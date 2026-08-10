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

/** Steps that could make an answer wrong in a way worth a model call. */
const ACTING = new Set(['edit_file', 'write_file', 'run_command']);

/**
 * Does this answer make a claim worth spending a model call on?
 *
 * Two gates, and the second matters more than the first.
 *
 * The regex alone is far too eager: "startup fails early with exact fixes"
 * matched `fixes` and sent a plain description of a README to a 30B judge,
 * which rejected it twice and escalated — three model calls and a minute of
 * latency spent on a question that was answered correctly the first time.
 *
 * So the turn must also have *acted*. A claim that something is fixed is only
 * checkable when something was changed or run; a turn that only read files has
 * nothing to be caught out about beyond what Tier 1 already verifies for free.
 *
 * @param {string} answer
 * @param {Array<{name: string}>} steps Tool activity for the turn.
 */
export function needsJudgement(answer, steps = []) {
  if (!answer || !answer.trim()) return false;
  // No tools means no evidence to weigh: a conversational reply is not a claim
  // about the workspace.
  if (!steps.some((s) => ACTING.has(s.name))) return false;
  return JUDGEABLE.test(answer);
}

/**
 * Condense the turn's tool activity into evidence the judge can read.
 *
 * Results are clipped hard: the judge needs to know what was looked at and what
 * came back, not the full contents of every file.
 */
export function buildEvidence(steps, { maxSteps = 12, maxChars = 400, budget = 9000 } = {}) {
  const recent = steps.slice(-maxSteps);
  if (!recent.length) return '(no tools were used)';

  // The allowance is shared, not per-step. A flat 400 characters meant a turn
  // that read fifty lines of a README handed the judge a tenth of them, and the
  // judge then rejected a correct answer with "the evidence does not mention"
  // — which was true of the evidence, and false of the file. Two steps now get
  // the room that twelve steps have to divide.
  const perStep = Math.max(maxChars, Math.floor(budget / recent.length));

  return recent
    .map((s, i) => {
      const args = JSON.stringify(s.args ?? {});
      const outcome = s.isError ? 'FAILED' : 'ok';
      const body = clip(String(s.output ?? '').replace(/\s+/g, ' ').trim(), perStep);
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
  const flat = stripReasoning(text).replace(/\s+/g, ' ').trim();
  if (!flat) return { supported: true, reason: null };

  // The LAST verdict, not the first. A reasoning model rehearses the word
  // "UNSUPPORTED" while deliberating, so the first occurrence is usually mid
  // thought and `(.*)` after it swallows the rest of the transcript — which is
  // how a one-sentence reason once printed as a page of the judge's monologue.
  const negatives = [...flat.matchAll(/\bUNSUPPORTED\b\s*[:.\-—]?\s*/gi)];
  if (negatives.length) {
    const last = negatives[negatives.length - 1];
    const reason = firstSentence(flat.slice(last.index + last[0].length));
    return { supported: false, reason: reason || 'The evidence does not support the answer.' };
  }
  if (/\bSUPPORTED\b/i.test(flat)) return { supported: true, reason: null };

  // No verdict token at all: fail open.
  return { supported: true, reason: null };
}

/**
 * Drop a reasoning model's scratchpad.
 *
 * Some models emit `<think>…</think>` inline in the content rather than in a
 * separate field, and some emit only the closing tag when the opening one was
 * consumed upstream — so a dangling `</think>` means everything before it was
 * thinking.
 */
function stripReasoning(text) {
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  const dangling = withoutBlocks.lastIndexOf('</think>');
  return (dangling === -1 ? withoutBlocks : withoutBlocks.slice(dangling + 8)).trim();
}

/** One sentence, capped — the prompt asks for one, but nothing enforces it. */
function firstSentence(text, max = 200) {
  const trimmed = text.trim().replace(/^["'`]+/, '');
  const end = trimmed.search(/[.!?](?:\s|$)/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end + 1);
  const clean = sentence.replace(/["'`]+$/, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
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
