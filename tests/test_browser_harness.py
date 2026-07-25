"""Unit tests for the pure-Python pieces of eval/browser_harness.py (plan
§6.2 tier 2 / §7 Phase 9) that don't need a real browser or network access.
The harness's actual browser-driving behavior is exercised by running it
for real (see the plan's Phase 9 write-up) — that's slow and needs a real
API key, so it's a manual/CI-tier check, not part of this fast unit suite,
the same way eval/smoke_test.py and eval/gepa_optimize.py aren't either.
"""

from types import SimpleNamespace

from eval.browser_harness import _check_mask_leaks
from eval.harness import load_case


def test_case_browser_dataset_path_uses_the_override_when_present():
    """analysis_4's case.yaml sets browser_dataset_path to a CSV — Phase 9
    found live that Pyodide can't read the .xlsx dataset_path uses (no
    prebuilt openpyxl); this is the fallback field that lets the browser
    tier still run against real data."""
    case = load_case("analysis_4")
    assert case.browser_dataset_path.name == "data.csv"
    assert case.browser_dataset_path.exists()
    assert case.dataset_path.suffix == ".xlsx"


def test_case_mask_spec_absent_by_default():
    case = load_case("analysis_4")
    assert case.mask_spec_path.exists() is False
    assert case.forbidden_values is None


def test_check_mask_leaks_is_a_noop_without_a_mask_spec():
    case = SimpleNamespace(forbidden_values=None)
    assert _check_mask_leaks(case, [b"anything at all"]) == []


def test_check_mask_leaks_detects_a_leaked_value():
    case = SimpleNamespace(forbidden_values=["90000", "Alice"])
    bodies = [b'{"messages":[{"role":"user","content":"the salary is 90000"}]}']
    assert _check_mask_leaks(case, bodies) == ["90000"]


def test_check_mask_leaks_passes_when_nothing_forbidden_appears():
    case = SimpleNamespace(forbidden_values=["90000", "Alice"])
    bodies = [b'{"messages":[{"role":"user","content":"the salary is [masked]"}]}']
    assert _check_mask_leaks(case, bodies) == []
