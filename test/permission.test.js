import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionManager, DECISION, summarize } from '../src/agent/permission.js';

const safeTool = { name: 'read_file', permission: 'safe' };
const riskyTool = { name: 'run_command', permission: 'ask' };

test('safe tools never reach the approval prompt', async () => {
  let asked = 0;
  const pm = new PermissionManager({ ask: async () => { asked++; return 'deny'; } });
  const result = await pm.request(safeTool, {});
  assert.equal(result.decision, DECISION.ALLOW);
  assert.equal(asked, 0);
});

test('a one-off approval does not persist to the next call', async () => {
  let asked = 0;
  const pm = new PermissionManager({ ask: async () => { asked++; return 'allow'; } });
  await pm.request(riskyTool, { command: 'ls' });
  await pm.request(riskyTool, { command: 'pwd' });
  assert.equal(asked, 2, 'each call should be approved separately');
});

test('"always" suppresses later prompts for that tool only', async () => {
  const askedFor = [];
  const pm = new PermissionManager({
    ask: async ({ tool }) => { askedFor.push(tool.name); return 'always'; },
  });

  await pm.request(riskyTool, { command: 'ls' });
  await pm.request(riskyTool, { command: 'rm -rf /' });
  assert.deepEqual(askedFor, ['run_command'], 'second run_command should not prompt');

  await pm.request({ name: 'write_file', permission: 'ask' }, { path: 'a' });
  assert.deepEqual(askedFor, ['run_command', 'write_file'], 'a different tool still prompts');
});

test('denial reports a reason and flags the turn as aborted', async () => {
  const pm = new PermissionManager({ ask: async () => 'deny' });
  const result = await pm.request(riskyTool, { command: 'ls' });
  assert.equal(result.decision, DECISION.DENY);
  assert.match(result.reason, /declined/i);
  assert.equal(pm.aborted, true);
});

test('config autoApprove pre-approves without prompting', async () => {
  let asked = 0;
  const pm = new PermissionManager({
    ask: async () => { asked++; return 'deny'; },
    autoApprove: ['run_command'],
  });
  const result = await pm.request(riskyTool, { command: 'ls' });
  assert.equal(result.decision, DECISION.ALLOW);
  assert.equal(asked, 0);
});

test('a missing approval mechanism denies rather than silently allowing', async () => {
  const pm = new PermissionManager({});
  const result = await pm.request(riskyTool, { command: 'ls' });
  assert.equal(result.decision, DECISION.DENY);
  assert.match(result.reason, /No approval mechanism/);
});

test('summaries describe the action in terms a user can judge', () => {
  assert.match(summarize('run_command', { command: 'rm -rf build' }), /run: rm -rf build/);
  assert.match(summarize('edit_file', { path: 'src/a.js' }), /edit src\/a\.js/);
  assert.match(summarize('edit_file', { path: 'src/a.js', replace_all: true }), /all occurrences/);
  assert.match(summarize('write_file', { path: 'b.js', content: 'a\nb\nc' }), /write b\.js \(3 lines\)/);
});

test('approveAll lets a run proceed with nobody at the keyboard', async () => {
  // A one-shot run in a container has no stdin, so every gated tool is denied
  // and the agent can read but never act. A benchmark or a CI job needs a way
  // to say yes in advance — named for what it does, not something reassuring.
  const { PermissionManager } = await import('../src/agent/permission.js');
  const gated = { name: 'run_command', permission: 'ask' };

  const asking = new PermissionManager({ ask: async () => 'deny' });
  assert.equal((await asking.request(gated, {})).decision, 'deny');

  const approving = new PermissionManager({ approveAll: true, ask: async () => 'deny' });
  assert.equal((await approving.request(gated, {})).decision, 'allow', 'and it never asks');
});

test('approveAll is off unless it is asked for', async () => {
  const { PermissionManager } = await import('../src/agent/permission.js');
  const manager = new PermissionManager({});
  assert.equal(manager.approveAll, false);
  // Without an ask function and without approveAll, a gated tool is denied
  // rather than silently allowed.
  assert.equal((await manager.request({ name: 'edit_file', permission: 'ask' }, {})).decision, 'deny');
});
