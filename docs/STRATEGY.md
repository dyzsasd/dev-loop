# dev-loop — Strategy

> PM's north star. Historically seeded by the pre-1.0 `/dev-loop:init` on 2026-06-23
> (operator-present setup); current workspaces use `dev-loop team init` +
> `/dev-loop:add-project` + `/dev-loop:add-repo`.
> `Current state` was seeded once from a read-only code map; `Vision` / `Goals` /
> `Non-goals` / `Personas` come from the operator interview. PM owns this doc thereafter
> (append-only — record shipped progress and new direction here so it stays a living
> north star, not a stale snapshot).

## Vision

dev-loop is a **standalone, long-lived coordination daemon** with **interchangeable AI-CLI
clients**. The daemon is the system of record (the `node:sqlite` hub), the coordination
service, the local web UI, and the agent-facing API — one persistent localhost process per
project. Any coding-agent CLI — Claude Code, Codex, opencode, … — connects TO this daemon as
an interchangeable client (via a thin stdio MCP shim, the `dev-loop` CLI, or a per-CLI plugin)
to operate tickets, post discussion, read the board, and steer the roadmap. The agents stay
**stateless per fire**; the daemon owns the shared state they coordinate through.

The loop still builds and maintains software through a shared ticket blackboard, steered by
operator **review (点评)** rather than by editing agent code. What changes is the substrate:
coordination moves from "N per-pane stdio processes + an optional read-only web view, all
poking one SQLite file" to "one daemon that owns the writer and serves both humans (web UI,
roadmap edit, chat bridge) and agents (the coordination API) from a single running service."

**Scope now — SINGLE-HOST, MULTI-CLI.** One machine, one trusted operator, multiple CLIs all
talking to ONE local daemon over loopback (127.0.0.1). Identity stays **cooperative
attribution** (`DEVLOOP_ACTOR` per pane, forwarded to the daemon) — honest, not anti-spoof:
on one host any local process can name any actor, so attribution is an accountability and
accident-prevention aid, not a wall. **Remote / multi-user / network deployment and a real
token-auth model are an explicitly DEFERRED later phase** — named as the boundary, not built.

**This is a deliberate reversal of the prior "no daemon" doctrine** (HUB-ARCHITECTURE §6/§14):
the hub was daemon-free by principle, with a daemon foreseen only if a push-webhook chat was
ever wanted. The operator has decided the daemon IS the destination — it is what makes the web
UI turnkey and lets the daemon own coordination. The reversal is bounded and honest: the
daemon is **localhost-only**, agents stay **stateless per fire**, and **the existing
daemon-free paths keep working byte-for-byte** — the stdio MCP server, the read-only web
daemon, and the `linear` / `local` / `service` backends are all preserved. The new
daemon-primary path is **strictly additive and opt-in**: a project that doesn't enable it is
unaffected.

The transport is chosen to dodge a known trap: each CLI talks to the daemon through a **thin
stdio MCP shim** that carries identity via an **environment variable**, never an HTTP
`Authorization` header — because headless `claude -p` drops that header on tool calls, which
would silently strip attribution from every fire. The per-CLI **identity gate** (call
`whoami` through the CLI, expect the launcher-set actor) stays the onboarding test for every
new client. _(amended 2026-07, D8/1.2.0: on `backend:"service"` the default agent transport is
now the `dev-loop` **CLI itself** — identity still rides the fire env — with the stdio MCP
shim/server kept as the sibling client and the `hub.agentInterface` rollback; the identity gate
probes whichever surface the fire actually uses — `identity-check` in the CLI's shell on
`"cli"`, `whoami` over MCP on `"mcp"`.)_

The invariants are non-negotiable and transport-independent: the **§17 self-evolution
firewall** (no agent ever auto-edits a SKILL / conventions / plugin / code file — structural
changes are operator git commits, surfaced as proposals), **§2 project isolation** (one daemon
= one pinned project, no cross-project endpoint — _amended 2026-07, D1/D2: one daemon now
serves every hub project under `/p/<key>/`, and hub ops accept a role-gated `project` override:
stewards any project or `_team`, PM `_team` only, delivery actors still refused server-side_),
and **§16 secrets/localhost-only** (binds
127.0.0.1 only; secrets live in env, referenced by name, read server-side; the SoR holds no
plaintext credential). The phased build is in `docs/design/daemon-multicli-repositioning.md`.

## Goals (north star)

**SHIPPED (operator, 2026-06-23):** the daemon + web UI + roadmap view/edit + Lark/Slack
bridge (DL-1 / DL-2 / DL-3 / DL-4) — all Done.

**Top priority (operator, 2026-06-24): the STANDALONE-DAEMON + MULTI-CLI repositioning** (Vision
above). Build it as an additive, phased arc — each phase independently shippable, the loop runnable
throughout, every current path (stdio MCP, read-only daemon, `linear`/`local`/`service` backends,
the Claude plugin) unbroken byte-for-byte. **Full design + critique-folded decisions:
`docs/design/daemon-multicli-repositioning.md`.** PM drives the backlog from these phases:

> 🏁 **MILESTONE COMPLETE — 2026-06-27 (v0.21.0).** Every build phase **P1–P5 is shipped + verified
> Done** (P1 DL-41/42/43 · P2 DL-55/62/64/67/68 · P3 DL-69/70 · P4 DL-71 · P5 DL-72). Only **Phase B**
> below (remote / multi-user + `agent_tokens` auth) stays explicitly DEFERRED. The loop now advances
> the **supporting goals** (hub/`service` hardening · agent-skill robustness · operator-facing polish
> & docs · broader portability) as concrete gaps surface.

- **P1 — Turnkey on-ramp.** ✅ **COMPLETE** (DL-41 lifecycle + DL-42 SessionStart hook + DL-43 op-API — all verified Done). `dev-loop daemon ensure` (pidfile + `hub.port` + a real `/api/health`
  liveness check, no double-start, one-per-project on a cwd-resolved port, DL-13) + auto-start the
  web UI on install/session (a Claude `SessionStart` hook — the hook half is a §17 `[pm-proposal]`
  for operator git-commit; the lifecycle/CLI half is Dev-buildable). Mount the agent op API
  (`POST /api/op/*`) DORMANT, gated on an explicit `hub.transport:"daemon"` setting (**default-off**
  → a current read-only-daemon project gets ZERO new surface). E2E: install → web UI up → an MCP
  ticket change shows in the UI, zero manual `npm run daemon`.
- **P2 — The thin stdio MCP shim.** ✅ **COMPLETE 2026-06-25 — the thin stdio shim is now a 100% `server.ts` drop-in (all 29/29 tools proxied).** Shipped family-by-family (the one-family discipline, not a 16-op mega-ticket): DL-55 (5 ticket) + **(3/n)** `doc.*`/`list_events` **DL-62** + **(4/n)** discussion-board (`topic.*`+`post.add`) **DL-64** + **(5/n)** `channel.*` **DL-67** + **(6/n)** `mirror.*`+labels+`get_project` **DL-68** — **all verified Done**. The drop-in is the **P3** (dispatch-convergence → single-writer) precondition, now MET. `shim.ts` proxies tool calls to the loopback daemon op API;
  identity rides env→`X-Devloop-Actor` (dodges the `claude -p` header-drop). Relies on the existing
  WAL + `busy_timeout` serialization (single-writer is a P3 optimization, not a P2 prerequisite).
- **P3 — Dispatch convergence, then daemon as canonical single writer.** ✅ **COMPLETE 2026-06-27.** **(a) dispatch-sharing
  refactor — DL-69 (verified Done — 767 tests green; the op-API/shim path byte-identical to the converged handlers)**: now that the op-API mirrors
  `server.ts` 1:1, `server.ts`'s 29 MCP handlers converge onto the shared `agentops.ts` ops so each
  ticket/read policy has ONE definition (retiring the "edit both files" drift tripwire at
  `agentops.ts:8-12`), behavior byte-identical (the differential-parity suite is the proof). Then
  **(b) DL-70 (verified Done)** — daemon as canonical single writer — the one long-lived writable connection (the atomic claim
  serializes in one process) + periodic `wal_checkpoint(TRUNCATE)`; the direct-db stdio `server.ts`
  stays a back-compat fallback.
- **P4 — Standalone packaging.** ✅ **COMPLETE 2026-06-27 — DL-71 (verified Done).** `npm i -g dev-loop` (core + daemon + shim + CLI + CLI-agnostic
  shared prompts), Claude-independent; reshape the Claude plugin to thin; a single-version release
  script stamps `package.json` + `plugin.json` + `marketplace.json`; the shim path via a `dev-loop`
  PATH bin.
- **P5 — Multi-CLI hardening.** ✅ **COMPLETE 2026-06-27 — DL-72 (verified Done): Codex certified end-to-end on the hub.** Certify a 2nd CLI (Codex) end-to-end on the daemon-primary path; add
  MCP-over-HTTP only if it passes the header identity gate.
- **Phase B — DEFERRED (named, not built):** remote / multi-host / multi-user + the `agent_tokens`
  auth model. The daemon's per-request actor-resolution function is the seam it slots into.

**Hard invariants (transport-independent, every phase):** §17 firewall (no agent auto-edits a
SKILL/conventions/plugin/code file — structural changes are operator-committed proposals);
§2 isolation (one daemon = one pinned project, no cross-project endpoint — see the D1/D2
amendment in the Vision above); §16 (binds 127.0.0.1
only; secrets in env by name); identity is **cooperative, not anti-spoof** on one host (honest);
every mutating op-API endpoint passes the `writeOriginOk` CSRF/DNS-rebind guard first. Honest
caveat: `doc.publish` over the op API becomes a cooperative (claim-based) gate vs today's
daemon-process-identity gate — acceptable on one trusted host, revisit under Phase B.

Supporting goals (all in scope this milestone):
- **Harden the hub / `service` backend** — robustness, tests, `doctor` coverage, and edge
  cases for the `node:sqlite` hub and the §18 backend (the daemon will build on this SoR).
- **Agent skill robustness** — tighter protocols, fewer strand/dead-loop failure modes,
  better dedupe/blocked handling across the agent SKILLs. (Edits to SKILL/conventions files
  hit the §17 self-edit boundary and stay human-gated — drafted as proposals.)
- **Operator-facing polish & docs** — onboarding (`init`), `RUNNING.md`, README accuracy
  (read v0.15.0 while git was 0.19.2 when this was recorded), examples, and error messages.
- **Broaden portability** — more CLIs / backends / integrations (Linear mirror, Lark/Slack
  channel, Codex) certified and documented.
- **The code-quality gauntlet as an adoptable surface** (added 2026-07-30; PM-proposed, operator-approved).
  `dev-loop quality` — the per-function CRAP gate (`CC² × (1−cov)³ + CC`) plus the mutation
  probe — is a **deliberate second surface**: it is useful to a repo that never runs the loop,
  and 1.7.0→1.10.0 was spent making it so (TS/JS + Go language backends, the `--diff-base` PR
  gate, and a reusable CI workflow any repo adopts in three lines). Pursue it on two fronts:
  (a) **inward** — it stays the fourth Step-5 ship gate and the Architect `test-strength`
  dimension, so the loop's own output is held to it; (b) **outward** — a legacy repo can adopt
  the gate on changed files alone, with no big-bang cleanup and no coordination substrate.
  **Boundary:** the gauntlet is a *gate and a report*, not a linter, a formatter, or a
  refactoring engine — it measures risk and test strength, and dev-loop does not grow a general
  static-analysis product around it.
  *Sequencing (operator, 2026-07-30): a mandate, not a pivot — the active program stays
  resilience (shipped, v1.11.0) → observability/metering (LOOP-12..15 → LOOP-3 → LOOP-4);
  sequence quality-line filings behind it.*

## Non-goals

- **Not Linear-locked.** Linear is a default, never a requirement; the loop must keep
  working on the `local` and `service` (hub) backends.
- **No default human step-by-step gating.** Safety comes from machine gates (red build
  never ships, diff self-review, deploy smoke-check + auto-revert), not interactive
  approval prompts (`autonomy:"full"`). dev-loop is not a human-approval workflow tool.

> _(Note: "no daemon" and "no GUI/web UI" were considered as non-goals but **rejected** by
> the operator — both are now in-scope per the Vision above.)_

## Current state

- **What it is:** a standalone `dev-loop` npm package + Claude Code plugin
  (`github.com/dyzsasd/dev-loop`) implementing **nine launchable autonomous agents** that
  coordinate through ticket state: PM, QA, senior-dev, junior-dev, Sweep, Reflect, Ops,
  Architect, and Communication. The legacy single `dev` path remains only as an explicit fallback
  for projects that opt out of split Dev.
- **1.0 runtime model:** one workspace directory = one team = one backend = one `dev-loop.json`.
  New installs start from `dev-loop team init`; `dev-loop.json` is the source of truth.
- **Main surfaces / modules:** `skills/` agent and operator skills; `references/` shared specs
  (`conventions.md`, `config-schema.md`, `codex-integration.md`); `hub/` — the `node:sqlite`
  service backend + `dev-loop` CLI, **v1.11.0 line** (see `CHANGELOG.md`), with the full npm test
  suite; `docs/`
  for architecture, running, portability, daemon, design records, and reviews; `config/` for
  MCP templates and example workspace config.
- **Coordination backends (§18/§27):** `linear` and `service` are the current 1.x paths. The
  service hub stores state under `<workspace>/.dev-loop/`, exposes the multi-project localhost
  web UI (`/p/<key>/` + the docs pages), can
  mirror to Linear (tickets + published docs, with the comment→intake poller), and is reached by
  agents through the `dev-loop` CLI by default (`hub.agentInterface`; MCP is the sibling +
  rollback).
- **How it runs:** the scheduler **`dev-loop run`** fires stateless-per-fire agents with
  per-agent coding CLI, model, effort, and cadence resolved from `dev-loop.json`. Agent View rows
  share the same `next-project` rotation picker.
- **Operator steering:** daily/weekly reports and 点评 are distilled into lessons; direction lands
  through the strategy/doc system and operator-reviewed changes.

(operator, 2026-07-05: Current state re-synced to the 1.0 workspace release. For the
always-current user-facing picture, see README.md + CHANGELOG.md.)

(operator, 2026-07-12: Current state re-synced to the **1.2.0** release — the 2026-07 full
review, decisions D1–D11 in `docs/design/2026-07-review-decisions.md`: CLI-first agent
interface (D8/D9; claude + codex certified), guided `dev-loop init` wizard, multi-project web
UI + docs system (D2/D3), role-gated hub `project` override (D1), PM investigation protocol +
Linear doc mirror (D4/D5), doc archiving (D6), and the uniform SKILL template with enforced
context budgets.)

(pm, 2026-07-30: **`Current state` re-synced 1.2.0 → v1.10.0.** The previous PM fire flagged this
section as eight releases stale but did not take it over, reading the two prior re-syncs as
operator-owned. §20 settles it — `Current state` is a PROGRESS section PM commits directly,
append-only — so here is what shipped after the 1.2.0 line above, per `CHANGELOG.md`:
- **1.3.0** — the 2026-07 field-report hardening batch (a 6-day dogfood, 1,472 fires); **any
  OpenAI-compatible model provider** through the opencode lane: provider registry,
  `team sync-opencode`, certification.
- **1.4.0** — **one-click workspace lifecycle**: `dev-loop up` / `bundle` / `attach` — a workspace
  home you can land in, move (an encrypted `age` bundle carrying config + secrets + `hub.db`), and
  drive against a remote hub.
- **1.5.0** — **the per-fire context program**: conventions progressive disclosure (kernel +
  tripwires + pay-per-use references), the runner-assembled boot prefix, the §21c cut and the
  snapshot doctrine, and `queue` as every board agent's first read. Plus the local
  **developer-code security scanner** + its CI wiring (`security/`).
- **1.6.0** — **multi-provider runner hardening**: the liveness/stall watchdog (a silent fire dies
  in minutes, not hours), `OPENCODE_CONFIG` injection, opencode model preflight, a config-integrity
  guard, tier-label⇒assignee at create, and `run --background` + `stop` (the operator-console loop
  lifecycle).
- **1.7.0–1.8.1** — **the quality gauntlet**: `dev-loop quality` (per-function
  `CRAP = CC² × (1−cov)³ + CC` over native V8 coverage) plus the mutation probe; `build.quality` as
  the fourth Step-5 ship gate; the Architect `test-strength` dimension; executable ACs; §8
  exact-title dedupe at the write; `team set-model`; and the gauntlet turned on its own codebase
  (CRAP ratchet 160 → 90).
- **1.9.0** — a **Go language backend** for the gauntlet: same formula, report, gate, ratchet and
  mutation probe, with the language picked per FILE.
- **1.10.0** — **`--diff-base` PR gate + a reusable CI workflow**: the legacy-repo adoption path —
  gate only what a PR touches, no big-bang cleanup, adoptable in three lines.

Recorded as shipped reality only. Whether the quality line is product *direction* is the open
question, parked for the operator on **LOOP-18** — `Goals` is unchanged pending that ruling.)

- **2026-07-30 — [ARCHIVED] the 2026-07-30 build-out arc.** The landing wedge (nothing had landed
  since v1.10.0 → the CRAP-ratchet block cleared → **v1.11.0 shipped**); runner resilience completed;
  the metering foundation landed with its join key uncarried; landing observability + `doc-land`
  specified and gated; the board-read truncation and write-only dependency-graph findings; the
  five-of-nine-agents finding; `sensitive` stopped being decorative. All superseded by the
  2026-07-31 arc below and by the shipped code. Full provenance rolled to
  **`docs/strategy-archive/2026-07.md`** (§20 R2 ledger-rollup, 2026-07-31) so this section stays the
  recent, actionable tail.
- **✅ The fire ledger stops writing what `secrets.ts` promises never to log (2026-07-31).**
  `origin/main` advanced `8cc84c5` → **`a0afe6e`** (LOOP-62). **Verified `Done` against the merged
  tree**, all six ACs, from a throwaway worktree — `recordFire` no longer spreads `extra` whole into
  `fires.jsonl` but enumerates the safe telemetry fields exactly as the `logEvent` sibling always
  did, so the raw 400-byte CLI tail never reaches disk; the ledger is created `0600` and its dir
  `0700`, while a **pre-existing** loose file is warned-once and *never* chmod'd behind the operator.
  All three perms branches were exercised directly, and **AC4 was proven in both directions**: the
  new test passes at `a0afe6e` and fails at `8cc84c5` with 3 checks red, including the seeded
  credential reaching the ledger. The breaker still receives the tail as an in-memory argument, so
  classification is untouched — `outputTail` now has writers, one in-memory consumer, and no
  persisted reader. **Residual filed as LOOP-93** (senior, p2, `sensitive`): `run.log` (196 KB) and
  every `runner-logs/*.log` are mode `644` and carry the *full* unredacted stream — the same §16
  defect with a larger blast radius, and there the fix is perms only, because unlike `outputTail`
  those files have real consumers. Recorded because the shape recurs: **one sink in a function was
  written with the discipline and its sibling three lines away was not.**

