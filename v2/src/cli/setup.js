/**
 * First-run setup.
 *
 * Picking a model is the one decision a new user cannot make well: it depends
 * on VRAM, on system RAM, on whether the model supports tool calling at all,
 * and on the difference between a model that fits and one that spills. Guessing
 * wrong produces an agent that looks broken rather than one that looks slow.
 *
 * So this measures the machine and proposes both models, explains why, and
 * downloads them on request. Nothing is pulled without a yes.
 */

import { stdout } from 'node:process';
import chalk from 'chalk';
import boxen from 'boxen';
import { detectHardware, describeHardware, formatGB } from '../util/hardware.js';
import { recommendModels, configFor, modelsToPull, CATALOG } from '../util/recommend.js';
import { saveConfig, loadConfig } from '../config.js';
import * as ollama from '../provider/ollama.js';
import { theme, getReadline } from '../ui/terminal.js';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.interactive] Prompt before downloading.
 * @returns {Promise<number>} Exit code.
 */
export async function runSetup({ interactive = true } = {}) {
  stdout.write(boxen(
    `${theme.brand('Cloi setup')}\n\n${theme.dim('Choosing models that fit this machine.')}`,
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'gray' },
  ) + '\n\n');

  const hw = detectHardware();
  stdout.write(`  ${theme.dim('hardware')}  ${describeHardware(hw)}\n`);

  if (!hw.vramMB) {
    stdout.write(`  ${theme.warn('note')}      No GPU detected — generation will run on CPU and be slow.\n`);
  }
  stdout.write('\n');

  const recommendation = recommendModels(hw);
  const { primary, escalation, reasons, warnings } = recommendation;

  stdout.write(`  ${theme.dim('primary')}   ${theme.brand(primary.name)}  ${theme.dim(`${primary.diskGB} GB · ${primary.note}`)}\n`);
  if (escalation) {
    stdout.write(`  ${theme.dim('fallback')}  ${theme.brand(escalation.name)}  ${theme.dim(`${escalation.diskGB} GB · ${escalation.note}`)}\n`);
  } else {
    stdout.write(`  ${theme.dim('fallback')}  ${theme.dim('(none — escalation disabled)')}\n`);
  }
  stdout.write('\n');

  for (const reason of reasons) stdout.write(`  ${theme.dim('·')} ${theme.dim(reason)}\n`);
  for (const warning of warnings) stdout.write(`  ${theme.warn('!')} ${theme.warn(warning)}\n`);
  stdout.write('\n');

  // Ollama has to be up before anything can be pulled or checked.
  if (!(await ollama.isReachable())) {
    stdout.write(theme.err(`  Ollama is not running at ${loadConfig().host}.\n`));
    stdout.write(`  Start it with ${chalk.bold('ollama serve')}, then run ${chalk.bold('cloi setup')} again.\n\n`);
    return 1;
  }

  const installed = await ollama.listModels().catch(() => []);
  const wanted = modelsToPull(recommendation);
  const missing = wanted.filter((m) => !installed.includes(m.name));
  const failed = [];

  for (const m of wanted) {
    const mark = installed.includes(m.name) ? theme.ok('✓ installed') : theme.dim('not installed');
    stdout.write(`  ${m.name.padEnd(16)} ${mark}\n`);
  }
  stdout.write('\n');

  if (missing.length) {
    const totalGB = missing.reduce((sum, m) => sum + m.diskGB, 0);
    stdout.write(`  ${missing.length} model${missing.length === 1 ? '' : 's'} to download, ${totalGB.toFixed(1)} GB total.\n\n`);

    let proceed = !interactive;
    if (interactive) {
      const answer = (await getReadline().question(`  ${theme.dim('Download now? [Y/n]')} › `)).trim().toLowerCase();
      proceed = answer === '' || answer === 'y' || answer === 'yes';
      stdout.write('\n');
    }

    if (proceed) {
      for (const m of missing) {
        stdout.write(`  ${theme.dim(`pulling ${m.name} (${m.diskGB} GB)…`)}\n`);
        const result = await pull(m.name);
        if (result.ok) {
          stdout.write(`  ${theme.ok('✓')} ${m.name}\n`);
        } else {
          // A failed download must not discard the choice: the recommendation
          // is still correct, and the config is what records it. Losing it
          // would leave the user with no model configured at all.
          failed.push({ name: m.name, error: result.error });
          stdout.write(`  ${theme.err('✗')} ${m.name} ${theme.dim(result.error || '')}\n`);
        }
      }
      stdout.write('\n');
    } else {
      stdout.write(theme.dim('  Skipped. Pull them later with:\n'));
      for (const m of missing) stdout.write(theme.dim(`    ollama pull ${m.name}\n`));
      stdout.write('\n');
      // Config is still written: the choice is recorded even if the download is not.
    }
  }

  const patch = configFor(recommendation, hw);
  saveConfig(patch);

  // Verify the prediction against what Ollama actually did. Our probes read the
  // card; this reads the outcome — and Ollama's own GPU detection covers
  // hardware the probes cannot, so this is the check that makes the
  // recommendation trustworthy on a machine nobody has tested.
  if (!failed.length && installedAfter(installed, failed).includes(patch.model)) {
    stdout.write(theme.dim('  Checking how much of it actually lands on the GPU…\n'));
    const measured = await verifyPlacement(patch.model);

    if (measured) {
      const pct = Math.round(measured.residency * 100);
      const colour = pct >= 60 ? theme.ok : theme.warn;
      stdout.write(`  ${colour(`${pct}% of ${patch.model} is resident in VRAM`)}\n`);

      if (measured.residency < 0.4) {
        const smaller = smallerThan(recommendation.primary);
        if (smaller) {
          stdout.write(theme.warn(`  That is low enough to hurt. Switching the primary to ${smaller.name}.\n`));
          saveConfig({ model: smaller.name });
          patch.model = smaller.name;
        } else {
          stdout.write(theme.warn('  That is low, but nothing smaller is available.\n'));
        }
      }
      stdout.write('\n');
    }
  }

  if (failed.length) {
    stdout.write(theme.warn(`  ${failed.length} download${failed.length === 1 ? '' : 's'} failed. Your choice is saved; retry with:\n`));
    for (const f of failed) stdout.write(theme.dim(`    ollama pull ${f.name}\n`));
    stdout.write('\n');
  }

  stdout.write(boxen(
    [
      `${theme.ok('Setup complete.')}`,
      '',
      `${theme.dim('model          ')} ${patch.model}`,
      `${theme.dim('escalates to   ')} ${patch.escalationModel ?? '(disabled)'}`,
      `${theme.dim('context        ')} ${patch.contextLength.toLocaleString()} tokens`,
      '',
      theme.dim('Run `cloi` to start, or `cloi setup` to redo this.'),
    ].join('\n'),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'green' },
  ) + '\n\n');

  return 0;
}

