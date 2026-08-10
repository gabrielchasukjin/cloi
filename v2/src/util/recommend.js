/**
 * Model recommendation.
 *
 * The primary and the escalation model are chosen against *different*
 * constraints, which is the whole idea:
 *
 *  - The **primary** runs every step of every turn, so it must fit in VRAM.
 *    A model that spills to system RAM is not slightly slower, it is several
 *    times slower, and that cost is paid on every one of the dozen-odd model
 *    calls a turn makes.
 *  - The **escalation** model runs rarely — only when a turn is already going
 *    wrong — so it is allowed to spill. It only has to fit in system RAM. Its
 *    job is to be more capable, and a few slow minutes on a turn that would
 *    otherwise fail outright is a good trade.
 *
 * Sizes below are the on-disk quantised sizes Ollama reports. Resident VRAM use
 * runs meaningfully higher once the KV cache and compute buffers are added —
 * `qwen3:1.7b` is 1.4 GB on disk and was measured at 3.2 GB resident — so the
 * fit calculation multiplies rather than comparing against the raw size.
 */

/**
 * Tool-capable, permissively licensed models in increasing capability order.
 * Every entry supports native function calling; a model that cannot call tools
 * is useless here regardless of how well it writes code.
 */
export const CATALOG = [
  { name: 'qwen3:1.7b', diskGB: 1.4, tier: 1, note: 'minimal; expect frequent escalation' },
  { name: 'qwen3:4b', diskGB: 2.6, tier: 2, note: 'usable for lookups and small edits' },
  { name: 'qwen3:8b', diskGB: 5.2, tier: 3, note: 'best small model for agent loops' },
  { name: 'qwen3:14b', diskGB: 9.3, tier: 4, note: 'stronger reasoning, needs more room' },
  { name: 'qwen3:30b-a3b', diskGB: 18, tier: 5, moe: true, note: 'mixture-of-experts: 3B active, so it stays fast even when it spills to RAM' },
  { name: 'qwen3:32b', diskGB: 20, tier: 6, note: 'dense; slow unless it fits in VRAM' },
];

/**
 * Memory a loaded model needs beyond its weights.
 *
 * Added rather than multiplied: the overhead is the KV cache and compute
 * buffers, which scale with the *context window*, not with the size of the
 * model. A multiplier over-penalises large models — it would refuse a 20 GB
 * model on a 24 GB card that holds it comfortably.
 *
 * Calibrated against measurement: qwen3:1.7b is 1.4 GB on disk and was observed
 * at 3.2 GB resident, and gemma4:12b at 7.6 GB was observed spilling on an 8 GB
 * card. Both match this reserve.
 */
const KV_RESERVE_GB = 1.5;

/** Leave room for the desktop, the compositor, and everything else on the card. */
const VRAM_HEADROOM = 0.9;

/**
 * Share of system RAM a spilled model may occupy. Weights are memory-mapped
 * and part of the model still sits in VRAM, so this is a ceiling on the
 * download rather than on true resident size.
 */
const RAM_BUDGET = 0.6;

export function residentGB(model) {
  return model.diskGB + KV_RESERVE_GB;
}

/**
 * Choose a primary and an escalation model for this machine.
 *
 * @param {import('./hardware.js').Hardware} hw
 * @returns {{primary: object|null, escalation: object|null, reasons: string[], warnings: string[]}}
 */
export function recommendModels(hw) {
  const reasons = [];
  const warnings = [];

  const vramGB = hw.vramMB ? hw.vramMB / 1024 : 0;
  const ramGB = hw.totalRamMB / 1024;

  // ── primary: must fit in VRAM ──────────────────────────────────────────────
  const vramBudget = vramGB * VRAM_HEADROOM;
  let primary = [...CATALOG].reverse().find((m) => residentGB(m) <= vramBudget) || null;

  if (!hw.vramMB) {
    // No GPU: everything runs on CPU, where only active parameters matter, so a
    // sparse mixture-of-experts beats a dense model of the same footprint.
    primary = CATALOG.find((m) => m.name === 'qwen3:4b');
    reasons.push('No GPU detected, so the primary is kept small — every token is generated on CPU.');
  } else if (primary) {
    reasons.push(`${primary.name} is the largest model that fits in ${vramGB.toFixed(1)} GB of VRAM with room for the context.`);
  } else {
    primary = CATALOG[0];
    warnings.push(`Only ${vramGB.toFixed(1)} GB of VRAM detected. Even ${primary.name} will spill to system RAM.`);
  }

  // ── escalation: must fit in RAM, and must be genuinely better ──────────────
  const ramBudget = ramGB * RAM_BUDGET;
  const better = CATALOG.filter((m) => m.tier > primary.tier && m.diskGB <= ramBudget);

  // Prefer a mixture-of-experts model when it will spill: only its active
  // parameters cost time, so it stays usable on CPU where a dense model of the
  // same size would not.
  const spills = (m) => residentGB(m) > vramBudget;
  const escalation =
    better.find((m) => m.moe && spills(m))
    || better[better.length - 1]
    || null;

  if (escalation) {
    reasons.push(
      escalation.moe && spills(escalation)
        ? `${escalation.name} is the escalation model: it spills to RAM, but only 3B parameters are active per token so it stays usable.`
        : `${escalation.name} is the escalation model — more capable, and it fits.`,
    );
  } else {
    warnings.push('No larger model fits in RAM, so escalation is disabled. Turns that get stuck will stop rather than retry.');
  }

  if (ramGB < 8) {
    warnings.push(`${ramGB.toFixed(0)} GB of RAM is tight; close other applications before long sessions.`);
  }

  return { primary, escalation, reasons, warnings };
}

/**
 * Config patch implementing a recommendation.
 *
 * `contextLength` scales with available memory: the KV cache grows with it, and
 * on a small card a large window costs more than the history is worth.
 */
export function configFor(recommendation, hw) {
  const vramGB = hw.vramMB ? hw.vramMB / 1024 : 0;
  // Thresholds sit slightly below the nominal card sizes: an "8 GB" card
  // reports 8151 MiB, which is 7.96 GiB, and a naive `>= 8` would drop it a
  // tier. Every card is a little short of its marketing number.
  const contextLength = vramGB >= 15 ? 32768 : vramGB >= 7.5 ? 16384 : 8192;

  return {
    model: recommendation.primary?.name ?? 'qwen3:4b',
    escalationModel: recommendation.escalation?.name ?? null,
    contextLength,
  };
}

/** Everything that needs pulling for a recommendation, largest last. */
export function modelsToPull(recommendation) {
  return [recommendation.primary, recommendation.escalation]
    .filter(Boolean)
    .map((m) => ({ name: m.name, diskGB: m.diskGB, note: m.note }));
}
