# Cloi

A local-first coding agent for the terminal, powered by Ollama.

You talk to it; it reads, searches, writes and edits files and runs commands in
your workspace to answer you. Everything runs on your machine — no API key, no
data leaving the host.

```bash
npm install -g @cloi-ai/cloi
cloi
```

`cloi setup` runs automatically the first time and picks models that fit your
hardware. Requires [Ollama](https://ollama.com), Node 22.5+, and a tool-capable
model.

```
  █▀▀ █   █▀█ █   fallback  qwen3:30b-a3b
  █▄▄ █▄▄ █▄█ █   context   16k
                  root      ~/my-project

──────────────────────────────────────────────────  nemotron-3-nano:4b
› why is the empty-list test failing?

  ✓ run npm test                                  exit 1
  ✓ grep /completionRate/                         3 matches
  ✓ read src/lib/stats.js                         5 lines

  ← Edit src/lib/stats.js
  1   export function completionRate(tasks) {
  2 +   if (tasks.length === 0) return 0;
  3     const done = tasks.filter((t) => t.status === 'done').length;

  ✓ run npm test                                  exit 0

  ctx ███░░░░░░░░░░░░░ 3.5k/16k
```

## What it does differently

Everything below exists because a small local model failed in a specific way
during live testing. [docs/internals.md](docs/internals.md) has the reasoning.

### Models chosen by measuring your machine

Setup reads VRAM, RAM and core count and proposes **two** models against
different constraints: a primary that fits in VRAM and runs every step, and a
fallback that only has to fit in RAM because it runs rarely. Then it loads the
primary and asks Ollama where it actually went, stepping down if the prediction
was wrong.

Tier means *measured capability*, not size — a 4B model scoring 63% is ranked
above an 8B scoring 46%. [docs/models.md](docs/models.md)

### Escalation when a turn is going wrong

Six signals say a turn is stuck: repeated identical calls, consecutive tool
failures, unusable calls, a narrated step never taken. Any of them hands the
conversation to the bigger model, which inherits everything already tried.

Routing is on **observed failure**, not on guessing the task type up front.

### Answers checked before you see them

A claim that a file contains something is settled by the file. Line citations
are checked against line counts, quotes against what was actually read, and a
conclusion of absence against how much of the file the agent bothered to open.
No model call — the workspace already knows.

A second, model-based review runs only after an escalation, because that is the
one moment the answer is worth doubting.

### Results you can name and reuse

Every substantial result is stored in full under a name taken from its
arguments — `stats_js`, `grep_completionrate`, `npm_test`:

```
  ✓ read README.md                                294 of 638 lines
    [saved as readme_md — recall it instead of running this again]
```

`recall` reads it back whole, sliced, or searched. The stored copy is complete
even when what the model was shown was truncated, and it outlives the
conversation that produced it.

### Python, with those results already in scope

A session-long interpreter where every stored result is a variable and **every
tool is a callable function**:

```python
files = glob(pattern='src/**/*.js').splitlines()[1:]
sizes = {f: len(read_file(path=f)) for f in files}
sorted(sizes.items(), key=lambda kv: -kv[1])[:3]
```

One cell drives a loop that would otherwise be one tool call per turn. Variables,
imports and helper functions survive across sessions. Tools that ask permission
still ask, so approving a cell does not approve everything it can reach.

Measured on `nemotron-3-nano:4b`, 8 runs per arm, on a task needing per-file
arithmetic:

```
arm               correct   used python   calls   time
without examples  0/8       0/8           7.1     9s
with examples     3/8       8/8           3.8     6s
```

### History summarised, not silently dropped

Ollama does not refuse an over-long prompt — it drops the oldest tokens, so the
agent forgets what it was asked while behaving as though it remembers. Cloi
summarises the older half instead, cutting only where a tool result cannot be
separated from the call that produced it.

Nothing is deleted: the summary records how far it reaches, and older messages
are simply not sent.

### Guardrails around what it can touch

Paths are contained to the workspace. Writes, edits and shell commands ask
first, with three answers — once, always-for-this-tool, or no. Subprocesses run
with a sanitised environment, so a command cannot read your API keys, and any
secret that reaches output is redacted before it is stored or sent.

## Usage

```bash
cloi                        # interactive session
cloi "add tests for auth"   # one request, then exit
cloi --continue             # resume the last session here
cloi setup                  # re-pick models
```

In a session: `/model`, `/tools`, `/plan`, `/usage`, `/sessions`, `/help`.
Ctrl+C interrupts a turn; Ctrl+D exits.

## Documentation

- [docs/models.md](docs/models.md) — how models are chosen, and the benchmark behind the catalog
- [docs/internals.md](docs/internals.md) — the loop, the rails, verification, and what live testing changed
- [docs/configuration.md](docs/configuration.md) — every setting and its default

## Benchmarks

```bash
node bench/compare.js qwen3:8b nemotron-3-nano:4b   # models, inside this loop
node bench/python-tool.js --repeats 8               # does documenting a tool change its use?
```

Both drive the real agent against the real tools, because what matters is how a
model behaves *here*, not on a leaderboard with different tools and prompts.

## Optional web search

Cloi stays local by default, but a coding agent sometimes needs a fact no file in
the workspace holds — a library's current major version, a deprecation notice,
an error string someone else has already hit. Export a You.com API key and a
`web_search` tool appears:

```bash
export YDC_API_KEY="..."   # https://you.com/platform/api-keys
```

Without the key the tool is not offered at all, so nothing changes for a default
install. With it, the first call asks before the query leaves the machine, and
the key itself never reaches a child process or the transcript.

## Known gaps

- Only Ollama. The provider sits behind one module, but nothing else is wired up.
- No sub-agents, no MCP. Web search is optional via `YDC_API_KEY`; everything else is local.
- Hard cross-file debugging is above the ceiling of every model that fits 8 GB — 0/12 in the benchmark, and that is the honest limit.

## License

MIT. See [LICENSE](LICENSE).
