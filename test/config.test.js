import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Migration runs once at load, and loadConfig caches — so each case needs its
 * own process to see a fresh read.
 */
function loadWith(saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloi-config-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(saved, null, 2));
  const target = new URL('../src/config.js', import.meta.url).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval',
    `const { loadConfig } = await import(${JSON.stringify(target)});
     process.stdout.write(JSON.stringify(loadConfig()));`,
  ], { env: { ...process.env, CLOI_DATA_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { config: JSON.parse(out), file: JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), dir };
}

test('a setting left at a superseded default follows the new one', () => {
  // Observed live: a config written before `think` became capability-based
  // still held `think: false`, which is the setting under which a reasoning
  // model streams its monologue into the answer. The fix reached new installs
  // only, so the bug persisted for everyone who already had cloi.
  const { config, file, dir } = loadWith({ model: 'm', think: false, judgeAnswers: true });
  assert.equal(config.think, null, 'think follows the model again');
  assert.equal(config.judgeAnswers, null, 'reviews are back to escalation-only');
  assert.ok(!('think' in file), 'and the stale value is removed from disk');
  assert.equal(file.configVersion, 2, 'so it migrates once, not every run');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a value the user actually changed is left alone', () => {
  // Only values still equal to the old default are dropped.
  const { config, dir } = loadWith({ model: 'm', think: true, judgeAnswers: false });
  assert.equal(config.think, true);
  assert.equal(config.judgeAnswers, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an already-migrated config is not touched again', () => {
  // Otherwise a deliberate `think: false` set after the migration would be
  // stripped on the next run, and every run after that.
  const { config, dir } = loadWith({ model: 'm', think: false, configVersion: 2 });
  assert.equal(config.think, false, 'a post-migration choice stands');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('everything else in the config survives migration', () => {
  const { config, file, dir } = loadWith({ model: 'custom:7b', escalationModel: 'big:30b', think: false, autoApprove: ['grep'] });
  assert.equal(config.model, 'custom:7b');
  assert.equal(config.escalationModel, 'big:30b');
  assert.deepEqual(config.autoApprove, ['grep']);
  assert.equal(file.model, 'custom:7b', 'and is still on disk');
  fs.rmSync(dir, { recursive: true, force: true });
});
