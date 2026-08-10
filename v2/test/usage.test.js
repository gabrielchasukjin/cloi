import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageAccumulator, formatTokens, formatDuration, formatUsageLine, formatUsageDetail,
  formatUsageCompact, contextPressure,
} from '../src/util/usage.js';

/** Shape returned by the provider for one model step. */
function step({ promptTokens = 100, outputTokens = 50, evalMs = 5000, promptEvalMs = 500, ttftMs = 800, contextLength = 16384, loadMs = 0 } = {}) {
  return {
    promptTokens, outputTokens, evalMs, promptEvalMs, ttftMs, contextLength, loadMs,
    wallMs: evalMs + promptEvalMs + loadMs,
    totalMs: evalMs + promptEvalMs + loadMs,
  };
}

test('an empty accumulator reports nothing rather than zeroes', () => {
  assert.equal(createUsageAccumulator().totals(), null);
});

test('token counts sum across the steps of a turn', () => {
  const usage = createUsageAccumulator();
  usage.add(step({ promptTokens: 500, outputTokens: 40 }));
  usage.add(step({ promptTokens: 900, outputTokens: 60 }));
  const t = usage.totals();
  assert.equal(t.steps, 2);
  assert.equal(t.promptTokens, 1400);
  assert.equal(t.outputTokens, 100);
  assert.equal(t.totalTokens, 1500);
});

test('peak context is a high-water mark, not a sum', () => {
  // Summing prompt tokens would suggest the context limit was blown when it
  // was not: each step resends history, it does not accumulate in one prompt.
  const usage = createUsageAccumulator();
  usage.add(step({ promptTokens: 4000, contextLength: 16384 }));
  usage.add(step({ promptTokens: 9000, contextLength: 16384 }));
  usage.add(step({ promptTokens: 6000, contextLength: 16384 }));
  const t = usage.totals();
  assert.equal(t.peakPromptTokens, 9000);
  assert.equal(t.contextLength, 16384);
  assert.ok(Math.abs(t.contextUsed - 9000 / 16384) < 1e-9);
});

test('generation rate uses model eval time, not wall clock', () => {
  // Wall clock would include tool execution and make the model look slower
  // than it is. 100 tokens over 10s of eval is 10 tok/s regardless of tools.
  const usage = createUsageAccumulator();
  usage.add(step({ outputTokens: 100, evalMs: 10_000 }));
  assert.ok(Math.abs(usage.totals().tokensPerSecond - 10) < 1e-9);
});

test('time to first token comes from the first step', () => {
  const usage = createUsageAccumulator();
  usage.add(step({ ttftMs: 1200 }));
  usage.add(step({ ttftMs: 300 }));
  assert.equal(usage.totals().ttftMs, 1200);
});

test('rates are null rather than Infinity when durations are zero', () => {
  const usage = createUsageAccumulator();
  usage.add(step({ evalMs: 0, promptEvalMs: 0, outputTokens: 5 }));
  const t = usage.totals();
  assert.equal(t.tokensPerSecond, null);
  assert.equal(t.promptTokensPerSecond, null);
});

test('formatTokens abbreviates at readable thresholds', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(24_000), '24k');
  assert.equal(formatTokens(null), '—');
});

test('formatDuration scales from milliseconds to minutes', () => {
  assert.equal(formatDuration(250), '250ms');
  assert.equal(formatDuration(4200), '4.2s');
  assert.equal(formatDuration(125_000), '2m05s');
  assert.equal(formatDuration(null), '—');
});

test('the one-line summary carries the figures that matter', () => {
  const usage = createUsageAccumulator();
  usage.add(step({ promptTokens: 1200, outputTokens: 80, evalMs: 8000, ttftMs: 900 }));
  usage.add(step({ promptTokens: 2400, outputTokens: 120, evalMs: 12_000 }));
  const line = formatUsageLine(usage.totals(), { turnMs: 45_000 });

  assert.match(line, /2 steps/);
  assert.match(line, /3\.6k in \/ 200 out/);
  assert.match(line, /10\.0 tok\/s/);
  assert.match(line, /ttft 900ms/);
  assert.match(line, /45\.0s/);
  assert.match(line, /ctx 2\.4k\/16k \(15%\)/);
});

test('the detail view separates model time from tool time', () => {
  const usage = createUsageAccumulator();
  usage.add(step({ evalMs: 10_000, promptEvalMs: 2000 }));
  const detail = formatUsageDetail(usage.totals(), { turnMs: 30_000 });
  assert.match(detail, /model time\s+12\.0s/);
  assert.match(detail, /wall time\s+30\.0s/);
  // 30s wall - 12s model = 18s in tools and overhead.
  assert.match(detail, /tools \+ overhead\s+18\.0s/);
});

test('the detail view is safe to call before anything has run', () => {
  assert.match(formatUsageDetail(null), /No usage recorded/);
});

test('the default per-turn stat is context alone', () => {
  const usage = createUsageAccumulator();
  usage.add(step({ promptTokens: 1300, contextLength: 16384 }));
  const line = formatUsageCompact(usage.totals());
  assert.equal(line, 'ctx 1.3k/16k · 8%');
  // The figures that barely move between turns stay out of the default view.
  assert.equal(/tok\/s|ttft|step/.test(line), false);
});

test('context pressure bands drive when the stat is highlighted', () => {
  const at = (promptTokens) => {
    const usage = createUsageAccumulator();
    usage.add(step({ promptTokens, contextLength: 10_000 }));
    return contextPressure(usage.totals());
  };
  assert.equal(at(1000), 'ok');
  assert.equal(at(6900), 'ok');
  assert.equal(at(7000), 'warn');
  assert.equal(at(8900), 'warn');
  assert.equal(at(9000), 'high');
  assert.equal(at(10_000), 'high');
  assert.equal(contextPressure(null), 'unknown');
});

test('the compact stat degrades gracefully without a context length', () => {
  const usage = createUsageAccumulator();
  usage.add(step({ promptTokens: 400, outputTokens: 100, contextLength: null }));
  assert.equal(formatUsageCompact(usage.totals()), '500 tokens');
});