/** Models present once the pulls that succeeded are counted. */
function installedAfter(installed, failed) {
  const failedNames = new Set(failed.map((f) => f.name));
  return [...installed, ...CATALOG.map((m) => m.name).filter((n) => !failedNames.has(n))];
}

/** The next model down from this one, for when the prediction was too generous. */
function smallerThan(model) {
  const below = CATALOG.filter((m) => m.tier < model.tier);
  return below[below.length - 1] || null;
}

/**
 * Load the model briefly and ask Ollama where it put it.
 *
 * A minimal generation is the only way to force placement; nothing else
 * populates `/api/ps`.
 */
async function verifyPlacement(model) {
  try {
    await ollama.chat({ model, messages: [{ role: 'user', content: 'hi' }], think: false });
    return await ollama.measureResidency(model);
  } catch {
    return null;
  }
}

/** Stream a pull over the HTTP API, redrawing only on whole-percent changes. */
async function pull(model) {
  let last = -1;
  const result = await ollama.pullModel(model, (pct) => {
    if (pct === last || !stdout.isTTY) return;
    last = pct;
    stdout.clearLine?.(0);
    stdout.cursorTo?.(0);
    stdout.write(`    ${theme.accent(`${pct}%`)}`);
  });
  if (stdout.isTTY) {
    stdout.clearLine?.(0);
    stdout.cursorTo?.(0);
  }
  return result;
}

/** Print the recommendation without touching config or the network. */
export function printRecommendationOnly() {
  const hw = detectHardware();
  const { primary, escalation } = recommendModels(hw);
  stdout.write(`\n  ${describeHardware(hw)}\n`);
  stdout.write(`  suggested: ${primary.name}${escalation ? ` → ${escalation.name}` : ''}\n`);
  stdout.write(`  run ${chalk.bold('cloi setup')} to install and configure\n\n`);
}

export { formatGB };
