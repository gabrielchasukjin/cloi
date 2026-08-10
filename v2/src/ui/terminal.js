/**
 * Terminal rendering and input.
 *
 * Deliberately plain: no alternate screen buffer, no full-screen redraw. Output
 * stays in the scrollback where the user can search it, and the agent's actions
 * read like a transcript rather than a dashboard.
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import chalk from 'chalk';
import boxen from 'boxen';
import { todoMarker } from '../tools/todo.js';

export const theme = {
  brand: chalk.hex('#7aa2f7').bold,
  dim: chalk.gray,
  tool: chalk.cyan,
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  accent: chalk.magenta,
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A single readline interface, reused so terminal state stays consistent. */
let rl = null;

export function getReadline() {
  if (!rl) {
    rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  }
  return rl;
}

export function closeReadline() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

export function banner({ model, cwd, sessionId }) {
  const body = [
    `${theme.brand('Cloi')} ${theme.dim('· local coding agent')}`,
    '',
    `${theme.dim('model  ')} ${model}`,
    `${theme.dim('folder ')} ${cwd}`,
    `${theme.dim('session')} ${sessionId.slice(0, 8)}`,
  ].join('\n');

  stdout.write(boxen(body, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    borderColor: 'gray',
  }) + '\n');
  stdout.write(theme.dim('  /help for commands · ctrl+c to interrupt · ctrl+d to exit\n\n'));
}

export function createSpinner(label = 'thinking') {
  let frame = 0;
  let timer = null;
  let active = false;
  const started = Date.now();

  const render = () => {
    if (!stdout.isTTY) return;
    const secs = Math.floor((Date.now() - started) / 1000);
    const elapsed = secs > 0 ? theme.dim(` ${secs}s`) : '';
    stdout.clearLine?.(0);
    stdout.cursorTo?.(0);
    stdout.write(`${theme.accent(SPINNER_FRAMES[frame])} ${theme.dim(label)}${elapsed}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };

  return {
    start() {
      if (active) return;
      active = true;
      render();
      timer = setInterval(render, 90);
      timer.unref?.();
    },
    stop() {
      if (!active) return;
      active = false;
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
}

/** Compact one-line description of a tool call, shown as it starts. */
export function formatToolCall(name, args = {}) {
  const detail = (() => {
    switch (name) {
      case 'read_file': {
        const range = args.start_line ? `:${args.start_line}-${args.end_line ?? ''}` : '';
        return `${args.path}${range}`;
      }
      case 'write_file':
      case 'edit_file':
        return args.path;
      case 'list_dir':
        return args.path || '.';
      case 'glob':
        return args.pattern;
      case 'grep': {
        // Every argument that can change the result set is shown. Omitting the
        // glob filter made "0 files searched" look like a bug in grep rather
        // than a filter the model chose.
        const where = args.path ? ` in ${args.path}` : '';
        const filter = args.glob ? ` (${args.glob} only)` : '';
        const flags = args.ignore_case ? ' -i' : '';
        return `/${args.pattern}/${flags}${where}${filter}`;
      }
      case 'run_command':
        return args.command;
      case 'update_plan':
        return `${(args.todos || []).length} tasks`;
      default:
        return Object.entries(args).map(([k, v]) => `${k}=${short(v)}`).join(' ');
    }
  })();
  return `${theme.tool(name)} ${theme.dim(short(detail, 120))}`;
}

/** First meaningful line of a tool result, for the collapsed view. */
export function summarizeResult(result) {
  const text = (result.output || '').trim();
  if (!text) return theme.dim('(no output)');
  const first = text.split('\n').find((l) => l.trim()) || '';
  const lineCount = text.split('\n').length;
  const suffix = lineCount > 1 ? theme.dim(` (+${lineCount - 1} lines)`) : '';
  const color = result.isError ? theme.err : theme.dim;
  return color(short(first, 140)) + suffix;
}

export function renderPlan(todos) {
  if (!todos?.length) return;
  const lines = todos.map((t) => {
    const mark = todoMarker(t.status);
    if (t.status === 'completed') return theme.dim(`  ${mark} ${t.task}`);
    if (t.status === 'in_progress') return `  ${theme.warn(mark)} ${t.task}`;
    return `  ${theme.dim(mark)} ${t.task}`;
  });
  stdout.write(`\n${lines.join('\n')}\n\n`);
}

/**
 * Ask the user to approve a tool call.
 *
 * Three answers, because two is not enough: a one-off yes is different from
 * "stop asking me about this tool", and conflating them trains people to
 * approve blindly.
 */
export async function askPermission({ tool, summary }) {
  stdout.write('\n' + boxen(
    `${theme.warn('Permission required')}\n\n${summary}`,
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'yellow' },
  ) + '\n');

  const prompt = `${theme.dim('  [y] once  [a] always for ' + tool.name + '  [n] no')} › `;
  const answer = (await getReadline().question(prompt)).trim().toLowerCase();

  if (answer === 'a' || answer === 'always') return 'always';
  if (answer === 'y' || answer === 'yes' || answer === '') return 'allow';
  return 'deny';
}

export function short(value, max = 80) {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function hr() {
  stdout.write(theme.dim('─'.repeat(Math.min(stdout.columns || 60, 60))) + '\n');
}
