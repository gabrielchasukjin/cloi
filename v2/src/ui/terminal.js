/**
 * Terminal rendering and input.
 *
 * Two rules hold the design together:
 *
 *  1. **A box means something exceptional.** Boxes draw the eye, so spending
 *     them on routine output spends the signal. Only a prompt that blocks on
 *     the user gets one. Corners are square; rounded ones read as decoration.
 *  2. **One line per event.** A tool call produces one line, not a header and
 *     an indented result. Ten calls should be ten scannable lines, not twenty
 *     that have to be read.
 *
 * No alternate screen buffer and no full-screen redraw: output stays in the
 * scrollback where it can be searched, and the session reads as a transcript.
 */

import readline from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import chalk from 'chalk';
import boxen from 'boxen';
import { displayMarker } from '../tools/todo.js';

export const theme = {
  brand: chalk.hex('#7aa2f7').bold,
  dim: chalk.gray,
  tool: chalk.cyan,
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  accent: chalk.magenta,
  /** A step below dim: present, but never competing for attention. */
  faint: chalk.hex('#565f89'),
};

/** Square corners. Rounded borders read as decoration rather than structure. */
export const BOX = {
  padding: { top: 0, bottom: 0, left: 1, right: 1 },
  borderStyle: 'single',
  borderColor: 'gray',
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Column where every tool result lines up. */
const RESULT_COLUMN = 46;

let rl = null;

export function getReadline() {
  if (!rl) rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  return rl;
}

export function closeReadline() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/** Home-relative where possible: you already know where you are. */
export function shortPath(p) {
  const home = os.homedir();
  const rel = path.relative(home, p);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel.split(path.sep).join('/')}`;
  return p.split(path.sep).join('/');
}

/** Usable width, clamped so a maximised terminal does not draw a rule to the horizon. */
export function width() {
  return Math.min(stdout.columns || 80, 100);
}

/**
 * Opening block.
 *
 * A wordmark and a short field list, no prose. Half-blocks keep every edge
 * square, and the fields sit beside the mark rather than under it so the whole
 * thing costs three lines. Nothing here is repeated on the rule below it.
 */

/** Half-block wordmark. Two rows, square everywhere. */
const WORDMARK = ['█▀▀ █   █▀█ █', '█▄▄ █▄▄ █▄█ █'];
/** Wide enough for the longest label plus a gap. "fallback" is exactly 8. */
const LABEL_WIDTH = 10;

export function banner({ model, escalationModel, cwd, contextLength, firstRun = false }) {
  // Labels rather than sentences: a field reads as instrumentation, and the
  // eye can skip it once it is familiar. Prose has to be read every time.
  const fields = [
    escalationModel ? ['fallback', escalationModel] : null,
    contextLength ? ['context', `${Math.round(contextLength / 1024)}k`] : null,
    ['root', shortPath(cwd)],
  ].filter(Boolean);

  // The active model is not here: the rule above the prompt carries it, and it
  // is redrawn every turn, so it stays true when /model switches mid-session.
  stdout.write('\n');
  WORDMARK.forEach((row, i) => {
    const field = fields[i];
    const suffix = field ? `   ${theme.faint(field[0].padEnd(LABEL_WIDTH))}${theme.dim(field[1])}` : '';
    stdout.write(`  ${theme.brand(row)}${suffix}\n`);
  });
  for (const [key, value] of fields.slice(WORDMARK.length)) {
    stdout.write(`  ${' '.repeat(WORDMARK[0].length)}   ${theme.faint(key.padEnd(LABEL_WIDTH))}${theme.dim(value)}\n`);
  }

  // Shown once, to someone who has not seen a prompt yet. After that it is
  // furniture: the same sentence every launch, telling you what you know.
  if (firstRun) {
    stdout.write(`\n  ${theme.faint('describe a change, or ask about the code   /help   ctrl+c interrupts')}\n`);
  }
}

/**
 * The rule above the input.
 *
 * A full-screen TUI can pin the model to a status bar; scrollback cannot, so
 * the separator that marks where the last turn ended carries it instead — the
 * information is where the eye already is, and costs no extra line.
 */
export function promptRule({ model, escalated = false } = {}) {
  const label = escalated ? `${model} ↑` : model;
  const rule = '─'.repeat(Math.max(4, width() - label.length - 4));
  stdout.write(`\n${theme.dim(rule)}  ${theme.dim(label)}\n`);
}

/** `← Edit path/to/file` — names the file a change is about to be shown for. */
export function fileHeader(verb, filePath) {
  return `\n  ${theme.dim('←')} ${theme.dim(verb)} ${theme.tool(filePath)}\n`;
}

/**
 * The spinner currently drawing, if any.
 *
 * Anything that needs the cursor to itself — above all a prompt waiting on a
 * keypress — has to be able to silence it. The spinner repaints the current
 * line every 90ms, so a question drawn underneath one is erased before it can
 * be read: the interface said "thinking 63s" while it was in fact waiting for
 * the user, which is indistinguishable from a hang.
 */
let running = null;

/** Silence the spinner so the cursor line belongs to the caller. */
export function suspendSpinner() {
  running?.stop();
}

export function createSpinner(initialLabel = 'thinking') {
  let frame = 0;
  let timer = null;
  let active = false;
  let label = initialLabel;
  let started = Date.now();

  const render = () => {
    if (!stdout.isTTY) return;
    const secs = Math.floor((Date.now() - started) / 1000);
    const elapsed = secs > 0 ? ` ${secs}s` : '';
    // Truncated to the terminal, never wrapped. clearLine erases one row, so a
    // spinner that spills onto a second one leaves the overflow stranded there
    // for the rest of the session — the source of torn half-labels like
    // "read README.md:" followed by a bare "00-".
    const room = Math.max(8, (stdout.columns || 80) - elapsed.length - 5);
    const text = label.length > room ? `${label.slice(0, room - 1)}…` : label;
    stdout.clearLine?.(0);
    stdout.cursorTo?.(0);
    stdout.write(`  ${theme.accent(SPINNER_FRAMES[frame])} ${theme.dim(text)}${theme.dim(elapsed)}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };

  const spinner = {
    start(nextLabel) {
      if (nextLabel !== undefined) label = nextLabel;
      if (active) return;
      active = true;
      // The clock starts when the spinner does, not when the label last
      // changed. `start()` with no argument left `started` at its previous
      // value, so the count included every second the spinner was stopped —
      // which is the time you spent typing. A turn began at "18s".
      started = Date.now();
      running = spinner;
      render();
      timer = setInterval(render, 90);
      timer.unref?.();
    },
    /** Change what is being waited on without restarting the spinner. */
    setLabel(next) {
      if (next === label) return;
      label = next;
      started = Date.now();
      if (active) render();
    },
    stop() {
      if (!active) return;
      active = false;
      if (running === spinner) running = null;
      clearInterval(timer);
      if (stdout.isTTY) {
        stdout.clearLine?.(0);
        stdout.cursorTo?.(0);
      }
    },
    get active() {
      return active;
    },
  };
  return spinner;
}

