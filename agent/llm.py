"""Thin Mistral chat-completions client.

Deliberately not the ``mistralai`` SDK — the raw HTTP call is small enough
that ``httpx`` (already a project dependency) covers it, and it keeps
requirements-eval.txt minimal. Swapping providers later (per plan §3.6) just
means adding another module with the same ``complete()`` signature.
"""

from __future__ import annotations

import os

import httpx

API_URL = "https://api.mistral.ai/v1/chat/completions"
DEFAULT_MODEL = "mistral-medium-latest"


class MistralError(RuntimeError):
    pass


def _api_key() -> str:
    key = os.environ.get("MISTRAL_KEY")
    if not key:
        raise MistralError(
            "MISTRAL_KEY is not set. Add it to .env (see .env.example) — "
            "this is a Runtime-scoped secret, never commit a filled-in .env."
        )
    return key


def complete(
    messages: list[dict],
    tools: list[dict] | None = None,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 2000,
    timeout: float = 90.0,
) -> dict:
    """One chat-completions call. Returns the raw `message` dict from choice 0."""
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    resp = httpx.post(
        API_URL,
        headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"},
        json=payload,
        timeout=timeout,
    )
    if resp.status_code != 200:
        raise MistralError(f"Mistral API error {resp.status_code}: {resp.text[:500]}")

    data = resp.json()
    choice = data["choices"][0]
    usage = data.get("usage", {})
    return {"message": choice["message"], "finish_reason": choice["finish_reason"], "usage": usage}


def as_lm_callable(model: str = DEFAULT_MODEL, max_tokens: int = 4000):
    """A plain-string-in/plain-string-out callable satisfying GEPA's
    ``LanguageModel`` protocol (``gepa.proposer.reflective_mutation.base``).

    GEPA's own string-model shortcut routes through ``litellm``, which isn't
    a project dependency (and would need MISTRAL_API_KEY under litellm's own
    naming convention, not our MISTRAL_KEY). This avoids that dependency
    entirely and reuses the same client as the agent loop.
    """

    def call(prompt: str | list[dict]) -> str:
        messages = prompt if isinstance(prompt, list) else [{"role": "user", "content": prompt}]
        result = complete(messages, model=model, max_tokens=max_tokens)
        return result["message"].get("content") or ""

    return call
