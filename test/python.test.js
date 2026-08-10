import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { detectPython, PythonKernel, shutdownKernels } from '../src/tools/kernel.js';

const python = detectPython();
/** Every kernel test needs a real interpreter; without one the tool is not offered. */
const needsPython = { skip: python ? false : 'no Python 3 on PATH' };

test('detection runs the interpreter rather than trusting the name', needsPython, () => {
  // On Windows `python3` is often an App Execution Alias that prints "Python
  // was not found…" and exits 0. A `which`-style check calls that a success and
  // the kernel then dies at the first cell with nothing to explain it.
  assert.ok(['python3', 'python', 'py'].includes(python));
  const probe = spawnSync(python, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '3', 'the detected command must really be Python 3');
});

test('a variable outlives the call that created it', needsPython, async () => {
  // The whole point of a kernel over a subprocess per call.
  const kernel = new PythonKernel({ cwd: process.cwd() });
  try {
    await kernel.exec('total = 0');
    await kernel.exec('total += 21');
    const result = await kernel.exec('total * 2');
    assert.equal(result.ok, true);
    assert.equal(result.value, '42');
  } finally {
    kernel.kill();
  }
});

test('the last expression of a multi-line cell is the value', needsPython, async () => {
  // Compiling the whole cell as an expression only works for a single line, so
  // a cell that built a list and then named it used to return nothing.
  const kernel = new PythonKernel({ cwd: process.cwd() });
  try {
    const result = await kernel.exec('rows = [1, 2, 3]\nsum(rows)');
    assert.equal(result.value, '6');
  } finally {
    kernel.kill();
  }
});

test('a cell that only assigns is a success, not an empty failure', needsPython, async () => {
  const kernel = new PythonKernel({ cwd: process.cwd() });
  try {
    const result = await kernel.exec('x = 1');
    assert.equal(result.ok, true);
    assert.equal(result.value, null);
    assert.ok(result.names.includes('x'), 'the caller needs to know what was defined');
  } finally {
    kernel.kill();
  }
});

test('an error is reported without killing the namespace', needsPython, async () => {
  // A failed cell must not cost every variable built before it.
  const kernel = new PythonKernel({ cwd: process.cwd() });
  try {
    await kernel.exec('keep = "still here"');
    const failed = await kernel.exec('1 / 0');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /ZeroDivisionError/);
    // The driver's own frames say nothing about the agent's code.
    assert.doesNotMatch(failed.error, /kernel\.py/);

    const after = await kernel.exec('keep');
    assert.equal(after.value, "'still here'");
  } finally {
    kernel.kill();
  }
});

test('stdout and the value are both reported', needsPython, async () => {
  const kernel = new PythonKernel({ cwd: process.cwd() });
  try {
    const result = await kernel.exec('print("working")\n7');
    assert.equal(result.stdout.trim(), 'working');
    assert.equal(result.value, '7');
  } finally {
    kernel.kill();
  }
});

test('bound values arrive as real Python strings', needsPython, async () => {
  const kernel = new PythonKernel({ cwd: process.cwd() });
  try {
    await kernel.bind({ grep_1: 'alpha\nbeta\ngamma' });
    const result = await kernel.exec("len([l for l in grep_1.splitlines() if 'a' in l])");
    assert.equal(result.value, '3');
    // Binding twice is a no-op, so a long session does not resend everything.
    const again = await kernel.bind({ grep_1: 'changed' });
    assert.deepEqual(again.bound, []);
  } finally {
    kernel.kill();
  }
});

test('a hung cell is killed rather than blocking the session', needsPython, async () => {
  // The kernel is single-threaded: one cell that never returns would otherwise
  // block every cell after it for the rest of the session.
  const kernel = new PythonKernel({ cwd: process.cwd(), timeoutMs: 700 });
  try {
    await assert.rejects(
      () => kernel.exec('import time; time.sleep(30)'),
      /did not finish within/,
    );
    // And the loss of state is stated rather than left to be discovered.
    assert.equal(kernel.running, false);
  } finally {
    kernel.kill();
  }
});

test('the kernel does not inherit the parent\'s secrets', needsPython, async () => {
  // Same containment as run_command: a subprocess started by the agent has no
  // business seeing the API keys of the shell that launched cloi.
  process.env.CLOI_TEST_FAKE_API_KEY = 'sk-must-not-leak';
  const kernel = new PythonKernel({ cwd: process.cwd() });
  try {
    const result = await kernel.exec('import os; os.environ.get("CLOI_TEST_FAKE_API_KEY", "absent")');
    assert.equal(result.value, "'absent'");
  } finally {
    kernel.kill();
    delete process.env.CLOI_TEST_FAKE_API_KEY;
  }
});

