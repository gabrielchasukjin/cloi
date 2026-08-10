/** Aggregate statistics over the task list. */

import { listTasks } from './store.js';

export function countByStatus() {
  const tasks = listTasks();
  let done = 0;
  let open = 0;
  for (const task of tasks) {
    if (task.done) done++;
    else open++;
  }
  return { done, open, total: tasks.length };
}

export function completionRate() {
  const { done, total } = countByStatus();
  return total === 0 ? 0 : done / total;
}
