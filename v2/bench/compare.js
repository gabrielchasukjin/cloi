#!/usr/bin/env node
/**
 * Head-to-head model comparison against the real tool registry.
 *
 * Public benchmarks use their own tools, prompts and scoring. What matters here
 * is how a model behaves inside *this* loop, with these eight tools and this
 * system prompt — so this runs the actual agent and counts what happened.
 *
 * Repeats are the point. A single pass over a handful of tasks produced results
 * that moved by a third between runs, which is enough to rank two models the
 * wrong way round. Anything reported below is a rate over several attempts,
 * with the spread shown.
 *
 * Usage:
 *   node bench/compare.js qwen3:8b nemotron-3-nano:4b
 *   node bench/compare.js --repeats 5 --difficulty hard qwen3:8b
 */

import fs from 'node:fs';
import { createRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/agent/permission.js';
import { runTurn, TurnStatus } from '../src/agent/loop.js';
import { loadConfig } from '../src/config.js';
import { TASKS, makeWorkspace } from './tasks.js';

function parseArgs(argv) {
  const opts = { repeats: 3, difficulty: null, models: [], maxIterations: 14 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--repeats': case '-n': opts.repeats = Number(argv[++i]); break;
      case '--difficulty': case '-d': opts.difficulty = argv[++i]; break;
      case '--max-iterations': opts.maxIterations = Number(argv[++i]); break;
      default: opts.models.push(argv[i]);
    }
  }
  return opts;
}

/** In-memory session: the benchmark must not touch the real database. */
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

async function runOne(model, task, { maxIterations }) {
  const cwd = makeWorkspace({ broken: !!task.broken });
  const counters = { repairs: 0, toolErrors: 0, verifications: 0, toolCalls: 0 };

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
      registry: createRegistry(),
      permissions: new PermissionManager({ ask: async () => 'allow' }),
      config: {
        ...loadConfig(),
        model,
        escalationModel: null,   // measure the model alone, not the fallback
        judgeAnswers: false,     // and without a second model grading it
        maxIterations,
      },
      ui,
      userText: task.prompt,
    });
  } catch (err) {
    fs.rmSync(cwd, { recursive: true, force: true });
    return { ok: false, status: 'error', error: err.message, seconds: (Date.now() - started) / 1000, ...counters };
  }

  let ok = false;
  try {
    ok = result.status === TurnStatus.COMPLETE
      && !!task.score({ text: result.text || '', cwd, toolCalls: counters.toolCalls });
  } catch {
    ok = false;
  }

  fs.rmSync(cwd, { recursive: true, force: true });

  return {
    ok,
    status: result.status,
    steps: result.iterations,
    seconds: (Date.now() - started) / 1000,
    tokPerSec: result.usage?.tokensPerSecond ?? null,
    ...counters,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

const opts = parseArgs(process.argv.slice(2));
if (!opts.models.length) {
  console.error('usage: node bench/compare.js [--repeats N] [--difficulty easy|medium|hard] <model>...');
  process.exit(2);
}

const tasks = opts.difficulty ? TASKS.filter((t) => t.difficulty === opts.difficulty) : TASKS;
const totalRuns = opts.models.length * tasks.length * opts.repeats;
console.error(`${opts.models.length} models x ${tasks.length} tasks x ${opts.repeats} repeats = ${totalRuns} runs\n`);

/** model -> task -> array of results */
const data = new Map();

for (const model of opts.models) {
  data.set(model, new Map());
  for (const task of tasks) {
    const runs = [];
    for (let i = 0; i < opts.repeats; i++) {
      process.stderr.write(`  ${model} / ${task.name} ${i + 1}/${opts.repeats}\r`);
      runs.push(await runOne(model, task, opts));
    }
    process.stderr.write(' '.repeat(60) + '\r');
    data.get(model).set(task.name, runs);
  }
  console.error(`  ${model} done`);
}

console.log('');
console.log('OVERALL');
console.log('model                  pass rate      steps   tok/s (sd)     repairs  toolErr   time');
console.log('-'.repeat(88));

for (const [model, byTask] of data) {
  const all = [...byTask.values()].flat();
  const passes = all.filter((r) => r.ok).length;
  const tps = all.map((r) => r.tokPerSec).filter(Boolean);
  const rate = ((passes / all.length) * 100).toFixed(0);
  console.log(
    model.padEnd(23)
    + `${passes}/${all.length} (${rate}%)`.padEnd(15)
    + mean(all.map((r) => r.steps || 0)).toFixed(1).padEnd(8)
    + `${mean(tps).toFixed(1)} (${stdev(tps).toFixed(1)})`.padEnd(15)
    + String(all.reduce((s, r) => s + r.repairs, 0)).padEnd(9)
    + String(all.reduce((s, r) => s + r.toolErrors, 0)).padEnd(10)
    + `${all.reduce((s, r) => s + r.seconds, 0).toFixed(0)}s`,
  );
}

console.log('');
console.log('BY DIFFICULTY');
console.log('model                  easy        medium      hard');
console.log('-'.repeat(60));
for (const [model, byTask] of data) {
  const cells = ['easy', 'medium', 'hard'].map((level) => {
    const names = tasks.filter((t) => t.difficulty === level).map((t) => t.name);
    const runs = names.flatMap((n) => byTask.get(n) || []);
    if (!runs.length) return '—'.padEnd(12);
    const p = runs.filter((r) => r.ok).length;
    return `${p}/${runs.length}`.padEnd(12);
  });
  console.log(model.padEnd(23) + cells.join(''));
}

console.log('');
console.log('BY TASK  (pass count out of ' + opts.repeats + ' repeats)');
const header = 'task              difficulty  ' + [...data.keys()].map((m) => m.slice(0, 20).padEnd(22)).join('');
console.log(header);
console.log('-'.repeat(header.length));
for (const task of tasks) {
  let line = task.name.padEnd(18) + task.difficulty.padEnd(12);
  for (const [, byTask] of data) {
    const runs = byTask.get(task.name) || [];
    const p = runs.filter((r) => r.ok).length;
    // A task that is not all-or-nothing is a task the model is guessing at.
    const flag = p > 0 && p < runs.length ? ' ~' : '';
    line += `${p}/${runs.length}${flag}`.padEnd(22);
  }
  console.log(line);
}
console.log('');
console.log('~ marks a task the model passed only sometimes — unreliable, not capable.');
