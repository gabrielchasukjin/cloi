/**
 * Benchmark fixtures and tasks.
 *
 * Every task is scored mechanically — a regex over the answer, or the exit code
 * of the project's own test suite. Nothing here is a judgement call, because a
 * benchmark you have to interpret is one you will unconsciously grade in favour
 * of whatever you already believe.
 *
 * Tasks are graded by difficulty so a run says *where* a model falls over,
 * rather than just how often. A model that passes every easy task and no hard
 * one is a different proposition from one that is uniformly unreliable.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Build a throwaway project.
 *
 * `broken` decides whether `completeTask` mutates a copy — the cross-file bug
 * where the failing test names one module and the cause lives in another.
 */
export function makeWorkspace({ broken = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloi-bench-'));
  const write = (rel, lines) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join('\n') + '\n');
  };

  write('package.json', ['{ "name": "taskbin", "type": "module",',
    '  "scripts": { "test": "node --test \\"test/**/*.test.js\\"" } }']);

  write('src/lib/store.js', [
    '/** In-memory task store. */',
    'let tasks = [];',
    'let nextId = 1;',
    '',
    'export function addTask(title) {',
    '  const task = { id: nextId++, title, done: false };',
    '  tasks.push(task);',
    '  return task;',
    '}',
    '',
    'export function completeTask(id) {',
    '  const task = tasks.find((t) => t.id === id);',
    '  if (!task) return null;',
    ...(broken
      ? ['  const updated = { ...task };', '  updated.done = true;', '  return updated;']
      : ['  task.done = true;', '  return task;']),
    '}',
    '',
    'export function listTasks() {',
    '  return tasks;',
    '}',
    '',
    'export function clearTasks() {',
    '  tasks = [];',
    '  nextId = 1;',
    '}',
  ]);

  write('src/lib/stats.js', [
    '/** Aggregate statistics. */',
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
  ]);

  // A near-identical name in another file, to catch models that pattern-match
  // on the word rather than reading.
  write('src/lib/report.js', [
    '/** Human-readable reporting. */',
    "import { completionRate } from './stats.js';",
    '',
    'export function completionPercent() {',
    '  return Math.round(completionRate() * 100);',
    '}',
  ]);

  write('test/stats.test.js', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { addTask, completeTask, clearTasks } from '../src/lib/store.js';",
    "import { countByStatus } from '../src/lib/stats.js';",
    '',
    "test('completing a task is reflected in the counts', () => {",
    '  clearTasks();',
    "  addTask('write docs');",
    "  const t = addTask('ship it');",
    '  completeTask(t.id);',
    '  assert.deepEqual(countByStatus(), { done: 1, open: 1, total: 2 });',
    '});',
  ]);

  return dir;
}

/** Does the project's own suite pass? Used to score edit tasks. */
export function testsPass(cwd) {
  // Whole command as one string: passing an args array alongside `shell: true`
  // concatenates without escaping, which Node now warns about.
  const res = spawnSync('npm test', { cwd, shell: true, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return res.status === 0;
}

const has = (...patterns) => (text) => patterns.every((p) => p.test(text));

/**
 * Is this file named *as the answer*, rather than merely mentioned?
 *
 * A plain "does the string appear" test scores correct answers as wrong: a
 * model replying "it is in stats.js, not report.js" is being more precise than
 * one that omits the distractor, and the naive check failed it for saying so.
 * Mentions adjacent to a negation are therefore not treated as claims.
 */
const NEG = /(?:not|n't|never|no longer|except|other than|rather than|instead of|excluding|besides)\s*$/i;

/**
 * The file the answer actually asserts: the first one mentioned that is not
 * preceded by a negation.
 *
 * Position matters, and looking for a negation *after* the name is wrong — in
 * "stats.js, not report.js" the negation belongs to the file that follows it,
 * so that rule rejected a correct answer for being more precise than required.
 */
function answeredFile(text) {
  for (const m of text.matchAll(/([\w.-]+\.(?:js|mjs|cjs|ts|py|json))/gi)) {
    const preceding = text.slice(Math.max(0, m.index - 45), m.index);
    if (NEG.test(preceding.replace(/[^a-z'\s]+\s*$/i, ' '))) continue;
    return m[1].split('/').pop().toLowerCase();
  }
  return null;
}

/** Does the answer name this file as its answer? */
function claims(text, file) {
  return answeredFile(text) === file.toLowerCase();
}

export const TASKS = [
  {
    name: 'locate',
    difficulty: 'easy',
    prompt: 'Which source file defines completionRate? Answer with the file path.',
    score: ({ text }) => claims(text, 'stats.js'),
  },
  {
    name: 'read-value',
    difficulty: 'easy',
    prompt: 'What does completionRate return when the task list is empty? Answer with the value.',
    score: ({ text }) => /\b0\b/.test(text) && !/NaN/i.test(text),
  },
  {
    name: 'distractor',
    difficulty: 'medium',
    // completionPercent lives in report.js and merely wraps completionRate.
    prompt: 'Which function converts the completion rate into a whole-number percentage, and which file is it in?',
    score: ({ text }) => /completionPercent/.test(text) && claims(text, 'report.js'),
  },
  {
    name: 'trace-import',
    difficulty: 'medium',
    prompt: 'Which files import listTasks? List every file path.',
    score: ({ text }) => claims(text, 'stats.js'),
  },
  {
    name: 'explain-guard',
    difficulty: 'medium',
    prompt: 'completionRate has a guard against one specific input. What input, and what does it return instead?',
    score: ({ text }) => has(/empty|zero|\b0\b/i)(text) && /\b0\b/.test(text),
  },
  {
    name: 'cross-file-cause',
    difficulty: 'hard',
    broken: true,
    prompt: 'npm test is failing. Name the function responsible for the failure and the file it is in. Do not fix it.',
    score: ({ text }) => /completeTask/.test(text) && claims(text, 'store.js'),
  },
  {
    name: 'fix-and-verify',
    difficulty: 'hard',
    broken: true,
    prompt: 'npm test is failing. Find the root cause, fix the source file responsible, then run the tests again to confirm they pass.',
    // Scored by the suite itself, not by what the model claims.
    score: ({ cwd }) => testsPass(cwd),
  },
  {
    name: 'restraint',
    difficulty: 'easy',
    prompt: 'What is 17 multiplied by 4? Answer with just the number.',
    // Catches models that reach for tools when nothing in the workspace is
    // relevant — the over-triggering that burns iterations in real use.
    score: ({ text, toolCalls }) => /\b68\b/.test(text) && toolCalls === 0,
  },
];
