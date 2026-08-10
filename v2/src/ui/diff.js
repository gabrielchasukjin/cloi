/**
 * Diff rendering.
 *
 * An edit used to report "1 change", which tells you that something happened
 * but not what. The change itself is the one piece of output worth spending
 * vertical space on: it is the only thing in a turn that is irreversible.
 *
 * Rendered as a unified diff with line numbers, tinted rather than boxed —
 * sharp gutters, no borders. Long edits are clipped, because a diff you have to
 * scroll past is no better than a summary.
 */

import chalk from 'chalk';
import { stdout } from 'node:process';

/** Panel width, clamped so a maximised terminal does not tint half a monitor. */
const columns = () => Math.min(stdout.columns || 80, 100);

/** Unchanged lines kept either side of a change. */
const CONTEXT = 3;
/** Beyond this the diff is a wall, and a wall is skipped rather than read. */
const MAX_LINES = 40;

/** Tinted backgrounds need 256 colours; below that, foreground alone carries it. */
const tinted = () => chalk.level >= 2;

const paint = {
  add: (s) => (tinted() ? chalk.bgHex('#12291c').hex('#7ee787')(s) : chalk.green(s)),
  del: (s) => (tinted() ? chalk.bgHex('#2b1416').hex('#ff9492')(s) : chalk.red(s)),
  ctx: (s) => chalk.gray(s),
  gutter: chalk.dim.gray,
};

/**
 * Line-level diff.
 *
 * Longest common subsequence: O(n·m), which is fine for the file sizes a single
 * edit touches and avoids a dependency for something this small.
 *
 * @returns {Array<{type: 'ctx'|'add'|'del', text: string, oldNo: number|null, newNo: number|null}>}
 */
export function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');

  // Shared head and tail are stripped first: an edit changes a few lines in the
  // middle of a file, so this leaves the LCS table small enough to be cheap.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const table = lcs(midA, midB);

  const out = [];
  for (let i = 0; i < head; i++) out.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: i + 1 });

  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      out.push({ type: 'ctx', text: midA[i], oldNo: head + i + 1, newNo: head + j + 1 });
      i++; j++;
    } else if (i < midA.length && (j === midB.length || table[i + 1][j] >= table[i][j + 1])) {
      // Deletions win ties so a replacement reads "- old" then "+ new", which
      // is the order every other diff tool prints and the order it is read in.
      out.push({ type: 'del', text: midA[i], oldNo: head + i + 1, newNo: null });
      i++;
    } else {
      out.push({ type: 'add', text: midB[j], oldNo: null, newNo: head + j + 1 });
      j++;
    }
  }

  for (let k = 0; k < tail; k++) {
    const oldNo = a.length - tail + k + 1;
    out.push({ type: 'ctx', text: a[oldNo - 1], oldNo, newNo: b.length - tail + k + 1 });
  }
  return out;
}

function lcs(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Drop runs of context longer than CONTEXT on either side of a change. */
export function trimContext(lines, context = CONTEXT) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.type === 'ctx') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  return lines.filter((_, i) => keep[i]);
}

/**
 * Render a diff, or null when there is nothing to show.
 *
 * @param {string} before
 * @param {string} after
 * @param {object} [opts]
 * @param {number} [opts.maxLines]
 * @returns {string|null}
 */
export function renderDiff(before, after, { maxLines = MAX_LINES } = {}) {
  const all = diffLines(before, after);
  if (!all.some((l) => l.type !== 'ctx')) return null;

  // A file's trailing newline splits into a final empty line, which renders as
  // a blank context row that looks like part of the change.
  while (all.length && all.at(-1).type === 'ctx' && all.at(-1).text === '') all.pop();

  const shown = trimContext(all);
  const clipped = shown.length > maxLines ? shown.slice(0, maxLines) : shown;
  const width = String(Math.max(...all.map((l) => l.newNo || l.oldNo || 0))).length;

  // Every row is padded to the same width so the tint forms a solid block with
  // a straight right edge. Ragged highlights read as damage, not as structure.
  const body = Math.max(20, columns() - width - 4);

  const rows = clipped.map((line) => {
    const no = String(line.newNo ?? line.oldNo ?? '').padStart(width);
    const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    const text = `${sign} ${line.text.replace(/\t/g, '  ')}`;
    const cell = text.length > body ? `${text.slice(0, body - 1)}…` : text.padEnd(body);
    // The gutter stays outside the tint so the numbers read as a fixed rule
    // down the left edge rather than as part of the change.
    return `  ${paint.gutter(no)} ${paint[line.type](cell)}`;
  });

  if (shown.length > clipped.length) {
    rows.push(`  ${' '.repeat(width)} ${chalk.dim(`… ${shown.length - clipped.length} more lines`)}`);
  }
  return rows.join('\n');
}

/** Counts for a one-line summary when the diff itself is not shown. */
export function diffStat(before, after) {
  const lines = diffLines(before, after);
  return {
    added: lines.filter((l) => l.type === 'add').length,
    removed: lines.filter((l) => l.type === 'del').length,
  };
}
