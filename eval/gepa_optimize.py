"""GEPA prompt optimization entry point (plan §6.4 / §7 Phase 1).

Wiring only, by design: this script defaults to a --dry-run that constructs
the trainset/valset/adapter/seed candidate and prints what *would* run,
without spending a single API call. The actual optimization search fans out
many metric calls (each an agent rollout, each an LLM reflection call) —
real money — so it only runs with an explicit --run flag, and even then
defaults to a tiny --max-metric-calls for a smoke test, not a full search.

Usage:
    python3 -m eval.gepa_optimize                       # dry run, no API calls
    python3 -m eval.gepa_optimize --run --max-metric-calls 6   # tiny smoke test
"""

from __future__ import annotations

import argparse
import pathlib
import sys

from dotenv import load_dotenv

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=REPO_ROOT / ".env")

from agent.llm import as_lm_callable  # noqa: E402
from agent.prompts import SEED_SYSTEM_PROMPT  # noqa: E402
from eval.adapter import StandaloneHarnessAdapter  # noqa: E402

# All cases currently checked in under eval/cases/. Phase 1 has exactly one,
# trimmed to the primary question (see eval/cases/analysis_4/case.yaml).
ALL_CASES = ["analysis_4"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Actually call gepa.optimize (spends API credits).")
    parser.add_argument("--task-model", default=None, help="Model for agent rollouts (default: agent/llm.py's default).")
    parser.add_argument("--reflection-model", default="mistral-large-latest", help="Model for GEPA's reflective proposer.")
    parser.add_argument("--max-metric-calls", type=int, default=6, help="Hard cap on rollouts — keep tiny for smoke tests.")
    args = parser.parse_args()

    seed_candidate = {"system_prompt": SEED_SYSTEM_PROMPT}
    trainset = ALL_CASES
    valset = ALL_CASES  # same tiny set for train/val at this stage — real GEPA runs need a proper split
    adapter = StandaloneHarnessAdapter(model=args.task_model)

    print("GEPA optimization — wiring summary")
    print(f"  cases (trainset=valset): {trainset}")
    print(f"  seed component(s): {list(seed_candidate.keys())}")
    print(f"  task model: {args.task_model or '(agent/llm.py default)'}")
    print(f"  reflection model: {args.reflection_model}")
    print(f"  max_metric_calls: {args.max_metric_calls}")

    if not args.run:
        print("\nDry run only (default) — no API calls made. Pass --run to actually optimize.")
        return

    import gepa  # imported lazily so --dry-run never needs it installed correctly configured

    print("\nRunning gepa.optimize — this WILL spend API credits.")
    result = gepa.optimize(
        seed_candidate=seed_candidate,
        trainset=trainset,
        valset=valset,
        adapter=adapter,
        # A callable, not the bare model-name string: GEPA's string shortcut
        # routes through litellm (not a project dependency, and expects
        # MISTRAL_API_KEY under its own naming convention) — see
        # agent.llm.as_lm_callable's docstring.
        reflection_lm=as_lm_callable(args.reflection_model),
        max_metric_calls=args.max_metric_calls,
        display_progress_bar=True,
    )
    print("\nBest candidate:")
    print(result.best_candidate["system_prompt"])
    print(f"\nBest score: {result.best_score if hasattr(result, 'best_score') else '(see result object)'}")


if __name__ == "__main__":
    sys.exit(main())
