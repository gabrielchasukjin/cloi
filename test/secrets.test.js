import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSecretName, sanitizeEnv, collectSecretValues, redactSecrets, REDACTION,
} from '../src/util/secrets.js';
import { runShell } from '../src/tools/shell.js';
import { createRegistry } from '../src/tools/index.js';

test('recognises credential-shaped variable names', () => {
  for (const name of [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY', 'MY_APP_SECRET', 'DB_PASSWORD', 'CLIENT_SECRET',
    'NODE_AUTH_TOKEN', 'STRIPE_SECRET_KEY', 'some_api_key',
  ]) {
    assert.equal(isSecretName(name), true, `${name} should be treated as a secret`);
  }
});

test('leaves ordinary variables alone', () => {
  for (const name of ['PATH', 'HOME', 'NODE_ENV', 'LANG', 'PWD', 'TERM', 'CI', 'EDITOR']) {
    assert.equal(isSecretName(name), false, `${name} should not be treated as a secret`);
  }
});

test('keeps pattern-matching names that are not actually secrets', () => {
  // Stripping these breaks git push and GUI launches for no security gain.
  for (const name of ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'XAUTHORITY', 'GPG_TTY']) {
    assert.equal(isSecretName(name), false, `${name} must survive sanitisation`);
  }
});

test('sanitizeEnv removes secrets and preserves everything else', () => {
  const { env, removed } = sanitizeEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    OPENAI_API_KEY: 'sk-live-should-not-survive',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.SSH_AUTH_SOCK, '/tmp/ssh-agent.sock');
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.deepEqual(removed, ['OPENAI_API_KEY']);
});

test('collectSecretValues ignores values too short to redact safely', () => {
  const values = collectSecretValues({ A_TOKEN: 'short', B_TOKEN: 'long-enough-value' });
  assert.equal(values.has('short'), false);
  assert.equal(values.has('long-enough-value'), true);
});

test('redactSecrets masks every occurrence of a live value', () => {
  const values = new Set(['sk-live-abcdefghijkl']);
  const text = 'key=sk-live-abcdefghijkl and again sk-live-abcdefghijkl';
  const out = redactSecrets(text, values);
  assert.equal(out.includes('sk-live-abcdefghijkl'), false);
  assert.equal(out, `key=${REDACTION} and again ${REDACTION}`);
});

test('run_command does not expose credentials to the spawned shell', async () => {
  const KEY = 'MOONSHOT_API_KEY';
  const SECRET = 'sk-test-must-not-leak-0123456789';
  const previous = process.env[KEY];
  process.env[KEY] = SECRET;

  try {
    const cmd = process.platform === 'win32' ? `echo %${KEY}%` : `echo $${KEY}`;
    const result = await runShell(cmd, { cwd: process.cwd(), timeout: 20_000 });
    assert.equal(
      result.output.includes(SECRET),
      false,
      `run_command leaked the credential: ${result.output.trim()}`,
    );
  } finally {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
  }
});

test('run_command still receives the variables a build needs', async () => {
  const cmd = process.platform === 'win32' ? 'echo %PATH%' : 'echo $PATH';
  const result = await runShell(cmd, { cwd: process.cwd(), timeout: 20_000 });
  assert.ok(result.output.trim().length > 3, 'PATH should survive sanitisation');
});

test('tool output is scrubbed of live credential values', async () => {
  const KEY = 'OPENAI_API_KEY';
  const SECRET = 'sk-live-leaked-through-a-file-987654';
  const previous = process.env[KEY];
  process.env[KEY] = SECRET;

  const registry = createRegistry();
  registry.register({
    name: 'echo_secret',
    description: 'returns a secret as if read from a config file',
    parameters: { type: 'object', properties: {} },
    execute: async () => `config: API_KEY=${SECRET}`,
  });

  try {
    const result = await registry.dispatch('echo_secret', {}, { cwd: process.cwd() });
    assert.equal(result.output.includes(SECRET), false, 'secret survived redaction');
    assert.match(result.output, /\[redacted\]/);
  } finally {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
  }
});

test('identifiers are not treated as credentials', () => {
  // Redaction matches on value, so classifying an identifier as a secret
  // corrupts any legitimate output containing it — a session id that is also a
  // directory name turned a real file path into ".../[redacted]/...".
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'SESSION_ID', 'BUILD_ID', 'REQUEST_ID']) {
    assert.equal(isSecretName(name), false, `${name} should not be treated as a secret`);
  }
});

test('a path containing an identifier survives redaction intact', () => {
  const KEY = 'CLAUDE_CODE_SESSION_ID';
  const ID = '9a0dd86c-1498-47ca-a832-0e6e5649f938';
  const previous = process.env[KEY];
  process.env[KEY] = ID;
  try {
    const path = `C:\Users\gabri\Temp\${ID}\scratchpad\fakerepo`;
    assert.equal(redactSecrets(path), path, 'the path should not be mangled');
  } finally {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
  }
});
