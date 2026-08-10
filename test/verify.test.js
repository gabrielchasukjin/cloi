import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyAnswer, checkCoverage, checkEditOutcome, extractFileRefs, extractNegativeAssertions, resetWorkspaceCache } from '../src/agent/verify.js';

/** A throwaway workspace mirroring the fixture the live failure occurred in. */
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloi-verify-'));
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'stats.js'), [
    '/** Aggregate statistics. */',
    '',
    "import { listTasks } from './store.js';",
    '',
    'export function countByStatus() {',
    '  const tasks = listTasks();',
    '  let done = 0;',
    '  let open = 0;',
    '  for (const task of tasks) {',
    '    if (task.done) done++;',
    '    else open++;',
    '  }',
    '  return { done, open, total: tasks.length };',
    '}',
    '',
    'export function completionRate() {',
    '  const { done, total } = countByStatus();',
    '  return total === 0 ? 0 : done / total;',
    '}',
    '',
  ].join('\n'));
  return dir;
}

test('extractFileRefs finds paths and line citations, ignoring prose', () => {
  const refs = extractFileRefs('It is in `src/lib/stats.js` at stats.js:17, not in the readme.');
  const paths = refs.map((r) => r.path);
  assert.ok(paths.includes('src/lib/stats.js'));
  assert.ok(paths.includes('stats.js'));
  assert.equal(refs.find((r) => r.path === 'stats.js').line, 17);
});

test('extractNegativeAssertions finds claims of absence', () => {
  const claims = extractNegativeAssertions(
    'The file does not contain the definition of completionRate.',
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].symbol, 'completionRate');
});

