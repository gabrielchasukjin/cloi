import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyAnswer, checkCoverage, extractFileRefs, extractNegativeAssertions, resetWorkspaceCache } from '../src/agent/verify.js';

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
