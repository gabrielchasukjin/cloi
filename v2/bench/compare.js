#!/usr/bin/env node
/**
 * Head-to-head model comparison against the real tool registry.
 *
 * Public benchmarks use their own tools, their own prompts and their own
 * scoring. What matters here is how a model behaves inside *this* loop, with
 * these eight tools and this system prompt — so this runs the actual agent and
 * counts what actually happened.
 *
 * Usage:
 *   node bench/compare.js qwen3:8b gemma4:12b nemotron-3-nano:4b
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/agent/permission.js';
import { runTurn, TurnStatus } from '../src/agent/loop.js';
import { loadConfig } from '../src/config.js';

/** Tasks with a checkable answer, so scoring is not a judgement call. */
const TASKS = [
  {
    name: 'locate',
    prompt: 'Which source file defines completionRate? Answer with the file path.',
    passes: (text) => /stats\.js/.test(text),
  },
  {
    name: 'read-value',
    prompt: 'What does completionRate return when the task list is empty? Answer with the value.',
    passes: (text) => /\b0\b/.test(text) && !/NaN/i.test(text),
  },
  {
    name: 'cross-file',
    prompt: 'Which function is responsible for marking a task as done? Give the file and function name.',
    passes: (text) => /completeTask/.test(text) && /store\.js/.test(text),
  },
];

/** A throwaway workspace, so every model sees an identical repository. */
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloi-bench-'));
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'store.js'), [
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
    '  task.done = true;',
    '  return task;',
    '}',
    '',
    'export function listTasks() {',
    '  return tasks;',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'stats.js'), [
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
    '',
  ].join('\n'));
  return dir;
}

/** In-memory session: the benchmark should not touch the real database. */
function makeSession(cwd) {
  const messages = [];
  return {
    id: 'bench', cwd, model: 'bench', messages,
    addMessage(m) { messages.push(m); },
    buildModelMessages(systemPrompt) {
      const out = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
      for (const m of messages) {
        if (m.role === 'tool') { out.push({ role: 'tool', content: m.content }); continue; }
        const msg = { role: m.role, content: m.content ?? '' };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
        }
        out.push(msg);
      }
      return out;
    },
    getTodos() { return []; },
    setTodos() {},
  };
}

async function runOne(model, task) {
  const cwd = makeWorkspace();
  const registry = createRegistry();
  const counters = { repairs: 0, toolErrors: 0, verifications: 0, escalations: 0, toolCalls: 0 };

  const ui = {
    onToolStart: () => { counters.toolCalls++; },
    onToolEnd: ({ result }) => { if (result.isError) counters.toolErrors++; },
    onToolRepaired: () => { counters.repairs++; },
    onVerificationFailed: () => { counters.verifications++; },
  };

  const started = Date.now();
  let result;
  try {
    result = await runTurn({
      session: makeSession(cwd),
      registry,
      permissions: new PermissionManager({ ask: async () => 'allow' }),
      config: {
        ...loadConfig(),
        model,
        escalationModel: null,      // measure the model alone, not the fallback
        judgeAnswers: false,        // and without a second model grading it
        maxIterations: 12,
      },
      ui,
      userText: task.prompt,
    });
  } catch (err) {
    fs.rmSync(cwd, { recursive: true, force: true });
    return { model, task: task.name, ok: false, error: err.message, ...counters };
  }

  fs.rmSync(cwd, { recursive: true, force: true });

  return {
    model,
    task: task.name,
    ok: result.status === TurnStatus.COMPLETE && task.passes(result.text || ''),
    status: result.status,
    steps: result.iterations,
    seconds: (Date.now() - started) / 1000,
    tokPerSec: result.usage?.tokensPerSecond ?? null,
    ...counters,
  };
}

const models = process.argv.slice(2);
if (!models.length) {
  console.error('usage: node bench/compare.js <model> [model...]');
  process.exit(2);
}

const rows = [];
for (const model of models) {
  for (const task of TASKS) {
    process.stderr.write(`running ${model} / ${task.name}…\n`);
    rows.push(await runOne(model, task));
  }
}

const byModel = new Map();
for (const r of rows) {
  const agg = byModel.get(r.model) || { pass: 0, total: 0, steps: 0, seconds: 0, repairs: 0, toolErrors: 0, verifications: 0, tps: [] };
  agg.total++;
  if (r.ok) agg.pass++;
  agg.steps += r.steps || 0;
  agg.seconds += r.seconds || 0;
  agg.repairs += r.repairs;
  agg.toolErrors += r.toolErrors;
  agg.verifications += r.verifications;
  if (r.tokPerSec) agg.tps.push(r.tokPerSec);
  byModel.set(r.model, agg);
}

console.log('');
console.log('model                 pass   steps   tok/s   repairs  toolErr  verifyFail   time');
console.log('-'.repeat(82));
for (const [model, a] of byModel) {
  const tps = a.tps.length ? (a.tps.reduce((x, y) => x + y, 0) / a.tps.length).toFixed(1) : '—';
  console.log(
    model.padEnd(22)
    + `${a.pass}/${a.total}`.padEnd(7)
    + String(a.steps).padEnd(8)
    + String(tps).padEnd(8)
    + String(a.repairs).padEnd(9)
    + String(a.toolErrors).padEnd(9)
    + String(a.verifications).padEnd(12)
    + `${a.seconds.toFixed(0)}s`,
  );
}
console.log('');
for (const r of rows) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.model.padEnd(22)} ${r.task.padEnd(12)} ${r.status ?? 'error'}`);
}
