/**
 * Interactive chat REPL.
 *
 * Owns the human side of the conversation: reading input, rendering the
 * agent's actions as they happen, and translating Ctrl+C into an abort of the
 * current turn rather than an exit from the program.
 */

import { stdout } from 'node:process';
import { Session } from '../session/store.js';
import { createRegistry } from '../tools/index.js';
import { PermissionManager } from '../agent/permission.js';
import { runTurn, TurnStatus } from '../agent/loop.js';
import { loadConfig, saveConfig } from '../config.js';
import * as ollama from '../provider/ollama.js';
import { formatUsageCompact, formatUsageLine, formatUsageDetail, contextPressure } from '../util/usage.js';
import {
  theme, banner, getReadline, closeReadline, createSpinner,
  describeCall, toolLine, renderPlan, askPermission, shortPath,
  promptRule, fileHeader, contextMeter,
} from '../ui/terminal.js';
import { renderDiff } from '../ui/diff.js';

export async function startRepl({ session, oneShot = null }) {
  const config = loadConfig();
  const registry = createRegistry();
  const permissions = new PermissionManager({
    ask: askPermission,
    autoApprove: config.autoApprove,
  });

  if (!oneShot) {
    banner({
      model: session.model,
      escalationModel: config.escalationModel,
      contextLength: config.contextLength,
      cwd: session.cwd,
      // Ask for two: list(1) can never return more than one row, so testing
      // it for <= 1 made every launch look like the first.
      firstRun: Session.list(2).length <= 1,
    });
  }

  const ui = createUi();
  /** Usage from the most recent turn, for the `/usage` command. */
  const lastTurn = { usage: null, turnMs: null };

  if (oneShot) {
    const result = await drive({ session, registry, permissions, config, ui, text: oneShot, lastTurn });
    closeReadline();
    return result.status === TurnStatus.COMPLETE ? 0 : 1;
  }

  const rl = getReadline();

  while (true) {
    promptRule({ model: session.model, escalated: session.model !== config.model });

    let input;
    try {
      input = await rl.question(`${theme.brand('›')} `);
    } catch {
      // Ctrl+D closes the interface.
      break;
    }

    const text = input.trim();
    if (!text) continue;

    if (text.startsWith('/')) {
      const outcome = await handleCommand(text, { session, registry, config, lastTurn });
      if (outcome === 'exit') break;
      continue;
    }

    await drive({ session, registry, permissions, config, ui, text, lastTurn });
  }

  stdout.write(theme.dim('\nSession saved. Resume with: cloi --continue\n'));
  closeReadline();
  return 0;
}

