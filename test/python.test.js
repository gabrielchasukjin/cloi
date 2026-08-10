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

/** A snapshot path in a directory nothing else touches. */
async function snapshotPath() {
  const fsp = await import('node:fs');
  const osp = await import('node:os');
  const pathp = await import('node:path');
  const dir = fsp.mkdtempSync(pathp.join(osp.tmpdir(), 'cloi-snap-'));
  return pathp.join(dir, 'ns.pickle');
}

test('variables survive a new process', needsPython, async () => {
  // The kernel dies with its process; the namespace should not.
  const snap = await snapshotPath();
  const first = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  await first.exec('counts = {"a": 1, "b": 2}');
  await first.snapshot();
  first.kill();

  const second = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  try {
    assert.equal((await second.exec('counts["a"] + counts["b"]')).value, '3');
  } finally {
    second.kill();
  }
});

test('imports and definitions come back too', needsPython, async () => {
  // pickle stores a function by reference, so a helper written in a cell cannot
  // be serialised — and a helper the agent wrote is exactly what is worth
  // keeping. Its source is replayed instead. Modules likewise: the name is
  // enough to import them again.
  const snap = await snapshotPath();
  const first = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  await first.exec('import json');
  await first.exec('def rate(done, total):\n    return round(done / total, 2)');
  await first.exec('class Row:\n    def __init__(self, n):\n        self.n = n');
  await first.snapshot();
  first.kill();

  const second = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  try {
    assert.equal((await second.exec('json.dumps([1])')).value, "'[1]'");
    assert.equal((await second.exec('rate(3, 4)')).value, '0.75');
    assert.equal((await second.exec('Row(7).n')).value, '7');
  } finally {
    second.kill();
  }
});

test('one unsaveable variable does not cost the others', needsPython, async () => {
  // Per-variable, not the whole namespace at once: an open file would otherwise
  // take every other variable down with it.
  const snap = await snapshotPath();
  const kernel = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  try {
    await kernel.exec('kept = [1, 2, 3]\nhandle = open("package.json")');
    const saved = await kernel.snapshot();
    assert.ok(saved.saved.includes('kept'));
    assert.ok(saved.skipped.some((s) => s.name === 'handle'), 'and the loss is reported');
    // A name must not be reported as saved and skipped at once.
    const both = saved.saved.filter((n) => saved.skipped.some((s) => s.name === n));
    assert.deepEqual(both, []);
  } finally {
    kernel.kill();
  }
});

test('a name rebound to a value is restored as that value', needsPython, async () => {
  // `rate = 5` after `def rate(...)` is a number now, and replaying the old
  // definition over it would silently resurrect the function.
  const snap = await snapshotPath();
  const first = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  await first.exec('def thing():\n    return 1');
  await first.exec('thing = 99');
  await first.snapshot();
  first.kill();

  const second = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  try {
    assert.equal((await second.exec('thing')).value, '99');
  } finally {
    second.kill();
  }
});

test('a corrupt snapshot does not stop the kernel starting', needsPython, async () => {
  // Losing variables is a nuisance; refusing to start is a broken session.
  const fsp = await import('node:fs');
  const snap = await snapshotPath();
  fsp.writeFileSync(snap, 'not a pickle at all');

  const kernel = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  try {
    assert.equal((await kernel.exec('1 + 1')).value, '2');
  } finally {
    kernel.kill();
  }
});

test('a missing snapshot is simply an empty namespace', needsPython, async () => {
  const snap = await snapshotPath();
  const kernel = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  try {
    assert.equal((await kernel.exec('2 + 2')).value, '4');
    assert.equal(kernel.takeRestoreNotice(), null, 'nothing to report on a first run');
  } finally {
    kernel.kill();
  }
});

test('what was restored is reported once, not every cell', needsPython, async () => {
  // The agent needs to know its variables came back, or it redefines them —
  // and repeating it after every cell would be noise.
  const snap = await snapshotPath();
  const first = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  await first.exec('saved_value = 5');
  await first.snapshot();
  first.kill();

  const second = new PythonKernel({ cwd: process.cwd(), snapshotPath: snap });
  try {
    await second.exec('saved_value');
    assert.match(second.takeRestoreNotice(), /restored from the last session: saved_value/);
    assert.equal(second.takeRestoreNotice(), null, 'reported once');
  } finally {
    second.kill();
  }
});

test('the description carries worked examples, not just prose', async () => {
  // Measured: with these, nemotron-3-nano:4b reached for the kernel 8/8 runs
  // and answered 3/8; without them, 0/8 and 0/8. A small model will not infer
  // an API from a sentence.
  const { createRegistry } = await import('../src/tools/index.js');
  const description = createRegistry().get('python').description;

  assert.match(description, /^Examples:$/m);
  // Each example must show something the prose cannot.
  assert.match(description, /read_1\.splitlines\(\)/, 'a stored handle in use');
  assert.match(description, /read_file\(path=f\)/, 'a tool called inside a loop');
  assert.match(description, /except ToolError/, 'a failure being handled');
  assert.match(description, /keyword arguments only/, 'the calling convention');
  assert.match(description, /run_command, so they run in the project/, 'what not to use it for');
});
