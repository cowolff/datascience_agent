import json

import httpx

from app import MAX_UPSTREAM_ATTEMPTS, app, _sanitize_dataset_meta, _sanitize_session_id
from agent.prompts import SEED_SYSTEM_PROMPT


def test_config_returns_system_prompt():
    """The client fetches its system prompt from here rather than a hand-
    copied JS duplicate, so agent/prompts.py stays the single source of
    truth GEPA (plan §6.4) mutates. Assert the wiring, not the exact text."""
    client = app.test_client()
    resp = client.get("/api/config")
    assert resp.status_code == 200
    assert resp.get_json()["systemPrompt"] == SEED_SYSTEM_PROMPT


def test_root_returns_200():
    """`/` is the landing page (not the workbench) — it introduces Bench
    and links out to `/workbench`."""
    client = app.test_client()
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Bench" in resp.data


def test_root_does_not_redirect():
    """atlasflow's health check hits `/` anonymously and expects a fast
    2xx with no redirect (e.g. to a login page) — see README. This is a
    trivial assertion today since the template has no auth at all, but
    keep it once you add any: a redirect here silently fails deploys."""
    client = app.test_client()
    resp = client.get("/", follow_redirects=False)
    assert resp.status_code < 300


def test_root_links_to_workbench_in_a_new_tab():
    """The landing page's primary CTA must open the workbench at its own
    route, in a new tab — not navigate the landing page away."""
    client = app.test_client()
    resp = client.get("/")
    assert b'href="/workbench"' in resp.data
    assert b'target="_blank"' in resp.data


def test_workbench_returns_200_and_still_gates_on_tos():
    """The chat/file-upload agent UI now lives at `/workbench` (moved off
    `/`). It must keep including the TOS gate markup — regression guard
    against the route move accidentally dropping the include."""
    client = app.test_client()
    resp = client.get("/workbench")
    assert resp.status_code == 200
    assert b"Bench" in resp.data
    assert b"tos-overlay" in resp.data
    assert b"Terms of Service" in resp.data


def test_design_returns_200():
    """Design-principles/priorities/tool-catalog detail page linked from
    the landing page."""
    client = app.test_client()
    resp = client.get("/design")
    assert resp.status_code == 200
    assert b"Design principles" in resp.data
    assert b"Tool catalog" in resp.data


def test_settings_returns_200():
    """Provider settings (plan §3.6/§7 Phase 7) — the page itself is static;
    everything about a chosen provider lives client-side in localStorage,
    so there's nothing else for the backend to assert here."""
    client = app.test_client()
    resp = client.get("/settings")
    assert resp.status_code == 200
    assert b"Settings" in resp.data


def test_llm_call_requires_messages():
    client = app.test_client()
    resp = client.post("/api/llm-call", json={"model": "mistral-small-latest"})
    assert resp.status_code == 400


def test_llm_call_requires_json_body():
    client = app.test_client()
    resp = client.post("/api/llm-call", data="not json", content_type="text/plain")
    assert resp.status_code == 400


