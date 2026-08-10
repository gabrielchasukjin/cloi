import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, shouldCompact, keepRecentTokens, isCutPoint, findTurnStart,
  findCutPoint, buildSummaryPrompt, renderTranscript, summarise,
} from '../src/agent/compact.js';

/** Stored rows, oldest first, as the session table returns them. */
function rows(...spec) {
  return spec.map((s, i) => ({
    seq: i,
    role: s.role,
    content: s.content ?? 'x'.repeat(s.size ?? 40),
    tool_calls: s.tool_calls ?? null,
    tool_name: s.tool_name ?? null,
    is_error: s.is_error ?? 0,
  }));
}

/** A turn: question, assistant reply with a call, tool result, assistant answer. */
function turn(size = 400) {
  return [
    { role: 'user', size },
    { role: 'assistant', size, tool_calls: '[{"name":"read_file","arguments":{}}]' },
    { role: 'tool', size, tool_name: 'read_file' },
    { role: 'assistant', size },
  ];
}

test('the trigger fires before the window is full, not after', () => {
  // Reserve exists so there is still room for the response that follows.
  assert.equal(shouldCompact(13_000, 16_384, { reserveTokens: 2048 }), false);
  assert.equal(shouldCompact(14_500, 16_384, { reserveTokens: 2048 }), true);
});

test('a missing or nonsense window never triggers compaction', () => {
  // Better to send a large prompt than to summarise on a number we do not have.
  assert.equal(shouldCompact(9999, 0), false);
  assert.equal(shouldCompact(9999, undefined), false);
  assert.equal(shouldCompact(undefined, 16_384), false);
  assert.equal(shouldCompact(0, 16_384), false);
});

test('the token estimate over-counts rather than under-counts', () => {
  // Under-counting compacts a turn too late, and a turn too late is an overflow.
  const row = rows({ role: 'user', content: 'a'.repeat(360) })[0];
  assert.ok(estimateTokens(row) >= 100, `estimated ${estimateTokens(row)} for 360 chars`);
  // Tool call arguments cost tokens too and must be counted.
  const withCalls = { ...row, tool_calls: 'y'.repeat(360) };
  assert.ok(estimateTokens(withCalls) > estimateTokens(row));
});

test('a tool result is never a cut point', () => {
  // The whole point: a result separated from its call is an orphan, and the
  // model sees output for a request it never made.
  assert.equal(isCutPoint({ role: 'tool' }), false);
  assert.equal(isCutPoint({ role: 'user' }), true);
  assert.equal(isCutPoint({ role: 'assistant' }), true);
});

test('the cut never lands on a tool result', () => {
  const history = rows(...turn(), ...turn(), ...turn(), ...turn());
  const cut = findCutPoint(history, { keepTokens: 300 });
  assert.ok(cut, 'expected a cut');
  assert.notEqual(history[cut.firstKeptIndex].role, 'tool');
});

test('a cut inside a turn carries that turn\'s question across', () => {
  // Otherwise the kept span opens with an answer to a question that is gone,
  // and the model defends it instead of revisiting it.
  const history = rows(
    { role: 'user', content: 'first question' },
    { role: 'assistant', size: 2000 },
    { role: 'user', content: 'the question that matters' },
    { role: 'assistant', size: 2000, tool_calls: '[{"name":"grep","arguments":{}}]' },
    { role: 'tool', size: 2000, tool_name: 'grep' },
    { role: 'assistant', size: 200 },
  );
  const cut = findCutPoint(history, { keepTokens: 400 });
  assert.ok(cut);
  if (cut.isSplitTurn) {
    assert.equal(history[cut.turnStartIndex].role, 'user');
    assert.ok(cut.turnStartIndex < cut.firstKeptIndex);
  }
});

test('a cut on a turn boundary carries nothing extra', () => {
  const history = rows(...turn(2000), ...turn(200));
  const cut = findCutPoint(history, { keepTokens: 400 });
  assert.ok(cut);
  if (history[cut.firstKeptIndex].role === 'user') {
    assert.equal(cut.isSplitTurn, false);
    assert.equal(cut.turnStartIndex, -1);
  }
});

test('nothing is compacted when there is nothing to spare', () => {
  // A summary of one exchange costs a model call and buys nothing.
  assert.equal(findCutPoint([], { keepTokens: 500 }), null);
  assert.equal(findCutPoint(rows(...turn()), { keepTokens: 100_000 }), null);
});

test('a history with no earlier turn is left alone', () => {
  // Every row is inside the first turn; cutting anywhere orphans something.
  const single = rows({ role: 'user', size: 8000 }, { role: 'assistant', size: 8000 });
  const cut = findCutPoint(single, { keepTokens: 100 });
  assert.equal(cut, null, 'must not cut at index 0 and summarise nothing');
});

