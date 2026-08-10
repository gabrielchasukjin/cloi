import test from 'node:test';
import assert from 'node:assert/strict';
import {
  needsJudgement, buildEvidence, buildJudgePrompt, parseVerdict, judgeAnswer,
} from '../src/agent/judge.js';

/** A demanding turn: two files changed, which is what opens the gate. */
const ACTED = [
  { name: 'edit_file', args: { path: 'a.js' } },
  { name: 'edit_file', args: { path: 'b.js' } },
  { name: 'run_command', args: { command: 'npm test' } },
];

test('only causal and completion claims are worth a model call', () => {
  const steps = ACTED;
  for (const answer of [
    'The root cause is that completeTask mutates a copy.',
    'I fixed the function so it adds tax instead of replacing the subtotal.',
    'The tests now pass.',
    'The bug is in store.js, where the task object is cloned.',
  ]) {
    assert.equal(needsJudgement(answer, steps), true, `should judge: ${answer}`);
  }

  for (const answer of [
    'completionRate is defined in src/lib/stats.js.',
    'There are three files in src/lib.',
    'It returns 0 for an empty list.',
    // Words that read as claims but are not. The second is from this project's
    // own README, where "fixed" is an adjective.
    'It returns 0 because the list is empty.',
    'It replaced a fixed analyze then classify then patch pipeline.',
  ]) {
    assert.equal(needsJudgement(answer, steps), false, `should skip: ${answer}`);
  }
});

test('an answer with no tool calls behind it is never judged', () => {
  // Nothing was gathered, so there is no evidence to weigh.
  assert.equal(needsJudgement('The root cause is obvious.', []), false);
  assert.equal(needsJudgement('', ACTED), false);
});

test('a turn that only read files is not judged', () => {
  // Observed live: "startup fails early with exact fixes" matched `fixes` and
  // sent a plain description of a README to a 30B judge, which rejected it
  // twice and escalated. Nothing had been changed, so there was no claim of a
  // fix to check — only prose containing the word.
  const readOnly = [{ name: 'list_dir' }, { name: 'read_file' }, { name: 'grep' }];
  const answer = 'Cloi is a coding agent. Startup fails early with exact fixes if Ollama is missing.';
  assert.equal(needsJudgement(answer, readOnly), false);
  // A real claim, on a demanding turn, still goes through.
  assert.equal(needsJudgement('I fixed the guard so it returns 0.', ACTED), true);
});

test('an ordinary one-file fix is not worth a review', () => {
  // The commonest turn and the easiest to get right. Paying a 30B model to
  // re-read it buys almost nothing, which is the whole reason for this gate.
  const simple = [
    { name: 'read_file', args: { path: 'a.js' } },
    { name: 'edit_file', args: { path: 'a.js' } },
    { name: 'run_command', args: { command: 'npm test' } },
  ];
  assert.equal(needsJudgement('I fixed the bug and the tests now pass.', simple), false);
});

test('a change spanning two files is worth a review', () => {
  // Where local models actually fail: a fix that is right in isolation and
  // wrong against the caller it never opened.
  const crossFile = [
    { name: 'edit_file', args: { path: 'src/a.js' } },
    { name: 'edit_file', args: { path: 'src/b.js' } },
  ];
  assert.equal(needsJudgement('I fixed the bug in both call sites.', crossFile), true);
});

test('a turn the primary model already failed is worth a review', () => {
  const simple = [{ name: 'edit_file', args: { path: 'a.js' } }];
  assert.equal(needsJudgement('The root cause is a stale cache.', simple), false);
  assert.equal(needsJudgement('The root cause is a stale cache.', simple, { escalated: true }), true);
});

test('a long grind is worth a review even in one file', () => {
  const grind = [
    ...Array.from({ length: 9 }, () => ({ name: 'read_file', args: { path: 'a.js' } })),
    { name: 'edit_file', args: { path: 'a.js' } },
  ];
  assert.equal(needsJudgement('The root cause is a stale cache.', grind), true);
});

