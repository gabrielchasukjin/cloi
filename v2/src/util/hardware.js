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

  const nvidia = detectNvidia();
  if (nvidia) {
    return {
      ...nvidia,
      totalRamMB,
      freeRamMB,
      unifiedMemory: false,
      platform,
      cpus: os.cpus()?.length || 1,
    };
  }

  // Apple Silicon shares one pool between CPU and GPU. Metal will not hand the
  // whole thing to a model, so treat roughly two thirds as usable.
  if (platform === 'darwin' && os.arch() === 'arm64') {
    return {
      vramMB: Math.round(totalRamMB * 0.66),
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
