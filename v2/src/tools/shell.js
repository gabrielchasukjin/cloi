/**
 * Shell execution tool.
 *
 * The only tool that can run arbitrary code, so it is permission-gated and
 * hard-bounded by a timeout. Output is merged (stdout then stderr) because
 * models reason better about one ordered transcript than two streams.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import { sanitizeEnv } from '../util/secrets.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** The shell the model is actually talking to, surfaced in the system prompt. */
export function shellName() {
  return os.platform() === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
}

export function registerShellTool(registry) {
  registry.register({
    name: 'run_command',
    description:
      `Run a shell command in the workspace and return its combined output. `
      + `The shell is ${shellName()} on ${os.platform()}. `
      + `Use this for builds, tests, git, and package managers — not for reading or editing files, `
      + `which have dedicated tools.`,
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        timeout_ms: { type: 'integer', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).` },
      },
      required: ['command'],
    },
    async execute(args, ctx) {
      const timeout = Math.min(args.timeout_ms || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const started = Date.now();

      const result = await runShell(args.command, {
        cwd: ctx.cwd,
        timeout,
        signal: ctx.signal,
      });

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const header = result.timedOut
        ? `Command timed out after ${elapsed}s (limit ${timeout}ms).`
        : `Exit code ${result.code} (${elapsed}s).`;

      const body = result.output.trim() || '(no output)';
      return {
        output: `${header}\n${body}`,
        isError: result.timedOut || result.code !== 0,
      };
    },
  });
}

/**
 * Spawn a command and collect its output.
 *
 * Resolves rather than rejects on failure so callers get a uniform shape.
 * On timeout the child is killed, then SIGKILLed if it ignores the first
 * signal — a hung process must not outlive the tool call.
 */
export function runShell(command, { cwd, timeout = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        // Credentials are withheld from the child: the agent chooses this
        // command, so anything readable here is one `echo` from exfiltration.
        env: sanitizeEnv().env,
      });
    } catch (err) {
      resolve({ code: -1, output: `Failed to start command: ${err.message}`, timedOut: false });
      return;
    }

    let output = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      const combined = stderr ? `${output}${output && !output.endsWith('\n') ? '\n' : ''}${stderr}` : output;
      resolve({ code, output: combined, timedOut });
    };

    const kill = () => {
      try {
        child.kill();
        // Escalate if the process ignores the polite signal.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref?.();
      } catch {}
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(-1);
    }, timeout);

    const onAbort = () => {
      kill();
      finish(-1);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? 0));
  });
}
