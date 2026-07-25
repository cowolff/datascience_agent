"""Tool schemas + local execution for the standalone eval harness.

This stands in for the client-side Pyodide/webR workers described in
plans/online-data-science-agent.md §3.2/§6.2 (tier 1, "standalone harness").
Code runs as a real local subprocess against the real fixture dataset — no
masking, no sandboxing, no browser involved. That's intentional at this
stage: eval fixtures are non-sensitive, checked-in dev data (§6.1), so the
standalone tier optimizes for "what would a competent analyst produce",
not for production sandboxing fidelity (that comes later, in §7 Phase 9).
"""

from __future__ import annotations

import shutil
import subprocess
import textwrap
from dataclasses import dataclass

TIMEOUT_SECONDS = 60
MAX_OUTPUT_CHARS = 8000

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "run_python",
            "description": (
                "Execute Python 3 code in a fresh local process (pandas, numpy, "
                "scipy, statsmodels, openpyxl are available) and return its "
                "stdout/stderr. Each call is a new process — no state persists "
                "between calls, so re-load the dataset each time you need it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python source to execute."},
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_r",
            "description": (
                "Execute R code via Rscript in a fresh local process and return "
                "its stdout/stderr. Each call is a new process — no state "
                "persists between calls."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "R source to execute."},
                },
                "required": ["code"],
            },
        },
    },
]


@dataclass
class ToolResult:
    ok: bool
    output: str


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n... [truncated, {len(text) - MAX_OUTPUT_CHARS} more chars]"


def _run_subprocess(cmd: list[str]) -> ToolResult:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(ok=False, output=f"Timed out after {TIMEOUT_SECONDS}s.")

    parts = []
    if proc.stdout:
        parts.append(proc.stdout)
    if proc.returncode != 0:
        parts.append(f"[exit code {proc.returncode}]")
        if proc.stderr:
            parts.append(proc.stderr)
    output = "\n".join(parts).strip() or "(no output)"
    return ToolResult(ok=proc.returncode == 0, output=_truncate(output))


def run_python(code: str) -> ToolResult:
    return _run_subprocess(["python3", "-c", textwrap.dedent(code)])


def run_r(code: str) -> ToolResult:
    if shutil.which("Rscript") is None:
        return ToolResult(
            ok=False,
            output=(
                "R is not available in this standalone harness environment "
                "(Rscript not found on PATH). Use run_python instead, or ask "
                "the operator to install R. This mirrors the webR "
                "package-availability risk flagged in the plan's §8 — a real "
                "constraint, not a harness bug."
            ),
        )
    return _run_subprocess(["Rscript", "-e", code])


DISPATCH = {"run_python": run_python, "run_r": run_r}


def dispatch_tool(name: str, arguments: dict) -> ToolResult:
    fn = DISPATCH.get(name)
    if fn is None:
        return ToolResult(ok=False, output=f"Unknown tool '{name}'.")
    code = arguments.get("code", "")
    return fn(code)
