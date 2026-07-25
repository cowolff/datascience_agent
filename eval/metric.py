"""Scoring for a harness run against a case's rubric (plan §6.3).

Deliberately coarse for Phase 1 debugging: substring/regex checks only, no
numeric-tolerance parsing and no LLM-judge fallback yet (those are called
out in the plan as later refinements, not blockers for wiring the pipeline).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from agent.loop import AgentRun
from eval.harness import Case


@dataclass
class CheckResult:
    id: str
    passed: bool
    feedback: str


@dataclass
class ScoreResult:
    score: float  # in [0, 1], higher is better
    checks: list[CheckResult] = field(default_factory=list)
    feedback: str = ""


def _check_contains_any(text: str, values: list[str]) -> bool:
    lowered = text.lower()
    return any(v.lower() in lowered for v in values)


def _check_regex(text: str, pattern: str) -> bool:
    return re.search(pattern, text, re.IGNORECASE | re.DOTALL) is not None


def score_run(case: Case, run: AgentRun) -> ScoreResult:
    if run.stopped_reason != "final_message" or not run.final_text:
        return ScoreResult(
            score=0.0,
            checks=[],
            feedback=(
                f"Run did not produce a final report (stopped_reason="
                f"{run.stopped_reason!r}). No rubric checks could be scored."
            ),
        )

    report = run.final_text
    rubric = case.rubric or {"checks": []}

    results: list[CheckResult] = []
    for check in rubric["checks"]:
        if check["type"] == "contains_any":
            passed = _check_contains_any(report, check["values"])
        elif check["type"] == "regex":
            passed = _check_regex(report, check["pattern"])
        else:
            raise ValueError(f"Unknown rubric check type: {check['type']}")
        results.append(
            CheckResult(
                id=check["id"],
                passed=passed,
                feedback="" if passed else check.get("feedback_if_failed", "Check failed.").strip(),
            )
        )

    total_weight = sum(c.get("weight", 1) for c in rubric["checks"]) or 1
    earned = sum(
        check_cfg.get("weight", 1)
        for check_cfg, result in zip(rubric["checks"], results)
        if result.passed
    )
    score = earned / total_weight

    failed = [r for r in results if not r.passed]
    if failed:
        feedback = "Failed checks:\n" + "\n".join(f"- {r.id}: {r.feedback}" for r in failed)
    else:
        feedback = "All rubric checks passed."

    return ScoreResult(score=score, checks=results, feedback=feedback)