- **📋 The tier-routing rule and the discovery process now pull against each other (2026-07-31).**
  Fifth consecutive fire with junior over its depth cap: **junior 14 unblocked `Todo` / cap 10,
  senior 7 / cap 10 — and all 16 unblocked `Backlog` tickets are junior-tier, so senior's three free
  slots have nothing eligible to fill them.** This is structural, not a scheduling accident: §21b
  routes "scoped improvement / bug-fix" to junior and says *"when borderline, junior"*, while the
  rotating-lens discovery process produces almost exclusively scoped fixes. The queue can therefore
  only drain through the tier that is already over cap. Recorded, not acted on — re-tiering to
  balance load would be exactly the inference §21b forbids, and changing the rule is a §17
  governing-file edit. Named here because it has now outlived five fires and is the loop's real
  throughput ceiling.

- **✅ Daemon-lifecycle hygiene designed and gated; the gate's finding was in the coordination, not
  the crux (2026-07-31).** LOOP-53 — 58 leaked test daemons on one laptop, 53 holding deleted fixture
  DBs, the oldest up 13 days, collectively owning the documented board port `:8787` — passed the §21a
  design gate; **LOOP-94** (test teardown harness) and **LOOP-95** (`dev-loop daemon reap` +
  `/api/health` identity + probe warning) are promoted to `Todo`. The design's hard part is right and
  I re-derived every load-bearing code fact rather than trusting the hand-off: reap **iff** the
  listener self-identifies as `service:"dev-loop-hub"` **and** reports `dbPresent:false` — never age,
  port, or fixture name. That rule exists because **SQLite keeps the open fd valid after the DB path
  is unlinked**, so `/api/health` answers `ok:true` forever against a deleted database — liveness is
  not a reap signal, DB-presence is — and a real workspace's DB always exists, so a live board
  (including a foreign one) is provably never reaped. What the gate actually caught was one rung
  down: the design asserted the two children were file-disjoint and could *"land in either order"*,
  but child B's own file scope writes into `hub/test/*`, and child A's guard is a **wildcard source
  scan** over `hub/test/*.ts` — so B-then-A turns A's guard red on files A was never told about.
  Fixed by amending both children rather than failing a sound design. **The generalisable shape: a
  decomposition can be correct in every child and still wrong in the seam between them — check the
  ordering claim separately from the ACs, because nothing in the AC mapping can surface it.**

- **📋 The board's read paths were bounded for agents and never for humans (2026-07-31).** The
  polish-performance lens: the daemon has **four** board-list read paths and only the two agent-facing
  ones are bounded. `list_issues` carries an explicit default cap of 250 plus a `fields:"summary"`
  mode (`agentops.ts:176-180`), and `list_events` validates `limit` and pushes `LIMIT` into SQL
  (`:353-357`) — while **`GET /api/tickets`** (`daemon.ts:618-627`) and **`GET /`**, the operator's own
  web board (`views/board.ts:160`), both `SELECT *` every row with full descriptions, filter in JS
  afterwards, and have no cap and no pagination. Measured live: 95 tickets ⇒ **433.6 KiB** of JSON, 92%
  of it description text; `?limit=1` still reads all 95 rows; and **`?fields=summary` is silently
  ignored** — the caller asks for a summary and gets 68× the bytes with no error. Nothing is slow today
  (4 ms on loopback) and the ticket says so plainly; what earns the filing is that the growth is linear
  and unbounded forever, and that the silent-param-drop is a **correctness** bug already fixed once in
  this exact handler (`daemon.ts:625` — *"DL-31: honor `?assignee` (was silently ignored)"*). Filed as
  **LOOP-96** (p3, junior). `hub/src/db.ts:94` already names the three ticket paths as one family —
  the codebase knew they were siblings; only one of them got the bound.

- **📋 The throughput ceiling tightened, and the loop's own gate mechanics tightened it (2026-07-31).**
  Sixth consecutive fire over cap, now **junior 15 unblocked `Todo` / cap 10, senior 7 / cap 10, and
  still zero unblocked senior-tier tickets in a 22-deep `Backlog`.** Two of this fire's three writes
  pushed the same direction and both were correct: the §21a design gate promoted its two children
  past the cap **by design** (a gate promotion is not a §5a promotion), and §21b routed this fire's
  new filing to junior on its explicit signals. So the imbalance is not drift to be corrected — it is
  what the rules produce when a design-gate tier and a discovery-lens tier are the same tier. Senior's
  three idle slots cannot be filled without either an operator ruling or work that genuinely needs
  design. **This is the loop's binding constraint; no single ticket on the board is.**

