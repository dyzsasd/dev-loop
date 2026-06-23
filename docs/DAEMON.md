# dev-loop Hub — the daemon (read-only HTTP read surface)

> **Status:** DL-1 — the **read-only** foundation. A persistent localhost HTTP service over the
> existing hub system-of-record (`node:sqlite`). It does **not** change the agents: they stay
> stateless-per-fire and keep coordinating through the **MCP server** (`hub/src/server.ts`). The
> daemon is an additive **human-facing read surface**, not a new coordinator (strategyDoc Decisions
> log, 2026-06-23). The web UI (DL-2) and roadmap-edit write path (DL-3) build on this.

## What it is

`hub/src/daemon.ts` is a long-running process that exposes the hub DB over HTTP for human/tool
consumption. It reuses the **same** `hub/src/db.ts` schema with **no schema fork**, zero native deps,
Node ≥23.6 (the hub doctrine). It opens its own DB connection with `PRAGMA query_only=ON`, so the
process **structurally cannot write** the system of record.

## Posture (the safety envelope)

- **Localhost-only.** Binds `127.0.0.1` **only** — never `0.0.0.0`, no external exposure (§16).
- **Read-only.** Only `GET`/`HEAD` are served; any other method → `405`. No endpoint mutates
  tickets, docs, or events. Defense-in-depth: `PRAGMA query_only=ON` on the connection.
- **One project.** Like the MCP server, it serves exactly the project named by `DEVLOOP_PROJECT`
  and refuses to start against an unknown/phantom project (the §2 firewall is structural).

## Running it

```sh
cd hub
DEVLOOP_PROJECT=<project-key> DEVLOOP_HUB_DB="$HOME/.dev-loop/hub.db" npm run daemon
# → [daemon] dev-loop-hub read API for '<project-key>' → http://127.0.0.1:8787/  (read-only, localhost-only)
```

Environment (same contract as the MCP server, `docs/RUNNING.md`):

| Var | Meaning | Default |
|---|---|---|
| `DEVLOOP_PROJECT` | the project to serve (must already exist) | `demo` |
| `DEVLOOP_HUB_DB` | path to the hub SQLite db | `~/.dev-loop/hub.db` |
| `DEVLOOP_DAEMON_PORT` | listen port | `8787` |

The daemon refuses to serve a project that hasn't been seeded (start the hub once, or
`node src/seed.ts <key> "<name>" <PREFIX>`) — it never auto-creates a board.

## Endpoints (all read-only)

| Method · path | Returns |
|---|---|
| `GET /` | the **web UI** board (DL-2): server-rendered HTML, tickets in columns by state |
| `GET /ticket/:id` | the **web UI** ticket detail (DL-2): HTML with the full description + comments; `404` HTML if unknown |
| `GET /api` | JSON API index (the project + the endpoint list; was `GET /` before DL-2 took the root for the UI) |
| `GET /api/health` | `{ ok: true, project }` — liveness |
| `GET /api/tickets` | the board: all tickets for the project. Filters: `?state=`, `?type=`, `?label=`, `?limit=` |
| `GET /api/tickets/:id` | one ticket with its comments; `404` if unknown |
| `GET /api/docs` | the project's documents (kind/slug/title/status/current_version — no bodies) |
| `GET /api/docs/:kind` | the document of that `kind` (or `slug`): the **published** version, else the latest draft; `404` if absent |

Quick check:

```sh
open http://127.0.0.1:8787/                       # the web UI board (or curl it for the HTML)
curl -s http://127.0.0.1:8787/api/health
curl -s 'http://127.0.0.1:8787/api/tickets?state=Todo'
curl -s http://127.0.0.1:8787/api/tickets/DL-1
curl -s http://127.0.0.1:8787/api/docs/roadmap
```

## Tests

`hub/test/daemon.ts` (wired into `npm test`) seeds a project with tickets + a published roadmap
through the real MCP write path, starts the daemon in-process on an ephemeral localhost port, and
asserts the web UI (board HTML renders the seeded tickets, ticket detail shows description +
comments), every JSON read endpoint, the `404`s, the read-only `405`, and the `127.0.0.1` bind.
