import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCall, summarizeResult, toolLine, shortPath, BOX } from '../src/ui/terminal.js';

/** Colour codes make assertions unreadable; the layout is what is under test. */
const strip = (s) => s.replace(/\[[0-9;]*m/g, '');

test('boxes have square corners', () => {
  // Rounded borders read as decoration rather than structure.
  assert.equal(BOX.borderStyle, 'single');
});

test('a call is described by verb and its identifying argument', () => {
  assert.equal(describeCall('read_file', { path: 'src/a.js' }), 'read src/a.js');
  assert.equal(describeCall('list_dir', {}), 'ls .');
  assert.equal(describeCall('grep', { pattern: 'foo', path: 'src' }), 'grep /foo/ in src');
  assert.equal(describeCall('run_command', { command: 'npm test' }), 'run npm test');
});

test('grep shows the glob filter, which changes the result', () => {
  // Hiding it once made "0 files searched" look like a bug in grep.
  assert.match(describeCall('grep', { pattern: 'x', glob: '*.py' }), /\(\*\.py\)/);
});

test('command results read the same whether they passed or failed', () => {
  assert.equal(strip(summarizeResult('run_command', { output: 'Exit code 0\nfine' })), 'exit 0');
  assert.equal(strip(summarizeResult('run_command', { output: 'Exit code 1\nboom', isError: true })), 'exit 1');
});

test('a timeout says so rather than reporting a code', () => {
  const out = summarizeResult('run_command', { output: 'Command timed out after 120s', isError: true });
  assert.equal(strip(out), 'timed out');
});

test('results are counts, not echoes of the argument', () => {
  // `ls src` reporting "src" told the reader nothing they had not just read.
  assert.equal(strip(summarizeResult('list_dir', { output: 'src\n  a.js\n  b.js' })), '2 entries');
  assert.equal(strip(summarizeResult('read_file', { output: 'a.js (lines 1-9 of 9)\nx' })), '9 lines');
  assert.equal(strip(summarizeResult('grep', { output: '3 matches for /x/:\na\nb\nc' })), '3 matches');
  assert.equal(strip(summarizeResult('glob', { output: 'No files matched *.py.' })), 'none');
  assert.equal(strip(summarizeResult('edit_file', { output: 'Edited a.js (1 replacement).' })), '1 change');
});

test('one tool call renders as one aligned line', () => {
  const line = strip(toolLine(
    'read_file',
    { path: 'src/lib/stats.js' },
    { output: 'src/lib/stats.js (lines 1-20 of 20)\nx' },
  ));
  assert.equal(line.split('\n').length, 1, 'a call must not cost two lines');
  assert.match(line, /^ {2}. read src\/lib\/stats\.js\s+20 lines$/);
});

test('failed calls are marked in the gutter', () => {
  const line = strip(toolLine('run_command', { command: 'npm test' }, { output: 'Exit code 1', isError: true }));
  assert.match(line, /^ {2}✗/);
});

test('results align to the same column regardless of call length', () => {
  const short = strip(toolLine('list_dir', { path: 'a' }, { output: 'a\n  x' }));
  const long = strip(toolLine('read_file', { path: 'src/lib/stats.js' }, { output: 'f (lines 1-9 of 9)\nx' }));
  const column = (line) => line.length - line.trimEnd().split(/\s{2,}/).pop().length;
  assert.equal(column(short), column(long), 'result column must not move');
});

test('paths under home are shown relative to it', () => {
  const home = process.env.HOME || process.env.USERPROFILE;
  assert.match(shortPath(`${home}/projects/thing`), /^~\/projects\/thing$/);
});

test('a permission prompt with no one to answer declines', async () => {
  // Piping a prompt into cloi closes stdin, and asking for approval then hung
  // forever or threw ERR_USE_AFTER_CLOSE part-way through an edit.
  //
  // Run as a child process: the test runner keeps its own stdin open, so EOF
  // cannot be reached in-process.
  const { execFileSync } = await import('node:child_process');
  // Resolved from this file, not from cwd, so the test does not depend on
  // where the runner was invoked.
  const target = new URL('../src/ui/terminal.js', import.meta.url).href;
  const probe = `
    const t = await import(${JSON.stringify(target)});
    const timer = setTimeout(() => { console.log('HUNG'); process.exit(0); }, 4000);
    console.log(await t.askPermission({ tool: { name: 'run_command' }, summary: 'run: rm -rf /' }));
    clearTimeout(timer);
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  assert.match(out, /deny/, 'silence must not be consent');
  assert.doesNotMatch(out, /HUNG/, 'a closed stdin must not block the turn');
});

/** Capture what a renderer writes to stdout. */
function captured(fn) {
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { process.stdout.write = write; }
  return strip(chunks.join(''));
}

test('the active model is named once on startup, not twice', async () => {
  // The banner and the rule above the prompt sit four lines apart; printing the
  // model in both put it on screen twice before the user had typed anything.
  const { banner, promptRule } = await import('../src/ui/terminal.js');
  const out = captured(() => {
    banner({ model: 'qwen3:8b', escalationModel: 'qwen3:30b-a3b', cwd: process.cwd() });
    promptRule({ model: 'qwen3:8b' });
  });
  assert.equal(out.split('qwen3:8b').length - 1, 1, `named ${out.split('qwen3:8b').length - 1} times`);
});

test('startup says what the fallback model is for', async () => {
  // "→ qwen3:30b-a3b (harder work)" left the reader to decode the arrow.
  const { banner } = await import('../src/ui/terminal.js');
  const out = captured(() => banner({ model: 'a', escalationModel: 'qwen3:30b-a3b', cwd: process.cwd() }));
  assert.match(out, /escalates to qwen3:30b-a3b when it gets stuck/);
});

test('a machine with no fallback gets no fallback line', async () => {
  const { banner } = await import('../src/ui/terminal.js');
  const out = captured(() => banner({ model: 'a', escalationModel: null, cwd: process.cwd() }));
  assert.doesNotMatch(out, /escalates/);
});

test('a ranged read reports what came back, not the size of the file', () => {
  // Six successive 20-line reads all reported "591 lines", so a model crawling
  // a file looked like it was reading the same thing over and over.
  const chunk = summarizeResult('read_file', { output: 'README.md (lines 51-70 of 591)\n…' });
  assert.equal(strip(chunk), '20 of 591 lines');
  const whole = summarizeResult('read_file', { output: 'README.md (lines 1-591 of 591)\n…' });
  assert.equal(strip(whole), '591 lines');
});

test('a prompt for input silences the spinner first', async () => {
  // The spinner repaints its line every 90ms. A question drawn under a running
  // one is erased before it can be read: the interface showed "thinking 63s"
  // while it was actually waiting for a keypress.
  const { createSpinner, suspendSpinner } = await import('../src/ui/terminal.js');
  const spinner = createSpinner('thinking');
  spinner.start();
  assert.equal(spinner.active, true);
  suspendSpinner();
  assert.equal(spinner.active, false, 'a spinner must not paint over a prompt');
});

test('the spinner never writes wider than the terminal', async () => {
  // clearLine erases one row. A spinner that wraps strands its overflow on the
  // row above for the rest of the session.
  const { createSpinner } = await import('../src/ui/terminal.js');
  const chunks = [];
  const write = process.stdout.write;
  const isTTY = process.stdout.isTTY;
  const columns = process.stdout.columns;
  process.stdout.isTTY = true;
  process.stdout.columns = 40;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    const spinner = createSpinner('read ' + 'a/very/long/path'.repeat(10));
    spinner.start();
    spinner.stop();
  } finally {
    process.stdout.write = write;
    process.stdout.isTTY = isTTY;
    process.stdout.columns = columns;
  }
  const painted = strip(chunks.join('')).replace(/\[[0-9]*[A-Z]/g, '');
  assert.ok(painted.length <= 40, `spinner painted ${painted.length} cols into 40`);
});

test('review does not paint over the end of the answer', async () => {
  // onJudging fires before onAssistantDone, so the streamed line is still open.
  // Starting the spinner without closing it repainted the answer's last row:
  // "Startup f  ⠦ reviewing against the evidence".
  const src = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../src/cli/repl.js', import.meta.url), 'utf8'));
  const handler = src.slice(src.indexOf('onJudging('), src.indexOf('onVerificationFailed('));
  assert.match(handler, /stopSpinner\(\)[\s\S]*spinner\.start/, 'onJudging must close the line first');
});

test('the elapsed count starts when the spinner does, not when it last ran', async () => {
  // start() with no label left the clock at its previous value, so the count
  // included the time the spinner was stopped — the seconds you spent typing.
  // A turn began at "18s".
  const { createSpinner } = await import('../src/ui/terminal.js');
  const isTTY = process.stdout.isTTY;
  const write = process.stdout.write;
  process.stdout.isTTY = true;
  process.stdout.clearLine = () => true;
  process.stdout.cursorTo = () => true;

  const spinner = createSpinner('thinking');
  spinner.start('thinking');
  spinner.stop();
  await new Promise((r) => setTimeout(r, 1100));

  const painted = [];
  process.stdout.write = (c) => { painted.push(String(c)); return true; };
  try {
    spinner.start();
  } finally {
    process.stdout.write = write;
    spinner.stop();
    process.stdout.isTTY = isTTY;
  }
  assert.doesNotMatch(strip(painted.join('')), /\d+s/, 'a fresh spinner must start at zero');
});

test('a capped search renders as a floor, not a total', () => {
  assert.equal(strip(summarizeResult('grep', { output: '100+ matches for /x/:\na' })), '100+ matches');
  assert.equal(strip(summarizeResult('grep', { output: '3 matches for /x/:\na' })), '3 matches');
  assert.equal(strip(summarizeResult('grep', { output: '1 match for /x/:\na' })), '1 match');
});
