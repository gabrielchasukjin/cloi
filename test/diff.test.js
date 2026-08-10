import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, trimContext, renderDiff, diffStat } from '../src/ui/diff.js';

const strip = (s) => (s ?? '').replace(/\[[0-9;]*m/g, '');

test('an unchanged file produces no diff', () => {
  // Rendering an empty change would spend three lines saying nothing happened.
  assert.equal(renderDiff('a\nb\n', 'a\nb\n'), null);
});

test('a changed line is reported as a removal and an addition', () => {
  const lines = diffLines('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(
    lines.map((l) => [l.type, l.text]),
    [['ctx', 'a'], ['del', 'b'], ['add', 'B'], ['ctx', 'c']],
  );
});

test('line numbers follow the file each side belongs to', () => {
  // An inserted line has no old number, and a deleted one has no new number —
  // conflating them makes the gutter lie about where the change landed.
  const lines = diffLines('a\nc', 'a\nb\nc');
  const added = lines.find((l) => l.type === 'add');
  assert.equal(added.newNo, 2);
  assert.equal(added.oldNo, null);
  assert.equal(lines.at(-1).oldNo, 2);
  assert.equal(lines.at(-1).newNo, 3);
});

test('a pure insertion does not rewrite the surrounding lines', () => {
  const lines = diffLines('a\nb\nc', 'a\nx\nb\nc');
  assert.equal(lines.filter((l) => l.type === 'del').length, 0, 'nothing was removed');
  assert.equal(lines.filter((l) => l.type === 'add').length, 1);
});

test('distant context is dropped', () => {
  const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 25', 'CHANGED');
  const kept = trimContext(diffLines(before, after));
  // Three lines of context either side of one replacement.
  assert.equal(kept.length, 8, `kept ${kept.length}`);
  assert.ok(kept.every((l) => !/line (1|2|48)$/.test(l.text)), 'far context must be dropped');
});

test('a long diff is clipped rather than flooding the screen', () => {
  const before = Array.from({ length: 200 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 200 }, (_, i) => `new ${i}`).join('\n');
  const out = strip(renderDiff(before, after, { maxLines: 10 }));
  const rows = out.split('\n');
  assert.equal(rows.length, 11, 'ten rows plus the tally');
  assert.match(rows.at(-1), /more lines/);
});

test('every rendered row carries a line number and a sign', () => {
  const out = strip(renderDiff('a\nb\nc', 'a\nB\nc'));
  for (const row of out.split('\n')) {
    assert.match(row, /^\s+\d+ [-+ ] /, `row not in gutter form: ${JSON.stringify(row)}`);
  }
});

test('a new file renders as all additions', () => {
  const out = strip(renderDiff('', 'one\ntwo\n'));
  assert.equal(out.split('\n').filter((r) => /\+ /.test(r)).length, 2);
});

test('the stat counts both sides', () => {
  assert.deepEqual(diffStat('a\nb', 'a\nB\nc'), { added: 2, removed: 1 });
});

test('rows are padded to a common width so the tint forms a block', () => {
  // A highlight whose right edge follows the code reads as damage rather than
  // as structure — the point of the tint is the straight edge.
  const out = strip(renderDiff('short\nb', 'short\na much longer replacement line'));
  const widths = new Set(out.split('\n').map((r) => r.length));
  assert.equal(widths.size, 1, `ragged rows: ${[...widths].join(', ')}`);
});

test('a line wider than the panel is cut, not wrapped', () => {
  // A wrapped row breaks the block and desynchronises the gutter.
  const long = 'x'.repeat(500);
  const out = strip(renderDiff('a', long));
  assert.ok(out.split('\n').every((r) => r.length <= 120), 'row exceeded the panel');
  assert.match(out, /…/);
});
