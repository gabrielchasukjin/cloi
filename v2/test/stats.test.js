import test from 'node:test';
import assert from 'node:assert/strict';
import { addTask, completeTask, clearTasks } from '../src/lib/store.js';
import { countByStatus } from '../src/lib/stats.js';

test('completing a task is reflected in the counts', () => {
  clearTasks();
  addTask('write docs');
  const t = addTask('ship it');
  completeTask(t.id);
  assert.deepEqual(countByStatus(), { done: 1, open: 1, total: 2 });
});