/** Run one turn with a fresh abort controller wired to Ctrl+C. */
async function drive({ session, registry, permissions, config, ui, text, lastTurn }) {
  const controller = new AbortController();
  let interrupted = false;

  const onSigint = () => {
    interrupted = true;
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  ui.reset();
  stdout.write('\n');

  try {
    const result = await runTurn({
      session,
      registry,
      permissions,
      config,
      ui: ui.handlers,
      userText: text,
      signal: controller.signal,
    });

    ui.finish();

    if (lastTurn) {
      lastTurn.usage = result.usage;
      lastTurn.turnMs = result.turnMs;
    }

    if (interrupted || result.status === TurnStatus.ABORTED) {
      stdout.write(theme.warn('\n  Interrupted.\n'));
    } else if (result.status === TurnStatus.ERROR) {
      stdout.write(theme.err(`\n  ${result.error}\n`));
    }

    // Usage is reported even for an interrupted or failed turn: the tokens were
    // still generated and the time was still spent.
    if (config.showUsage && result.usage) {
      const { peakPromptTokens, contextLength } = result.usage;
      const pressure = contextPressure(result.usage);
      const hint = pressure === 'high' ? `  ${theme.dim('history is being dropped')}` : '';
      // The bar needs both ends of the ratio. With no context figure there is
      // nothing to fill, so fall back to the plain token count.
      const stat = contextLength
        ? contextMeter({ used: peakPromptTokens, total: contextLength, pressure })
        : theme.dim(formatUsageCompact(result.usage));
      stdout.write(`\n  ${stat}${hint}\n`);
    }
    stdout.write('\n');

    return result;
  } finally {
    process.off('SIGINT', onSigint);
    // A denial aborts one turn; the next should start from a clean slate.
    permissions.aborted = false;
  }
}

/**
 * Rendering state machine.
 *
 * The spinner and streamed text share one line, so every path that writes must
 * stop the spinner first. Centralising that here keeps the output from tearing.
 */
function createUi() {
  const spinner = createSpinner('thinking');
  let streaming = false;

  /**
   * Clear the shared line before writing to it.
   *
   * Both the spinner and streamed assistant text occupy the current line, so
   * anything printed after them has to close it first. Only `onToolStart` did,
   * which is how a verification warning once landed on the tail of a sentence:
   * "I'll edit the file now.  ! not supported by the evidence".
   */
  const stopSpinner = () => {
    if (spinner.active) spinner.stop();
    if (streaming) {
      stdout.write('\n');
      streaming = false;
    }
  };

  const handlers = {
    onIteration() {
      streaming = false;
      spinner.start();
    },

    onThinking() {
      // Reasoning tokens are not shown; the spinner already signals activity.
    },

    onAssistantDelta(chunk) {
      if (!streaming) {
        stopSpinner();
        streaming = true;
      }
      stdout.write(chunk);
    },

    onAssistantDone() {
      stopSpinner();
    },

    onToolStart({ name, args }) {
      stopSpinner();
      // The spinner names what is running; the outcome is printed when the call
      // returns, so each tool call costs exactly one line of scrollback.
      spinner.start(describeCall(name, args));
    },

    onToolEnd({ name, args, result }) {
      stopSpinner();
      const change = result.meta?.change;
      if (change) {
        // A file change is the only irreversible thing a turn does, so it is
        // the one result worth more than a line. "1 change" said that something
        // happened without saying what.
        const diff = renderDiff(change.before, change.after);
        if (diff) {
          stdout.write(fileHeader(change.verb, change.path));
          stdout.write(`${diff}\n\n`);
          spinner.start('thinking');
          return;
        }
      }
      stdout.write(`${toolLine(name, args, result)}\n`);
      spinner.start('thinking');
    },

    onToolRepaired({ from, to }) {
      stopSpinner();
      stdout.write(theme.dim(`  ~ read "${from}" as ${to}\n`));
    },

    onToolError({ name, message }) {
      stopSpinner();
      stdout.write(`  ${theme.err('✗')} ${theme.tool(name)}  ${theme.dim(message)}\n`);
    },

    onToolDenied({ name }) {
      stopSpinner();
      stdout.write(`  ${theme.warn('–')} ${theme.dim(`${name} skipped`)}\n`);
    },

    onPlanUpdate(todos) {
      stopSpinner();
      renderPlan(todos);
      spinner.start();
    },

    onJudging({ model }) {
      // Close the streamed line first. Judging starts before the answer is
      // marked done, so without this the spinner repaints the last row of the
      // answer and eats the end of a sentence:
      // "Startup f  ⠦ reviewing against the evidence".
      stopSpinner();
      // No line of its own beyond that: the spinner says what is being awaited.
      spinner.start(`reviewing against the evidence · ${model}`);
    },

    onVerificationFailed({ detail, judged }) {
      stopSpinner();
      stdout.write(`  ${theme.warn('!')} ${theme.dim(judged ? 'not supported by the evidence' : 'did not check out')}\n`);
      stdout.write(`    ${theme.dim(detail)}\n`);
      spinner.start('thinking');
    },

    onEscalate({ from, to, reason }) {
      stopSpinner();
      stdout.write(`  ${theme.warn('↑')} ${from} ${theme.dim('→')} ${to}  ${theme.dim(reason)}\n`);
      spinner.start('thinking');
    },

    onNotice(message) {
      stopSpinner();
      stdout.write(`\n  ${theme.warn(message)}\n`);
    },

    onError(message) {
      stopSpinner();
      stdout.write(`\n  ${theme.err(message)}\n`);
    },
  };

  return {
    handlers,
    reset() {
      streaming = false;
    },
    finish() {
      stopSpinner();
    },
  };
}

async function handleCommand(input, { session, registry, config, lastTurn }) {
  const [command, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (command) {
    case 'help':
      stdout.write([
        '',
        `  ${theme.brand('/help')}            this message`,
        `  ${theme.brand('/model')} [name]   show or switch the Ollama model`,
        `  ${theme.brand('/models')}          list installed models`,
        `  ${theme.brand('/tools')}           list available tools`,
        `  ${theme.brand('/plan')}            show the current task list`,
        `  ${theme.brand('/usage')}           token and throughput breakdown for the last turn`,
        `  ${theme.brand('/sessions')}        list recent sessions`,
        `  ${theme.brand('/session')}         show this session's id and location`,
        `  ${theme.brand('/exit')}            quit`,
        '',
        `  ${theme.dim('ctrl+c interrupts the current turn · ctrl+d exits')}`,
        '',
      ].join('\n'));
      return;

    case 'model': {
      if (!arg) {
        stdout.write(`\n  ${session.model}\n\n`);
        return;
      }
      const models = await ollama.listModels().catch(() => []);
      if (models.length && !models.includes(arg)) {
        stdout.write(theme.err(`\n  "${arg}" is not installed. Try: ollama pull ${arg}\n\n`));
        return;
      }
      if (!(await ollama.supportsTools(arg))) {
        stdout.write(theme.err(`\n  "${arg}" does not support tool calling, so the agent loop cannot use it.\n\n`));
        return;
      }
      session.model = arg;
      saveConfig({ model: arg });
      config.model = arg;
      stdout.write(theme.ok(`\n  Switched to ${arg} (saved as default).\n\n`));
      return;
    }

    case 'models': {
      const models = await ollama.listModels().catch(() => []);
      if (!models.length) {
        stdout.write(theme.dim('\n  No models found. Pull one with: ollama pull gemma4:12b\n\n'));
        return;
      }
      stdout.write('\n');
      for (const m of models) {
        const marker = m === session.model ? theme.ok('●') : theme.dim('○');
        stdout.write(`  ${marker} ${m}\n`);
      }
      stdout.write('\n');
      return;
    }

    case 'tools': {
      const tools = await registry.available();
      stdout.write('\n');
      for (const t of tools) {
        const gate = t.permission === 'ask' ? theme.warn(' (asks first)') : '';
        stdout.write(`  ${theme.tool(t.name)}${gate}\n    ${theme.dim(t.description.split('\n')[0])}\n`);
      }
      stdout.write('\n');
      return;
    }

    case 'usage': {
      if (!lastTurn?.usage) {
        stdout.write(theme.dim('\n  No usage recorded yet — ask me something first.\n\n'));
        return;
      }
      stdout.write(theme.dim(`\n  ${formatUsageLine(lastTurn.usage, { turnMs: lastTurn.turnMs })}\n\n`));
      stdout.write(formatUsageDetail(lastTurn.usage, { turnMs: lastTurn.turnMs }) + '\n\n');
      return;
    }

    case 'plan': {
      const todos = session.getTodos();
      if (!todos.length) {
        stdout.write(theme.dim('\n  No plan yet.\n\n'));
        return;
      }
      renderPlan(todos);
      return;
    }

    case 'sessions': {
      const rows = Session.list(10);
      stdout.write('\n');
      for (const row of rows) {
        const when = new Date(row.updated_at).toLocaleString();
        const active = row.id === session.id ? theme.ok('●') : theme.dim('○');
        stdout.write(`  ${active} ${theme.dim(row.id.slice(0, 8))}  ${row.title || theme.dim('(untitled)')}\n`);
        stdout.write(`    ${theme.dim(`${when} · ${row.message_count} messages · ${row.cwd}`)}\n`);
      }
      stdout.write('\n');
      return;
    }

    case 'session':
      stdout.write(`\n  ${theme.dim('id     ')} ${session.id}\n`);
      stdout.write(`  ${theme.dim('folder ')} ${session.cwd}\n`);
      stdout.write(`  ${theme.dim('turns  ')} ${session.messageCount()} messages\n\n`);
      return;

    case 'exit':
    case 'quit':
      return 'exit';

    default:
      stdout.write(theme.err(`\n  Unknown command: /${command}. Try /help.\n\n`));
      return;
  }
}