/** Verb plus its most identifying argument — no key=value noise. */
export function describeCall(name, args = {}) {
  switch (name) {
    case 'read_file':
      return `read ${args.path}${args.start_line ? `:${args.start_line}-${args.end_line ?? ''}` : ''}`;
    case 'write_file':
      return `write ${args.path}`;
    case 'edit_file':
      return `edit ${args.path}`;
    case 'list_dir':
      return `ls ${args.path || '.'}`;
    case 'glob':
      return `glob ${args.pattern}`;
    case 'grep': {
      const where = args.path && args.path !== '.' ? ` in ${args.path}` : '';
      const only = args.glob ? ` (${args.glob})` : '';
      return `grep /${args.pattern}/${where}${only}`;
    }
    case 'run_command':
      return `run ${args.command}`;
    case 'update_plan':
      return `plan ${(args.todos || []).length} tasks`;
    default:
      return `${name} ${Object.values(args).map((v) => short(v, 30)).join(' ')}`.trim();
  }
}

/**
 * Result condensed to a few words.
 *
 * A count or an outcome is what the eye needs while scanning; the full text is
 * already in the model's context, which is the only place it has to be.
 */
export function summarizeResult(name, result) {
  const text = (result.output || '').trim();

  // Checked before the generic error path so a failing command reads the same
  // as a passing one — "exit 1" next to "exit 0", not "Exit code 1".
  if (name === 'run_command') {
    const code = text.match(/^(?:Exit code|Command timed out)[^\d-]*(-?\d+)?/i);
    const timedOut = /timed out/i.test(text);
    const label = timedOut ? 'timed out' : `exit ${code?.[1] ?? '?'}`;
    return result.isError ? theme.err(label) : theme.dim(label);
  }

  if (result.isError) {
    const first = text.split('\n').find((l) => l.trim()) || 'failed';
    return theme.err(short(first, 60));
  }
  if (!text) return theme.dim('done');
  if (name === 'update_plan') {
    const n = text.split('\n').filter((l) => /^\s*\[/.test(l)).length;
    return theme.dim(n ? `${n} task${n === 1 ? '' : 's'}` : 'cleared');
  }

  if (name === 'read_file') {
    const m = text.match(/\(lines (\d+)-(\d+) of (\d+)\)/);
    if (m) {
      const [start, end, total] = m.slice(1).map(Number);
      // The count is what came back, not how big the file is. Reporting the
      // total made six successive 20-line reads all report "591 lines", so a
      // model crawling a file looked like it was reading the same thing over.
      const got = end - start + 1;
      return theme.dim(got === total ? `${total} lines` : `${got} of ${total} lines`);
    }
  }

  if (name === 'grep' || name === 'glob') {
    // The `+` is load-bearing: it marks a search that stopped at its limit
    // rather than finishing, and dropping it would report a cap as a total.
    const m = text.match(/^(\d+)(\+?) match/);
    if (m) return theme.dim(`${m[1]}${m[2]} ${Number(m[1]) === 1 && !m[2] ? 'match' : 'matches'}`);
    if (/^No (matches|files)/.test(text)) return theme.dim('none');
  }
  if (name === 'list_dir') {
    // The first line is the directory itself, which the call already showed.
    // Echoing it back told the reader nothing they had not just read.
    const entries = text.split('\n').length - 1;
    return theme.dim(entries === 1 ? '1 entry' : `${entries} entries`);
  }
  if (name === 'edit_file' || name === 'write_file') {
    const n = text.match(/\((\d+) replacement/);
    if (n) return theme.dim(`${n[1]} change${n[1] === '1' ? '' : 's'}`);
    const lines = text.match(/\((\d+) lines\)/);
    if (lines) return theme.dim(`${lines[1]} lines`);
    return theme.dim('written');
  }
  return theme.dim(short(text.split('\n')[0], 50));
}

/** One aligned line: status, what ran, what came back. */
export function toolLine(name, args, result) {
  const mark = result.isError ? theme.err('✗') : theme.ok('✓');
  const call = describeCall(name, args);
  const pad = Math.max(1, RESULT_COLUMN - call.length);
  return `  ${mark} ${theme.tool(short(call, RESULT_COLUMN - 2))}${' '.repeat(pad)}${summarizeResult(name, result)}`;
}

/**
 * The task list.
 *
 * Done work recedes into grey and the current task is the only thing coloured,
 * so the list answers "where are we" at a glance rather than having to be read
 * top to bottom.
 */
export function renderPlan(todos) {
  if (!todos?.length) return;
  const lines = todos.map((t) => {
    const mark = displayMarker(t.status);
    if (t.status === 'completed') return theme.dim(`  ${mark} ${t.task}`);
    if (t.status === 'in_progress') return `  ${theme.ok(mark)} ${theme.ok(t.task)}`;
    return theme.dim(`  ${mark} ${t.task}`);
  });
  stdout.write(`\n${lines.join('\n')}\n\n`);
}

/**
 * Ask the user to approve a tool call.
 *
 * The one place a box is warranted: execution stops here until the user
 * answers, and the border marks that this is not more scrollback.
 *
 * Three answers, because two are not enough — a one-off yes differs from
 * "stop asking about this tool", and conflating them trains blind approval.
 */
export async function askPermission({ tool, summary }) {
  // Before anything is drawn. The prompt is requested one step ahead of the
  // tool starting, so the previous step's spinner is still repainting this
  // line and would erase the question.
  suspendSpinner();

  stdout.write('\n' + boxen(`${theme.warn('Permission required')}\n${summary}`, {
    ...BOX,
    borderColor: 'yellow',
  }) + '\n');

  const answer = await ask(`  ${theme.dim(`[y] once  [a] always ${tool.name}  [n] no`)} › `);

  // Silence is not consent. Nobody is there to answer when stdin has reached
  // EOF, which happens whenever a prompt is piped in — and that arrives two
  // different ways: an already-closed interface throws ERR_USE_AFTER_CLOSE,
  // while a fresh one over a closed stdin simply never resolves.
  if (answer === null) {
    stdout.write(`  ${theme.dim('no input — declined')}\n`);
    return 'deny';
  }

  if (answer === 'a' || answer === 'always') return 'always';
  if (answer === 'y' || answer === 'yes' || answer === '') return 'allow';
  return 'deny';
}

/**
 * Read one answer, or null if the input stream is gone.
 * @returns {Promise<string|null>}
 */
async function ask(prompt) {
  let rlInstance;
  try {
    rlInstance = getReadline();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const onClose = () => resolve(null);
    rlInstance.once('close', onClose);
    rlInstance.question(prompt).then(
      (value) => {
        rlInstance.off('close', onClose);
        resolve(value.trim().toLowerCase());
      },
      () => resolve(null),
    );
  });
}

export function short(value, max = 80) {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