test('evidence keeps the shape of each call but clips the output', () => {
  const evidence = buildEvidence([
    { name: 'read_file', args: { path: 'a.js' }, output: 'x'.repeat(5000), isError: false },
    { name: 'run_command', args: { command: 'npm test' }, output: 'FAIL', isError: true },
  ]);
  assert.match(evidence, /read_file\(\{"path":"a\.js"\}\) -> ok/);
  assert.match(evidence, /run_command.*-> FAILED: FAIL/);
  // Clipped, not pasted whole. The bound is the allowance, not a fixed number:
  // a 5000-character read has to lose something at two steps.
  assert.ok(evidence.length < 5000, `evidence was ${evidence.length} chars`);
  assert.match(evidence, /…/);
});

test('evidence keeps only the most recent steps', () => {
  const steps = Array.from({ length: 30 }, (_, i) => ({ name: `tool${i}`, args: {}, output: 'ok' }));
  const evidence = buildEvidence(steps, { maxSteps: 5 });
  assert.ok(evidence.includes('tool29'));
  assert.ok(!evidence.includes('tool10'));
});

test('the prompt asks for a decision, not for skepticism', () => {
  const prompt = buildJudgePrompt({ userText: 'fix it', evidence: '1. read_file', answer: 'Fixed.' });
  assert.match(prompt, /SUPPORTED/);
  assert.match(prompt, /UNSUPPORTED: <one sentence/);
  // A judge told simply to be skeptical rejects nearly everything.
  assert.match(prompt, /Reject it only if/);
});

test('verdicts are parsed in both directions', () => {
  assert.deepEqual(parseVerdict('SUPPORTED'), { supported: true, reason: null });
  const bad = parseVerdict('UNSUPPORTED: store.js was never read.');
  assert.equal(bad.supported, false);
  assert.equal(bad.reason, 'store.js was never read.');
  assert.equal(parseVerdict('unsupported - no test was run').supported, false);
});

test('the reason is the final verdict, not the deliberation leading to it', () => {
  // Observed live: a reasoning model rehearsed the verdict a dozen times, and
  // matching the first occurrence printed its entire monologue as the "reason".
  const rambling = [
    'Let me check. So it might be UNSUPPORTED because the path looks wrong.',
    'But wait — maybe it is fine. Let me look again at the evidence.',
    'Therefore we reject.',
    'UNSUPPORTED: src/statistics does not exist.',
  ].join(' ');
  const verdict = parseVerdict(rambling);
  assert.equal(verdict.supported, false);
  assert.equal(verdict.reason, 'src/statistics does not exist.');
});

test('a reasoning scratchpad is not mistaken for the verdict', () => {
  // Inline <think> blocks, and the dangling closing tag some models emit alone.
  assert.equal(parseVerdict('<think>UNSUPPORTED maybe?</think> SUPPORTED').supported, true);
  const dangling = parseVerdict('so it is UNSUPPORTED I guess</think> SUPPORTED');
  assert.equal(dangling.supported, true);
});

test('a reason that runs on is cut to one sentence', () => {
  const long = `UNSUPPORTED: the file was never read. ${'Also '.repeat(80)}`;
  const { reason } = parseVerdict(long);
  assert.equal(reason, 'the file was never read.');
  assert.ok(reason.length <= 200);
});

test('an unparseable or empty verdict fails open', () => {
  // A confused judge must not block an answer from reaching the user.
  for (const reply of ['', '   ', 'I think it looks fine overall.', '```json\n{}\n```']) {
    assert.equal(parseVerdict(reply).supported, true, `should fail open: ${reply}`);
  }
});

