# Deploying a dev-loop home

The workspace has exactly **one live home** (`docs/design/one-click-deployment.md`). These artifacts
run that home somewhere durable; you keep operating it from your laptop via **attach**.

## The flow (any target)

```bash
# 1. LOCAL — author the encrypted bundle (config + secrets + the board itself):
age-keygen -o dev-loop.key                     # once; the pubkey is printed
dev-loop bundle export --out dev-loop-bundle.age --recipients <age1…pubkey> --move

# 2. REMOTE — load it (each target below wires this up):
AGE_IDENTITY_FILE=… DEVLOOP_UI_TOKEN=… dev-loop up --bundle dev-loop-bundle.age --dir /workspace

# 3. LAPTOP — operate the remote home (board verbs over the token-authed op-API):
DEVLOOP_UI_TOKEN=<token> dev-loop attach https://your-host:8787
# board UI: ssh -L 8787:127.0.0.1:8787 your-host  → http://127.0.0.1:8787 (+ the token via a proxy)
# bring it home again: stop the loop remotely → bundle export --move there → up --bundle locally
```

Backups: schedule `dev-loop bundle export --backup --out backups/$(date +%F).age --recipients …` on
the home (live WAL-checkpoint snapshot; repos need no backup — their state is on the git remotes).

## Targets

| Target | Files | Notes |
|---|---|---|
| Docker / a VPS | `Dockerfile`, `docker-compose.yml` | single service + workspace volume; secrets via docker secrets (decrypt key + UI token only — provider keys travel INSIDE the bundle) |
| Kubernetes | `helm/dev-loop/` | **single-replica StatefulSet by construction** (single-writer SQLite + run lock): replicas hard-pinned 1, `OnDelete` rollout, required one-per-node anti-affinity; PVC = the home |
| Bare Linux | `systemd/dev-loop.service` | the Linux autostart the macOS-only LaunchAgent never covered |

Non-negotiables the artifacts encode (do not "fix" them):

- **Bind+token land together.** `DEVLOOP_DAEMON_HOST=0.0.0.0` without `DEVLOOP_UI_TOKEN(_FILE)`
  refuses to boot — a widened bind with no auth is the one misconfiguration the daemon fails closed on.
  `/api/health` alone stays token-exempt (the probe surface).
- **`dev-loop run` owns the daemon** (the entrypoint chains into it) — never start a second daemon
  process against the same `hub.db`.
- **Replicas = 1.** Scale-out of the home is structurally meaningless (SQLite single-writer, one
  scheduler lock) and corrupting. Scale the TEAM by running more agents/cadence, not more pods.
- **Secrets:** the image never contains any; the bundle is the carrier; fires see only their own
  provider key (per-fire scoping — build/test subprocesses cannot read the rest).
