# ── Stage 1: install Python dependencies ──────────────────────────────────────
FROM python:3.12-slim AS deps
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM python:3.12-slim
WORKDIR /app
COPY --from=deps /install /usr/local
COPY app.py ./
COPY docker-entrypoint.sh ./
# app.py imports agent.prompts, and Flask needs templates/ (Jinja2 pages)
# and static/ (the client-side SPA — JS modules, Tailwind CDN build for
# now) to serve anything at all beyond a bare import. Before this, the
# image built and started but crashed immediately on `import agent.prompts`
# — a stub-template leftover from before this became a real app, not
# something the original bare Dockerfile had any reason to anticipate.
#
# TEMPORARY, like the Tailwind-CDN/Pyodide-CDN notes in the templates
# themselves: this copies the frontend as-is (CDN-loaded Tailwind/Pyodide/
# webR at runtime) rather than the vendored, build-time-compiled asset
# pipeline plan §3.1/§4 describes for production — that asset-build stage
# is still a pre-deploy TODO, tracked there and in the plan's Phase 10.
COPY agent/ ./agent/
COPY templates/ ./templates/
COPY static/ ./static/
RUN chmod +x docker-entrypoint.sh

# An arbitrary non-root UID with no matching /etc/passwd entry has no
# HOME, which defaults to "/" — gunicorn's control socket then tries to
# create /.gunicorn there and fails with Permission denied. Several
# hosting platforms run containers as a non-root UID regardless of what
# this Dockerfile specifies; /tmp is writable by any UID, unlike "/".
# Cheap, no downside — keep this even if your current platform doesn't
# need it.
ENV HOME=/tmp

# atlasflow requires the container to listen on port 3000 and bind
# 0.0.0.0 (not 127.0.0.1), with no override supported — see README →
# "Deploying to atlasflow". 3000 is the default here for exactly that
# reason; $PORT stays overridable for local dev or other platforms.
EXPOSE 3000

CMD ["/app/docker-entrypoint.sh"]
