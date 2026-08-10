/**
 * Configuration loading and persistence.
 *
 * Config is a flat JSON file. Environment variables win over the file so a
 * one-off run can override without mutating saved state.
 */

import fs from 'node:fs';
import { CONFIG_PATH, ensureDataDir } from './util/paths.js';

const DEFAULTS = {
  /** Ollama model tag used for the agent loop. */
  model: 'gemma4:12b',
  /** Ollama server base URL. */
  host: 'http://127.0.0.1:11434',
  /** Hard ceiling on model round-trips per user turn. */
  maxIterations: 40,
  /** Consecutive unusable tool calls tolerated before the turn is abandoned. */
  maxStrikes: 3,
  /** Identical tool calls tolerated before the loop is declared stuck. */
  doomLoopThreshold: 3,
  /**
   * Consecutive failing tool calls tolerated before the loop is declared stuck.
   *
   * Distinct from the strike budget, which only counts calls that were unusable
   * (unknown name, bad arguments). A model can instead emit perfectly well-formed
   * calls that all fail — wrong paths, wrong flags — and make no progress at all.
   * Nothing else detects that.
   */
  maxConsecutiveToolErrors: 3,
  /**
   * Model to hand the turn to when the primary gets stuck. Null disables
   * escalation.
   *
   * Routing is on observed failure rather than predicted task type: the loop
   * already knows when it is struggling, whereas classifying a task up front
   * would cost a model call to guess something the loop can simply measure.
   */
  escalationModel: null,
  /** How many times one turn may escalate before giving up. */
  maxEscalations: 1,
  /**
   * Check the answer's factual claims against the workspace before accepting
   * it. Costs no model call: claims about files are settled by the files.
   */
  verifyAnswers: true,
  /** How many times a failed check is handed back before escalating. */
  maxVerificationRetries: 1,
  /**
   * Ask a model whether the evidence supports claims the filesystem cannot
   * settle — a stated root cause, a claimed fix.
   *
   * Three states. `null`, the default, means **only after an escalation**: the
   * review is not paid for until the primary model has visibly failed at this
   * turn, which is the one moment its answer is worth doubting. `true` reviews
   * any turn passing the gates in judge.js; `false` never reviews.
   *
   * On by default was wrong. It cost a call on the largest model on the machine
   * for turns that were going fine, and a false rejection there is expensive
   * twice over — the wrong answer is handed back, and the retry escalates.
   */
  judgeAnswers: null,
  /**
   * Model used for that review. Defaults to the escalation model when one is
   * configured: asking the model that just produced a wrong answer to grade it
   * mostly reproduces the error.
   */
  judgeModel: null,
  /** Sampling temperature. Low, because tool-call arguments must be exact. */
  temperature: 0.2,
  /**
   * Whether Ollama should parse the model's reasoning pass into its own field.
   *
   * `null` means follow the model. Not a cosmetic default: `false` does not
   * stop a reasoning model from reasoning, it stops Ollama from separating the
   * reasoning out — qwen3 thought anyway and the whole monologue arrived as
   * ordinary content and was streamed to the user, ending in a stray
   * `</think>`. Models that declare the capability therefore get it parsed.
   *
   * Set `false` to force it off everywhere. Measured cost on a warm 4B model:
   * roughly 420ms per call becomes 850ms, so this is a real trade.
   */
  think: null,
  /** Context window requested from Ollama. */
  contextLength: 16384,
  /**
   * Summarise old history when the window is nearly full.
   *
   * Ollama does not refuse an over-long prompt, it silently drops the oldest
   * tokens — so without this the agent forgets what it was asked while
   * behaving as though it remembers. Set false to send everything and let it
   * truncate.
   */
  compaction: true,
  /** Head-room kept for the response, so the trigger fires before the window fills. */
  compactionReserveTokens: 2048,
  /** Tools permitted to run without asking, beyond those marked safe. */
  autoApprove: [],
  /**
   * Print the context-usage stat after each turn. Kept to one number on
   * purpose: throughput and latency barely move for a given model and machine,
   * whereas context climbs across a session and silently truncates history at
   * the limit. `/usage` shows the full breakdown on demand.
   */
  showUsage: true,
};

/** Bumped when a default changes in a way a saved config would otherwise pin. */
const CONFIG_VERSION = 2;

/**
 * Settings whose default changed, with the value they used to default to.
 *
 * A saved config records what setup wrote, not what the user chose, so a value
 * still equal to the old default was never a decision — and leaving it pinned
 * means an existing install never receives the fix. `think: false` in
 * particular did not merely keep the old behaviour: it is the setting under
 * which a reasoning model's monologue is streamed into the answer.
 *
 * This cannot tell a deliberate `false` from an inherited one. That is the
 * trade, taken because these were defaults nobody was ever asked about.
 */
const SUPERSEDED = {
  think: false,
  judgeAnswers: true,
};

let cached = null;

/** Drop values a config only holds because they used to be the default. */
function migrate(fromFile) {
  if (fromFile.configVersion >= CONFIG_VERSION) return fromFile;

  const migrated = { ...fromFile };
  const dropped = [];
  for (const [key, oldDefault] of Object.entries(SUPERSEDED)) {
    if (key in migrated && migrated[key] === oldDefault) {
      delete migrated[key];
      dropped.push(key);
    }
  }
  migrated.configVersion = CONFIG_VERSION;

  try {
    // Written directly rather than through saveConfig, which loads config and
    // would re-enter this.
    ensureDataDir();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(migrated, null, 2), 'utf8');
  } catch {
    // An unwritable config still migrates for this run; it just does not stick.
  }
  if (dropped.length) {
    console.error(`cloi: ${dropped.join(', ')} now follow the current defaults.`);
  }
  return migrated;
}

export function loadConfig() {
  if (cached) return cached;
  let fromFile = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fromFile = migrate(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    }
  } catch (err) {
    // A corrupt config should degrade to defaults, not prevent startup.
    console.error(`Ignoring unreadable config at ${CONFIG_PATH}: ${err.message}`);
  }

  const fromEnv = {};
  if (process.env.CLOI_MODEL) fromEnv.model = process.env.CLOI_MODEL;
  if (process.env.OLLAMA_HOST) fromEnv.host = normalizeHost(process.env.OLLAMA_HOST);

  cached = { ...DEFAULTS, ...fromFile, ...fromEnv };
  return cached;
}

export function saveConfig(patch) {
  ensureDataDir();
  const next = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return next;
}

/** Accept `host:port` as well as a full URL, matching Ollama's own convention. */
function normalizeHost(value) {
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  return `http://${value.replace(/\/+$/, '')}`;
}

export { DEFAULTS };
