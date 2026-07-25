"""Production-fidelity eval harness (plan §6.2 tier 2 / §7 Phase 9).

Unlike eval/harness.py (Phase 1's standalone tier — a local Python
subprocess, no browser), this drives the *actual* deployed SPA headlessly
via Playwright: real Flask server, real page load, real Pyodide/webR
execution inside the browser, the real `/api/config` system prompt, the
real `/api/llm-call` proxy. The point is to confirm the prompt GEPA
optimized against the standalone tier still holds up once every layer of
the real product — worker message-passing, OPFS, the actual masking
pipeline, actual WASM package availability — is in the loop, not just
assumed to transfer.

Reuses eval/harness.py's Case loading and eval/metric.py's scoring
unchanged: only the *execution* environment differs between tiers, not
the fixtures or the grading. `run_case_in_browser()` returns the same
(Case, AgentRun) shape eval.harness.run_case() does, so
eval.metric.score_run(case, run) works on either tier's output.

CLI (case_name is the directory under eval/cases/, e.g. "analysis_4" —
not the `name:` field inside that case's case.yaml, which is a separate,
purely descriptive label):
    python -m eval.browser_harness analysis_4
    python -m eval.browser_harness analysis_4 --model mistral-small-latest --min-score 0.5
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

from dotenv import load_dotenv

from agent.loop import AgentRun, ToolCallRecord
from eval import metric
from eval.harness import Case, REPO_ROOT, load_case

RESULTS_DIR = pathlib.Path(__file__).resolve().parent / "results"
SERVER_START_TIMEOUT_SECONDS = 20
PER_QUESTION_TIMEOUT_MS = 180_000  # generous: a real question can involve several tool calls, incl. package installs


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_server(base_url: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(base_url + "/", timeout=2)
            return
        except (urllib.error.URLError, ConnectionError) as exc:
            last_error = exc
            time.sleep(0.3)
    raise RuntimeError(f"Flask server at {base_url} did not become ready in time: {last_error}")


@contextlib.contextmanager
def _running_flask_server():
    """Spins up the real app.py (not a mock) as a subprocess on an
    ephemeral port, so this harness is self-contained — no "start the
    server first" manual step, which matters for wiring this into CI
    (plan §6.7)."""
    load_dotenv(dotenv_path=REPO_ROOT / ".env")
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"

    env = dict(os.environ)
    env["FLASK_APP"] = "app.py"
    proc = subprocess.Popen(
        [sys.executable, "-m", "flask", "run", "--port", str(port)],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        _wait_for_server(base_url, SERVER_START_TIMEOUT_SECONDS)
        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _set_provider_settings(page: Page, model: str | None) -> None:
    """Forces hosted mode with an explicit model override, written to
    localStorage before any app script runs — the same storage key
    static/js/settings.js reads. Only touches hosted mode: this harness
    exercises our own proxy/logging path, not custom-endpoint mode."""
    settings = {
        "mode": "hosted",
        "hostedModel": model or "",
        "customBaseUrl": "",
        "customApiKey": "",
        "customModel": "",
        "customAdapter": "openai",
    }
    page.add_init_script(
        f"window.localStorage.setItem('bench.providerSettings.v1', {json.dumps(json.dumps(settings))});"
    )


def _disable_hitl(page: Page) -> None:
    """Human-in-the-loop tools (plans/human-in-the-loop-tools.md) pause the
    agent loop waiting for a real person to click a prompt card — a
    headless Playwright run has no one to click it, so left alone every
    case that triggers one would sit for the full ~10 minute HITL timeout
    before falling back. Same trick as _set_provider_settings: an
    add_init_script runs before any app script, so workbench.js's own
    `if (!window.__BENCH_DISABLE_HITL__)` guard sees this before it ever
    installs the real UI-backed provider, and HITL tools degrade to their
    always-available no-op default (immediate "not answered") instead."""
    page.add_init_script("window.__BENCH_DISABLE_HITL__ = true;")


def _wait_for_python_ready(page: Page, timeout_ms: int = 60_000) -> None:
    page.wait_for_selector("#python-status:has-text(\"ready\")", timeout=timeout_ms)


def _count_matching(page: Page, selector: str) -> int:
    return page.locator(selector).count()


def _drive_one_question(page: Page, question_text: str) -> tuple[str | None, str, list[ToolCallRecord]]:
    """Sends one message through the real composer and waits for the turn
    to finish. Returns (final_text_or_None, stopped_reason, new_tool_calls).

    Completion is detected via tag+class combinations that are unique to
    workbench.js's own rendering functions (checked against
    static/js/workbench.js, not guessed): appendFinalText's bubble is the
    only `div.leading-relaxed` in #messages; appendErrorText's bubble
    (both the generic error path and the "gave up after max turns" path)
    is the only `div.text-rose-700`. A tool *result* is rendered as a
    `<pre>`, not a `<div>`, so it can't collide with either selector even
    though the CSS class list overlaps."""
    final_selector = "#messages div.leading-relaxed"
    error_selector = "#messages div.text-rose-700"
    tool_card_selector = "#messages span.font-mono"

    final_before = _count_matching(page, final_selector)
    error_before = _count_matching(page, error_selector)
    tool_before = _count_matching(page, tool_card_selector)

    page.fill("#composer-input", question_text)
    page.click("#composer-send")

    page.wait_for_function(
        """([finalSel, errorSel, finalBefore, errorBefore]) => {
            return document.querySelectorAll(finalSel).length > finalBefore
                || document.querySelectorAll(errorSel).length > errorBefore;
        }""",
        arg=[final_selector, error_selector, final_before, error_before],
        timeout=PER_QUESTION_TIMEOUT_MS,
    )
    page.wait_for_timeout(300)  # let the DOM settle after the triggering event

    tool_names = page.locator(tool_card_selector).all_inner_texts()[tool_before:]
    new_tool_calls = [ToolCallRecord(name=n, arguments={}, ok=True, output="") for n in tool_names]

    final_count = _count_matching(page, final_selector)
    if final_count > final_before:
        final_text = page.locator(final_selector).last.inner_text()
        return final_text, "final_message", new_tool_calls

    error_text = page.locator(error_selector).last.inner_text()
    stopped_reason = "max_turns" if "too many turns" in error_text.lower() else f"error: {error_text}"
    return None, stopped_reason, new_tool_calls


def _check_mask_leaks(case: Case, request_bodies: list[bytes]) -> list[str]:
    """Privacy regression check (plan §6.1/§6.2): for a mask_spec case,
    assert none of the values that spec marks hidden ever appear in any
    payload this harness saw cross the network boundary (every POST to
    /api/llm-call — the only place, per plan §3.4, request/response
    bodies exist in transit at all). Returns a list of leaked values
    found (empty = passed). A no-op for cases without a mask_spec, since
    there's nothing to check."""
    forbidden = getattr(case, "forbidden_values", None)
    if not forbidden:
        return []
    leaks = []
    for value in forbidden:
        if any(value.encode() in body for body in request_bodies):
            leaks.append(value)
    return leaks