def test_llm_call_without_api_key_is_server_error(monkeypatch):
    monkeypatch.delenv("MISTRAL_KEY", raising=False)
    client = app.test_client()
    resp = client.post("/api/llm-call", json={"messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 500


def test_llm_call_upstream_timeout_returns_504_not_502(monkeypatch):
    """Phase 10 hardening: a hung/slow upstream is a distinct failure mode
    from a connection actively failing, and should read as a timeout to
    whatever's calling this proxy, not a generic "upstream refused" 502."""
    monkeypatch.setenv("MISTRAL_KEY", "test-key")

    def timed_out_post(*args, **kwargs):
        raise httpx.ReadTimeout("timed out")

    monkeypatch.setattr("app.httpx.post", timed_out_post)
    client = app.test_client()
    resp = client.post("/api/llm-call", json={"messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 504


def test_llm_call_retries_transient_connection_errors_then_succeeds(monkeypatch):
    """A connection reset/refused talking to Mistral is usually a blip on
    that one hop, not the model being down. Before the retry loop, the very
    first blip surfaced as "Upstream request failed." straight to the agent
    loop, which has no recovery path of its own and just ends the turn —
    assert a transient failure that clears within MAX_UPSTREAM_ATTEMPTS
    succeeds instead."""
    monkeypatch.setenv("MISTRAL_KEY", "test-key")
    monkeypatch.setattr("app.time.sleep", lambda *_: None)

    calls = {"n": 0}

    class FakeResponse:
        status_code = 200
        headers = {"content-type": "application/json"}

        def json(self):
            return {"choices": [{"message": {"content": "hi"}}]}

    def flaky_post(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] < MAX_UPSTREAM_ATTEMPTS:
            raise httpx.ConnectError("connection reset")
        return FakeResponse()

    monkeypatch.setattr("app.httpx.post", flaky_post)
    client = app.test_client()
    resp = client.post("/api/llm-call", json={"messages": [{"role": "user", "content": "hi"}]})

    assert resp.status_code == 200
    assert calls["n"] == MAX_UPSTREAM_ATTEMPTS


def test_llm_call_gives_up_after_max_retries_returns_502(monkeypatch):
    """The retry loop still has a floor: a persistently broken upstream
    (not just a one-off blip) must give up and report 502, not retry
    forever."""
    monkeypatch.setenv("MISTRAL_KEY", "test-key")
    monkeypatch.setattr("app.time.sleep", lambda *_: None)

    calls = {"n": 0}

    def always_broken_post(*args, **kwargs):
        calls["n"] += 1
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr("app.httpx.post", always_broken_post)
    client = app.test_client()
    resp = client.post("/api/llm-call", json={"messages": [{"role": "user", "content": "hi"}]})

    assert resp.status_code == 502
    assert resp.get_json() == {"error": "Upstream request failed."}
    assert calls["n"] == MAX_UPSTREAM_ATTEMPTS


def test_llm_call_body_over_max_content_length_returns_json_413():
    """Phase 10 hardening review of the plan §5 proxy body-size limit: the
    limit already existed (MAX_CONTENT_LENGTH), but without an explicit
    handler Werkzeug renders its default HTML error page — assert this API
    returns the same JSON error shape as every other failure here."""
    client = app.test_client()
    oversized = "x" * (app.config["MAX_CONTENT_LENGTH"] + 1)
    resp = client.post("/api/llm-call", data=oversized, content_type="application/json")
    assert resp.status_code == 413
    assert resp.get_json() == {"error": "Request body too large."}


def test_unhandled_exception_returns_generic_error_without_leaking_details(monkeypatch, capsys):
    """Traceback redaction (plan §7 Phase 10): an unexpected, non-httpx
    exception must never put its own message (which could echo back
    request content) into the HTTP response or the stdout log — only a
    generic error to the client and a structured {error_type, path} line
    to stdout, the same discipline §3.7 already applies to message bodies."""
    monkeypatch.setenv("MISTRAL_KEY", "test-key")
    secret_detail = "unexpected internal detail: patient_ssn=123-45-6789"

    def broken_post(*args, **kwargs):
        raise ValueError(secret_detail)

    monkeypatch.setattr("app.httpx.post", broken_post)
    client = app.test_client()
    resp = client.post("/api/llm-call", json={"messages": [{"role": "user", "content": "hi"}]})

    assert resp.status_code == 500
    assert resp.get_json() == {"error": "Internal server error."}
    assert secret_detail not in resp.get_data(as_text=True)

    log_out = capsys.readouterr().out
    assert secret_detail not in log_out
    log_line = json.loads([line for line in log_out.splitlines() if line.strip()][0])
    assert log_line["event"] == "unhandled_error"
    assert log_line["error_type"] == "ValueError"
    assert log_line["path"] == "/api/llm-call"


def test_unknown_route_still_returns_a_normal_404():
    """The catch-all Exception handler must not swallow ordinary HTTP
    errors (404, the 413 above, ...) into a generic 500 — only genuinely
    unexpected exceptions should hit that path."""
    client = app.test_client()
    resp = client.get("/this-route-does-not-exist")
    assert resp.status_code == 404


# ---- usage metadata (plan §3.7 / Phase 8) ----------------------------------


def test_sanitize_session_id_accepts_a_reasonable_string():
    assert _sanitize_session_id("abc-123") == "abc-123"


def test_sanitize_session_id_rejects_non_strings_and_oversized_strings():
    assert _sanitize_session_id(12345) is None
    assert _sanitize_session_id(None) is None
    assert _sanitize_session_id("") is None
    assert _sanitize_session_id("x" * 101) is None


def test_sanitize_dataset_meta_keeps_only_the_allowed_fields():
    raw = {
        "fileCount": 1,
        "files": [{"rows": 42, "cols": 3, "sizeBucket": "10KB-100KB"}],
    }
    assert _sanitize_dataset_meta(raw) == {
        "fileCount": 1,
        "files": [{"rows": 42, "cols": 3, "sizeBucket": "10KB-100KB"}],
    }


def test_sanitize_dataset_meta_drops_malformed_fields_without_failing_the_whole_record():
    """This is the actual privacy guarantee for this function, exercised
    directly: a compromised or buggy client build sending a real filename,
    an out-of-range count, a bool masquerading as an int, or an
    unrecognized size-bucket string must not get that value logged as-is."""
    raw = {
        "files": [
            {"rows": "patient_ssn_column", "cols": 3, "sizeBucket": "10KB-100KB"},  # rows: not an int
            {"rows": 5, "cols": True, "sizeBucket": "10KB-100KB"},  # cols: bool, not a real int
            {"rows": 5, "cols": 3, "sizeBucket": "actual_filename.csv"},  # bucket not in the allowlist
            {"rows": -1, "cols": 3, "sizeBucket": "<10KB"},  # rows: out of range
            "not-a-dict",
        ]
    }
    cleaned = _sanitize_dataset_meta(raw)
    assert cleaned["fileCount"] == 4  # the malformed string entry is dropped entirely
    assert cleaned["files"] == [
        {"cols": 3, "sizeBucket": "10KB-100KB"},
        {"rows": 5, "sizeBucket": "10KB-100KB"},
        {"rows": 5, "cols": 3},
        {"cols": 3, "sizeBucket": "<10KB"},
    ]


def test_sanitize_dataset_meta_caps_file_count():
    raw = {"files": [{"rows": 1, "cols": 1, "sizeBucket": "<10KB"}] * 200}
    cleaned = _sanitize_dataset_meta(raw)
    assert cleaned["fileCount"] == 50


def test_sanitize_dataset_meta_rejects_non_dict_input():
    assert _sanitize_dataset_meta(None) is None
    assert _sanitize_dataset_meta("not a dict") is None
    assert _sanitize_dataset_meta({"files": "not a list"}) is None


class _FakeUpstreamResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._payload


def test_llm_call_logs_only_metadata_never_message_content(monkeypatch, capsys):
    """The logging-discipline audit this phase calls for, made concrete:
    actually capture the stdout log line from a real (mocked-upstream) call
    and assert the secret message text is absent and the sanitized metadata
    fields are present — not just a code comment promising this."""
    monkeypatch.setenv("MISTRAL_KEY", "test-key")

    secret_text = "the patient's secret diagnosis is XYZ-999"

    def fake_post(url, headers, json, timeout):
        return _FakeUpstreamResponse(
            200,
            {
                "choices": [{"message": {"role": "assistant", "content": "a public-safe reply", "tool_calls": []}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )

    monkeypatch.setattr("app.httpx.post", fake_post)

    client = app.test_client()
    resp = client.post(
        "/api/llm-call",
        json={
            "messages": [{"role": "user", "content": secret_text}],
            "sessionId": "session-abc",
            "datasetMeta": {"files": [{"rows": 3, "cols": 2, "sizeBucket": "<10KB"}]},
        },
    )
    assert resp.status_code == 200

    log_lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(log_lines) == 1
    record = json.loads(log_lines[0])

    assert secret_text not in log_lines[0]
    assert "a public-safe reply" not in log_lines[0]
    assert record["session_id"] == "session-abc"
    assert record["dataset_meta"] == {"fileCount": 1, "files": [{"rows": 3, "cols": 2, "sizeBucket": "<10KB"}]}
    assert record["usage"] == {"prompt_tokens": 10, "completion_tokens": 5}
    assert record["ok"] is True


def test_llm_call_forwards_session_id_as_prompt_cache_key(monkeypatch):
    """Mistral's prompt caching (docs.mistral.ai/studio-api/conversations/
    advanced/prompt-caching) discounts a repeated `messages` prefix by 90%,
    keyed off an explicit `prompt_cache_key` — reusing the already-anonymous
    per-tab session id for it is the one intentional exception to "metadata
    fields never reach `payload`" (see the comment in app.py). Assert it
    actually reaches the upstream request, not just the log line."""
    monkeypatch.setenv("MISTRAL_KEY", "test-key")
    captured = {}

    def fake_post(url, headers, json, timeout):
        captured.update(json)
        return _FakeUpstreamResponse(200, {"choices": [{"message": {"role": "assistant", "content": "ok"}}]})

    monkeypatch.setattr("app.httpx.post", fake_post)
    client = app.test_client()
    resp = client.post(
        "/api/llm-call",
        json={"messages": [{"role": "user", "content": "hi"}], "sessionId": "session-abc"},
    )

    assert resp.status_code == 200
    assert captured["prompt_cache_key"] == "session-abc"


def test_llm_call_omits_prompt_cache_key_without_a_session_id(monkeypatch):
    """No sane cache key to send if the client didn't provide one (or sent
    something _sanitize_session_id rejects) — omit the field entirely
    rather than forwarding None/empty and relying on Mistral to ignore it."""
    monkeypatch.setenv("MISTRAL_KEY", "test-key")
    captured = {}

    def fake_post(url, headers, json, timeout):
        captured.update(json)
        return _FakeUpstreamResponse(200, {"choices": [{"message": {"role": "assistant", "content": "ok"}}]})

    monkeypatch.setattr("app.httpx.post", fake_post)
    client = app.test_client()
    resp = client.post("/api/llm-call", json={"messages": [{"role": "user", "content": "hi"}]})

    assert resp.status_code == 200
    assert "prompt_cache_key" not in captured
