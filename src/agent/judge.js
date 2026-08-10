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

/**
 * A claim that something was diagnosed or made to work.
 *
 * Every loose word has been taken out. `because` and `due to` are ordinary
 * explanatory prose. Bare `fixes`/`fixed` is worse than loose — this project's
 * own README describes "a fixed analyze -> classify -> patch pipeline", where
 * the word is an adjective. What is left needs a subject and an outcome.
 */
const CLAIM = new RegExp(
  [
    /root cause/,
    /the cause (?:is|was)/,
    /caused by/,
    /this (?:is why|explains|fixes)/,
    /(?:i|we) fixed\b/,
    /(?:is|are|has been|have been) (?:now )?fixed\b/,
    /fixe[sd] the (?:bug|issue|error|problem|failure|test|tests)/,
    /resolved the/,
    /now pass(?:es|ing)?\b/,
    /should (?:now )?(?:work|pass)\b/,
    /the (?:bug|issue|problem|failure) (?:is|was)\b/,
    // Literals, not strings: in a string passed to RegExp, "\b" is a backspace
    // character rather than a word boundary, and every alternative using one
    // silently stopped matching.
  ].map((r) => `(?:${r.source})`).join('|'),
  'i',
);

/** Steps that could make an answer wrong in a way worth a model call. */
const ACTING = new Set(['edit_file', 'write_file', 'run_command']);
/** Steps that changed a file, as opposed to merely running something. */
const MUTATING = new Set(['edit_file', 'write_file']);

/** A turn shorter than this is not the kind of work a reviewer catches. */
const LONG_TURN = 10;

/**
 * Was this turn hard enough to be worth a second opinion?
 *
 * The review costs a call on the largest model available, so it is reserved for
 * the shape of turn that actually produces confidently-wrong answers: work
 * spanning more than one file, a long grind, or a turn the primary model
 * already failed at. A single edit followed by a passing test is both the
 * commonest turn and the easiest to get right; paying a 30B model to re-read it
 * buys almost nothing.
 */
function isDemanding(steps, { escalated = false } = {}) {
  if (escalated) return true;

  const filesChanged = new Set(
    steps.filter((s) => MUTATING.has(s.name)).map((s) => s.args?.path).filter(Boolean),
  );
  // Cross-file changes are where local models fail: a fix that is right in
  // isolation and wrong against the caller it never opened.
  if (filesChanged.size >= 2) return true;

  return steps.length >= LONG_TURN;
}

/**
 * Does this answer make a claim worth spending a model call on?
 *
 * Three gates, deliberately narrow. The review used to fire on a read-only
 * question about a README: the regex matched the noun `fixes` in "startup fails
 * early with exact fixes", and a plain summary went to a 30B judge that
 * rejected it twice and escalated - three extra model calls on an answer that
 * was right the first time.
 *
 * So a turn is reviewed only when it (1) claims a diagnosis or a fix in so many
 * words, (2) actually changed or ran something, and (3) was demanding enough
 * that being confidently wrong is a real risk. Everything else is returned as
 * the model wrote it, with Tier 1's free mechanical checks still applied.
 *
 * @param {string} answer
 * @param {Array<{name: string, args?: object}>} steps Tool activity for the turn.
 * @param {object} [opts]
 * @param {boolean} [opts.escalated] The primary model already failed this turn.
 */
export function needsJudgement(answer, steps = [], opts = {}) {
  if (!answer || !answer.trim()) return false;
  // No action means no evidence to weigh: a conversational reply, or a lookup,
  // is not a claim about work done.
  if (!steps.some((s) => ACTING.has(s.name))) return false;
  if (!isDemanding(steps, opts)) return false;
  return CLAIM.test(answer);
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
