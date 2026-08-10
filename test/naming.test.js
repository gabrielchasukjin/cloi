import test from 'node:test';
import assert from 'node:assert/strict';
import { resultName } from '../src/session/naming.js';

const name = (tool, args, taken) => resultName(tool, args, taken);

test('a handle is named after what it holds', () => {
  // `read_1` says which tool ran and in what order. The model has to fetch the
  // result to remember what is in it.
  assert.equal(name('read_file', { path: 'src/lib/stats.js' }), 'stats_js');
  assert.equal(name('read_file', { path: 'README.md' }), 'readme_md');
  assert.equal(name('grep', { pattern: 'completionRate' }), 'grep_completionrate');
  assert.equal(name('glob', { pattern: '**/*.py' }), 'glob_py');
  assert.equal(name('list_dir', { path: 'src/lib' }), 'ls_lib');
});

test('a command is named after the work, not the setup', () => {
  assert.equal(name('run_command', { command: 'npm test' }), 'npm_test');
  // `cd demo && python x.py` is about x.py; naming it `cd_demo` describes
  // the directory change and nothing else.
  assert.equal(name('run_command', { command: 'cd demo && python mpp.py' }), 'python_mpp_py');
  assert.equal(name('run_command', { command: 'npm test --silent -w pkg' }), 'npm_test');
});

test('a name is always a usable Python identifier', () => {
  // These are bound as variables in the kernel, so a name that is not an
  // identifier is a SyntaxError the moment a cell touches it.
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const [tool, args] of [
    ['read_file', { path: '2024-report.txt' }],
    ['read_file', { path: 'src/lib/my file (copy).js' }],
    ['grep', { pattern: '^\s*export\s+' }],
    ['read_file', { path: '../../weird/../path.js' }],
    ['glob', { pattern: '***' }],
    ['run_command', { command: '--flags-only' }],
    ['read_file', { path: '' }],
    ['read_file', {}],
  ]) {
    assert.match(resultName(tool, args), identifier, `bad identifier from ${JSON.stringify(args)}`);
  }
});

test('a handle never shadows a tool function or a builtin', () => {
  // A handle called `grep` would replace the tool function with a string, and
  // the next cell calling grep(pattern=...) fails with something that looks
  // nothing like the cause.
  assert.notEqual(name('read_file', { path: 'grep' }), 'grep');
  assert.notEqual(name('read_file', { path: 'list.py' }), 'list');
  assert.equal(name('read_file', { path: 'open' }), 'read_open');
  assert.equal(name('read_file', { path: 'class' }), 'read_class');
});

test('a repeat read gets its own name rather than replacing the first', () => {
  // The earlier copy may predate an edit. Silently rebinding the name would
  // hide that the file changed.
  const used = new Set(['stats_js']);
  const second = name('read_file', { path: 'src/stats.js' }, (n) => used.has(n));
  assert.equal(second, 'stats_js_2');

  used.add(second);
  assert.equal(name('read_file', { path: 'src/stats.js' }, (n) => used.has(n)), 'stats_js_3');
});

test('names stay short enough to type in a cell', () => {
  const long = name('read_file', { path: 'src/very/deep/an-extremely-long-file-name-that-goes-on.js' });
  assert.ok(long.length <= 28, `${long} is ${long.length} chars`);
  assert.match(long, /^[A-Za-z_][A-Za-z0-9_]*$/);
});
