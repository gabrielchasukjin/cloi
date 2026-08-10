/**
 * Task list tool.
 *
 * Long-horizon work drifts: a model six tool calls deep forgets what it set out
 * to do. An explicit, rewritable plan that is echoed back after every update
 * keeps the objective inside the context window and gives the user something
 * legible to watch.
 *
 * State lives on the session, so it survives across turns and is persisted with
 * everything else.
 */

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export function registerTodoTool(registry) {
  registry.register({
    name: 'update_plan',
    description:
      'Record or update the task list for multi-step work. Pass the complete list every time — '
      + 'it replaces the previous one. Mark exactly one task in_progress while working on it, '
      + 'and mark it completed before starting the next. Skip this for single-step requests.',
    permission: 'safe',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full task list.',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'What needs to be done.' },
              status: { type: 'string', description: 'One of: pending, in_progress, completed.' },
            },
            required: ['task', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async execute(args, ctx) {
      const raw = Array.isArray(args.todos) ? args.todos : [];
      if (!raw.length) {
        ctx.session.setTodos([]);
        return 'Plan cleared.';
      }

      const todos = [];
      for (const item of raw) {
        const task = typeof item?.task === 'string' ? item.task.trim() : '';
        if (!task) continue;
        const status = STATUSES.has(item?.status) ? item.status : 'pending';
        todos.push({ task, status });
      }

      if (!todos.length) {
        return { output: 'Each todo needs a non-empty "task" and a status of pending, in_progress, or completed.', isError: true };
      }

      const inProgress = todos.filter((t) => t.status === 'in_progress').length;
      ctx.session.setTodos(todos);
      ctx.ui?.onPlanUpdate?.(todos);

      const rendered = todos.map((t) => `  ${marker(t.status)} ${t.task}`).join('\n');
      const warning = inProgress > 1
        ? '\nNote: more than one task is in_progress. Work on one at a time.'
        : '';
      return `Plan updated:\n${rendered}${warning}`;
    },
  });
}

function marker(status) {
  if (status === 'completed') return '[x]';
  if (status === 'in_progress') return '[>]';
  return '[ ]';
}

export { marker as todoMarker };
