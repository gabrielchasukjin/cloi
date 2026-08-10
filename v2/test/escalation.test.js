import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, TurnStatus } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { PermissionManager } from '../src/agent/permission.js';

/**
 * Escalation is exercised against a scripted provider rather than a live model,
 * so the failure being escalated from is deterministic. The live behaviour of
 * any particular model is a separate question from whether the mechanism works.
 */

/** Minimal in-memory stand-in for the SQLite session. */
function fakeSession() {
  const messages = [];
  return {
    id: 'test',
    cwd: process.cwd(),
    messages,
    addMessage(m) { messages.push(m); },
    buildModelMessages() { return messages.map((m) => ({ role: m.role, content: m.content })); },
    getTodos() { return []; },
    setTodos() {},
  };
}

function registry() {
  const r = new ToolRegistry();
  r.register({
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async () => 'file contents',
  });
  return r;
}

const baseConfig = {
  model: 'small-model',
  maxIterations: 20,
  maxStrikes: 2,
  doomLoopThreshold: 2,
  escalationModel: null,
  maxEscalations: 1,
};

/**
 * A provider whose replies are scripted per model, so a turn can be made to
 * fail on one model and succeed on another without touching a real one.
 */
function scriptedProvider(script) {
  const calls = [];
  return {
    calls,
    chat: async ({ model }) => {
      calls.push(model);
      const next = script(model, calls.length);
      return {
        content: next.content ?? '',
        thinking: '',
        toolCalls: next.toolCalls ?? [],
        doneReason: 'stop',
        metrics: {
          promptTokens: 10, outputTokens: 5, evalMs: 100, promptEvalMs: 10,
          ttftMs: 50, contextLength: 4096, loadMs: 0, wallMs: 110,
        },
      };
    },
  };
}

test('a doom loop escalates to the bigger model instead of giving up', async () => {
  // The small model repeats one call forever; the big model answers.
  const script = (model) => (model === 'small-model'
    ? { toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'a.js' } }] }
    : { content: 'Here is the answer.' });

  const provider = scriptedProvider(script);
  const result = await runTurn({
    session: fakeSession(),
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model' },
    userText: 'do the thing',
    provider,
  });

  assert.equal(result.status, TurnStatus.COMPLETE, 'escalation should rescue the turn');
  assert.equal(result.escalations, 1);
  assert.deepEqual(result.models, ['small-model', 'big-model']);
  assert.ok(provider.calls.includes('big-model'), 'the escalation model should have been called');
});

test('without an escalation model the same turn reports stuck', async () => {
  const script = () => ({ toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'a.js' } }] });

  const result = await runTurn({
    session: fakeSession(),
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: null },
    userText: 'do the thing',
    provider: scriptedProvider(script),
  });
  assert.equal(result.status, TurnStatus.STUCK);
  assert.equal(result.escalations, 0);
  assert.deepEqual(result.models, ['small-model']);
});

test('hallucinated tool names also trigger escalation', async () => {
  const script = (model) => (model === 'small-model'
    // Far enough from any real name that repair cannot rescue it.
    ? { toolCalls: [{ id: 'c', name: 'send_email_to_customer', arguments: {} }] }
    : { content: 'Recovered.' });

  const result = await runTurn({
    session: fakeSession(),
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model' },
    userText: 'do the thing',
    provider: scriptedProvider(script),
  });
  assert.equal(result.status, TurnStatus.COMPLETE);
  assert.equal(result.escalations, 1);
});

test('escalation happens at most maxEscalations times', async () => {
  // Neither model ever succeeds: the turn must still terminate.
  const script = () => ({ toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'a.js' } }] });

  const result = await runTurn({
    session: fakeSession(),
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model', maxEscalations: 1 },
    userText: 'do the thing',
    provider: scriptedProvider(script),
  });
  assert.equal(result.status, TurnStatus.STUCK);
  assert.equal(result.escalations, 1, 'should not escalate past the cap');
  assert.deepEqual(result.models, ['small-model', 'big-model']);
});

test('an escalation model identical to the primary is not a switch', async () => {
  const script = () => ({ toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'a.js' } }] });

  const result = await runTurn({
    session: fakeSession(),
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'small-model' },
    userText: 'do the thing',
    provider: scriptedProvider(script),
  });
  assert.equal(result.status, TurnStatus.STUCK);
  assert.equal(result.escalations, 0);
});

test('the escalated model is told why it was brought in', async () => {
  const session = fakeSession();
  const script = (model) => (model === 'small-model'
    ? { toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'a.js' } }] }
    : { content: 'done' });

  await runTurn({
    session,
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model' },
    userText: 'do the thing',
    provider: scriptedProvider(script),
  });
  const handoff = session.messages.find((m) => String(m.content).includes('previous attempt got stuck'));
  assert.ok(handoff, 'a handoff note should be added to the conversation');
  assert.match(handoff.content, /different approach/);
});

test('narrating a next step without taking it is nudged, not accepted', async () => {
  const session = fakeSession();
  let turn = 0;
  const script = () => {
    turn++;
    // Surrenders once, then follows through after the nudge.
    return turn === 1
      ? { content: 'No matches found. I will now check the other directory.' }
      : { content: 'It is in src/lib/stats.js and returns 0.' };
  };

  const provider = scriptedProvider(script);
  const result = await runTurn({
    session,
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model' },
    userText: 'where is it',
    provider,
  });

  assert.equal(result.status, TurnStatus.COMPLETE);
  assert.equal(provider.calls.length, 2, 'the model should be asked to follow through');
  assert.equal(result.escalations, 0, 'a nudge should be tried before escalating');
  assert.ok(session.messages.some((m) => String(m.content).includes('did not do it')));
  assert.match(result.text, /stats\.js/);
});

