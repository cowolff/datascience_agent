import json
import os
import sys
import time

import httpx
from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from agent.prompts import SEED_SYSTEM_PROMPT

app = Flask(__name__)

# Body-size limit on the LLM proxy (plan §5) — a buggy or malicious client
# shouldn't be able to turn this into an unbounded-payload channel.
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024  # 2 MB

MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions"
DEFAULT_MODEL = "mistral-medium-latest"
PROXY_TIMEOUT_SECONDS = 90

# A connection reset/refused talking to Mistral (httpx.RequestError, but not
# a timeout — see the except order below) is usually a transient network
# blip on that one hop, not the model genuinely being down. Without a retry
# here, every such blip surfaced as "Upstream request failed." straight to
# the agent loop, which has no recovery path of its own and just ends the
# turn — the user had to notice and retype their message. Retried
# in-process, close to the flaky hop, instead of leaving it to the client
# (which would mean a full extra browser<->server round trip per attempt).
MAX_UPSTREAM_ATTEMPTS = 3  # 1 initial try + 2 retries
RETRY_BACKOFF_SECONDS = 0.25

# Usage metadata (plan §3.7) — validation constants. The client (provider.js/
# dataset-meta.js) is only ever supposed to send small numeric/enum fields
# here, but this is the place that actually writes to stdout logs, so it
# validates rather than trusts: a bug or a modified client build must not be
# able to smuggle real message content into logs via these two fields.
ALLOWED_SIZE_BUCKETS = {"<10KB", "10KB-100KB", "100KB-1MB", "1MB-10MB", ">10MB"}
MAX_DATASET_FILES = 50
MAX_SESSION_ID_LENGTH = 100


@app.get("/")
def landing():
    """Marketing/orientation page — the workbench is no longer served at
    this path (see `workbench()` below). This is also atlasflow's health
    check path — must stay a fast, unauthenticated 2xx with no redirect.
    See README → "Deploying to atlasflow"."""
    return render_template("landing.html")


@app.get("/workbench")
def workbench():
    """The actual chat + file-upload agent UI — linked from the landing
    page's "Launch workbench" button (opened in a new tab so the landing
    page stays put)."""
    return render_template("workbench.html", active="workbench")


@app.get("/design")
def design():
    """Detail page for the design principles, priorities, and tool catalog
    behind Bench — linked from the landing page. Purely informational
    (no dataset/LLM interaction happens here), so it isn't gated by the
    TOS modal the way workbench/datasets/settings are."""
    return render_template("design.html", active="design")


@app.get("/datasets")
def datasets():
    """Data-governance UI (plan §3.3/§7 Phase 5) — masking rules are edited
    here and read back by the workbench when a dataset is (re)loaded into
    Python; nothing about a dataset's content passes through this route or
    any other backend route, since parsing/masking both happen client-side
    against files already in OPFS."""
    return render_template("datasets.html", active="datasets")


@app.get("/settings")
def settings():
    """Provider settings UI (plan §3.6/§7 Phase 7) — mode (hosted vs. custom
    endpoint), base URL, API key, model, adapter. Entirely client-side
    (localStorage): this route only serves the static page, never reads or
    stores a submitted value."""
    return render_template("settings.html", active="settings")


@app.get("/help/ollama-cors")
def ollama_cors_help():
    """Static tutorial linked from the Settings page's custom-endpoint CORS
    warning (plan §3.6: local model servers are the most common first
    failure in that mode). Purely informational, like /design — no dataset/
    LLM interaction, so no TOS gate. `active="settings"` keeps the sidebar's
    Settings icon highlighted, since this reads as part of that section."""
    return render_template("ollama_cors_help.html", active="settings")


@app.get("/api/config")
def config():
    """Serves the client its system prompt from a single source of truth —
    agent/prompts.py, the same file GEPA (plan §6.4) mutates — instead of a
    hand-copied duplicate living in static/js that would silently drift.
    Nothing sensitive here: this is a prompt, not a secret."""
    return jsonify({"systemPrompt": SEED_SYSTEM_PROMPT})


