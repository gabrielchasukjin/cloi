/**
 * Usage accounting.
 *
 * One user turn spans several model calls, so per-call numbers are noisy and
 * hard to act on. These are aggregated into a per-turn view instead.
 *
 * Two figures matter most when running locally:
 *
 *  - **Generation speed** is computed against the model's own eval duration
 *    rather than wall clock, so it measures throughput and is not skewed by a
 *    cold-start model load or by time spent running tools.
 *  - **Peak prompt size** is a high-water mark, not a sum. It answers the
 *    question that actually bites on a local model: how close did this turn get
 *    to the context limit, beyond which history is silently dropped.
 */

export function createUsageAccumulator() {
  const steps = [];

  return {
    add(metrics) {
      if (metrics) steps.push(metrics);
    },

    get stepCount() {
      return steps.length;
    },

    totals() {
      if (!steps.length) return null;

      const sum = (key) => steps.reduce((acc, s) => acc + (s[key] || 0), 0);

      const promptTokens = sum('promptTokens');
      const outputTokens = sum('outputTokens');
      const evalMs = sum('evalMs');
      const promptEvalMs = sum('promptEvalMs');
      const loadMs = sum('loadMs');
      const wallMs = sum('wallMs');

      // The largest single prompt is the one that came closest to the limit.
      const peakPromptTokens = steps.reduce((max, s) => Math.max(max, s.promptTokens || 0), 0);
      const contextLength = steps.find((s) => s.contextLength)?.contextLength ?? null;

      return {
        steps: steps.length,
        promptTokens,
        outputTokens,
        totalTokens: promptTokens + outputTokens,
        peakPromptTokens,
        contextLength,
        contextUsed: contextLength ? peakPromptTokens / contextLength : null,
        evalMs,
        promptEvalMs,
        loadMs,
        wallMs,
        ttftMs: steps[0]?.ttftMs ?? null,
        tokensPerSecond: evalMs > 0 ? (outputTokens / evalMs) * 1000 : null,
        promptTokensPerSecond: promptEvalMs > 0 ? (promptTokens / promptEvalMs) * 1000 : null,
      };
    },
  };
}

export function formatTokens(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * Context pressure band, used to decide whether the stat deserves attention.
 *
 * Exceeding the context window is not an error the user ever sees: Ollama
 * silently drops the oldest history and the agent quietly starts forgetting
 * what it read. Surfacing the approach is the only warning available.
 *
 * @returns {'ok'|'warn'|'high'|'unknown'}
 */
export function contextPressure(totals) {
  if (!totals?.contextUsed && totals?.contextUsed !== 0) return 'unknown';
  if (totals.contextUsed >= 0.9) return 'high';
  if (totals.contextUsed >= 0.7) return 'warn';
  return 'ok';
}

/**
 * The default per-turn stat: context used.
 *
 * Deliberately one number. Throughput and latency are near-constant for a given
 * model and machine, so repeating them every turn is noise; context is the only
 * figure that drifts across a session and has a threshold worth acting on.
 * Everything else stays available through `/usage`.
 */
export function formatUsageCompact(totals) {
  if (!totals) return '';
  if (!totals.contextLength) {
    // No context figure available, so fall back to something non-empty.
    return `${formatTokens(totals.totalTokens)} tokens`;
  }
  const pct = Math.round(totals.contextUsed * 100);
  return `ctx ${formatTokens(totals.peakPromptTokens)}/${formatTokens(totals.contextLength)} · ${pct}%`;
}

/**
 * Full single-line summary. Not shown by default; available via `/usage`.
 *
 * @param {object} totals Output of `totals()`.
 * @param {object} [opts]
 * @param {number} [opts.turnMs] Wall time for the whole turn, including tool
 *   execution. Differs from model time, and the gap is informative.
 */
export function formatUsageLine(totals, { turnMs } = {}) {
  if (!totals) return '';

  const parts = [
    `${totals.steps} step${totals.steps === 1 ? '' : 's'}`,
    `${formatTokens(totals.promptTokens)} in / ${formatTokens(totals.outputTokens)} out`,
  ];

  if (totals.tokensPerSecond) parts.push(`${totals.tokensPerSecond.toFixed(1)} tok/s`);
  if (totals.ttftMs !== null) parts.push(`ttft ${formatDuration(totals.ttftMs)}`);
  parts.push(formatDuration(turnMs ?? totals.wallMs));

  if (totals.contextLength) {
    const pct = Math.round(totals.contextUsed * 100);
    parts.push(`ctx ${formatTokens(totals.peakPromptTokens)}/${formatTokens(totals.contextLength)} (${pct}%)`);
  }

  return parts.join(' · ');
}

/**
 * Multi-line breakdown, for when the one-liner is not enough.
 * Surfaced by the `/usage` command.
 */
export function formatUsageDetail(totals, { turnMs } = {}) {
  if (!totals) return 'No usage recorded yet.';

  const rows = [
    ['model steps', String(totals.steps)],
    ['input tokens', `${totals.promptTokens.toLocaleString()}`],
    ['output tokens', `${totals.outputTokens.toLocaleString()}`],
    ['total tokens', `${totals.totalTokens.toLocaleString()}`],
    ['generation', totals.tokensPerSecond ? `${totals.tokensPerSecond.toFixed(1)} tok/s` : '—'],
    ['prompt eval', totals.promptTokensPerSecond ? `${totals.promptTokensPerSecond.toFixed(1)} tok/s` : '—'],
    ['time to first token', formatDuration(totals.ttftMs)],
    ['model time', formatDuration(totals.evalMs + totals.promptEvalMs)],
    ['wall time', formatDuration(turnMs ?? totals.wallMs)],
  ];

  if (totals.loadMs > 0) rows.push(['model load', formatDuration(totals.loadMs)]);
  if (totals.contextLength) {
    rows.push([
      'peak context',
      `${totals.peakPromptTokens.toLocaleString()} / ${totals.contextLength.toLocaleString()} (${Math.round(totals.contextUsed * 100)}%)`,
    ]);
  }

  // Time not spent in the model is time spent running tools.
  if (turnMs) {
    const modelMs = totals.evalMs + totals.promptEvalMs;
    const toolMs = Math.max(0, turnMs - modelMs - totals.loadMs);
    rows.push(['tools + overhead', formatDuration(toolMs)]);
  }

  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
}
