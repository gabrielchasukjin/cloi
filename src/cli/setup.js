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
import { detectHardware, describeHardware, formatGB } from '../util/hardware.js';
import { recommendModels, configFor, modelsToPull, CATALOG } from '../util/recommend.js';
import { saveConfig, loadConfig } from '../config.js';
import * as ollama from '../provider/ollama.js';
import { theme, getReadline } from '../ui/terminal.js';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.interactive] Prompt before downloading.
 * @param {boolean} [opts.standalone] False when a session banner follows, which
 *   already states the model and makes a summary line redundant.
 * @returns {Promise<number>} Exit code.
 */
export async function runSetup({ interactive = true, standalone = true } = {}) {
  const hw = detectHardware();
  const recommendation = recommendModels(hw);
  const { primary, escalation, warnings } = recommendation;

  stdout.write(`\n  ${theme.dim(describeHardware(hw))}\n`);
  stdout.write(
    `  ${theme.brand(primary.name)}${escalation ? ` ${theme.dim('→')} ${theme.brand(escalation.name)}` : ''}`
    + `  ${theme.dim(`${primary.diskGB}${escalation ? ` + ${escalation.diskGB}` : ''} GB`)}\n`,
  );

  // Only what is actionable. "It fits" is good news, and good news does not
  // need a line — the previous version explained every choice at length, which
  // made the one warning that mattered indistinguishable from the rest.
  if (!hw.vramMB) {
    stdout.write(`  ${theme.warn('!')} ${theme.dim('No GPU detected — generation runs on CPU and will be slow.')}\n`);
  }
  for (const warning of warnings) stdout.write(`  ${theme.warn('!')} ${theme.dim(warning)}\n`);
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

  // Already-installed models are not reported. A list of ticks confirming that
  // nothing needs doing is the definition of noise.
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
    const measured = await verifyPlacement(patch.model);

    if (measured) {
      const pct = Math.round(measured.residency * 100);
      // Reported only when it is not the expected outcome: a model sitting
      // fully on the GPU is what should happen, and does not need announcing.
      if (measured.residency < 0.4) {
        const smaller = smallerThan(recommendation.primary);
        if (smaller) {
          stdout.write(`  ${theme.warn('!')} ${theme.dim(`only ${pct}% fits on the GPU — using ${smaller.name} instead`)}\n`);
          saveConfig({ model: smaller.name });
          patch.model = smaller.name;
        } else {
          stdout.write(`  ${theme.warn('!')} ${theme.dim(`only ${pct}% fits on the GPU; nothing smaller is available`)}\n`);
        }
      } else if (measured.residency < 0.95) {
        stdout.write(`  ${theme.dim(`${pct}% on GPU`)}\n`);
      }
    }
  }

  if (failed.length) {
    stdout.write(theme.warn(`  ${failed.length} download${failed.length === 1 ? '' : 's'} failed. Your choice is saved; retry with:\n`));
    for (const f of failed) stdout.write(theme.dim(`    ollama pull ${f.name}\n`));
    stdout.write('\n');
  }

  // No completion box. The banner that follows already states the model, the
  // fallback and the context — and the old box also said "run `cloi` to start"
  // immediately before cloi started, which simply was not true.
  if (standalone) {
    stdout.write(`  ${theme.ok('ready')} ${theme.dim(`· ${patch.model}${patch.escalationModel ? ` → ${patch.escalationModel}` : ''} · ${Math.round(patch.contextLength / 1024)}k`)}\n\n`);
  }

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