test('the live failure is caught: absence claim disproved by the file', () => {
  // This is verbatim the answer a 1.7b gave after reading one line of the file.
  const dir = workspace();
  try {
    const answer = 'The file `src/lib/stats.js` does not contain the definition of completionRate.';
    const result = verifyAnswer(answer, { cwd: dir });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].detail, /completionRate appears in src\/lib\/stats\.js at line 16/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a correct answer passes untouched', () => {
  const dir = workspace();
  try {
    const answer = 'completionRate is defined in `src/lib/stats.js` and returns 0 for an empty list.';
    const result = verifyAnswer(answer, { cwd: dir });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invented file path is reported', () => {
  const dir = workspace();
  try {
    const result = verifyAnswer('The bug is in `src/lib/task.js`.', { cwd: dir });
    assert.equal(result.ok, false);
    assert.match(result.failures[0].detail, /does not exist in the workspace/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a line citation past the end of the file is reported', () => {
  const dir = workspace();
  try {
    const result = verifyAnswer('See src/lib/stats.js:400 for the definition.', { cwd: dir });
    assert.equal(result.ok, false);
    assert.match(result.failures[0].detail, /only 20 lines/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fabricated code quote is reported', () => {
  const dir = workspace();
  try {
    const filesRead = new Map([['src/lib/stats.js', { maxLine: 20 }]]);
    const result = verifyAnswer(
      'The line reads `return done / total * 100;` which is the bug.',
      { cwd: dir, filesRead },
    );
    assert.equal(result.ok, false);
    assert.match(result.failures[0].detail, /does not appear in the files you read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real quote passes even when whitespace differs', () => {
  const dir = workspace();
  try {
    const filesRead = new Map([['src/lib/stats.js', { maxLine: 20 }]]);
    const result = verifyAnswer(
      'The line is `return total === 0 ? 0 : done / total;`.',
      { cwd: dir, filesRead },
    );
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prose with no checkable claims is left alone', () => {
  const dir = workspace();
  try {
    for (const answer of [
      'I fixed the bug and the tests pass now.',
      'That change looks reasonable to me.',
      '',
    ]) {
      assert.equal(verifyAnswer(answer, { cwd: dir }).ok, true, `should pass: ${answer}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage check rejects a conclusion drawn from a fragment', () => {
  // The exact shape of the live failure: 1 of 20 lines read, absence asserted.
  const dir = workspace();
  try {
    const filesRead = new Map([['src/lib/stats.js', { maxLine: 1, total: 20 }]]);
    const complaint = checkCoverage(
      'The file does not contain completionRate.',
      { cwd: dir, filesRead },
    );
    assert.ok(complaint);
    assert.match(complaint, /only 1 of 20 lines/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage check is silent when the file was read in full', () => {
  const dir = workspace();
  try {
    const filesRead = new Map([['src/lib/stats.js', { maxLine: 20, total: 20 }]]);
    assert.equal(checkCoverage('It does not contain foo.', { cwd: dir, filesRead }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage check only applies to claims of absence', () => {
  const dir = workspace();
  try {
    const filesRead = new Map([['src/lib/stats.js', { maxLine: 1, total: 20 }]]);
    assert.equal(checkCoverage('I read the top of the file.', { cwd: dir, filesRead }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file referred to by bare name is not reported as missing', () => {
  // Observed live: the model wrote "stats.test.js" while the file sits at
  // "test/stats.test.js", and the check called it nonexistent — a false
  // accusation, which is the one thing this module must not produce.
  const dir = workspace();
  try {
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'stats.test.js'), 'test("x", () => {});\n');
    resetWorkspaceCache();

    const result = verifyAnswer('The failure is asserted in `stats.test.js`.', { cwd: dir });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  } finally {
    resetWorkspaceCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a name that exists nowhere in the tree is still reported', () => {
  const dir = workspace();
  try {
    resetWorkspaceCache();
    const result = verifyAnswer('The bug is in `nonexistent-module.js`.', { cwd: dir });
    assert.equal(result.ok, false);
    assert.match(result.failures[0].detail, /does not exist in the workspace/);
  } finally {
    resetWorkspaceCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prose between two inline-code spans is not mistaken for a quote', () => {
  // Observed live: an odd number of backticks made a regex pair the closing
  // tick of one span with the opening tick of the next, capturing the prose
  // between them and reporting it missing from the file.
  const dir = workspace();
  try {
    const filesRead = new Map([['src/lib/stats.js', { maxLine: 20 }]]);
    const answer =
      'The `countByStatus` function is incorrect. You should review the `countByStatus` function.';
    const result = verifyAnswer(answer, { cwd: dir, filesRead });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  } finally {
    resetWorkspaceCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prose containing the word "function" is not treated as code', () => {
  const dir = workspace();
  try {
    const filesRead = new Map([['src/lib/stats.js', { maxLine: 20 }]]);
    const result = verifyAnswer(
      'The `function is incorrect and should be reviewed` as noted.',
      { cwd: dir, filesRead },
    );
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  } finally {
    resetWorkspaceCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a value quoted from command output is not called fabrication', () => {
  // Observed live: the model quoted assertion values printed by `npm test`,
  // and the check reported them missing because it only searched file contents.
  const dir = workspace();
  try {
    const toolOutputs = [
      'Exit code 1\n  actual: { done: 0, open: 2, total: 2 },\n  expected: { done: 1, open: 1, total: 2 },',
    ];
    const result = verifyAnswer(
      'The actual result is `{ done: 0, open: 2, total: 2 }` rather than the expected counts.',
      { cwd: dir, toolOutputs },
    );
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  } finally {
    resetWorkspaceCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a quote found in neither files nor tool output is still reported', () => {
  const dir = workspace();
  try {
    const result = verifyAnswer(
      'The code reads `return done / total * 100;` there.',
      { cwd: dir, filesRead: new Map([['src/lib/stats.js', { maxLine: 20 }]]), toolOutputs: ['unrelated output'] },
    );
    assert.equal(result.ok, false);
    assert.match(result.failures[0].detail, /does not appear/);
  } finally {
    resetWorkspaceCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── edited-but-still-failing ───────────────────────────────────────────── */

const cmd = (command, isError) => ({ name: 'run_command', args: { command }, output: '', isError });
const edit = (path, isError = false) => ({ name: 'edit_file', args: { path }, output: '', isError });

test('an edit followed by a still-failing command is reported', () => {
  // The live failure: stats.js was edited, npm test still failed, and the turn
  // ended leaving the workspace changed and broken with nothing said about it.
  const complaint = checkEditOutcome([
    cmd('npm test', true),
    edit('src/lib/stats.js'),
    cmd('npm test', true),
  ]);
  assert.ok(complaint);
  assert.match(complaint, /changed src\/lib\/stats\.js/);
  assert.match(complaint, /still fails/);
});

test('an edit followed by a passing command is the good path', () => {
  assert.equal(checkEditOutcome([
    cmd('npm test', true),
    edit('src/lib/store.js'),
    cmd('npm test', false),
  ]), null);
});

test('an edit that was never re-verified is reported', () => {
  const complaint = checkEditOutcome([
    cmd('npm test', true),
    edit('src/lib/store.js'),
  ]);
  assert.ok(complaint);
  assert.match(complaint, /never re-ran/);
});

test('an edit with no failing command beforehand is left alone', () => {
  // "Add a comment to this file" should not be scolded for running no tests.
  assert.equal(checkEditOutcome([edit('README.md')]), null);
  assert.equal(checkEditOutcome([cmd('git status', false), edit('README.md')]), null);
});

test('a turn that changed nothing is left alone', () => {
  assert.equal(checkEditOutcome([cmd('npm test', true), { name: 'read_file', args: {}, isError: false }]), null);
  assert.equal(checkEditOutcome([]), null);
});

test('a failed edit does not count as a change', () => {
  // The edit errored, so nothing was written and there is nothing to verify.
  assert.equal(checkEditOutcome([cmd('npm test', true), edit('src/lib/stats.js', true)]), null);
});

test('only the command after the last edit matters', () => {
  // An earlier failure, then a fix, then a pass: the turn succeeded.
  assert.equal(checkEditOutcome([
    edit('a.js'),
    cmd('npm test', true),
    edit('b.js'),
    cmd('npm test', false),
  ]), null);
});

test('a technology named like a file is not treated as one', async () => {
  // Observed live: "Requires Node.js 22.5+" read out of a README got the whole
  // answer rejected for referring to a file that does not exist.
  const { extractFileRefs } = await import('../src/agent/verify.js');
  const paths = extractFileRefs('Requires Node.js 22.5+, and the UI is built with Next.js and Vue.js.')
    .map((r) => r.path);
  assert.deepEqual(paths, [], `flagged: ${paths.join(', ')}`);
});

test('a real path that happens to share a technology name is still checked', async () => {
  // The exemption is for bare prose names only — src/next.js is a file.
  const { extractFileRefs } = await import('../src/agent/verify.js');
  const paths = extractFileRefs('see src/next.js and ./node.js for the wiring').map((r) => r.path);
  assert.deepEqual(paths.sort(), ['./node.js', 'src/next.js']);
});
