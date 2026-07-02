# dev-loop — Strategy

> PM's north star. Seeded by `/dev-loop:init` on 2026-06-23 (operator-present setup).
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
new client.

The invariants are non-negotiable and transport-independent: the **§17 self-evolution
firewall** (no agent ever auto-edits a SKILL / conventions / plugin / code file — structural
changes are operator git commits, surfaced as proposals), **§2 project isolation** (one daemon
= one pinned project, no cross-project endpoint), and **§16 secrets/localhost-only** (binds
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
§2 isolation (one daemon = one pinned project, no cross-project endpoint); §16 (binds 127.0.0.1
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
  (currently reads v0.15.0 while git is 0.19.2), examples, and error messages.
- **Broaden portability** — more CLIs / backends / integrations (Linear mirror, Lark/Slack
  channel, Codex) certified and documented.

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
  (`github.com/dyzsasd/dev-loop`) implementing **ten launchable autonomous agents** that
  coordinate entirely through ticket state (no agent calls another): five inward/build
  (**PM, QA, legacy Dev, Sweep, Reflect**), three outward (**Ops, Architect,
  Communication**), plus **senior-dev / junior-dev** — the default two-tier split-dev pair
  (§21a; with `devSplit` on, the legacy single `dev` defers).
- **Main surfaces / modules:** `skills/` — **11 SKILLs** (the ten agents + `init`);
  `references/` — `conventions.md` (the authoritative shared spec), `config-schema.md`,
  `codex-integration.md`; `hub/` — the `node:sqlite` MCP system-of-record, **v0.23.3**
  (`hub/package.json`), with a **29-file `test/` suite** run via `npm test` plus
  `npm run doctor`; `docs/` (architecture · running · portability · daemon · designs ·
  reviews) and `config/` (example `projects.json` + per-CLI MCP templates).
- **Coordination backends (§18):** `linear` (default) / `local` / `service` (the hub) —
  **plus the shipped opt-in daemon transport**: `hub.transport:"daemon"` routes the thin
  stdio shim to the loopback daemon op-API (the default stays direct-db stdio).
- **How it runs:** the scheduler **`dev-loop run`** fires the stateless-per-fire agents,
  with **two-level per-agent `codingAgent` (claude/codex) + `model` + `effort` config**
  (built-in defaults + `projects.json` overrides, `a11f9e5`); the daemon adds the
  localhost web UI (board · tickets · roadmap · reports · activity) and the Lark/Slack
  channel bridge.
- **Operator steering:** daily/weekly reports + `<report>.review.md` (点评) distilled into
  per-project `lessons.md` rules; direction lands via `docs/STRATEGY.md` / hub docs behind
  the operator-publish gate.

(operator, 2026-07-02: Current state re-synced to HEAD; for the always-current picture see
README.md + CHANGELOG.md.)

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

## Candidate ideas

_(The daemon/web-UI/roadmap-bridge and README-drift ideas below were filed as DL-1…DL-5 on
2026-06-23 per the resolved decision above; this list is the remaining overflow parking lot.)_

- **`/roadmap` editor on a repo-file-strategy project — a silent-divergence affordance (ux-flows lens, PM 2026-06-25 — marginal, parked).** This `dev-loop` project is `hub.docs:false` + has no `director` config, so the agents' north-star is the **repo file** `docs/STRATEGY.md`, not the hub `roadmap` doc. Yet the daemon `/roadmap` page offers an editable "Roadmap (empty) — saves a DRAFT" surface that writes the hub `roadmap` doc **no agent reads** for this config — an operator who edits it there could believe they're steering the loop while the real north-star (the repo file) stays untouched. No false claim is made (the page just says "Roadmap"), so it's a discoverability/expectation gap, not a bug. **Cheap fix when filed:** an informational banner on `/roadmap` when `hub.docs` is false / `strategyDoc` is a repo file (e.g. "this project's north-star is a repo file; this hub roadmap is not read by the agents"). Read-only daemon change, localhost-only. **Deliberately parked, not filed** — niche config + low value, and the Todo queue is Dev-bottlenecked; file if the queue drains or a non-operator adopter hits it. **UPDATE 2026-06-27: ✅ FILED as DL-83** (Improvement/pm/Low) — release gate MET (Todo drained to 2 Low items DL-81/DL-82 + Dev active on DL-79, flipping the Dev-bottleneck rationale); confirmed not built (`roadmapPage` renders no such banner), §17-clean; scoped to the `roadmapPage` banner + the daemon route threading the config boolean + a regression test.
- **Backend-choice-at-init — sequenced follow-ups to the DL-56 groom (operator 2026-06-25, design `docs/design/backend-choice-unification.md`).** Filed this milestone: DL-59 (U0 notifier), DL-60 (U1 init service bootstrap), DL-61 (U2 `.mcp.json` merge), DL-53-extended (the §17 prose). **U4 — ✅ VERIFIED DONE 2026-06-27 as DL-81** (filed when the Todo drained to 2; gate had been MET since DL-60 + DL-61 verified Done 2026-06-25; closes the DL-56 turnkey milestone end-to-end): an optional init "backend-doctor" reconcile on re-run (extend `hub/src/doctor.ts` to verify daemon-up / `.mcp.json` actor wiring / `/api/health` / the DL-42 hook present, reported in the Step-8 readiness checklist; read-only/idempotent, Low). Its dependency (DL-60 + DL-61) shipped 2026-06-25; banked until the Todo drained, then **filed as DL-81** scoped to the `hub/src/doctor.ts` extension + its test — init already runs doctor (DL-60) so its Step-8 checklist inherits the new lines with **no §17 SKILL edit**. **DEFERRED epic (operator decision — NOT a ticket until prioritized):** cross-store ticket **migration** (linear↔service). The blocker is real: hub ids are a global PK minted from prefix+seq (`db.ts:286-292`) and `ensureProject` hard-throws on a prefix clash (`seed.ts:46-47`), so an importer cannot preserve source ids as the PK — source ids must ride a separate `externalId`. The only cross-store seam today is the one-way hub→Linear `mirror` (a projection, not a bridge); Linear visibility without migrating = `service` + `mirror`. Its own epic (exporter/importer per direction + `externalId` carry + id-remap + a freeze→import→verify→cutover runbook) when the operator prioritizes it.
- **MCP↔daemon unification — sequenced follow-ups to DL-43 (thread 2, operator 2026-06-24).** _(Now
  formalized as the design doc's **P2–P5** phase plan — `docs/design/daemon-multicli-repositioning.md`;
  reconciled `8857c0a`.)_ Once
  DL-43 (the opt-in loopback **`POST /api/op/*`** for the core ticket tools, gated `hub.transport:"daemon"`) lands + is verified Done: **(2/n = P2)**
  an opt-in stdio-`server.ts` **thin-client** mode that proxies tool calls to the loopback daemon when
  configured — extract the shared tool-dispatch so both transports reuse it; the default
  stdio-owns-its-own-db path stays 100% working. *This* is what makes "agents act through one running
  service" real (the Vision's "daemon owns coordination"). **(3/n)** widen the loopback surface beyond
  ticket tools to `doc.*` / `topic.*` / `channel.*`. Each additive + default-off + localhost-only;
  file the next increment as the prior verifies (never one unscoped mega-ticket — Dev would block it).
  **UPDATE 2026-06-25: (2/n=P2) SHIPPED as DL-55 (verified Done). (3/n) docs+events (`list_events` + `doc.*`,
  `doc.publish` cooperatively operator-gated per folded-critique #85) SHIPPED as **DL-62 — verified Done this fire**
  (the shim now proxies 13/29 `server.ts` tools). The operator's "(4/n) bucket" (`topic.*`/`post.add` + `channel.*`
  + `mirror.*` + labels) is being delivered **family-by-family** — the DL-55/DL-62 "one coherent family per
  increment, never an unscoped mega-ticket Dev would block" discipline — because, unlike docs/tickets, the
  topic/channel/mirror write logic is **inline in `server.ts`** (no `topicstore`/`channelstore` yet), so each
  family first needs its own extract-to-shared-module step (the `docstore.ts` precedent). Sequenced: **(4/n)**
  discussion-board (`topic.*`+`post.add`, extract `topicstore.ts`) = **DL-64 (filed this fire)**; **(5/n)** `channel.*`;
  **(6/n)** `mirror.push/status` + `list_issue_labels`/`create_issue_label` + `get_project`. The full drop-in
  (through (6/n)) is the precondition for P3 (single-writer + the `server.ts`↔`agentops.ts` dispatch convergence).**
  **✅ COMPLETE (reconciled 2026-06-27):** **(5/n) = DL-67** and **(6/n) = DL-68** are both verified **Done** → the
  100% 29/29 `server.ts` drop-in shipped; **P3** (DL-69 dispatch-convergence + DL-70 daemon single-writer), **P4**
  (DL-71 npm package) and **P5** (DL-72 Codex 2nd-CLI) likewise shipped (v0.21.0, `4bb96af`). The entire
  MCP↔daemon-unification + portability arc is done — see the **P2** summary above and `Current state`. **Nothing in this
  bullet remains to file** (noted because a prior throttle mis-read the lagging `(5/n) channel.*` line as an unfiled
  candidate "ready to file"; per §8 dedupe-against-reality it was already DL-67/Done).
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
- **Web-UI fidelity polish (ux-flows lens, PM 2026-06-23).** **UPDATE 2026-06-23: filed as DL-16** (items a+b: render markdown ticket/comment bodies via the existing renderMarkdown + show created/updated timestamps), now that the milestone backlog drained. **UPDATE 2026-06-24: item (c) confirmed live + filed as DL-36** (ux-flows sweep at `dfa5f9b`: `/totally/bogus` → JSON 404 while `/ticket/<missing>` → HTML 404; serve the friendly HTML 404 for non-API paths, keep `/api/*` JSON). All three sub-items now filed. Lower-value read-view
  refinements found alongside DL-8, parked to keep the Dev-bottlenecked Todo signal-rich: (a)
  ticket/comment bodies render as **raw markdown** inside a `<pre>` block — a tiny inline
  markdown→HTML renderer (no native deps, hub doctrine) would match the "Linear-like" Vision; (b)
  the detail view omits **created/updated timestamps**; (c) an unknown **non-API** path returns
  JSON (`{"error":"not found"}`) instead of the friendly HTML 404 the ghost-ticket route already
  serves. File as the daemon backlog drains.
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
- **Loop-cost-governance — Phase 2 (sequenced after a cost-signal precursor; PM 2026-06-27, banked from the DL-73 groom).** The DL-73 intake's two cost-*quantifying* asks are **not buildable until the hub has a per-fire cost signal** (agents don't report token/$ spend to the SoR today): **(a)** a loop-level **token/$ budget ceiling** (the hard circuit-breaker complementing DL-76's no-progress detector), and **(b)** a **cost-per-accepted-change** metric + a cost column on `/activity` (complementing DL-79's accept-rate). The likely precursor is a **§17 [pm-proposal]** for the operator-owned launcher to emit per-fire cost into the hub (a new `events` kind), then a buildable hub cap + the cost surfacing. File the precursor proposal when the operator signals appetite, or when an adopter hits a real runaway-cost incident. **(c)** Surfacing DL-79's accept-rate in the **Reflect daily digest** is a Reflect SKILL change → a §17 [reflect-proposal], not a code ticket; fold into the next Reflect-curation pass rather than filing Dev work.
- **[❌ RETIRED 2026-06-28 — Director + §25 board removed; moot, see running log.]** **Web read-view for the discussion board + non-roadmap hub docs (ux-flows lens, PM 2026-06-27 — director-config-gated, banked).** The daemon web UI surfaces the roadmap (`/roadmap`) but **not** the deliberation that produces it: the hub's discussion board (`topic.*` / `post.add` / `topic.synthesize` / `topic.close` — the §25 plane the Director chairs) and non-roadmap hub docs (`kind:"strategy"`) have **no web read-view** (only the JSON `/api/docs`). An operator on a **director-configured** project can see the roadmap OUTPUT but not the topics / posts / decisions that drove it — an observe-and-steer gap for that persona. **Deliberately banked, not filed:** `dev-loop` itself has **no `director` config** (board OFF) and `hub.docs:false`, so a ticket here would be speculative, config-gated-off Dev work (§8 dedupe-against-reality — don't file a surface this instance never exercises). **File when** a `director`-configured project comes online (or an adopter asks): a read-only `/topics` (list → topic detail with posts + the closing decision) + `/docs/<kind>` view, reusing the `roadmapPage` / `renderMarkdown` precedent; localhost-only, no write path, §17-clean. Pairs with the parked "Multi-stakeholder roadmap auth" + "Reports + 点评 review in the web UI" observe/steer items.
- **Open-WIP aging on `/activity` — forward-looking sibling of DL-84's per-stage breakdown (data-analytics lens, PM 2026-06-27 — banked).** DL-84 surfaces where *completed* tickets spent their time (backward-looking medians); the complement is surfacing the *aging of currently-open* WIP — the oldest open ticket per active state (In Progress / In Review), flagging stale WIP: e.g. In Review > N days = an owner agent (PM/QA) isn't verifying; In Progress > N days = a possible orphan beyond Sweep's reclaim. Actionable *now* (the operator acts on the named stale ticket), vs DL-84's trend. Read-only over current tickets + their latest transition event; §17-clean. **Banked, not filed** — to avoid flooding the queue (DL-84 filed this fire) and because it lightly overlaps Sweep's lane (Sweep *acts* on orphaned In Progress; this *surfaces* aging — incl. In-Review verify-lag, which Sweep doesn't touch — to the operator). **File when** DL-84 lands or an operator asks. **UPDATE 2026-06-27: ✅ FILED as DL-89** (Improvement/pm/Low) — condition MET (DL-84 verified Done this milestone). Confirmed not built (`activityPage` is backward-looking only — medians over recently-Done; daemonviews.ts:461-540), §17-clean (read-only `openWipSection` over the events ledger, no new route/table), deduped vs DL-84/DL-79 and the full Done/Canceled history. Scoped to the new section + a regression test asserting age-from-latest-into-state-transition.
- **ux-flows overflow — banked nits from the `65e7ae7` web-UI + onboarding sweep (PM 2026-06-27).** Low-value or gated items found alongside DL-86/DL-87, parked to keep the queue signal-rich: **(a)** the web **"New ticket" form collects only title + type** (`daemonviews.ts:204-209`) — no description/priority field, so an operator-created ticket lands description-less (and renders an empty `<div class="doc">` under "Description", `daemonviews.ts:250`). Debatable whether this is a gap or deliberate quick-capture minimalism (DL-29 shipped it lean; PM grooms W3 intake anyway) — **file a "richer create form + (no description) placeholder" Improvement only if an operator actually uses web-create and hits the thinness.** **(b)** RUNNING.md §4a teaches the manual `service` setup before noting `init` automates it (doc-ordering polish; fold into the next docs reconcile). **(c)** init's readiness verdict (`skills/init/SKILL.md`) could point a `service` operator at their board URL / "Observe the loop" — but that's a **§17 SKILL edit** (`[pm-proposal]`, operator-applied), not a Dev ticket; fold into a future init-prose proposal. **(d) considered + REJECTED (do NOT re-file):** a persistent "read-only" banner on the board (read-only IS the default mode → chrome-noise, unlike `/roadmap` where write is a headline feature) and a throughput "— no data" empty-state (a count's `0` is a real value, unlike acceptance-rate's undefined `0/0`). **(e) QA-lane (noted for QA, not a PM Feature):** `seed --help` is parsed as the project key → seeds a junk-named project instead of printing usage (`hub/src/seed.ts` CLI dispatch) — a minor footgun on an internal/init-driven command. **UPDATE 2026-06-27: ✅ QA picked it up — filed as DL-88 (Bug, qa-owned). Cross-lane hand-off worked; no PM action.**
- **Daemon serves stale VIEW code until restarted — observe-surface lag after a Dev ship (ux-flows/ops lens, PM 2026-06-27 — banked).** The long-lived daemon (DL-41) loads `daemonviews.ts` + routes at boot, and `daemon ensure` is idempotent (never restarts a live process), so after a Dev commit that changes the web-UI rendering (e.g. DL-84's new `/activity` section, or DL-83's banner) the running daemon keeps serving the OLD view code until manually `down`+`up`'d — the operator sees fresh DATA (read per-request from the SoR) with **stale RENDERING**. Standard server behavior, but a real papercut for THIS dogfooding loop where Dev ships ~every 20min and the daemon IS the operator's observe surface (a new feature looks un-shipped until restart). **Options when filed:** a `dev-loop daemon restart` subcommand + a post-ship hint; OR a lightweight **served-commit-vs-HEAD banner** on the web UI so staleness is *visible* (the DL-83 surface-don't-prevent pattern); OR file-watch auto-reload (heavier — touches the lifecycle + the stateless contract). **Banked, not filed** — expected daemon behavior, low-severity (data is correct, only new view code lags); file if the operator finds the lag misleading or asks.
- **`dev-loop tickets` richer filters — the follow-up DL-90 explicitly deferred (competitive-parity lens, PM 2026-06-27 — banked).** DL-90 shipped `dev-loop tickets` v1 with `--state` + free-text `--q` and stated "richer filters are a follow-up." The `gh issue list` / linear-cli parity extras are `--type` (Feature/Bug/Improvement), `--owner` (pm/qa), and `--label` (arbitrary label membership) — each a one-line in-process `rows.filter` over the already-loaded board (no new query, read-only, §17-clean). **Banked, not filed** — marginal at the current ~90-ticket scale where `--q` + `--state` cover most needs, and the relations gap (DL-92) is the stronger DL-90 follow-up this fire. **File when** the board grows materially, an operator asks, or the Todo queue empties and this is the best remaining candidate. **UPDATE 2026-06-27: ✅ FILED as DL-93** (Improvement/pm/Low) — trigger MET (Todo drained to 1: DL-92, with DL-89 picked up → In Progress). Confirmed-not-built + deduped: `cli-tickets.ts:30-45` parses only `--all`/`--state`/`--q` and silently swallows an unknown flag's value as positional `--q` (DL-93 fixes that footgun too); §17-clean (read-only CLI, no new query/route), relatedTo DL-90/DL-92, regression test extends the existing `test/cli-tickets.ts`.

- **2026-06-28 — REMOVED the Director agent + the §25 discussion board (operator decision).** The Director was enabled on **zero** projects (including this dogfood — `dev-loop` has no `director` config; the north-star is this repo-file `strategyDoc`), off by default, and an audit found its headline "multi-agent deliberation" was single-model role-play on the default roadmap path, while its one genuinely-unique mechanism (the async board) was unused and its other "unique" value (operator-publish gate; two-way channel) duplicated existing surfaces (PM's strategy draft uses the same `docPublish` gate; the §9 notify webhook already pushes to Lark/Slack). **Direction now flows entirely through PM** — the no-`director` default the system already documented: the operator files a `Todo` to PM (§9a W3 intake, **widened** to cover **research/direction** asks → PM researches and updates the docs, not only grooms Dev children), and a genuinely human-only call is parked **`Human-Blocked`** (§9) and auto-pinged out-of-band (on `service` the **daemon** reminds on the state; on `linear`/`local` PM emits the §9 `notify` once). **Deleted:** the `director-agent` SKILL, the `topic.*` board subsystem (hub `topicstore.ts` + the `topics`/`posts` tables + `board.ts` test), and all `director` roster/seed/install/config-schema/plugin-manifest/doc wiring; the sibling skills' dead board-participation blocks; conventions §25 collapsed to a tombstone. **Kept:** the `channel.*` IM module — it's the transport behind the §9 human-park notify; its two-way *inbound* half (`channel.poll`/`ack`) is now agent-unused (a fiddly follow-up to trim, not worth disturbing the notify path). **Retired as obsolete:** the board-gated Candidate ideas (web read-view for the discussion board; multi-stakeholder roadmap auth) — there is no board to surface.
