#!/usr/bin/env node
/**
 * Cloi entry point.
 *
 * Startup is deliberately opinionated about failing early: if Ollama is down,
 * the model is missing, or the model cannot call tools, that is reported here
 * with the exact command to fix it. Discovering any of those halfway through a
 * turn produces baffling behaviour instead of an error.
 */

// node:sqlite is stable in Node 24 but still emits an experimental warning on
// some builds. Silence that one warning without hiding anything else.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const text = typeof warning === 'string' ? warning : warning?.message || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return emitWarning.call(process, warning, ...args);
};

import path from 'node:path';
import fs from 'node:fs';
import { stdout, stderr } from 'node:process';
import chalk from 'chalk';
import { loadConfig, saveConfig } from '../src/config.js';
import { Session } from '../src/session/store.js';
import { startRepl } from '../src/cli/repl.js';
import { runSetup } from '../src/cli/setup.js';
import * as ollama from '../src/provider/ollama.js';
import { pruneOverflow, CONFIG_PATH } from '../src/util/paths.js';
import { closeReadline } from '../src/ui/terminal.js';
import { shutdownKernels } from '../src/tools/kernel.js';

const USAGE = `
${chalk.hex('#7aa2f7').bold('cloi')} — local coding agent powered by Ollama

  ${chalk.bold('Usage')}
    cloi                        start an interactive session
    cloi "add tests for auth"   run a single request and exit
    cloi setup                  pick models that fit this machine
    cloi sessions               list recent sessions

  ${chalk.bold('Options')}
    -m, --model <name>    Ollama model to use
    -c, --continue        resume the most recent session in this folder
        --session <id>    resume a specific session
        --cwd <dir>       workspace root (defaults to the current directory)
        --set-default     save --model as the default and exit
    -y, --yes             approve every tool without asking. For runs with
                          nobody at the keyboard; the model can then run any
                          shell command it likes
    -h, --help            show this message
`;

function parseArgs(argv) {
  const opts = { prompt: null, model: null, continue: false, session: null, cwd: null, help: false, setDefault: false, command: null, approveAll: false };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help': opts.help = true; break;
      case '-c': case '--continue': opts.continue = true; break;
      case '-m': case '--model': opts.model = argv[++i]; break;
      case '--session': opts.session = argv[++i]; break;
      case '--cwd': opts.cwd = argv[++i]; break;
      case '--set-default': opts.setDefault = true; break;
      case '-y': case '--yes': opts.approveAll = true; break;
      default:
        if (arg.startsWith('-')) {
          stderr.write(chalk.red(`Unknown option: ${arg}\n`));
          process.exit(2);
        }
        positional.push(arg);
    }
  }

  if (positional[0] === 'sessions' || positional[0] === 'setup') {
    opts.command = positional[0];
  } else if (positional.length) {
    opts.prompt = positional.join(' ');
  }
  return opts;
}

/**
 * Verify the model can actually drive the loop.
 * @returns {Promise<boolean>} false if the caller should exit.
 */
async function preflight(model) {
  if (!(await ollama.isReachable())) {
    const { host } = loadConfig();
    stderr.write(chalk.red(`\n  Cannot reach Ollama at ${host}.\n\n`));
    stderr.write(`  Start it with ${chalk.bold('ollama serve')}, or set ${chalk.bold('OLLAMA_HOST')} if it runs elsewhere.\n\n`);
    return false;
  }

  const installed = await ollama.listModels().catch(() => []);
  if (installed.length && !installed.includes(model)) {
    stderr.write(chalk.red(`\n  Model "${model}" is not installed.\n\n`));
    stderr.write(`  Install it with ${chalk.bold(`ollama pull ${model}`)}\n`);
    if (installed.length) stderr.write(chalk.gray(`  Installed: ${installed.join(', ')}\n`));
    stderr.write('\n');
    return false;
  }

  if (!(await ollama.supportsTools(model))) {
    stderr.write(chalk.red(`\n  Model "${model}" does not support tool calling.\n\n`));
    stderr.write('  Cloi drives an agent loop, which requires a tool-capable model.\n');
    stderr.write(`  Check support with ${chalk.bold(`ollama show ${model}`)} — look for "tools" under Capabilities.\n\n`);
    return false;
  }

  return true;
}

