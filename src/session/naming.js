/**
 * Names for stored tool results.
 *
 * `read_1` says only which tool ran and in what order — the model has to fetch
 * a result to remember what is in it. A name taken from the arguments carries
 * the answer: `stats_js` holds `src/lib/stats.js`, `npm_test` holds the output
 * of `npm test`.
 *
 * These are bound as variables in the Python kernel, so a name is not merely a
 * label: it has to be a valid identifier, it must not collide with a tool
 * function or a builtin, and `stats_js.splitlines()` has to read as code.
 */

/** Fallbacks when the arguments carry nothing worth naming. */
const TOOL_LABELS = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  run_command: 'run',
  list_dir: 'ls',
};

/**
 * Names a result must never take.
 *
 * A handle that shadows `grep` would replace the tool function with a string,
 * and the next cell calling `grep(pattern=...)` fails with something that looks
 * nothing like the cause. Python keywords and the builtins most likely to be
 * used in a cell are reserved for the same reason.
 */
const RESERVED = new Set([
  'read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep',
  'run_command', 'update_plan', 'recall', 'python', 'ToolError',
  'and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'none', 'not', 'or', 'pass', 'raise', 'return', 'true',
  'false', 'try', 'while', 'with', 'yield', 'async', 'await', 'nonlocal',
  'len', 'list', 'dict', 'set', 'str', 'int', 'float', 'open', 'print',
  'sum', 'min', 'max', 'sorted', 'type', 'range', 'map', 'filter', 'input',
]);

/** Long enough to be recognisable, short enough to type in a cell. */
const MAX_LENGTH = 28;

/** Lowercase, identifier-safe, no runs of underscores. */
function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/_+$/, '');
}

/**
 * The part of the arguments worth naming the result after.
 *
 * A path is reduced to its filename: the directory is what the paths have in
 * common, so it is the part that distinguishes nothing.
 */
function subject(toolName, args = {}) {
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return basename(args.path);
    case 'list_dir':
      return `ls_${basename(args.path) || 'root'}`;
    case 'glob':
      // `**/*.py` has nothing but the extension to go on.
      return `glob_${slug(String(args.pattern || '').replace(/[*/.]/g, ' ')) || 'files'}`;
    case 'grep':
      return `grep_${slug(args.pattern) || 'search'}`;
    case 'run_command': {
      // The last segment of a chain, not the first: `cd demo && python x.py`
      // is about `x.py`, and naming it `cd_demo` describes the setup rather
      // than the work.
      const last = String(args.command || '').split(/&&|\|\||;/).pop() || '';
      const words = last.trim().split(/\s+/).filter((w) => w && !w.startsWith('-'));
      return slug(words.slice(0, 2).join(' ')) || 'run';
    }
    default:
      return '';
  }
}

function basename(filePath) {
  if (!filePath) return '';
  const last = String(filePath).split(/[/\\]/).filter(Boolean).pop() || '';
  return slug(last);
}

/**
 * Choose a name for a result.
 *
 * @param {string} toolName
 * @param {object} args Arguments the tool was called with.
 * @param {(name: string) => boolean} taken Whether a name is already in use.
 * @returns {string}
 */
export function resultName(toolName, args, taken = () => false) {
  let base = subject(toolName, args) || TOOL_LABELS[toolName] || slug(toolName) || 'result';

  // An identifier cannot start with a digit, and a reserved word cannot be
  // rebound. Both are fixed by prefixing with what the tool was.
  if (/^[0-9]/.test(base) || RESERVED.has(base)) {
    base = `${TOOL_LABELS[toolName] || slug(toolName)}_${base}`;
  }

  if (!taken(base)) return base;
  // Same file read twice is a second result, not a replacement: the first may
  // predate an edit, and a name that silently rebinds would hide that.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}
