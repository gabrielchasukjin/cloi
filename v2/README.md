# Cloi

A local-first coding agent for the terminal, powered by Ollama.

Cloi is a general-purpose agent, not a single-purpose tool: you talk to it, and
it reads, searches, writes, and edits files and runs commands in your workspace
to answer you. Everything runs on your machine. No API key, no data leaving the
host.

This is a rewrite of the original Cloi, which was a fixed
`analyze → classify → patch` debugging pipeline — the model could never say
"show me the caller of this function first." The architecture here follows
patterns from [hermes-agent](https://github.com/NousResearch/hermes-agent) and
[opencode](https://github.com/anomalyco/opencode).

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite`, so no native build)
- [Ollama](https://ollama.com) running locally
- A **tool-capable** model — check with `ollama show <model>` and look for
  `tools` under Capabilities

```bash
npm install
cloi setup      # measures the machine, picks models, downloads them
cloi
```

`cloi setup` runs automatically on first use if no config exists.

Startup fails early and loudly if Ollama is unreachable, the model is missing,
or the model cannot call tools — each with the exact command to fix it.
Discovering any of those mid-turn produces baffling behaviour instead of an
error.

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

Three details that matter:

- **Fit is computed with an additive reserve, not a multiplier.** The overhead
  beyond the weights is the KV cache, which scales with the *context window*
  rather than model size. A multiplier would refuse a 20 GB model on a 24 GB
  card that holds it fine.
- **A mixture-of-experts model is preferred for escalation when it will spill.**
  Only its active parameters cost time, so `qwen3:30b-a3b` stays usable on CPU
  where a dense model of the same footprint would not.
- **Thresholds sit under the nominal card size.** An "8 GB" card reports 8151
  MiB — 7.96 GiB — so a naive `>= 8` would quietly drop it a tier.

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

## Usage

```bash
cloi                          # interactive session in the current folder
cloi "add tests for auth"     # one-shot request, then exit
cloi --continue               # resume the last session in this folder
cloi --session <id>           # resume a specific session
cloi sessions                 # list recent sessions
cloi -m qwen3:8b              # use a different model
```

In a session:

| Command | |
|---|---|
| `/help` | command list |
| `/model [name]` | show or switch model (validates tool support) |
| `/models` | installed Ollama models |
| `/tools` | available tools and which ones ask first |
| `/plan` | current task list |
| `/usage` | token and throughput breakdown for the last turn |
| `/sessions` | recent sessions |
| `/session` | this session's id and workspace |
| `/exit` | quit |

Ctrl+C interrupts the current turn without killing the session. Ctrl+D exits.

## Architecture

```
bin/cloi.js                entry point, preflight checks
  src/cli/repl.js          chat loop, slash commands, rendering state machine
  src/agent/
    loop.js                the agent loop and every safety rail
    prompt.js              system prompt construction
    permission.js          approval gating for side-effecting tools
    verify.js              checks an answer's claims against the files
    judge.js               reviews claims the filesystem cannot settle
  src/tools/
    registry.js            define / validate / dispatch, truncation, name repair
    fs-tools.js            read, write, edit, list, glob, grep
    shell.js               run_command
    todo.js                update_plan
    workspace.js           path containment, directory walking
  src/session/store.js     SQLite persistence
  src/provider/ollama.js   streaming + tool calls over Ollama's HTTP API
  src/cli/setup.js         hardware detection, model recommendation, downloads
  src/util/
    hardware.js            VRAM / RAM / GPU detection
    recommend.js           model catalog and fit calculation
    usage.js               token accounting and context pressure
    secrets.js             credential containment
    truncate.js            output limits and overflow spill
```

### One user turn, many model steps

`runTurn` drives the loop. Each iteration is a **single** model step — the
provider never loops on tool calls itself. Iteration lives in one place so
persistence, permissions, and every safety rail sit at the same layer instead of
being spread across the transport.

The provider is injectable, so the loop is not bound to Ollama and can be driven
by a scripted provider under test.

### SQLite is the source of truth

Conversation state is not an in-memory array that gets flushed to disk. The loop
rebuilds its model messages from SQLite on **every iteration**, so an
interrupted turn leaves a coherent, resumable session behind rather than a
half-written buffer.

### Safety rails

Small local models fail in specific, repeatable ways. Each has a guard:

| Failure | Guard |
|---|---|
| Invents a tool name (`readFile`, `read-file`) | Levenshtein repair onto the real name; the call proceeds instead of costing a round trip |
| Repeats an identical failing call | Doom-loop detection — after N identical calls the model is told to change approach |
| Well-formed calls that all fail | Consecutive-error counter. No strike accrues and nothing repeats, so nothing else sees it |
| Spins forever | Hard iteration ceiling per turn |
| Emits unusable calls repeatedly | Strike budget; a tool that ran and reported a real failure does *not* count against it |
| Returns a huge tool result | Truncated at 2000 lines / 50 KB, overflow spilled to a temp file the agent can read back |
| Throws inside a tool | `dispatch` never throws; errors return as text the model can act on |
| Reaches outside the workspace | Every path resolved and contained under the workspace root |
| Returns nothing at all | Nudged once rather than silently ending the turn |

Every threshold is defaulted inside the loop rather than read straight off
config. A missing key would otherwise compare against `undefined`, which is
always false — silently disabling a rail instead of failing loudly.

## Answer verification

Every rail above detects the agent *malfunctioning*. None detects it being
*wrong* — and in live testing that was the more common failure by a wide margin.
A model read one line of a twenty-line file, declared the function absent, and
the loop accepted it: both tool calls had succeeded, nothing repeated, nothing
looked broken.

Three checks run before an answer is accepted, cheapest first.

### 1. Did the turn leave the workspace changed and broken?

The strongest signal available, and the only one needing no pattern matching and
no model call — it is pure ordering over the tool log:

- **Still failing** — an edit succeeded, then a command ran *after it* and
  failed. The change is in place and the thing still does not work.
- **Unverified** — an edit succeeded, a command had already failed *before* it,
  and nothing was re-run afterwards.

Both branches are narrow by construction. "Unverified" requires a prior failing
command, so a turn merely asked to change a file is never scolded for running no
tests. This is checked first: a workspace left changed and broken is a worse
outcome than any misworded claim.

### 2. Do the answer's claims survive contact with the files?

No model call — claims about a filesystem are settled by the filesystem.

| Claim in the answer | Check |
|---|---|
| Names a file | Does it exist anywhere in the workspace? |
| Cites `file:line` | Does the file have that many lines? |
| Asserts something is absent | Grep for it — one match disproves the claim |
| Quotes source | Does that text appear in a file read, or in tool output? |
| Concludes absence from a fragment | Was enough of the file actually read? |

A failure is handed back with the specific contradiction — "`completionRate`
appears in `src/lib/stats.js` at line 16" — and a second failure escalates.

### 3. Does the evidence support the reasoning?

For claims the filesystem cannot settle — a stated root cause, a claimed fix —
a review pass asks a model whether the gathered evidence actually supports the
answer. This one costs a call, so it is deliberately narrow:

- fires only on answers asserting a cause or an outcome, never on a lookup
- fires only when tools were actually used, since otherwise there is no evidence
- **fails open**: an unparseable verdict counts as approval, because a verifier
  that blocks answers when confused is worse than none
- prefers the escalation model as judge, since asking the model that just
  produced a wrong answer to grade it mostly reproduces the error

### Biased toward silence

A false accusation costs a wasted round trip and teaches you to ignore the
check, so a claim is reported only when it can be positively *disproved*. Prose
with nothing checkable in it passes untouched.

That bias was earned. Live testing produced three false positives, each now
covered by a regression test: a file referred to by bare name was called
nonexistent; an odd number of backticks made the quote checker capture prose
*between* two code spans; and a value quoted out of `npm test` output was
reported as fabrication because the check searched only file contents.

## Model escalation

A model that gets stuck can hand the turn to a stronger one. Set
`escalationModel`; the replacement inherits the full conversation plus a note
explaining why it was brought in, so it can see exactly what was already tried.

Routing is on **observed failure, not predicted task type**. The loop already
knows when it is struggling; classifying a task up front would cost a model call
to guess something the loop can simply measure.

Six triggers, in the order live testing showed they were needed:

| Trigger | Detects |
|---|---|
| Strike budget exhausted | Unknown tool names, unusable arguments |
| Doom loop | The same call repeated verbatim |
| Consecutive tool errors | Well-formed calls that all fail — wrong paths, wrong flags |
| Repeated surrender | Narrated a next step and stopped, after a nudge already failed |
| Claim disproved | Verification found a statement the files contradict |
| Evidence insufficient | The review pass rejected the reasoning |

The last three exist because the first three caught roughly two failures in
five. Weak models rarely break mechanically; they narrate a next step and stop,
or answer confidently and wrongly.

Phrase matching catches some narration, but every run turned up a new phrasing,
so the durable signal is phrasing-independent: **tools were tried, none
succeeded, and the model stopped anyway**.

A cheap nudge is always tried before escalating, and the escalated model gets
its own nudge budget rather than inheriting an exhausted one.

### What a switch actually does

```
escalations++                 currentModel = escalationModel
callCounts.clear()            strikes = 0
consecutiveToolErrors = 0     surrenders = 0
verificationFailures = 0
```

Every counter resets, because the new model should not be blamed for the
previous one's mistakes. A handoff note is appended to the conversation, and the
loop continues — same session, same history, rebuilt from SQLite.

**Cost on a small card.** Swapping takes ~3–8 s, and switching forfeits the KV
cache, so the conversation is reprocessed. On 8 GB only one model stays resident
— `qwen3:1.7b` alone occupies 3.2 GB of VRAM, well above its 1.4 GB on disk.
That is affordable precisely because escalation is rare and capped; it is not a
mechanism for routing every turn.

## Permissions

`write_file`, `edit_file`, and `run_command` ask before running. Three answers,
because two are not enough: **once**, **always for this tool**, or **no**.
"Always" is scoped to the running process — a statement about this session, not
a standing grant that silently persists into future runs. Add tool names to
`autoApprove` for a durable grant.

## Credential containment

The agent can run shell commands and write files, so anything reachable from its
environment is one `echo` away from being exfiltrated. Two layers:

1. **Secrets are stripped from child processes.** `run_command` spawns with a
   sanitised environment — anything matching a credential-shaped name
   (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …) plus an explicit list of
   known provider variables. `SSH_AUTH_SOCK`, `XAUTHORITY` and friends are
   exempted, because removing them breaks `git push` for no security gain.
2. **Live secret values are redacted from tool output.** Only values actually
   present in the environment are masked, so redaction is precise. This catches
   a credential arriving by another route — a `.env` file, a config dump, a
   verbose log — before it reaches the transcript or a provider.

Identifiers are deliberately *not* treated as credentials. Redaction matches on
value, so classifying a session id as secret corrupted a real file path into
`.../[redacted]/...` when that id was also a directory name.

This is defence in depth, not a guarantee: an agent running arbitrary commands
can still read a credentials file off disk. It removes the trivial paths.

## Cross-platform by construction

No shelling out to `sed`, `cat`, `find`, `which`, or `patch`. Filesystem work
uses Node APIs and `fs.globSync`, so behaviour is identical on Windows and
POSIX. The only shell is `run_command`, and the system prompt tells the model
which shell it is actually talking to.

## Configuration

`~/.cloi/config.json` (override the location with `CLOI_DATA_DIR`):

```json
{
  "model": "qwen3:8b",
  "host": "http://127.0.0.1:11434",

  "maxIterations": 40,
  "maxStrikes": 3,
  "doomLoopThreshold": 3,
  "maxConsecutiveToolErrors": 3,

  "escalationModel": null,
  "maxEscalations": 1,

  "verifyAnswers": true,
  "maxVerificationRetries": 1,
  "judgeAnswers": true,
  "judgeModel": null,

  "temperature": 0.2,
  "think": false,
  "contextLength": 16384,
  "showUsage": true,
  "autoApprove": []
}
```

`think` is off by default: on local hardware a visible reasoning pass costs a
great deal of latency and buys little accuracy for tool selection. Turning it
off took one measured task from ~106 s to ~16 tok/s sustained.

Keep `maxVerificationRetries` low. A model that fails the same complaint twice
will fail it five times — measured, not assumed.

## Performance and usage reporting

This runs local models, and it feels like it. On a laptop with 8 GB of VRAM,
`gemma4:12b` sits around 67% GPU / 33% CPU and a turn with a few tool calls
takes minutes rather than seconds.

Every turn ends with one number:

```
  ctx 1.3k/16k · 8%
```

Context is the only stat that is *news*. Throughput, time-to-first-token and
elapsed time are constants of your hardware — you learn them once. Context
climbs across a session and has a cliff: exceed `contextLength` and Ollama
silently drops history, so the agent quietly forgets a file it read three turns
ago, with no error anywhere. The line is dim below 70%, yellow at 70%, and red
at 90% with an explanation.

`/usage` expands to the full breakdown — input/output tokens, generation rate,
prompt-eval rate, TTFT, model load, and the split between model time and time
spent in tools. The numbers come from Ollama's own counters, not estimates, and
two are computed deliberately:

- **tok/s is measured against the model's eval duration**, not wall clock, so it
  reports real throughput and is not dragged down by time in tools or a
  cold-start load.
- **ctx is a high-water mark, not a sum.** Each step resends the conversation,
  so summing prompt tokens would imply the window was blown when it was not.

## What live testing showed

The rails above are not speculative — each was added after watching a specific
failure, and several were built the wrong way first.

**Escalation works, and raises the floor rather than the ceiling.** A weak
primary handing off to a stronger model was demonstrated repeatedly; after
handoff the stronger model traced a failure across files the weak one never
approached. But no amount of rescue makes a task solvable that no available
model can solve.

**Malfunction is the minority failure.** Across five live runs, mechanical rails
fired on two. The other three were confident and wrong, with every tool call
succeeding — which is why verification exists.

**Verification changes outcomes.** Replaying the exact turn that failed before:
the model read one line, claimed absence, was told its evidence was thin,
re-read the whole file and answered correctly — *without* escalating. The weak
model could do the task all along; it needed to be told its evidence was thin.

**Detection is not capability.** A cross-file bug — the failing test names one
module, the cause lives in another — was attempted four times by `qwen3:8b`,
with and without every rail. It never solved it, and a control run with all
rails off failed identically. The checks made the failure *loud* instead of
silent, which is the real win: without them the run ended with a nonsense edit
in place and a confident summary.

**Context growth is the cost driver.** A trivial four-step turn consumed 6.5k
input tokens, because each step resends the whole conversation plus ~4 KB of
tool schemas. Free on Ollama, expensive on a metered API.

## Tests

```bash
npm test
```

122 tests covering tool-name repair, argument validation and coercion, dispatch
error containment, availability probes, output truncation and overflow recovery,
workspace path containment, call-identity hashing, permission gating,
credential containment, usage accounting, escalation triggers and handoff state,
model recommendation across hardware profiles, and every verification check —
including regression tests for each false positive found in live runs.

## Known gaps

- **Ollama only.** No cloud provider or bring-your-own-key yet. A generic
  OpenAI-compatible provider would unlock Kimi, OpenRouter, Groq, and local vLLM
  through one code path.
- **No context compaction.** Full history is resent every iteration.
- **No sub-agents, MCP, web access, or retrieval.**
- **The interactive permission prompt has not been exercised with a live
  keypress.** Its logic has unit coverage; the readline round trip does not.
- **Tested against `gemma4:12b`, `qwen3:8b`, and `qwen3:1.7b`.**

## License

GPL-3.0