test('kept history scales with the window', () => {
  assert.ok(keepRecentTokens(16_384) > keepRecentTokens(8_192));
  // Never so small that the kept span is useless.
  assert.ok(keepRecentTokens(100) >= 512);
});

test('the transcript keeps tool names and failures', () => {
  const text = renderTranscript(rows(
    { role: 'assistant', content: 'checking', tool_calls: '[{"name":"run_command","arguments":{}}]' },
    { role: 'tool', content: 'Exit code 1', tool_name: 'run_command', is_error: 1 },
  ));
  assert.match(text, /called: run_command/);
  assert.match(text, /\[tool run_command FAILED\]/);
});

test('the summary prompt asks for verbatim paths and errors', () => {
  // Those are what a paraphrase loses first and the next turn needs most.
  const prompt = buildSummaryPrompt('conversation');
  assert.match(prompt, /## Goal/);
  assert.match(prompt, /## Done/);
  assert.match(prompt, /## Next/);
  assert.match(prompt, /verbatim/);
});

test('a summariser that fails leaves the history alone', async () => {
  // Large history beats no turn.
  const provider = { chat: async () => { throw new Error('model unavailable'); } };
  assert.equal(await summarise({ provider, model: 'm', rows: rows({ role: 'user' }) }), null);

  const empty = { chat: async () => ({ content: '   ' }) };
  assert.equal(await summarise({ provider: empty, model: 'm', rows: rows({ role: 'user' }) }), null);
});

test('an abort during summarisation propagates', async () => {
  // Ctrl+C must end the turn, not be swallowed as "no summary available".
  const err = new Error('aborted');
  err.name = 'AbortError';
  const provider = { chat: async () => { throw err; } };
  await assert.rejects(
    () => summarise({ provider, model: 'm', rows: rows({ role: 'user' }) }),
    /aborted/,
  );
});

test('findTurnStart walks back to the opening question', () => {
  const history = rows(
    { role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'assistant' },
  );
  assert.equal(findTurnStart(history, 3), 0);
  assert.equal(findTurnStart(rows({ role: 'assistant' }), 0), -1);
});

test('a compacted session sends a summary in place of old messages', async () => {
  // End to end through the real store: the pure cut logic passing does not
  // prove the rebuild honours it, and the loop rebuilds from SQLite every
  // iteration, so a compaction that is not persisted has no effect at all.
  const os = await import('node:os');
  const p = await import('node:path');
  const fsp = await import('node:fs');
  const dir = fsp.mkdtempSync(p.join(os.tmpdir(), 'cloi-compact-'));
  process.env.CLOI_HOME = dir;

  const { Session } = await import('../src/session/store.js');
  const session = Session.create({ cwd: dir, model: 'm' });

  session.addMessage({ role: 'user', content: 'first question' });
  session.addMessage({ role: 'assistant', content: 'first answer' });
  session.addMessage({ role: 'user', content: 'second question' });
  session.addMessage({ role: 'assistant', content: 'second answer' });

  const before = session.buildModelMessages('SYSTEM');
  assert.equal(before.length, 5, 'system plus four messages');

  const cutAt = session.rows()[2].seq;
  session.recordCompaction({ throughSeq: cutAt, summary: 'GOAL: ship it.' });

  const after = session.buildModelMessages('SYSTEM');
  assert.equal(after[0].role, 'system');
  assert.match(after[1].content, /earlier conversation, summarised/);
  assert.match(after[1].content, /GOAL: ship it\./);
  assert.equal(after.length, 4, 'system, summary, and the two kept messages');
  assert.equal(after[2].content, 'second question');
  assert.ok(!after.some((m) => m.content === 'first answer'), 'old messages must not be sent');

  // Nothing was deleted: the transcript on disk is still whole.
  assert.equal(session.rows().length, 4);

  fsp.rmSync(dir, { recursive: true, force: true });
  delete process.env.CLOI_HOME;
});

test('a carried question survives the cut it sits before', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  const fsp = await import('node:fs');
  const dir = fsp.mkdtempSync(p.join(os.tmpdir(), 'cloi-compact-'));
  process.env.CLOI_HOME = dir;

  const { Session } = await import('../src/session/store.js');
  const session = Session.create({ cwd: dir, model: 'm' });
  session.addMessage({ role: 'user', content: 'old chatter' });
  session.addMessage({ role: 'user', content: 'THE QUESTION' });
  session.addMessage({ role: 'assistant', content: 'the answer' });

  const stored = session.rows();
  session.recordCompaction({
    throughSeq: stored[2].seq,
    carrySeq: stored[1].seq,
    summary: 'earlier work',
  });

  const messages = session.buildModelMessages(null);
  const texts = messages.map((m) => m.content);
  assert.ok(texts.some((t) => t.includes('THE QUESTION')), 'the kept answer needs its question');
  assert.ok(!texts.some((t) => t.includes('old chatter')));

  fsp.rmSync(dir, { recursive: true, force: true });
  delete process.env.CLOI_HOME;
});
