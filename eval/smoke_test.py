"""One real harness run against Mistral, no GEPA involved — the cheap way to
debug the Phase 1 pipeline (agent loop, tools, metric) before ever calling
gepa.optimize. Costs one agent rollout (a handful of Mistral calls), not a
GEPA search.

Usage:
    python3 -m eval.smoke_test
    python3 -m eval.smoke_test --model mistral-medium-latest --max-turns 6
"""

from __future__ import annotations

import argparse
import pathlib
import sys

from dotenv import load_dotenv

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=REPO_ROOT / ".env")

from agent.prompts import SEED_SYSTEM_PROMPT  # noqa: E402
from eval import harness, metric  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", default="analysis_4")
    parser.add_argument("--model", default=None, help="Defaults to agent/llm.py's DEFAULT_MODEL (mistral-medium-latest).")
    parser.add_argument("--max-turns", type=int, default=25)
    args = parser.parse_args()

    print(f"Running case={args.case!r} model={args.model or '(default)'} max_turns={args.max_turns}\n")

    case, run = harness.run_case(args.case, SEED_SYSTEM_PROMPT, model=args.model, max_turns=args.max_turns)

    print(f"stopped_reason: {run.stopped_reason}")
    print(f"turns_used:     {run.turns_used}")
    print(f"total_tokens:   {run.total_tokens}")
    print(f"tool_calls:     {len(run.tool_calls)}")
    for i, tc in enumerate(run.tool_calls, 1):
        status = "ok" if tc.ok else "FAILED"
        preview = tc.output.replace("\n", " ")[:160]
        print(f"  [{i}] {tc.name} ({status}): {preview}")

    print("\n--- final report ---")
    print(run.final_text or "(none)")

    if run.stopped_reason == "final_message":
        result = metric.score_run(case, run)
        print(f"\n--- rubric score: {result.score:.2f} ---")
        for check in result.checks:
            mark = "PASS" if check.passed else "FAIL"
            print(f"  [{mark}] {check.id}")
        print()
        print(result.feedback)


if __name__ == "__main__":
    sys.exit(main())
