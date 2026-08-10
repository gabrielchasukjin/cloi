/**
 * Credential containment.
 *
 * The agent can run shell commands and write files, so any secret reachable
 * from its environment is a secret it can exfiltrate — `echo $OPENAI_API_KEY`
 * is one tool call away. Two layers guard against that:
 *
 *   1. Secrets are stripped from the environment handed to child processes, so
 *      the agent cannot read them in the first place.
 *   2. Live secret *values* are redacted from tool output, so a credential that
 *      reaches the agent by some other route (a .env file, a config dump, a
 *      verbose log) never lands in the transcript or gets sent to a provider.
 *
 * This is defence in depth, not a guarantee. An agent running arbitrary commands
 * can still read a credentials file off disk. The goal is to remove the trivial
 * paths and make the remaining ones require deliberate action.
 */

/** Environment variable names that look like they hold a credential. */
const SECRET_NAME_PATTERN =
  /(^|_)(API_?KEYS?|ACCESS_?KEYS?|SECRET_?KEYS?|KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASS|CREDENTIALS?|AUTH|BEARER|PRIVATE_?KEY|CLIENT_?SECRET)($|_)/i;

/**
 * Names that match the pattern above but are not secrets, and whose removal
 * breaks ordinary workflows. `SSH_AUTH_SOCK` is a socket path git needs to
 * push; `XAUTHORITY` is a file path. Stripping either causes confusing
 * failures for no security benefit.
 */
const NOT_SECRETS = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'XAUTHORITY',
  'GPG_TTY',
  'AUTHORS',
  'KEYBOARD',
  'KEYMAP',
]);

/**
 * Provider variables worth naming explicitly, so a rename of the generic
 * pattern can never silently stop covering them.
 */
const KNOWN_SECRET_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
  'COHERE_API_KEY',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'SLACK_TOKEN',
  'DOCKER_PASSWORD',
]);

/**
 * Values shorter than this are too collision-prone to redact safely.
 *
 * Note the failure mode this guards against: redaction matches on *value*, so
 * any environment value that also appears legitimately in output gets mangled.
 * A session identifier that happens to be a directory name turned a real file
 * path into `.../[redacted]/...`, which is worse than useless to the model.
 * Hence `SESSION_ID` is deliberately absent from the name pattern above:
 * identifiers are not credentials, and treating them as such corrupts output.
 */
const MIN_REDACTABLE_LENGTH = 8;

export const REDACTION = '[redacted]';

/**
 * @param {string} name Environment variable name.
 * @returns {boolean} True if the variable should be withheld from child processes.
 */
export function isSecretName(name) {
  if (!name) return false;
  const upper = String(name).toUpperCase();
  if (NOT_SECRETS.has(upper)) return false;
  if (KNOWN_SECRET_NAMES.has(upper)) return true;
  return SECRET_NAME_PATTERN.test(upper);
}

/**
 * Copy of the environment with credential-bearing variables removed.
 *
 * @param {object} [env]
 * @returns {{env: object, removed: string[]}}
 */
export function sanitizeEnv(env = process.env) {
  const clean = {};
  const removed = [];
  for (const [key, value] of Object.entries(env)) {
    if (isSecretName(key)) {
      removed.push(key);
      continue;
    }
    clean[key] = value;
  }
  return { env: clean, removed };
}

/**
 * The set of live secret values worth scrubbing from output.
 *
 * Only actual values present in the environment are collected, which keeps
 * redaction precise: nothing is masked unless it is genuinely a credential
 * this process can see.
 *
 * @param {object} [env]
 * @returns {Set<string>}
 */
export function collectSecretValues(env = process.env) {
  const values = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (!isSecretName(key)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_REDACTABLE_LENGTH) values.add(trimmed);
  }
  return values;
}

/**
 * Replace known secret values in text.
 *
 * @param {string} text
 * @param {Set<string>|Iterable<string>} [values] Defaults to the live environment.
 * @returns {string}
 */
export function redactSecrets(text, values) {
  if (typeof text !== 'string' || !text) return text;
  const secrets = values ?? collectSecretValues();
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_REDACTABLE_LENGTH) continue;
    // Values can appear many times and are not regex-safe, so split/join.
    if (out.includes(secret)) out = out.split(secret).join(REDACTION);
  }
  return out;
}

export { SECRET_NAME_PATTERN, KNOWN_SECRET_NAMES, NOT_SECRETS, MIN_REDACTABLE_LENGTH };
