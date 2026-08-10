/**
 * Answer verification.
 *
 * The loop accepts a reply the moment the model stops calling tools, which
 * means a confidently wrong answer is indistinguishable from a correct one.
 * Every other rail detects the agent *malfunctioning*; nothing detects it being
 * *wrong*. In live testing that was the dominant failure: a model read one line
 * of a twenty-line file and declared the function absent, with both tool calls
 * succeeding and nothing repeating.
 *
 * This checks the answer's factual claims against the files themselves. No
 * model call is involved — claims about a filesystem are settled by the
 * filesystem.
 *
 * Bias throughout is toward silence: a false accusation costs a wasted round
 * trip and teaches the user to ignore the check, so a claim is only reported
 * when it can be positively disproved.
 */

import fs from 'node:fs';
import { resolvePath, displayPath, isProbablyBinary, looksBinary, walkFiles } from '../tools/workspace.js';

/** Extensions worth treating as a file reference in prose. */
// Data and document files count too. Without them a claim to have written
// "endpoint_list.txt" was never checked at all, and the agent asserted three
// times that it had created a file it never created.
//
// `log` and `env` are deliberately absent: `console.log` and `process.env`
// parse as filenames and appear constantly in ordinary prose about code.
const CODE_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|json|ya?ml|toml|md|sql|txt|csv|tsv|html?|xml)$/i;

/**
 * Names that end in a source extension but are technologies, not files.
 *
 * Only applied to bare names: `src/next.js` is a file, `Next.js` in prose is
 * not. The list is short and specific by design — a loose rule here would
 * silently stop checking real filenames, which is the failure that matters.
 */
const TECH_NAME = /^(?:node|next|nuxt|vue|react|angular|ember|backbone|express|nest|remix|astro|svelte|solid|preact|alpine|three|d3|chart|moment|lodash|jquery|socket|passport|discord|p5|deno|bun)\.js$/i;

/**
 * Something the answer asserts that the workspace can settle.
 * @typedef {{kind: string, text: string, path?: string, symbol?: string, line?: number}} Claim
 */

/**
 * Paths the answer refers to, optionally with a line number.
 *
 * Bare filenames are included, but a name with no directory and no extension is
 * not — prose is full of words that would otherwise look like paths.
 */
export function extractFileRefs(text) {
  const refs = new Map();
  // Optional backtick/quote wrapper, then a path with an extension.
  const pattern = /[`'"(\s]((?:\.{0,2}\/)?(?:[\w.-]+[\/\\])*[\w.-]+\.[a-z]{1,5})(?::(\d+))?/gi;
  for (const m of `${text} `.matchAll(pattern)) {
    const raw = m[1];
    if (!CODE_EXT.test(raw)) continue;
    // Skip URLs and package specifiers.
    if (/^https?:/i.test(raw) || raw.startsWith('@')) continue;
    // Skip technologies whose names end in a source extension. "Requires
    // Node.js 22.5+" is prose about a runtime, but it parses as a bare
    // filename, and the answer was rejected for citing a file nobody claimed
    // existed.
    if (!raw.includes('/') && !raw.includes('\\') && TECH_NAME.test(raw)) continue;
    const key = raw.replace(/\\/g, '/');
    const line = m[2] ? Number(m[2]) : undefined;
    if (!refs.has(key) || (line && !refs.get(key).line)) {
      refs.set(key, { kind: 'file', text: raw, path: key, line });
    }
  }
  return [...refs.values()];
}

/**
 * Assertions that something is absent.
 *
 * This is the shape that produced the failure this module exists for, and it is
 * the most checkable: a claim of absence is disproved by a single match.
 */
export function extractNegativeAssertions(text) {
  const claims = [];

  // Filler between the verb and the identifier is consumed by the pattern
  // rather than captured and filtered afterwards: a lazy quantifier would
  // match "the" in "does not contain the definition of completionRate" and the
  // claim would be discarded instead of checked.
  const FILLER = String.raw`(?:(?:the|a|an|any|its|this|that|such)\s+)*(?:(?:definition|declaration|implementation|function|method|variable|constant|class|property|field)s?\s+(?:of\s+|for\s+|named\s+|called\s+)?)*`;

  const patterns = [
    // "does not contain the definition of completionRate"
    new RegExp(
      String.raw`\b(?:does\s+not|doesn'?t|do\s+not|don'?t|is\s+not|isn'?t|are\s+not)\s+(?:seem\s+to\s+)?(?:contain|define|include|have|declare|export)[sd]?\s+${FILLER}[\`'"]?([A-Za-z_$][\w$]{2,})[\`'"]?`,
      'gi',
    ),
    // "there is no completionRate function" / "no completionRate defined"
    new RegExp(
      String.raw`\b(?:there\s+(?:is|are)\s+no|no)\s+[\`'"]?([A-Za-z_$][\w$]{2,})[\`'"]?\s+(?:function|variable|method|class|definition|declaration|export)\b`,
      'gi',
    ),
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const symbol = m[1];
      if (RESERVED.test(symbol) || seen.has(symbol)) continue;
      seen.add(symbol);
      claims.push({ kind: 'absent', text: m[0].trim(), symbol });
    }
  }
  return claims;
}

