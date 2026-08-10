/**
 * Filesystem locations used by cloi.
 *
 * Everything user-scoped lives under a single data dir so the install is easy
 * to inspect and easy to delete. Overflow from truncated tool output goes to
 * the OS temp dir instead, since it is disposable by design.
 */

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';

export const DATA_DIR = process.env.CLOI_DATA_DIR || join(homedir(), '.cloi');
export const DB_PATH = join(DATA_DIR, 'cloi.db');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const OVERFLOW_DIR = join(tmpdir(), 'cloi-overflow');

/** Create a directory if absent. Safe to call repeatedly. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDataDir() {
  return ensureDir(DATA_DIR);
}

/**
 * Delete overflow files older than the retention window.
 *
 * Called opportunistically on startup; failures are ignored because a stale
 * temp file is never worth interrupting a session over.
 */
export function pruneOverflow(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(OVERFLOW_DIR)) return;
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(OVERFLOW_DIR)) {
      const full = join(OVERFLOW_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {}
    }
  } catch {}
}
