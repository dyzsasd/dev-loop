# dev-loop Hub — the daemon (localhost HTTP surface — read by default, opt-in operator write)

> **Status:** a persistent localhost HTTP service over the existing hub system-of-record
> (`node:sqlite`). It does **not** change the agents: they stay stateless-per-fire and keep
> coordinating through the hub **op layer** — the `dev-loop` CLI write verbs by default since
> the D8 interface flip, or the **MCP server** (`hub/src/server.ts`) on the `"mcp"`
> interface / the shim. The daemon is an additive
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

- **Localhost-only by default; a widened bind REQUIRES the bearer token (one-click §1.5/§6.2).**
  The bind is `127.0.0.1` unless `DEVLOOP_DAEMON_HOST` overrides it (a container/pod must — probes and
  published ports reach the pod IP, never the container's loopback). A non-loopback bind with no
  `DEVLOOP_UI_TOKEN(_FILE)` **refuses to boot** (fail closed — the Host-allowlist guard is only
  sufficient on loopback). With a token configured, EVERY request except `GET /api/health` (the probe
  surface) must send `Authorization: Bearer <token>` (constant-time compare; 401 +
  `WWW-Authenticate: Bearer` otherwise), and a bearer-authed request **bypasses `writeOriginOk`** — a
  browser cannot attach cross-site Authorization headers, so the CSRF/rebinding vector cannot reach a
  tokened surface, which is exactly what lets a reverse proxy (injecting the header upstream) or an
  attach client (`DEVLOOP_HUB_URL`, §6.0) use the write surface cleanly. Token-less loopback behavior
  is byte-identical to the pre-token daemon.
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
- **One boot project; per-request `/p/<key>/` routing for the web UI.** The daemon boots pinned
  to the project named by `DEVLOOP_PROJECT` and refuses to start against an unknown/phantom
  project (the §2 firewall is structural). Since D2 the **human web pages** additionally serve
  every hub project under a `/p/<key>/` prefix (resolved per request — see *Read endpoints*);
  **bare paths and the JSON/op API stay boot-scoped**. The one role-gated exception is the D1
  **`project` override** on the agent op-API (below): stewards
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
`dev-loop team add-project` **auto-seeds** the hub row on a `service` backend (the
`/dev-loop:add-project` skill performs the same backend sync) before writing project config. The
lower-level `dev-loop seed <key> "<name>" <PREFIX>` and `dev-loop init-service ...` commands are
compatibility tools for tests and debugging.

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

**Multi-project routing (F2, decision D2).** One daemon serves **every** hub project: a `/p/<key>/`
path prefix resolves the project **per request** (unknown key → friendly HTML `404`), and every page
link/form action the UI emits is in that canonical `/p/<key>/…` form. **Bare** paths (everything below
without the prefix) keep serving the **boot** project, so old URLs and bookmarks survive. Bare `GET /`
is special: it renders the **project index** — one card per project (open counts by state,
last-activity), with `_team` pinned last as “Team intake” — or `302`-redirects straight to
`/p/<key>/` when the hub holds exactly **one** real (non-`_team`) project. The JSON `/api/*` surface
(including the op-API and its D1 role-gated `project` override) stays **boot-scoped on bare paths
only** — under `/p/<key>/` it is unmounted (`404`), except the SSE live stream: `/p/<key>/api/stream`
follows its project, bare `/api/stream` follows the boot project, and `/api/stream?all=1` (what the
index page subscribes to) watches the whole ledger.

| Method · path | Returns |
|---|---|
| `GET /` | the **project index** (or the single-real-project `302` → `/p/<key>/`, preserving any filter query) |
| `GET /p/<key>/` | the **web UI** board (DL-2): server-rendered HTML, tickets in columns by state. Filters (DL-20): `?state=`, `?type=`, `?label=`, `?assignee=`, `?q=` (free-text over id/title); swimlanes (DL-31): `?group=assignee` |
| `GET [/p/<key>]/ticket/:id` | the **web UI** ticket detail (DL-2): HTML with the full description + comments; friendly `404` HTML if unknown |
| `GET [/p/<key>]/docs` | the **docs index** (F4/D3): the hub docs — kind, title, published-vs-latest badge (`published vN` · `draft vM pending`), latest author, updated-at. **Archived** design docs are hidden by default (D6): `?archived=1` shows them badged, and a footer names the hidden count |
| `GET [/p/<key>]/doc/:slug` | the **doc viewer** (kind-agnostic): rendered markdown of the latest version (`?v=N` picks an exact one), status/version meta; when the DL-29 double gate is open it adds the CAS draft-edit form, and the operator additionally sees the publish button on gated kinds (`design` is never publish-gated). `/doc/<kind>` `302`s to the kind's canonical slug |
| `GET [/p/<key>]/doc/:slug/history` | the **version ledger**: status/author/summary/CAS-base/date per version, with view + diff-vs-previous links |
| `GET [/p/<key>]/doc/:slug/diff?from=N&to=N` | the **unified diff** between two versions (server-rendered, fully escaped) |
| `GET [/p/<key>]/roadmap` | `302` → the roadmap **doc page** (`/doc/<slug>`) — D3 folded the dedicated roadmap page into the docs system (edit form, publish, and the DL-83 divergence banner live there) |
| `GET [/p/<key>]/reports` + `…/reports/<agent>/<level>/<date>` | the agent **reports** index + one rendered report (DL-10), read-only filesystem view |
| `GET [/p/<key>]/activity` | **activity & throughput** over the events ledger (DL-17): recent feed, Done throughput, per-actor counts, cycle time |
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
| `POST [/p/<key>]/doc/:slug/save` | F4/D3 — saves a new DRAFT of any hub doc (CAS on `baseVersion`; kind is server-derived from the stored doc, or from the slug when creating a singleton kind); requires `settings_json.humanWrite.enabled` (the DL-29 double gate) |
| `POST [/p/<key>]/doc/:slug/publish` | F4/D3 — publishes a version; the same double gate **plus operator only** (`DEVLOOP_ACTOR=operator`, docstore's single gate) |
| `POST [/p/<key>]/roadmap/save` · `/roadmap/publish` | legacy DL-3 aliases — resolve the roadmap doc's slug server-side and behave exactly like the `/doc/:slug/*` routes (incl. the humanWrite gate) |
| `POST [/p/<key>]/ticket` | DL-29 — create a ticket; requires `settings_json.humanWrite.enabled` |
| `POST [/p/<key>]/ticket/:id/comment` · `/move` · `/assign` | DL-29 — comment / move state / (un)assign; requires `settings_json.humanWrite.enabled` |

Each write redirects (303 PRG) back to the affected page on success; the board/ticket/doc pages render
their **forms only when the write surface is enabled** (and a rejected doc save re-renders the doc page
with the typed text preserved — DL-14). When the resolved project has gated docs with drafts ahead of
their published version, every project page's header shows an **`N drafts pending`** chip → `/docs`
(docs P6a), so agent-drafted direction can't silently stall awaiting the operator publish.

## Agent op-API — `POST /api/op/<op>` (DL-43/P2, opt-in)

The **agent** write/read surface (distinct from the human web-write above): the thin stdio MCP shim
(`hub/src/shim.ts`) — and, since D8, the `dev-loop` CLI write verbs, both through the shared
`hub/src/op-client.ts` — proxy their tool calls here instead of opening `hub.db` directly, so all
writes serialize through the one daemon process (the P3 single-writer path). **Default-off** — absent
the opt-in it returns `404`, byte-identical to a pure read surface.

- **Enable:** set the project's `settings_json.hub.transport = "daemon"` (read **fresh per request/
  command**). The CLI write verbs pick it up automatically; for an `"mcp"`-interface fire, point the
  MCP `args` at `hub/src/shim.ts` instead of `hub/src/server.ts` (same per-pane `DEVLOOP_ACTOR`).
  Reference: `docs/design/daemon-multicli-repositioning.md` (`hub.transport`, DL-58).
- **Shape:** `POST /api/op/<op>` with a JSON body; `<op>` mirrors the MCP tools 1:1 — the shim is a
  **100% `server.ts` drop-in** (all 25 tools: `list_issues`/`get_issue`/`save_issue`/`save_comment`/
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
via seed / CLI / git — never by an agent** (design §11): the hub agents coordinate through the
CLI/op layer, and the human web-write path is for a human at the localhost board. The flag is read **fresh
per request**, so toggling it takes effect without a restart. Writes are attributed to the daemon's
`DEVLOOP_ACTOR` (default `operator`); comment/description bodies are stored **verbatim** (operator
DATA — no command-verb parser, no channel scrub), and every interpolated value is HTML-escaped at render.

This is **cooperative attribution + a localhost trust boundary, not an anti-spoof control**: the real
human-only guarantee is that the surface is reachable only from `127.0.0.1` (`writeOriginOk`), not that
the actor string can't be set.

## Background notifiers

Besides serving HTTP, the daemon runs a small set of interval notifiers (`hub/src/daemon-notifiers.ts`)
that push **one-line, §16-safe** alerts to the team's outward channel. They all share the same envelope:

- **One send target** (DL-59): a registered DB `channels` row wins; else the §9 `notify` webhook
  (`team.comms` is bridged into it); **neither ⇒ the notifier is a true no-op** (no timer, no ledger work).
- **Stateless due-ness + per-send dedupe markers** in the events ledger (`*.notified` events) — a daemon
  restart never double-sends, and a failed send writes no marker so it retries next tick.
- **Dry-run is write-free** (DL-34, `DEVLOOP_CHANNEL_DRYRUN=1`): preview to stderr, no send, no marker.
- **Boot-time config**: cadences, `team.comms` presence, and `intake.mode` are resolved once at daemon
  boot — an already-running daemon picks changes up **on restart only**
  (`references/config-schema.md` → *Hub daemon notifier settings*).

| Notifier | Fires when | Cadence / dedupe |
|---|---|---|
| **Decision-queue reminder** (DL-26, workflows P3; P1-3) | an item sits in the operator's decision queue — `Human-Blocked` tickets **∪ `In Review` assigned to `operator`** (the §9a approval stops). First ping on detection, then repeats; each shape keeps its own wording + marker kind (`human_blocked.notified` / `operator_review.notified`), so de-dup never crosses. The line names the ticket, **its age in the state**, and the action (resume via `dev-loop ticket update <id> --state Todo`, or rule on the board) + the ticket URL | `settings_json.humanBlockedReminderHours`; **default 24h when `team.comms` is configured, else off**; explicit `0` = opt-out. Tick 60s (`DEVLOOP_BLOCKED_TICK_MS`) |
| **Fire-health self-monitor** (P0-1c) | fire success in the trailing `fireHealth.windowHours` window (default 2h) drops below `threshold` (default 50%) on a real sample (`minFires`, default 6) — the alert carries the `errorClass` tallies (e.g. `spend-limit×9`); the first HEALTHY window after an alert sends one recovery line. An insufficient sample (the P0-1a breaker probing) is neither — the episode stays open and silent | once per degradation episode (`fire_health.notified`/`.recovered` markers — restart-safe); needs the team fires ledger (legacy daemons skip). `fireHealth.windowHours: 0` = opt-out. Tick 10m (`DEVLOOP_FIREHEALTH_TICK_MS`) |
| **No-progress circuit-breaker** (DL-76) | zero tickets reached `Done` in the trailing `settings_json.noProgressWindowHours` window (cold start excluded) | once per stall episode; re-alerts only after progress resumed. Tick 1h (`DEVLOOP_NOPROGRESS_TICK_MS`) |
| **Passive-intake doc-edit notifier** (docs P3) | `intake.mode:"passive"` **only** — PM's doc-watch is off, so a hub-doc version authored by a **non-agent** actor (operator/web edit; `actors.kind` decides, so no agent draft can self-trigger) that sat unconsumed past a settle window gets one line naming slug/version/author + the `/p/<key>/doc/<slug>` URL. `design` docs excluded; **archived** docs excluded (D6) | deduped **per version** (an editing burst collapses to the final version's line). Settle 15m (`DEVLOOP_DOC_FOREIGN_SETTLE_MS`), tick 10m (`DEVLOOP_DOC_NOTIFY_TICK_MS`) |
| **Passive-intake strategy-FILE watch** (docs P3b) | `intake.mode:"passive"` **only**, and the project's `strategyDoc` is a **repo file** (a plain string / `{ path }` — the default config shape; resolved at boot via the §19 doc-home rule, `repoFileStrategyPath`). The daemon watches the file's **content hash**; a **settled** change (file mtime older than the settle window) emits one line: `operator edited <path> — PM is passive; file a needs-pm ticket to act`. **The PATH only — never a byte of file content** (§16) | deduped **by content hash** (ledger markers). The **first observation seeds a silent baseline** (a file has no authorship, so boot-state is never announced). Settle 15m (`DEVLOOP_STRATEGY_FILE_SETTLE_MS`), tick 10m (`DEVLOOP_STRATEGY_FILE_TICK_MS`) |
| **Drafts-pending notifier** (docs P6b) | a publish-gated doc's drafts trail the published current for **>24h** (measured from the first unpublished version — a fresh draft on top does not reset the clock): `"strategy: draft v14 pending over published v12 — review at /p/<key>/doc/strategy"` | one **daily** line while pending, deduped per version; a **new** draft version re-announces immediately. Tick 1h (`DEVLOOP_DOC_DRAFTS_TICK_MS`) |

In autonomous intake mode the doc-edit notifier and the strategy-file watch stay off by design: PM's own
doc-watch / strategy-doc read (keyed on the latest **foreign** version — `dev-loop doc history` exposes
version+author) owns that propagation, and a comms line on top would be duplicate noise. The
drafts-pending notifier runs in **both** modes — only the operator can publish, so the nudge is always
aimed at a human.

## Tests

`hub/test/daemon.ts` (wired into `npm test`) seeds a project through the real MCP write path, starts the
daemon in-process on an ephemeral localhost port, and asserts: the web UI (board + ticket detail), every
JSON read endpoint, board filters/swimlanes, the friendly non-API `404` vs JSON `/api` `404`, the
read-only `405` when human-write is off, the `127.0.0.1` bind, and — for the opt-in write surface — the
`405`-when-disabled / `303`-same-origin / `403`-cross-origin+foreign-Host behavior, the `STATES` move
guard, and operator attribution (the DL-29 cases). The notifier suites — `hub/test/blocked.ts`,
`hub/test/no-progress.ts`, `hub/test/doc-notify.ts` — cover the background notifiers above (due-ness,
dedupe, the comms-derived reminder default, self-trigger exclusion, and write-free dry-run).
