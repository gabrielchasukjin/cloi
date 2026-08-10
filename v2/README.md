# Cloi

A local-first coding agent for the terminal, powered by Ollama.

Cloi is a general-purpose agent, not a single-purpose tool: you talk to it, and
it reads, searches, writes, and edits files and runs commands in your workspace
to answer you. Everything runs on your machine. No API key, no data leaving the
host.

This is a rewrite of the original Cloi, which was a fixed
`analyze → classify → patch` debugging pipeline. The architecture here follows
the patterns used by [hermes-agent](https://github.com/NousResearch/hermes-agent)
and [opencode](https://github.com/anomalyco/opencode).

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite`)
- [Ollama](https://ollama.com) running locally
- A **tool-capable** model — check with `ollama show <model>` and look for
  `tools` under Capabilities

```bash
ollama pull gemma4:12b
npm install
node bin/cloi.js
```

## Usage

```bash
cloi                          # interactive session in the current folder
cloi "add tests for auth"     # one-shot request, then exit
cloi --continue               # resume the last session in this folder
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
bin/cloi.js            entry point, preflight checks
  src/cli/repl.js      chat loop, slash commands, rendering state machine
  src/agent/
    loop.js            the agent loop and its safety rails
    prompt.js          system prompt construction
    permission.js      approval gating for side-effecting tools
  src/tools/
    registry.js        define / validate / dispatch, truncation, name repair
    fs-tools.js        read, write, edit, list, glob, grep
    shell.js           run_command
    todo.js            update_plan
    workspace.js       path containment, directory walking
  src/session/store.js SQLite persistence
  src/provider/ollama.js  streaming + tool calls over Ollama's HTTP API
```

### One user turn, many model steps

`runTurn` drives the loop. Each iteration is a **single** model step — the
provider never loops on tool calls itself. Iteration lives in one place so
persistence, permissions, and every safety rail sit at the same layer instead of
being spread across the transport.

### SQLite is the source of truth

Conversation state is not an in-memory array that gets flushed to disk. The loop
rebuilds its model messages from SQLite on **every iteration**, so an
interrupted turn leaves a coherent, resumable session behind rather than a
half-written buffer.

### Safety rails

Small local models fail in specific, repeatable ways. Each has a guard:

| Failure | Guard |
|---|---|
| Invents a tool name (`readFile`, `read-file`) | Levenshtein repair onto the real name; the call proceeds instead of costing a round-trip |
| Repeats an identical failing call | Doom-loop detection — after N identical calls the model is told to change approach |
| Spins forever | Hard iteration ceiling per turn |
| Emits unusable calls repeatedly | Strike budget; a tool that ran and reported a real failure does *not* count against it |
| Returns a huge tool result | Every result truncated at 2000 lines / 50 KB, overflow spilled to a temp file the agent can read back |
| Throws inside a tool | `dispatch` never throws; errors come back as text the model can act on |
| Reaches outside the workspace | Every path resolved and contained under the workspace root |
| Returns nothing at all | Nudged once rather than silently ending the turn |

### Answer verification

Every other rail detects the agent *malfunctioning*. This one detects it being
*wrong*, which in live testing was the far more common failure: a model read one
line of a twenty-line file, declared the function absent, and the loop accepted
it — both tool calls had succeeded, nothing repeated, nothing looked broken.

Before an answer is accepted, its factual claims are checked against the files.
No model call is involved: claims about a filesystem are settled by the
filesystem.

| Claim in the answer | Check |
|---|---|
| Names a file | Does it exist in the workspace? |
| Cites `file:line` | Does the file have that many lines? |
| Asserts something is absent | Grep for it — one match disproves the claim |
| Quotes source | Does that text appear in a file the agent read? |
| Concludes absence from a fragment | Was enough of the file actually read? |

A failed check is handed back to the model with the specific contradiction
("`completionRate` appears in `src/lib/stats.js` at line 16"), and a second
failure escalates.

The whole module biases toward silence. A false accusation costs a wasted round
trip and teaches you to ignore the check, so a claim is only reported when it
can be positively disproved — prose with nothing checkable in it passes
untouched.

### Model escalation

A weak model that gets stuck can hand the turn to a stronger one. Set
`escalationModel` in config; the replacement inherits the full conversation
plus a note explaining why it was brought in, so it can see what was already
tried.

Routing is on **observed failure, not predicted task type**. The loop already
knows when it is struggling; classifying a task up front would cost a model call
to guess something the loop can simply measure.

Four triggers, in the order they were discovered to matter:

| Trigger | Detects |
|---|---|
| Strike budget exhausted | Unknown tool names, unusable arguments |
| Doom loop | The same call repeated verbatim |
| Consecutive tool errors | Well-formed calls that all fail — wrong paths, wrong flags. No strike accrues and nothing repeats, so nothing else catches it |
| Fruitless turn | Tools were tried, none succeeded, and the model stopped anyway |

The last one does the durable work. Weak models rarely fail mechanically; they
narrate a next step ("I will now check the other file") and stop, which the loop
would otherwise read as a finished answer. Phrase matching catches some of that,
but every run turns up a new phrasing — so the primary signal is
phrasing-independent: attempted tools, zero successes, stopped.

A cheap nudge is always tried before escalating, and the escalated model gets
its own nudge budget rather than inheriting an exhausted one.

**Cost on a small card.** Swapping models takes ~3–8 s, and on 8 GB only one
model stays resident (`qwen3:1.7b` alone occupies 3.2 GB of VRAM, well above its
1.4 GB on disk). That is affordable precisely because escalation is rare — it is
not a mechanism for routing every turn.

### Permissions

`write_file`, `edit_file`, and `run_command` ask before running. Three answers,
because two are not enough: **once**, **always for this tool**, or **no**.
"Always" is scoped to the running process — it is a statement about this
session, not a standing grant that silently persists into future runs. Add tool
names to `autoApprove` in `~/.cloi/config.json` for a durable grant.

### Credential containment

The agent can run shell commands and write files, so anything reachable from its
environment is one `echo` away from being exfiltrated. Two layers:

1. **Secrets are stripped from child processes.** `run_command` spawns with a
   sanitised environment — anything matching a credential-shaped name
   (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …) plus an explicit list of
   known provider variables is withheld. `SSH_AUTH_SOCK`, `XAUTHORITY` and
   friends are exempted, because removing them breaks `git push` for no gain.
2. **Live secret values are redacted from tool output.** Only values actually
   present in the environment are masked, so redaction is precise. This catches
   a credential that reaches the agent by another route — a `.env` file, a
   config dump, a verbose log — before it lands in the transcript or gets sent
   to a provider.

This is defence in depth, not a guarantee: an agent running arbitrary commands
can still read a credentials file off disk. It removes the trivial paths.

### Cross-platform by construction

No shelling out to `sed`, `cat`, `find`, `which`, or `patch`. Filesystem work
uses Node APIs and `fs.globSync`, so behaviour is identical on Windows and
POSIX. The only shell is `run_command`, and the system prompt tells the model
which shell it is actually talking to.

## Configuration

`~/.cloi/config.json` (override the location with `CLOI_DATA_DIR`):

```json
{
  "model": "gemma4:12b",
  "host": "http://127.0.0.1:11434",
  "maxIterations": 40,
  "maxStrikes": 3,
  "doomLoopThreshold": 3,
  "temperature": 0.2,
  "think": false,
  "contextLength": 16384,
  "autoApprove": []
}
```

`think` is off by default. On local hardware a visible reasoning pass costs a
great deal of latency and buys little accuracy for tool selection.

## Performance and usage reporting

This runs local models, and it feels like it. On a laptop with 8 GB of VRAM,
`gemma4:12b` sits around 67% GPU / 33% CPU, and a turn with a few tool calls
takes minutes rather than seconds. Smaller models are faster but drift more;
`maxIterations` and the strike budget exist partly to bound the cost of that
drift.

Because that range is so wide, every turn ends with a measured summary:

```
  3 steps · 3.6k in / 200 out · 10.0 tok/s · ttft 900ms · 45.0s · ctx 2.4k/16k (15%)
```

The numbers come from Ollama's own counters, not estimates. Two are computed
deliberately:

- **tok/s is measured against the model's eval duration**, not wall clock, so it
  reports real throughput and is not dragged down by time spent running tools or
  by a cold-start model load.
- **ctx is a high-water mark, not a sum.** Each step resends the conversation, so
  summing prompt tokens would imply you had blown the context window when you
  had not. The peak is what matters: exceed `contextLength` and Ollama silently
  drops history.

`/usage` expands this into a full breakdown, including model load time and the
split between model time and time spent in tools. Set `showUsage: false` in
config to suppress the per-turn line.

## Tests

```bash
npm test
```

34 tests covering name repair, argument validation and coercion, dispatch error
containment, availability probes, output truncation and overflow recovery,
workspace path containment, call-identity hashing, permission gating, and
credential containment (including a regression test that `run_command` cannot
read an API key out of the environment).

## License

GPL-3.0