@app.post("/api/llm-call")
def llm_call():
    """Stateless LLM proxy (plan §2/§3.5) — hosted mode only.

    Forwards a Mistral-shaped chat-completions request (the "openai-style"
    adapter shape from plan §3.6) to Mistral, using our server-held API key,
    and returns the provider's response essentially unmodified. No session
    state, no conversation history kept here — every call is self-contained,
    which is what lets this be plain HTTP with no persistent connection.

    Never logs the request/response body (plan §3.7) — only a structured
    metadata line to stdout (model, token usage, latency, tool names).
    """
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        return jsonify({"error": "Request body must include a 'messages' list."}), 400

    api_key = os.environ.get("MISTRAL_KEY")
    if not api_key:
        # Server misconfiguration (missing Runtime Variable), not a client error.
        return jsonify({"error": "Server is not configured with an LLM API key."}), 500

    payload = {
        "model": body.get("model") or DEFAULT_MODEL,
        "messages": body["messages"],
    }
    if body.get("tools"):
        payload["tools"] = body["tools"]
        payload["tool_choice"] = "auto"
    if body.get("max_tokens"):
        payload["max_tokens"] = body["max_tokens"]

    # Metadata only (plan §3.7) — deliberately read from `body` and never
    # merged into `payload`, so these fields can't end up forwarded to the
    # upstream provider by accident.
    session_id = _sanitize_session_id(body.get("sessionId"))
    dataset_meta = _sanitize_dataset_meta(body.get("datasetMeta"))

    # Prompt caching (docs.mistral.ai/studio-api/conversations/advanced/
    # prompt-caching): Mistral discounts any repeated prefix of `messages`
    # (system prompt + growing history) by 90%, keyed off an explicit,
    # stable `prompt_cache_key` — it isn't automatic. This is the one
    # exception to "never merged into payload" just above, and it's fine
    # for the same reason dataset_meta/session_id themselves are fine to
    # log: session_id is already just an anonymous, client-generated UUID
    # (session-id.js) with no message content in it, so reusing it here as
    # the cache key doesn't send anything upstream that isn't already
    # implicit in `messages` itself — it only works because our client
    # already builds `messages` as a stable, ever-growing prefix per tab
    # (agent-loop.js appends new turns, never rewrites old ones — except
    # its own token-saving prunes, which only ever touch the *current*
    # turn's tail, never anything from an earlier turn already sent).
    if session_id:
        payload["prompt_cache_key"] = session_id

    started = time.monotonic()
    resp = None
    for attempt in range(MAX_UPSTREAM_ATTEMPTS):
        try:
            resp = httpx.post(
                MISTRAL_API_URL,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
                timeout=PROXY_TIMEOUT_SECONDS,
            )
            break
        except httpx.TimeoutException as exc:
            # Distinguished from other RequestErrors (plan §7 Phase 10
            # hardening review) so a slow/hung upstream reports as a 504, not
            # a generic 502 that reads like the upstream actively refused the
            # call. Not retried — the call already waited the full timeout
            # once, and retrying would just double that wait for the user.
            _log_call(model=payload["model"], ok=False, latency_ms=_elapsed_ms(started), error="timeout")
            return jsonify({"error": "Upstream request timed out."}), 504
        except httpx.RequestError as exc:
            if attempt == MAX_UPSTREAM_ATTEMPTS - 1:
                _log_call(
                    model=payload["model"],
                    ok=False,
                    latency_ms=_elapsed_ms(started),
                    error=str(exc),
                    retries=attempt,
                )
                return jsonify({"error": "Upstream request failed."}), 502
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))

    latency_ms = _elapsed_ms(started)
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}

    tool_names = []
    if resp.status_code == 200:
        message = (data.get("choices") or [{}])[0].get("message", {})
        tool_names = [tc.get("function", {}).get("name") for tc in (message.get("tool_calls") or [])]

    _log_call(
        model=payload["model"],
        ok=resp.status_code == 200,
        latency_ms=latency_ms,
        status_code=resp.status_code,
        usage=data.get("usage"),
        tool_names=tool_names,
        session_id=session_id,
        dataset_meta=dataset_meta,
    )

    return jsonify(data), resp.status_code


