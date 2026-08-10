import test from 'node:test';
import assert from 'node:assert/strict';
import {
  needsJudgement, buildEvidence, buildJudgePrompt, parseVerdict, judgeAnswer,
} from '../src/agent/judge.js';

test('only causal and completion claims are worth a model call', () => {
  const steps = 3;
  for (const answer of [
    'The root cause is that completeTask mutates a copy.',
    'Fixed: the function now adds tax instead of replacing the subtotal.',
    'The tests now pass.',
    'The bug is in store.js because the task object is cloned.',
  ]) {
    assert.equal(needsJudgement(answer, steps), true, `should judge: ${answer}`);
  }

  for (const answer of [
    'completionRate is defined in src/lib/stats.js.',
    'There are three files in src/lib.',
    'It returns 0 for an empty list.',
  ]) {
    assert.equal(needsJudgement(answer, steps), false, `should skip: ${answer}`);
  }
});

test('an answer with no tool calls behind it is never judged', () => {
  // Nothing was gathered, so there is no evidence to weigh.
  assert.equal(needsJudgement('The root cause is obvious.', 0), false);
  assert.equal(needsJudgement('', 5), false);
});

test('evidence keeps the shape of each call but clips the output', () => {
  const evidence = buildEvidence([
    { name: 'read_file', args: { path: 'a.js' }, output: 'x'.repeat(5000), isError: false },
    { name: 'run_command', args: { command: 'npm test' }, output: 'FAIL', isError: true },
  ]);
  assert.match(evidence, /read_file\(\{"path":"a\.js"\}\) -> ok/);
  assert.match(evidence, /run_command.*-> FAILED: FAIL/);
  assert.ok(evidence.length < 1200, 'evidence should be clipped, not pasted whole');
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
    { maxChars: 300 },
  );
  assert.match(evidence, /actual: \{ done: 0, open: 2 \}/);
  assert.match(evidence, /expected: \{ done: 1, open: 1 \}/);
  assert.match(evidence, /…/, 'the middle should be elided, not the end');
});
