# Choosing models

How cloi decides which models to run on your machine, and the measurements behind those
choices. Summarised in the README; this is the working.

## Choosing models

The hardest decision for a new user is which model to run, and getting it wrong
produces an agent that looks *broken* rather than one that looks slow. So it is
measured rather than guessed.

`cloi setup` reads VRAM, system RAM and core count, then proposes two models
against **different constraints** — which is the whole idea:

- The **primary** runs every step of every turn, so it must fit in VRAM. A model
  that spills is not slightly slower, it is several times slower, and that cost
  is paid on each of the dozen-odd model calls a turn makes.
- The **escalation** model runs rarely, only when a turn is already going wrong,
  so it is allowed to spill. It only has to fit in RAM. A few slow minutes on a
  turn that would otherwise fail outright is a good trade.

```
NVIDIA GeForce RTX 5060 Laptop GPU · 8.0 GB VRAM · 31.4 GB RAM · 20 cores

primary   qwen3:8b       5.2 GB · best small model for agent loops
fallback  qwen3:30b-a3b   18 GB · mixture-of-experts: 3B active, so it stays
                                  fast even when it spills to RAM
```

Sample recommendations:

| Machine | Primary | Escalation |
|---|---|---|
| No GPU, 16 GB RAM | `qwen3:4b` | `qwen3:14b` |
| 6 GB VRAM, 16 GB RAM | `qwen3:4b` | `qwen3:14b` |
| 8 GB VRAM, 32 GB RAM | `qwen3:8b` | `qwen3:30b-a3b` |
| 16 GB VRAM, 32 GB RAM | `qwen3:14b` | `qwen3:30b-a3b` |
| 24 GB VRAM, 64 GB RAM | `qwen3:32b` | — |

Five details that matter, all of them corrected by measurement rather than
reasoned from first principles:

- **The bar is ~60% VRAM residency, not a full fit.** On an 8 GB card only a 4B
  model fits entirely, and dropping two tiers of capability to avoid a 20% spill
  is the wrong trade.
- **Fit uses an additive reserve, not a multiplier.** The overhead beyond the
  weights is the KV cache, which scales with the *context window* rather than
  model size. A multiplier refused a 20 GB model on a 24 GB card that holds it
  fine.
- **A primary is stepped down when it would leave nothing to escalate to.** A
  faster primary plus a working fallback beats a bloated primary alone.
- **A mixture-of-experts model is preferred for escalation when it will spill.**
  Only its active parameters cost time, so `qwen3:30b-a3b` stays usable on CPU
  where a dense model of the same footprint would not.
- **Thresholds sit under the nominal card size.** An "8 GB" card reports 8151
  MiB — 7.96 GiB — so a naive `>= 8` would quietly drop it a tier.

### Which models, and why those

The catalog spans families rather than betting on one vendor, and entries were
chosen from a local run through this registry — not from public leaderboards,
which use their own tools and prompts.

`bench/compare.js` runs candidate models against the real eight tools with
escalation and judging disabled, on tasks with checkable answers:

Eight tasks across three difficulty bands, three repeats each, scored
mechanically — a regex over the answer, or the exit code of the project's own
test suite:

```
model                  pass rate      easy   medium   hard   tok/s (sd)
qwen3:8b               11/24 (46%)    8/9    3/9      0/6    33.7 (5.2)
nemotron-3-nano:4b     15/24 (63%)    8/9    7/9      0/6    98.8 (18.7)
```

Three results shaped the catalog:

- **Nemotron wins on a smaller model.** 63% against 46%, and 7/9 against 3/9 on
  medium tasks, at 2.8 GB and roughly three times the throughput. So catalog
  *tier means measured capability, not size* — ordering by size would hand an
  8 GB card the weaker model purely because it is bigger.
- **Hard tasks are 0/12 for both.** Not one pass in twelve attempts at tracing a
  bug across files. That is the ceiling, stated with real n rather than inferred.
- **Neither over-triggers.** Both scored 3/3 on a task that passes only if *no*
  tool is called, which the relevance/irrelevance splits in public benchmarks
  suggested was a genuine risk.

A `~` marks any task passed only sometimes — unreliability is a different
failure from incapability, and matters more inside a loop.

An earlier three-task version of this benchmark ranked the two models as tied.
It was too easy to discriminate, and its scorer was wrong: an answer of "it is in
stats.js, **not** report.js" was marked incorrect for naming the distractor —
penalising precision. Scoring now takes the first non-negated file mentioned,
verified against twelve hand-written cases covering both word orders.

**Gemma 4** is deliberately absent despite being tool-capable and Apache-2.0. It
came last here — hitting the iteration ceiling on a task the others finished in
four steps — which matches independent results giving Qwen 3.6 large agentic
margins (SWE-bench +21.4, MCPMark +18.9, TAU2 +13). Gemma 4 wins math and
multimodal; this loop uses neither.

**Nemotron 3 Super and Ultra** are 120B and 550B, and Ultra is cloud-only on
Ollama, so neither fits a laptop.

Run it yourself against anything you like:

```bash
node bench/compare.js qwen3:8b nemotron-3-nano:4b your-model:tag
```

### The prediction is checked against reality

Probes read the card; they can still be wrong on hardware nobody has tested. So
after the primary is pulled, setup loads it and asks Ollama where it actually
went:

```
82% of qwen3:8b is resident in VRAM
```

That number comes from `size_vram / size` on `/api/ps`, which reflects **Ollama's
own GPU detection** — covering NVIDIA, AMD, Intel and Metal, including hardware
these probes cannot read. If residency comes back below 40%, the primary is
stepped down automatically and you are told why.

The constants are calibrated against that measurement: on this machine the
prediction was 82% and the observed value 80%, a two-point error. There is no
Ollama endpoint reporting card capacity — `/api/gpu`, `/api/hardware`,
`/api/system` all 404 — so the placement of a real model is the closest thing to
ground truth available.

VRAM is probed in order of how reliable the number is: `nvidia-smi`, then
`rocm-smi` for AMD, then the Windows display-adapter registry (covering AMD and
Intel), then Linux sysfs. Apple Silicon is treated as unified memory at roughly
two thirds of system RAM.

Two Windows traps are worth naming, since both silently produce a wrong answer
rather than an error. WMI's `AdapterRAM` is a 32-bit field that reports *any*
card above 4 GB as exactly 4 GB — so the registry's 64-bit `qwMemorySize` is
used instead. And that value is a *flat* property whose name contains a dot, so
it must be quoted: dot-traversal reads `null` and makes every machine look like
it has no GPU.

Every probe returns null rather than a guess. If nothing is detectable the
recommendation drops to a CPU-sized model, because suggesting something too
large fails confusingly while suggesting something too small merely
underperforms.

Downloads go through Ollama's HTTP API rather than the `ollama` binary, which
may not be on `PATH` even when the server is reachable. A failed download never
discards the recommendation — the config is written either way, so you are never
left with no model configured.

`npm install` prints a one-line pointer to `cloi setup` and does nothing else:
no hardware probing, no network, no writes. It is silent under `CI`.