def run_case_in_browser(
    case_name: str,
    model: str | None = None,
    base_url: str | None = None,
    headless: bool = True,
) -> tuple[Case, AgentRun, list[str]]:
    """Returns (case, run, mask_leaks) — run is AgentRun-shaped so
    eval.metric.score_run(case, run) works unchanged; mask_leaks is a
    separate hard-fail signal per plan §6.3(b), not folded into the score.

    Imports playwright lazily (not at module top-level) so that importing
    this module — e.g. tests/test_browser_harness.py's unit tests of the
    pure-logic helpers — doesn't require requirements-eval.txt's Playwright
    dependency at all unless a browser run is actually requested."""
    from playwright.sync_api import sync_playwright

    case = load_case(case_name)

    server_ctx = contextlib.nullcontext(base_url) if base_url else _running_flask_server()

    with server_ctx as resolved_base_url:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox"], headless=headless)
            context = browser.new_context()
            page = context.new_page()

            request_bodies: list[bytes] = []

            def _capture(request):
                if request.url.endswith("/api/llm-call") and request.method == "POST":
                    body = request.post_data
                    if body:
                        request_bodies.append(body.encode("utf-8", errors="ignore"))

            page.on("request", _capture)
            _set_provider_settings(page, model)
            _disable_hitl(page)

            all_tool_calls: list[ToolCallRecord] = []
            final_text: str | None = None
            stopped_reason = "error: harness never ran a question"

            try:
                page.goto(resolved_base_url + "/workbench", wait_until="domcontentloaded")
                page.wait_for_selector("#composer-input")

                # Same ingestion path a real user uses: the file input,
                # not some internal API — plan §6.2's explicit requirement.
                page.set_input_files("#file-input", str(case.browser_dataset_path))
                page.wait_for_selector("#dataset-list li")
                _wait_for_python_ready(page)

                dataset_filename = case.browser_dataset_path.name
                for i, question in enumerate(case.questions):
                    text = question["text"].strip()
                    if i == 0:
                        # The standalone tier's build_user_prompt() (eval/harness.py)
                        # tells the model the dataset's exact path explicitly.
                        # A real chat user does the same just by having
                        # uploaded the file this turn — without this, the
                        # model has to guess the filename from a bare
                        # research question, and a first real run here
                        # caught it doing exactly that: hallucinating a
                        # plausible-sounding filename instead of checking,
                        # producing a report that never touched real data.
                        # This mirrors that same courtesy, not a hint the
                        # standalone tier lacks.
                        text = f"Using the uploaded file /data/{dataset_filename}, answer: {text}"
                    final_text, stopped_reason, new_calls = _drive_one_question(page, text)
                    all_tool_calls.extend(new_calls)
                    if stopped_reason != "final_message":
                        break  # later questions in the same conversation can't proceed without a reply
            finally:
                browser.close()

    run = AgentRun(
        final_text=final_text,
        turns_used=len(all_tool_calls),
        tool_calls=all_tool_calls,
        messages=[],  # the standalone tier's full message log has no browser-DOM equivalent worth reconstructing
        total_tokens=0,  # not observable from the DOM; would need the /api/llm-call response bodies to sum usage
        stopped_reason=stopped_reason,
    )
    mask_leaks = _check_mask_leaks(case, request_bodies)
    return case, run, mask_leaks


