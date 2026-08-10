/** In-memory task store. */

let tasks = [];
let nextId = 1;

export function addTask(title, priority = 'normal') {
  const task = { id: nextId++, title, priority, done: false };
  tasks.push(task);
  return task;
}

export function completeTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  const updated = { ...task };
  updated.done = true;
  return updated;
}

export function listTasks() {
  return tasks;
}

export function clearTasks() {
  tasks = [];
  nextId = 1;
}
