import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/agent/prompt.js';

const rulesOf = (toolNames) => buildSystemPrompt({ cwd: '/w', toolNames })
  .split('\n').filter((l) => /^\d+\. /.test(l));

test('the model is told about python only when it has python', async () => {
  // Describing a tool the model was not given is worse than silence: it spends
  // a turn calling something that is not there, and the repair costs another.
  const withIt = rulesOf(['read_file', 'python']).join('\n');
  const without = rulesOf(['read_file']).join('\n');
  assert.match(withIt, /one python cell/);
  assert.doesNotMatch(without, /python/);
});

test('rule numbering has no gaps whichever tools are present', () => {
  // A model reading "1, 2, 4" wonders what it was not told.
  for (const tools of [['read_file'], ['read_file', 'python'], []]) {
    const numbers = rulesOf(tools).map((l) => Number(l.split('.')[0]));
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1), `gap with tools: ${tools}`);
  }
});

test('batching is reconciled with taking one step at a time', () => {
  // Rule 3 says one step at a time; a loop over fifty files in one cell could
  // read as a violation, and a model that believes it is breaking a rule will
  // not do it.
  const withIt = rulesOf(['python']).join('\n');
  assert.match(withIt, /the cell is the step/);
});

test('the rules survive being asked for with no tools at all', () => {
  // buildSystemPrompt is called before availability is known in some paths.
  assert.ok(rulesOf(undefined).length >= 5);
  assert.doesNotMatch(buildSystemPrompt({ cwd: '/w' }), /undefined/);
});
