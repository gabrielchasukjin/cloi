/**
 * Builtin tool assembly.
 *
 * Tools register themselves through explicit calls rather than filesystem
 * auto-discovery. Auto-loading whatever happens to sit in a directory is how
 * an agent ends up executing untrusted code it was never meant to see.
 */

import { ToolRegistry } from './registry.js';
import { registerFsTools } from './fs-tools.js';
import { registerShellTool } from './shell.js';
import { registerTodoTool } from './todo.js';

export function createRegistry() {
  const registry = new ToolRegistry();
  registerFsTools(registry);
  registerShellTool(registry);
  registerTodoTool(registry);
  return registry;
}

export { ToolRegistry };
