/**
 * Tool registry.
 *
 * Two invariants everything else depends on:
 *
 *  1. `dispatch` never throws. A tool that blows up returns an error string the
 *     model can read and react to. A thrown exception would end the turn and
 *     discard work the agent had already done.
 *  2. Every result is truncated. Tools read from a machine with far more data
 *     than fits in a context window.
 *
 * Availability is probed through an optional `check` and cached, so a tool
 * whose backing binary is missing is simply absent from the schema list rather
 * than failing at call time.
 */

import { truncateOutput, byteCapFor } from '../util/truncate.js';
import { redactSecrets } from '../util/secrets.js';
import { loadConfig } from '../config.js';

/** How long a successful/failed availability probe is trusted. */
const CHECK_TTL_MS = 30_000;
/**
 * After a check has passed once, a later failure is tolerated for this long
 * before the tool is withdrawn. Availability probes are frequently flaky
 * (a busy shell, a slow mount) and dropping a working tool mid-session is
 * far more disruptive than briefly offering one that errors.
 */
const CHECK_GRACE_MS = 60_000;

/** @typedef {'safe'|'ask'} Permission */

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.tools = new Map();
    this._checkCache = new Map();
  }

  /**
   * Register a tool definition.
   *
   * @param {object} def
   * @param {string} def.name
   * @param {string} def.description Shown to the model; be precise, it is the
   *   only guidance the model gets about when to reach for this.
   * @param {object} def.parameters JSON Schema for the arguments object.
   * @param {Permission} [def.permission] `ask` gates execution behind the user.
   * @param {() => Promise<boolean|{ok:boolean,reason?:string}>} [def.check]
   * @param {(args: object, ctx: object) => Promise<string|object>} def.execute
   * @param {number} [def.maxLines] Override output truncation.
   * @param {number} [def.maxBytes]
   */
  register(def) {
    if (!def?.name) throw new Error('Tool requires a name');
    if (typeof def.execute !== 'function') throw new Error(`Tool ${def.name} requires an execute()`);
    this.tools.set(def.name, {
      permission: 'safe',
      parameters: { type: 'object', properties: {} },
      ...def,
    });
    return this;
  }

  get(name) {
    return this.tools.get(name);
  }

  names() {
    return [...this.tools.keys()];
  }

  /** Tools currently usable, honouring availability probes. */
  async available() {
    const out = [];
    for (const tool of this.tools.values()) {
      if (await this._isAvailable(tool)) out.push(tool);
    }
    return out;
  }

  /** Tool schemas in the OpenAI function-calling shape Ollama expects. */
  async schemas() {
    const tools = await this.available();
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async _isAvailable(tool) {
    if (typeof tool.check !== 'function') return true;

    const cached = this._checkCache.get(tool.name);
    const now = Date.now();
    if (cached && now - cached.at < CHECK_TTL_MS) return cached.ok;

    let ok = false;
    try {
      const result = await tool.check();
      ok = typeof result === 'object' ? !!result?.ok : !!result;
    } catch {
      ok = false;
    }

    // Absorb a flaky failure if the probe recently succeeded.
    if (!ok && cached?.lastGoodAt && now - cached.lastGoodAt < CHECK_GRACE_MS) {
      this._checkCache.set(tool.name, { ...cached, at: now, ok: true });
      return true;
    }

    this._checkCache.set(tool.name, {
      at: now,
      ok,
      lastGoodAt: ok ? now : cached?.lastGoodAt,
    });
    return ok;
  }

  /**
   * Map a possibly-wrong tool name onto a real one.
   *
   * Small models routinely emit near-misses (`read`, `readFile`, `read_files`).
   * Repairing those is strictly better than rejecting the call: the model's
   * intent is unambiguous and a rejection costs a full round-trip.
   *
   * @returns {{name: string|null, repaired: boolean}}
   */
  resolveName(raw) {
    if (!raw) return { name: null, repaired: false };
    if (this.tools.has(raw)) return { name: raw, repaired: false };

    const candidates = this.names();
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(raw);

    for (const c of candidates) {
      if (norm(c) === target) return { name: c, repaired: true };
    }

    let best = null;
    let bestDistance = Infinity;
    for (const c of candidates) {
      const d = levenshtein(target, norm(c));
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    // Allow roughly a quarter of the name to be wrong, capped at 3 edits.
    const tolerance = Math.min(3, Math.max(1, Math.floor(target.length / 4)));
    if (best && bestDistance <= tolerance) return { name: best, repaired: true };
    return { name: null, repaired: false };
  }

  /**
   * Validate arguments against the tool's JSON Schema.
   *
   * Intentionally shallow: required keys, primitive types, and light coercion
   * of the string/number confusion small models make constantly. Anything
   * deeper belongs to the tool itself, which has real context for it.
   *
   * @returns {{ok: true, args: object} | {ok: false, error: string}}
   */
  validateArgs(tool, args) {
    const schema = tool.parameters || {};
    const props = schema.properties || {};
    const required = schema.required || [];
    const out = { ...(args || {}) };

    if (out.__raw !== undefined) {
      return { ok: false, error: `Arguments were not valid JSON. Received: ${String(out.__raw).slice(0, 200)}` };
    }

    for (const key of required) {
      if (out[key] === undefined || out[key] === null || out[key] === '') {
        return { ok: false, error: `Missing required argument "${key}". Expected: ${describeSchema(schema)}` };
      }
    }

    for (const [key, spec] of Object.entries(props)) {
      if (out[key] === undefined) continue;
      const coerced = coerce(out[key], spec.type);
      if (coerced === undefined) {
        return { ok: false, error: `Argument "${key}" should be a ${spec.type}, got ${typeof out[key]}.` };
      }
      out[key] = coerced;
    }

    return { ok: true, args: out };
  }

  /**
   * Execute a tool. Always resolves.
   *
   * @returns {Promise<{output: string, isError: boolean, meta?: object}>}
   */
  async dispatch(name, args, ctx = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: `Unknown tool "${name}". Available tools: ${this.names().join(', ')}`, isError: true };
    }

    const validation = this.validateArgs(tool, args);
    if (!validation.ok) {
      return { output: `Invalid arguments for ${name}: ${validation.error}`, isError: true };
    }

    let raw;
    try {
      raw = await tool.execute(validation.args, ctx);
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { output: `${name} was interrupted.`, isError: true };
      }
      // Exception messages routinely echo arguments, which may carry a secret.
      return { output: redactSecrets(`${name} failed: ${err?.message || String(err)}`), isError: true };
    }

    // Tools may return a bare string or {output, isError, meta}.
    const isError = typeof raw === 'object' && raw !== null ? !!raw.isError : false;
    const meta = typeof raw === 'object' && raw !== null ? raw.meta : undefined;
    const rawText = typeof raw === 'string'
      ? raw
      : (raw?.output ?? (raw === undefined ? '' : JSON.stringify(raw, null, 2)));

    // Scrub live credential values before the output reaches the transcript,
    // the model, or a remote provider. Catches secrets that arrived by a route
    // other than the child environment — a .env file, a config dump, a log.
    const text = redactSecrets(rawText);

    // The cap follows the context window rather than being a fixed size. A
    // 50 KB result is ~14k tokens, which does not fit in a 16k window at all.
    const { output, truncated, overflowPath } = truncateOutput(text, {
      maxLines: tool.maxLines,
      maxBytes: tool.maxBytes ?? byteCapFor(loadConfig().contextLength),
      label: name,
      // Only the tool knows whether there is a cheaper way to get the rest.
      hint: tool.truncationHint?.(validation.args) ?? undefined,
    });

    return { output, isError, meta: { ...meta, truncated, overflowPath } };
  }
}

function coerce(value, type) {
  switch (type) {
    case undefined:
      return value;
    case 'string':
      return typeof value === 'string' ? value : String(value);
    case 'integer':
    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    }
    case 'array':
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
        return [value];
      }
      return undefined;
    case 'object':
      return typeof value === 'object' && value !== null ? value : undefined;
    default:
      return value;
  }
}

function describeSchema(schema) {
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const parts = Object.entries(props).map(
    ([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${v.type || 'any'}`,
  );
  return `{ ${parts.join(', ')} }`;
}

/** Iterative Levenshtein with a rolling row; names are short so this is cheap. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[b.length];
}

export { levenshtein };
