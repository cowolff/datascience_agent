"""GEPAAdapter wiring the standalone harness + metric into GEPA (plan §6.4).

DataInst = case name (str, matches a directory under eval/cases/).
Trajectory = a small dict capturing what make_reflective_dataset needs.
RolloutOutput = the final report text (or None on failure).

Only one component is optimized: "system_prompt" (agent/prompts.py). Tool
descriptions / masking guidance are future components per the plan's
§6.4 note — not wired yet, since Phase 1 is scoped to the seed system
prompt only.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from gepa.core.adapter import EvaluationBatch, GEPAAdapter

from eval import harness, metric


class StandaloneHarnessAdapter(GEPAAdapter):
    def __init__(self, model: str | None = None, max_turns: int = 10):
        self.model = model
        self.max_turns = max_turns

    def evaluate(
        self,
        batch: list[str],
        candidate: dict[str, str],
        capture_traces: bool = False,
    ) -> EvaluationBatch:
        system_prompt = candidate["system_prompt"]
        outputs = []
        scores = []
        trajectories = [] if capture_traces else None

        for case_name in batch:
            try:
                case, run = harness.run_case(
                    case_name, system_prompt, model=self.model, max_turns=self.max_turns
                )
                result = metric.score_run(case, run)
            except Exception as exc:  # noqa: BLE001 - see adapter contract: never raise per-example
                outputs.append(None)
                scores.append(0.0)
                if capture_traces:
                    trajectories.append(
                        {"case_name": case_name, "error": str(exc), "final_text": None, "feedback": str(exc)}
                    )
                continue

            outputs.append(run.final_text)
            scores.append(result.score)
            if capture_traces:
                trajectories.append(
                    {
                        "case_name": case_name,
                        "question": case.questions[0]["text"] if case.questions else "",
                        "final_text": run.final_text,
                        "feedback": result.feedback,
                        "score": result.score,
                        "tool_calls": len(run.tool_calls),
                        "stopped_reason": run.stopped_reason,
                    }
                )

        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories)

    def make_reflective_dataset(
        self,
        candidate: dict[str, str],
        eval_batch: EvaluationBatch,
        components_to_update: list[str],
    ) -> Mapping[str, Sequence[Mapping[str, Any]]]:
        records = []
        for traj in eval_batch.trajectories or []:
            records.append(
                {
                    "Inputs": {"question": traj.get("question", "")},
                    "Generated Outputs": traj.get("final_text") or "(no final report produced)",
                    "Feedback": traj.get("feedback", ""),
                }
            )
        # Only one component ("system_prompt") is ever registered — see the
        # class docstring — so the same reflective dataset drives its update
        # regardless of what components_to_update contains.
        return {name: records for name in components_to_update}
