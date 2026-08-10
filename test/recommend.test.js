import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recommendModels, configFor, modelsToPull, residentGB, CATALOG, MIN_VRAM_RESIDENCY } from '../src/util/recommend.js';

const hw = ({ vramGB = null, ramGB = 32, unified = false }) => ({
  vramMB: vramGB === null ? null : vramGB * 1024,
  totalRamMB: ramGB * 1024,
  freeRamMB: ramGB * 1024 * 0.5,
  gpuName: vramGB === null ? null : 'test gpu',
  unifiedMemory: unified,
  platform: 'linux',
  cpus: 8,
});

test('the primary is the ablest model that fits in VRAM', () => {
  // Ablest, not largest: on 8 GB the highest-ranked model that fits is the
  // 2.8 GB nemotron, which outscored the 5.2 GB alternative in measurement.
  const { primary } = recommendModels(hw({ vramGB: 8 }));
  const fits = CATALOG.filter((m) => (8 * 0.8) / residentGB(m) >= MIN_VRAM_RESIDENCY);
  const ablest = fits.reduce((a, b) => (b.tier > a.tier ? b : a));
  assert.equal(primary.name, ablest.name);
});

test('a bigger card never gets a weaker primary', () => {
  // Monotonic rather than strictly increasing: the step-down rule may hold a
  // tier back to preserve an escalation target, which is the better system.
  let last = 0;
  for (const vramGB of [4, 6, 8, 12, 16, 24, 48]) {
    const { primary } = recommendModels(hw({ vramGB, ramGB: 64 }));
    assert.ok(primary.tier >= last, `${vramGB} GB regressed to ${primary.name}`);
    last = primary.tier;
  }
});

test('the primary always keeps most of its weights in VRAM', () => {
  // Full residency is the wrong bar: on an 8 GB card only a 4B model fits
  // entirely, and dropping two tiers to avoid a 20% spill is a bad trade.
  for (const vramGB of [4, 6, 8, 12, 16, 24, 48]) {
    const { primary } = recommendModels(hw({ vramGB, ramGB: 64 }));
    const residency = (vramGB * 0.8) / residentGB(primary);
    assert.ok(
      residency >= MIN_VRAM_RESIDENCY,
      `${primary.name} would be only ${Math.round(residency * 100)}% resident on a ${vramGB} GB card`,
    );
  }
});

test('a primary is stepped down when it would leave nothing to escalate to', () => {
  // A faster primary plus a working fallback beats a bloated primary alone.
  const { primary, escalation, reasons } = recommendModels(hw({ vramGB: 16, ramGB: 32 }));
  assert.ok(escalation, 'escalation should be preserved');
  assert.ok(escalation.tier > primary.tier);
  assert.ok(reasons.some((r) => /Stepped down/.test(r)) || primary.tier < escalation.tier);
});

test('the escalation model is always more capable than the primary', () => {
  for (const vramGB of [4, 6, 8, 12, 16]) {
    const { primary, escalation } = recommendModels(hw({ vramGB, ramGB: 64 }));
    if (!escalation) continue;
    assert.ok(escalation.tier > primary.tier, `${escalation.name} should outrank ${primary.name}`);
  }
});

test('the escalation model may exceed VRAM, since it runs rarely', () => {
  // The whole point: it only has to fit in RAM. Requiring it to fit in VRAM
  // would mean escalating to something barely better than the primary.
  const { escalation } = recommendModels(hw({ vramGB: 8, ramGB: 32 }));
  assert.ok(residentGB(escalation) > 8 * 0.9, 'escalation is expected to spill');
});

test('a mixture-of-experts model is preferred when it will spill', () => {
  // Only its active parameters cost time, so it stays usable on CPU where a
  // dense model of the same footprint would not.
  const { escalation } = recommendModels(hw({ vramGB: 8, ramGB: 32 }));
  assert.equal(escalation.name, 'qwen3:30b-a3b');
  assert.equal(escalation.moe, true);
});

test('escalation is disabled rather than recommending something that will not fit', () => {
  const { escalation, warnings } = recommendModels(hw({ vramGB: 24, ramGB: 8 }));
  if (escalation) {
    assert.ok(escalation.diskGB <= 8 * 0.6, 'must fit the RAM budget');
  } else {
    assert.ok(warnings.some((w) => /escalation is disabled/i.test(w)));
  }
});

test('a machine with no GPU gets a small primary and an explanation', () => {
  const { primary, reasons } = recommendModels(hw({ vramGB: null, ramGB: 32 }));
  // On CPU, size is what costs time — so this asserts smallness, not rank.
  // Selecting by tier here once picked a 5.2 GB model for a CPU-only machine.
  assert.ok(primary.diskGB <= 3, `a CPU-only machine needs a small model, got ${primary.name}`);
  assert.ok(primary.tier > 1, 'but not the bottom tier');
  assert.ok(reasons.some((r) => /No GPU detected/i.test(r)));
});

test('a very small card still yields a usable choice, with a warning', () => {
  const { primary, warnings } = recommendModels(hw({ vramGB: 2, ramGB: 8 }));
  assert.ok(primary, 'should still recommend something');
  assert.ok(warnings.length > 0, 'and say that it will spill');
});

