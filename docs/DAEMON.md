# dev-loop Hub — the daemon (localhost HTTP surface — read by default, opt-in operator write)

> **Status:** a persistent localhost HTTP service over the existing hub system-of-record
> (`node:sqlite`). It does **not** change the agents: they stay stateless-per-fire and keep
> coordinating through the **MCP server** (`hub/src/server.ts`). The daemon is an additive
> **human-facing surface** — a web UI + read API (DL-2), the roadmap doc editor (DL-3), reports
> (DL-10), an activity view (DL-17), board filters/swimlanes (DL-20/DL-31), and an **opt-in,
> off-by-default human web-write** path for tickets (DL-29). It is **not** a new coordinator
> (strategyDoc Decisions log, 2026-06-23).
>
> **1.x workspace note:** for normal operation, manage this daemon with
> `dev-loop hub start|stop|status|ensure` from a workspace. The raw `dev-loop daemon ...`,
> `seed`, and `init-service` commands still exist for compatibility and low-level debugging, but
> they are not the recommended starting point for a new workspace.

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
- **Agent op-API publish is *cooperative* (DL-43/DL-62).** When `settings_json.hub.transport:"daemon"` is
  set, the daemon also mounts the agent op-API (`POST /api/op/*`, default-off ⇒ `404`, same `writeOriginOk`
  wall), which from DL-62 serves the document/event family (`doc.save`/`doc.publish` + the doc reads +
  `list_events`). It resolves identity from the **`X-Devloop-Actor`** request header, so **`doc.publish`
  over the op-API is a *cooperative* operator gate** — it trusts the client-declared `…:operator` — distinct
  from the stdio `server.ts` publish gate, which reads the daemon **process's own** `DEVLOOP_ACTOR`. Same
  single-host cooperative attribution, **not** anti-spoof (§16); revisited only under the deferred remote/auth
  phase. (Full op-API config + reference: DL-58.)
- **One project.** Like the MCP server, it serves exactly the project named by `DEVLOOP_PROJECT`
  and refuses to start against an unknown/phantom project (the §2 firewall is structural). The one
  role-gated exception is the D1 **`project` override** on the agent op-API (below): stewards
  (sweep/ops/reflect/communication) may name any existing project key or `_team`, PM may name
  `_team` only, every other actor is refused (`403 FORBIDDEN`) — enforced server-side at the shared
  `agentOp()` dispatch choke point, identically on both transports.

## Running it

Normal workspace lifecycle:

```sh
cd <workspace>
dev-loop hub ensure
dev-loop hub status
```

For `backend:"service"`, `dev-loop run` calls `hub ensure` automatically. `dev-loop hub stop`
performs the WAL checkpoint you want before copying a workspace to another machine.

Raw daemon lifecycle, mainly for compatibility/debugging:

```sh
DEVLOOP_WORKSPACE=<workspace> DEVLOOP_PROJECT=<project-key> \
  DEVLOOP_HUB_DB="<workspace>/.dev-loop/hub.db" dev-loop daemon up
# → [daemon] up: started '<project-key>' → http://127.0.0.1:<port>
```

Environment (same contract as the MCP server, `docs/RUNNING.md`):

| Var | Meaning | Default |
|---|---|---|
| `DEVLOOP_PROJECT` | the project to serve (must already exist). Optional only when the command's cwd is inside a configured `repoPath` / `repos[].path`; otherwise unresolved/no-op. | unset |
| `DEVLOOP_WORKSPACE` | workspace root; preferred in 1.x launchers | unset |
| `DEVLOOP_HUB_DB` | path to the hub SQLite db | `<workspace>/.dev-loop/hub.db` when a workspace resolves; otherwise `~/.dev-loop/hub.db` compatibility default |
| `DEVLOOP_DAEMON_PORT` | listen port; also forces `daemon up`'s port when set | `8787` |
| `DEVLOOP_ACTOR` | identity that **attributes** daemon writes and gates roadmap **publish** (only `operator` may publish; any other known actor gets drafts only). Must be a known actor or the daemon refuses to start the write surface. | `operator` |
| `DEVLOOP_RUN_DIR` | dir for the raw `daemon up` runfile + log (DL-41) | the hub DB's dir |

The raw daemon refuses to serve a project that has not been seeded. In the 1.x workspace flow,
`/dev-loop:add-project` performs that backend sync before writing project config. The lower-level
`dev-loop seed <key> "<name>" <PREFIX>` and `dev-loop init-service ...` commands are compatibility
tools for tests and debugging.

### Raw lifecycle — `daemon up | up-all | down | status`

For compatibility/debugging, the daemon also has an **idempotent per-project lifecycle**
(additive — the workspace `dev-loop hub ...` wrapper is the normal 1.x entry):

```sh
DEVLOOP_PROJECT=<project-key> dev-loop daemon up         # `ensure` is an alias for `up`
# → [daemon] up: started '<project-key>' → http://127.0.0.1:<port>  (pid …)
dev-loop daemon up-all                                   # starts every configured backend:"service" project
dev-loop daemon status                                   # → RUNNING → <url> (pid …)  | stopped
dev-loop daemon down                                     # → stops this project's daemon, clears the runfile
```

