# dev-loop — the remote home (one-click §5.1).
# Entry = `dev-loop up --bundle` → team repair → doctor preflight → exec `dev-loop run`, which OWNS the
# board daemon (Q5: run's auto-ensure via the lifecycle path). The image NEVER contains secrets: they
# arrive in the age-encrypted bundle (decrypted to .dev-loop/secrets.env at load) with the decrypt key
# supplied at runtime (AGE_IDENTITY_FILE — a mounted secret) — never baked, never co-shipped.
#
#   docker build -f deploy/Dockerfile -t dev-loop:latest .
#   (or: --build-arg DEVLOOP_SPEC=@dyzsasd/dev-loop@1.4.0 for a pinned npm install)
FROM node:23-bookworm-slim

# git = repo re-clone/push · age = bundle decrypt · curl = healthcheck probe · ca-certs = https remotes
RUN apt-get update && apt-get install -y --no-install-recommends \
      git age curl ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

# opencode — the container runner (Q2: containers are keys-only; claude stays a local-console choice).
# W15 gates the certified floor (>= 1.2.24) at doctor time.
RUN npm install -g opencode-ai && opencode --version

# dev-loop itself. Default: this build context (the repo — CI/dogfood). Release images pass
# DEVLOOP_SPEC=@dyzsasd/dev-loop@<version> to install from npm instead.
ARG DEVLOOP_SPEC=/src/hub
COPY . /src
RUN npm install -g "$DEVLOOP_SPEC" && dev-loop version

# The workspace home lives on a volume — repos, hub.db, secrets.env, scheduler state all persist there.
ENV DEVLOOP_WORKSPACE=/workspace \
    DEVLOOP_PROJECT=_team \
    DEVLOOP_ACTOR=operator \
    DEVLOOP_DAEMON_HOST=0.0.0.0
# DEVLOOP_DAEMON_HOST widens the bind for probes/exposure — the daemon REFUSES to boot like this
# without DEVLOOP_UI_TOKEN(_FILE) (§1.5/§6.2: the pair lands together; fail closed). Supply the token
# and the age identity as runtime secrets (compose/K8s below) — NEVER as image layers.
WORKDIR /workspace
VOLUME /workspace

EXPOSE 8787
# /api/health is deliberately token-exempt (the probe surface): 503 when the SoR is wedged.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${DEVLOOP_DAEMON_PORT:-8787}/api/health" || exit 1

ENTRYPOINT ["dev-loop", "up", "--bundle", "/bundle/dev-loop-bundle.age", "--dir", "/workspace"]