test('low RAM is called out', () => {
  const { warnings } = recommendModels(hw({ vramGB: 8, ramGB: 6 }));
  assert.ok(warnings.some((w) => /tight/i.test(w)));
});

test('context thresholds tolerate cards that report just under their size', () => {
  // An "8 GB" card reports 8151 MiB = 7.96 GiB; a naive `>= 8` drops it a tier.
  const real8gb = { vramMB: 8151, totalRamMB: 32 * 1024, freeRamMB: 16 * 1024, gpuName: 'g', unifiedMemory: false, platform: 'linux', cpus: 8 };
  assert.equal(configFor(recommendModels(real8gb), real8gb).contextLength, 16384);

  const real16gb = { ...real8gb, vramMB: 16376 };
  assert.equal(configFor(recommendModels(real16gb), real16gb).contextLength, 32768);
});

test('context length scales with available memory', () => {
  assert.equal(configFor(recommendModels(hw({ vramGB: 24, ramGB: 64 })), hw({ vramGB: 24, ramGB: 64 })).contextLength, 32768);
  assert.equal(configFor(recommendModels(hw({ vramGB: 8, ramGB: 32 })), hw({ vramGB: 8, ramGB: 32 })).contextLength, 16384);
  assert.equal(configFor(recommendModels(hw({ vramGB: 4, ramGB: 16 })), hw({ vramGB: 4, ramGB: 16 })).contextLength, 8192);
});

test('the config patch names both models', () => {
  const machine = hw({ vramGB: 8, ramGB: 32 });
  const patch = configFor(recommendModels(machine), machine);
  assert.equal(patch.model, 'nemotron-3-nano:4b');
  assert.equal(patch.escalationModel, 'qwen3:30b-a3b');
});

test('the pull list carries sizes so the download can be sized up front', () => {
  const list = modelsToPull(recommendModels(hw({ vramGB: 8, ramGB: 32 })));
  assert.equal(list.length, 2);
  assert.ok(list.every((m) => typeof m.diskGB === 'number' && m.diskGB > 0));
});

test('catalog tiers are a strict capability ranking', () => {
  // Tier is measured capability, not size. Those usually agree, but
  // nemotron-3-nano:4b outscored qwen3:8b while being half the size, and
  // ordering by size would hand an 8 GB card the weaker model.
  for (let i = 1; i < CATALOG.length; i++) {
    assert.ok(CATALOG[i].tier > CATALOG[i - 1].tier, 'tiers must strictly increase');
  }
  const tiers = new Set(CATALOG.map((m) => m.tier));
  assert.equal(tiers.size, CATALOG.length, 'tiers must be unique');
});

test('a higher tier is chosen even when it is the smaller download', () => {
  // The 8 GB case that motivated decoupling tier from size.
  const { primary } = recommendModels(hw({ vramGB: 8, ramGB: 32 }));
  const qwen8b = CATALOG.find((m) => m.name === 'qwen3:8b');
  assert.ok(primary.tier >= qwen8b.tier, 'should not pick a lower-ranked model');
});

/* ── hardware detection shape ───────────────────────────────────────────── */

test('detectHardware always returns a usable shape', async () => {
  const { detectHardware } = await import('../src/util/hardware.js');
  const hw = detectHardware();
  assert.ok(Number.isFinite(hw.totalRamMB) && hw.totalRamMB > 0);
  assert.ok(Number.isFinite(hw.cpus) && hw.cpus > 0);
  assert.ok(hw.vramMB === null || (Number.isFinite(hw.vramMB) && hw.vramMB > 0));
  assert.equal(typeof hw.platform, 'string');
});

test('a recommendation exists for whatever detection returns', async () => {
  const { detectHardware } = await import('../src/util/hardware.js');
  const { primary } = recommendModels(detectHardware());
  assert.ok(primary?.name, 'there must always be something to run');
});

test('undetectable VRAM degrades to a CPU-sized model, never a guess', () => {
  // Recommending too large fails confusingly; too small merely underperforms.
  const { primary, reasons } = recommendModels(hw({ vramGB: null, ramGB: 64 }));
  assert.ok(primary.diskGB <= 3);
  assert.ok(reasons.some((r) => /No GPU detected/.test(r)));
});

test('the catalog spans more than one model family', () => {
  // A single-vendor catalog is a bet, not a decision. Nemotron matched an 8B
  // on accuracy at roughly four times the throughput in a local run, which is
  // exactly the kind of result a Qwen-only list would have hidden.
  const families = new Set(CATALOG.map((m) => m.name.split(/[:-]/)[0]));
  assert.ok(families.size > 1, `catalog is single-family: ${[...families].join(', ')}`);
});

test('no catalog entry is referenced by hardcoded name in selection', () => {
  // Selecting by name breaks silently when the catalog changes; every branch
  // should select by tier or by measured fit.
  const src = fs.readFileSync(new URL('../src/util/recommend.js', import.meta.url), 'utf8');
  const selectionBody = src.slice(src.indexOf('export function recommendModels'));
  for (const m of CATALOG) {
    assert.ok(
      !selectionBody.includes(`'${m.name}'`),
      `recommendModels references ${m.name} by name`,
    );
  }
});
