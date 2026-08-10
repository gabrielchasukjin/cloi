/**
 * Context compaction.
 *
 * A long session eventually sends more history than the model can hold. Ollama
 * does not refuse — it silently drops the oldest tokens, which is the worst
 * possible failure: the agent forgets what it was asked while behaving as though
 * it remembers. Compaction replaces the old span with a written summary, so what
 * survives is chosen rather than whatever happened to fall inside the window.
 *
 * The hard part is *where* to cut. Cutting in the wrong place produces a message
 * list the model cannot read:
 *
 *  - A tool result with no preceding call is an orphan. Ollama accepts it and
 *    the model sees output for a request it never made.
 *  - An assistant reply with no preceding question reads as an unprompted
 *    assertion, and the model defends it rather than revisiting it.
 *
 * So a cut lands only on a turn boundary or an assistant message, and when it
 * lands mid-turn the user message that opened that turn is carried across with
 * it. The approach is taken from Prime Agent's compaction, which is careful
 * about exactly these two cases.
 *
 * Nothing is deleted. Compaction records how far the summary reaches and the
 * rest is simply not sent — the transcript on disk stays whole, so a session can
 * still be read back in full.
 */

/** Reserved for the next response, so the trigger fires before the window is full. */
export const DEFAULT_RESERVE_TOKENS = 2048;
/** Share of the window kept as verbatim recent history. */
const KEEP_RECENT_SHARE = 0.35;
/** Characters per token. Deliberately low, so the estimate over-counts. */
const CHARS_PER_TOKEN = 3.6;

/**
 * Rough token cost of a stored message row.
 *
 * Over-counting is the safe direction: it compacts slightly early rather than
 * one turn too late, and one turn too late is an overflow.
 */
export function estimateTokens(row) {
  let chars = (row.content || '').length;
  if (row.tool_calls) chars += row.tool_calls.length;
  // Role, separators and the tool name all cost tokens the content does not.
  return Math.ceil(chars / CHARS_PER_TOKEN) + 8;
}

/**
 * @param {number} contextTokens Tokens the last request actually sent.
 * @param {number} contextWindow Configured window.
 * @param {object} [opts]
 * @param {number} [opts.reserveTokens]
 */
export function shouldCompact(contextTokens, contextWindow, { reserveTokens = DEFAULT_RESERVE_TOKENS } = {}) {
  if (!contextWindow || contextWindow <= 0) return false;
  if (!contextTokens || contextTokens <= 0) return false;
  return contextTokens > contextWindow - reserveTokens;
}

/** How much recent history to keep verbatim, given a window. */
export function keepRecentTokens(contextWindow) {
  return Math.max(512, Math.floor(contextWindow * KEEP_RECENT_SHARE));
}

/**
 * A row the history may be cut at.
 *
 * Never a tool result: it belongs to the assistant message that requested it,
 * and separating the two is what produces an orphan. Cutting *at* an assistant
 * message is fine — its tool results follow it and are kept with it.
 */
export function isCutPoint(row) {
  return row.role === 'user' || row.role === 'assistant';
}

/** The user message that opened the turn containing `index`, or -1. */
export function findTurnStart(rows, index) {
  for (let i = index; i >= 0; i--) {
    if (rows[i].role === 'user') return i;
  }
  return -1;
}

/**
 * Choose where to cut.
 *
 * Walks backwards from the newest row accumulating estimated tokens, and stops
 * at the first valid cut point past the budget.
 *
 * @param {Array<object>} rows Stored message rows, oldest first.
 * @param {object} opts
 * @param {number} opts.keepTokens Recent history to preserve verbatim.
 * @returns {{firstKeptIndex: number, turnStartIndex: number, isSplitTurn: boolean}|null}
 *   null when there is nothing worth compacting.
 */
export function findCutPoint(rows, { keepTokens }) {
  if (!rows.length) return null;

  let accumulated = 0;
  let cutIndex = -1;

  for (let i = rows.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(rows[i]);
    if (accumulated >= keepTokens && isCutPoint(rows[i])) {
      cutIndex = i;
      break;
    }
  }

  // Everything fits, or the whole history is one unbroken turn. Either way
  // there is no safe cut, and a summary of nothing is worse than none.
  if (cutIndex <= 0) return null;

  const isTurnStart = rows[cutIndex].role === 'user';
  const turnStartIndex = isTurnStart ? -1 : findTurnStart(rows, cutIndex);

  // The carried question is kept verbatim, so it is not reclaimed. When it is
  // the *only* thing before the cut, compaction would spend a model call to
  // summarise a span it then keeps in full.
  let reclaimed = 0;
  for (let i = 0; i < cutIndex; i++) {
    if (i !== turnStartIndex) reclaimed++;
  }
  if (reclaimed === 0) return null;

  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isTurnStart && turnStartIndex !== -1,
  };
}

/**
 * Prompt asking for a checkpoint another model instance can work from.
 *
 * Fixed headings, because a summary that varies in shape has to be re-read to
 * be used. Exact paths and error text are called out: those are the details a
 * paraphrase loses first, and the ones the next turn needs most.
 */
export function buildSummaryPrompt(transcript) {
  return [
    'Summarise the conversation below into a checkpoint that lets you continue the work',
    'after the original messages are gone. Use exactly these headings:',
    '',
    '## Goal',
    "What the user asked for, in their terms.",
    '',
    '## Done',
    'Changes actually made, each with the file path.',
    '',
    '## Current state',
    'What is working, what is failing, and the exact error text if any.',
    '',
    '## Next',
    'The immediate next step.',
    '',
    'Preserve exact file paths, function names, and error messages verbatim.',
    'Do not speculate about work that was not done. Be brief.',
    '',
    '--- conversation ---',
    transcript,
  ].join('\n');
}

/** Render rows as plain text for the summariser. */
export function renderTranscript(rows) {
  return rows
    .map((row) => {
      if (row.role === 'tool') {
        return `[tool ${row.tool_name || '?'}${row.is_error ? ' FAILED' : ''}] ${clip(row.content)}`;
      }
      const calls = row.tool_calls ? ` (called: ${toolNames(row.tool_calls)})` : '';
      return `[${row.role}]${calls} ${clip(row.content)}`;
    })
    .join('\n');
}

function toolNames(json) {
  try {
    return JSON.parse(json).map((c) => c.name).join(', ');
  } catch {
    return '?';
  }
}

function clip(text, max = 600) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Summarise a span of history.
 *
 * Fails soft: a summariser that errors must not take the turn down with it. The
 * caller keeps the uncompacted history, which is merely large — losing the turn
 * would be worse.
 *
 * @returns {Promise<string|null>}
 */
export async function summarise({ provider, model, rows, signal }) {
  if (!rows.length) return null;
  try {
    const response = await provider.chat({
      model,
      messages: [{ role: 'user', content: buildSummaryPrompt(renderTranscript(rows)) }],
      signal,
      think: false,
    });
    const text = (response?.content || '').trim();
    return text || null;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  }
}