/** Words that survive the pattern but name nothing checkable. */
const RESERVED = /^(?:the|a|an|any|it|its|this|that|there|and|but|not|file|files|code|line|lines|test|tests|error|errors|issue|problem|task|tasks|list|value|values)$/i;

/** Backtick-quoted fragments that look like source rather than prose. */
export function extractCodeQuotes(text) {
  const quotes = [];

  // Split on backticks and take the odd segments. A regex pairing backticks
  // gets this wrong when their number is odd: it captured the prose *between*
  // two inline-code spans — " function is incorrect. You should review the " —
  // and then reported that the file did not contain it. Observed live.
  const segments = text.split('`');
  for (let i = 1; i < segments.length; i += 2) {
    const q = segments[i].trim();
    if (q.length < 8 || q.length > 200 || q.includes('\n')) continue;
    if (CODE_EXT.test(q)) continue;
    // Structural punctuation, not a keyword: prose says "the function is
    // incorrect" and would otherwise pass a keyword test.
    if (!/[=(){};[\]]|=>/.test(q)) continue;
    quotes.push({ kind: 'quote', text: q });
  }
  return quotes;
}

/**
 * Check an answer's claims against the workspace.
 *
 * @param {string} answer The model's final reply.
 * @param {object} opts
 * @param {string} opts.cwd Workspace root.
 * @param {Map<string, {maxLine: number}>} [opts.filesRead] Files the agent read
 *   this turn, and how far into each, keyed by workspace-relative path.
 * @param {string[]} [opts.toolOutputs] Everything the tools returned this turn.
 *   A quote is legitimate if it came from command output rather than a file —
 *   citing an assertion from a test run is normal, not fabrication.
 * @returns {{ok: boolean, failures: Array<{claim: Claim, detail: string}>, checked: number}}
 */
export function verifyAnswer(answer, { cwd, filesRead = new Map(), toolOutputs = [] } = {}) {
  const failures = [];
  let checked = 0;

  if (!answer || !answer.trim()) return { ok: true, failures, checked };

  const fileRefs = extractFileRefs(answer);
  const resolved = new Map();

  for (const ref of fileRefs) {
    const abs = safeResolve(cwd, ref.path);
    if (!abs) continue;
    checked++;
    if (!fs.existsSync(abs)) {
      // Referring to a file by bare name, or by a path relative to somewhere
      // other than the workspace root, is normal phrasing rather than a wrong
      // answer. Only a basename that exists nowhere in the tree is a real miss.
      if (!basenameExistsSomewhere(cwd, ref.path, filesRead)) {
        failures.push({
          claim: ref,
          detail: `You referred to "${ref.path}", which does not exist in the workspace.`,
        });
      }
      continue;
    }
    if (fs.statSync(abs).isDirectory()) continue;
    const content = readText(abs);
    if (content === null) continue;
    resolved.set(ref.path, { abs, content, lines: content.split('\n') });

    if (ref.line) {
      checked++;
      const lines = content.split('\n');
      if (ref.line > lines.length) {
        failures.push({
          claim: ref,
          detail: `You cited ${ref.path}:${ref.line}, but that file has only ${lines.length} lines.`,
        });
      }
    }
  }

  // A claim of absence is disproved by one match in a file the answer names.
  // With no named file, every file the agent read is fair game — it cannot
  // assert absence about material it never looked at.
  const searchSet = resolved.size
    ? [...resolved.entries()].map(([path, r]) => ({ path, content: r.content }))
    : readFilesFromLog(cwd, filesRead);

  for (const claim of extractNegativeAssertions(answer)) {
    if (!searchSet.length) continue;
    checked++;
    const hit = searchSet.find(({ content }) => symbolPresent(content, claim.symbol));
    if (hit) {
      const lineNo = lineOf(hit.content, claim.symbol);
      failures.push({
        claim,
        detail:
          `You claimed "${claim.text}", but ${claim.symbol} appears in ${hit.path}`
          + `${lineNo ? ` at line ${lineNo}` : ''}. Read the whole file before concluding something is absent.`,
      });
    }
  }

  // Quoted text must exist somewhere the agent actually looked — which
  // includes what commands printed, not only file contents. Quoting an
  // assertion out of a failing test run is normal and was being reported as
  // fabrication.
  const quoteCorpus = [
    ...(resolved.size ? [...resolved.values()].map((r) => r.content) : readFilesFromLog(cwd, filesRead).map((f) => f.content)),
    ...toolOutputs.filter((o) => typeof o === 'string' && o),
  ];
  if (quoteCorpus.length) {
    for (const quote of extractCodeQuotes(answer)) {
      checked++;
      const normalized = normalize(quote.text);
      const found = quoteCorpus.some((content) => normalize(content).includes(normalized));
      if (!found) {
        failures.push({
          claim: quote,
          detail: `You quoted \`${truncate(quote.text, 80)}\`, which does not appear in the files you read.`,
        });
      }
    }
  }

  return { ok: failures.length === 0, failures, checked };
}

