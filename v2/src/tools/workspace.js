/**
 * Workspace path handling.
 *
 * Every filesystem tool routes through `resolvePath`, which keeps access inside
 * the directory the session was started in. The model is not a trusted caller:
 * a hallucinated `../../../.ssh/id_rsa` should fail loudly rather than succeed.
 */

import path from 'node:path';
import fs from 'node:fs';

/** Directories never worth walking into. */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt',
  '.cache', '.pytest_cache', '.mypy_cache', '.tox', '.idea', '.vscode',
  '.gradle', '.terraform', 'vendor', '.cloi',
]);

/** Extensions we treat as text for reading and searching. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.avif',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.pyc',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3', '.faiss',
]);

export class PathAccessError extends Error {}

/**
 * Resolve a possibly-relative path against the workspace root.
 *
 * @param {string} root Absolute workspace root.
 * @param {string} candidate Path from the model.
 * @returns {string} Absolute, normalized path guaranteed to sit under `root`.
 */
export function resolvePath(root, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new PathAccessError('A path is required.');
  }
  const abs = path.resolve(root, candidate);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathAccessError(
      `Path "${candidate}" is outside the workspace (${root}). Only files under the workspace can be accessed.`,
    );
  }
  return abs;
}

/** Path shown back to the model: relative and posix-style, stable across OSes. */
export function displayPath(root, abs) {
  const rel = path.relative(root, abs) || '.';
  return rel.split(path.sep).join('/');
}

export function isProbablyBinary(filePath) {
  return BINARY_EXT.has(path.extname(filePath).toLowerCase());
}

/**
 * Detect binary content by sampling for NUL bytes, since extension alone is a
 * weak signal for extensionless files.
 */
export function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) return true;
  return false;
}

/**
 * Depth-first walk yielding absolute file paths, skipping ignored directories
 * and anything unreadable.
 */
export function* walkFiles(root, { maxFiles = 20000 } = {}) {
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (++seen > maxFiles) return;
        yield full;
      }
    }
  }
}