function listSessions() {
  const rows = Session.list(20);
  if (!rows.length) {
    stdout.write(chalk.gray('\n  No sessions yet.\n\n'));
    return;
  }
  stdout.write('\n');
  for (const row of rows) {
    stdout.write(`  ${chalk.gray(row.id.slice(0, 8))}  ${row.title || chalk.gray('(untitled)')}\n`);
    stdout.write(chalk.gray(`    ${new Date(row.updated_at).toLocaleString()} · ${row.message_count} messages · ${row.cwd}\n`));
  }
  stdout.write('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    stdout.write(USAGE);
    return 0;
  }

  let config = loadConfig();

  if (opts.setDefault) {
    if (!opts.model) {
      stderr.write(chalk.red('--set-default requires --model\n'));
      return 2;
    }
    saveConfig({ model: opts.model });
    stdout.write(chalk.green(`Default model set to ${opts.model}\n`));
    return 0;
  }

  if (opts.command === 'sessions') {
    listSessions();
    return 0;
  }

  if (opts.command === 'setup') {
    const code = await runSetup();
    closeReadline();
    return code;
  }

  // First run: no config on disk means no model has been chosen yet. Guessing
  // one produces an agent that looks broken rather than one that looks slow, so
  // measure the machine and ask instead.
  if (!fs.existsSync(CONFIG_PATH)) {
    // standalone:false — the session banner follows immediately and restates
    // the model, so setup does not repeat it.
    const code = await runSetup({ standalone: false });
    closeReadline();
    if (code !== 0) return code;
    // Re-read: setup just chose the model, and the value loaded above is stale.
    config = loadConfig();
  }

  const cwd = path.resolve(opts.cwd || process.cwd());
  if (!fs.existsSync(cwd)) {
    stderr.write(chalk.red(`Workspace not found: ${cwd}\n`));
    return 2;
  }

  const model = opts.model || config.model;
  if (!(await preflight(model))) return 1;

  pruneOverflow();

  let session = null;
  if (opts.session) {
    session = Session.load(opts.session);
    if (!session) {
      stderr.write(chalk.red(`No session with id ${opts.session}\n`));
      return 2;
    }
  } else if (opts.continue) {
    session = Session.latest(cwd);
    if (!session) {
      stdout.write(chalk.gray('No previous session in this folder; starting a new one.\n'));
    }
  }

  if (!session) session = Session.create({ cwd, model });
  // A resumed session adopts the model requested on this run.
  if (opts.model) session.model = opts.model;

  return startRepl({ session, oneShot: opts.prompt, approveAll: opts.approveAll });
}

/**
 * Exit without calling `process.exit`.
 *
 * On Windows, tearing the process down in the same tick that readline releases
 * stdin trips a libuv assertion (`UV_HANDLE_CLOSING` in async.c) and the shell
 * sees 127 instead of the real code — a clean quit looked like a crash. Setting
 * `exitCode` and letting the loop drain lets the handle finish closing first.
 */
function finish(code) {
  process.exitCode = code ?? 0;
  // The Python kernel is a child process; without this it outlives the session
  // that started it and keeps the workspace directory open.
  shutdownKernels();
  // Nothing is left to read, and an un-unref'd stdin would keep the loop alive.
  process.stdin.pause();
  process.stdin.unref?.();
}

main()
  .then(finish)
  .catch((err) => {
    stderr.write(chalk.red(`\nUnexpected error: ${err?.stack || err?.message || err}\n`));
    finish(1);
  });
