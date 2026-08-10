/**
 * The agent loop.
 *
 * One user turn drives many model round-trips. Each iteration is a *single*
 * model step: the provider never loops on tool calls itself. Keeping iteration
 * here means persistence, permission gating, and every safety rail live at one
 * layer instead of being smeared across the transport.
 *
 * The rails exist because small local models fail in specific, recurring ways:
 * they invent tool names, they repeat a call that already failed, and they will
 * happily spin forever. Each of those has a matching guard below.
 */

import { buildSystemPrompt } from './prompt.js';
import { DECISION } from './permission.js';
import * as ollama from '../provider/ollama.js';
import { createUsageAccumulator } from '../util/usage.js';

export const TurnStatus = {
  COMPLETE: 'complete',
  ABORTED: 'aborted',
  MAX_ITERATIONS: 'max_iterations',
  STUCK: 'stuck',
  ERROR: 'error',
};

/**
 * Run one user turn to completion.
 *
 * @param {object} opts
 * @param {import('../session/store.js').Session} opts.session
 * @param {import('../tools/registry.js').ToolRegistry} opts.registry
 * @param {import('./permission.js').PermissionManager} opts.permissions
 * @param {object} opts.config
 * @param {object} [opts.ui] Event callbacks for rendering.
 * @param {string} opts.userText
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{status: string, iterations: number, text: string, usage: object|null, turnMs: number, error?: string}>}
 */
export async function runTurn({ session, registry, permissions, config, ui = {}, userText, signal }) {
  session.addMessage({ role: 'user', content: userText });

  const ctx = {
    cwd: session.cwd,
    session,
    ui,
    signal,
  };

  /** Counts of identical calls this turn, keyed by name+args. */
  const callCounts = new Map();
  const usage = createUsageAccumulator();
  const turnStartedAt = Date.now();
  let strikes = 0;
  let iterations = 0;
  let lastText = '';

  const done = (status) => ({
    status,
    iterations,
    text: lastText,
    usage: usage.totals(),
    turnMs: Date.now() - turnStartedAt,
  });

  while (true) {
    if (signal?.aborted) return done(TurnStatus.ABORTED);

    if (++iterations > config.maxIterations) {
      const note = `Stopped after ${config.maxIterations} steps without finishing.`;
      session.addMessage({ role: 'assistant', content: note });
      ui.onNotice?.(note);
      return done(TurnStatus.MAX_ITERATIONS);
    }

    ui.onIteration?.(iterations);

    // Rebuild from storage every iteration: the store is authoritative.
    const schemas = await registry.schemas();
    const messages = session.buildModelMessages(
      buildSystemPrompt({
        cwd: session.cwd,
        toolNames: schemas.map((s) => s.function.name),
        todos: session.getTodos(),
      }),
    );

    let response;
    try {
      response = await ollama.chat({
        messages,
        tools: schemas,
        signal,
        onDelta: ui.onAssistantDelta,
        onThinking: ui.onThinking,
      });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        return done(TurnStatus.ABORTED);
      }
      const message = err?.message || String(err);
      ui.onError?.(message);
      session.addMessage({ role: 'assistant', content: `Model call failed: ${message}` });
      return { ...done(TurnStatus.ERROR), error: message };
    }

    const { content, toolCalls } = response;
    if (content) lastText = content;

    usage.add(response.metrics);
    ui.onStepUsage?.(response.metrics);

    session.addMessage({
      role: 'assistant',
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });

    // No tool calls means the model is answering, which ends the turn.
    if (!toolCalls.length) {
      if (!content.trim()) {
        // An empty response with no tool call is a dead end; nudge once rather
        // than silently returning nothing to the user.
        session.addMessage({
          role: 'user',
          content: 'You replied with nothing. Either call a tool or give me your answer.',
        });
        continue;
      }
      ui.onAssistantDone?.(content);
      return done(TurnStatus.COMPLETE);
    }

    for (const call of toolCalls) {
      if (signal?.aborted) return done(TurnStatus.ABORTED);

      const resolved = registry.resolveName(call.name);

      if (!resolved.name) {
        strikes++;
        const message = `Unknown tool "${call.name}". Available tools: ${registry.names().join(', ')}.`;
        ui.onToolError?.({ name: call.name, message });
        recordToolResult(session, call, message, true);
        if (strikes >= config.maxStrikes) {
          const note = `Giving up after ${strikes} unusable tool calls.`;
          ui.onNotice?.(note);
          return done(TurnStatus.STUCK);
        }
        continue;
      }

      if (resolved.repaired) {
        ui.onToolRepaired?.({ from: call.name, to: resolved.name });
        call.name = resolved.name;
      }

      // Doom-loop guard: an identical call repeated is the model stuck in a
      // groove. Telling it so is more useful than letting it burn iterations.
      const key = `${call.name}:${stableStringify(call.arguments)}`;
      const seen = (callCounts.get(key) || 0) + 1;
      callCounts.set(key, seen);
      if (seen > config.doomLoopThreshold) {
        const message =
          `You have called ${call.name} with these exact arguments ${seen} times. `
          + 'The result will not change. Try a different approach, or tell me what is blocking you.';
        ui.onToolError?.({ name: call.name, message });
        recordToolResult(session, call, message, true);
        strikes++;
        if (strikes >= config.maxStrikes) {
          ui.onNotice?.('Stopping: the model is repeating itself.');
          return done(TurnStatus.STUCK);
        }
        continue;
      }

      const tool = registry.get(call.name);

      const permission = await permissions.request(tool, call.arguments);
      if (permission.decision === DECISION.DENY) {
        const message = permission.reason || 'The user declined this action.';
        recordToolResult(session, call, message, true);
        ui.onToolDenied?.({ name: call.name, args: call.arguments });
        if (permissions.aborted) return done(TurnStatus.ABORTED);
        continue;
      }

      ui.onToolStart?.({ name: call.name, args: call.arguments });
      const result = await registry.dispatch(call.name, call.arguments, ctx);
      ui.onToolEnd?.({ name: call.name, args: call.arguments, result });

      recordToolResult(session, call, result.output, result.isError);

      // Only a genuinely unusable call counts against the strike budget; a tool
      // that ran and reported a real failure is useful information.
      if (!result.isError) strikes = 0;
    }
  }
}

function recordToolResult(session, call, output, isError) {
  session.addMessage({
    role: 'tool',
    content: output,
    toolCallId: call.id,
    toolName: call.name,
    isError,
  });
}

/** Key-sorted stringify so argument order never masks an identical call. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export { stableStringify };
