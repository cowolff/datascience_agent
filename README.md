# Bench

Bench is a browser-based data science agent: it chats with you about a
dataset, and to actually answer, it runs real Python (Pyodide/WASM) and R
(webR/WASM) code — but that code, and the data it operates on, never leave
your browser. The Flask backend is a thin, stateless proxy that forwards
chat/tool-call turns to an LLM; it never receives a dataset, a parsed
dataframe, or a tool result. See
[`plans/online-data-science-agent.md`](plans/online-data-science-agent.md)
for the full design and a phase-by-phase build log.

This started from `repo_template`, a minimal Flask + Docker starting point
for projects deployed on [atlasflow](https://atlasflow.com). The
atlasflow-specific guidance below is still accurate and still load-bearing
— keep it even as the app keeps growing.

## Quick start (local development)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in MISTRAL_KEY — see .env.example
flask --app app run --debug
```

Open http://127.0.0.1:5000/ — that's the landing page (also atlasflow's
health check path); its "Launch workbench" button opens `/workbench` (chat +
file upload) in a new tab, and "Design & tools" links to `/design`, a page
detailing the design principles, priorities, and tool catalog. `/datasets`
manages row/column/cell masking rules per uploaded file; `/settings` chooses
hosted vs. a custom/local model endpoint (plan §3.6).
Pyodide/webR and Tailwind currently load from a CDN at runtime rather than
a vendored build (tracked in the plan as a pre-deploy TODO), so local dev
needs outbound network access even though no *data* ever does.

Without `MISTRAL_KEY` set, everything except sending a hosted-mode chat
message still works — you can upload/mask datasets and browse Settings;
a chat send just fails with a clear 500 until the key is set (or until you
switch Settings to "Custom endpoint" and supply your own).

## Running tests

```bash
python -m pytest tests/ -v                                    # Flask routes + logging/metadata discipline
node --test $(find static/js -name '*.test.mjs' | sort)   # client-side masking, provider-adapter, tool-registry + render-tool logic, agent-loop failed-attempt pruning
```

Both are fast and need no API key or network access. CI
(`.github/workflows/ci.yml`) runs both on every push, plus a Docker build
+ route smoke test — see that file's own comments for what each job does
and why the eval job below is a separate, opt-in tier.

## Evaluation harness & prompt tuning

`agent/prompts.py` holds the single system prompt Bench actually serves
(via `/api/config`) — it's a GEPA-optimized starting point (plan §6), not
hand-tuned in place. Two ways to check whether a prompt or agent-loop
change regressed it, both against the fixtures in `eval/cases/`:

```bash
pip install -r requirements-eval.txt

# Standalone tier (fast, no browser — real Python/R execution in a local
# subprocess): what GEPA itself optimizes against. Defaults to the
# analysis_4 case; pass --case <name> for a different one.
python -m eval.smoke_test

# Production-fidelity tier (slower, real thing — spawns the actual Flask
# app and drives the actual browser SPA + real Pyodide/webR execution via
# Playwright; run `playwright install chromium` once first):
python -m eval.browser_harness analysis_4
```

Both make real, billed calls to whichever model is configured
(`MISTRAL_KEY` by default) — they're dev/CI tooling, not something a
request from the deployed app ever triggers. Running GEPA itself
(`eval/gepa_optimize.py`) is a separate, expensive, manually-triggered job
— see plan §6.4; it's never run automatically.

## Deploying

### With Docker, matching production

```bash
docker build -t bench .
docker run --rm -p 3000:3000 -e MISTRAL_KEY=your-key-here bench
curl http://localhost:3000/
```

### Deploying to atlasflow

atlasflow's [container requirements](https://atlasflow.com/docs/guides/container-requirements)
are strict and unconfigurable:

- **Your container must listen on port 3000 and bind to `0.0.0.0`** —
  not `127.0.0.1`. Binding to localhost only prevents atlasflow from
  reaching the app over its internal network. **Custom port configuration
  isn't supported at all** — atlasflow always connects to 3000, so
  `docker-entrypoint.sh` defaults to it without needing any env var set.
- **The health check is `GET /`**, not `/health` or anything else. It's
  probed every 15 seconds with a 5-second timeout, expects a 2xx, and
  atlasflow stops routing traffic to the deployment after 3 consecutive
  failures. Their own checklist specifically calls out the most common
  way to fail this: **`/` redirecting to a login page** for anonymous
  visitors. If you add authentication later, make sure `/` (or whatever
  route you point the health check at) stays reachable and fast for an
  unauthenticated request — see `tests/test_app.py` for a regression
  test that pins this down.
- **The `CMD` in the Dockerfile is JSON-array form calling a script that
  `exec`s gunicorn**, not a bare shell-form `CMD gunicorn ...`. Shell
  form runs under `/bin/sh -c`, which becomes PID 1 and does *not*
  forward `SIGTERM`/`SIGINT` to gunicorn — `docker stop` (or atlasflow
  redeploying/stopping the container) then has to wait out the full
  stop timeout and `SIGKILL` it instead of a clean shutdown. `exec` inside
  the entrypoint script replaces the shell process with gunicorn so it
  receives the signal directly. (This is also what a Dockerfile linter's
  `JSONArgsRecommended` / `DL3025` warning on `CMD` is telling you to fix.)

### Environment variables on atlasflow

atlasflow splits env vars into **Build** and **Runtime** scopes in the
project settings. A Build-scoped variable is available while the image
is being built but **is not present in the running container** unless
you also add it as a Runtime variable. `MISTRAL_KEY` — and any secret or
config value the app reads at request/startup time — needs to go in
**Runtime Variables**; putting it in Build Variables only will crash the
app at startup (or, in this app's case specifically, only fail once a
chat request is actually sent) with a "missing config" error that looks
unrelated to this distinction.

### Current deployment status — read before relying on this

Docker packaging was fixed and verified for real as part of the Phase 9
work (see the plan's Phase 9 write-up): the image now actually copies
`agent/`, `templates/`, and `static/` (previously it only copied `app.py`
and would crash on startup the moment a request came in — `docker build`
succeeded, but the container never actually served anything). A real
`docker build && docker run` plus curling `/`, `/datasets`, `/settings`,
`/api/config`, and a static JS file all now return 200 — this is wired
into CI as a standing regression test (the `docker-smoke-test` job) so it
can't silently regress again.

Phase 10 ("hardening", plan §7) is done: `/api/llm-call` now returns `504`
(not a generic `502`) on a genuine upstream timeout, an oversized request
body gets the same JSON error shape as every other failure on this API
instead of Werkzeug's default HTML `413` page, and a catch-all error
handler makes traceback redaction an explicit, tested guarantee rather
than an implicit side effect of nobody setting `FLASK_DEBUG` — any
unexpected exception logs one content-free structured line
(`event: "unhandled_error"`, `error_type`, `path`) and returns a generic
500, never the exception's own message (which could otherwise echo back
request content). All of this was re-verified against a real
`docker build && docker run`, including confirming `GET /` still satisfies
atlasflow's exact health-check contract (fast, `200`, no redirect)
unchanged by the new error handlers.

Still genuinely incomplete, not yet done:
- The frontend still loads Tailwind/Pyodide/webR from a CDN at runtime
  inside the container, not from a vendored, build-time-compiled asset
  stage (plan §3.1/§4's eventual design) — functional, but means the
  running container needs outbound network access for the UI to render
  at all, and isn't the final intended packaging.
- No real atlasflow deployment has been performed against this app —
  the guidance above is carried over from the original template and
  re-verified against a local Docker run, not against an actual atlasflow
  project.

### Other defensive choices worth keeping

- **`ENV HOME=/tmp`** — gunicorn creates a control socket under
  `$HOME/.gunicorn/` by default. An arbitrary non-root UID with no
  matching `/etc/passwd` entry (something some hosting platforms impose
  regardless of what the Dockerfile specifies) has no `HOME`, which
  defaults to `/` — and gunicorn then fails with `Permission denied`
  trying to create a directory there. `/tmp` is writable by any UID.
  Costs nothing even if your current platform doesn't need it.
- **Two-stage Dockerfile** (`deps` → runtime) — keeps the final image
  free of pip's build-time cruft and cleanly separates "what changes
  when dependencies change" from "what changes when app code changes"
  for Docker's layer cache.
- **If you add a database or anything that writes to disk**: some
  hosting platforms run the container as an arbitrary non-root UID.
  `VOLUME`-declared directories are root-owned by default and won't be
  writable under those UIDs — create the directory explicitly and
  `chmod` it permissively (it holds only this app's own data, not shared
  with other tenants, so that's a reasonable tradeoff for working under
  an unknown runtime UID). Also confirm with atlasflow's docs whether
  local disk on their microVMs actually persists across
  restarts/redeploys before relying on it for anything that needs to
  survive one — this app has no persistence story at all yet (and, by
  design — plan principle 2 — never will for user data; this only
  applies if you add something like a metadata database per plan §3.7).

## License
MIT