def _log_result(case_name: str, model: str | None, result: metric.ScoreResult, mask_leaks: list[str]) -> None:
    RESULTS_DIR.mkdir(exist_ok=True)
    record = {
        "ts": time.time(),
        "tier": "browser",
        "case": case_name,
        "model": model or "(server default)",
        "score": result.score,
        "checks": [{"id": c.id, "passed": c.passed} for c in result.checks],
        "mask_leaks": mask_leaks,
    }
    with (RESULTS_DIR / "browser_harness.jsonl").open("a") as f:
        f.write(json.dumps(record) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_name")
    parser.add_argument("--model", default=None, help="Override the hosted-mode model (default: server's own default).")
    parser.add_argument("--base-url", default=None, help="Use an already-running server instead of spawning one.")
    parser.add_argument("--headed", action="store_true", help="Show the browser window instead of running headless.")
    parser.add_argument("--min-score", type=float, default=0.5, help="Exit non-zero if the score is below this (CI gate).")
    args = parser.parse_args()

    case, run, mask_leaks = run_case_in_browser(
        args.case_name, model=args.model, base_url=args.base_url, headless=not args.headed
    )
    result = metric.score_run(case, run)
    _log_result(args.case_name, args.model, result, mask_leaks)

    print(f"case: {args.case_name}")
    print(f"stopped_reason: {run.stopped_reason}")
    print(f"tool calls made: {len(run.tool_calls)} ({[c.name for c in run.tool_calls]})")
    print(f"score: {result.score:.2f}")
    for check in result.checks:
        print(f"  [{'x' if check.passed else ' '}] {check.id}")
    if not result.checks:
        print(f"  (no checks scored — {result.feedback})")
    if mask_leaks:
        print(f"PRIVACY FAILURE — leaked values seen crossing /api/llm-call: {mask_leaks}")

    ok = result.score >= args.min_score and not mask_leaks
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
