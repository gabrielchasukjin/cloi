/**
 * A Python process that outlives a single tool call.
 *
 * This is the piece that makes a result a *variable* rather than a lookup:
 * `matches` bound in one call is still bound in the next, and can be filtered,
 * counted, or passed to something else. Prime Agent gets that from a live
 * IPython kernel; this is the same idea with the smallest machinery that
 * delivers it — a long-lived interpreter and newline-delimited JSON.
 *
 * One kernel per session. It is started on first use, not at launch: most turns
 * never need Python, and paying a process spawn for all of them would be a
 * tax on the common case.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sanitizeEnv } from '../util/secrets.js';

const DRIVER = fileURLToPath(new URL('./kernel.py', import.meta.url));

/** Interpreters to try, best first. */
const CANDIDATES = ['python3', 'python', 'py'];

/** A cell that has not answered by now is not going to. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Quiet period after a cell before the namespace is written to disk. */
const SNAPSHOT_DEBOUNCE_MS = 1_500;
/** Ceiling on a saved namespace, checked per variable and in total. */
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;

let detected;

/**
 * Find a Python that actually runs.
 *
 * Not a `which` check. On Windows `python3` is frequently an App Execution
 * Alias that prints "Python was not found; run without arguments to install
 * from the Microsoft Store" and **exits 0** — so a naive probe reports success
 * and the kernel then fails at the first cell with nothing to explain it. The
 * only reliable test is asking it to print its own version.
 *
 * @returns {string|null}
 */