test('the python tool binds stored results before running', needsPython, async () => {
  // The bridge: a handle created by an earlier tool call is in scope without
  // being fetched, which is what recall could never do.
  // Only the two methods the binding uses. The real store is exercised by the
  // recall tests; coupling this to it would mean opening a session database
  // that node:sqlite then holds for the life of the process.
  const stored = { grep_1: 'one\ntwo\nthree' };
  const session = {
    id: 'bind-test',
    listResults: () => Object.keys(stored).map((name) => ({ name })),
    getResult: (name) => (stored[name] ? { name, content: stored[name] } : null),
  };

  const { createRegistry } = await import('../src/tools/index.js');
  const result = await createRegistry().dispatch(
    'python', { code: 'len(grep_1.splitlines())' }, { cwd: process.cwd(), session, ui: {} },
  );
  assert.match(result.output, /3/);

  // A handle created later in the same session is bound on the next cell.
  stored.read_1 = 'a\nb';
  const later = await createRegistry().dispatch(
    'python', { code: 'len(read_1.splitlines())' }, { cwd: process.cwd(), session, ui: {} },
  );
  assert.match(later.output, /2/, 'new handles must reach an already-running kernel');

  shutdownKernels();
});

test('the tool is withheld when there is no interpreter', async () => {
  // Offering a tool that cannot run teaches the model to call something that
  // always fails. Registry availability checks exist for exactly this.
  const { createRegistry } = await import('../src/tools/index.js');
  const offered = (await createRegistry().available()).map((t) => t.name);
  assert.equal(offered.includes('python'), !!python);
});

/** A registry plus a permission manager that records what it was asked. */
async function harness({ answer = async () => 'allow' } = {}) {
  const { createRegistry } = await import('../src/tools/index.js');
  const { PermissionManager } = await import('../src/agent/permission.js');
  const asked = [];
  const registry = createRegistry();
  const permissions = new PermissionManager({
    ask: async (request) => { asked.push(request.tool.name); return answer(request); },
  });
  const session = { id: `t${asked.length}-${Math.random()}`, listResults: () => [], getResult: () => null };
  return {
    asked,
    run: (code) => registry.dispatch('python', { code }, {
      cwd: process.cwd(), session, ui: {}, registry, permissions,
    }),
  };
}

test('a tool can be called as a function and its output used', needsPython, async () => {
  const { run } = await harness();
  const result = await run("text = read_file(path='package.json')\n'\"name\"' in text");
  assert.match(result.output, /True/);
  shutdownKernels();
});

test('one cell can drive many tool calls', needsPython, async () => {
  // The point of calling out rather than being fed in: a loop over results
  // costs one model round-trip instead of one per file.
  const { run } = await harness();
  const result = await run(
    "names = ['package.json', 'README.md']\n"
    + 'sizes = [len(read_file(path=n)) for n in names]\n'
    + 'len(sizes)',
  );
  assert.match(result.output, /2/);
  shutdownKernels();
});

test('a gated tool called from Python still asks', needsPython, async () => {
  // Approving the scratchpad must not approve everything the scratchpad can
  // reach, or the permission gate is simply routed around.
  const { run, asked } = await harness({ answer: async () => 'deny' });
  const result = await run("edit_file(path='README.md', old_string='a', new_string='b')");
  assert.equal(result.isError, true);
  assert.match(result.output, /declined/);
  assert.ok(asked.includes('edit_file'), 'the user must have been asked');
  shutdownKernels();
});

test('a safe tool called from Python does not ask', needsPython, async () => {
  const { run, asked } = await harness();
  await run("read_file(path='package.json')");
  assert.equal(asked.includes('read_file'), false);
  shutdownKernels();
});

test('a failing tool raises a catchable ToolError', needsPython, async () => {
  // A tool failure is information, not a dead cell — the code around it should
  // be able to decide what to do.
  const { run } = await harness();
  const result = await run(
    'try:\n'
    + "    read_file(path='does-not-exist.txt')\n"
    + '    caught = None\n'
    + 'except ToolError as e:\n'
    + '    caught = str(e)\n'
    + 'caught',
  );
  assert.match(result.output, /File not found/);
  assert.equal(result.isError, false, 'the cell handled it, so the cell succeeded');
  shutdownKernels();
});

test('python cannot call itself', needsPython, async () => {
  // Recursion through the bridge would deadlock: the kernel is single-threaded
  // and the outer cell is blocked waiting for the inner one.
  const { run } = await harness();
  const result = await run("python(code='1')");
  assert.equal(result.isError, true);
  assert.match(result.output, /NameError|cannot be called/);
  shutdownKernels();
});

test('installed tools are not reported as the agent\'s variables', needsPython, async () => {
  // Ten function names after every cell is noise; what matters is what this
  // cell left for the next one.
  const { run } = await harness();
  const result = await run('kept = 1');
  assert.match(result.output, /\[variables: kept\]/);
  assert.doesNotMatch(result.output, /read_file/);
  shutdownKernels();
});
