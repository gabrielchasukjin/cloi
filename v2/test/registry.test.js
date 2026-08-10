import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, levenshtein } from '../src/tools/registry.js';

function makeRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file',
    description: 'read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, start_line: { type: 'integer' } },
      required: ['path'],
    },
    execute: async (args) => `read ${args.path}`,
  });
  registry.register({
    name: 'run_command',
    description: 'run',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async () => { throw new Error('boom'); },
  });
  return registry;
}

test('levenshtein computes edit distance', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('same', 'same'), 0);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('resolveName passes through exact matches without repairing', () => {
  const r = makeRegistry();
  assert.deepEqual(r.resolveName('read_file'), { name: 'read_file', repaired: false });
});

test('resolveName repairs common near-miss tool names', () => {
  const r = makeRegistry();
  for (const wrong of ['readFile', 'read-file', 'ReadFile', 'read_files']) {
    const result = r.resolveName(wrong);
    assert.equal(result.name, 'read_file', `expected ${wrong} to resolve to read_file`);
    assert.equal(result.repaired, true);
  }
});

test('resolveName refuses names that are not plausibly the same tool', () => {
  const r = makeRegistry();
  assert.equal(r.resolveName('send_email').name, null);
  assert.equal(r.resolveName('').name, null);
});

test('validateArgs reports missing required arguments', () => {
  const r = makeRegistry();
  const result = r.validateArgs(r.get('read_file'), {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing required argument "path"/);
});

test('validateArgs coerces stringified numbers', () => {
  const r = makeRegistry();
  const result = r.validateArgs(r.get('read_file'), { path: 'a.js', start_line: '12' });
  assert.equal(result.ok, true);
  assert.equal(result.args.start_line, 12);
});

test('validateArgs rejects arguments that failed to parse as JSON', () => {
  const r = makeRegistry();
  const result = r.validateArgs(r.get('read_file'), { __raw: '{path: broken' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test('dispatch converts a thrown tool error into a readable result', async () => {
  const r = makeRegistry();
  const result = await r.dispatch('run_command', { command: 'ls' }, {});
  assert.equal(result.isError, true);
  assert.match(result.output, /run_command failed: boom/);
});

test('dispatch reports unknown tools instead of throwing', async () => {
  const r = makeRegistry();
  const result = await r.dispatch('nope', {}, {});
  assert.equal(result.isError, true);
  assert.match(result.output, /Unknown tool/);
});

test('unavailable tools are excluded from the schema list', async () => {
  const r = makeRegistry();
  r.register({
    name: 'docker_ps',
    description: 'docker',
    check: async () => false,
    execute: async () => 'ok',
  });
  const schemas = await r.schemas();
  assert.equal(schemas.some((s) => s.function.name === 'docker_ps'), false);
  assert.equal(schemas.some((s) => s.function.name === 'read_file'), true);
});
