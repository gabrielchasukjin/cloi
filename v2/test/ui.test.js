import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCall, summarizeResult, toolLine, shortPath, BOX } from '../src/ui/terminal.js';

/** Colour codes make assertions unreadable; the layout is what is under test. */
const strip = (s) => s.replace(/\[[0-9;]*m/g, '');

test('boxes have square corners', () => {
  // Rounded borders read as decoration rather than structure.
  assert.equal(BOX.borderStyle, 'single');
});

test('a call is described by verb and its identifying argument', () => {
  assert.equal(describeCall('read_file', { path: 'src/a.js' }), 'read src/a.js');
  assert.equal(describeCall('list_dir', {}), 'ls .');
  assert.equal(describeCall('grep', { pattern: 'foo', path: 'src' }), 'grep /foo/ in src');
  assert.equal(describeCall('run_command', { command: 'npm test' }), 'run npm test');
});

test('grep shows the glob filter, which changes the result', () => {
  // Hiding it once made "0 files searched" look like a bug in grep.
  assert.match(describeCall('grep', { pattern: 'x', glob: '*.py' }), /\(\*\.py\)/);
});

test('command results read the same whether they passed or failed', () => {
  assert.equal(strip(summarizeResult('run_command', { output: 'Exit code 0\nfine' })), 'exit 0');
  assert.equal(strip(summarizeResult('run_command', { output: 'Exit code 1\nboom', isError: true })), 'exit 1');
});

test('a timeout says so rather than reporting a code', () => {
  const out = summarizeResult('run_command', { output: 'Command timed out after 120s', isError: true });
  assert.equal(strip(out), 'timed out');
});

test('results are counts, not echoes of the argument', () => {
  // `ls src` reporting "src" told the reader nothing they had not just read.
  assert.equal(strip(summarizeResult('list_dir', { output: 'src\n  a.js\n  b.js' })), '2 entries');
  assert.equal(strip(summarizeResult('read_file', { output: 'a.js (lines 1-9 of 9)\nx' })), '9 lines');
  assert.equal(strip(summarizeResult('grep', { output: '3 matches for /x/:\na\nb\nc' })), '3 matches');
  assert.equal(strip(summarizeResult('glob', { output: 'No files matched *.py.' })), 'none');
  assert.equal(strip(summarizeResult('edit_file', { output: 'Edited a.js (1 replacement).' })), '1 change');
});

test('one tool call renders as one aligned line', () => {
  const line = strip(toolLine(
    'read_file',
    { path: 'src/lib/stats.js' },
    { output: 'src/lib/stats.js (lines 1-20 of 20)\nx' },
  ));
  assert.equal(line.split('\n').length, 1, 'a call must not cost two lines');
  assert.match(line, /^ {2}. read src\/lib\/stats\.js\s+20 lines$/);
});

test('failed calls are marked in the gutter', () => {
  const line = strip(toolLine('run_command', { command: 'npm test' }, { output: 'Exit code 1', isError: true }));
  assert.match(line, /^ {2}✗/);
});

test('results align to the same column regardless of call length', () => {
  const short = strip(toolLine('list_dir', { path: 'a' }, { output: 'a\n  x' }));
  const long = strip(toolLine('read_file', { path: 'src/lib/stats.js' }, { output: 'f (lines 1-9 of 9)\nx' }));
  const column = (line) => line.length - line.trimEnd().split(/\s{2,}/).pop().length;
  assert.equal(column(short), column(long), 'result column must not move');
});

test('paths under home are shown relative to it', () => {
  const home = process.env.HOME || process.env.USERPROFILE;
  assert.match(shortPath(`${home}/projects/thing`), /^~\/projects\/thing$/);
});
