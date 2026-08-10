import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh store per test, so handle numbering starts from one. */
async function freshSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloi-recall-'));
  process.env.CLOI_HOME = dir;
  const { Session } = await import('../src/session/store.js');
  return { session: Session.create({ cwd: dir, model: 'm' }), dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CLOI_HOME;
}

async function recall(session, args) {
  const { createRegistry } = await import('../src/tools/index.js');
  return createRegistry().dispatch('recall', args, { cwd: session.cwd, session, ui: {} });
}

test('handles are named after the tool and numbered per tool', async () => {
  const { session, dir } = await freshSession();
  assert.equal(session.saveResult({ toolName: 'read_file', args: { path: 'a.js' }, content: 'x' }), 'read_1');
  assert.equal(session.saveResult({ toolName: 'read_file', args: { path: 'b.js' }, content: 'x' }), 'read_2');
  // A different tool counts separately, so the number means something.
  assert.equal(session.saveResult({ toolName: 'grep', args: { pattern: 'q' }, content: 'x' }), 'grep_1');
  assert.equal(session.saveResult({ toolName: 'run_command', args: { command: 'npm test' }, content: 'x' }), 'run_1');
  cleanup(dir);
});

test('the stored copy is complete even when the model was shown a preview', async () => {
  // The whole point: a truncated read no longer has to be repeated.
  const { session, dir } = await freshSession();
  const full = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  const name = session.saveResult({ toolName: 'read_file', args: { path: 'big.js' }, content: full });

  // Recalling it whole still gets windowed — a 5000-line dump would just be
  // cut again by the same truncation that made storing it worthwhile.
  const whole = await recall(session, { name });
  assert.match(whole.output, /5000 lines/);
  assert.match(whole.output, /showing the first 200 of 5000 lines/);

  // The tail is reachable, which is the point: no re-reading the file.
  const tail = await recall(session, { name, start_line: 4998, end_line: 5000 });
  assert.match(tail.output, /line 4999/, 'the tail must be retrievable');
  cleanup(dir);
});

test('a stored result can be searched instead of re-read', async () => {
  const { session, dir } = await freshSession();
  const content = ['alpha', 'beta', 'gamma needle', 'delta', 'needle again'].join('\n');
  const name = session.saveResult({ toolName: 'read_file', args: { path: 'a.js' }, content });

  const hits = await recall(session, { name, pattern: 'needle' });
  assert.match(hits.output, /3\tgamma needle/, 'line numbers refer to the original');
  assert.match(hits.output, /5\tneedle again/);
  assert.doesNotMatch(hits.output, /alpha/);

  const none = await recall(session, { name, pattern: 'absent' });
  assert.match(none.output, /No lines match/);
  assert.equal(none.isError, false, 'no matches is an answer, not a failure');
  cleanup(dir);
});

test('a stored result can be sliced', async () => {
  const { session, dir } = await freshSession();
  const content = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join('\n');
  const name = session.saveResult({ toolName: 'read_file', args: { path: 'a.js' }, content });

  const slice = await recall(session, { name, start_line: 40, end_line: 42 });
  assert.match(slice.output, /40\tL40/);
  assert.match(slice.output, /42\tL42/);
  assert.doesNotMatch(slice.output, /L43/);
  cleanup(dir);
});

test('an unknown handle lists what does exist', async () => {
  // A bare "not found" invites the model to guess again.
  const { session, dir } = await freshSession();
  session.saveResult({ toolName: 'grep', args: { pattern: 'x' }, content: 'hit' });

  const missing = await recall(session, { name: 'read_9' });
  assert.equal(missing.isError, true);
  assert.match(missing.output, /grep_1/, 'the model needs to see the real names');
  cleanup(dir);
});

test('calling recall with no name lists the stored results', async () => {
  const { session, dir } = await freshSession();
  const empty = await recall(session, {});
  assert.match(empty.output, /Nothing stored yet/);

  session.saveResult({ toolName: 'read_file', args: { path: 'src/a.js' }, content: 'x'.repeat(50) });
  const listed = await recall(session, {});
  assert.match(listed.output, /read_1/);
  assert.match(listed.output, /src\/a\.js/, 'the arguments make a handle recognisable');
  cleanup(dir);
});

test('a bad pattern is reported, not thrown', async () => {
  const { session, dir } = await freshSession();
  const name = session.saveResult({ toolName: 'grep', args: {}, content: 'a\nb' });
  const bad = await recall(session, { name, pattern: '([unclosed' });
  assert.equal(bad.isError, true);
  assert.match(bad.output, /Invalid regular expression/);
  cleanup(dir);
});

test('a result survives the compaction that drops its message', async () => {
  // This is what the store buys over a live kernel: the conversation that
  // produced the result can be summarised away and the data is still there.
  const { session, dir } = await freshSession();
  const name = session.saveResult({
    toolName: 'grep', args: { pattern: 'completionRate' }, content: 'src/lib/stats.js:2: completionRate',
  });

  session.addMessage({ role: 'user', content: 'find it' });
  session.addMessage({ role: 'tool', content: `hit [saved as ${name}]`, toolName: 'grep' });
  session.addMessage({ role: 'user', content: 'now fix it' });

  const rows = session.rows();
  session.recordCompaction({ throughSeq: rows[2].seq, summary: `matches are in ${name}` });

  const sent = session.buildModelMessages(null);
  assert.ok(!sent.some((m) => m.content.includes('src/lib/stats.js:2')), 'the message is gone');

  const recovered = await recall(session, { name });
  assert.match(recovered.output, /src\/lib\/stats\.js:2/, 'the data is not');
  cleanup(dir);
});

test('a read stores the whole file, not just the window it delivered', async () => {
  // Without this the handle only holds what already fitted, and recall can do
  // nothing a re-read could not. The point is to read a file once.
  const { session, dir } = await freshSession();
  // Under the 256 KB storage cap, but far over what one result can carry.
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'p'.repeat(70)}`).join('\n');
  fs.writeFileSync(path.join(dir, 'big.js'), big);

  const { createRegistry } = await import('../src/tools/index.js');
  const registry = createRegistry();
  const ctx = { cwd: dir, session, ui: {} };

  const read = await registry.dispatch('read_file', { path: 'big.js' }, ctx);
  const delivered = read.output.split('\n').filter((l) => /^\s*\d+\t/.test(l)).length;
  assert.ok(delivered < 2000, 'the window must be smaller than the file for this to mean anything');

  const name = session.saveResult({ toolName: 'read_file', args: { path: 'big.js' }, content: read.meta.fullText });
  const stored = session.getResult(name).content.split('\n').length;
  assert.equal(stored, 2000, 'the handle holds the file, not the window');

  // A line the model was never shown, without reading the file again.
  const beyond = await recall(session, { name, start_line: 1999, end_line: 1999 });
  assert.match(beyond.output, /line 1998/);
  cleanup(dir);
});

test('a result too large to store is not stored', async () => {
  // A runaway command must not put half a megabyte into the session database.
  // The overflow file already covers that case.
  const { session, dir } = await freshSession();
  fs.writeFileSync(path.join(dir, 'huge.txt'), 'z'.repeat(400_000));

  const { createRegistry } = await import('../src/tools/index.js');
  const read = await createRegistry().dispatch('read_file', { path: 'huge.txt' }, { cwd: dir, session, ui: {} });
  assert.equal(read.meta.fullText, null, 'over the cap, nothing is offered for storage');
  cleanup(dir);
});
