# Running cloi on Terminal-Bench

[Terminal-Bench](https://github.com/laude-institute/terminal-bench) evaluates
agents on ~240 real terminal tasks — fix a broken system Python, recover a
corrupted archive, get a build working — inside Docker containers, scored by
running the task's own pytest suite afterwards. The agent's claims count for
nothing; only whether the tests pass.

These two files plug cloi in.

## Install

```bash
git clone https://github.com/laude-institute/terminal-bench
cd terminal-bench
uv sync

mkdir -p terminal_bench/agents/installed_agents/cloi
cp /path/to/cloi/integrations/terminal-bench/* terminal_bench/agents/installed_agents/cloi/
touch terminal_bench/agents/installed_agents/cloi/__init__.py
```

Then register it in two files:

```python
# terminal_bench/agents/agent_name.py
CLOI = "cloi"

# terminal_bench/agents/agent_factory.py
from terminal_bench.agents.installed_agents.cloi.cloi_agent import CloiAgent
#   ... and add CloiAgent to the list in AGENT_NAME_TO_CLASS
```

## Run

The container needs to reach Ollama on the host, so start Ollama bound to all
interfaces first:

```bash
OLLAMA_HOST=0.0.0.0 ollama serve
```

```bash
tb run \
  --agent cloi \
  --model ollama/nemotron-3-nano:4b \
  --agent-kwarg escalation_model=qwen3:30b-a3b \
  --dataset-name terminal-bench-core --dataset-version 0.1.1 \
  --n-concurrent 1
```

`--n-concurrent 1` matters: a local model is a single GPU serialising every
request, so concurrency buys nothing and distorts the timings.

## What the adapter has to get right

**cloi runs inside the container; the model does not.** The install script
writes `~/.cloi/config.json` pointing at `host.docker.internal` rather than
letting `cloi setup` run — setup would measure a GPU-less container and try to
download models into every task image.

**Node is installed unconditionally.** Task containers are minimal and vary;
cloi needs 22.5+ for `node:sqlite`.

**`--yes` is required.** There is nobody to answer a permission prompt, stdin is
closed, and cloi treats silence as refusal — so without it the agent reads the
task and can never act on it.

**Reachability is checked during install**, so an unreachable Ollama fails
loudly at setup instead of being scored as ~240 tasks the agent could not do.

## Expectation

Low. These tasks are built for frontier models on hard multi-step system work,
and a 4B model that fits 8 GB of VRAM went 0/12 on cross-file debugging in
cloi's own benchmark, which is easier. The value is a real number for what a
local setup does end-to-end, on a leaderboard that currently has no local-model
column at all.

Start with the 63 `difficulty: easy` tasks and raise the timeouts — the defaults
assume an API model, not 20 tokens/second.
