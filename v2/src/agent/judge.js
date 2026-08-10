/**
 * Evidence review for claims the filesystem cannot settle.
 *
 * Tier 1 verification checks facts: does the file exist, is the symbol really
 * absent, does the quoted line appear. Some claims are not facts about files —
 * "the root cause is the shared mutable array", "this fixes the failure" — and
 * those need judgement rather than a grep.
 *
 * Three constraints shape this module, because unlike Tier 1 it costs a model
 * call on hardware where a call takes seconds:
 *
 *  1. **It fires narrowly.** Only answers that claim a cause or a completion
 *     are reviewed. Most turns never trigger it.
 *  2. **It fails open.** A judge that returns something unparseable is treated
 *     as approval. A verifier that blocks answers when it is confused is worse
 *     than no verifier.
 *  3. **It prefers a stronger judge.** Asking the model that just produced a
 *     wrong answer to grade that answer mostly reproduces the error, so the
 *     escalation model is used when one is configured.
 */

/** Claims that assert a cause, a fix, or an outcome — not a lookup. */
const JUDGEABLE =
  /\b(?:root cause|the cause|caused by|because|this (?:is why|explains)|fixe[sd]|resolved|corrected|repaired|now pass(?:es|ing)?|should (?:now )?(?:work|pass)|the (?:bug|issue|problem|failure) (?:is|was)|due to)\b/i;

/**
 * Does this answer make a claim worth spending a model call on?
 *
 * @param {string} answer
 * @param {number} toolCallCount Evidence available to judge against.
 */
export function needsJudgement(answer, toolCallCount = 0) {
  if (!answer || !answer.trim()) return false;
  // With no tool calls there is no evidence to weigh, so there is nothing to
  // review — a conversational reply is not a claim about the workspace.
  if (toolCallCount === 0) return false;
  return JUDGEABLE.test(answer);
}

/**
 * Condense the turn's tool activity into evidence the judge can read.
 *
 * Results are clipped hard: the judge needs to know what was looked at and what
 * came back, not the full contents of every file.
 */
export function buildEvidence(steps, { maxSteps = 12, maxChars = 400 } = {}) {
  const recent = steps.slice(-maxSteps);
  if (!recent.length) return '(no tools were used)';
  return recent
    .map((s, i) => {
      const args = JSON.stringify(s.args ?? {});
      const outcome = s.isError ? 'FAILED' : 'ok';
      const body = clip(String(s.output ?? '').replace(/\s+/g, ' ').trim(), maxChars);
      return `${i + 1}. ${s.name}(${args.slice(0, 200)}) -> ${outcome}: ${body}`;
    })
    .join('\n');
}

/**
 * Keep both ends of a long result.
 *
 * Clipping from the front alone loses exactly what matters for a command:
 * a test run puts the assertion values at the end, and the judge then rejected
 * an answer for citing figures the evidence "did not show" — because the clip
 * had removed them. Observed live.
 */
function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.4);
  const tail = Math.floor(maxChars * 0.6);
  return `${text.slice(0, head)} … ${text.slice(-tail)}`;
}

/**
 * Prompt asking whether the evidence supports the answer.
 *
 * Phrased to make UNSUPPORTED the considered response rather than the default:
 * a judge told to be skeptical rejects almost everything, which is the same
 * failure as approving everything.
 */
export function buildJudgePrompt({ userText, evidence, answer }) {
  return [
    'You are checking whether an answer is supported by the evidence that was gathered.',
    '',
    'The user asked:',
    userText,
    '',
    'Tools that were run, and what they returned:',
    evidence,
    '',
    'The proposed answer:',
    answer,
    '',
    'Decide whether the evidence above actually supports the answer.',
    'It is fine for an answer to be brief or to omit detail. Reject it only if it',
    'asserts something the evidence does not show — a cause that was never',
    'checked, a fix that was never applied, or a test result that was never run.',
    '',
    'Reply with exactly one line, in one of these two forms:',
    'SUPPORTED',
    'UNSUPPORTED: <one sentence naming what is missing>',
  ].join('\n');
}

/**
 * Read a verdict out of the judge's reply.
 *
 * Unparseable replies count as approval. The judge is an advisory second
 * opinion; when it is incoherent the answer should still reach the user.
 *
 * @returns {{supported: boolean, reason: string|null}}
 */
export function parseVerdict(text) {
  if (!text || !text.trim()) return { supported: true, reason: null };
  const flat = text.replace(/\s+/g, ' ').trim();

  const negative = flat.match(/\bUNSUPPORTED\b\s*[:.\-—]?\s*(.*)/i);
  if (negative) {
    const reason = negative[1].trim().replace(/^["'`]|["'`]$/g, '');
    return { supported: false, reason: reason || 'The evidence does not support the answer.' };
  }
  if (/\bSUPPORTED\b/i.test(flat)) return { supported: true, reason: null };

  // No verdict token at all: fail open.
  return { supported: true, reason: null };
}

/**
 * Run the review.
 *
 * @param {object} opts
 * @param {{chat: Function}} opts.provider
 * @param {string} opts.model Model to judge with.
 * @param {string} opts.userText
 * @param {Array} opts.steps Tool activity for the turn.
 * @param {string} opts.answer
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{supported: boolean, reason: string|null, skipped?: boolean}>}
 */
export async function judgeAnswer({ provider, model, userText, steps, answer, signal }) {
  const prompt = buildJudgePrompt({
    userText,
    evidence: buildEvidence(steps),
    answer,
  });

  try {
    const response = await provider.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      // No tools: this is a single judgement, not another agent loop.
      signal,
      think: false,
    });
    return parseVerdict(response?.content ?? '');
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // A judge that cannot run must not block the answer.
    return { supported: true, reason: null, skipped: true };
  }
}