test('judgeAnswer returns the verdict from the model', async () => {
  const provider = {
    chat: async () => ({ content: 'UNSUPPORTED: the fix was never applied to store.js.' }),
  };
  const verdict = await judgeAnswer({
    provider, model: 'big', userText: 'fix it',
    steps: [{ name: 'read_file', args: {}, output: 'ok' }],
    answer: 'Fixed the root cause.',
  });
  assert.equal(verdict.supported, false);
  assert.match(verdict.reason, /never applied/);
});

test('judgeAnswer runs without tools', async () => {
  let sawTools;
  const provider = {
    chat: async (opts) => { sawTools = opts.tools; return { content: 'SUPPORTED' }; },
  };
  await judgeAnswer({
    provider, model: 'big', userText: 'x',
    steps: [{ name: 'read_file', args: {}, output: 'ok' }],
    answer: 'Fixed it.',
  });
  assert.equal(sawTools, undefined, 'the review is one judgement, not another agent loop');
});

test('a judge that throws does not block the answer', async () => {
  const provider = { chat: async () => { throw new Error('model unavailable'); } };
  const verdict = await judgeAnswer({
    provider, model: 'big', userText: 'x',
    steps: [{ name: 'read_file', args: {}, output: 'ok' }],
    answer: 'Fixed the root cause.',
  });
  assert.equal(verdict.supported, true);
  assert.equal(verdict.skipped, true);
});

test('an abort propagates rather than being swallowed as approval', async () => {
  const err = new Error('aborted');
  err.name = 'AbortError';
  const provider = { chat: async () => { throw err; } };
  await assert.rejects(() => judgeAnswer({
    provider, model: 'big', userText: 'x',
    steps: [{ name: 'read_file', args: {}, output: 'ok' }],
    answer: 'Fixed the root cause.',
  }), /aborted/);
});

test('long command output keeps its tail, where failures live', () => {
  // Clipping from the front alone dropped the assertion values, and the judge
  // then rejected an answer for citing figures the evidence "did not show".
  const output = `${'setup noise '.repeat(200)}actual: { done: 0, open: 2 } expected: { done: 1, open: 1 }`;
  const evidence = buildEvidence(
    [{ name: 'run_command', args: { command: 'npm test' }, output, isError: true }],
    // Squeezed deliberately: this is about which end survives a clip, so the
    // shared allowance has to be small enough to force one.
    { maxChars: 300, budget: 300 },
  );
  assert.match(evidence, /actual: \{ done: 0, open: 2 \}/);
  assert.match(evidence, /expected: \{ done: 1, open: 1 \}/);
  assert.match(evidence, /…/, 'the middle should be elided, not the end');
});

test('a turn with few steps gives the judge room to see them', () => {
  // Observed live: a 50-line README read was clipped to 400 characters, and the
  // judge rejected a correct answer with "the evidence does not mention the
  // project rewriting an original Cloi pipeline" — true of the evidence it was
  // handed, false of the file the agent had actually read.
  const body = `${'filler. '.repeat(200)}This is a rewrite of the original Cloi.${' trailing.'.repeat(200)}`;
  const steps = [
    { name: 'list_dir', args: { path: '.' }, output: 'a\nb' },
    { name: 'read_file', args: { path: 'README.md' }, output: body },
  ];
  assert.match(buildEvidence(steps), /rewrite of the original Cloi/);
});

test('evidence stays bounded as steps pile up', () => {
  // The allowance is shared, so a long turn must not grow without limit.
  const steps = Array.from({ length: 12 }, (_, i) => ({
    name: 'read_file',
    args: { path: `f${i}.js` },
    output: 'x'.repeat(50_000),
  }));
  const evidence = buildEvidence(steps);
  assert.ok(evidence.length < 15_000, `evidence was ${evidence.length} chars`);
});

test('every step keeps a floor of its own', () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({
    name: 'run_command',
    args: { command: `cmd${i}` },
    output: 'y'.repeat(2000),
  }));
  for (const line of buildEvidence(steps).split('\n')) {
    assert.ok(line.length > 400, `a step was starved: ${line.length} chars`);
  }
});
