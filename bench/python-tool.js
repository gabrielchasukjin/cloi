#!/usr/bin/env node
/**
 * Does documenting the Python tool change how a model uses it?
 *
 * The `python` tool exposes a persistent interpreter where stored results are
 * variables and every other tool is a callable function. None of that is
 * discoverable: a model that is not told cannot guess it. This measures the
 * cost of *not* saying so, by running the same task twice with the only
 * difference being whether the tool description carries worked examples.
 *
 * The task has to be one where the kernel genuinely wins, which is harder to
 * arrange than it sounds. The first version asked for a total count of
 * `export function` across a directory — but grep reports a match count, so it
 * answered in a single call and the baseline scored 3/3 without ever touching
 * Python. The fixture here varies exports and file length *independently*, so
 * the file with the highest exports-per-line is not the file with the most
 * exports, and no single tool call gets there.
 *
 * Usage:
 *   node bench/python-tool.js                         # default model, 8 repeats
 *   node bench/python-tool.js --repeats 12 qwen3:8b
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/agent/permission.js';
import { runTurn } from '../src/agent/loop.js';
import { loadConfig } from '../src/config.js';
import { Session } from '../src/session/store.js';
import { shutdownKernels, detectPython } from '../src/tools/kernel.js';

/**
 * Exports and total length vary independently.
 *
 * `golf` has the most exported functions; `hotel` has the highest ratio. A
 * model that tallies grep output and stops has the wrong answer, so reaching
 * the right one takes either a read of every file or a single cell.
 */
const FILES = [
  ['alpha', 4, 40], ['bravo', 2, 8], ['charlie', 5, 60], ['delta', 1, 30],
  ['echo', 3, 12], ['foxtrot', 2, 50], ['golf', 6, 90], ['hotel', 3, 9],
];

const TASK = 'For each file in src/, work out how many `export function` declarations it has '
  + 'divided by its total number of lines. Reply with just the filename that has the highest ratio.';

/** The file with the highest exports-per-line, computed rather than asserted. */
const ANSWER = FILES.reduce((best, f) => (f[1] / f[2] > best[1] / best[2] ? f : best))[0];

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloi-pybench-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "pybench" }\n');

  for (const [name, exports, lines] of FILES) {
    const body = [
      ...Array.from({ length: exports }, (_, i) => `export function ${name}_${i + 1}() { return ${i + 1}; }`),
      ...Array.from({ length: lines - exports }, (_, i) => `// padding line ${i + 1}`),
    ];
    fs.writeFileSync(path.join(dir, 'src', `${name}.js`), `${body.join('\n')}\n`);
  }
  return dir;
}

/** The registry, with the worked examples optionally stripped back out. */
function registryFor({ examples }) {
  const registry = createRegistry();
  if (!examples) {
    const tool = registry.get('python');
    const cut = tool.description.indexOf('\nExamples:');
    if (cut !== -1) tool.description = tool.description.slice(0, cut);
  }
  return registry;
}

async function runOnce({ model, cwd, examples, maxIterations }) {
  const registry = registryFor({ examples });
  const session = Session.create({ cwd, model });
  const calls = [];
  const errors = [];
  const started = Date.now();

  const result = await runTurn({
    session,
    registry,
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: {
      model, contextLength: 16384, maxIterations, escalationModel: null,
      // Both arms measure tool choice, not the rails. Verification and review
      // would add model calls that differ between arms for reasons unrelated
      // to the question being asked.
      verifyAnswers: false, judgeAnswers: false, compaction: true,
    },
    ui: {
      onToolStart: ({ name }) => calls.push(name),
      onToolEnd: ({ name, result: r }) => {
        if (name === 'python' && r.isError) errors.push(r.output.split('\n').pop().slice(0, 70));
      },
    },
    userText: TASK,
  });

  const text = result.text || '';
  return {
    correct: new RegExp(`\\b${ANSWER}\\b`, 'i').test(text),
    usedPython: calls.includes('python'),
    calls: calls.length,
    seconds: (Date.now() - started) / 1000,
    errors,
  };
}

function summarise(label, runs) {
  const n = runs.length;
  const rate = (pick) => `${runs.filter(pick).length}/${n}`;
  const mean = (pick) => (runs.reduce((s, r) => s + pick(r), 0) / n).toFixed(1);
  return {
    label,
    correct: rate((r) => r.correct),
    usedPython: rate((r) => r.usedPython),
    calls: mean((r) => r.calls),
    seconds: `${mean((r) => r.seconds)}s`,
    cellErrors: runs.reduce((s, r) => s + r.errors.length, 0),
  };
}

function parseArgs(argv) {
  const opts = { repeats: 8, model: null, maxIterations: 25 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeats' || argv[i] === '-n') opts.repeats = Number(argv[++i]);
    else if (argv[i] === '--max-iterations') opts.maxIterations = Number(argv[++i]);
    else if (!argv[i].startsWith('-')) opts.model = argv[i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const model = opts.model || loadConfig().model;

  if (!detectPython()) {
    console.error('No Python 3 interpreter found, so the tool under test is not offered. Nothing to measure.');
    return 1;
  }

  const cwd = makeWorkspace();
  console.log(`model      ${model}`);
  console.log(`task       ${TASK}`);
  console.log(`answer     ${ANSWER}.js  (most exports is ${FILES.reduce((b, f) => (f[1] > b[1] ? f : b))[0]}.js — a tally gets it wrong)`);
  console.log(`repeats    ${opts.repeats} per arm\n`);

  const arms = [];
  for (const examples of [false, true]) {
    const label = examples ? 'with examples' : 'without examples';
    const runs = [];
    for (let i = 0; i < opts.repeats; i++) {
      process.stdout.write(`  ${label}: run ${i + 1}/${opts.repeats}\r`);
      runs.push(await runOnce({ model, cwd, examples, maxIterations: opts.maxIterations }));
    }
    process.stdout.write(' '.repeat(40) + '\r');
    arms.push(summarise(label, runs));

    const failures = runs.flatMap((r) => r.errors);
    if (failures.length) {
      const counts = new Map();
      for (const f of failures) counts.set(f, (counts.get(f) || 0) + 1);
      arms.at(-1).topError = [...counts].sort((a, b) => b[1] - a[1])[0];
    }
  }

  console.log(`${'arm'.padEnd(18)}${'correct'.padEnd(10)}${'used python'.padEnd(14)}${'calls'.padEnd(8)}time`);
  for (const arm of arms) {
    console.log(
      arm.label.padEnd(18) + arm.correct.padEnd(10) + arm.usedPython.padEnd(14)
      + arm.calls.padEnd(8) + arm.seconds,
    );
  }

  for (const arm of arms) {
    if (arm.cellErrors) {
      console.log(`\n${arm.label}: ${arm.cellErrors} cells raised. Commonest: ${arm.topError?.[0]} (×${arm.topError?.[1]})`);
    }
  }

  shutdownKernels();
  // The interpreter ran with the fixture as its working directory and holds it
  // for a moment after being killed. Tidying up is not worth throwing away a
  // measurement that took minutes to produce.
  try {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch {
    console.log(`\n(left ${cwd} behind; the interpreter still held it)`);
  }
  return 0;
}

main().then((code) => { process.exitCode = code ?? 0; });