export function detectPython({ force = false } = {}) {
  if (detected !== undefined && !force) return detected;

  for (const command of CANDIDATES) {
    try {
      const probe = spawnSync(command, ['-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      if (probe.status === 0 && probe.stdout.trim() === '3') {
        detected = command;
        return detected;
      }
    } catch {
      // Not on PATH; try the next one.
    }
  }
  detected = null;
  return detected;
}

export class PythonKernel {
  constructor({ cwd, command, timeoutMs = DEFAULT_TIMEOUT_MS, snapshotPath = null } = {}) {
    this.cwd = cwd;
    this.command = command || detectPython();
    this.timeoutMs = timeoutMs;
    this.snapshotPath = snapshotPath;
    /** Result of the restore done at startup, for the first cell to report. */
    this.restored = null;
    this.snapshotTimer = null;
    this.child = null;
    this.buffer = '';
    /** Requests are answered in order, so one queue is enough. */
    this.pending = [];
    /** Handles already bound, so a rebind costs nothing. */
    this.bound = new Set();
  }

  get running() {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  start() {
    if (this.running) return;
    if (!this.command) throw new Error('No Python 3 interpreter found on PATH.');

    this.child = spawn(this.command, ['-u', DRIVER], {
      cwd: this.cwd,
      // Same containment as run_command: a subprocess started by the agent has
      // no business seeing the API keys of the shell that launched cloi.
      env: sanitizeEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._consume(chunk));

    this.stderr = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });

    const fail = (reason) => {
      const waiting = this.pending.splice(0);
      for (const { reject } of waiting) reject(new Error(reason));
      this.child = null;
      this.bound.clear();
    };
    this.child.on('exit', (code) => fail(`Python kernel exited (code ${code}). ${this.stderr}`.trim()));
    this.child.on('error', (err) => fail(`Python kernel failed to start: ${err.message}`));

    // Restored first, before tools are installed and handles rebound, so a
    // fresh tool function always wins over a stale copy of one. Queued rather
    // than awaited: the caller's own message is written straight after and the
    // driver answers in order.
    if (this.snapshotPath) {
      this._enqueue({ type: 'restore', path: this.snapshotPath })
        .then((result) => { this.restored = result; })
        .catch(() => { this.restored = null; });
    }
  }

  _consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        const broken = this.pending.shift();
        if (broken) {
          clearTimeout(broken.timer);
          broken.reject(new Error(`Unreadable kernel reply: ${line.slice(0, 200)}`));
        }
        continue;
      }

      // A call arrives *during* an execution, not instead of it: the cell is
      // still running and blocked on the answer, so the pending waiter stays
      // where it is.
      if (message.type === 'call') {
        this._serveCall(message);
        continue;
      }

      const waiter = this.pending.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  /**
   * Run a tool on the cell's behalf and hand the result back.
   *
   * The waiting cell's timeout is suspended for the duration: a tool call is
   * work the cell asked for, and a `run_command` that takes a minute should not
   * look like a hung interpreter.
   */
  async _serveCall(message) {
    const waiter = this.pending[0];
    if (waiter) clearTimeout(waiter.timer);

    let payload;
    try {
      if (!this.onCall) throw new Error('this kernel cannot call tools');
      payload = { ok: true, output: await this.onCall(message) };
    } catch (err) {
      payload = { ok: false, error: err?.message || String(err) };
    }

    // The cell may already be gone — a timeout, or the kernel killed under it.
    if (!this.running) return;
    if (waiter && this.pending[0] === waiter) waiter.timer = this._armTimeout(waiter);
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _armTimeout(waiter) {
    const timer = setTimeout(() => {
      const index = this.pending.indexOf(waiter);
      if (index !== -1) this.pending.splice(index, 1);
      this.kill();
      waiter.reject(new Error(
        `Python did not finish within ${Math.round(this.timeoutMs / 1000)}s; `
        + 'the kernel was restarted and its variables are gone.',
      ));
    }, this.timeoutMs);
    timer.unref?.();
    return timer;
  }

  /** Expose these tool names as functions inside the kernel. */
  installTools(names) {
    return this._send({ type: 'tools', names });
  }

  /**
   * Write the namespace to disk.
   *
   * Debounced: a cell that assigns one variable does not need its own write,
   * and the interesting moment is when the agent stops working, not each step.
   */
  scheduleSnapshot() {
    if (!this.snapshotPath || !this.running) return;
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => { void this.snapshot(); }, SNAPSHOT_DEBOUNCE_MS);
    this.snapshotTimer.unref?.();
  }

  /**
   * What a restore recovered, reported once.
   *
   * The agent needs to know its variables came back — otherwise it redefines
   * them — and needs to know when one did not, since a name that silently
   * failed to unpickle would raise NameError several cells later with nothing
   * to connect it to.
   */
  takeRestoreNotice() {
    const restored = this.restored;
    this.restored = null;
    if (!restored?.restored?.length && !restored?.failed?.length) return null;

    const parts = [];
    if (restored.restored.length) {
      parts.push(`[restored from the last session: ${restored.restored.join(', ')}]`);
    }
    if (restored.failed?.length) {
      parts.push(`[could not restore: ${restored.failed.map((f) => f.name).join(', ')}]`);
    }
    return parts.join('\n');
  }

  async snapshot() {
    if (!this.snapshotPath || !this.running) return null;
    clearTimeout(this.snapshotTimer);
    try {
      return await this._send({ type: 'snapshot', path: this.snapshotPath, maxBytes: SNAPSHOT_MAX_BYTES });
    } catch {
      // Losing a snapshot costs the next session its variables. Losing the turn
      // to say so would cost more.
      return null;
    }
  }

  _send(message) {
    this.start();
    return this._enqueue(message);
  }

  _enqueue(message) {
    return new Promise((resolve, reject) => {
      // The kernel is single-threaded, so a cell that hangs blocks every cell
      // after it. Killing is the only way back, and the namespace goes with it
      // — which is worth saying rather than silently starting over.
      const waiter = { resolve, reject };
      waiter.timer = this._armTimeout(waiter);
      this.pending.push(waiter);
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  /** Define variables in the namespace. Values are strings. */
  bind(vars) {
    const fresh = {};
    for (const [name, value] of Object.entries(vars)) {
      if (!this.bound.has(name)) fresh[name] = value;
    }
    if (!Object.keys(fresh).length) return Promise.resolve({ ok: true, bound: [] });
    for (const name of Object.keys(fresh)) this.bound.add(name);
    return this._send({ type: 'bind', vars: fresh });
  }

  exec(code) {
    return this._send({ type: 'exec', code });
  }

  names() {
    return this._send({ type: 'names' });
  }

  kill() {
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    if (this.child) {
      this.child.kill('SIGKILL');
      this.child = null;
    }
    this.bound.clear();
    this.buffer = '';
  }
}

/** One kernel per session, created on first use. */
const kernels = new Map();

export function kernelFor(sessionId, options) {
  let kernel = kernels.get(sessionId);
  if (!kernel || !kernel.command) {
    kernel = new PythonKernel(options);
    kernels.set(sessionId, kernel);
  }
  return kernel;
}

export function shutdownKernels() {
  for (const kernel of kernels.values()) kernel.kill();
  kernels.clear();
}
