/**
 * Filesystem tools.
 *
 * All of these use Node APIs rather than shelling out to `sed`/`cat`/`find`,
 * which is what makes the agent work identically on Windows and POSIX.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, displayPath, looksBinary, isProbablyBinary, walkFiles, IGNORED_DIRS } from './workspace.js';

const READ_LIMIT = 1500;

export function registerFsTools(registry) {
  registry.register({
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns the contents with line numbers. '
      + 'Use start_line/end_line to read a slice of a large file.',
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        start_line: { type: 'integer', description: 'First line to read (1-indexed).' },
        end_line: { type: 'integer', description: 'Last line to read (inclusive).' },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      const abs = resolvePath(ctx.cwd, args.path);
      if (!fs.existsSync(abs)) return { output: `File not found: ${args.path}`, isError: true };
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return { output: `${args.path} is a directory. Use list_dir instead.`, isError: true };
      if (isProbablyBinary(abs)) return { output: `${args.path} looks like a binary file; not reading it.`, isError: true };

      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) return { output: `${args.path} contains binary data; not reading it.`, isError: true };

      const lines = buf.toString('utf8').split('\n');
      const start = Math.max(1, args.start_line || 1);
      const end = Math.min(lines.length, args.end_line || start + READ_LIMIT - 1);
      if (start > lines.length) {
        return { output: `${args.path} has only ${lines.length} lines; start_line ${start} is past the end.`, isError: true };
      }

      const width = String(end).length;
      const body = lines
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(width)}\t${line}`)
        .join('\n');

      const header = `${displayPath(ctx.cwd, abs)} (lines ${start}-${end} of ${lines.length})`;
      return {
        output: `${header}\n${body}`,
        // Reported so the loop can tell how much of a file the agent has
        // actually seen, which verification uses to judge whether a conclusion
        // about that file is supported.
        meta: { readRange: { path: displayPath(ctx.cwd, abs), start, end, total: lines.length } },
      };
    },
  });

  registry.register({
    name: 'write_file',
    description:
      'Write a file, creating it or replacing its entire contents. '
      + 'Prefer edit_file for changing part of an existing file.',
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
    async execute(args, ctx) {
      const abs = resolvePath(ctx.cwd, args.path);
      const existed = fs.existsSync(abs);
      const before = existed ? fs.readFileSync(abs, 'utf8') : '';
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content, 'utf8');
      const lineCount = args.content.split('\n').length;
      return {
        output: `${existed ? 'Overwrote' : 'Created'} ${displayPath(ctx.cwd, abs)} (${lineCount} lines).`,
        // meta is for the interface only — it is deliberately not persisted to
        // the transcript, so carrying both revisions here costs nothing at rest.
        meta: { change: { verb: existed ? 'Write' : 'Create', path: displayPath(ctx.cwd, abs), before, after: args.content } },
      };
    },
  });

  registry.register({
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match the file exactly, including '
      + 'indentation, and must be unique unless replace_all is true.',
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(args, ctx) {
      const abs = resolvePath(ctx.cwd, args.path);
      if (!fs.existsSync(abs)) return { output: `File not found: ${args.path}`, isError: true };

      const original = fs.readFileSync(abs, 'utf8');
      if (args.old_string === args.new_string) {
        return { output: 'old_string and new_string are identical; nothing to do.', isError: true };
      }

      const occurrences = countOccurrences(original, args.old_string);
      if (occurrences === 0) {
        return {
          output: `old_string was not found in ${args.path}. Read the file again and copy the exact text, including whitespace.`,
          isError: true,
        };
      }
      if (occurrences > 1 && !args.replace_all) {
        return {
          output: `old_string appears ${occurrences} times in ${args.path}. Add more surrounding context to make it unique, or set replace_all.`,
          isError: true,
        };
      }

      const updated = args.replace_all
        ? original.split(args.old_string).join(args.new_string)
        : original.replace(args.old_string, args.new_string);

      fs.writeFileSync(abs, updated, 'utf8');
      return {
        output: `Edited ${displayPath(ctx.cwd, abs)} (${occurrences} replacement${occurrences === 1 ? '' : 's'}).`,
        meta: { change: { verb: 'Edit', path: displayPath(ctx.cwd, abs), before: original, after: updated } },
      };
    },
  });

  registry.register({
    name: 'list_dir',
    description: 'List the contents of a directory in the workspace.',
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Defaults to the workspace root.' },
      },
    },
    async execute(args, ctx) {
      const abs = resolvePath(ctx.cwd, args.path || '.');
      if (!fs.existsSync(abs)) return { output: `Directory not found: ${args.path || '.'}`, isError: true };
      if (!fs.statSync(abs).isDirectory()) return { output: `${args.path} is a file, not a directory.`, isError: true };

      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !IGNORED_DIRS.has(e.name))
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

      if (!entries.length) return `${displayPath(ctx.cwd, abs)} is empty.`;

      const rows = entries.map((e) => {
        if (e.isDirectory()) return `  ${e.name}/`;
        let size = '';
        try {
          size = ` (${formatBytes(fs.statSync(path.join(abs, e.name)).size)})`;
        } catch {}
        return `  ${e.name}${size}`;
      });
      return `${displayPath(ctx.cwd, abs)}\n${rows.join('\n')}`;
    },
  });

  registry.register({
    name: 'glob',
    description:
      'Find files by glob pattern, e.g. "src/**/*.js". Returns matching paths, most recently modified first.',
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern relative to the workspace root.' },
        limit: { type: 'integer', description: 'Maximum paths to return (default 100).' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const limit = args.limit || 100;
      let matches = [];
      try {
        // fs.globSync is built into Node 22+, so no glob dependency is needed.
        matches = fs.globSync(args.pattern, { cwd: ctx.cwd })
          .map((m) => path.resolve(ctx.cwd, m))
          .filter((m) => {
            const rel = path.relative(ctx.cwd, m);
            return !rel.split(path.sep).some((seg) => IGNORED_DIRS.has(seg));
          });
      } catch (err) {
        return { output: `Invalid glob pattern "${args.pattern}": ${err.message}`, isError: true };
      }

      if (!matches.length) return `No files matched ${args.pattern}.`;

      const withTime = matches.map((m) => {
        let mtime = 0;
        try { mtime = fs.statSync(m).mtimeMs; } catch {}
        return { path: m, mtime };
      }).sort((a, b) => b.mtime - a.mtime);

      const shown = withTime.slice(0, limit).map((m) => displayPath(ctx.cwd, m.path));
      const extra = withTime.length > limit ? `\n… and ${withTime.length - limit} more` : '';
      return `${withTime.length} match${withTime.length === 1 ? '' : 'es'} for ${args.pattern}:\n${shown.join('\n')}${extra}`;
    },
  });

  registry.register({
    name: 'grep',
    description:
      'Search file contents with a regular expression. Returns matching lines with file paths and line numbers.',
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        path: { type: 'string', description: 'Directory or file to search. Defaults to the workspace root.' },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.py".' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
        limit: { type: 'integer', description: 'Maximum matching lines to return (default 100).' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      let regex;
      try {
        regex = new RegExp(args.pattern, args.ignore_case ? 'i' : '');
      } catch (err) {
        return { output: `Invalid regular expression "${args.pattern}": ${err.message}`, isError: true };
      }

      const searchRoot = resolvePath(ctx.cwd, args.path || '.');
      if (!fs.existsSync(searchRoot)) return { output: `Path not found: ${args.path}`, isError: true };

      const limit = args.limit || 100;
      const nameFilter = args.glob ? globToRegExp(args.glob) : null;
      const results = [];
      let scanned = 0;

      const files = fs.statSync(searchRoot).isFile()
        ? [searchRoot]
        : [...walkFiles(searchRoot)];

      for (const file of files) {
        if (results.length >= limit) break;
        if (nameFilter && !nameFilter.test(path.basename(file))) continue;
        if (isProbablyBinary(file)) continue;

        let content;
        try {
          const buf = fs.readFileSync(file);
          if (looksBinary(buf)) continue;
          content = buf.toString('utf8');
        } catch {
          continue;
        }
        scanned++;

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${displayPath(ctx.cwd, file)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            if (results.length >= limit) break;
          }
        }
      }

      if (!results.length) return `No matches for /${args.pattern}/ across ${scanned} files.`;
      const capped = results.length >= limit ? `\n[stopped at ${limit} matches]` : '';
      return `${results.length} match${results.length === 1 ? '' : 'es'} for /${args.pattern}/:\n${results.join('\n')}${capped}`;
    },
  });
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Minimal glob→RegExp for basename filtering (`*`, `?`, character classes). */
function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
