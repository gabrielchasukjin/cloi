import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendModels, configFor, modelsToPull, residentGB, CATALOG } from '../src/util/recommend.js';

const hw = ({ vramGB = null, ramGB = 32, unified = false }) => ({
  vramMB: vramGB === null ? null : vramGB * 1024,
  totalRamMB: ramGB * 1024,
  freeRamMB: ramGB * 1024 * 0.5,
  gpuName: vramGB === null ? null : 'test gpu',
  unifiedMemory: unified,
  platform: 'linux',
  cpus: 8,
});

test('the primary is the largest model that fits in VRAM', () => {
  // 8 GB card: qwen3:8b is 5.2 GB on disk, ~7.0 GB resident — the largest fit.
  const { primary } = recommendModels(hw({ vramGB: 8 }));
  assert.equal(primary.name, 'qwen3:8b');
});

test('a bigger card gets a bigger primary', () => {
  assert.equal(recommendModels(hw({ vramGB: 24, ramGB: 64 })).primary.name, 'qwen3:32b');
  assert.equal(recommendModels(hw({ vramGB: 16, ramGB: 32 })).primary.name, 'qwen3:14b');
  assert.equal(recommendModels(hw({ vramGB: 6, ramGB: 16 })).primary.name, 'qwen3:4b');
});

test('the primary never exceeds the VRAM budget', () => {
  for (const vramGB of [4, 6, 8, 12, 16, 24, 48]) {
    const { primary } = recommendModels(hw({ vramGB, ramGB: 64 }));
    assert.ok(
      residentGB(primary) <= vramGB * 0.9,
      `${primary.name} (${residentGB(primary).toFixed(1)} GB) should fit in ${vramGB} GB`,
    );
  }
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
  assert.equal(primary.name, 'qwen3:4b');
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
  assert.equal(patch.model, 'qwen3:8b');
  assert.equal(patch.escalationModel, 'qwen3:30b-a3b');
});

test('the pull list carries sizes so the download can be sized up front', () => {
  const list = modelsToPull(recommendModels(hw({ vramGB: 8, ramGB: 32 })));
  assert.equal(list.length, 2);
  assert.ok(list.every((m) => typeof m.diskGB === 'number' && m.diskGB > 0));
});

test('every catalog entry is ordered and sized coherently', () => {
  for (let i = 1; i < CATALOG.length; i++) {
    assert.ok(CATALOG[i].tier > CATALOG[i - 1].tier, 'tiers must increase');
    assert.ok(CATALOG[i].diskGB > CATALOG[i - 1].diskGB, 'sizes must increase');
  }
});