- **Project resolution.** `DEVLOOP_PROJECT` wins (trimmed; an empty/whitespace value is treated as
  unset, matching the MCP server); otherwise the project is resolved from the cwd (the DL-13 matcher).
  A **non-service / unresolved / unseeded** project is a clean **no-op + exit 0** (never an error) — so
  an unconditional auto-start hook (DL-42) is safe. `ensure` is an accepted alias for `up`.
- **Real liveness, not a port ping.** `up`/`status` probe **`GET /api/health`**, which is a real
  **DB-writable** liveness check (a trivial read + acquire/release of the reserved write lock, no
  mutation) — so a **bound-but-wedged** daemon (port open, SoR unreadable/unwritable) returns `503`
  and is treated as NOT running: `up` reclaims it instead of no-op'ing onto a dead process.
- **One daemon per project, stable port.** `up` records `{pid, port, url}` in a machine-local
  runfile `<DEVLOOP_RUN_DIR>/daemon-<project>.json` (default `~/.dev-loop/`, never committed) and
  starts at the fixed default port **8787**. If that port is occupied it probes upward and records the
  actual port; later restarts reuse the recorded port, so the URL is stable for that project.
- **Never double-starts.** A second `up` while a healthy daemon is already listening is a no-op
  that prints the existing URL. A **stale** runfile (its pid is dead) never reads as running — `up`
  cleanly restarts, `status`/`down` report stopped.
- **Detached + localhost-only.** `up` spawns the daemon **detached** so it survives the launching
  shell, bound to **127.0.0.1 only** (§16). The packaged `dev-loop daemon up` command and the
  source-checkout fallback drive the same lifecycle.

### Login autostart

On macOS, a global `npm i -g @dyzsasd/dev-loop` attempts to install a LaunchAgent automatically
during `postinstall` (unless `DEVLOOP_SKIP_AUTOSTART=1` is set or npm scripts are skipped). To repair
or install it manually after the npm package and service projects are configured:

```sh
dev-loop daemon install-autostart
```

The LaunchAgent runs the packaged daemon entry with `up-all` at login, using the compatible Node that
`dev-loop` resolved (`DEVLOOP_NODE` when set, otherwise a probed Node ≥23.6). It starts configured
`backend:"service"` projects only; projects that are unseeded in the hub DB are skipped cleanly. Remove it with:

```sh
dev-loop daemon uninstall-autostart
```

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

## Agent op-API — `POST /api/op/<op>` (DL-43/P2, opt-in)

The **agent** write/read surface (distinct from the human web-write above): the thin stdio MCP shim
(`hub/src/shim.ts`) proxies its tool calls here instead of opening `hub.db` directly, so all writes
serialize through the one daemon process (the P3 single-writer path). **Default-off** — absent the
opt-in it returns `404`, byte-identical to a pure read surface.

- **Enable:** set the project's `settings_json.hub.transport = "daemon"` (read **fresh per request**),
  then point the MCP `args` at `hub/src/shim.ts` instead of `hub/src/server.ts` (same per-pane
  `DEVLOOP_ACTOR`). See `references/config-schema.md` (`hub.transport`).
- **Shape:** `POST /api/op/<op>` with a JSON body; `<op>` mirrors the MCP tools 1:1 — the shim is a
  **100% `server.ts` drop-in** (all 23 tools: `list_issues`/`get_issue`/`save_issue`/`save_comment`/
  `list_comments`/`whoami` · `doc.*`/`list_events` · `channel.*` · `mirror.*` ·
  labels/`get_project`).
- **Identity:** the actor rides the **`X-Devloop-Actor`** header (the shim forwards its per-pane
  `DEVLOOP_ACTOR`), dodging the `claude -p` Authorization-header-drop; the daemon validates it against
  the `actors` table (cooperative attribution, single-host — §16, not anti-spoof).
- **Project override (D1):** every op accepts an optional **`project`** key in the JSON body, role-gated
  server-side (the matrix above): stewards → any project key or `_team`; pm → `_team` only; everyone
  else → `403 FORBIDDEN` (forbidden-first, so a refused actor never learns which keys exist; an
  *allowed* actor's unknown key gets the normal `404`). Omitted ⇒ the daemon's pinned project,
  byte-identical to the pre-override behavior. The server-side dry-run mode gate judges the
  **effective** (overridden) project.
- **Gate:** every **mutating** op passes `writeOriginOk` (the DL-19 localhost `Host`+`Origin` CSRF /
  DNS-rebind wall) **first**, then resolves the pinned project (§2) and appends an attributed event.
  Honest caveat: `doc.publish` over the op-API is a **cooperative** (claim-based) gate vs the
  daemon-process-identity gate of the human `POST /roadmap/publish` — acceptable on one trusted host,
  revisited under the deferred Phase B auth model.

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