@app.errorhandler(413)
def _handle_payload_too_large(exc):
    """Werkzeug raises this itself once `MAX_CONTENT_LENGTH` (plan §5) is
    exceeded, before the route even runs — without this handler it renders
    Werkzeug's default HTML error page instead of the JSON shape every other
    error on this API uses."""
    return jsonify({"error": "Request body too large."}), 413


@app.errorhandler(Exception)
def _handle_unhandled_error(exc):
    """Traceback redaction (plan §7 Phase 10): Flask's default debug=False
    behavior already keeps a traceback out of the HTTP response, but that's
    an implicit property of not setting FLASK_DEBUG rather than something
    this app asserts — this handler makes the guarantee explicit and gives
    every unexpected failure the same structured-metadata-only stdout log
    line as a normal `/api/llm-call` failure, instead of vanishing silently.

    Real HTTP errors (404, the 413 above, ...) are re-raised as-is — they
    already carry a safe, intentional status/message and shouldn't be
    swallowed into a generic 500.
    """
    if isinstance(exc, HTTPException):
        return exc
    # Deliberately log only the exception's type, not `str(exc)` — unlike
    # the upstream RequestError branch above (whose messages are connection
    # details), an arbitrary internal exception could echo back request
    # content (e.g. a JSON-decode error quoting the offending bytes), and
    # this handler is the last line of defense against that reaching stdout.
    record = {
        "event": "unhandled_error",
        "ts": time.time(),
        "path": request.path,
        "error_type": type(exc).__name__,
    }
    print(json.dumps(record), file=sys.stdout, flush=True)
    return jsonify({"error": "Internal server error."}), 500


def _elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


def _sanitize_session_id(raw):
    """An anonymous, client-generated id (plan §3.7) — just enough
    structure to group log lines from the same browser tab. Anything not a
    reasonably-sized string is dropped rather than logged as-is."""
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or len(raw) > MAX_SESSION_ID_LENGTH:
        return None
    return raw


def _sanitize_dataset_meta(raw):
    """Coarse dataset shape (plan §3.7): file count plus, per file, row/
    column counts and a size bucket — never filenames, column names, cell
    values, or exact byte size. Validated field-by-field rather than
    trusted, since this function's output goes straight into a log line;
    anything that doesn't match the expected shape/type/range is dropped
    silently, not logged as-is and not treated as a request error (this
    metadata is best-effort, never required for the call itself to work).
    """
    if not isinstance(raw, dict):
        return None
    files = raw.get("files")
    if not isinstance(files, list):
        return None

    clean_files = []
    for f in files[:MAX_DATASET_FILES]:
        if not isinstance(f, dict):
            continue
        clean = {}
        rows, cols, bucket = f.get("rows"), f.get("cols"), f.get("sizeBucket")
        # bool is a subclass of int in Python — exclude it explicitly so a
        # stray `true`/`false` can't pass as a row/column count.
        if isinstance(rows, int) and not isinstance(rows, bool) and 0 <= rows <= 100_000_000:
            clean["rows"] = rows
        if isinstance(cols, int) and not isinstance(cols, bool) and 0 <= cols <= 100_000:
            clean["cols"] = cols
        if bucket in ALLOWED_SIZE_BUCKETS:
            clean["sizeBucket"] = bucket
        clean_files.append(clean)

    return {"fileCount": len(clean_files), "files": clean_files}


def _log_call(**fields) -> None:
    # Structured stdout logging (plan §3.7 decision) — deliberately only
    # these explicit fields ever reach this call, never the request/response
    # body, so there's no accidental path for message content to get logged.
    record = {"event": "llm_call", "ts": time.time(), **fields}
    print(json.dumps(record), file=sys.stdout, flush=True)
