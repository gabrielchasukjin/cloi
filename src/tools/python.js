/**
 * Python as a scratchpad, with tool results already in scope.
 *
 * The gap this closes: `recall` can search a stored result or slice it, and
 * nothing else, because those were the two operations written by hand. Here
 * every stored handle arrives as a Python string, so the agent can do whatever
 * it likes with it — filter, count, intersect two results, build a table —
 * without another round-trip to fetch anything.
 *
 *     lines = [l for l in read_1.splitlines() if 'export' in l]
 *     len(lines)
 *
 * `read_1` was not fetched here. It was bound because a `read_file` call
 * earlier in the session produced it, and the binding survives compaction for
 * the same reason the handle does: it comes from the store, not the transcript.
 *
 * The kernel is additive. The ordinary tools remain, and a model that never
 * writes Python is unaffected — which matters, because writing correct Python
 * against live state is harder than emitting a tool call, and a bad line here
 * can leave the namespace in a state later cells inherit.
 */

import { detectPython, kernelFor } from './kernel.js';
import { DECISION } from '../agent/permission.js';
import { kernelSnapshotPath } from '../util/paths.js';

/** Output beyond this is cut before it reaches the transcript. */
const MAX_LINES = 200;

export function registerPythonTool(registry) {
  registry.register({
    name: 'python',
    description:
      'Run Python in a session-long interpreter. Variables, imports and functions persist '
      + 'between calls, so results can be built up step by step. Every stored tool result is '
      + 'already bound as a string variable under its handle (read_1, grep_2, …) — use those '
      + 'instead of re-reading a file or repeating a search. A bare expression on the last line '
      + 'returns its value, as in a REPL. This is a scratchpad for working with data you have '
      + 'already gathered; use run_command to run the project\'s own tests and tools.',
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source to execute in the persistent namespace.' },
      },
      required: ['code'],
    },
    // Missing Python is not an error to report at call time — the tool simply
    // is not offered, so the model never reaches for something it cannot have.
    check: () => !!detectPython(),

    async execute(args, ctx) {
      const command = detectPython();
      if (!command) {
        return { output: 'No Python 3 interpreter is available.', isError: true };
      }

      const sessionId = ctx.session?.id ?? 'default';
      const kernel = kernelFor(sessionId, {
        cwd: ctx.cwd,
        command,
        snapshotPath: kernelSnapshotPath(sessionId),
      });
      kernel.onCall = (message) => serveTool(message, ctx);

      try {
        await installCallableTools(kernel, ctx);
        await bindStoredResults(kernel, ctx.session);
        const result = await kernel.exec(args.code);
        // After the cell, not before: what is worth keeping is what it left.
        kernel.scheduleSnapshot();
        return format(result, kernel.takeRestoreNotice());
      } catch (err) {
        // A dead or hung kernel is a tool failure, not a turn-ending one: the
        // model can try something smaller, or fall back to the other tools.
        return { output: err.message, isError: true };
      }
    },
  });
}

/** A kernel calling itself would recurse; recall is redundant once bound. */
const NOT_CALLABLE = new Set(['python', 'recall']);

/**
 * Expose cloi's tools as Python functions.
 *
 * Installed once per kernel. The set cannot change mid-session, so re-sending
 * it on every cell would be a round-trip for nothing.
 */
async function installCallableTools(kernel, ctx) {
  if (kernel.toolsInstalled) return;
  const registry = ctx.registry;
  if (!registry?.available) return;

  const names = (await registry.available())
    .map((tool) => tool.name)
    .filter((name) => !NOT_CALLABLE.has(name));

  await kernel.installTools(names);
  kernel.toolsInstalled = true;
}

/**
 * Run a tool for a cell that asked for it.
 *
 * The permission gate is the point. `python` being approved buys the *cell* a
 * run, not everything the cell can reach — otherwise an approved scratchpad
 * becomes a way to edit files and run shell commands with no prompt at all,
 * which is precisely the gate the model would be routing around.
 */
async function serveTool({ tool: name, args }, ctx) {
  const registry = ctx.registry;
  if (!registry) throw new Error('tools are not available in this kernel');
  if (NOT_CALLABLE.has(name)) throw new Error(`${name} cannot be called from Python`);

  const tool = registry.get(name);
  if (!tool) throw new Error(`no such tool: ${name}`);

  if (tool.permission === 'ask') {
    if (!ctx.permissions) throw new Error(`${name} needs approval, which is not available here`);
    // request() answers with {decision, reason}, not a bare decision. Comparing
    // the object to DECISION.ALLOW is always false — but written the other way
    // round it would be always true, and every gated tool would sail through.
    const { decision, reason } = await ctx.permissions.request(tool, args || {});
    if (decision !== DECISION.ALLOW) throw new Error(reason || `${name} was not approved`);
  }

  const result = await registry.dispatch(name, args || {}, ctx);
  if (result.isError) throw new Error(result.output);
  return result.output;
}

/**
 * Make every stored result available as a variable.
 *
 * Done before each cell rather than once at startup, because handles are
 * created as the turn runs — a grep two steps ago should be in scope now.
 * Already-bound names are skipped, so this costs nothing after the first call.
 */
async function bindStoredResults(kernel, session) {
  if (typeof session?.listResults !== 'function') return;

  const vars = {};
  for (const row of session.listResults(50)) {
    if (kernel.bound.has(row.name)) continue;
    const stored = session.getResult(row.name);
    if (stored) vars[row.name] = stored.content;
  }
  if (Object.keys(vars).length) await kernel.bind(vars);
}

/** Render a kernel reply the way a REPL would. */
function format(result, notice) {
  const parts = [];
  if (notice) parts.push(notice);
  if (result.stdout) parts.push(clip(result.stdout.replace(/\n$/, '')));
  if (result.stderr) parts.push(clip(result.stderr.replace(/\n$/, '')));

  if (!result.ok) {
    parts.push(result.error || 'Python raised an error.');
    return { output: parts.join('\n') || 'Python raised an error.', isError: true };
  }

  if (result.value !== null && result.value !== undefined) parts.push(clip(result.value));

  // Bound handles are not news — the model knows those exist. What it needs
  // back is what *this* cell left behind for the next one.
  const defined = (result.names || []).filter((n) => !/^(read|grep|glob|ls|run|write|edit)_\d+$/.test(n));
  if (defined.length) parts.push(`[variables: ${defined.join(', ')}]`);

  // Only when there is genuinely nothing to say. A cell that assigns and prints
  // nothing is normal and successful, and an empty result reads as a failure.
  if (!parts.length) parts.push('(no output)');

  return { output: parts.join('\n') };
}

function clip(text) {
  const lines = String(text).split('\n');
  if (lines.length <= MAX_LINES) return lines.join('\n');
  return `${lines.slice(0, MAX_LINES).join('\n')}\n… ${lines.length - MAX_LINES} more lines`;
}
