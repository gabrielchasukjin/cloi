import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * The benchmark is evidence, so its own logic has to be right. A fixture where
 * the answer is reachable by a shortcut measures nothing — which is exactly how
 * the first version of this experiment scored 3/3 on a baseline that never
 * touched the tool under test.
 */
test('the benchmark answer cannot be reached by counting exports alone', async () => {
  const source = fs.readFileSync(new URL('../bench/python-tool.js', import.meta.url), 'utf8');
  const files = [...source.matchAll(/\['(\w+)', (\d+), (\d+)\]/g)]
    .map(([, name, exports, lines]) => ({ name, exports: +exports, lines: +lines }));

  assert.ok(files.length >= 6, `parsed ${files.length} fixture files`);

  const densest = files.reduce((a, b) => (a.exports / a.lines > b.exports / b.lines ? a : b));
  const most = files.reduce((a, b) => (a.exports > b.exports ? a : b));
  assert.notEqual(densest.name, most.name, 'a tally of exports must give the wrong answer');
});

test('stripping the examples leaves the rest of the description intact', async () => {
  // The two arms must differ by the examples and nothing else, or the result
  // measures something other than what it claims.
  const { createRegistry } = await import('../src/tools/index.js');
  const full = createRegistry().get('python').description;
  const stripped = full.slice(0, full.indexOf('\nExamples:'));

  assert.ok(stripped.length > 200, 'the prose survives');
  assert.doesNotMatch(stripped, /^Examples:$/m);
  assert.match(stripped, /callable as a function/, 'the capability is still described');
});
