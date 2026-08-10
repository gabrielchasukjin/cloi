/**
 * System prompt construction.
 *
 * Written for small local models, which behave differently from frontier ones:
 * they need the rules stated plainly, the environment stated explicitly, and
 * few enough instructions that the important ones are not diluted.
 */

import os from 'node:os';
import { shellName } from '../tools/shell.js';
import { todoMarker } from '../tools/todo.js';

export function buildSystemPrompt({ cwd, toolNames, todos = [] }) {
  const lines = [
    'You are Cloi, a coding agent working in a terminal on the user\'s machine.',
    'You help by reading, searching, writing, and editing real files, and by running commands.',
    '',
    'Environment:',
    `- Workspace root: ${cwd}`,
    `- Operating system: ${os.platform()} (${os.release()})`,
    `- Shell for run_command: ${shellName()}`,
    '',
    'Rules:',
    ...numbered(rules(toolNames)),
  ];

  if (toolNames?.length) {
    lines.push('', `Available tools: ${toolNames.join(', ')}.`);
  }

  lines.push(
    '',
    'For work that takes several steps, call update_plan first to lay out the tasks, then keep it current as you go.',
    'For a single-step request, skip the plan and just do the work.',
  );

  if (todos.length) {
    lines.push('', 'Current plan:');
    for (const t of todos) lines.push(`${todoMarker(t.status)} ${t.task}`);
  }

  return lines.join('\n');
}

/**
 * The rules, as a plain list.
 *
 * Numbered when rendered rather than in the text, because a rule that only
 * applies when a tool is present would otherwise leave a gap in the sequence —
 * and a model reading "1, 2, 4" wonders what it was not told.
 */
function rules(toolNames = []) {
  const list = [
    'Use tools to find things out. Never guess the contents of a file, and never invent file paths — locate them with glob or grep first.',
    'Before editing a file, read it. edit_file requires the exact existing text, including indentation.',
    'Take one step at a time. Call a tool, read the result, then decide the next step.',
    'Paths are relative to the workspace root. You cannot access files outside it.',
    'A result ending in "[saved as <name>]" was stored in full. To look at more of it, '
      + 'call recall with that name - with a pattern to search inside it, or start_line/end_line '
      + 'for a slice. What you were shown may have been truncated, and the stored copy is complete. '
      + 'Never re-read a file or repeat a search to see something you already fetched.',
  ];

  // Only when the interpreter exists. Describing a tool the model has not been
  // given is worse than silence: it spends a turn calling something that is not
  // there, and the repair costs another.
  if (toolNames.includes('python')) {
    list.push(
      'Repetitive work over many files or many matches belongs in one python cell, not one tool '
      + 'call per item. Stored results are already variables there, and every tool is callable as '
      + 'a function - so read_file(path=p) inside a loop does in one step what would otherwise '
      + 'take ten. That is still one step: the cell is the step.',
    );
  }

  list.push(
    'When you have finished, reply with plain text and no tool calls. That ends your turn.',
    'Keep replies short. Report what you did and what you found, not what you are about to do.',
  );
  return list;
}

/** Render a list as "1. …", so the numbering can never drift from the content. */
function numbered(list) {
  return list.map((rule, i) => `${i + 1}. ${rule}`);
}
