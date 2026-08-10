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
import { verifyAnswer, checkCoverage, checkEditOutcome } from './verify.js';
import { needsJudgement, judgeAnswer } from './judge.js';
import {
  shouldCompact, keepRecentTokens, findCutPoint, summarise, DEFAULT_RESERVE_TOKENS,
} from './compact.js';

/**
 * Text announcing a next step the model then failed to take.
 *
 * Weak models rarely fail mechanically; far more often they narrate an
 * intention ("I will now check the task list") and stop, which the loop would
 * otherwise read as a finished answer. Matched only against the tail of the
 * message, so a reply that merely mentions a plan in passing does not trip it.
 */
const STATED_INTENT = new RegExp(
  [
    /I(?:'m| am) going to/,
    /I will(?: now)?/,
    /I'll(?: now)?/,
    // "Let me know if you want…" is a sign-off, the opposite of an unfinished
    // step, and nudging it cost a round-trip on a turn that was already done.
    /Let(?:'s| us| me)(?: now)?(?!\s+know)/,
    // Only a commitment. "We can also override it per run" is an offer, and
    // `We should` is a suggestion — neither is a step the model meant to take.
    /We(?:'ll| will)/,
    /Next,? I(?:'ll| will)/,
    /Next step/,
    /I need to/,
    /I should now/,
    // `Try …` is gone: "try running npm test to confirm" is advice to the
    // reader, not a narrated next step, and it fired on finished answers.
    //
    // Regex literals rather than strings, because "\b" inside a string handed
    // to RegExp is a backspace character, not a word boundary.
  ].map((r) => `(?:${r.source})`).join('|'),
  'i',
);

/**
 * The phrase, plus something after it.
 *
 * The trailing `\s*\S` stops a phrase at the very end of a message from
 * matching: "I will" with nothing following is a truncated sentence, not a plan.
 */
export const INTENT = new RegExp(`\\b(?:${STATED_INTENT.source})\\s*\\S`, 'i');

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
  // Every threshold is defaulted here rather than read straight off config.
  // A missing key would otherwise compare against undefined, which is always
  // false — silently disabling the rail instead of failing loudly.
  const limits = {
    maxIterations: config.maxIterations ?? 40,
    maxStrikes: config.maxStrikes ?? 3,
    doomLoopThreshold: config.doomLoopThreshold ?? 3,
    maxConsecutiveToolErrors: config.maxConsecutiveToolErrors ?? 3,
    maxEscalations: config.maxEscalations ?? 1,
    maxVerificationRetries: config.maxVerificationRetries ?? 1,
  };

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
  /** How far into each file the agent has actually read, for verification. */
  const filesRead = new Map();
  let verificationFailures = 0;
  /** Tool activity this turn, condensed into evidence for the review pass. */
  const evidenceSteps = [];
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
    if (escalations >= limits.maxEscalations) return false;

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

    if (++iterations > limits.maxIterations) {
      const note = `Stopped after ${limits.maxIterations} steps without finishing.`;
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

    // Checked against what the request actually sent, not an estimate: Ollama
    // reports it, and a measured number beats a guess for the one decision that
    // matters. Runs after the response so the summary covers this turn too.
    if (config.compaction !== false) {
      await maybeCompact({
        session, provider, config, ui, signal,
        promptTokens: response.metrics?.promptTokens,
        model: currentModel,
      });
    }

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
      if (fruitless || INTENT.test(content.slice(-300))) {
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

      // Last gate before the answer reaches the user: check its claims against
      // the files. Every other rail detects the agent breaking; this is the
      // only one that detects it being wrong.
      if (config.verifyAnswers) {
        // Checked first: a turn that left the workspace changed and broken is a
        // worse outcome than any misworded claim, and it needs no heuristics.
        const editOutcome = checkEditOutcome(evidenceSteps);
        const coverage = checkCoverage(content, { cwd: session.cwd, filesRead });
        const { failures } = verifyAnswer(content, {
          cwd: session.cwd,
          filesRead,
          toolOutputs: evidenceSteps.map((s) => s.output),
        });
        const detail = editOutcome || coverage || failures.map((f) => f.detail).join(' ');

        if (detail) {
          verificationFailures++;
          ui.onVerificationFailed?.({ detail, failures });

          if (verificationFailures <= limits.maxVerificationRetries) {
            session.addMessage({
              role: 'user',
              content: `That does not hold up. ${detail} Check again and correct your answer.`,
            });
            continue;
          }
          if (tryEscalate('the answer did not hold up against the files')) {
            verificationFailures = 0;
            continue;
          }
        }
      }

      // Claims the filesystem cannot settle — a stated root cause, a claimed
      // fix — go to a model for review. Narrow by design: this costs a call on
      // the largest model available.
      //
      // Off unless the primary model already failed this turn. Reviewing a turn
      // that is going fine is a bad trade: a false rejection costs twice, once
      // to hand the right answer back and again for the retry that escalates.
      // An explicit `true` reviews any turn passing the gates; `false` never.
      const escalated = escalations > 0;
      const reviewing = config.judgeAnswers ?? escalated;

      if (reviewing && needsJudgement(content, evidenceSteps, { escalated })) {
        const judgeModel = config.judgeModel || config.escalationModel || currentModel;
        ui.onJudging?.({ model: judgeModel });

        const verdict = await judgeAnswer({
          provider,
          model: judgeModel,
          userText,
          steps: evidenceSteps,
          answer: content,
          signal,
        });

        if (!verdict.supported) {
          verificationFailures++;
          ui.onVerificationFailed?.({ detail: verdict.reason, judged: true });

          if (verificationFailures <= limits.maxVerificationRetries) {
            session.addMessage({
              role: 'user',
              content:
                `Your answer is not supported by what you actually checked. ${verdict.reason} `
                + 'Gather that evidence, then answer again.',
            });
            continue;
          }
          if (tryEscalate('the answer was not supported by the evidence')) {
            verificationFailures = 0;
            continue;
          }
        }
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
        if (strikes >= limits.maxStrikes) {
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
      if (seen > limits.doomLoopThreshold) {
        const message =
          `You have called ${call.name} with these exact arguments ${seen} times. `
          + 'The result will not change. Try a different approach, or tell me what is blocking you.';
        ui.onToolError?.({ name: call.name, message });
        recordToolResult(session, call, message, true);
        strikes++;
        if (strikes >= limits.maxStrikes) {
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

      // File the untruncated output under a handle and tell the model its name.
      // What it was shown is a preview; the stored copy is whole, and it
      // outlives compaction because it is not part of the conversation.
      let output = result.output;
      const handle = fileResult(session, call, result);
      if (handle) output += `\n[saved as ${handle} — recall it instead of running this again]`;

      recordToolResult(session, call, output, result.isError);
      evidenceSteps.push({
        name: call.name,
        args: call.arguments,
        output: result.output,
        isError: result.isError,
      });

      // Only a genuinely unusable call counts against the strike budget; a tool
      // that ran and reported a real failure is useful information.
      toolsAttempted++;
      if (!result.isError) {
        toolsSucceeded++;
        const range = result.meta?.readRange;
        if (range) {
          const seen = filesRead.get(range.path)?.maxLine || 0;
          filesRead.set(range.path, { maxLine: Math.max(seen, range.end), total: range.total });
        }
        strikes = 0;
        consecutiveToolErrors = 0;
      } else if (++consecutiveToolErrors >= limits.maxConsecutiveToolErrors) {
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

/**
 * Tools whose output is not worth a handle.
 *
 * `recall` reads the store, so filing its output would store a copy of a copy
 * under a new name every time. `update_plan` echoes a list the session already
 * holds.
 */
const NOT_FILED = new Set(['recall', 'update_plan']);

/**
 * Save a result under a handle, if it is substantial enough to be worth one.
 *
 * A three-line directory listing does not need a name — the model can read it
 * where it stands, and a handle on every trivial result is noise in the
 * transcript and rows in the database nobody will ask for.
 *
 * @returns {string|null} The handle, or null if nothing was filed.
 */
function fileResult(session, call, result) {
  if (result.isError) return null;
  if (NOT_FILED.has(call.name)) return null;
  if (typeof session?.saveResult !== 'function') return null;

  const full = result.meta?.fullText;
  if (!full) return null;

  const worthNaming = result.meta?.truncated
    || full.length >= 400
    || full.split('\n').length >= 10;
  if (!worthNaming) return null;

  try {
    return session.saveResult({ toolName: call.name, args: call.arguments, content: full });
  } catch {
    // Storage is a convenience here; a failure must not cost the tool call.
    return null;
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

/**
 * Summarise old history when the window is nearly full.
 *
 * Deliberately silent about failure. A summariser that errors, returns nothing,
 * or finds no safe cut leaves the history exactly as it was — which is merely
 * large. Taking the turn down to avoid a large prompt would be a poor trade.
 */
async function maybeCompact({ session, provider, config, ui, signal, promptTokens, model }) {
  const window = config.contextLength;
  const reserve = config.compactionReserveTokens ?? DEFAULT_RESERVE_TOKENS;
  if (!shouldCompact(promptTokens, window, { reserveTokens: reserve })) return;

  const rows = session.rows();
  const previous = session.latestCompaction();
  // Only ever consider what the last summary did not already cover, so repeated
  // compactions do not re-summarise a summary.
  const start = previous ? rows.findIndex((r) => r.seq >= previous.through_seq) : 0;
  const pending = start >= 0 ? rows.slice(start) : rows;

  const cut = findCutPoint(pending, { keepTokens: keepRecentTokens(window) });
  if (!cut) return;

  const dropped = pending.slice(0, cut.firstKeptIndex);
  if (!dropped.length) return;

  ui.onCompacting?.({ messages: dropped.length });

  const summary = await summarise({
    provider,
    // The primary model, not the escalation model: this runs mid-turn and a
    // 30B load would stall the loop for longer than the compaction saves.
    model,
    rows: dropped,
    signal,
  });
  if (!summary) return;

  const carrySeq = cut.isSplitTurn ? pending[cut.turnStartIndex]?.seq ?? null : null;
  session.recordCompaction({
    throughSeq: pending[cut.firstKeptIndex].seq,
    carrySeq,
    summary,
  });

  ui.onCompacted?.({ messages: dropped.length, keptFrom: pending[cut.firstKeptIndex].seq });
}
