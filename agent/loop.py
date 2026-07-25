"""The agent orchestration loop — model call -> tool_use -> local execution ->
tool_result -> model call again -> ... -> final report.

Stands in for the client-side loop in plans/online-data-science-agent.md §2
(there it runs in the browser; here it runs in this local process, which is
exactly what makes it reusable as the standalone eval harness in §6.2).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from . import llm
from .tools import TOOL_SCHEMAS, dispatch_tool

MAX_TURNS_DEFAULT = 25  # kept in sync with static/js/agent-loop.js's MAX_TURNS


@dataclass
class ToolCallRecord:
    name: str
    arguments: dict
    ok: bool
    output: str


@dataclass
class AgentRun:
    final_text: str | None
    turns_used: int
    tool_calls: list[ToolCallRecord]
    messages: list[dict]
    total_tokens: int
    stopped_reason: str  # "final_message" | "max_turns" | "error"


def run_agent(
    system_prompt: str,
    user_prompt: str,
    model: str = llm.DEFAULT_MODEL,
    max_turns: int = MAX_TURNS_DEFAULT,
) -> AgentRun:
    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    tool_calls: list[ToolCallRecord] = []
    total_tokens = 0

    for turn in range(max_turns):
        try:
            result = llm.complete(messages, tools=TOOL_SCHEMAS, model=model)
        except llm.MistralError as exc:
            return AgentRun(
                final_text=None,
                turns_used=turn,
                tool_calls=tool_calls,
                messages=messages,
                total_tokens=total_tokens,
                stopped_reason=f"error: {exc}",
            )

        total_tokens += result["usage"].get("total_tokens", 0)
        message = result["message"]
        messages.append(message)

        calls = message.get("tool_calls")
        if not calls:
            return AgentRun(
                final_text=message.get("content"),
                turns_used=turn + 1,
                tool_calls=tool_calls,
                messages=messages,
                total_tokens=total_tokens,
                stopped_reason="final_message",
            )

        for call in calls:
            name = call["function"]["name"]
            try:
                arguments = json.loads(call["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                arguments = {}
            outcome = dispatch_tool(name, arguments)
            tool_calls.append(ToolCallRecord(name=name, arguments=arguments, ok=outcome.ok, output=outcome.output))
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "name": name,
                    "content": outcome.output,
                }
            )

    return AgentRun(
        final_text=None,
        turns_used=max_turns,
        tool_calls=tool_calls,
        messages=messages,
        total_tokens=total_tokens,
        stopped_reason="max_turns",
    )