/**
 * Did the agent read enough of a file to justify talking about it?
 *
 * Separate from the claim checks because it is about evidence rather than
 * truth: asserting anything about a file after reading a twentieth of it is
 * unsound even when the conclusion happens to be right.
 *
 * @returns {string|null} A complaint, or null if coverage is adequate.
 */
export function checkCoverage(answer, { cwd, filesRead = new Map(), minFraction = 0.5 } = {}) {
  const negatives = extractNegativeAssertions(answer);
  if (!negatives.length) return null;

  for (const [path, info] of filesRead) {
    const abs = safeResolve(cwd, path);
    if (!abs || !fs.existsSync(abs)) continue;
    const content = readText(abs);
    if (content === null) continue;
    const total = content.split('\n').length;
    const seen = info.maxLine || 0;
    if (total > 4 && seen / total < minFraction) {
      return `You concluded something is missing after reading only ${seen} of ${total} lines of ${path}. Read the rest before deciding.`;
    }
  }
  return null;
}

/** Tools that change the workspace. */
const MUTATING = new Set(['edit_file', 'write_file']);

/**
 * Did the turn leave the workspace changed and still broken?
 *
 * The strongest available signal that a turn failed, and the only one here that
 * needs no pattern matching and no model call — it is pure ordering over the
 * tool log. It catches the case that matters most to a user: code was modified,
 * it did not work, and nothing said so.
 *
 * Deliberately narrow in two ways, because the obvious version is noisy:
 *
 *  - "Still failing" requires the command to have run *after* the edit.
 *  - "Unverified" requires a command to have already failed *before* the edit,
 *    so that a turn which was simply asked to change a file — with no test in
 *    play — is never scolded for not running one.
 *
 * @param {Array<{name: string, args: object, output: string, isError: boolean}>} steps
 * @returns {string|null} A complaint, or null if the turn is in good shape.
 */
export function checkEditOutcome(steps = []) {
  let lastEdit = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (MUTATING.has(steps[i].name) && !steps[i].isError) {
      lastEdit = i;
      break;
    }
  }
  if (lastEdit === -1) return null; // nothing was changed

  const edited = steps[lastEdit].args?.path || 'a file';
  const after = steps.slice(lastEdit + 1).filter((s) => s.name === 'run_command');

  if (after.length) {
    const last = after[after.length - 1];
    if (last.isError) {
      const cmd = last.args?.command || 'the command';
      return `You changed ${edited}, but \`${cmd}\` still fails afterwards. `
        + 'The change did not fix the problem — either find the real cause, or undo your edit and say so.';
    }
    return null; // changed and verified: the good path
  }

  // Nothing was re-run. Only a problem if something was already failing.
  const failedBefore = steps.slice(0, lastEdit).some((s) => s.name === 'run_command' && s.isError);
  if (failedBefore) {
    return `You changed ${edited} to fix a failing command but never re-ran it. `
      + 'Run it again before claiming the problem is solved.';
  }
  return null;
}

/* ─────────────────────────── helpers ─────────────────────────── */

function safeResolve(cwd, p) {
  try {
    return resolvePath(cwd, p);
  } catch {
    return null;
  }
}

function readText(abs) {
  try {
    if (isProbablyBinary(abs)) return null;
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function readFilesFromLog(cwd, filesRead) {
  const out = [];
  for (const path of filesRead.keys()) {
    const abs = safeResolve(cwd, path);
    if (!abs || !fs.existsSync(abs)) continue;
    const content = readText(abs);
    if (content !== null) out.push({ path, content });
  }
  return out;
}

/** Word-boundary match, so `rate` does not satisfy a claim about `completionRate`. */
function symbolPresent(content, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(content);
}

function lineOf(content, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`);
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}

/** Compare ignoring whitespace: models reformat quotes constantly. */
function normalize(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Does a file of this basename exist anywhere under the workspace?
 *
 * Consulting only the files already read was not enough: a model that has read
 * nothing still refers to files by name, and reporting `stats.test.js` as
 * nonexistent when `test/stats.test.js` is right there is precisely the false
 * accusation this module is supposed to avoid. Observed live, twice in one turn.
 */
function basenameExistsSomewhere(cwd, refPath, filesRead) {
  const base = refPath.split('/').pop();

  for (const known of filesRead.keys()) {
    if (known.split('/').pop() === base) return true;
  }

  const names = workspaceBasenames(cwd);
  return names.has(base.toLowerCase());
}

/** Basenames present in the workspace, walked once per process and cached. */
let basenameCache = null;
function workspaceBasenames(cwd) {
  if (basenameCache && basenameCache.cwd === cwd) return basenameCache.names;
  const names = new Set();
  try {
    for (const file of walkFiles(cwd, { maxFiles: 20000 })) {
      names.add(file.split(/[\\/]/).pop().toLowerCase());
    }
  } catch {
    // An unreadable tree means we cannot disprove the claim, so stay silent.
  }
  basenameCache = { cwd, names };
  return names;
}

/** Exposed so a test can force a rescan after changing the tree. */
export function resetWorkspaceCache() {
  basenameCache = null;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export { displayPath };
