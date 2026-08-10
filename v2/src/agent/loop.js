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
import * as ollamaProvider from '../provider/ollama.js';
import { createUsageAccumulator } from '../util/usage.js';

/**
 * Text announcing a next step the model then failed to take.
 *
 * Weak models rarely fail mechanically; far more often they narrate an
 * intention ("I will now check the task list") and stop, which the loop would
 * otherwise read as a finished answer. Matched only against the tail of the
 * message, so a reply that merely mentions a plan in passing does not trip it.
 */
const STATED_INTENT =
  /\b(?:I(?:'m| am) going to|I will(?: now)?|I'll(?: now)?|Let(?:'s| us| me)(?: now)?|We(?:'ll| will| should| can)|Next,? I(?:'ll| will)|Next step|I need to|I should now|Tr(?:y|ying) (?:to |the |using )?)\s*\S/i;

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
 * @param {{chat: Function}} [opts.provider] Injectable so the loop stays
 *   provider-agnostic and can be driven by a scripted provider under test.
 * @returns {Promise<{status: string, iterations: number, text: string, usage: object|null, turnMs: number, error?: string}>}
 */
export async function runTurn({
  session, registry, permissions, config, ui = {}, userText, signal,
  provider = ollamaProvider,
}) {
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
  let currentModel = config.model;
  let escalations = 0;
  let surrenders = 0;
  /** Well-formed tool calls that ran and failed, back to back. */
  let consecutiveToolErrors = 0;
  /** Tool outcomes across the whole turn, used to spot a fruitless turn. */
  let toolsAttempted = 0;
  let toolsSucceeded = 0;
  const modelsUsed = [config.model];

  const done = (status) => ({
    status,
    iterations,
    text: lastText,
    usage: usage.totals(),
    turnMs: Date.now() - turnStartedAt,
    models: modelsUsed,
    escalations,
  });

  /**
   * Hand the turn to a more capable model after the primary got stuck.
   *
   * The replacement inherits the full conversation, so it can see exactly what
   * was tried. A note explaining why it was brought in is appended, because
   * otherwise it tends to repeat the approach that just failed.
   *
   * @returns {boolean} True if the turn should continue on the new model.
   */
  const tryEscalate = (reason) => {
    if (!config.escalationModel) return false;
    if (config.escalationModel === currentModel) return false;
    if (escalations >= config.maxEscalations) return false;

    escalations++;
    const from = currentModel;
    currentModel = config.escalationModel;
    modelsUsed.push(currentModel);

    // The new model starts with a clean slate: the previous model's repeated
    // calls should not immediately trip the guard for a different model that
    // has not tried them yet.
    callCounts.clear();
    strikes = 0;
    consecutiveToolErrors = 0;
    // The replacement model has its own nudge budget: it has not been asked to
    // follow through yet, and inheriting the previous model's exhausted count
    // meant a single narrated step ended the turn outright.
    surrenders = 0;

    session.addMessage({
      role: 'user',
      content:
        `The previous attempt got stuck: ${reason}. `
        + 'Look at what has already been tried above, then take a different approach. '
        + 'Do not repeat a tool call that already failed.',
    });

    ui.onEscalate?.({ from, to: currentModel, reason });
    return true;
  };

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
      response = await provider.chat({
        messages,
        tools: schemas,
        model: currentModel,
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

    usage.add({ ...response.metrics, model: currentModel });
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

      // Two signals that a reply is surrender rather than an answer. The
      // phrasing match catches a narrated next step, but phrasings are endless
      // and each run turns up a new one; the fruitless-turn check is
      // phrasing-independent and does the durable work: the model reached for
      // tools, nothing worked, and it stopped anyway.
      const fruitless = toolsAttempted > 0 && toolsSucceeded === 0;
      if (fruitless || STATED_INTENT.test(content.slice(-300))) {
        surrenders++;
        if (surrenders === 1) {
          ui.onNotice?.('The model described a next step without taking it; asking it to follow through.');
          session.addMessage({
            role: 'user',
            content:
              'You described what you would do next but did not do it. '
              + 'Either make that tool call now, or give me your final answer with no further plans.',
          });
          continue;
        }
        if (tryEscalate('the model kept describing next steps without taking them')) continue;
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
          if (tryEscalate(`${strikes} unusable tool calls in a row`)) break;
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
          if (tryEscalate('the model kept repeating the same tool call')) break;
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
      toolsAttempted++;
      if (!result.isError) {
        toolsSucceeded++;
        strikes = 0;
        consecutiveToolErrors = 0;
      } else if (++consecutiveToolErrors >= config.maxConsecutiveToolErrors) {
        const reason = `${consecutiveToolErrors} tool calls in a row failed`;
        if (tryEscalate(reason)) {
          consecutiveToolErrors = 0;
          break;
        }
        ui.onNotice?.(`Giving up: ${reason}.`);
        return done(TurnStatus.STUCK);
      }
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
