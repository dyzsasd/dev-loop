# dev-loop Hub — the daemon (localhost HTTP surface — read by default, opt-in operator write)

> **Status:** a persistent localhost HTTP service over the existing hub system-of-record
> (`node:sqlite`). It does **not** change the agents: they stay stateless-per-fire and keep
> coordinating through the **MCP server** (`hub/src/server.ts`). The daemon is an additive
> **human-facing surface** — a web UI + read API (DL-2), the roadmap doc editor (DL-3), reports
> (DL-10), an activity view (DL-17), board filters/swimlanes (DL-20/DL-31), and an **opt-in,
> off-by-default human web-write** path for tickets (DL-29). It is **not** a new coordinator
> (strategyDoc Decisions log, 2026-06-23).

## What it is

`hub/src/daemon.ts` is a long-running process that exposes the hub DB over HTTP for human/tool
consumption. It reuses the **same** `hub/src/db.ts` schema with **no schema fork**, zero native deps,
Node ≥23.6 (the hub doctrine). The **read** surface opens its connection with `PRAGMA query_only=ON`,
so every `GET` is served by a connection that **structurally cannot write** the system of record. The
opt-in write routes use a **separate**, ordinary connection (`writeDb`) and never run through the
read connection.

## Posture (the safety envelope)

- **Localhost-only.** Binds `127.0.0.1` **only** — never `0.0.0.0`, no external exposure (§16).
- **Read by default; writes are opt-in and guarded.** Every `GET`/`HEAD` is served by the
  `query_only=ON` read connection, which can never mutate the SoR. The only non-`GET` routes are:
  the **roadmap** write routes (DL-3, always present when a write actor is configured) and the
  **human ticket-write** routes (DL-29, present **only** when `settings_json.humanWrite.enabled` is
  `true`). When neither matches, any non-`GET` falls through to a read-only `405`. Both write surfaces
  are guarded by **`writeOriginOk`** — the request's `Host` must be `127.0.0.1`/`localhost` **and** the
  `Origin` (when sent) same-origin, else `403` (the CSRF / DNS-rebinding boundary, DL-19) — plus the
  operator / `humanWrite` gates below.
- **One project.** Like the MCP server, it serves exactly the project named by `DEVLOOP_PROJECT`
  and refuses to start against an unknown/phantom project (the §2 firewall is structural).

## Running it

```sh
cd hub
DEVLOOP_PROJECT=<project-key> DEVLOOP_HUB_DB="$HOME/.dev-loop/hub.db" npm run daemon
# → [daemon] dev-loop-hub for '<project-key>' (actor=operator, can publish) → http://127.0.0.1:8787/  (reads read-only; /roadmap editable, localhost-only)
```

Environment (same contract as the MCP server, `docs/RUNNING.md`):

| Var | Meaning | Default |
|---|---|---|
| `DEVLOOP_PROJECT` | the project to serve (must already exist) | `demo` |
| `DEVLOOP_HUB_DB` | path to the hub SQLite db | `~/.dev-loop/hub.db` |
| `DEVLOOP_DAEMON_PORT` | listen port | `8787` |
| `DEVLOOP_ACTOR` | identity that **attributes** daemon writes and gates roadmap **publish** (only `operator` may publish; any other known actor gets drafts only). Must be a known actor or the daemon refuses to start the write surface. | `operator` |

The daemon refuses to serve a project that hasn't been seeded (start the hub once, or
`node src/seed.ts <key> "<name>" <PREFIX>`) — it never auto-creates a board.

## Read endpoints

| Method · path | Returns |
|---|---|
| `GET /` | the **web UI** board (DL-2): server-rendered HTML, tickets in columns by state. Filters (DL-20): `?state=`, `?type=`, `?label=`, `?assignee=`, `?q=` (free-text over id/title); swimlanes (DL-31): `?group=assignee` |
| `GET /ticket/:id` | the **web UI** ticket detail (DL-2): HTML with the full description + comments; friendly `404` HTML if unknown |
| `GET /roadmap` | the **roadmap document** view + edit form (DL-3); the operator additionally sees the publish control |
| `GET /reports` + `GET /reports/<agent>/<level>/<date>` | the agent **reports** index + one rendered report (DL-10), read-only filesystem view |
| `GET /activity` | **activity & throughput** over the events ledger (DL-17): recent feed, Done throughput, per-actor counts, cycle time |
| `GET /api` | JSON API index (the project + the endpoint list) |
| `GET /api/health` | `{ ok: true, project }` — liveness |
| `GET /api/tickets` | all tickets for the project. Filters: `?state=`, `?type=`, `?label=`, `?assignee=` (DL-31), `?limit=` |
| `GET /api/tickets/:id` | one ticket with its comments; JSON `404` if unknown |
| `GET /api/docs` + `GET /api/docs/:kind` | the project's documents (no bodies) / the document of that `kind`-or-`slug`: the **published** version, else the latest draft; `404` if absent |

An unknown **non-API** path renders the friendly HTML `404` page (DL-36); an unknown `/api/*` path returns a JSON `404`.

## Write endpoints (opt-in, localhost-guarded)

All require `writeOriginOk` (localhost `Host` + same-origin `Origin`, DL-19) and a configured write actor.

| Method · path | Gate |
|---|---|
| `POST /roadmap/save` | DL-3 — saves a new roadmap draft (CAS on `baseVersion`); any known write actor |
| `POST /roadmap/publish` | DL-3 — publishes a version; **operator only** (`DEVLOOP_ACTOR=operator`) |
| `POST /ticket` | DL-29 — create a ticket; requires `settings_json.humanWrite.enabled` |
| `POST /ticket/:id/comment` · `/move` · `/assign` | DL-29 — comment / move state / (un)assign; requires `settings_json.humanWrite.enabled` |

Each write redirects (303 PRG) back to the affected page on success; the board/ticket pages render the
create/comment/move/assign **forms only when the write surface is enabled**.

### Enabling human web-write (DL-29)

Off by default — with no config the `POST /ticket*` routes are absent (they `405`, byte-identical to a
pure read surface) and the forms don't render. To enable, an **operator** sets the project's
`settings_json.humanWrite.enabled` to `true` (the only field this block reads). It is **operator-set
via seed / CLI / git — never by an agent** (design §11): the hub agents coordinate through the MCP
server, and the human web-write path is for a human at the localhost board. The flag is read **fresh
per request**, so toggling it takes effect without a restart. Writes are attributed to the daemon's
`DEVLOOP_ACTOR` (default `operator`); comment/description bodies are stored **verbatim** (operator
DATA — no command-verb parser, no channel scrub), and every interpolated value is HTML-escaped at render.

This is **cooperative attribution + a localhost trust boundary, not an anti-spoof control**: the real
human-only guarantee is that the surface is reachable only from `127.0.0.1` (`writeOriginOk`), not that
the actor string can't be set.

## Tests

`hub/test/daemon.ts` (wired into `npm test`) seeds a project through the real MCP write path, starts the
daemon in-process on an ephemeral localhost port, and asserts: the web UI (board + ticket detail), every
JSON read endpoint, board filters/swimlanes, the friendly non-API `404` vs JSON `/api` `404`, the
read-only `405` when human-write is off, the `127.0.0.1` bind, and — for the opt-in write surface — the
`405`-when-disabled / `303`-same-origin / `403`-cross-origin+foreign-Host behavior, the `STATES` move
guard, and operator attribution (the DL-29 cases).
