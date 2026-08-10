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
