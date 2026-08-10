/**
 * Tool output truncation.
 *
 * Unbounded tool output is the fastest way to destroy a context window, so
 * every result funnels through here. Overflow is written to a temp file and
 * the path is reported, which keeps the full output recoverable by the agent
 * (it can read the file back) without forcing it into the prompt.
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OVERFLOW_DIR, ensureDir } from './paths.js';

export const MAX_LINES = 2000;
export const MAX_BYTES = 50_000;

/**
 * @param {string} text Raw tool output.
 * @param {object} [opts]
 * @param {number} [opts.maxLines]
 * @param {number} [opts.maxBytes]
 * @param {string} [opts.label] Used in the overflow filename for debuggability.
 * @returns {{ output: string, truncated: boolean, overflowPath: string|null }}
 */
export function truncateOutput(text, opts = {}) {
  const maxLines = opts.maxLines ?? MAX_LINES;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const label = (opts.label || 'output').replace(/[^a-z0-9_-]/gi, '');

  if (typeof text !== 'string') text = String(text ?? '');

  const overLines = countLines(text) > maxLines;
  const overBytes = Buffer.byteLength(text, 'utf8') > maxBytes;
  if (!overLines && !overBytes) {
    return { output: text, truncated: false, overflowPath: null };
  }

  const overflowPath = spill(text, label);

  let clipped = text;
  if (overLines) clipped = clipped.split('\n').slice(0, maxLines).join('\n');
  if (Buffer.byteLength(clipped, 'utf8') > maxBytes) {
    clipped = Buffer.from(clipped, 'utf8').subarray(0, maxBytes).toString('utf8');
  }

  const reason = [
    overLines ? `${countLines(text)} lines (limit ${maxLines})` : null,
    overBytes ? `${Buffer.byteLength(text, 'utf8')} bytes (limit ${maxBytes})` : null,
  ].filter(Boolean).join(', ');

  const notice = overflowPath
    ? `\n\n[output truncated: ${reason}. Full output saved to ${overflowPath} — read that file if you need the rest.]`
    : `\n\n[output truncated: ${reason}.]`;

  return { output: clipped + notice, truncated: true, overflowPath };
}

function countLines(text) {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function spill(text, label) {
  try {
    ensureDir(OVERFLOW_DIR);
    const file = join(OVERFLOW_DIR, `${label}-${randomUUID().slice(0, 8)}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch {
    // Losing the overflow copy is acceptable; losing the turn is not.
    return null;
  }
}
