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
   * settle — a stated root cause, a claimed fix. Costs one call, so it only
   * fires on answers that assert a cause or an outcome.
   */
  judgeAnswers: true,
  /**
   * Model used for that review. Defaults to the escalation model when one is
   * configured: asking the model that just produced a wrong answer to grade it
   * mostly reproduces the error.
   */
  judgeModel: null,
  /** Sampling temperature. Low, because tool-call arguments must be exact. */
  temperature: 0.2,
  /**
   * Whether to let the model emit a visible reasoning pass. Off by default:
   * on local hardware the latency cost is large and the accuracy gain for
   * tool selection is small.
   */
  think: false,
  /** Context window requested from Ollama. */
  contextLength: 16384,
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

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  let fromFile = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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
