"""Terminal-Bench adapter for cloi, a local-first coding agent.

Unlike every other agent here, cloi has no API key and no provider. It talks to
an Ollama server, which for a containerised run lives on the host — so the
interesting configuration is not credentials but reachability, and the failure
this adapter works hardest to prevent is a task scored as "the agent could not
do it" when the truth is that the model was never reachable.
"""

import os
import shlex

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand
from terminal_bench.utils.logger import logger

#: Reaches the host from inside a container on Docker Desktop, and on Linux when
#: the run adds `--add-host=host.docker.internal:host-gateway`.
DEFAULT_OLLAMA_HOST = "http://host.docker.internal:11434"


class CloiAgent(AbstractInstalledAgent):
    """cloi, run one-shot inside the task container against a host Ollama."""

    @staticmethod
    def name() -> str:
        return "cloi"

    def __init__(self, model_name: str | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # `--model provider/name` is the convention across this harness, but an
        # Ollama tag is `qwen3:30b-a3b` — a slash would be wrong, so anything
        # before one is dropped rather than being rejected.
        raw = model_name or os.environ.get("CLOI_MODEL", "qwen3:8b")
        self._model_name = raw.split("/", 1)[-1] if "/" in raw else raw

        self._escalation_model = kwargs.get(
            "escalation_model", os.environ.get("CLOI_ESCALATION_MODEL", "")
        )
        self._context_length = str(
            kwargs.get("context_length", os.environ.get("CLOI_CONTEXT_LENGTH", "16384"))
        )
        self._ollama_host = kwargs.get(
            "ollama_host", os.environ.get("OLLAMA_HOST", DEFAULT_OLLAMA_HOST)
        )
        self._version = kwargs.get("version", "latest")
        self._logger = logger.getChild(__name__)

    @property
    def _env(self) -> dict[str, str]:
        # No API key: everything here is about finding the model, not paying for
        # it. Passed through the install script, which writes cloi's config.
        return {
            "CLOI_MODEL": self._model_name,
            "CLOI_ESCALATION_MODEL": self._escalation_model,
            "CLOI_CONTEXT_LENGTH": self._context_length,
            "OLLAMA_HOST": self._ollama_host,
        }

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return self._get_templated_script_path("cloi-setup.sh.j2")

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        # `--yes` because there is nobody to answer a permission prompt. Without
        # it cloi denies every write and shell command — stdin is closed, and
        # silence is treated as refusal — so the agent would read the task and
        # then be unable to act on it.
        return [
            TerminalCommand(
                command=f"cloi --yes {shlex.quote(instruction)}",
                min_timeout_sec=0.0,
                # A local model on consumer hardware runs at a fraction of an
                # API model's speed. The harness's own per-task timeout is the
                # real bound; this must not cut in before it.
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            ),
        ]