test('repeated surrender escalates after the nudge fails', async () => {
  const script = (model) => (model === 'small-model'
    ? { content: 'I will now look at the other file.' }
    : { content: 'It is in src/lib/stats.js.' });

  const provider = scriptedProvider(script);
  const result = await runTurn({
    session: fakeSession(),
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model' },
    userText: 'where is it',
    provider,
  });

  assert.equal(result.status, TurnStatus.COMPLETE);
  assert.equal(result.escalations, 1, 'persistent surrender should escalate');
  assert.deepEqual(result.models, ['small-model', 'big-model']);
});

test('an ordinary final answer is not mistaken for surrender', async () => {
  const provider = scriptedProvider(() => ({
    content: 'The function is in src/lib/stats.js and returns 0 for an empty list.',
  }));
  const result = await runTurn({
    session: fakeSession(),
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model' },
    userText: 'where is it',
    provider,
  });
  assert.equal(result.status, TurnStatus.COMPLETE);
  assert.equal(provider.calls.length, 1, 'a real answer should not be nudged');
  assert.equal(result.escalations, 0);
});

test('well-formed tool calls that keep failing escalate', async () => {
  // The distinguishing case: names and arguments are valid, the calls simply
  // fail. No strike accrues and no call repeats, so nothing else detects it.
  const r = new ToolRegistry();
  r.register({
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (args) => ({ output: `File not found: ${args.path}`, isError: true }),
  });

  let n = 0;
  const script = (model) => (model === 'small-model'
    // A different path each time, so the doom-loop guard never fires.
    ? { toolCalls: [{ id: `c${++n}`, name: 'read_file', arguments: { path: `guess${n}.js` } }] }
    : { content: 'Found it in src/lib/stats.js.' });

  const provider = scriptedProvider(script);
  const result = await runTurn({
    session: fakeSession(),
    registry: r,
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model', maxConsecutiveToolErrors: 3 },
    userText: 'find it',
    provider,
  });

  assert.equal(result.status, TurnStatus.COMPLETE, 'escalation should rescue the turn');
  assert.equal(result.escalations, 1);
  assert.deepEqual(result.models, ['small-model', 'big-model']);
});

test('an occasional tool failure between successes does not escalate', async () => {
  const r = new ToolRegistry();
  let call = 0;
  r.register({
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    // Fail, succeed, fail, succeed — never three failures in a row.
    execute: async () => (++call % 2 === 1
      ? { output: 'File not found', isError: true }
      : 'contents'),
  });

  let n = 0;
  const script = () => (n < 4
    ? { toolCalls: [{ id: `c${++n}`, name: 'read_file', arguments: { path: `f${n}.js` } }] }
    : { content: 'Done.' });

  const result = await runTurn({
    session: fakeSession(),
    registry: r,
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model', maxConsecutiveToolErrors: 3 },
    userText: 'find it',
    provider: scriptedProvider(script),
  });

  assert.equal(result.status, TurnStatus.COMPLETE);
  assert.equal(result.escalations, 0, 'intermittent failures are normal, not stuck');
});

test('a fruitless turn escalates regardless of how the model phrases it', async () => {
  // The durable signal: tools were tried, none worked, and the model stopped.
  // No intent phrase, no repeat, no unknown name — nothing else would catch it.
  const r = new ToolRegistry();
  r.register({
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async () => ({ output: 'File not found', isError: true }),
  });

  let n = 0;
  const script = (model) => {
    if (model !== 'small-model') return { content: 'It is in src/lib/stats.js and returns 0.' };
    return ++n === 1
      ? { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'tasks.json' } }] }
      // Plain prose, no announced intention at all.
      : { content: 'The file tasks.json was not found.' };
  };

  const provider = scriptedProvider(script);
  const result = await runTurn({
    session: fakeSession(),
    registry: r,
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model', maxConsecutiveToolErrors: 5 },
    userText: 'find it',
    provider,
  });

  assert.equal(result.status, TurnStatus.COMPLETE);
  assert.equal(result.escalations, 1, 'a fruitless turn should escalate');
  assert.deepEqual(result.models, ['small-model', 'big-model']);
  assert.match(result.text, /stats\.js/);
});

test('a turn with a successful tool call is not treated as fruitless', async () => {
  const r = new ToolRegistry();
  r.register({
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async () => 'contents of the file',
  });

  let n = 0;
  const script = () => (++n === 1
    ? { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.js' } }] }
    : { content: 'It returns 0 for an empty list.' });

  const provider = scriptedProvider(script);
  const result = await runTurn({
    session: fakeSession(),
    registry: r,
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model' },
    userText: 'what does it return',
    provider,
  });

  assert.equal(result.status, TurnStatus.COMPLETE);
  assert.equal(result.escalations, 0);
  assert.equal(provider.calls.length, 2, 'a productive turn should not be nudged');
});

test('the escalated model gets a fresh nudge budget', async () => {
  // Inheriting an exhausted surrender count meant the new model was dropped
  // after a single narrated step, before it had been asked to follow through.
  let n = 0;
  const script = (model) => {
    if (model === 'small-model') return { content: 'I will now check the file.' };
    n++;
    return n === 1
      ? { content: 'Let me look at store.js next.' }   // narrates once
      : { content: 'Fixed: completeTask mutated a copy.' };
  };

  const provider = scriptedProvider(script);
  const result = await runTurn({
    session: fakeSession(),
    registry: registry(),
    permissions: new PermissionManager({ ask: async () => 'allow' }),
    config: { ...baseConfig, escalationModel: 'big-model' },
    userText: 'fix the test',
    provider,
  });

  assert.equal(result.escalations, 1);
  assert.equal(n, 2, 'the escalated model should be nudged rather than abandoned');
  assert.match(result.text, /Fixed/);
});
