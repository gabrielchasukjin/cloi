import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { truncateOutput, MAX_LINES } from '../src/util/truncate.js';
import { resolvePath, PathAccessError, displayPath } from '../src/tools/workspace.js';
import { stableStringify } from '../src/agent/loop.js';

test('short output passes through untouched', () => {
  const result = truncateOutput('hello\nworld');
  assert.equal(result.truncated, false);
  assert.equal(result.output, 'hello\nworld');
  assert.equal(result.overflowPath, null);
});

test('long output is truncated and spilled to a recoverable file', () => {
  const text = Array.from({ length: MAX_LINES + 500 }, (_, i) => `line ${i}`).join('\n');
  const result = truncateOutput(text, { label: 'test' });
  assert.equal(result.truncated, true);
  assert.ok(result.output.length < text.length);
  assert.match(result.output, /output truncated/);
  assert.ok(result.overflowPath, 'expected an overflow path');
  assert.equal(fs.readFileSync(result.overflowPath, 'utf8'), text);
  fs.rmSync(result.overflowPath, { force: true });
});

test('byte-heavy single-line output is truncated', () => {
  const result = truncateOutput('x'.repeat(80_000), { label: 'test' });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output, 'utf8') < 80_000);
  if (result.overflowPath) fs.rmSync(result.overflowPath, { force: true });
});

test('resolvePath keeps relative paths inside the workspace', () => {
  const root = path.resolve(os.tmpdir(), 'cloi-ws');
  const resolved = resolvePath(root, 'src/index.js');
  assert.equal(resolved, path.join(root, 'src', 'index.js'));
});

test('resolvePath rejects traversal out of the workspace', () => {
  const root = path.resolve(os.tmpdir(), 'cloi-ws');
  assert.throws(() => resolvePath(root, '../../etc/passwd'), PathAccessError);
  assert.throws(() => resolvePath(root, 'a/b/../../../outside.txt'), PathAccessError);
});

test('resolvePath rejects absolute paths outside the workspace', () => {
  const root = path.resolve(os.tmpdir(), 'cloi-ws');
  const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
  assert.throws(() => resolvePath(root, outside), PathAccessError);
});

test('displayPath renders posix-style relative paths on every platform', () => {
  const root = path.resolve(os.tmpdir(), 'cloi-ws');
  const abs = path.join(root, 'src', 'deep', 'file.js');
  assert.equal(displayPath(root, abs), 'src/deep/file.js');
});

test('stableStringify ignores key order so repeated calls are detected', () => {
  assert.equal(
    stableStringify({ path: 'a.js', line: 1 }),
    stableStringify({ line: 1, path: 'a.js' }),
  );
  assert.notEqual(
    stableStringify({ path: 'a.js' }),
    stableStringify({ path: 'b.js' }),
  );
});

test('a single tool result cannot swallow the context window', async () => {
  // Observed live: reading one 600-line README cost 7469 tokens and left a
  // 16k-token turn at 73% before any work had been done. The old cap was a
  // fixed 50 KB — roughly 14k tokens, which does not fit in that window at all.
  const { byteCapFor, MAX_BYTES } = await import('../src/util/truncate.js');
  const cap = byteCapFor(16384);
  assert.ok(cap < MAX_BYTES, 'a 16k window must cap below the absolute limit');
  // Comfortably under a quarter of the window once converted back to tokens.
  assert.ok(cap / 3.6 < 16384 * 0.3, `cap was ~${Math.round(cap / 3.6)} tokens`);
  // A large window is still allowed the absolute maximum.
  assert.equal(byteCapFor(200_000), MAX_BYTES);
  // An unknown window falls back rather than capping at zero.
  assert.equal(byteCapFor(0), MAX_BYTES);
});

test('a truncated read is told to continue, not to re-read the overflow', async () => {
  // The overflow copy is the same size as what was just cut, so sending the
  // agent there spends the window twice to see the same bytes. The file is
  // still on disk; continuing from the last line delivered costs only the rest.
  const { truncateOutput } = await import('../src/util/truncate.js');
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');

  const read = truncateOutput(big, {
    maxBytes: 500,
    label: 'read_file',
    hint: 'Call read_file again on a.js with start_line past the last line shown.',
  });
  assert.match(read.output, /start_line past the last line shown/);
  assert.doesNotMatch(read.output, /read that file if you need the rest/);

  // Without a hint the overflow file is still the right answer.
  const command = truncateOutput(big, { maxBytes: 500, label: 'run_command' });
  assert.match(command.output, /read that file if you need the rest/);
  // Either way the full output stays recoverable.
  assert.ok(read.overflowPath && command.overflowPath);
});

test('read_file supplies its own truncation advice', async () => {
  const { createRegistry } = await import('../src/tools/index.js');
  const tool = createRegistry().get('read_file');
  const hint = tool.truncationHint({ path: 'src/big.js', start_line: 40 });
  assert.match(hint, /read_file again on src\/big\.js/);
  assert.match(hint, /40/, 'the agent needs to know where it started');
});
