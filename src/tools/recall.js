/**
 * Named tool results.
 *
 * Every tool result the model sees is a *preview*: truncated to fit the window,
 * and eventually dropped entirely by compaction. The full text is kept in the
 * session database under a short handle — `read_3`, `grep_1` — and this tool
 * reads it back, optionally filtered or sliced.
 *
 * The idea is Prime Agent's, where the model binds results to Python variables
 * in a live kernel and slices them later instead of re-reading the file. There
 * is no kernel here, so the store plays that role — and it is strictly more
 * durable: a kernel dies with the process, whereas a handle named in a summary
 * is still readable after the conversation that produced it has been compacted
 * away.
 *
 * What this buys, concretely: a model that read a 600-line README in six
 * twenty-line calls can read it once and then search within it.
 */

const MAX_MATCHES = 100;
/** Lines returned when the caller asks for a whole result without a range. */
const DEFAULT_WINDOW_LINES = 200;

export function registerRecallTool(registry) {
  registry.register({
    name: 'recall',
    description:
      'Read back the full output of an earlier tool call by its name (e.g. "read_3", "grep_1"), '
      + 'which appears at the end of that call\'s result. Use this instead of repeating a read or '
      + 'search: the stored copy is complete even when what you were shown was truncated, and it '
      + 'survives after older messages are summarised away. '
      + 'Give a pattern to return only matching lines, or start_line/end_line for a slice. '
      + 'Call with no name to list what is available.',
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Handle of a stored result, e.g. "grep_1".' },
        pattern: { type: 'string', description: 'Return only lines matching this regular expression.' },
        start_line: { type: 'integer', description: 'First line to return (1-indexed).' },
        end_line: { type: 'integer', description: 'Last line to return (inclusive).' },
      },
      required: [],
    },
    async execute(args, ctx) {
      const session = ctx.session;
      if (!session?.getResult) {
        return { output: 'No session is available, so nothing has been stored.', isError: true };
      }

      if (!args.name) return { output: listing(session) };

      const row = session.getResult(args.name);
      if (!row) {
        const available = session.listResults(10).map((r) => r.name);
        return {
          output: available.length
            ? `No stored result named "${args.name}". Available: ${available.join(', ')}.`
            : `No stored result named "${args.name}", and nothing has been stored yet.`,
          isError: true,
        };
      }

      const lines = row.content.split('\n');
      const header = `${args.name} — ${row.tool_name} ${describeArgs(row.args)} (${lines.length} lines)`;

      if (args.pattern) {
        let regex;
        try {
          regex = new RegExp(args.pattern);
        } catch (err) {
          return { output: `Invalid regular expression "${args.pattern}": ${err.message}`, isError: true };
        }
        const hits = [];
        for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
          if (regex.test(lines[i])) hits.push(`${i + 1}\t${lines[i]}`);
        }
        if (!hits.length) return { output: `${header}\nNo lines match /${args.pattern}/.` };
        // The cap is a floor, not a total — same reason grep reports "100+".
        const capped = hits.length >= MAX_MATCHES ? `\n[stopped at ${MAX_MATCHES} matches]` : '';
        return { output: `${header}\n${hits.length}${capped ? '+' : ''} matching lines:\n${hits.join('\n')}${capped}` };
      }

      // With no pattern and no range, a large result would be dumped whole and
      // then cut by the same truncation that made it worth storing. A window
      // plus the way to reach the rest is more use than a re-truncated dump.
      const asked = args.start_line !== undefined || args.end_line !== undefined;
      const windowed = !asked && lines.length > DEFAULT_WINDOW_LINES;

      const start = Math.max(1, args.start_line || 1);
      const end = windowed
        ? DEFAULT_WINDOW_LINES
        : Math.min(lines.length, args.end_line || lines.length);
      if (start > lines.length) {
        return { output: `${header}\nstart_line ${start} is past the end.`, isError: true };
      }

      const width = String(end).length;
      const body = lines
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(width)}\t${line}`)
        .join('\n');
      const more = windowed
        ? `\n[showing the first ${DEFAULT_WINDOW_LINES} of ${lines.length} lines — pass start_line/end_line, or a pattern, for the rest]`
        : '';
      return { output: `${header}\nlines ${start}-${end}:\n${body}${more}` };
    },
  });
}

function listing(session) {
  const rows = session.listResults(20);
  if (!rows.length) return 'Nothing stored yet. Results are saved as you use other tools.';
  const lines = rows.map((r) => `  ${r.name}\t${r.tool_name} ${describeArgs(r.args)}\t${r.bytes} bytes`);
  return `Stored results (newest first):\n${lines.join('\n')}`;
}

/** The arguments that produced a result, so a handle is recognisable. */
function describeArgs(json) {
  try {
    const args = JSON.parse(json || '{}');
    const summary = args.path || args.pattern || args.command || '';
    return summary ? `${String(summary).slice(0, 60)}` : '';
  } catch {
    return '';
  }
}
