/**
 * Ollama provider.
 *
 * Talks to Ollama's HTTP API directly with `fetch` rather than going through a
 * client library. The wire format is small and stable, and owning the parser
 * means streaming, tool calls, and abort handling behave exactly the way the
 * agent loop needs them to.
 */

import { loadConfig } from '../config.js';

/**
 * Declarative description of the provider, kept separate from the transport so
 * a second provider can be added by supplying another profile rather than
 * threading conditionals through the agent loop.
 */
export const profile = {
  id: 'ollama',
  label: 'Ollama (local)',
  /** Ollama speaks the OpenAI-style `tools` schema. */
  toolFormat: 'openai',
  supportsStreaming: true,
  requiresApiKey: false,
};

export class OllamaError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
    this.cause = cause;
  }
}

function baseUrl() {
  return loadConfig().host.replace(/\/+$/, '');
}

/** True when an Ollama server is reachable. Used for actionable startup errors. */
export async function isReachable(timeoutMs = 2000) {
  try {
    const res = await fetch(`${baseUrl()}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Model tags installed on the server. */
export async function listModels() {
  const res = await fetch(`${baseUrl()}/api/tags`);
  if (!res.ok) throw new OllamaError(`Could not list models (HTTP ${res.status})`, { status: res.status });
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/**
 * Capability flags Ollama reports for a model. The agent loop needs `tools`;
 * checking up front turns a baffling "model just answers in prose" failure
 * into a clear error at startup.
 */
export async function getCapabilities(model) {
  try {
    const res = await fetch(`${baseUrl()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.capabilities || [];
  } catch {
    return [];
  }
}

export async function supportsTools(model) {
  return (await getCapabilities(model)).includes('tools');
}

/**
 * Download a model.
 *
 * Uses the HTTP API rather than shelling out to the `ollama` binary: the
 * binary may not be on PATH even when the server is reachable, and everything
 * else here already speaks HTTP.
 *
 * @param {string} model
 * @param {(pct: number, status: string) => void} [onProgress]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function pullModel(model, onProgress) {
  let res;
  try {
    res = await fetch(`${baseUrl()}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
  } catch (err) {
    return { ok: false, error: `Cannot reach Ollama at ${baseUrl()}: ${err.message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let failure = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl).trim();
        carry = carry.slice(nl + 1);
        if (!line) continue;

        let chunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        if (chunk.error) failure = String(chunk.error);
        if (chunk.total && chunk.completed) {
          onProgress?.(Math.round((chunk.completed / chunk.total) * 100), chunk.status || '');
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  return failure ? { ok: false, error: failure } : { ok: true };
}

/**
 * One model round-trip.
 *
 * Deliberately a *single* step: this never loops on tool calls. The agent loop
 * owns iteration so that persistence, permission gating, and doom-loop
 * detection all sit at one layer instead of being split across the transport.
 *
 * @param {object} opts
 * @param {Array} opts.messages Chat messages in Ollama wire format.
 * @param {Array} [opts.tools] Tool schemas in OpenAI function format.
 * @param {(text: string) => void} [opts.onDelta] Called with each content chunk.
 * @param {(text: string) => void} [opts.onThinking] Called with reasoning chunks.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content: string, thinking: string, toolCalls: Array, doneReason: string|null, metrics: object}>}
 */
export async function chat({ messages, tools, onDelta, onThinking, signal, model, think } = {}) {
  const cfg = loadConfig();
  const body = {
    model: model || cfg.model,
    messages,
    stream: true,
    think: think ?? cfg.think,
    options: {
      temperature: cfg.temperature,
      num_ctx: cfg.contextLength,
    },
  };
  if (tools && tools.length) body.tools = tools;

  // Started before dispatch, not after headers arrive: Ollama flushes response
  // headers together with the first chunk, so measuring from inside the stream
  // reader would exclude prompt evaluation and report a time-to-first-token
  // of zero.
  const startedAt = Date.now();

  let res;
  try {
    res = await fetch(`${baseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new OllamaError(
      `Cannot reach Ollama at ${baseUrl()}. Is the server running?`,
      { cause: err },
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new OllamaError(
      `Ollama returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      { status: res.status },
    );
  }

  return consumeStream(res, {
    onDelta,
    onThinking,
    contextLength: body.options.num_ctx,
    startedAt,
  });
}

/** Nanoseconds, as Ollama reports durations, to milliseconds. */
function nsToMs(ns) {
  return typeof ns === 'number' ? ns / 1e6 : 0;
}

/**
 * Derive usage statistics from Ollama's final stream chunk.
 *
 * Ollama reports raw counters and nanosecond durations; the useful figures are
 * the rates. Generation speed is computed against `eval_duration` rather than
 * wall clock, so it reflects the model's actual throughput and is not skewed by
 * model load time on a cold start.
 */
function buildMetrics(final, { startedAt, firstTokenAt, contextLength }) {
  const promptTokens = final?.prompt_eval_count ?? 0;
  const outputTokens = final?.eval_count ?? 0;
  const promptEvalMs = nsToMs(final?.prompt_eval_duration);
  const evalMs = nsToMs(final?.eval_duration);
  const loadMs = nsToMs(final?.load_duration);
  const totalMs = nsToMs(final?.total_duration) || (Date.now() - startedAt);

  return {
    promptTokens,
    outputTokens,
    totalTokens: promptTokens + outputTokens,
    loadMs,
    promptEvalMs,
    evalMs,
    totalMs,
    wallMs: Date.now() - startedAt,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
    tokensPerSecond: evalMs > 0 ? (outputTokens / evalMs) * 1000 : null,
    promptTokensPerSecond: promptEvalMs > 0 ? (promptTokens / promptEvalMs) * 1000 : null,
    contextLength: contextLength ?? null,
  };
}

/**
 * Parse Ollama's newline-delimited JSON stream.
 *
 * Chunks can split mid-line, so a carry buffer is kept across reads. A single
 * unparseable line is skipped rather than aborting the turn — a partial answer
 * is more useful than a crash.
 */
async function consumeStream(res, { onDelta, onThinking, contextLength, startedAt = Date.now() }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstTokenAt = null;
  let carry = '';
  let content = '';
  let thinking = '';
  const toolCalls = [];
  let doneReason = null;
  let final = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, newline).trim();
        carry = carry.slice(newline + 1);
        if (!line) continue;

        let chunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }

        if (chunk.error) throw new OllamaError(String(chunk.error));

        const msg = chunk.message;
        if (msg) {
          // Time to first token covers any generated content, including a
          // reasoning pass or a tool call with no prose.
          if (!firstTokenAt && (msg.thinking || msg.content || msg.tool_calls?.length)) {
            firstTokenAt = Date.now();
          }
          if (msg.thinking) {
            thinking += msg.thinking;
            onThinking?.(msg.thinking);
          }
          if (msg.content) {
            content += msg.content;
            onDelta?.(msg.content);
          }
          if (Array.isArray(msg.tool_calls)) {
            for (const call of msg.tool_calls) toolCalls.push(normalizeToolCall(call, toolCalls.length));
          }
        }
        if (chunk.done) {
          doneReason = chunk.done_reason || 'stop';
          final = chunk;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  return {
    content,
    thinking,
    toolCalls,
    doneReason,
    metrics: buildMetrics(final, { startedAt, firstTokenAt, contextLength }),
  };
}

/**
 * Normalize a tool call into a stable shape.
 *
 * Ollama may omit an id, and argument values arrive either as an object or as
 * a JSON string depending on the model template. Both are handled here so the
 * agent loop only ever sees one shape.
 */
function normalizeToolCall(call, index) {
  const fn = call.function || {};
  let args = fn.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      // Preserve the raw text; the loop reports it back as a usable error.
      args = { __raw: fn.arguments };
    }
  }
  return {
    id: call.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
    name: fn.name || '',
    arguments: args && typeof args === 'object' ? args : {},
  };
}
