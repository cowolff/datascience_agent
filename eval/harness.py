"""Standalone eval harness (plan §6.2, tier 1) — loads a fixture case,
drives the agent loop against it with a given candidate system prompt, and
returns the run for scoring. No browser, no Pyodide/webR, no masking: just
the real agent loop (agent/loop.py) against real fixture data, per the
sequencing decision in plan §6/§7 Phase 1.
"""

from __future__ import annotations

import json
import pathlib

import yaml

from agent.loop import AgentRun, run_agent

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
CASES_DIR = pathlib.Path(__file__).resolve().parent / "cases"


class Case:
    def __init__(self, case_dir: pathlib.Path):
        self.dir = case_dir
        self.meta = yaml.safe_load((case_dir / "case.yaml").read_text())
        self.questions = yaml.safe_load((case_dir / "questions.yaml").read_text())
        rubric_path = case_dir / "rubric.yaml"
        self.rubric = yaml.safe_load(rubric_path.read_text()) if rubric_path.exists() else None

    @property
    def name(self) -> str:
        return self.meta["name"]

    @property
    def dataset_path(self) -> pathlib.Path:
        return REPO_ROOT / self.meta["dataset_path"]

    @property
    def browser_dataset_path(self) -> pathlib.Path:
        """Used by eval/browser_harness.py (plan §6.2 tier 2 / §7 Phase 9)
        instead of dataset_path when a case needs a different file for the
        browser sandbox (e.g. a format the production Pyodide/webR
        environment can't read yet — see case.yaml's own comment for why
        analysis_4 has one). Falls back to dataset_path for any case that
        doesn't need the distinction."""
        return REPO_ROOT / self.meta.get("browser_dataset_path", self.meta["dataset_path"])

    @property
    def mask_spec_path(self) -> pathlib.Path:
        return self.dir / "mask_spec.json"

    @property
    def forbidden_values(self) -> list[str] | None:
        """Values that must never appear in any network payload, for a
        mask_spec case (plan §6.1/§6.2's privacy-regression fixture).
        Deliberately simple for now: `mask_spec.json` lists literal
        forbidden values directly (`{"forbidden_values": [...]}`) rather
        than row/col coordinates re-derived against the dataset the way
        static/js/masking.js's computeForbiddenValues() does — no case
        uses this yet, so replicating that row/col logic server-side in
        Python isn't justified until one actually needs it. None (nothing
        to check) if the file doesn't exist."""
        if not self.mask_spec_path.exists():
            return None
        return json.loads(self.mask_spec_path.read_text()).get("forbidden_values", [])


def load_case(case_name: str) -> Case:
    case_dir = CASES_DIR / case_name
    if not case_dir.is_dir():
        raise FileNotFoundError(f"No such eval case: {case_dir}")
    return Case(case_dir)


def build_user_prompt(case: Case) -> str:
    lines = [
        "You are analyzing a real dataset on disk. Absolute path (use exactly this "
        f"path in your code, quoted, since it contains spaces):\n{case.dataset_path}",
        "",
        "Research question(s):",
    ]
    for q in case.questions:
        lines.append(f"- {q['text'].strip()}")
    lines.append("")
    lines.append(
        "Produce a written report answering the question(s) above. Use your "
        "tools to actually load and analyze the data — don't guess at column "
        "names or values, discover them."
    )
    return "\n".join(lines)


def run_case(case_name: str, system_prompt: str, model: str | None = None, max_turns: int = 25) -> tuple[Case, AgentRun]:
    case = load_case(case_name)
    user_prompt = build_user_prompt(case)
    kwargs = {"max_turns": max_turns}
    if model:
        kwargs["model"] = model
    run = run_agent(system_prompt=system_prompt, user_prompt=user_prompt, **kwargs)
    return case, run