- **📋 Five increments reached `In Review` without landing — and the rule they broke was already
  written down (2026-07-31).** Both tickets in PM's verify queue this fire had **open, unlandable
  PRs**: LOOP-19 (#54, `mergeable: CONFLICTING` — required checks never even ran) and LOOP-26 (#55,
  both required checks `FAILURE` on a `TS2345` in the ticket's own new test). Repo `dev-loop` runs
  `landing:"pr"` **+ `autoMerge:true`**, where §12c / dev-agent Step 6 is explicit: *the ticket stays
  `In Progress` from PR-open until Step 0.5 merges the **green** PR — only then `In Review`.* A sweep
  of every open PR found the same shape on **LOOP-45** (#39, CONFLICTING, QA-owned), and LOOP-89
  already records **LOOP-13 + LOOP-14**. That is **five increments across three fires**, hitting
  **both** verification owners and **both** dev tiers' output — which rules out "one agent's SKILL
  needs better prose" as a sufficient fix. Counter-case that must keep working: LOOP-43 (#38) is
  merged and legitimately `In Review`. Evidence routed to **LOOP-89** (senior, `Mode: design`, Todo)
  rather than a new ticket; both PM-owned tickets returned to `In Progress` with the exact fix named.
  **The mechanism worth naming: `npm test` green is not the ship gate under `landing:"pr"` — the PR's
  `mergeChecks` are.** LOOP-26's author ran `npm test` (green) and never ran `npm run typecheck`,
  which is a *separate script* that CI runs as its own step. A local gate that is not the CI job's
  step list is a gate that reports success on unlandable work.

- **📋 "Search the board" is two searches, and neither is a superset of the other (2026-07-31).**
  The competitive-parity lens, measured against the live daemon: the human's web `?q=`
  (`views/board.ts:156-159`) matches **id + title + the first 5,000 chars of description** and
  **no comment at all**; the agent's `list_issues query` (`agentops.ts:165-172`) matches **title +
  full description + comment bodies** with whitespace-AND-ed terms and **never the ticket id**. Both
  fail silently — an empty result reads as "no such ticket", never as "this surface doesn't index
  that". `dev-loop tickets --q LOOP-96` returns **zero rows** for a live open ticket; a web search
  for a term living only in comments returns **zero cards**. What the human's search cannot reach:
  **188,374 bytes across 156 comments on 57 of 96 tickets — 31.6% of all board text**, including
  every §9c `Blocked-by:` edge, every verify ruling, and designs authored as comments (LOOP-10's
  design is one). Plus **8.1% of description text** past the 5,000-char scan cap, on the 31% of
  tickets whose descriptions exceed it. The agent path's comment clause is documented as deliberate
  — *"so the §8 dedup query catches a reworded duplicate whose only match is in a comment"* — so the
  value was already established here; the human surface simply never got it, and nothing recorded
  that the two diverged. Filed as **LOOP-97** (p2, junior); a third silently-ignored param on
  `/api/tickets` (`?q=`, joining `?fields=summary`) folded into **LOOP-96** rather than filed.

- **✅ The landing wedge cleared: all three handed-back increments came back green and verified Done
  (2026-07-31).** `origin/main` moved `6e02a8f → 2594f9c` **mid-fire**, carrying **LOOP-63** (#56,
  `9ff4abd`), **LOOP-26** (#55, `7823c59`) and **LOOP-19** (#54, `2594f9c`) — every one with both
  required checks SUCCESS. Two of the three (LOOP-19, LOOP-26) are exactly the tickets the previous
  fire returned to `In Progress` as unlandable, which **closes the loop on the §12c hand-back
  ruling**: the state-error path did what a verify-fail would not have — the increments were rebased
  and landed rather than Canceled and re-specified. Verify queue went **0 at boot → 3 at pre-report**;
  had this fire trusted its boot snapshot it would have shipped nothing. **The pre-report board
  re-read has now paid on four fires out of five.** All three verified against a detached worktree at
  `origin/main`, never the installed binary (still 1.11.0, still 12+ commits stale — LOOP-38).
- **⚠️ A full local `npm test` cannot reach the end of its own chain on this machine, in either
  env.** Measured while verifying: inside a fire, **33** `run-agents` assertions fail on ambient
  `DEVLOOP_*` (**LOOP-45**); with the env stripped, `test/lifecycle.ts` dies of an uncaught ENOENT
  against the foreign v1.2.1 daemon still squatting **:8787** (**LOOP-84** p1 · **LOOP-52**, both
  still reproducible). The abort lands at **chain link 27 of 68**, so `seed`, `consistency`,
  `accept-rate`, `quality` and 30+ others never execute — and `seed`/`consistency` are precisely the
  two suites **LOOP-63's own ACs name**. This is **LOOP-86** demonstrated on a live verification
  rather than argued: the ship gate silently under-ran the evidence a senior increment needed, and
  only running the suites directly surfaced it. CI, on a clean runner, was green throughout.
- **📉 The loop's headline quality KPI overstates itself by 11.5 points, in both implementations
  (2026-07-31).** The data-analytics lens: `acceptRate = done/(done+verifyFails)` builds a ratio from
  **two different populations** — the numerator counts *every* transition into `Done` board-wide
  (`metrics.ts:131`), the denominator only `In Review → Canceled` (`:132`). Measured on the live
  board: **86.5% reported vs 75.0% true**. Two independent errors that push the **same** way —
  2 of the 32 Dones never entered `In Review`, and **5 of 40 `In Review` exits (12.5%) are counted
  nowhere**: `In Review → In Progress` (3, the §12c hand-back this very fire vindicated) and
  `In Review → Human-Blocked` (2). The web `/activity` metric (`views/activity.ts:140,199`) has the
  **identical** defect (86% vs 75%), so there is no correct sibling to copy. `test/accept-rate.ts`
  covers that surface with 30 assertions and passes anyway, because its fixture helper is
  `trans(db,"In Review","Done",ms)` — **every Done it seeds is already an In-Review Done**, so the
  numerator's scope is invisible to it. Filed **LOOP-98** (p2, junior, both sites + both test gaps).
- **🔕 The split shipped in LOOP-26 turned a noisy number into a confident wrong one.** `blockedNow`
  keys on the `blocked` **label**, but on `backend:"service"` the operator park is the
  **`Human-Blocked` STATE**. **LOOP-92** — awaiting an operator ruling for four fires — carries no
  `blocked` label, so `dev-loop metrics` now renders **`0 parked`** on the field whose own source
  comment reads *"need human attention"*. Before the split it read `13 blocked open`: noisy, but
  non-zero, so it forced a look. `metrics --json` now **contradicts itself** — `.decisionQueue` sees
  LOOP-92, `.blockedNow` does not. Outside LOOP-26's ACs (all label-scoped) so explicitly **not** a
  verify-fail; routed to **LOOP-31** as a binding added AC, which the same fire also unparked.
- **🎯 The stranding detector reads a hand-picked 2 of 5 open states — and the loop just fixed the
  other axis of the same function (2026-07-31).** `origin/main` advanced `2594f9c` → **`a273f6a`**
  (LOOP-30, PR #57, one commit, three checks green). **Verified `Done`** from a detached worktree,
  all five ACs, stage-1 triage clean: `ownerLiveness` now resolves ownership from
  `union(assignee, label)` for `Todo` and label-only for `In Review`. Recorded honestly on the
  ticket: **the fix changes no number on today's board** — every open ticket happens to carry both
  signals, so `labelOnly == resolved` for all four handles. That is its own AC5 ("no behaviour change
  when a handle carries both signals") holding, and the value shipped is a *latent* silent-zero
  removed, not a visible correction. The **consistency** lens then walked the adjacent axis — *which
  states* count as owned — and found the same function wrong in **both directions at once**:
  it counts `blocked` tickets its own router refuses to serve (`agentops.ts:206`/`:218` filter the
  label out; `ownerLiveness` alone does not) — **6 of 23 for junior-dev, 7 of 26 for pm, ~26%
  inflation** — while W16's remedy line, *"re-owner them"*, is a **no-op** on exactly that subset;
  and it cannot see **`In Progress`** at all, the one state where a stale claim's only recovery is
  *the claimant firing again*, because the runner-side reaper is deliberately scoped to
  `if (timedOut || stalled)` (`run-agents.ts:1166`, LOOP-10) and this workspace logged **21 non-zero
  exits against 1 timeout in 7 days**. The web `/activity` page already flags that state
  `⚠ possible-orphan` (`views/activity.ts:261`); the CLI gate the operator actually reads returns
  `DOCTOR_OK`. Filed **LOOP-102** (p2, junior). Two candidate findings were **not** filed — both
  turned out to re-derive rulings already in this log (see the Decisions entry below).
- **🔥 The loop shipped a destructive verb under a non-destructive name, and four callers still hold
  the old contract (2026-07-31).** `origin/main` advanced `a273f6a` → **`49644f8`** (LOOP-37, PR #58).
  **Verified `Done`** against the merged tree: `dev-loop worktree path` returns the canonical
  `wsWorktree()` path, and `worktree reap --dry-run` correctly selected **7** stale worktrees across
  **four distinct roots** (`.dev-loop/wt/`, `<ws>/worktrees/`, `/private/tmp/dev-loop-*`,
  `/private/tmp/worktree-*`) while keeping every open ticket, the non-standard branch name, and three
  detached-HEAD trees. The reaper is right. What no AC covered is what it inherited: the same commit
  turned **`dev-loop team repair`** from `git worktree repair` + `prune` — which deletes nothing — into
  a pass that runs `git worktree remove --force` and `git branch -D`. **`bundle.ts:380` calls it with
  no `--dry-run`, unattended, on the headless `dev-loop up --bundle` path, and *ahead of* the `doctor`
  fail-fast gate** (`:377-382`); `config-schema.md:19` prescribes it as the machine-migration recipe;
  `conventions.md:2370`/`:2403` and `skills/sync-repo/SKILL.md:52` all still describe a path/index
  fixup — the last of those being an instruction an **agent** executes. And `Canceled` force-deletes a
  branch regardless of upstream or merge state, while §3 makes `Canceled` the **verify-fail** state, so
  the targets are exactly the increments a follow-up ticket wants. Filed **LOOP-106** (p2, senior,
  `sensitive`), promoted the same fire — the first unblocked senior-tier work the lens has produced in
  eleven fires, routed there by §21b's explicit *"data migration/**deletion**"* signal, not by senior's
  idle slots.
- **✅ The quality ratchet earned its keep, and named the next chokepoint.** LOOP-56 reached `In Review`
  with both required checks concluding **FAILURE**: `quality: CRAP threshold exceeded — max 90.4 > 90`,
  the offender being **`doctorWorkspace` (`doctor.ts:185`, CC 64, cov 81.4%)** — the very function its
  W19 block extends. Self-inflicted, over by **0.4**, and structural: that one function already carries
  **ten** W-code blocks (W05/W06/W09–W16), and **LOOP-46 (W18), LOOP-74 (W20), LOOP-81 (W21)** are all
  in `Todo` waiting to add an eleventh. Closing the gap with coverage leaves CC at 64 and hands the
  same wall to the next ticket, so the fix was directed at **extraction**. Deliberately **not**
  verify-failed (see Decisions).
- **⛔ The 68-link test chain stopped a landing, not just a measurement.** LOOP-40's PR #59 is
  `CONFLICTING` against `49644f8` for exactly one reason: LOOP-37 and LOOP-40 both edit the single
  ~4.5 KB `"test"` line in `hub/package.json` — one inserting `team-repair.ts` mid-chain, one appending
  `landing.ts`. Semantically disjoint, textually unmergeable; `git merge-tree` reports that one file
  and nothing else. Its code verified clean (25/25 assertions, typecheck green, spec triage clean), so
  this is a pure landing tax. **LOOP-86**'s filed cost was silent partial runs; its second cost is that
  the chain **serializes every concurrent increment that adds a suite** — with two dev tiers running,
  the common case. Recorded there as a binding shape on the fix, not refiled.
- **⛔ The first verify-fail caused by a missing *test*, not missing code (2026-07-31).** LOOP-99
  (defaultBranch seam, LOOP-70 Child A) shipped a clean increment — exactly the 7 files its spec names,
  `test/team-config.ts` + `test/worktree.ts` + `test/push-guard.ts` all green on PR #61's head `c5ec5c8`
  with `DEVLOOP_*` stripped, typecheck clean, no EXTRA, no MISUNDERSTANDING — and still failed §3 on
  **AC2**: `pushGuard()`'s signature at `push-guard.ts:29` still carries `defaultBranch = "main"`. Not a
  reading invented at verify time — the design **enumerates that exact line** (`default-branch-resolution`
  §3 names `push-guard.ts:27,41,88`; §4 requires *"no `"main"` literal anywhere in this file (AC2)"*).
  `:88` and `:41` were fixed; `:27` was not. **The second missing delta explains the first:** design §5
  mandates *"assert no `"main"` string-literal remains as a branch default in either file"*, and no such
  assertion exists in `hub/test/push-guard.ts`. The one AC that would have caught the residual is the one
  nobody wrote — so the ordering, not the code, is the lesson. Live blast radius today is zero (the sole
  production caller passes a resolved value), but the new AC4 path only fails loud when
  `origin/<branch>` **fails to resolve**: on a `master` repo that still carries an `origin/main` ref, an
  arg-omitting caller silently detects passengers against the wrong base — the *"fails open, silently"*
  shape the design exists to kill, reintroduced through the seam meant to remove it. Superseded by
  **LOOP-107** (senior, `Mode: direct-code`, two deltas on top of the surviving branch).
- **🔥 LOOP-43's truncation is 8× worse than documented, and it silently corrupted a live §9c pass
  (2026-07-31).** The ticket records **65,536 bytes**, re-measured through a shell pipe fourteen times.
  Through a **Node parent capturing stdout** (`spawnSync`/`execSync` — how an agent reads the board when
  it parses with `node -e`) the cliff is **~8.1 KB**, still `exit 0`, still silent: `tickets --json`
  515,269 → **8,115**; `comments LOOP-38` 24,808 → **8,099**; `comments LOOP-4` 8,560 → **8,122**. Below
  8 KB it stops being a whole-board problem and truncates **single-ticket comment reads** — which is
  where this loop keeps its `Blocked-by:`/`Unblocked-by:` dependency ledger. **It cost a wrong answer
  this fire:** the §9c tracker pass resolved **LOOP-50, LOOP-38 and LOOP-4 to zero blocker edges** — the
  three longest threads on the board, every marker present and canonical. §9c's *"a zero-edge ticket is
  never an unpark candidate"* is the **only** reason it failed safe: three blocked tickets became
  permanently un-parkable rather than spuriously released onto unbuilt foundations. That asymmetry is
  luck, not design, and it inverts the moment any consumer reads zero-edges as *unblocked*. The merged
  fix (`8cc84c5`) covers both thresholds — verified side by side, same board, same moment: installed
  `1.11.0` → 8,115 bytes unparseable, `origin/main` source → 517,936 bytes, 107 tickets. So this is
  **purely LOOP-38's deploy gap**, whose severity it raises from *partial reads* to *silent dependency-
  graph corruption*. Routed as evidence (LOOP-38, LOOP-43) and one binding read-integrity AC (LOOP-104).
- **🚢 The loop shipped again after three frozen fires — and what unstuck it was a ticket STATE, not
  code (2026-07-31).** `origin/main` moved **`49644f8` → `bf890d3`** (LOOP-73, PR #62), the first
  landing in three PM fires. It was not waiting on a build: the PR had been `MERGEABLE`/`CLEAN` with all
  three checks green for ~35 minutes. **It was parked in a state no agent could act on.**
  `agentops.ts:205-210` builds a dev tier's queue as `todo` + its **own `In Progress`** — `In Review` is
  in neither — while §12c says that under `landing:"pr"` + `autoMerge:true` a ticket **stays
  `In Progress` until its green PR merges**, because the Dev tier owns landing it. Junior-dev has been
  moving tickets to `In Review` at PR-open (the §12b *human*-merge flow) instead, so five increments sat
  in a state where the only agent permitted to land or fix them could not see them. Returning LOOP-73 to
  `In Progress` at 01:25 put it back in view; Step 0.5 merged it at **01:29:05Z**, four minutes later.
- **📉 The measured cost of that gap, because it is not theoretical.** PR #60 (LOOP-56) failed CI on the
  CRAP ratchet; head `f3e7a9ed` committed **00:26:08Z**; PM's diagnosis posted **00:37:52Z**; junior's
  next fire ran **00:54:35Z** and correctly worked its actual queue. The head never moved — the
  instruction was written to a ticket the recipient structurally could not read. Same shape on LOOP-40
  (PR #59, one-file `hub/package.json` conflict, all checks green, **gates seven tickets**), LOOP-57
  (PR #64, doc-land) and LOOP-67 (PR #65). All five corrected to `In Progress` this fire with the exact
  remaining action named. The running tally of increments handed off unlandable is now **nine** — routed
  as evidence to **LOOP-89**, which owns the mechanism, and broadened there from *admission* (don't let
  a red increment in) to **admission + egress** (an increment that gets in must stay reachable by the
  tier that owns landing it).
- **⚠️ Two guards that are correct and would deadlock if wired today.** **LOOP-67** (built, verified,
  PR #65 green) adds a merge-guard axis tripping on `In Review`/`Canceled`/`Duplicate`. Its premise is
  exactly the §12c invariant above — which is the thing not currently holding — so wiring it `--strict`
  into Step 0.5 (**LOOP-69**) before the state discipline lands would make **every** junior PR
  permanently unmergeable. Sequencing recorded on both tickets: land §12c discipline → advisory for one
  cycle → `--strict`; or enforce only `Canceled`/`Duplicate`, which has no downside today and would
  already be earning its keep — **#48, #49 and #61 are open PRs on Canceled tickets right now, and #61
  is green and mergeable.** §12c's merge pass keys on *"green AND mergeable"*, reading the PR and never
  the board, so cancelling a ticket does not stop its work from shipping.
- **↩️ Correcting the entry above: the state correction did not unstick the loop — greenness did
  (2026-07-31).** The previous bullet's headline — *"what unstuck it was a ticket STATE, not code"* —
  **is not supportable, and I am withdrawing the causal half of it.** §12c's fire-start merge pass
  iterates `gh pr list --search "head:dev-loop/ is:open"`; board state is an **output** of that pass
  (*"then move the ticket In Progress → In Review"*), never an input. The same paragraph one bullet up
  says so in its own last sentence. A **senior-dev fire was already in flight** (started 01:18:45Z) when
  PR #62 merged at 01:29:05Z, so the landing is fully explained without my edit. The correlation was
  four minutes; the mechanism was a running dev fire. The next hour separated the two cleanly: **PR #65
  (LOOP-67) merged at 01:43:43Z** moving `origin/main` to `3f6af36`, while LOOP-56 (#60, red) and
  LOOP-57 (#64, now `DIRTY` since the base moved) did not — all three had been state-corrected
  identically. **Greenness explains which PRs land. The state correction explains something different
  and still real: reachability.** LOOP-56 and LOOP-57 need a human-equivalent *fix*, and `In Review` is
  where no dev tier can see them. Both claims were true in the original entry; only one of them was the
  cause, and I asserted the wrong one as the headline.
- **🚪 The other half of that gap now has a ticket instead of a state file (2026-07-31).** `In Review` is
  a one-way door for a dev tier: `agentops.ts:205-210` returns `Todo` (mine, unblocked) + `In Progress`
  (`assignee === actor`), and nothing else. **Live evidence: LOOP-45** — `In Review`, assigned
  `junior-dev`, PR #39 `OPEN`/`CONFLICTING` with the required checks having **never run**, stranded ~9
  hours. Two QA fires re-checked it and correctly wrote nothing, because nothing *can* change: junior
  cannot see it to rebase, and §3 offers QA only `Done` (it isn't) or `Cancel`, which would destroy a
  correct 32-assertion fix over a merge conflict. Counter-example that must stay healthy: **LOOP-43**,
  also `In Review`, but PR #38 `MERGED` — verification-pending is the right state. A second-order find
  from the same read: `inProgress` filters on `assignee === actor`, **not** the tier label, so a ticket
  parked in `In Progress` but assigned to `pm` is invisible to Dev too — I hit that on LOOP-75 today and
  had to reassign by hand. Filed as **LOOP-112** (a third, explicitly non-pickable `inReview` list on
  the dev slice, keyed on the same `assignee === actor` rule, annotated with LOOP-111's landing seam).
- **✅ LOOP-89's design gate passed; the loop will stop admitting unlanded work (2026-07-31).** Senior's
  `review-admission-gate` design picks **one** authoritative point — the CLI `ticket update` verb
  refuses `In Progress → In Review` when the ticket's PR is not `MERGED` — and argues down the hub
  `ticketwrite.ts` gate I had pushed for: `updateTicketRow` runs in the daemon with **no network**, and
  no offline per-ticket merged signal exists in board state today (LOOP-40's `readLandingState` is
  repo-aggregate and `gh`-based, so it cannot supply one). The reversal is correct and I accepted it.
  The strongest call is the predicate: **`MERGED` strictly implies "was green AND mergeable"**, so one
  condition subsumes the concluded-red case, the pending case *and* the absent-checks case (LOOP-19/#54)
  that a "no red check" test wrongly passes. Children **LOOP-110** (the gate) + **LOOP-111** (verify-queue
  landing annotation) promoted to `Todo`; parent `Done`.
- **🔍 A guard that landed 10 minutes ago is blind to the operator's own decision queue (2026-07-31).**
  `merge-guard.ts:15` (LOOP-67, shipped in `3f6af36`) declares `NOT_MERGE_ELIGIBLE = {In Review,
  Canceled, Duplicate}`. `db.ts:30` — the declared single source of truth — lists **eight** states. The
  other five are merge-eligible **by omission**, and one of them is **`Human-Blocked`**: the loop's only
  explicit "a human must rule on this" park, and the entire content of the operator's decision queue
  (`daemon-notifiers.ts:72` selects on it by name). A guard whose stated purpose is stopping *"a human's
  single most deliberate act of steering, discarded silently"* would merge over it. **It is not a
  trade-off — the design never saw it:** `Human-Blocked` appears **0 times** in `merge-review-guard`,
  whose §3.3 reasons only about `In Review` and terminal-reject states. Reachable via §12c's own text
  (`fix-exhausted` → a §9 park → `Human-Blocked` on `service`, **PR still open**; a later green re-run or
  a base move then makes it mergeable). **Latent, not live** — the two `Human-Blocked` tickets have no
  PR, and I checked before filing. Root cause is the negative set: four sites partition `db.ts`'s eight
  states with their own hand-written literals, and `Human-Blocked` is the proof, having been **added
  later** (`db.ts:257`, DL-25) into every pre-existing set's permissive side. Filed as **LOOP-113** —
  invert to a positive `MERGE_ELIGIBLE` so an unknown state fails **closed**, plus an exhaustiveness test
  driven off `db.ts`'s exported list so a ninth state breaks a test instead of silently widening merges.
- **🔍 The loop's failure taxonomy explains 1 of its 26 failures; the other 25 are all the same cause
  (2026-07-31).** `dev-loop metrics` reports `fires: 174 … 26 failed` above `errors: timeout×1`. Reading
  `.dev-loop/team/fires.jsonl` directly: `{"timeout": 1, "(none)": 25}`, and **all 25 unclassified rows
  carry one tail** — `"You've hit your session limit · resets <time> (Europe/Paris)"` (junior 6, senior 6,
  qa 6, pm 6, sweep 1). `classifyFireError` matches `spend limit|usage limit|monthly limit|…` and
  `rate limit|too many requests|429|…`; Claude Code emits **`session limit`**, which hits neither, so the
  class is `null`. Two consequences, both measured. **(a)** `PROVIDER_SCOPED_CLASSES` is keyed on the
  class, so a `null` can never enter it and the streak falls to the per-agent lane — meaning the
  provider breaker **LOOP-8 built for exactly this case** ("when one key is exhausted every agent on it
  fails identically") cannot engage for the one failure that actually exhausts the key. On 07-30
  20:36→20:59 four agents each independently accumulated their own 5-failure streak: **20 wasted fires
  where a provider-scoped trip costs 5**, a multiplier equal to the agent count on the provider (9 at
  full roster). **(b)** `metrics.ts:68` tallies `byErrorClass` only `if (r.errorClass)`, so both
  `metrics` and `doctor`'s "top errors" line drop all 25. Filed as **LOOP-114**. Worth stating plainly:
  the per-agent breaker **did** trip and the 60-minute probe cadence held — this is a 4× overpay and an
  observability hole, **not** the blind-retry runaway LOOP-1 was built to stop.
- **🎚️ The merge gate that protects every PR is passing by exactly zero, and its top entry has no
  test file at all (2026-07-31).** The CRAP ratchet (`node src/quality.ts --coverage-dir .v8cov
  --threshold 90 --top 15`) is a required check on both Node lanes; `quality.ts:654` gates on
  `maxCrap > threshold`. Read from the last green run on `origin/main` @ `2dc6c7b` (run
  `30598713412`, 02:26:57Z): max is **`isError` (`fire-usage.ts:48`) at CRAP 90.0 against threshold
  90 — a margin of 0.0**. The score is arithmetic, not judgement: `CRAP = CC²·(1−cov)³ + CC`, and a
  CC-9 function at **0.0% coverage** is exactly `81 + 9`. There is no `hub/test/fire-usage.ts` and no
  test in the 68-link chain imports `codexUsageAdapter` — the function shipped with LOOP-15, passed
  review, and has never been executed by a test. One added branch anywhere in it red-lines every loop
  PR, which is the outage LOOP-22/LOOP-24 already lived through once. Filed as **LOOP-115**.
- **🧱 A second entry sits at 86.7 that no amount of testing can lower — CRAP floors at raw CC
  (2026-07-31).** `daemon.ts:449` (the 225-line anonymous `createServer` handler holding the whole
  daemon HTTP surface: 38 `if`, 31 `&&`, 35 ternaries) measures **CC 86 at 95.4% coverage**. The
  coverage term contributes 0.7 of its 86.7; the rest is the undiscounted `+ CC`. **Any function with
  CC ≥ 90 fails this gate at 100% coverage** — the only exit is a refactor, and this one is four
  branches from that wall. It is the counter-example to the reflex the first finding invites: "the
  ratchet is a coverage problem." Two top-3 entries, two different remedies. Filed as **LOOP-116**
  (senior + `sensitive` — the closure carries the bearer-token gate and the path-derived project
  key's traversal guard).
- **♻️ LOOP-46 was parked on a number that stopped being true, and the thing that fixed the number
  was the ticket it was parked behind (2026-07-31).** Last fire I sequenced LOOP-46 behind LOOP-56 on
  a measured basis: `doctorWorkspace` at CRAP **90.4** > 90, with LOOP-56's own CI failing on exactly
  that string. LOOP-56 then landed (`9ad4aec`) — and the tests it brought raised that function's
  coverage to 83.4%, dropping it to **82.9**, off the top of the ratchet entirely. The blocker
  dissolved at the moment the blocking ticket landed, and nothing re-read it. Compounding it, the
  §9c unpark retired the `Blocked-by` edge and dropped the `blocked` label but left `state: Backlog`,
  so the ticket was invisible to junior's pick query regardless — **QA caught that half at 02:34Z and
  routed it to PM rather than acting outside its lane.** Both halves fixed this fire; LOOP-46 is in
  `Todo` and **LOOP-38** (p1, the stale installed binary that keeps every Done CLI fix from actually
  being live here) has no open blocker left.
- **🔴 Five `Done` metering tickets produce nothing on this workspace, and the fire ledger proves it
  183 times out of 183 (2026-07-31).** The `dev-loop` binary that *launches* every fire here is the
  installed `v1.11.0` = `685fee3`, and `git rev-list --count 685fee3..origin/main` is **44 commits /
  33 tickets**. That release contains **zero** occurrences of `DEVLOOP_FIRE_ID`; `origin/main` contains
  three. `run-agents.ts:902` is where the fireId enters a fire's env — it is the join key the whole
  metering programme was built on, and the running launcher does not have that line. Consequence,
  measured across the entire ledger: `.dev-loop/team/fires.jsonl`, 183 rows, **0 with `fireId`, 0 with
  `usage`**; the row schema is `ts, agent, project, codingAgent, provider, model, effort, durationMs,
  exitCode, timedOut` — no cost, no tokens, no join key. LOOP-12's fireId minting (`e5669cb`),
  **LOOP-75** (`140a4b1`), **LOOP-83** (`fd48e2e`) and **LOOP-15** (`79da67b`) all sit *inside* that
  44-commit gap: all `Done`, all correct in source, all inert in practice. **Why 183 fires never
  surfaced it: the two versions are byte-identical strings** (`1.11.0` vs `1.11.0`), so every
  version-based check reports agreement — the skew is visible only by comparing *code* or *output*.
  This is LOOP-38's real blast radius, and it reframes that ticket from "some CLI fixes aren't live"
  to "a capability the loop paid five tickets for cannot run." Two independent corroborations landed
  the same hour from other agents: QA hit `ticket create` missing `--state` (LOOP-11, in the 44), and
  LOOP-43's 64 KiB truncation (also in the 44) still bites every board read. Recorded on LOOP-38;
  **LOOP-85 and LOOP-4 were warned that the ledger is not a valid verification oracle here** — an
  honest metering increment would otherwise be verify-failed for a deployment problem it does not own.
- **✅ LOOP-93 verified `Done` — the operator debug logs now carry LOOP-62's §16 ledger posture
  (2026-07-31).** Landed `66a941a` (PR #69, all three checks green). `run.log` and
  `runner-logs/<agent>.log` are created `0600` and `runner-logs/` `0700`, by **reusing**
  `hardenLedgerPerms` rather than copying it; a pre-existing loose file is warned once per path per
  process and never chmod'd behind the operator. Verified by running the merged code against real
  fires in a temp workspace (`LOG_PERMS_OK`, 11/11) plus §3 spec triage (no MISSING/EXTRA/
  MISUNDERSTANDING), and **the fails-before half was reproduced independently** — the new suite dropped
  onto the pre-fix parent `c229715` fails 6 assertions across 5 distinct defects. Two subtleties the
  ticket could not have specified were load-bearing and correct: `createWriteStream` opens its fd
  *asynchronously* (so the file is touched synchronously first, or `chmodSync` races the open and
  no-ops on ENOENT), and `existed` is read *after* the 50 MB rotation rename (so a rotated log
  re-hardens instead of landing at the umask). Note for LOOP-86: `npm test` is now a **69**-link `&&`
  chain with the new suite appended last — the exact position that made it silently not run on Node 24
  during the ship cycle.
- **🔎 LOOP-46's W18 spec was re-checked against the skew it exists to catch, and it holds
  (2026-07-31).** Went looking for a spec defect — specifically whether resolving the installed version
  to a commit could go silent (`unknown` ⇒ *info, never warn*) on today's real skew. It cannot:
  `v1.11.0` resolves via both the tag and the `chore(release)` fallback to `685fee3`, giving
  `behind = 44 > 0` ⇒ **W18 warns correctly today**. The finding worth folding into its test is that
  **the installed and `origin/main` versions are EQUAL while the code differs** — the obvious
  "simplification" of comparing version strings would stay silent on the only skew that has ever
  happened here, while passing every other test in the suite. Also cross-linked LOOP-117 (QA, filed
  minutes earlier: `runDoctor` discards an explicit `DEVLOOP_HUB_DB` when cwd resolves to a workspace)
  onto LOOP-46 mid-build, because a W18 fixture test run from this checkout could assert against the
  *ambient* workspace and go green for the wrong reason — this workspace genuinely is 44 behind.
- **❌ LOOP-57 verify-FAILED after it merged: `doc-land` refuses every real PM landing, and the
  regression suite could not see it (2026-07-31).** PR #64 landed `b49c0ba` with all three checks
  green, and the shipped suite re-run at the merge sha is **22/22**. The verb is still unusable.
  Step 1's load-bearing docs-only assertion (`doc-land.ts:101`) is
  `git diff --name-only origin/main main` — a **two-dot `git diff`, which is a tree comparison, not a
  commit range.** The ticket's own prose said `origin/<defaultBranch>..<defaultBranch>`, and in
  `git log`/`rev-list` that genuinely *does* mean "commits in B not in A"; in `git diff` it does not.
  Consequence: whenever `origin/main` has moved ahead with a **code** commit — the permanent condition
  of this repo, where the loop lands dev PRs continuously — the diff contains *other agents' files*,
  step 1 names one of them as PM's offender, and the verb exits 1 at line 101, **before** the
  fetch/rebase at `:125-137` that would have aligned the trees. Reproduced against the merge sha on a
  bare-origin+clone fixture: local `main` ahead 1 (doc-only), behind 1 (code) ⇒
  `REFUSED — range touches non-doc path(s): hub/src/thing.ts`. **Why the suite is green:** case (c)
  advances origin with `docs/STRATEGY.md`, a *doc* file (`test/doc-land.ts:104-107`) — a doc-only
  divergence makes the tree comparison and the commit range give the same answer, so the fixture dodges
  the failure. The fix (`...`, three-dot) was verified before filing: the repro flips to exit 0 and the
  full suite still passes 22/22, passenger hard-stop included, because a locally-authored non-doc
  commit is still inside the merge-base range. Superseded by **LOOP-119** (senior `Mode: direct-code`;
  a fix-forward on live code, not a rebuild — the verb's structure, the operator's step-3 finding split
  and the un-widened docs-only fence are all correct and stay). **The trap is contained:** every
  `git diff` range call site in `hub/src` was swept, and `quality.ts:144` already uses three-dot
  correctly — `doc-land.ts:101` is the only offender.
- **🔎 `strategyDoc` is schema-declared, read by four consumers, and writable by no mutator — a
  second, independent reason `doc-land` cannot run here (2026-07-31).** `projects.<key>.strategyDoc`
  exists at `team-config.ts:100`, but it is absent from `team set`'s `SETTABLE` table
  (`team-edit.ts:55-73`) and there is no `--strategy-doc` flag on `team add-project`. `git grep
  strategyDoc -- hub/src` at `b49c0ba` returns **reads only**. Under the operator console's hard rule 1
  — *never hand-edit `dev-loop.json`* — the operator therefore has **no legal way to set it at all**,
  and four shipped features are silently inert on any workspace built the sanctioned way: `doc-land`
  (hard exit 1), the passive-intake repo-file doc **watch** (`daemon-notifiers.ts:384-416`), the
  `/roadmap` divergence banner (`daemon.ts:65-73`), and `repoFileStrategyPath()`. Confirmed by running
  the shipped verb against this workspace: *"project 'loop' has no repo-file strategyDoc configured."*
  The doc itself is real and 146 KB; only the pointer is missing. **Why 183 fires never surfaced it:
  PM's own doc reads and writes never consult this field** — the path lives in `pm-state.json` — so the
  gap was invisible to the only agent that touches the doc. Filed **LOOP-120**. LOOP-119 and LOOP-120
  are both required and neither alone is sufficient; **LOOP-60 and LOOP-50 have been re-pointed onto
  both** rather than auto-unparked on a `Canceled` prerequisite.
- **🤝 QA filed LOOP-118 against the same function mid-fire, and the two defects compose badly
  (2026-07-31).** Independently found: `doc-land` never runs `git rebase --abort` on a real conflict,
  stranding the **shared** doc-home checkout (detached HEAD, unmerged `STRATEGY.md`) so every later op
  fails identically until a human intervenes. Confirmed distinct rather than duplicate — the two
  partition the input space (a *code* divergence refuses at line 101 and never reaches the rebase; a
  *doc-only same-line* divergence reaches it and wedges the repo). **The interaction is the point:
  fixing LOOP-119 makes LOOP-118's stranding MORE reachable**, because the rebase begins executing in a
  whole class of cases that currently refuse outright. Re-tiered `junior-dev` → `senior-dev` and
  promoted to `Todo` so both land in one PR — the reason is collision, not difficulty: both edit the
  same `attempt()` catch block, and two tiers editing one function concurrently is how a merge conflict
  becomes a regression.
- **✅ The metering lane is complete in code and still unobserved in production (2026-07-31).**
  **LOOP-85** (opencode usage capture) verified Done against `origin/main` `22f2e4c` — the last of the
  three lanes (claude/LOOP-83, codex/LOOP-15, opencode/LOOP-85) on top of the LOOP-2 core. It is the
  strongest increment this loop has produced: the adapter reads `part.tokens`/`part.cost` from a
  **verbatim recorded opencode 1.2.24 event**, takes the LAST `step_finish` rather than the first, and
  `test/run-agents-live.ts` proves usage capture end-to-end through a real subprocess (input 111 /
  output 12, cache split, cost), output survival on multi-line **and truncated** JSONL, and all three
  `suspectError` arms. The builder went and measured the real shape instead of trusting a documented
  one — the exact failure that sank LOOP-13/LOOP-14, closed at the source. **And the ledger is still
  `193 rows, 0 with usage, 0 with fireId`**: that is LOOP-38 (installed launcher ~44 commits behind
  under an unchanged version string), not metering. Every lane is built; none of them can run here.
  With both blockers Done, **LOOP-4** (the aggregation surfaces) was unparked to `Todo` — not
  re-blocked on LOOP-38, but re-scoped: the empty column is now a first-class AC (render "no metered
  fires", never a zero-filled table; report *N of M fires carry usage*, which reads `0 of 193` today
  and self-corrects the day the binary is current).
- **🔴 `landing-observability` shipped whole and has never produced a single real reading
  (2026-07-31).** `hub/src/landing.ts:130` asks `gh pr list` for `--json …,mergeableState` — **a field
  `gh` does not have.** gh validates field names locally, exits 1 before any network call, and
  `readLandingState` reports that as `reason:"forge unreachable"`, so every repo, every invocation,
  every machine returns `state:"unknown"`. Reproduced against the live forge with every other `gh` call
  in the same fire succeeding; a one-word fix in a worktree turned `landed: null` into **`landed: 42`**
  and `unknown` into `healthy`. So the design's three children are: **LOOP-40** `Done` and inert (**I
  verified it, off the code and its injected-`exec` suite, and never ran it against a real forge**),
  **LOOP-42** correct code whose output is permanently `unknown` (verified `Done` on its own ACs —
  its contract explicitly forbids opening its own forge call), and **LOOP-41** now blocked before it
  ships a doctor line that can never say anything but "forge unreachable". Filed **LOOP-121** (P1) with
  the repro, the tested fix, and the test that would have caught it.
- **🔴 `push-guard`'s passenger detection is blind to a rebase, and this strategy doc was the payload
  (2026-07-31).** PR #70 (LOOP-52) merged carrying **16 of PM's unpushed `docs(strategy)` commits** —
  `docs/STRATEGY.md` **+1074 lines** plus three READMEs — onto `origin/main` under a hub-feature
  commit, bypassing `doc-land`'s ff-only path and the §20 D4 progress-only fence. `push-guard`
  reported **clean**. Replaying its algorithm at the refs it would have seen: **18 commits in range,
  0 flagged.** The passenger loop's second clause (`push-guard.ts:53`) asks
  `merge-base --is-ancestor <sha> main` — SHA ancestry in *local* `main`. **The junior rebased the
  branch onto `origin/main` an hour before the merge** (the ordinary response to CI asking for an
  update), and a rebase rewrites every SHA, so the copies are no longer ancestors and the clause
  `continue`s past all 16. Content identity proved by `git patch-id --stable`: **16 of the 18 branch
  commits have a patch-id twin on local `main`; zero were flagged.** The guard therefore catches only
  the *un-rebased* passenger — the case least likely to reach a merge — and with `autoMerge:true` it
  is the last gate before an unattended landing. Evidence folded into **LOOP-87**, raised to **P1**;
  its already-prescribed remedy (attribute by the `(TICKET-ID)` subject convention) is
  **rewrite-invariant** and is the right fix, so clause 2's ancestry test should be *retired*, not
  layered onto. **Consequence this time was benign and I verified that rather than assuming it** — see
  the doc-fork entry below.
- **🟢 The strategy doc's apparent `origin`-vs-local fork is not a fork, and needs no operator
  decision (2026-07-31).** After the passenger landing, `origin/main:docs/STRATEGY.md` stood at
  **2179 lines** against local `main`'s **1693**, and senior-dev flagged it as "two divergent
  evolutions; PM must choose the canonical version". Measured instead of adjudicated: every one of the
  **27** entries `origin` holds that local lacks is present in local's
  `docs/strategy-archive/2026-07.md` (**878** lines vs origin's stale **77**) — `origin` is simply a
  **pre-R2-rollup** snapshot that also stops **10** entries short. Local is a strict superset; nothing
  was lost. A real `git rebase origin/main` in a throwaway worktree then **succeeded with zero
  conflicts**, skipping the 16 passenger commits by patch-id and reproducing the canonical doc
  **byte-for-byte** (1693 lines / 161200 b). So the first real `doc-land` will rebase cleanly and
  publish the correct post-rollup doc. **Recorded so nobody hand-edits the doc to "fix" a divergence
  that resolves itself.**
- **🟡 `doc-land` is now correct and still cannot run here (2026-07-31).** LOOP-119 verified `Done`
  against this repository's *real* divergence rather than a fixture: with local `main`
  `[ahead 20, behind 32]`, the old two-dot range named **30 paths, 28 of them non-doc** (other agents'
  commits, any one of which PM would be blamed for); the three-dot fix names **2 paths, 0 non-doc**.
  28 → 0 on live data. LOOP-118's abort-on-conflict landed in the same PR, so a conflicted rebase no
  longer wedges the shared checkout. **But the verb still refuses on this workspace** —
  `doc-land: project 'loop' has no repo-file strategyDoc configured` — because
  `projects.<key>.strategyDoc` is schema-declared, read by four consumers, and writable by **no
  mutator** (**LOOP-120**, P1, the top junior promote). The mechanism is finished; the config surface
  is the last mile. Same family as **LOOP-123** (`team.agentReviewers`, QA) — **two config fields in
  two days that shipped complete and unreachable.**
- **✅ The cost-governance arc reached its read surfaces (2026-07-31).** **LOOP-4**'s design gate
  **passed** — the first design this loop has produced whose every load-bearing code claim survived
  independent re-verification against `origin/main`: `FireRow` really does omit the four dimension
  fields `recordFire` writes; `FireUsage`'s quoted shape is byte-exact; `comms.ts` really is
  transport-only (senior-dev **overrode the ticket's own "Affected area"** and was right); `/activity`
  really does inject `Date.now()` at the route, which is the purity seam the web child copies. Three
  children promoted (**LOOP-125** core+CLI → **LOOP-126** `/usage` → **LOOP-127** digest line), B and C
  `Todo`+`blocked` behind A so the aggregation is written once. **The measurement that reframed it:**
  the ledger is `206 rows, 0 with usage, 0 with fireId` — **but 206 of 206 carry `provider` and
  `model`.** The dimension columns are fully populated *today*; only token/cost are empty. So
  `metrics --usage --by provider` is not a stub waiting on LOOP-38 — the `FireRow` type-drift is the
  *only* thing between this loop and that answer, and Child A ships real value on day one.
- **🔴 A required merge check with no local runner — this cost two landings in one fire (2026-07-31).**
  LOOP-79 (PR #78) and LOOP-80 (PR #79) both reached `In Review` with red CI, **same finding**:
  `hub/package.json:1:1: unsafe-package-script: test script must invoke every tracked hub/test/*.ts once`.
  Both added a **new** `hub/test/*.ts` without a `hub/package.json` chain entry, so **the regression
  test each ticket was built to prove itself with had never executed — not once.** `main` was green,
  so both were branch-introduced. The structural cause: CI runs `security/source_integrity.py` as
  **two steps of its own** (pre-install + post-test `--whole-tree`), and **no npm script runs it at
  all** — the 75-segment `test` chain contains zero `python`/`security` invocations. `npm test` cannot
  catch this by construction: an unwired test simply does not run, so the chain stays green. A tier can
  execute the entire documented local gate, see green, push, and be rejected for a rule it had no way
  to evaluate. Filed **LOOP-128** (P1): make one command reproduce every required CI check locally.
  Both tickets were routed back to `Todo` rather than superseded — one packaging line from green, and
  per **LOOP-112** `In Review` is a dead end a dev tier cannot reach.
- **🟢 The board can point at the code under review (2026-07-31).** **LOOP-66** verified `Done`
  (`2dc2db5`): `metrics --json` → `landing[].prs[]` now carries real `{ticket, pr, url, state}` links
  on live data — `LOOP-80`→#79, `LOOP-79`→#78 — with the 31-day-old non-loop PR #8 correctly filtered
  out, **zero extra forge calls** (it re-reads the list already fetched, adding only `url` to the
  `--json` set), and the single-`spawnSync("gh")` invariant intact. Its test double **validates the
  argv** — the discipline that would have caught the `mergeableState` bug (LOOP-121). Known gap, and
  it is **PM's spec defect, not the builder's**: the surfaced `prs[]` is open-PRs-only with `state`
  hardcoded `"OPEN"`, so a *merged* PR is not readable back; the exported `ticketToPr` (`--state all`)
  that would close it is called by **nothing** in `hub/src`. Folded into **LOOP-111** — the
  verify-queue landing annotation is exactly that function's intended consumer.
- **🔴 The integrity scanner audits what CI executes — and the two scripts CI structurally
  *cannot* execute are the two that ship to users (2026-07-31, trust-safety lens).**
  `security/source_integrity.py` is a required merge check on every PR and gates the npm publish
  four times over. Its docstring names the threat: *"an injected lifecycle script cannot execute
  before the repository is inspected."* The **ordering** half holds; the **inspection** half does
  not. `RELEASE_SCRIPT_EXACT` pins exactly two script strings — `build`, `typecheck` — and
  `IMPLICIT_RELEASE_HOOKS` flags six `pre*`/`post*` names. `hub/package.json` ships **two explicit
  npm lifecycle scripts, `postinstall` and `prepack`, and neither is in either set.** Measured, with
  a control: poisoning `postinstall` → **no findings, scanner passes**; poisoning `prepack` → **no
  findings**; poisoning `build` → `'build' is not the audited command`. **The pinning mechanism
  works perfectly and is simply not pointed at the two scripts that need it most.** Four layers miss
  the same bytes in the same direction: `package.json` is not an `_is_executable_source`, so the
  eval/`Function`/IOC scans never read the strings; the pin set omits them; `_scan_lockfile`'s
  `if package_path and …` deliberately skips the **root** entry, whose `hasInstallScript` really is
  `True`; and both workflows run `--ignore-scripts` everywhere, so CI never executes either script
  and gets no behavioural signal either. Consequence is concrete, not theoretical:
  `postinstall.cjs` is in `files[]`, so `postinstall` runs on every `npm i -g @dyzsasd/dev-loop`.
  Poisoning the *file* is partly covered (`.cjs` **is** scanned); poisoning the *script string*
  reaches users unexamined. Filed **LOOP-129** (P2, `sensitive` → senior). **The generalisable
  lesson, and the sixth entry in the method: a guard's coverage tends to stop exactly where its
  own CI's observability stops — so audit the paths CI cannot run, because those are the paths
  nothing else is watching either.**
- **🟢 A destructive verb made safe, and the metering surfaces verified where absence is the answer
  (2026-07-31, late).** Two landed increments verified in the same closing window. **LOOP-106** —
  `dev-loop team repair` is **non-destructive by default**; the terminal-worktree reap is now opt-in
  (`--reap`), so `bundle.ts:380`'s unattended pre-doctor call on `up --bundle` deletes nothing, and a
  branch is deleted only when `branchRecoverable()` proves the work survives elsewhere (merged, or
  pushed with no local-only commits ahead). **The standing "do not move this workspace" warning is
  withdrawn.** The verdict turned on checking the ticket's own claim that its tests fail against the
  pre-fix code: a worktree at the old SHA carrying *only* the new test file returned **9 failures
  across AC1/AC2/AC3**. senior-dev made the recoverability rule *stricter* than the AC and named the
  deviation — the right way to overrule a spec. **LOOP-125** — `metrics --usage/--cost/--flow` verified
  against this workspace's **214 fires with zero metered rows**, which is precisely the case the ACs
  protect: every token field renders `null` (**not `0`**), cost renders `unavailable` (**not `$0.00`**),
  and the genuinely measurable half keeps reporting (`board throughput: 58 →Done`). AC6 closed the
  `FireRow` dimension type-drift found at the LOOP-4 design gate. LOOP-126 + LOOP-127 unparked.
- **🔴 LOOP-87 recurred live, and the payload was this document again (2026-07-31, late).** PR #82
  (LOOP-65) reached review carrying **eight commits, only one its own** — LOOP-125's commit plus **six
  unpushed PM `docs(strategy)` commits**, each confirmed by a `git patch-id --stable` twin on the
  shared checkout's local `main`. Same shape as the PR #70 incident. **The root cause is LOOP-120, and
  it is PM's:** while doc-land cannot push, local `main` stays permanently dirty, so *any* branch cut
  from it inherits the doc commits. The ticket's own work was scope-clean and passed every AC, so it
  was routed back to `Todo` (right and unfinished), not `Canceled` — and **PR #81 cut clean off
  `origin/main` in the same window**, which is the proof that the clean path was available. **The
  standing lesson: a dirty shared `main` is not a PM inconvenience, it is a supply route into
  `origin/main`** — and there is no mechanical guard, because LOOP-69 (wiring merge-guard into the
  fire-start merge pass) is still parked.
- **✅ LOOP-87's recurrence closed in twelve minutes, and the guard chain is now complete but unwired
  (2026-07-31).** LOOP-65 was routed back to `Todo` at 05:40Z with a force-push instruction;
  junior-dev cherry-picked its own commit onto `origin/main`, force-pushed, and merged at 05:52Z.
  The landed commit `4d1beb6` touches **exactly two files** (`hub/src/merge-guard.ts` +100/-4,
  `hub/test/merge-guard.ts` +108) — the seven passengers are gone, not squashed in. ACs re-run at the
  *merged* sha, not the PR head: suite exit 0, typecheck exit 0. **Route-back beat close-and-refile by
  a wide margin** — a `Canceled` + follow-up would have discarded a branch whose every AC passed.
  With LOOP-64, LOOP-67 and LOOP-65 all `Done`, the merge-guard mechanism is **complete and calls
  nothing**: LOOP-69 (the §17 wiring hand-off) unparked this fire to the operator, both of its edges
  retired.
- **🔴 The pipeline is 12.5:1 skewed toward the tier that is at cap, and the two tiers deliver nearly
  the same output (2026-07-31).** Measured across all 129 board rows: non-terminal work is **50
  junior / 4 senior**, and the Backlog is **30 junior / 1 senior** (that one, LOOP-38, blocked).
  Delivered work is **junior 31 `Done` / senior 26 `Done`** — near parity from a 12.5:1 queue. So
  senior is not slower; it is *starved*, and junior has been over its depth cap for twelve
  consecutive fires (11/10 at close after two verified increments were routed back to land).
  **The mechanism is §21b working exactly as written, not drift:** only 6 of 129 tickets ever carried
  `sensitive` (4.7%), and "when borderline, junior" sends everything else down. senior-dev's own
  design-and-delegate mode then *manufactures* junior work — it created **37 junior-tier tickets and
  zero senior-tier ones**. Only PM/QA/operator file senior work (24/3/1). Re-tiering to balance load
  remains the inference §21b forbids; §21b is governing prose no agent may edit (§17). **This is an
  operator lever, and it is now quantified rather than merely observed.**
- **✅ §21b's own justification tested and upheld — no ticket filed.** The rule justifies "when
  borderline, junior" by asserting *"escalation (§21a) is the cheap safety net, so over-routing to the
  expensive tier is the costlier mistake."* That is a testable claim, and the obvious hypothesis was
  that the net never fires. It fires: **8 `Mode: direct-code` senior escalations exist (LOOP-23, 33,
  58, 63, 83, 85, 107, 119) and all 8 are `Done`** — a 100% completion rate. The imbalance above is
  therefore a capacity-allocation question, *not* a safety question.
- **⛔ The 68-link test chain took its second landing, and it is now the expected case, not bad luck.**
  PR #78 (LOOP-79) and PR #79 (LOOP-80) are each `MERGEABLE`/`CLEAN` with every check green, and are
  **mutually unmergeable**: `git merge-tree --write-tree pr78 pr79` reports a conflict in
  `hub/package.json` and nothing else. One inserts `test/ticketwrite.ts`, the other
  `test/queue-sensitive.ts`, into the same single ~4.5 KB `"test"` line; their source changes touch
  disjoint files. First instance was LOOP-37 × LOOP-40 (PR #59). **What changed is that it is no
  longer accidental:** LOOP-128's source-integrity gate makes registering a new suite in that line
  *mandatory* for CI to pass, and the two dev tiers run concurrently by design — so any two
  test-adding increments in flight collide. **LOOP-86 raised to P1**, with a binding shape on the fix:
  a partial run must stay distinguishable from a full one *and* two increments must be able to
  register a suite without editing a shared line.
- **🔴 `In Review` stranded two verified increments, and only a hand-route freed them.** LOOP-79 and
  LOOP-80 sat `In Review` with green, mergeable, **unmerged** PRs. `agentops.ts:205-210` serves a dev
  tier only `Todo` + its *own* `In Progress`, so neither ticket was reachable by the one agent allowed
  to land it (**LOOP-112**, Backlog). Both were verified in full — including running LOOP-79's new
  suite against `cec3598` with only the test file dropped in, which returned **exit 1 / 4 failures**,
  proving a real regression test rather than a tautology — then routed to `Todo` to be landed.
  **LOOP-110** (the review-admission gate) is the mechanism and sits in `Todo`; until it lands, PM
  hand-routing is the only egress, and it is exactly why the `In Review` axis of merge-guard must stay
  out of the enforcing set (recorded on LOOP-69).
- **✅ The developer incident scanner does what its docstring claims — controlled, not assumed.**
  `security/local_code_scan.py` is the largest unreviewed file in the repo (98,869 bytes) and no lens
  had ever swept it. Two hypotheses died on contact. **(a) "CI never runs it" is true and correct by
  design** — CI runs its *tests* but never the scanner, because it scans a *developer host*
  (`~/workspace`, npm caches, VS Code extensions, git object DBs), not the repo; it is an
  incident-response tool meant to be run from a trusted copy against a suspect machine. **(b) Its
  docstring's safety claim — *"Findings never include source snippets or environment values"* — holds
  under test.** A fixture carrying a fake AWS key, a fake `sk-ant-` token, a malicious `postinstall`,
  an `eval(atob(...))` and a `curl | sh` was scanned with `--format json`: **all six planted canaries
  are absent from the output**, while the scanner still correctly reported
  `suspicious-lifecycle-script (postinstall combines: decode, dynamic-exec)` and two
  `dynamic-decoder-review` findings, exiting 1. Findings carry rule IDs, paths and digests — never
  bytes. **The output is safe to attach to a ticket, which is the property that matters for a tool
  shipped to users.**
- **✅ The worktree base fix is holding — the doc payload is contained.** PR #83 opened at 05:52Z
  while local `main` carried **24 unpushed PM commits**, and it carries **one commit, three files, no
  passengers**. Local `main`'s 24-commit lead touches only `docs/STRATEGY.md` and
  `docs/strategy-archive/2026-07.md`. So the PR #82 incident was a stale branch base, not a live leak
  (LOOP-48 landed), though LOOP-120 still keeps local `main` permanently dirty.
- **🔴 `origin/main` is RED, and the increment that broke it is the one built to stop exactly this
  class of miss.** LOOP-110 (the review-admission gate) merged at 06:29Z carrying a new
  `hub/test/review-admission.ts` with **no `hub/package.json` `scripts.test` entry**. Measured at
  `origin/main` @ `e808d3b`: `source_integrity.py --whole-tree` → `unsafe-package-script: test script
  must invoke every tracked hub/test/*.ts once`, **exit 1**; CI run `30609818467` failed the same line
  in **all four** integrity steps across both Node jobs. Of **77** tracked `hub/test/*.ts` files, **76**
  are registered — `review-admission.ts` is the sole gap. Two consequences: LOOP-110's 21 assertions
  have **never executed in CI**, and because the file is now tracked on `main`, **every branch cut from
  main inherits a red required check before it adds a line**. Un-break filed as **LOOP-133** (P1, Todo);
  the recurrence-stopper is **LOOP-128** (promoted to Todo), whose thesis this instance confirms — the
  0.3-second command that catches it is the one no npm script exposes.
  **RESOLVED WITHIN THE SAME FIRE — main is GREEN again at `312e751`:** `source_integrity.py
  --whole-tree` → `OK (252 file/blob(s) scanned)`, exit 0; **78 tracked `hub/test/*.ts`, 78 registered,
  zero unregistered**; `node test/review-admission.ts` → `REVIEW_ADMISSION_OK`. Junior folded LOOP-133's
  one line into PR #79's rebase 16 minutes after I filed it, rather than opening a third PR — correct,
  because #79 was already editing the identical `scripts.test` line and an isolated fix would have hit
  the `#78 × #79` conflict class measured last fire. Total red window: **06:29Z → 08:12Z**, and the loop
  closed it itself. **LOOP-128 stays open regardless: this was caught by a PM verify, not by any gate.**
- **Four increments verified `Done` in one fire — a board record — and not one of them is observable on
  this workspace.** LOOP-110, LOOP-116, LOOP-126 and LOOP-79 all landed and all verify clean at their
  merged shas, yet: the installed binary (`/opt/homebrew/.../dist/cli.js`, `1.11.0`) contains no
  `review-admission gate` string; `/usage` returns **404** on the running hub daemon while `/activity`
  returns **200** on the same process, because that daemon has been up since **2026-07-30T17:08Z**
  (~15h) and predates all four merges. **The loop's `Done` rate and its deployed rate have fully
  decoupled** — verification is worktree-based and correct, deployment is nonexistent. This escalates
  the "daemon serves stale VIEW code" entry banked below on 2026-06-27: a brand-new *route* 404ing is
  not rendering lag, it is an absent feature, and LOOP-4's entire usage-surface programme exists to be
  looked at. Still the same lever: **LOOP-38**.
- **The strategy doc reached `origin/main` by accident, and that is now a measured fact rather than a
  risk.** Nine PM `docs(strategy)` commits rode PR #86 as passengers; the squash landed
  `docs/STRATEGY.md` (1431 lines) + `docs/strategy-archive/2026-07.md` (+801, new) under a PR titled
  "review-admission gate". `git show origin/main:docs/STRATEGY.md | shasum` now equals the local file
  (`9b2499647a2bc2eb`, 191,781 bytes). Three sibling PRs in the same 16-minute window (#83/#84/#85)
  carried **zero** passengers, so the leak is intermittent and tied to #86's rebase-produced base —
  precisely the case LOOP-87's title says push-guard is blind to. **This makes LOOP-50's premise
  ("PM doc-only commits never push") wrong**: they push, as unreviewed passengers. Both tickets updated;
  LOOP-87 and LOOP-120 promoted together — stop the leak, and give the doc a legitimate path.
- **Three more surfaces swept clean, zero tickets.** `hooks/hooks.json` is sound: the SessionStart hook's
  dist/src dual path is correct in both the npm-package and git-checkout layouts, and
  `hub/test/build-artifact.ts` covers dist emission, npm-pack inclusion, the hooks.json reference, and
  an **installed end-to-end run** that starts the daemon and health-checks it. `.claude-plugin/` +
  `hub/package.json` agree at `1.11.0` under a dedicated `hub/test/version-sync.ts`. `config/` is
  examples only. **`hooks/`, `config/` and `.claude-plugin/` are now swept — do not re-walk them without
  a new reason.**
- **✅ The npm lifecycle-script audit denies by default (2026-07-31, `b248f166`).** **LOOP-129**
  verified `Done` at the merged sha. `security/source_integrity.py` pinned only `build`/`typecheck`,
  so poisoning the `postinstall` string in `hub/package.json` — the script that ships in the tarball
  via `files[]` and runs on every `npm i -g` — passed all four layers and reached users. The audit is
  now derived from a 28-name enumeration of npm's auto-run lifecycle set with **deny-by-default**:
  any present lifecycle name absent from the pin map, or whose bytes changed, is an
  `unsafe-package-script` finding. Measured against the shipped scanner, not inferred: `postinstall`,
  `prepack`, `preinstall`, `prepare`, `prepublishOnly` — plus `postpack` and `preversion`, which the
  ACs never named and which fire correctly, confirming the *class* was closed and not three cases.
  The `build` control still trips, so the old pins were not loosened. **This is the first increment
  whose regression tests I proved fail against the old code** — the 5 new tests, run against the
  scanner at `312e751`, give `FAILED (failures=5)`.
- **🔻 The sanctioned-config surface has a hole the operator cannot route around (2026-07-31,
  `consistency` lens).** Hard rule 1 of the operator console is *never hand-edit `dev-loop.json`;
  every config change goes through a validated mutator.* Measured on `origin/main`: **`team add-repo`
  silently discards 12 of its 13 field flags when the repo ref already exists** — `--landing`,
  `--auto-merge`, `--merge-check`, every `--*-cmd`, `--deploy-style`, `--ops-check`, `--path`,
  `--remote` — writes nothing, prints `registered repo '<ref>' under project '<key>'`, and **exits
  0**. Only `--owner` updates in place. Its sibling `add-project` **refuses loudly** in the identical
  case (`team-edit.ts:190`). Reproduced on a throwaway copy of this workspace's own config: the file
  came back byte-identical. Meanwhile `team set`'s allowlist carries exactly one `repos.<ref>.*`
  family (`deploy.*`), so `landing`, `autoMerge`, `mergeChecks` and the build gates are rejected
  there and dropped here — **there is no working sanctioned route to change them at all**, and this
  repo's `mergeChecks` are pinned to a Node matrix (`Test (Node 23.6.0)`) that will move. Filed as
  **LOOP-134** (P1, `Todo`) and **LOOP-135** (the CLI's rejection message tells the operator to
  *"edit dev-loop.json directly"* — the one thing the console forbids).
- **⏳ The live consequence, caught before it shipped.** **LOOP-100** is in `Todo` now and its spec
  says to write `entry.defaultBranch` *"beside `entry.landing`/`entry.mergeChecks`"* — inside the
  new-ref-only block. `defaultBranch` is being retrofitted onto **already-registered** repos, so as
  written the new `--default-branch` flag would be a silent no-op in its primary use case. A binding
  spec correction is on the ticket; the general fix is LOOP-134.
- **The suite is green because its fixtures never vary the one variable that breaks.**
  `hub/test/team-edit.ts` exercises `add-repo` six times and **every case uses a fresh ref**. This is
  the fourth instance of the same shape on this codebase and the method note now has a name: *ask
  which variable the fixture holds constant.*

### 2026-07-31 (later) — the daemon port band is exhausted, and every health surface says fine

- **🔴 All 64 ports the allocator can hand out are occupied.** `lcFreePort`
  (`daemon-lifecycle.ts:149`) probes exactly `tries = 64` consecutive ports from 8787. Replicating
  its own `lcTryBind` across that band at 08:53Z: **0 free, no gaps.** So it falls through to
  `return start` and the next `daemon up` for any project without an existing runfile port dies with
  `EADDRINUSE` on 8787 — a port held by a **14-day-old daemon from an unrelated workspace**
  (`/Users/shuai/workspace/jinko/dev-loop`). LOOP-53 filed this fleet at **58**; it is now **64**,
  which is also the ceiling. The fleet is mostly foreign-workspace daemons and deleted
  `/private/tmp/qa-*` fixtures.
- **`dev-loop doctor` prints `DOCTOR_OK` on that machine.** Its only daemon line is a single
  `/api/health` GET for the *current* project — which passes exactly because that project already
  holds a port (8840). There is no fleet or band check anywhere in its 630 lines. The operator
  console instructs the human to run doctor and *"read every W-code"* before an unattended run, so
  the designated pre-flight surface is the one that cannot see the machine's actual blocker. Filed
  **LOOP-137** (`Backlog`, blocked-by LOOP-95 — the W22 line is only useful once LOOP-95's
  `dbPresent` marker can tell a reapable orphan from a colleague's live board, and once
  `daemon reap` exists to be named).
- **The measurement invalidates an AC that was already written.** LOOP-94's AC-A1 says to count
  listeners in 8787..8850 before and after a suite run and assert the delta is 0. On a saturated
  band **nothing can bind, so the delta is 0 whether or not the suite leaks** — the check is
  unfalsifiable exactly where it was meant to bite. Recorded on LOOP-136 as a replacement method
  (assert the exit hook killed the registered pid directly, never a range delta). *A count-based
  assertion needs a stated precondition that the resource it counts was available.*
- **⏳ LOOP-84 unparked and promoted (P1).** Its only edge was LOOP-94, which closed `Canceled` —
  but its artifact **landed** (`daemon-harness.ts` is on main at `9932337`), and the edge existed so
  LOOP-84 would build on that harness rather than race it. That condition is met, so the edge
  retires: **a `Canceled` ticket whose artifact shipped still satisfies a "wait for the harness"
  edge.** Read the reason, not the state. LOOP-84 truncates `npm test` at suite ~29 of ~60 — it is
  why `test/quality.ts` never runs on this workspace — and QA re-reproduced it on current main this
  fire.
- **🟡 LOOP-86 landed mid-fire and the 78-link `&&` chain is gone** — `hub/package.json`'s `test` is
  now `node test/run-all.ts`, a glob-discovery runner. Exercised the shipped runner directly: a
  failing suite no longer halts the run, a *throwing* suite is classified `crashed` distinctly from
  `failed` and the suite after it still executes, all-green exits 0, and every run prints its
  denominator. Discovery is exactly faithful — the old chain and the glob resolve to the **same 80
  files**, zero drift. This also retires the shared-line merge conflict recorded twice above
  (LOOP-37×LOOP-40, LOOP-79×LOOP-80): two increments can now register a suite without touching one
  line. **Verify-failed anyway** (→ **LOOP-139**, senior-dev `direct-code`): three of its five ACs
  named a deliverable at `hub/test/…` and no test of the runner was written. The sharp edge is what
  *else* the diff did — it deleted `source_integrity.py`'s `expected_test_paths` check (*"the test
  script must invoke every tracked `hub/test/*.ts` once"*). Deleting it was **correct**, a manifest
  check is meaningless under a glob — but **the invariant it held did not move somewhere safer, it
  moved somewhere unguarded**: from an audited manifest plus a Python regression test, to a 71-line
  runner with no test at all. That invariant is LOOP-128's and LOOP-110 is what happens without it.
  *When a change makes a guard obsolete, ask where the guard's invariant went — "obsolete" and
  "unenforced" look identical in a green diff.*
- **2026-07-31 — the release path is hard-red, and the loop cannot ship anything at all
  (LOOP-140).** The operator dispatched `bump=minor` off `f9d9ab2` at 09:42Z; it died at *Verify
  source integrity (pre-install)* — `source-integrity: FAILED (221 findings, 2260 blobs)`.
  Reproduced locally and **root-caused to LOOP-86 (`c02ba33`), not LOOP-129** as first filed:
  `--all-history` at `9932337` (LOOP-129 landed, LOOP-86 not yet) is **OK across all 2274 blobs**;
  at `c02ba33` the *same corpus* yields 222 findings. Only the checked-out scanner differs.
  The mechanism is the previous entry's lesson running in reverse: `_scan_release_manifest`
  used to open `if path != hub/package.json or expected_test_paths is None: return []`, and that
  second clause was the **history-scope gate** — the byte-exact script pins never saw a historical
  blob. LOOP-86 deleted the parameter because it fed the rule it was retiring, and the same line
  silently widened the audit from *the current tree* to *all of history*. **A parameter can be
  load-bearing for something other than what it is named after.**
  The structural finding is larger than the bug: `test.yml` never passes `--all-history`;
  `release-npm.yml` is the only caller and it is `workflow_dispatch`-only. **Every PR and every
  push to main stayed green while the publish path was dead** — the break is undetectable until a
  human tries to release. *A guard's coverage stops where its own CI's observability stops.*
  Consequence: v1.12.0 — the whole overnight batch plus the operator's §17 merge-guard wiring —
  is stranded on main, and **LOOP-38** (installed-binary skew) is now correctly `Blocked-by:
  LOOP-140`, since only a release can close it.
- **2026-07-31 — the merge guard shipped wired and half-inert; the defective spec was PM's own
  (LOOP-69 → Canceled, → LOOP-142).** The operator committed the §12c + three-SKILL wiring at
  `f9d9ab2`, exactly as this ticket specified. Every claim in the contract paragraph is **true** —
  exit 0/1/2 and degrade-to-pass on a missing `gh`/hub DB all verified by running the verb six
  ways. But all four governing files prescribe `merge-guard --pr <pr> --strict --apply`, and
  `mergeGuard()` resolves the ticket only from `--ticket` or the **local** `HEAD` branch — never
  from the PR, though `--pr` is in hand. Measured, one flag apart on the same PR: from the repo
  root on `main` (the real fire-start context) `--pr 90 --strict` → **exit 0, "no ticket
  resolved"**; with `--ticket LOOP-87` → **exit 1, TRIP**. From a worktree it is worse than silent:
  on branch `dev-loop/LOOP-140` it printed *"ticket LOOP-140 is Todo — merge-eligible"* while
  gating **LOOP-87**'s PR. So LOOP-67's axis — the one that already fired in anger on LOOP-12/PR
  #40 — is unwired in practice. The command line came from **LOOP-69's own body, recorded by PM as
  "re-verified"**; it was re-verified by reading. *A prescribed command line is a testable
  artifact — run it in the context it will actually run in.* The fix is code, not another §17
  commit: a `gh pr view <n> --json headRefName` rung above local-branch inference makes the
  already-committed prose correct as written.
- **2026-07-31 — verified Done: LOOP-87 (stacked-branch passengers) and LOOP-101 (`defaultBranch`
  config reference).** LOOP-87 at the merge commit `58ef4eb`, all five ACs, with the §15 control
  clean (the new tests exit 1 against `f9d9ab2`, red on exactly the LOOP-87 assertions). Its
  rule-12 check passed too: replacing SHA-ancestry with ticket-id attribution kept LOOP-55's block
  intact and removed exactly one assertion — the one that *encoded the bug*. The PM correction that
  push-guard was blind to a rebase is carried as its own test, and is one of the assertions that
  goes red pre-fix. LOOP-101 documents all four `defaultBranch` surfaces; its `team set`-settable
  claim was re-checked against the live `SETTABLE` table (`team-edit.ts:40`) rather than taken on
  the commit message's word — the LOOP-134/135 class makes that check mandatory now.
- **2026-07-31 — the recurring defect of the week has a name: a surface reporting a result it never
  established.** Five instances now, filed independently: doctor prints `DOCTOR_OK` with all 64
  daemon ports occupied (**LOOP-137**); metrics reports "0 escaped to prod" on a loop that cannot
  measure it (**LOOP-122**); merge-guard reports a clean board axis when it resolved no ticket at
  all (**LOOP-142**); `list_events` returns a full 500 rows with no envelope, so a window 64%
  missing is byte-identical to a complete one (**LOOP-143**); and source-integrity stays green on
  every PR while the publish path is dead (**LOOP-140**). The shared shape is not a wrong answer —
  it is **a confident answer where there should have been "I had no input."** Worth treating as a
  design rule for every new check: *a guard that cannot report "skipped" will be read as "clean."*
- **2026-07-31 — doc-land is unblocked, and for the first time that is a measurement rather than a
  claim.** LOOP-120 (PR #93, checks green) makes `projects.<key>.strategyDoc` settable through a
  validated mutator. With it set to the repo-relative `docs/STRATEGY.md`, `doc-land --dry-run` exits
  **0** on this workspace's real backlog — *"would rebase 49 commit(s) from origin/main; step-1
  docs-only assertion passed."* That closes the LOOP-57 → LOOP-119 → LOOP-120 chain which has kept
  ~20 fires of strategy writing local-only. **LOOP-120 is now the sole remaining live blocker edge on
  both LOOP-50 and LOOP-60**; both unpark the moment it merges. Two caveats kept honest: it reaches
  the *running* loop only at v1.12.0 (gated on **LOOP-140**), and a *workspace*-relative path is
  accepted but silently poisons step 1, because doc-land compares repo-relative changed paths against
  a workspace-relative allow-list — only `docs/STRATEGY.md` works.
- **2026-07-31 — the tier pipeline has inverted, and the lever is at filing time.** senior-dev holds
  **0** servable `Todo` (its last row went In Progress mid-fire; its only Backlog row, LOOP-38, is
  blocked) while junior-dev sits at **10/10** with **31 of 34** Backlog rows queued behind it. Output
  to date is near-balanced (35 junior / 27 senior Done, near-identical median fire length), so this is
  a *queue-composition* problem, not a capability one. §21b forbids re-tiering to fix it, which makes
  filing the only legal valve — this fire filed **LOOP-144** to senior on its genuine cross-module
  signal rather than rebalancing anything.

- **2026-07-31 — four increments landed and closed in one fire, and the §12b hold is what made it
  safe.** LOOP-136 (daemon-guard widening), LOOP-120 (`strategyDoc` setter + doctor W17), LOOP-134
  (`add-repo` refuses field flags on an existing ref) and LOOP-139 (`run-all.ts` coverage) all reached
  `Done`. Two of them — 120 and 134 — were verified while their PRs were still open, held In Review as
  landing wait-states rather than bounced, and merged **mid-fire** (10:55–10:56Z). Closing them meant
  proving the merged content equalled the reviewed content: 120 was byte-identical, and 134 required
  isolating the squash delta against its real parent (`ed00279^1`, itself LOOP-120) because a plain
  two-dot diff against the PR head was contaminated by the rebase. **Verify-then-hold cost two
  comments and produced four clean closes; bouncing them to `Todo` to "make progress visible" would
  have destroyed the review.**
- **2026-07-31 — a merge gate shipped this morning is not running, and nothing can see that.** The
  review-admission gate (LOOP-89/LOOP-110, PR #86) merged at **06:29Z** to refuse the
  `In Progress → In Review` edge on an unlanded PR. It is wired correctly on main (`cli.ts:144`
  re-routes `ticket update` to `cli-agentops.ts`, which calls it at `:361`). It is **absent from the
  installed `dist/`**: the running `@dyzsasd/dev-loop` is `1.11.0` built **Jul 30 19:07**, and
  origin/main *also* declares `1.11.0`. Four hours after that merge it let LOOP-120 (10:16) and
  LOOP-134 (10:21) into In Review with open PRs; senior-dev's LOOP-136 merged first and transitioned
  17 seconds later, so the intended sequence is achievable and only the missing gate distinguishes
  them. Recorded as evidence on **LOOP-38** — whose blast radius is no longer "Done CLI fixes aren't
  live" but **"every merged guard is silently inert, and no version check can detect it."**
- **2026-07-31 — §9c cleared two long-parked rows.** LOOP-120 landing retired the last live edge on
  **LOOP-50** and **LOOP-60**; both unparked. The tier pipeline is unchanged and still inverted —
  senior **1**, junior **10/10 at cap**, Backlog **34**.

## Personas

- **Operator (primary).** Runs the loop on a product, reviews reports, drops 点评, sets
  direction. Today: terminal + the data dir; wants a web app + Slack/Lark to do this from
  anywhere. _(For this repo, the operator and the developer of dev-loop are the same
  person — dogfooding.)_
- **Plugin adopter / developer.** Installs dev-loop to run the loop on *their own*
  product; cares about onboarding (`init`), backend choice, and safety boundaries.
- **Roadmap stakeholder (future).** A non-operator (PM-ish/business) who views and edits
  the roadmap via the planned web UI or Lark/Slack, without touching a terminal.

## Glossary

- **Fire** — one run of an agent; agents are stateless per fire (re-read ground truth).
- **Backend** — the coordination substrate: `linear` / `local` / `service` (hub).
- **Hub** — the `node:sqlite` MCP system-of-record (`backend:"service"`); gives real
  per-agent identity (`DEVLOOP_ACTOR`).
- **点评 (operator review)** — a `<report>.review.md` critique an agent distills into a
  `lessons.md` rule.
- **§17 boundary** — agents may edit `lessons.md` autonomously but must NOT auto-rewrite
  SKILL files / `conventions.md`; those are drafted as proposals for the operator.
- **Owner label** — `pm` (Features) / `qa` (Bugs); the owner files and verifies.

## Decisions (running log)

- **2026-06-14 → 06-27 — [ARCHIVED] the 2026-06 milestone arc** (daemon foundation DL-1..DL-5;
  the standalone-daemon + multi-CLI repositioning P1..P5 incl. the MCP↔daemon dispatch unification,
  npm packaging, Codex certification; the hub buildout; the two-tier Dev split). All verified Done and
  superseded by **Current state**. Full provenance rolled to **`docs/strategy-archive/2026-06.md`**
  (R2 ledger-rollup) so this live log stays the recent, actionable tail.
- **2026-06-28 — 📝 DECISION recorded: `dev-loop` flipped to the two-tier Dev split (`devSplit:true`, `059cf3e`) — supersedes the "stays single-dev / no dev-tier markers" conclusion in the entry directly above.** The operator reversed the DL-78 single-dev stance **for this project**: set **`devSplit:true`** (+ launcher `DEV_SPLIT=1`). Rationale (root-caused in `059cf3e`): monitoring caught **split-events = 0 over ~100 min** — the senior/junior-dev agents were *inferring* the dev model from board history + the Canceled DL-78 ticket and defensively no-op-ing, silently stalling the whole implementation tier; **that inference was the bug.** The fix made **`devSplit:true` the single authoritative source of truth** — agents read the flag, never infer from history / `models{}` / actor-attribution / launcher panes. **Now live:** junior-dev actively claims + ships (DL-96, DL-98 → Done; DL-97 corrected the last straggler SKILL so all live agents read the flag authoritatively). **PM routing here (effective now):** tier-tag every dev ticket via the §18 `service` encoding (the ticket **`assignee`** actor) — improvement / bug-fix → **junior-dev**, new module / feature → **senior-dev** (`Mode: design`), **borderline → junior-dev** (escalation is the cheap safety net). Already mirrored in **Current state** (the 2026-06-27 correction); this entry closes the running-log's stale tail so a future fire reading only the latest Decision isn't re-misled.

- **(operator, 2026-07-02) DL-78 reconcile.** The 2026-06-27 decline of model-tiering (DL-78) was superseded by the operator-directed per-agent codingAgent/model/effort config shipped in a11f9e5 (2026-07-01). Recorded retroactively so the ledger and the shipped scheduler agree.
- **(operator, 2026-07-02) DL-2 amendment — the daemon web UI may carry a tiny inline script.** The original "no client JS, no bundler" doctrine (DL-2, 2026-06-23) is relaxed to permit a single ~15-line inline progressive-enhancement script for SSE live updates (`GET /api/stream`): the board/activity pages now refresh themselves as agents mutate the ledger, degrading to a static page when JS is off. Still no bundler, no dependency, no external script; a CSP (`connect-src 'self'`) bounds it. The UI's whole point is watching an autonomous loop — a dead page that needs manual F5 defeated that.
- **(operator, 2026-07-02) Linear-parity scope — what we build, and what we deliberately skip.** BUILT (the features that serve agents-coordinating + an operator-reviewing): relation-aware querying (`list_issues relatedTo:<id>` + `get_issue.referencedBy`), per-ticket history (`list_events ticketId:`), incremental reads (`updatedSince`), and native Linear priority on the mirror. DELIBERATELY SKIPPED (a queryable data model, not a project-management app) — do NOT re-propose these on the rotating competitive-parity lens without a new concrete need: **cycles/sprints + estimates** (agents fire on cadence, not sprint economics; `/activity` accept-rate + cycle-time are the value metrics), **due dates** (the DL-89 WIP-aging flags supersede), **milestones/initiatives** (the roadmap doc-kind covers), **saved views** (URL filters suffice), **reactions/threads** (agents coordinate via flat comments), **attachments** (the §22 reports tree is the artifact store), **SLAs** (Ops cadence + the DL-76 no-progress breaker). DEFERRED (real value, not yet built): a default `list_issues` limit + summary-field mode (a behavior change needing SKILL/§10 coordination), and comment-body search.
- **(pm, 2026-07-30) Fresh workspace, first PM fire — the five operator intake asks groomed against
  the code, not against their titles.** The loop was restarted on a **new workspace** (`loop` team,
  `LOOP-*` prefix, `devSplit:true`, backend `service`, single repo `dev-loop`); every `DL-*` id
  earlier in this log belongs to the previous workspace's board and no longer resolves. The
  operator seeded five title-only intake tickets (LOOP-1…LOOP-5); PM verified each sub-item against
  HEAD `3cfc250` (v1.10.0) before filing anything, and the checking paid for itself:
  - **`quota errorClass` was already shipped** — `classifyFireError` already emits
    `spend-limit`/`rate-limit`/`auth`/`network`. Reported, not refiled (§8 dedupe-against-reality).
  - **LOOP-2 (metering core) is exactly the precursor the `Candidate ideas`
    "Loop-cost-governance — Phase 2" entry was banked on.** `LOOP-4` (the aggregation surfaces) is
    therefore **deliberately held in `Backlog` behind a `Blocked-by: LOOP-2` edge** — three
    dashboards over an empty column is not work. This is the sequencing call of the fire.
  - **LOOP-1 was a six-item bundle** → one already-shipped, three scoped junior tickets
    (LOOP-7/8/9), and one that needed design (LOOP-10, `Mode: design`: the runner has no
    claimed-ticket release path at all, and which mechanism is right depends on the Sweep boundary,
    tier-assignment preservation, and race safety).
  - **Scoping ruling (so Dev does not block on it):** `references/config-schema.md` is a
    config-field reference documenting code behavior — **not** a §17 governing file, so it is in
    scope for a Dev ticket that changes the config surface. `conventions.md` and `skills/**/SKILL.md`
    prose remain out of scope; generated cheat-sheet blocks are regenerated, never hand-edited.
  - **Funnel defect found and filed (LOOP-11):** §5a's Backlog-first intake is **unenforceable
    through the documented CLI** — `dev-loop ticket create` has no `--state` and defaults to `Todo`
    (so QA/Architect/Ops discoveries land straight in the commitment queue, bypassing PM's gate),
    and `dev-loop ticket update` has no `--description` (so PM's §5a "refine vague tickets into §6
    shape" duty cannot be done through the CLI at all). The `save_issue` op supports both; only the
    wrapper is thin.
  - **⚠️ `Current state` below is stale and PM did NOT rewrite it:** it describes the **1.2.0** line
    while the repo is at **v1.10.0** — eight releases of unrecorded shipped work (quality gauntlet +
    CRAP/mutation gate, the Go language backend, `--diff-base` PR gate + reusable CI, multi-provider
    hardening, the per-fire context program, the developer-code security scanner, one-click
    deployment). Both prior re-syncs of that section were operator-authored (2026-07-05, 2026-07-12),
    so PM is flagging it here rather than taking the section over unprompted.
- **(operator, 2026-07-10) The 2026-07 full review → 1.2.0.** Six-dimension design review; every
  decision recorded as **D1–D11 in `docs/design/2026-07-review-decisions.md`** (the durable
  record — this line is a pointer, not the ledger). Shipped as **1.2.0** (PR #21): CLI-first
  agent interface (D8/D9), `dev-loop init` wizard, multi-project web UI + docs system (D2/D3),
  hub `project` override (D1), investigation protocol + doc mirror (D4/D5), retention/archive
  (D6), SKILL template + context budgets. Repo hygiene (D11): `examples/` + `evaluation.xlsx`
  moved out to `~/workspace/jinko/writing-loop/`.
- **2026-07-30 — [ARCHIVED] the 2026-07-30 pm fire arc** (fires 2-N: the lens rotation from
  `strategy-gaps` through `trust-safety`, the metering/landing/observability chains, and the
  design-gate + §9c tracker rulings of that day). All verified Done or superseded by later
  entries and by **Current state**. Full provenance rolled to
  [`docs/strategy-archive/2026-07.md`](strategy-archive/2026-07.md) (R2 ledger-rollup, 71.2 KB)
  so this live log stays the recent, actionable tail.

- **2026-07-31 (early arc) — [ARCHIVED] ~30 rulings and method notes from the day's earlier PM
  fires.** The board's search / acceptance-rate / ownership contracts; the send-back-vs-verify-fail
  boundary and the third verify outcome; §9c's `Canceled`-is-not-satisfied asymmetry and the
  decaying-measurement rule; the §21a-gate-outranks-the-§5a-cap ruling; the validate-then-drop family
  reaching six shapes; the first §20 R2 rollup; and the standing rules that a `Done` capability is
  verified against the workspace's OUTPUT and that a guard's predicate must be invariant under the
  operations it guards. Rolled to **`docs/strategy-archive/2026-07.md`** (§20 R2, second rollup of the
  day) — the live tail below keeps the most recent entries.
- **(pm, 2026-07-31) 📝 DECISION — a test double that never validates its input cannot catch a wrong
  input, and that is now the loop's fifth distinct way of shipping a green lie.** LOOP-121: the
  `landing-observability` reader has asked `gh` for a nonexistent JSON field since the day it landed,
  through a passing suite, two verifications, and green CI on two Node versions. Nothing about the
  *code* was wrong in a way review could see — `hub/test/landing.ts` injects an `ExecFn` that answers
  any argv, and LOOP-42's fixture writes a fake `gh` binary that regex-matches `--state open` and
  ignores the rest. **Both doubles accept arguments the real tool rejects**, so the suite proves the
  parser and the classifier and is structurally silent about the only thing that is broken. The
  running tally of this failure family, one per fire: (1) checked against the code, never the ledger;
  (2) checked against an output that had since moved; (3) checked against the code of a version that
  isn't the one running; (4) checked against a fixture that dodged the case; (5) **checked against a
  double that would have accepted anything.** The standing method — *ask which variable the fixture
  holds constant, then ask what the product does when it varies* — held again; the new refinement is
  that **an argv is a variable too**, and a mock is the one place a wrong argv is guaranteed to look
  right. LOOP-121's third AC makes the double validate its own input; LOOP-111's guard-rail comment
  applies the same rule to the next hand-rolled `gh` probe before it is written.
- **(pm, 2026-07-31) 📝 DECISION — a child that correctly consumes a broken dependency is `Done`, and
  the strategy doc carries the inertness.** LOOP-42 met all five of its ACs against the merged product
  and its contract explicitly forbade opening its own forge call, so failing it would have punished
  the implementer for LOOP-40's defect *and* stranded correct merged code In Review (the LOOP-112
  one-way door). The ticket state answers "did this increment do its job"; **`Current state` answers
  "does the capability exist"** — and only the second one is allowed to say no here. The corollary is
  a duty: when a `Done` sits on top of something inert, the doc entry is not optional, because the
  board will otherwise read as three shipped children and a working feature.
- **(pm, 2026-07-31) 📝 DECISION — a `Done` blocker whose *reason* is still true gets its edge retired
  and its constraint promoted into the ACs, never a re-block.** LOOP-4 was parked because "there is no
  token/cost data, so every surface would aggregate an empty column". Both blockers (LOOP-83, LOOP-85)
  are now Done and the sentence is still true — the ledger is `0 of 193` until LOOP-38 lands. Blocking
  again on an operator-gated prerequisite would park a buildable design for a third time; unparking
  silently would send senior at a surface that renders `$0.00` and calls it a total. So the edge was
  retired and the empty column became a requirement: fixtures not this ledger, an explicit no-data
  render (LOOP-42's `landed unknown` is the in-repo precedent), and *N of M fires carry usage* stated
  on the surface itself. **Generalises last fire's Canceled-because-superseded ruling:** the board
  records that a blocker *closed*, never whether the condition it protected against *cleared* — so
  every §9c unpark must re-read the reason, not just the edge.
- **(pm, 2026-07-31) 📝 The `board:` line is now three-for-three on unmeasurable fields presented as
  measurements.** `landed unknown` (correct, LOOP-42's AC3 — the one that got it right); `0 escaped to
  prod` on a loop that runs neither agent able to set the `incident`/`signal` label and has no prod
  deploy at all — 0 of 121 tickets carry either (filed **LOOP-122**); `1 parked` while **two** tickets
  sit in `Human-Blocked`, because the KPI keys on the `blocked` *label* while the human park on
  `service` is a *state* (LOOP-92 has been invisible to it for fourteen fires; evidence added to
  LOOP-31). The pattern worth naming: **a zero that cannot be non-zero is a null wearing a number's
  clothes**, and it always reads as the reassuring answer.
- **(pm, 2026-07-31) 🧭 STANDING RULE — a guard's predicate must be invariant under the operations
  its own workflow performs routinely.** `push-guard` identifies a passenger commit by **SHA ancestry
  in local `main`**; the workflow it guards tells agents to **rebase onto `origin/main`** whenever CI
  asks for an update. Rebase rewrites SHAs, so the predicate is destroyed by the most ordinary action
  in the pipeline — and the guard fails *silently and in the permissive direction*, reporting `clean`
  on 18 commits of which 16 were passengers. **The generalisation, and it is the fourth member of the
  `validate-then-drop` family:** when a check keys on an *identity* (a SHA, a path, a pid, a port)
  rather than a *property* (what ticket the commit claims, what DB the handle points at), ask which
  routine operation changes that identity — then assume it happens. The fix is not a tighter identity
  (patch-id would close this instance and still miss an edited passenger) but a **rewrite-invariant
  property**: the `(TICKET-ID)` subject convention, which survives every rebase. Ratified on LOOP-87
  (raised P1). **Same fire, same shape, second surface:** LOOP-124 — the board identity bar keys on
  `process.cwd()` when the property it means is *the database this daemon opened*.
- **(pm, 2026-07-31) ⚖️ RULING — when the ambiguity a triage hit exploits is in PM's OWN acceptance
  criterion, passing is mandatory, not discretionary.** LOOP-52 shipped an identity affordance that
  names the daemon's cwd-resolved workspace rather than the DB it serves; I reproduced the lie on the
  production entry point first try. Under §3's letter that is a MISUNDERSTANDING ⇒ verify-fail. I
  passed it. **The reasoning, extending the LOOP-9 precedent rather than restating it:** LOOP-9
  established that a triage hit inside a gap *the ticket's own scoping* pre-authorised is passed-and-
  filed. LOOP-52 is the sharper case — the gap was authored by **me**, in the AC's own words
  (*"the workspace root **or** `hub.db` path"*, offered as equivalents that are only equivalent when
  no `DEVLOOP_HUB_DB` override is in play). The implementer satisfied the criterion as written **and**
  solved the motivating scenario (a foreign daemon runs in its own workspace, so the two boards *are*
  distinguishable). Cancelling merged, CI-green, correct-to-spec work because the spec was mine to
  get right would teach the tier to distrust its own ACs — the most expensive lesson available. **The
  rule:** own the ambiguity by name in the verify comment, pass, file the defect with the AC the spec
  should have carried (LOOP-124), and say plainly that the operator may overrule cheaply.
- **(pm, 2026-07-31) 📝 A green suite is silent about every variable it never varies — now measured
  three fires running, and this fire it was MY OWN test that lied to me.** LOOP-52's regression suite
  spins two **real** daemons and fetches **real** pages (genuinely good practice, and I said so) — and
  asserts the ws-bar's CSS class and version string, **never the path**. So the wrong path survived a
  green suite, CI on two Node versions, and my own verify; the suite would pass if the bar rendered
  any string at all. Then, hunting the same class of bug, I mis-read my *own* probe: zsh does not
  word-split unquoted variables, so a `for a in "--pr notanumber"` loop passed one argument, not two,
  and reported exit 2 where the real argv gives exit 0 — I nearly filed an AC miss against a correct
  exit-code table. **The tally, one per fire: (1) checked against the code, never the ledger; (2)
  against an output that had since moved; (3) against the code of a version not running; (4) against a
  fixture that dodged the case; (5) against a double that would accept anything; (6) against an
  assertion that never named the field under test; (7) against my own harness's argv.** The discipline
  that keeps working: **re-run the real thing with the exact inputs the code sends, and read the
  degraded field instead of skimming past it.**
- **(pm, 2026-07-31) 📝 DECISION — a design gate promotes *every* staged child, even the blocked ones;
  and an increment that cannot land goes back to `Todo`, not to `Canceled`.** Two routing rules
  settled this fire, both against a plausible alternative. **(1)** senior-dev's LOOP-4 handoff proposed
  "promote A; leave B/C parked in `Backlog`". §21a requires promoting all staged children *before*
  closing the parent, and the reason is concrete: a child left in `Backlog` behind a `Done` parent is
  invisible to every dev pick-query *and* to the §9c unpark scan — that is precisely how children get
  stranded. Resolution: **all children → `Todo`, with `blocked` added to the ones carrying real
  `Blocked-by` edges.** The junior slice excludes `blocked`, so sequencing is preserved and §9c
  auto-unparks them; nothing is stranded. Note `ticket create --blocked-by` writes the *marker* but
  **not the label** — closing that gap is the gate's job. **(2)** LOOP-79/LOOP-80 arrived `In Review`
  with red CI over a one-line packaging omission. §3's close-and-supersede is built for *landed* work
  that missed its ACs; these never landed, and superseding would have burned two branches and two
  rebuild cycles for an omission. But leaving them `In Review` was not an option either — per LOOP-112
  the dev queue serves `todo` + the tier's *own* `In Progress`, so an unlanded ticket parked there is
  unreachable by the only agent allowed to land it (LOOP-45 stranded 9h that way). **Routed back to
  `Todo` with the exact fix.** The general rule: *`Canceled` is for work that was wrong; `Todo` is for
  work that is right and unfinished.*
- **(pm, 2026-07-31) 📝 The lens found the defect in the *agent's* flow, not the human's — and the
  operator's manual is otherwise accurate.** Audited every factual claim `operator-brief.ts` generates
  into each workspace's `CLAUDE.md` by running the argv it advertises: `team add-project|add-repo|
  add-provider|set|sync-opencode`, `secret set`, `hub start`, `bundle export`, `up`, `doc list|get`,
  `run --agents core --once`, and doctor codes W13/W14/W15 — **all real, all as described.** Exactly
  one claim is false, and it is the same `:8787` literal LOOP-124's AC4 already covers. But the live
  proof is worse than staleness: `:8787` is held by a **15-day-old v1.2.1 daemon from a different
  workspace** (`/Users/shuai/workspace/jinko/dev-loop`) that answers **200 OK**, so an operator
  following the instruction lands on a real-looking, wrong, foreign board. A connection-refused would
  have been kinder. Added as **LOOP-124 AC5**: `up.ts:215` prints `env ?? 8787` while the lifecycle it
  just invoked *resolved and recorded* the true port — and **`doctor`, `hub status` and
  `init-wizard.ts:211` all read it correctly**, so the fix is to copy a sibling, not to invent one.
  **The pattern worth keeping: when one surface is wrong, look for the sibling that is right — this
  loop keeps shipping the correct resolution ladder in one place and re-deriving it badly in another
  (LOOP-117, LOOP-124, and now `up`).**
- **(pm, 2026-07-31) Integrity-audit doctrine: the script audit denies by default, and LOOP-129 is
  NOT folded into LOOP-128.** Two calls, both encoded into LOOP-129's ACs:
  **(1) Deny by default, not a longer allow-list.** The obvious fix for the `postinstall`/`prepack`
  gap is to add those two names to `RELEASE_SCRIPT_EXACT`. That is refused as the *whole* fix,
  because an allow-list of two only moves the hole to the third name — the next lifecycle script
  anyone adds re-opens it silently, and nothing fails to announce that. AC3 therefore requires that
  **any** unpinned npm lifecycle script (`preinstall`, `prepare`, `prepublishOnly`, …) is itself a
  finding. A security guard whose coverage depends on someone remembering to extend it is a guard
  with a maintenance-shaped hole. Constraint the implementer must respect: the scanner is
  deliberately stdlib-and-Git-only because it runs *before* Node exists, so it cannot grow an
  npm dependency to enumerate lifecycle names.
  **(2) Same file, two tickets, deliberately.** LOOP-128 ("the check has no local runner" —
  throughput/DX, P1, junior) and LOOP-129 ("the check has a hole" — coverage, P2, `sensitive` →
  senior) both live in `security/`. They are kept apart because the fixes touch different files, at
  different tiers, on different urgencies: LOOP-128 is why two PRs are red *right now*; LOOP-129 is
  defence-in-depth on the published artifact. Folding them would let the urgent one drag the
  careful one, or the careful one delay the urgent one.
- **(pm, 2026-07-31) ⚖️ RULING: an increment whose ACs pass but whose PR has not merged goes back to
  `Todo`, not `Done` and not `Canceled` — and the route-back is now evidence-backed.** LOOP-79 and
  LOOP-80 were verified in full (every AC observed, §3 triage clean, LOOP-79's regression test proven
  RED against `cec3598`) and still moved to `Todo`, because an unmerged PR has not landed and
  `In Review` is unreachable by the tier that must land it (LOOP-112). The precedent is now measured
  rather than argued: **the same treatment on LOOP-65 produced a clean landing in twelve minutes**,
  where §3's close-and-follow-up would have discarded a branch that passed every AC. **The boundary
  holds at wrongness.** `Canceled` + follow-up is for an increment that is *wrong*; `Todo` is for one
  that is *right and unfinished*. A green-but-unlanded PR is unfinished ship-work owned by the
  implementer, and the ticket state should say so out loud rather than parking it where nobody can
  act. Cost to name: this pushes junior to 11/10, over cap — accepted, because false `Done` and
  silent stranding are both worse than a visibly over-full queue. **A route-back is not a §5a
  promotion and is not depth-capped.**
- **(pm, 2026-07-31) 📝 Three hypotheses died this fire and none became a ticket — the count is the
  point.** (1) *"senior idles because §21b's escalation safety net never fires"* — it fired 8 times,
  all 8 `Done`. (2) *"`local_code_scan.py` is 98 KB of shipped code CI never invokes"* — true and
  correct by design; it scans a developer host, not a repo. (3) *"its no-source-snippets claim is
  unenforced prose — there is no redaction code anywhere in the file"* — the claim is structural and
  **holds under a six-canary control**. Each was a plausible P1/P2 that would have cost an implementer
  a fire to disprove. **The method that killed all three is the same one that found LOOP-129: treat
  the stated claim as an assertion and go run it.** The difference between "I read the code and it
  looks wrong" and "I ran a control and it is wrong" is an entire wasted increment, and this fire it
  went the other way three times. Filing **zero** with a 34-deep backlog and junior over cap is the
  correct outcome, not an unproductive one.
- **(pm, 2026-07-31) 📝 The merge-guard chain is complete and enforces nothing — wire it in two
  stages.** LOOP-64 (review axis), LOOP-67 (board-state axis) and LOOP-65 (`--apply`) are all `Done`;
  LOOP-69, the §17 hand-off that calls the verb from the fire-start merge pass, unparked to the
  operator this fire with both edges retired. The staged recommendation is recorded on the ticket and
  is unchanged, but its premise was **re-confirmed against live state rather than assumed**: enforce
  `Canceled`/`Duplicate` now (unambiguous, and PR #61 already needed it), and hold `In Review` out of
  the enforcing set until **LOOP-110** lands — because LOOP-79 and LOOP-80 sat `In Review` with green
  unmerged PRs at 06:00Z today, and an `In Review`-enforcing guard would have made both permanently
  unmergeable with no state either ticket could reach to clear the refusal.
- **(pm, 2026-07-31) 📝 A new `hub/test/*.ts` in a diff is a two-file change, and the second file is
  `hub/package.json`. This is now a standing §3 triage step.** Last fire I routed LOOP-79 and LOOP-80
  back to `Todo` for exactly this defect and wrote the lesson down. On the very next increment that
  could trip it — LOOP-110, verified an hour later — I checked the three files it touched, found them
  clean, and **closed it `Done` without checking the fourth file it needed to touch**. `origin/main` was
  red at that moment and my verify comment said "spec triage: clean". The generalisable error is that
  **§3's MISSING category is not confined to files the diff contains**; a delta can be missing from a
  file the diff never opens. The check is one command and it is now unconditional whenever a diff adds a
  test file: `python3 security/source_integrity.py --whole-tree`, or the direct form — count
  `git ls-files 'hub/test/*.ts'` against occurrences in `scripts.test`. Correction recorded on LOOP-110
  rather than silently reopening it: the capability is complete and correct, the missing line is
  **LOOP-133**, and reopening a landed working increment to add one line costs more than it recovers.
- **(pm, 2026-07-31) 📝 An AC that the same ticket's own "Out of scope" section contradicts is a PM
  defect, and the implementer gets the benefit.** LOOP-116's AC2 demanded "the CI quality step's max
  CRAP is strictly below 70" while the ticket's Out-of-scope paragraph excluded `isError`
  (`fire-usage.ts:48`) — which **is** the global max at 90.0. Even discounting it, the next rows
  (`doctorWorkspace` 84.1, `metricsCli` 83.3, `upCli` 79.7) all sit in files the ticket forbade
  touching, so **no decomposition of `daemon.ts` could ever have satisfied the AC as written**. The real
  intent was met with room to spare: max CC in `daemon.ts` 86 → **30** (AC asked ≤ 45), max CRAP 86.7 →
  **30.5**, and no `daemon.ts` row anywhere in CI's top-15 whose floor is 53.5. Passed on intent, with
  the spec defect named as mine on the ticket. **Before writing a global-threshold AC, check whether the
  metric is dominated by anything the ticket puts out of scope** — if it is, scope the AC to the file.
- **(pm, 2026-07-31) 📝 Re-running `dev-loop queue` after Job A "finishes" has now paid off three fires
  running, and this time it caught a ticket that landed mid-fire.** LOOP-79's PR #78 merged at 07:56Z
  while I was verifying LOOP-126; a single closing `queue` read surfaced it and it closed `Done` in the
  same fire instead of waiting ~30 minutes for the next one. The route-back pattern is also now
  measured end-to-end: LOOP-79 was fully verified and sent to `Todo` (not `Canceled`) last fire purely
  because its PR was unmerged, and it landed clean this fire with the `package.json` registration its
  routing note asked for — the same registration LOOP-110 omitted. **`Canceled` is for work that was
  wrong; `Todo` is for work that is right and unfinished** — three applications, three clean landings.
- **(pm, 2026-07-31) ⚖️ RULING — the product may not instruct the operator to break its own hard
  rule, and today it does.** `dev-loop team set` rejects any path outside a 27-entry allowlist and
  closes with *"edit `dev-loop.json` directly and validate with `dev-loop doctor`"*. The shipped
  `skills/operator-console/SKILL.md` states the opposite twice, once in its `description:` and once
  as a hard limit at `:95` — *"Config through mutators only — never hand-edit `dev-loop.json`."* Both
  halves ship in the same package. The ruling: **the CLI is the surface that must change, not the
  rule.** A rejection must route by class — name the mutator that owns the path, say "create-time
  only", or state plainly that no writer exists yet — because an operator meeting a dead end deserves
  the truth rather than a suggestion to violate the contract they were handed. Filed as LOOP-135.
  `add-project`'s existing-key `die()` gets the same treatment; it ends with *"or edit dev-loop.json"*
  too. **Deliberately NOT in scope: adding the missing writers.** Whether `agents.<h>.cadence`,
  `hub.agentInterface` (documented as *"the rollback switch"*), `projects.<key>.{mode,autonomy}`,
  `team.autonomy`, `reports`, `mirror.*` and the daemon alert cadences should become settable is a
  capability call with real surface-area cost — banked in `Candidate ideas`, not decided here.
- **(pm, 2026-07-31) 📝 DECISION — a mutator that discards input and reports success is a
  correctness defect, not a UX one, and it outranks the missing capability.** Two gaps sit on the
  same code path: `team set` *cannot* write a repo's `landing`/`autoMerge`/`mergeChecks`/build gates
  (a missing capability), and `team add-repo` *pretends to* and then doesn't (a lie). I filed the lie
  as P1 (**LOOP-134**) and the capability question as a banked candidate, because a missing feature
  is discoverable — the operator hits an error and asks — while a success message over a discarded
  write is not. `add-project` already models the right behavior: refuse loudly and name the route. The
  fix must pick **apply or refuse** deliberately and state it in the usage string; either is honest,
  and silence is not.
- **(pm, 2026-07-31) 🧭 STANDING RULE — before filing "X is undocumented/unwired", check whether the
  sibling surface is right, then check whether the *fixture* is.** Both of this fire's tickets came
  from that pair of questions and neither came from the strategy doc. `add-project` vs `add-repo` on
  "already exists" gave the shape of the bug in one read; `hub/test/team-edit.ts`'s six fresh-ref
  cases explained why a green suite never caught it. The same pairing killed this fire's first
  hypothesis in four calls — *"a shipped SKILL names a `dev-loop` verb that does not exist"* was
  **FALSE**: all **141** `dev-loop <verb>` command occurrences in `skills/**` and `references/**`
  prose (cheat-sheet blocks excluded, since `hub/test/cli-cheatsheet.ts` byte-checks those) resolve
  against the real `ROUTES` table. `skills/` and `references/` are now swept for this class.
- **(pm, 2026-07-31) 🧾 §20 R2 ledger rollup executed — the second of the day, and the cadence is
  now the finding.** The live doc was **199 KB, 10× its ~20 KB budget**, only four hours after the
  previous rollup took it down. `Current state` was 103 KB (52%) and `Decisions` 67 KB (34%) — 86%
  between them — because ~20 PM fires a day each append 1–4 entries. Archived the whole dated
  **2026-07-30** `Current state` arc and the early **2026-07-31** Decisions arc to
  `docs/strategy-archive/2026-07.md`, leaving one `[ARCHIVED]` pointer bullet each: **199,132 →
  128,671 B (−35%)**. **The durable preamble and the 1.3.0–1.10.0 release history were deliberately
  kept** — they are what the section is *for*; only the dated arcs roll. At this append rate the
  rollup is not an occasional chore but a **per-fire cost**, and the next PM should budget it as a
  first-class task rather than discovering it at close.
- **(pm, 2026-07-31) 🔴 A guard can go green by moving the code out of its own field of view — and
  the same diff that built the guard did it.** LOOP-94's AC-A4 asked for a scan proving
  `src/daemon.ts` **/ `daemon up`** is spawned only from the test harness. The shipped rule matches
  one literal: a line carrying both `daemon.ts` and `spawn`. Seeding one line into a non-harness
  test at the merge sha, the guard **caught** `spawn(NODE,["src/daemon.ts","up"])` but **passed**
  both `spawnSync(NODE,["src/server.ts","daemon","up"])` and the installed-CLI `[instCli,"daemon",
  "up"]` — and those two idioms are not hypothetical future ones, they are **what this very diff
  rewrote `lifecycle.ts` and `lifecycle-race.ts` into**. Four of the seven pre-fix violations went
  green by changing the spawn target string, not by routing through the harness. The harness itself
  is correct and the guard does have teeth (7 violations, exit 1, against the pre-fix tree) — the
  defect is that it cannot see the pattern the tree now teaches, so the next test to copy
  `lifecycle.ts` leaks silently. Verify-failed; superseded by **LOOP-136** (senior-dev,
  `direct-code`). **The generalisation, and it is the fourth instance this week: a guard's rule must
  be written against the PROPERTY it defends, never against one spelling of it — and when a diff
  both writes a guard and edits the code it guards, check whether the green came from the fix or
  from the relocation.**
- **(pm, 2026-07-31) ⏳ The same class caught one ticket earlier, before it shipped.** LOOP-95
  (`Todo`, unbuilt) specifies its early-warning line as *"if the chosen port is more than
  `PROBE_WARN_GAP` (8) above the requested start"*. But `lcFreePort` probes exactly 64 ports and on
  total failure **returns `start`** — so at full exhaustion the gap is **0 and the warning never
  fires**, in precisely the case the operator most needs it. Root cause is a lossy return type: 8787
  means "the start port was free" and "I tried 64 and failed" identically, so no caller-side
  arithmetic can recover it. Binding correction posted (amended AC-B5 + new AC-B6/AC-B7: signal
  exhaustion at the source, emit a distinct louder line naming `daemon reap` *before* the bind, and
  regression-test both polarities). **Two guards blind in their own defining case, found in one
  fire, on unrelated code.**
- **(pm, 2026-07-31) 🧭 Deliberately filed one Job-C ticket, not five.** The junior tier sat at its
  Todo depth cap (10/10) with **31 unblocked Backlog items** behind it. With the queue saturated the
  marginal value of another junior-tier idea is ~0 — the bottleneck is throughput, not ideas — so
  the fire's discretionary output went into two **binding spec corrections on unbuilt tickets**
  (LOOP-95, and LOOP-84's build guidance) instead of new rows. Correcting a spec before it is built
  is worth more than filing the ticket that would have caught it afterwards.
- **(pm, 2026-07-31) 📝 DECISION: the release gate is the loop's single blocking constraint — every
  other sequencing question is subordinate to LOOP-140 until it lands.** Nothing the loop has built
  since `89244e7` (2026-07-30 17:01Z) can reach a user; the npm publish path has been dead since
  `c02ba33` and no CI signal says so. Consequences recorded so no fire re-derives them: (a)
  **LOOP-38 is `Blocked-by: LOOP-140`** — the installed-binary skew it describes *grows* with every
  merge and cannot be closed by anything but a release, so re-measuring it now just re-derives the
  same fact; (b) **LOOP-142 should ship in the same v1.12.0** as the merge-guard wiring it repairs,
  because that wiring goes live the moment the package publishes and half of it is a no-op until
  then; (c) the operator's "head of the queue" instruction on LOOP-140 **is** mechanically enforced
  — `PICK_RANK` puts P1+`Bug` at rank 0 and LOOP-140 is the oldest such row, so the two older P1s
  (LOOP-128, LOOP-134) rank behind it as `Improvement`s. Checked rather than assumed; a prose
  instruction that the router happens to disagree with would be invisible.
- **(pm, 2026-07-31) 🧭 Filed two tickets, both routed rather than ideated — no Job-C lens sweep
  this fire, deliberately.** HEAD moved (`c02ba33` → `58ef4eb`) so the lens list reset and Job C was
  formally due. Skipped it anyway: junior sits at **14 Todo / 11 unblocked** over a 34-row Backlog,
  *and* the release gate means nothing that tier builds can ship. Adding a lens-driven idea to a
  saturated queue behind a closed shipping path is worth ~0. The fire's output went to what the
  product actually produced on its own: two **binding spec corrections** (LOOP-140's attribution +
  restoration reference; LOOP-142's proven repro) and two routed files (LOOP-142 from a verify-fail,
  LOOP-143 from reflect's proposal). *Reviewing the product through Jobs A and B is still reviewing
  the product* — this fire's two sharpest findings both came out of verifying someone else's work,
  not out of looking for something new.
- **(pm, 2026-07-31) 🧭 W-code collision ruled in favour of the built ticket, and the registry was
  reconstructed by hand.** LOOP-120's PR and LOOP-41's ACs both bind **W17** — the third gate-caught
  instance of LOOP-88's hazard (filers grep the shipped `doctor.ts`; half the namespace lives in
  unlanded tickets). **Decision: the built, green, mergeable ticket keeps the code; the unbuilt
  blocked one moves** — LOOP-41 → **W22**, a one-line spec edit against a rebuild. Chronological
  priority was LOOP-41's and was explicitly overridden on cost, not merit. The interim registry is
  now written into LOOP-41: allocated on origin/main = W01–W03, W05–W16, W18, W19, W21; claimed by
  unlanded work = W17 (LOOP-120), W20 (LOOP-74); **W04 is a gap, not a vacancy — allocate forward.**
  The durable fix stays LOOP-88.
- **(pm, 2026-07-31) 🧭 Job C ran the polish-performance lens on the scheduler — an unswept surface —
  and filed one senior ticket, LOOP-144.** The fire gate (`run-agents.ts:823-836`) asks only *did
  anything change* (`MAX(events.id) | HEAD`); on a busy board another agent's comment satisfies it,
  so a dev fire launches into a provably empty queue. `opQueue` already computes the servable slice
  and the scheduler never calls it — zero references. **Filed on the structural argument and said so:
  the 18 short dev fires total 1.8 minutes of wall-clock, and the real cost — a model launch at the
  senior tier's opus/max profile before anything can observe the empty queue — is currently
  *unmeasurable*, because `fires.jsonl` records `durationMs`/`exitCode` but no token or cost field.**
  Routed senior on two explicit §21b signals, not on load: it spans scheduler ↔ queue authority, and
  the obvious fix is wrong — gating on `todo.length === 0` alone would starve the orphan-resume path,
  since a dev agent's own `In Progress` row is exactly what needs a fire when nothing else moved.
- **(pm, 2026-07-31) 🧭 Two hypotheses died before they became tickets, again.** (a) *The change gate
  keys on local HEAD, not origin* — true (`rev-parse HEAD` on a checkout that is 31 ahead / 47 behind),
  but the board cursor moves on every write and therefore dominates the key, so no mis-skip could be
  demonstrated; recorded, not filed. (b) *main is red* — `hub/test/team-edit.ts` reported **15
  failures** at `origin/main`, which turned out to be a bare `git worktree` with no `node_modules`;
  symlinking the checkout's `hub/node_modules` gives clean `TEAM_EDIT_OK` at both base and PR head.
  **A scratch worktree is not a test environment until its dependencies are linked** — worth knowing
  before reporting a red main, which this loop has done for real twice this week.

- **(pm, 2026-07-31) 📐 A guard's stated scope is a claim; verify it against the tree it passes, not
  the table it was written from.** LOOP-136's widened `daemon-guard.ts` catches all three idioms its
  ticket named — I seeded each myself — and prints *"no direct daemon spawns in test files."* That
  sentence is false on the tree it passes: `hub-lifecycle.ts:21/:60` starts three real daemons via
  `node src/hub.ts start`, and `hub.ts:60` is `case "start": … daemonLifecycleCode("up")` — the same
  `daemonLifecycle()` the guard defends, through a fourth entry file. Seeding that exact live line →
  **exit 0**. I passed the ticket anyway (AC1 said *"at minimum"* those three, and what was specified
  was delivered with real evidence) and filed **LOOP-146** instead. **A spec gap is not an
  implementation failure — bouncing the increment would have punished the wrong party.** Instance
  **#7** of the standing pattern *a surface reporting a result it never established*; the design rule
  holds: **a guard that cannot report "skipped" will be read as "clean."**
- **(pm, 2026-07-31) 🧭 Check the environment before crediting OR blaming the code — the inverse of
  last fire's lesson.** Every recent PR shows `mergedBy: dyzsasd` with `autoMergeRequest: None`, which
  reads as "the human hand-merges everything." It is not: agents run `gh pr merge` at dev Step 0.5
  under the operator's `gh` credentials, so GitHub attributes it to them. **An attribution field
  records whose token was used, not who decided.** Had I filed on the first reading it would have been
  a false "the loop never merges its own PRs" ticket — three of them merged 10 minutes later.
- **(pm, 2026-07-31) 📐 An exclusion list can strengthen an invariant, if it is declared and
  asserted.** LOOP-139's AC4 demanded a check that fails *"if someone later adds a filter."* The
  implementer added one — `NON_SUITES` + `run-all.ts --list` — which a strict reading forbids. It is
  better than the letter: an exclusion must carry a reason and is asserted against `git ls-files`, so
  a *silent* drop stays impossible. Control: adding an undeclared `f !== "smoke.ts"` filter →
  **`❌ AC4 … (missing: smoke.ts)`**. `NON_SUITES` ships empty and `daemon-harness.ts` is still
  discovered, so LOOP-138 was left genuinely open rather than quietly absorbed. **Judge a deviation by
  the failure mode the AC was defending, not by its wording.**

## Candidate ideas

_(The overflow parking lot: strong ideas not yet filed. **Rolled 2026-07-30** — ten completed /
filed / shipped / retired DL-era entries (16 KB) moved to
[`docs/strategy-archive/2026-07.md`](strategy-archive/2026-07.md); this list now holds only
candidates with an unfiled action. Earlier DL-1…DL-5 daemon/web-UI/roadmap-bridge ideas were filed
2026-06-23.)_

- **Close the config-mutator gap wholesale — an operator capability call, deliberately not filed
  (banked 2026-07-31).** `references/config-schema.md` marks each documented field with its
  `dev-loop team set` path: **13 rows carry a ✓, 26 are marked `—`**. Many of the 26 are reachable at
  *create* time via `add-project`/`add-repo`/`add-provider`/`set-model` flags, but the following are —
  measured on `origin/main` @ `312e751` — writable by **no mutator at all, at create time or after**:
  `team.agents.<h>.cadence` (`team init` hardcodes `{sweep:30m, ops:10m, reflect:1d, communication:1d}`
  at `team-init.ts:132` and nothing can change them — **this workspace has exactly those four**);
  `agents.<h>.{fireTimeout,stallTimeout,manual}`; `team.hub.agentInterface` and its project override,
  which config-schema itself calls *"the rollback switch"*; `team.autonomy` and `team.deployPolicy`
  (init-only, never after); `projects.<key>.{mode,autonomy,reports}`; `team.opencodePermission`;
  `mirror.*`; and the daemon alert cadences (`humanBlockedReminderHours`, `noProgressWindowHours`,
  `fireHealth`). **File this only if the operator wants it** — widening the allowlist is real surface
  area, and each field arguably wants its own validation rather than a blanket path setter.
  `strategyDoc` is already the filed instance (**LOOP-120**); `agentReviewers` is another
  (**LOOP-123**). **LOOP-135 is the honesty half and stands alone** — it stops the CLI recommending a
  hand-edit regardless of whether this ever gets built.

- **`worktree reap --dry-run` previews the worktrees but not the branch decisions** (recorded
  2026-07-31 at the LOOP-106 verify, deliberately not filed). The dry-run path returns before the
  branch logic, so it prints `would remove worktree …` and never says which branches would be
  *deleted* versus *KEPT as unrecoverable*. Since LOOP-106 the reap is an opt-in destructive verb, and
  for that shape **the preview is the safety mechanism** — an operator deciding whether to pass
  `--reap` cannot currently see the half that is irreversible. Not a LOOP-106 failure: no AC asked for
  it, and when the ambiguity is in PM's own AC, passing is mandatory. Pick this up wherever the reap
  is next touched.

- **Unclassified-failure-rate health warning — banked 2026-07-31, blocked on a refactor, not on value.**
  LOOP-114 fixes the one classifier pattern this workspace needed, but the taxonomy will always lag the
  next provider's wording: the failure mode is silent, and the whole point is that nobody notices a
  `null` class. The durable defense is a doctor line that fires when the unclassified share of failures
  crosses a threshold ("25 of 26 failures carry no class — the taxonomy is blind here"), which turns an
  invisible gap into a health warning. **Not filed deliberately:** it belongs in `doctorWorkspace`
  (`doctor.ts:185`), which carries ten W-code blocks. **⚠️ CORRECTED 2026-07-31: the 90.4 figure this
  bullet was banked on is stale and was blocking more than it should.** Re-measured on `origin/main` @
  `2dc6c7b`, `doctorWorkspace` is CRAP **82.9** (CC 64, 83.4% covered) and is **not** the ratchet's #1
  entry — LOOP-56 landing is what fixed it. An eleventh W-code block lands at ~84.3 **provided it ships
  with a covering test** (coverage is cubed; the same block at 80% coverage is 98.8 and red). So this
  is filable now, and so were LOOP-46 (W18 — promoted to `Todo` this fire), LOOP-74 (W20) and LOOP-81
  (W21). The real zero-margin entries are elsewhere: LOOP-115 (`fire-usage.ts:48`, CRAP 90.0) and
  LOOP-116 (`daemon.ts:449`, CC-floored at 86).
- **Cross-store ticket migration (linear↔service) — DEFERRED epic, operator decision; not a ticket
  until prioritized.** (Live remainder of the archived backend-choice-at-init bullet.) The blocker
  is structural, not effort: hub ids are a global PK minted from prefix+seq (`hub/src/db.ts:286-292`)
  and `ensureProject` hard-throws on a prefix clash (`hub/src/seed.ts:46-47`), so an importer cannot
  preserve source ids as the PK — source ids must ride a separate `externalId`. The only cross-store
  seam today is the one-way hub→Linear `mirror` (a projection, not a bridge); Linear visibility
  without migrating = `service` + `mirror`. Scope as its own epic when prioritized: exporter/importer
  per direction + `externalId` carry + id-remap + a freeze→import→verify→cutover runbook.
- **Inter-agent discussion daemon (deferred).** The Vision also names the daemon "owning
  inter-agent communication and discussion." Today that plane is the **poll-based, no-daemon**
  §25 board + P6 channel. Moving it into a persistent process is a larger architectural step
  that touches the stateless-per-fire contract and the §17 firewall — defer until the
  read/edit daemon (DL-1…DL-4) is proven, then scope as its own initiative.
- **Hub/`service` hardening pass** (supporting goal): widen `doctor` coverage and edge-case
  tests for the `node:sqlite` SoR that the daemon will build on (file as the daemon backlog
  drains and concrete gaps surface).
- **Multi-stakeholder roadmap auth** (future persona): once the web UI exists, distinguish
  operator vs. non-operator roadmap stakeholders beyond the single operator-publish gate.
- **Reports + 点评 review in the web UI** (ux-flows lens, PM 2026-06-23): the operator's
  *observe-and-steer* flow is today purely file-based (read `reports/<agent>/**`, drop a
  `<report>.review.md` 点评 sibling). **UPDATE 2026-06-23:** the operator asked for this directly,
  and the **read half** is now filed as **DL-10** (surface the daily/weekly/monthly reports in the
  web UI). **Remaining follow-up (DL-10 has now landed):** accepting a **点评 *from* the web UI** (a
  write path that drops a `<report>.review.md` sibling) — closes the operator-feedback loop without a
  terminal; reuses DL-10's reports view + a guarded write path like DL-3's roadmap edit. **⚠️ §17/§22
  firewall constraint (load-bearing — do NOT file as a naive Dev ticket):** conventions §22 states
  *"agents never write a `*.review.md` file — ever,"* because that's exactly what makes any on-disk
  review operator-authored-by-construction (the spoof-proof trust boundary). A daemon write path
  therefore needs a **conventions §22 carve-out** — "the localhost daemon MAY write a `*.review.md`
  ONLY for an operator-submitted 点评 via the web UI (the operator IS the author; localhost-trust),
  attributed/audited as such" — which is a **§17-gated `[pm-proposal]`** (operator applies), paired
  with a buildable daemon `POST /reports/<agent>/<level>/<date>/review` slice (path-validated, §16-safe,
  CSRF/same-origin-guarded since it's a write). Scope it like the cwd feature (DL-12 proposal +
  DL-13/15 buildable) — i.e. a small design pass, not a one-shot ticket. Awaiting operator
  prioritization vs. the supporting goals (hub hardening + portability) now that the milestone is done.
- **Board summary band (data-analytics lens, PM 2026-06-23 — P4 polish, parked from the 6-lens sweep).**
  `boardPage()` renders one section per state with only a per-column count; no at-a-glance composition
  by **type / owner / priority** above the columns. Pure read-only aggregate over the existing
  `query_only` db (no new table, no write route). **Deliberately parked rather than filed** — it overlaps
  the same `boardPage()` surface as the filed DL-20 (filter/search) and is convenience polish at the
  current ~16-ticket scale; file it (or fold it into DL-20's implementation) when the board grows or
  DL-20 lands. Buildable when filed — no §17/§22 gate. **UPDATE 2026-06-24: gate opened — DL-20 verified
  Done and the board grew ~16→44, so this is no longer DL-20-overlapping polish at a small scale. Confirmed
  not built (`boardPage()` still renders per-column counts only, daemon.ts:245). Filed as DL-45** (Improvement,
  pm, Low; read-only aggregate over the existing rows, respects DL-20 filters + DL-31 swimlanes).
- **Web-UI header nav: active-surface highlight (consistency lens, PM 2026-06-23 — marginal, parked).**
  Highlight the current surface in the header nav (board / roadmap / reports / the DL-17 `/activity`).
  Cosmetic parity polish with no observe/steer payoff — fold into a future nav pass alongside the
  `/activity` nav link DL-17 adds, rather than its own ticket. (The "labeled board item" half was
  redundant with the existing wordmark-as-home at `daemon.ts:127`.)
- **Loop-cost-governance — Phase 2 (sequenced after a cost-signal precursor; PM 2026-06-27, banked from the DL-73 groom).** The DL-73 intake's two cost-*quantifying* asks are **not buildable until the hub has a per-fire cost signal** (agents don't report token/$ spend to the SoR today): **(a)** a loop-level **token/$ budget ceiling** (the hard circuit-breaker complementing DL-76's no-progress detector), and **(b)** a **cost-per-accepted-change** metric + a cost column on `/activity` (complementing DL-79's accept-rate). The likely precursor is a **§17 [pm-proposal]** for the operator-owned launcher to emit per-fire cost into the hub (a new `events` kind), then a buildable hub cap + the cost surfacing. File the precursor proposal when the operator signals appetite, or when an adopter hits a real runaway-cost incident. **(c)** Surfacing DL-79's accept-rate in the **Reflect daily digest** is a Reflect SKILL change → a §17 [reflect-proposal], not a code ticket; fold into the next Reflect-curation pass rather than filing Dev work. **UPDATE 2026-07-30 (pm): ✅ (a)+(b) UNBANKED — the operator asked for the whole arc directly, and the precursor is now FILED as `LOOP-2` (metering core: `fireId` + per-fire token/cache/cost across all three CLI lanes, senior `Mode: design`), with the read surfaces as `LOOP-4` (held in `Backlog` behind `Blocked-by: LOOP-2`).** Confirmed still not built before filing: `recordFire` writes duration/exit/model/effort/`bootBytes` only, and `context-bill.ts` is a *static* 4-bytes-per-token estimator of the boot corpus — there is no measured provider usage anywhere in the hub. Note the shape changed from what was banked here: this is **operator-directed work through the normal intake path, NOT a §17 `[pm-proposal]`** — the launcher already writes the per-fire ledger (`fire.completed`), so extending it is ordinary Dev work on hub code, with no SKILL/conventions edit required. **Enforcement (a budget ceiling that stops fires) is still NOT filed** — it is a separate ticket built ON this signal once LOOP-2 lands; do not fold it into LOOP-4's read surfaces.
- **Daemon serves stale VIEW code until restarted — observe-surface lag after a Dev ship (ux-flows/ops lens, PM 2026-06-27 — banked).** The long-lived daemon (DL-41) loads `daemonviews.ts` + routes at boot, and `daemon ensure` is idempotent (never restarts a live process), so after a Dev commit that changes the web-UI rendering (e.g. DL-84's new `/activity` section, or DL-83's banner) the running daemon keeps serving the OLD view code until manually `down`+`up`'d — the operator sees fresh DATA (read per-request from the SoR) with **stale RENDERING**. Standard server behavior, but a real papercut for THIS dogfooding loop where Dev ships ~every 20min and the daemon IS the operator's observe surface (a new feature looks un-shipped until restart). **Options when filed:** a `dev-loop daemon restart` subcommand + a post-ship hint; OR a lightweight **served-commit-vs-HEAD banner** on the web UI so staleness is *visible* (the DL-83 surface-don't-prevent pattern); OR file-watch auto-reload (heavier — touches the lifecycle + the stateless contract). **Banked, not filed** — expected daemon behavior, low-severity (data is correct, only new view code lags); file if the operator finds the lag misleading or asks.
- **`DEVLOOP_*` test-env scrubbing is one idiom hand-copied ~9 times with mutually inconsistent key
  lists (consistency lens, PM 2026-07-31 — TESTED AND DECLINED, banked).** The runner injects 11
  identity vars into every fire (`run-agents.ts:896-909`). Tests that spawn a child must scrub them or
  the fire's own env leaks in — the bug that produced **LOOP-6** (`hub-lifecycle.ts`), **LOOP-32**
  (`run-agents-live.ts`) and **LOOP-45** (`run-agents.ts`), plus **LOOP-47** filed and Canceled as a
  duplicate of the last. Four fixes, one class, zero shared helper. The sites now disagree: `run-agents.ts`
  scrubs 8 keys at two spawn helpers but only 4 at a third (`runL9`, line 383, a *destructuring* idiom);
  `hub-lifecycle.ts` scrubs 3; `cli-agentops.ts` 4 (a different 4); `init-wizard.ts` 4; `daemon-lifecycle.ts`
  uses an array loop; `DEVLOOP_FIRE_ID` is handled by direct `process.env` mutation in a fifth idiom.
  **Declined because it was measured, not assumed:** `node test/run-agents.ts` at `origin/main` run under
  a full live fire env returns `RUN_AGENTS_OK` — the weak `runL9` list is a *latent* inconsistency with
  no live failure, because those cases pass `--project` explicitly. **File it when** a fifth instance of
  this bug appears, or when a new identity var is added (the next one will land in none of the six lists);
  the shippable form is a single exported `scrubFireEnv()` the way **LOOP-63** replaced 25 entrypoint
  guards in 3 idioms with one helper — precedent this loop already accepted and shipped.
- **A verify-fail should be reachable from a green suite — the "which case does the fixture dodge?"
  check, banked 2026-07-31.** LOOP-57 shipped 22/22 green and was still unusable, because its case (c)
  chose a *doc* file for the divergence it was testing and thereby made the only distinction that
  mattered (tree comparison vs commit range) unobservable. The generalizable move that caught it costs
  one question per verify: **name the variable the fixture holds constant, then ask what the product
  does when it varies.** Here: "case (c) diverges origin — with *what kind of file*?" Possible shippable
  form is a §15 convention (a regression case must vary the dimension its assertion depends on) or a
  Reflect lesson; it is a review *method*, not code, so it is banked rather than filed as Dev work.
