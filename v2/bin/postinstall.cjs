#!/usr/bin/env node
/*
 * Post-install hint.
 *
 * Deliberately does no work: no hardware probing, no network access, no writes.
 * An install that starts downloading gigabytes or shelling out to `nvidia-smi`
 * is hostile, and npm runs this in contexts — CI, Docker builds, dependency
 * installs — where none of that is wanted. It only points at `cloi setup`,
 * which does the real thing on request.
 */

if (process.env.CI || process.env.CLOI_SKIP_POSTINSTALL) process.exit(0);

const ESC = String.fromCharCode(27);
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;

process.stdout.write([
  '',
  `  ${bold('cloi')} installed.`,
  '',
  `  Run ${bold('cloi setup')} to measure this machine and pick models that fit it.`,
  dim('  It suggests a primary model and a stronger fallback, then downloads them.'),
  '',
  dim('  Requires Ollama — https://ollama.com'),
  '',
].join('\n') + '\n');
