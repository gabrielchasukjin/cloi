/**
 * Hardware detection.
 *
 * Only three numbers matter for choosing a model: how much VRAM will hold the
 * weights, how much system RAM is available when they spill, and whether there
 * is a discrete GPU at all. Everything here degrades to a safe unknown rather
 * than guessing — recommending a model too large is worse than recommending one
 * too small, since the first fails confusingly and the second merely
 * underperforms.
 */

import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * @typedef {object} Hardware
 * @property {number|null} vramMB Dedicated VRAM, or null if undetectable.
 * @property {number} totalRamMB
 * @property {number} freeRamMB
 * @property {string|null} gpuName
 * @property {boolean} unifiedMemory GPU shares system RAM (Apple Silicon).
 * @property {string} platform
 * @property {number} cpus
 */

/** @returns {Hardware} */
export function detectHardware() {
  const platform = os.platform();
  const totalRamMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeRamMB = Math.round(os.freemem() / 1024 / 1024);

  // Probed in order of how reliable the number is, not by market share. Every
  // probe returns null rather than a guess: recommending a model that does not
  // fit fails confusingly, while recommending one that is too small merely
  // underperforms.
  const gpu = detectNvidia() || detectAmd() || detectWindowsGpu() || detectLinuxDrm();
  if (gpu) {
    return {
      ...gpu,
      totalRamMB,
      freeRamMB,
      unifiedMemory: false,
      platform,
      cpus: os.cpus()?.length || 1,
    };
  }

  // Apple Silicon shares one pool between CPU and GPU, and Metal caps what a
  // process may take. The cap is not a single figure: machines with 36 GB or
  // less get roughly 66%, larger machines roughly 75%. This is a macOS GPU
  // memory-manager limit, not an Ollama one, so it applies to any Metal backend.
  if (platform === 'darwin' && os.arch() === 'arm64') {
    const metalShare = totalRamMB > 36 * 1024 ? 0.75 : 0.66;
    return {
      vramMB: Math.round(totalRamMB * metalShare),
      gpuName: 'Apple Silicon (unified memory)',
      totalRamMB,
      freeRamMB,
      unifiedMemory: true,
      platform,
      cpus: os.cpus()?.length || 1,
    };
  }

  return {
    vramMB: null,
    gpuName: null,
    totalRamMB,
    freeRamMB,
    unifiedMemory: false,
    platform,
    cpus: os.cpus()?.length || 1,
  };
}

/**
 * Query an NVIDIA GPU.
 *
 * `nvidia-smi` is used rather than a WMI/registry lookup because the Windows
 * `AdapterRAM` field is a 32-bit value that saturates at 4 GB — it reports any
 * larger card as exactly 4 GB, which would silently downgrade every
 * recommendation on an 8, 12 or 24 GB GPU.
 */
function detectNvidia() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const first = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    if (!first) return null;
    const [name, mib] = first.split(',').map((s) => s.trim());
    const vramMB = Number(mib);
    if (!Number.isFinite(vramMB) || vramMB <= 0) return null;
    return { vramMB, gpuName: name };
  } catch {
    return null;
  }
}

/** AMD via rocm-smi, which reports VRAM in bytes. */
function detectAmd() {
  try {
    const out = execFileSync('rocm-smi', ['--showmeminfo', 'vram', '--csv'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Rows look like: card0,<total bytes>,<used bytes>
    const bytes = out.split('\n')
      .map((l) => l.split(',')[1])
      .map((v) => Number(String(v).trim()))
      .find((n) => Number.isFinite(n) && n > 0);
    if (!bytes) return null;
    return { vramMB: Math.round(bytes / 1024 / 1024), gpuName: 'AMD GPU (rocm-smi)' };
  } catch {
    return null;
  }
}

/**
 * Windows fallback covering AMD and Intel.
 *
 * Reads `qwMemorySize` out of the display adapter's registry key rather than
 * WMI's `AdapterRAM`, which is a 32-bit field that reports any card larger than
 * 4 GB as exactly 4 GB — the same trap that makes `Win32_VideoController`
 * useless for this.
 */
function detectWindowsGpu() {
  if (os.platform() !== 'win32') return null;
  try {
    // The value is a *flat* property whose name contains a dot, so it must be
    // quoted. Dot-traversal (`$p.HardwareInformation.qwMemorySize`) silently
    // reads null, which made this probe look like "no GPU" on every machine.
    // Integrated adapters have no such value at all, so taking the maximum
    // naturally selects the discrete card.
    const script = [
      "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';",
      '$best=0; $name=$null;',
      'Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {',
      '  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue;',
      "  $q = $p.'HardwareInformation.qwMemorySize';",
      '  if ($q) {',
      '    $v = [int64]$q;',
      '    if ($v -gt $best) { $best = $v; $name = $p.DriverDesc }',
      '  }',
      '};',
      'if ($best -gt 0) { Write-Output "$name|$best" }',
    ].join(' ');

    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();

    if (!out.includes('|')) return null;
    const [name, bytes] = out.split('|');
    const vramMB = Math.round(Number(bytes) / 1024 / 1024);
    if (!Number.isFinite(vramMB) || vramMB <= 0) return null;
    return { vramMB, gpuName: (name || 'GPU').trim() };
  } catch {
    return null;
  }
}

/** Linux fallback: AMD cards expose total VRAM through sysfs. */
function detectLinuxDrm() {
  if (os.platform() !== 'linux') return null;
  try {
    let best = 0;
    for (const card of fs.readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(card)) continue;
      const path = `/sys/class/drm/${card}/device/mem_info_vram_total`;
      if (!fs.existsSync(path)) continue;
      const bytes = Number(fs.readFileSync(path, 'utf8').trim());
      if (Number.isFinite(bytes) && bytes > best) best = bytes;
    }
    if (!best) return null;
    return { vramMB: Math.round(best / 1024 / 1024), gpuName: 'GPU (sysfs)' };
  } catch {
    return null;
  }
}

export function formatGB(mb) {
  if (mb === null || mb === undefined) return 'unknown';
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** One-line description for the setup screen. */
export function describeHardware(hw) {
  const gpu = hw.gpuName
    ? `${hw.gpuName} · ${formatGB(hw.vramMB)}${hw.unifiedMemory ? ' usable' : ' VRAM'}`
    : 'no discrete GPU detected';
  return `${gpu} · ${formatGB(hw.totalRamMB)} RAM · ${hw.cpus} cores`;
}
