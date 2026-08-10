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
/**
 * Tier is **measured capability in this loop**, not size.
 *
 * Those usually agree, and once they did not: `nemotron-3-nano:4b` outscored
 * `qwen3:8b` (63% vs 46% over 24 runs, and 7/9 vs 3/9 on medium tasks) while
 * being roughly half the size and three times faster. Ordering by size would
 * hand an 8 GB card the weaker model purely because it is bigger.
 */
export const CATALOG = [
  { name: 'qwen3:1.7b', diskGB: 1.4, tier: 1, note: 'minimal; expect frequent escalation' },
  { name: 'qwen3:8b', diskGB: 5.2, tier: 2, note: 'solid on lookups; weaker at tracing across files' },
  {
    name: 'nemotron-3-nano:4b',
    diskGB: 2.8,
    tier: 3,
    note: 'built for agentic loops; best measured accuracy per GB here, and ~3x faster',
  },
  { name: 'qwen3:14b', diskGB: 9.3, tier: 4, note: 'stronger reasoning, needs more room' },
  { name: 'qwen3:30b-a3b', diskGB: 18, tier: 5, moe: true, note: 'mixture-of-experts: 3B active, so it stays fast even when it spills to RAM' },
  { name: 'qwen3:32b', diskGB: 20, tier: 6, note: 'dense; slow unless it fits in VRAM' },
];

/**
 * Families deliberately not in the catalog, and why — so the reasoning is
 * visible rather than looking like an oversight.
 *
 * - **Gemma 4** is tool-capable and Apache-2.0, but loses agentic work by wide
 *   margins (SWE-bench +21.4, MCPMark +18.9, TAU2 +13 to Qwen 3.6) and came
 *   last in a local three-way run through this registry: 1/3 tasks, 27 steps,
 *   16 tok/s. It wins math and multimodal, which this loop does not use.
 * - **Nemotron 3 Super / Ultra** are 120B and 550B; Ultra is cloud-only on
 *   Ollama. Neither fits a laptop.
 * - **Llama 3.x** posts weak multi-turn tool-calling scores and is superseded
 *   by everything above at comparable sizes.
 */
export const CONSIDERED_AND_EXCLUDED = ['gemma4', 'nemotron-3-super', 'nemotron-3-ultra', 'llama3.x'];

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
const KV_RESERVE_GB = 2.6;

/**
 * Share of VRAM a model actually gets.
 *
 * Measured rather than assumed: on an 8151 MiB card Ollama placed 6.29 GB of a
 * model in VRAM — about 79% — keeping the rest for the display and its own
 * buffers. An earlier 0.9 was too generous and predicted full residency for a
 * model that in fact spilled 20% to CPU.
 */
const VRAM_HEADROOM = 0.8;

/**
 * How much of a model must sit in VRAM for it to be a sensible primary.
 *
 * Not 100%: on an 8 GB card only a 4B model fits entirely, and a 20% spill on
 * an 8B model is a far better trade than dropping two tiers of capability. The
 * threshold marks where spilling starts to dominate generation time.
 */
export const MIN_VRAM_RESIDENCY = 0.6;

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
  // A model qualifies if enough of it lands in VRAM, not if all of it does.
  // Requiring full residency drops two tiers of capability to avoid a 20%
  // spill, which is the wrong trade.
  const vramBudget = vramGB * VRAM_HEADROOM;
  let primary = [...CATALOG].reverse()
    .find((m) => vramBudget / residentGB(m) >= MIN_VRAM_RESIDENCY) || null;

  if (!hw.vramMB) {
    // No GPU: everything is generated on CPU, so size is what costs time.
    // Selected as the smallest model that is not the bottom tier — neither by
    // name (breaks silently when the catalog changes) nor by tier, since tier
    // ranks capability and the ablest small model need not be the largest.
    primary = [...CATALOG]
      .filter((m) => m.tier > 1)
      .sort((a, b) => a.diskGB - b.diskGB)[0] || CATALOG[0];
    reasons.push('No GPU detected, so the primary is kept small — every token is generated on CPU.');
  } else if (primary) {
    const residency = Math.min(1, (vramGB * VRAM_HEADROOM) / residentGB(primary));
    reasons.push(
      residency >= 0.98
        ? `${primary.name} fits entirely in ${vramGB.toFixed(1)} GB of VRAM.`
        : `${primary.name} is the largest model that keeps roughly ${Math.round(residency * 100)}% of its weights in ${vramGB.toFixed(1)} GB of VRAM.`,
    );
  } else {
    primary = CATALOG[0];
    warnings.push(`Only ${vramGB.toFixed(1)} GB of VRAM detected. Even ${primary.name} will spill to system RAM.`);
  }

  // ── escalation: must fit in RAM, and must be genuinely better ──────────────
  const ramBudget = ramGB * RAM_BUDGET;
  const betterThan = (model) => CATALOG.filter((m) => m.tier > model.tier && m.diskGB <= ramBudget);

  // Taking the largest possible primary can consume the only model worth
  // escalating to. A slightly smaller primary that keeps a fallback is the
  // better system: the primary runs faster on every turn, and turns that get
  // stuck still have somewhere to go.
  if (hw.vramMB && !betterThan(primary).length) {
    const candidates = CATALOG.filter(
      (m) => m.tier < primary.tier && betterThan(m).length,
    );
    const stepDown = candidates[candidates.length - 1];
    if (stepDown) {
      reasons.push(`Stepped down to ${stepDown.name} so there is still a stronger model to escalate to.`);
      primary = stepDown;
    }
  }

  const better = betterThan(primary);

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
