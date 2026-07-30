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
  service backend + `dev-loop` CLI, **1.2.0 line** (see `CHANGELOG.md`), with the full npm test
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

- **⚠️ Nothing has landed since v1.10.0 — the loop can build but cannot ship (2026-07-30).** The
  repo's required merge checks (`Test (Node 23.6.0)` / `Test (Node 24)`) have been RED on `main`
  since `7f18a62` (1.9.0, 2026-07-24): the full-repo CRAP ratchet fails on `stripGo`
  (`hub/src/quality.ts:267`, CRAP 113.8 > the 90 threshold). `autoMerge` therefore cannot fire for
  any `dev-loop/*` PR. The first PR the loop itself produced (#27) passes typecheck and its own
  tests on both Node lanes and is still unmergeable. Tracked as **LOOP-22** (P1, Todo).

- **The health surfaces do not model landing at all (2026-07-30).** `doctor` prints `DOCTOR_OK` and
  `metrics` prints `3 shipped, accept 75%` in exactly the state above: `throughput` counts board
  `In Review → Done` transitions (a verification), and no hub code reads the git forge for any repo,
  including ones configured `landing:"pr"` + `autoMerge:true`. So "shipped" currently means
  "verified", and a six-day landing stall is invisible to every operator-facing read. Filed as
  **LOOP-27**. Related: 7 of 21 fires in the last 7d left no report file at all (junior-dev 4,
  sweep 3) with nothing detecting the gap — **LOOP-28**.

- **The observability layer measures the board with fields the board does not route on
  (2026-07-30, `data-analytics` lens).** Three operator-facing reads each answer a board question
  from a different column than the router uses, so all three can be wrong while every one of them
  looks healthy:
  - **Ownership.** `ownerLiveness` (`hub/src/metrics.ts:140`, rendered as doctor **W16** and quoted
    in the Sweep digest) resolves "who owns this ticket" from **labels**; `opQueue`
    (`hub/src/agentops.ts:203`) serves dev work by **assignee**. Measured on this board:
    junior-dev owns **12** open tickets by assignee and **9** by label. Worse than the undercount,
    the `if (!mine.length) continue` guard means a handle whose open work is *entirely*
    assignee-only emits **no finding at all** — the precise stranding W16 was built for (MP-156).
    Filed as **LOOP-30** (High).
  - **Blocked.** `dev-loop metrics` reports `blockedNow: 4` (the `blocked` **label**) while
    `/activity` renders `0 blocked now` (the `Human-Blocked` **state**, `views/activity.ts:207`) —
    two contradictory figures under one name, on the same db, at the same moment. The dashboard's
    blind spot is the serious half: a Dev bail (`blocked`+`needs-pm`, never escalated to the
    operator) renders as a clean board. Filed as **LOOP-31**, sequenced behind **LOOP-26**, which
    owns the taxonomy itself.
  - Together with LOOP-27 (landing) and LOOP-28 (reports), this is one pattern rather than four
    bugs: **every health surface reports on a proxy, and no surface reports on the thing itself.**

- **`ticket create` cannot comply with §5a (2026-07-30).** The CLI has no `--state`, so every
  create lands in **`Todo`** — the commitment queue — while §5a requires `Backlog`. Hit twice this
  fire (LOOP-30, LOOP-31 both needed a corrective `update --state Backlog`), and independently by
  QA moments earlier (`qa moved LOOP-29 Todo → Backlog`). It also walks straight through
  `intake.todoDepthCap`: two creates took junior from a deliberate 10/10 to 12/10 with no surface
  reporting an over-cap board. Already owned by **LOOP-11** (Todo); evidence recorded there.

- **✅ THE LANDING WEDGE CLEARED (2026-07-30, `cec3598` / PR #32).** The CRAP-ratchet block that
  held the loop's entire output for three PM fires is gone: **LOOP-22** extracted four helpers out
  of `stripGo` (`hub/src/quality.ts`), taking it from CRAP 113.8 to under the 90 gate, and merged.
  The PR pile flushed **five → three** in the same hour (#27/#30/#31 merged; #28/#29/#33 remain,
  now failing on a stale pre-`cec3598` base rather than on the ratchet). Two honest qualifiers:
  QA verify-failed the shipped increment on coverage — the claimed nested/adjacent regression test
  was not in the diff — and filed **LOOP-33** (senior `direct-code`, §3 escalation) rather than
  accepting it; and CI fragility has simply moved down the stack to **LOOP-32**'s wall-clock race
  in `hub/test/run-agents-live.ts` §6, promoted to `Todo` this fire. The wedge was never a Dev
  productivity problem — junior shipped throughout — and the board proved that the moment merge
  worked again.

- **The two invariants the strategy doc calls "hard" are the two with the least machinery behind
  them (trust-safety lens, 2026-07-30).** `Goals` names the §17 firewall and §21b's sensitive
  routing as hard invariants of the autonomous model. For **documents** §17 is genuinely
  structural — `docstore.ts` / `db.ts:125` give doc tools no filesystem path at all, so a SKILL
  file is unreachable by construction, which is the right shape. Outside that one seam both rules
  are prose: `sensitive` occurs in `hub/src/` only as a seeded label (`seed.ts:44`) and a board
  colour (`views/board.ts:35`) — `opQueue`, `save_issue`, `doctor`, and the Sweep digest all
  ignore it — and no check anywhere looks at whether a commit touched `skills/**` or
  `conventions.md`. Filed as **LOOP-34** (senior `Mode: design`) and **LOOP-35** (junior). Neither
  has been violated yet; both are tripwires, filed while they are still cheap.

- **✅ The landing stall is over — supersedes the "⚠️ Nothing has landed since v1.10.0" bullet
  above (2026-07-30, consistency lens).** Four PRs merged to `origin/main` in one window:
  `cec3598` (#32, LOOP-22 — the CRAP ratchet unblocked), `baa756f` (#30, LOOP-20 — `dev-loop queue`
  routable at the top level), `a5c1533` (#31, LOOP-25 — push-guard scans the full commit message),
  `6b4b1e5` (#34, LOOP-21 — `comment add --body-file -` reads stdin). `origin/main` moved
  `3cfc250 → 6b4b1e5`; QA verified LOOP-20/21/25 to `Done` during this fire. Three of the four
  fixed CLI gotchas the PM state file had been carrying as standing workarounds — the loop is now
  visibly repairing its own agent-facing surface. **The installed CLI still reports `1.10.0`**, so
  these fixes reach an operator only at the next release cut.

- **But the strategy doc itself does not land (2026-07-30, consistency lens).** PM writes
  `docs/STRATEGY.md` by committing to the local `main`; this repo is configured
  `landing:"pr"` + `autoMerge:true`, and every dev worktree is branched off
  `origin/<defaultBranch>`. So PM's six doc commits (`b278db8`…`bfb9f47`, **+385/−45** lines) and
  the whole `docs/strategy-archive/2026-07.md` rollup exist **only in the doc-home checkout**.
  Measured this fire: PM reads a **60,523**-byte strategy doc while the live `LOOP-32` dev worktree
  reads a **41,004**-byte one — the dev tiers cannot see today's `Decisions` log, the re-worked
  `Candidate ideas`, or the `Current state` re-sync. The branches have **diverged 4 ↔ 6**, growing
  one commit per PM fire, and the reflexive operator recovery (`git reset --hard origin/main`)
  would discard all of it silently. Filed as **LOOP-36** (senior `Mode: design` — choosing the
  landing path is a real decision, and the same gap applies to senior-dev's `docs/design/*.md`).

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
- **(pm, 2026-07-30, fire 2) `strategy-gaps` lens — the north star had not noticed where the
  product's center of gravity moved.** The board was quiet (nothing `In Review`, nothing
  `blocked`/`needs-pm`, the Backlog drained to the dependency-held LOOP-4), so the whole fire went
  to the lens.
  - **The finding: four consecutive releases are absent from `Goals`.** 1.7.0→1.10.0 went almost
    entirely into `dev-loop quality`, yet the strings `quality` / `CRAP` / `mutation` appear
    **nowhere** in `Vision`, `Goals`, `Non-goals` or `Current state` — the doc still describes
    dev-loop as exactly one thing, a coordination daemon with interchangeable CLI clients. The
    1.10.0 reusable CI workflow ("adopt in three lines") implies a second audience the doc does not
    admit exists: a repo with no daemon, no agents and no board.
  - **Proposed, not edited.** `Goals` is a §20 D4 DIRECTION section, so PM opened **LOOP-18** on
    itself per the investigation protocol: findings + a mechanically generated unified diff (one
    12-line insert adding the gauntlet as a fifth supporting goal, with an explicit "gate and
    report, not a linter/formatter/refactoring engine" boundary), parked `In Review` assigned to the
    operator, with two alternatives spelled out (promote to a first-class goal / reject it as a
    private ship-gate detail). **PM has not committed that diff, and continues to treat the quality
    line as out-of-mandate for Job C filings until the operator rules.**
  - **`Current state` re-synced 1.2.0 → v1.10.0** — the progress half of the same gap, which is
    PM's own lane per §20, closing what the previous fire flagged but left.
  - **Filed 2, both held in `Backlog`:** **LOOP-16** (`--detect` build-fact gaps — the `:350` emit
    guard silently discards detected `test`/`quality`, and the `package.json` read is
    repo-root-only) and **LOOP-17** (doctor cannot nudge a repo with **no** `build` block at all,
    because the existing `doctor.ts:208` nudge requires a test gate to fire).
  - **Two sequencing calls, both deliberate.** LOOP-16 sits behind a `Blocked-by: LOOP-5` edge —
    both tickets edit `detectRepoFacts` in one file, and two concurrent junior fires in one function
    is a collision, not throughput. LOOP-17 is held even though junior depth is 6/10 and the §5a
    rule would permit promoting it: the junior queue already carries an unstarted P1 (LOOP-6) and
    three P2s, and 6 of 7 open Todo items are junior-tier, so Dev is the pace setter and the cap is
    a ceiling rather than a target.
  - **Dogfood gap → operator, not a ticket** (PM cannot write `dev-loop.json`, and a Dev ticket
    cannot either): this workspace has **no `build` block** for its own repo, so the loop's own
    Step-5 gates are entirely unconfigured and the quality ratchet it ships (`hub/package.json` →
    `"quality": "node src/quality.ts --threshold 90 --top 15"`) is wired to nothing. Root cause is
    exactly LOOP-16(b) — `--detect` reads the repo ROOT, and this repo's package is
    `hub/package.json`. Immediate fix, if wanted:
    `dev-loop team set repos.dev-loop.build.quality "cd hub && npm run quality"` (likewise
    `typecheck` / `build` / `test`).

- **(pm, 2026-07-30, fire 3) Both design gates PASSED, one increment sent back, and the loop's
  landing path found blocked.** The `ux-flows` lens ran; HEAD had not moved on product code (the
  only commit since the last review was PM's own doc commit), so this fire was Job-A-heavy by
  design.
  - **LOOP-2 (metering core) — design gate PASS**, children LOOP-12/13/14/15 promoted, parent
    `Done`. **Deliberately NOT parked for §21a big-module operator sign-off**, and the reasoning is
    the precedent worth keeping: cross-cutting scope alone does not make a design "big-module" —
    it is additive-only (every field optional), needs no schema migration, touches no
    auth/money/PII/secret surface, and carries an explicit best-effort/non-fatal posture. The one
    property that *would* have forced the park (an irreversible or migrating change) is a named
    non-goal in the design itself. Parking it would have stalled the whole cost-governance line
    behind a human for no safety gain.
  - **LOOP-10 (infra-kill ticket release) — design gate PASS**, child LOOP-19 promoted, parent
    `Done`. The design's sharpest point is now precedent: the runner release **preserves the
    assignee**, because on `service` the split-dev pick filter IS the assignee — Sweep's generic
    unassign-on-reset would make a released ticket invisible to BOTH dev queues.
  - **📌 Mechanism discovered, and it changes how PM promotes design children: a `Blocked-by:`
    marker comment does NOT gate anything.** The dev queue filters on the **`blocked` LABEL**
    (`hub/src/agentops.ts:206,218`); `Blocked-by:` is convention consumed by humans, PM and Sweep.
    So a staged child promoted `Backlog → Todo` on nothing but its marker comment is served to
    junior-dev as pickable work immediately, out of order. **Rule going forward:** when the §21a
    gate promotes children, any child with an unmet dependency gets the `blocked` label too — that
    is what actually implements the senior's stated sequencing — and PM drops the label as the
    blockers land (§9c). Applied to LOOP-13/14/15/19 this fire.
  - **⚠️ A false-unpark trap, caught and fixed — worth remembering.** LOOP-19 carried
    `Blocked-by: LOOP-7`. LOOP-7 failed verify this fire and became `Canceled` — and §9c unparks a
    ticket once **every** blocker edge is `Done`/`Canceled`. A Canceled blocker reads as
    *satisfied*, so the edge would have released LOOP-19 while its real prerequisite (the
    process-group kill) had not landed at all. **Whenever a verify-fail Cancels a ticket, re-point
    every inbound `Blocked-by:` edge to the follow-up in the same fire.** Re-pointed to LOOP-23.
  - **LOOP-7 (process-group kill + retry-loop detection) — verify FAIL, routed UP to senior-dev as
    LOOP-23 (`Mode: direct-code`, §3).** ACs 1–4 (the process-group half) are genuinely met and
    PR #27 is explicitly kept as the base. AC 5 is not: `seenLines` is capped at 200 entries and
    **never evicts**, so after the first ~200 distinct lines every line fails the `has()` check,
    counts as new content, and the retry-loop watchdog can never trip. A real fire saturates that
    set in seconds, so the detector is inert in exactly the 429-retry-loop scenario the ticket was
    written to fix. Its live test passes only because the stub repeats from the very first byte —
    **the test proved the mechanism, not the requirement.** Worth generalizing: a bounded cache
    that is described as "rolling" but only freezes is a shape to look for.
  - **CI red on `main` — the whole board is undeliverable until it clears.** Found independently
    during the LOOP-7 verify; senior-dev filed it concurrently as **LOOP-22** while this fire was
    running. LOOP-22 is the better ticket (it proves `stripGo` is the *only* function over the
    ratchet, next-worst 86.7, so the fix is bounded to one function) — PM's duplicate LOOP-24 was
    `Canceled` into it, LOOP-22 groomed to junior-dev and promoted P1 ahead of everything.
    Reinforced its third AC with a route: **do not raise the threshold to go green** — the 90
    ratchet is a deliberate commitment (`2e18244` tightened 160 → 90) and relaxing it to unblock a
    merge would quietly retire the product's own headline gate; if the threshold must move, that
    is a direction call routed to PM, not an edit.
  - **Process note carried from LOOP-22, deliberately NOT filed as Dev work:** the *Release npm
    package* workflow does not depend on *Test*, which is why 1.9.0 and 1.10.0 both shipped over a
    red gate and the breach went unnoticed for ~6 days. That is CI topology / process, for the
    operator and reflect/architect — not a product ticket.
  - **PM also observed a second, distinct failure** on `main` (run 30149735763): the `Test` step
    itself fails on **Node 23.6.0 only** — it does not reproduce on PR #27's branch, so it is
    already fixed or intermittent. Recorded on LOOP-22, since a green quality gate alone will not
    turn that check green if it is still live.
  - **Filed on the `ux-flows` lens: LOOP-26 (Backlog).** `blockedNow` (`hub/src/metrics.ts:104`)
    counts the `blocked` label without distinguishing *parked-needs-attention* from
    *sequenced-behind-a-dependency*. This fire proved the cost: labelling four design children for
    sequencing drove the operator's board KPI to `blockedNow: 4` when **none** of them needs a
    human. The metric reads worst exactly when the loop is doing dependency management well.
    Scoped to split the count from data that already exists (`Blocked-by:` edges + `needs-*`), with
    an explicit instruction **not** to add a label — the taxonomy lives behind the §17 boundary.
  - **Still with the operator: LOOP-18** (the `Goals`/quality-gauntlet direction proposal) has had
    no verdict. `Goals` stays untouched; the diff is applied and committed on approval.
  - **Housekeeping due next fire:** this doc is ~53KB, well past the §20 ~20KB rollup threshold.
    The 2026-07 Decisions tail should be rolled to `docs/strategy-archive/2026-07.md` the way
    2026-06 already was. Deliberately deferred rather than done half-way at the end of a long fire.

- **(pm, 2026-07-30) `conversion-retention` lens — the loop's health surfaces cannot see its own
  ship pipeline; plus the doc rollup, done where the bloat actually was.**
  - **Filed LOOP-27 (Feature, High, senior `Mode: design`) — landing observability.** The finding:
    at this fire `dev-loop doctor` printed `DOCTOR_OK` + `NEXT: dev-loop run` and `dev-loop metrics`
    printed `21 fires, 100% success · 3 shipped, accept 75%` — while **three loop PRs (#27/#28/#29)
    sat unmergeable on a base branch whose required checks have been red since `7f18a62` (1.9.0,
    2026-07-24), six days.** Two concrete causes, both verified in code: `boardMetrics`
    (`hub/src/metrics.ts:96-101`) increments `throughput` on the `issue.transition` `to === "Done"`
    event, so **"shipped" means "a PM/QA verify passed", not "the branch landed"**; and
    `grep -rn "gh pr\|pull_request\|prNumber" hub/src/*.ts` returns **zero hits** — the hub has no
    forge concept at all, even for repos configured `landing:"pr"` + `autoMerge:true`. This is the
    retention failure mode for an autonomous loop: every dial reads green while the output goes
    nowhere, and the operator finds out by accident. Routed senior/`Mode: design` because the hard
    parts are posture calls, not code — whether offline-and-fast `doctor` may make a network call at
    all, what the degradation contract is with no `gh`/no auth/no network/a non-GitHub remote, and
    which signal is worth trusting. Explicitly **detect-and-report only**: it never merges, re-runs
    or mutates a PR. Related-not-duplicate to LOOP-22 (this instance's *fix*), LOOP-5 (one *cause*
    class), LOOP-26 (a different metric).
  - **Filed LOOP-28 (Improvement, Medium, junior) — an agent that fires but writes no report.**
    `.dev-loop/team/fires.jsonl` records **junior-dev 4 fires and sweep 3** in 7d; the reports tree
    holds files for `pm-agent`, `qa-agent` and `senior-dev-agent` **only**. So 7 of 21 fires left no
    durable trail — including the tier doing most of the implementation — against a §22 contract
    that says every agent leaves one, and a README that sells the trail as a core value prop.
    Nothing notices. **The §17 line matters here:** whether an agent *should* have written a report
    is SKILL behavior and not PM's to fix; what is squarely a product gap is that the loop cannot
    tell the operator its own record has holes. Scoped as the exact mirror of the existing **W16
    owner-liveness** check (`hub/src/metrics.ts:140-163` → `hub/src/doctor.ts:276-296`) over the same
    ledger — deterministic, read-only, no new data source.
  - **§20 rollup — done on `Candidate ideas`, and deliberately NOT on the Decisions log.** The prior
    fire banked "roll the 2026-07 Decisions tail." Measuring first changed the answer: `Candidate
    ideas` was **23.7 KB — the doc's largest section**, bigger than the 16.5 KB Decisions log. Ten
    entries there were already `✅ FILED` / `VERIFIED DONE` / `COMPLETE` / `RETIRED` DL-era
    provenance, i.e. not candidates at all; they rolled to
    `docs/strategy-archive/2026-07.md` (**59.5 KB → 43.5 KB**, nothing lost). The Decisions log
    **stays** because §20 rolls *completed/superseded* decisions, not merely *dated* ones, and its
    2026-07 entries are live standing direction — the operator's Linear-parity "**do NOT re-propose**
    these on the competitive-parity lens" list and the DL-2 inline-script amendment are guard rails a
    date-based roll would have silently deleted. **Next fire: do not re-attempt the Decisions roll as
    a mechanical chore.** One live remainder was lifted out of an archived bullet rather than buried
    with it: the deferred cross-store ticket-migration (linear↔service) epic.
  - **Tier encoding, settled by reading the code — do not "fix" it.** `opQueue`
    (`hub/src/agentops.ts:199-210`) filters the dev queues on **`assignee`**, never on a
    `senior-dev`/`junior-dev` **label**. LOOP-16/LOOP-17/LOOP-4 carry the assignee without the label
    and are fully routable; the label is decorative on the `service` backend. (The `blocked` **label**
    *is* load-bearing in the same function — that asymmetry is the trap.)
  - **Promotion pace (Job B2).** Promoted **LOOP-16** (High, junior) and **LOOP-27** (senior). Junior
    unblocked-Todo depth 7 → 8 of 10: held LOOP-17 (sequenced behind LOOP-16's `detectRepoFacts`
    change), LOOP-26 (Medium behind a deep queue) and LOOP-4 (correctly parked behind the LOOP-12…15
    metering children). Senior depth was **0** — the expensive tier was idle with LOOP-23 its only
    live work — so LOOP-27 went straight to `Todo` rather than waiting a full cycle in `Backlog`.
  - **Still with the operator: LOOP-18** — no verdict yet on the `Goals`/quality-gauntlet direction
    proposal. `Goals` remains untouched and the quality line stays out-of-mandate for Job C filings;
    neither ticket filed this fire depends on that ruling.

- **(pm, 2026-07-30) `data-analytics` lens — the health surfaces are auditing the wrong columns,
  and one blocker edge was about to lie.** Fourth lens at the unchanged product HEAD (`3cfc250` /
  v1.10.0; the three commits on top are PM doc-only edits and correctly did **not** reset the lens
  rotation). No foreign edit to this doc since last fire.
  - **The finding, and why it is one finding.** LOOP-30 (ownership read from labels, routing done
    by assignee) and LOOP-31 (`blockedNow` label-based in the CLI, `Human-Blocked` state-based on
    `/activity`) are the same mistake in two places, and LOOP-27/LOOP-28 are it in two more:
    **the loop measures proxies for the thing it wants to know.** Verified against the live db
    rather than inferred — the 12-vs-9 ownership split and the 4-vs-0 blocked contradiction are
    both reproducible today. LOOP-31 is deliberately sequenced behind LOOP-26 (`Blocked-by:`)
    because LOOP-26 defines the taxonomy this one applies; filing them merged would have hidden
    that ordering. Neither is a `Bug`: both surfaces behave exactly as their own header comments
    document — the documented *assumption* is what broke.
  - **A false unpark caught before it fired (§9c).** LOOP-4's blocker edge read `Blocked-by:
    LOOP-2`, and **LOOP-2 is now `Done`** — so the next §9c pass would have unparked LOOP-4 and
    handed senior-dev three cost dashboards over an empty column, the exact outcome the hold
    existed to prevent. A design parent going `Done` means the plan is agreed, not that the data
    exists. Edge retired and re-pointed at the implementation children (LOOP-12…15). Second
    instance of this shape after LOOP-19 (`Canceled` LOOP-7 would have counted as satisfied):
    **a blocker edge must name the ticket that produces the artifact, never its design parent.**
  - **Promotion pace (Job B2).** Promoted four in §5 pick order — LOOP-21 and LOOP-29 (both
    `Bug`+`edge-case`, rank 2, oldest first) ahead of LOOP-17 and LOOP-26 (rank 5). Junior
    unblocked-Todo **6 → 10 of 10, now at cap**; senior stays 1. Promoting into a landing-blocked
    board was deliberate: the wedge is on **merge**, not on work — junior is demonstrably
    productive (PRs #30/#31 opened this hour) and every finished PR flushes the moment LOOP-22
    goes green. Tier labels were re-passed on LOOP-17/21/29 for consistency, which is a workaround
    for LOOP-30, not a fix.
  - **Landing: still red, and the pile is growing.** Five `dev-loop/*` PRs now open and
    unmergeable (#27/#28/#29/#30/#31), up from three last fire. Every one fails *only* the CRAP
    ratchet on `stripGo` (113.8 > 90); their own tests pass on both Node lanes. **LOOP-22 remains
    the single gate on the entire loop's output.**

- **(pm, 2026-07-30) `trust-safety` lens — the loop's two named hard invariants are enforced by
  prose, and the landing wedge cleared mid-fire.** Fifth lens at the same product line; product
  HEAD moved `3cfc250` → **`cec3598`** during this fire (LOOP-22 merging), the first product
  movement in five fires. No foreign edit to this doc since last fire.
  - **The finding, and why the two tickets are one shape.** `Goals` lists the §17 firewall and
    §21b's *"SENSITIVE ⇒ senior-dev, **ALWAYS**"* as hard invariants — and §21b is explicit that
    for sensitive work *"the protection is the mandatory design step + the owner's independent
    verification, not a pause,"* which is the entire safety argument for letting an unattended loop
    ship auth, money, PII, and migration code. **Neither invariant has an enforcement point.**
    `sensitive` exists in `hub/src/` only at `seed.ts:44` (seeded into the taxonomy) and
    `views/board.ts:35` (painted red); `opQueue` (`agentops.ts:205`) filters the dev slice on
    `assignee` and `blocked` and consults nothing else, so a `sensitive` ticket assigned junior is
    served to junior in normal pick order and **no surface — board, `queue`, `doctor`, digest —
    reports that it happened.** The §17 file surface is the same story: `push-guard` never looks at
    a changed path, Sweep's D4 audit covers only this doc's direction sections, and
    `cli-cheatsheet.ts` byte-checks that the *generated* block is fresh, not that the prose around
    it is untouched. Filed as **LOOP-34** (senior `Mode: design` — choosing the enforcement point
    is a real decision across `ticketwrite`/`agentops`/`doctor`, and the wrong choice is worse than
    the gap) and **LOOP-35** (junior — extend `push-guard`, which already walks the pre-push commit
    list under `--strict`).
  - **What makes it more than theory.** `gen-cheatsheets.ts:286` *writes into* all ten
    `skills/*/SKILL.md` files by design, and two junior tickets in flight (LOOP-11, LOOP-20) both
    require running it. The only thing separating that legitimate regeneration from an
    out-of-bounds prose edit is a sentence LOOP-11's author hand-wrote into the ticket body
    (*"Out of scope: … every `skills/**/SKILL.md` prose section (§17)"*). **The invariant is
    currently enforced by asking the agent nicely, per ticket.** Checked before filing: all 40 most
    recent commits touching `skills/` or `conventions.md` are operator-authored, and no ticket on
    this board carries `sensitive` — both rules hold today. Filed as tripwires while cheap, not as
    incidents.
  - **The docs seam is the counter-example worth keeping.** `docstore.ts:6` / `db.ts:125` make §17
    structural for documents by giving doc tools no filesystem path at all. That is the pattern the
    other two gates should be judged against: *make the violation unrepresentable*, not detected.
  - **Job B — two blocker edges retired, no unpark.** LOOP-4 still carried a live `Blocked-by:
    LOOP-2` (Done) alongside last fire's corrected edges — the re-point added markers but never
    retired the old one, and §9c only clears an edge on an explicit `Unblocked-by:`. LOOP-19
    carried `Blocked-by: LOOP-7` (Canceled). Both retired; both tickets stay parked on their live
    edges (LOOP-12…15 / LOOP-12 + LOOP-23). Third fire running with this shape: **correcting an
    edge means retiring the old one, not just adding the right one.**
  - **Job B2 — one promotion, and a ticket that was invisible to the entire Dev tier.** LOOP-32
    (QA's flaky-CI filing) had **no dev-tier marker at all** — `assignee=null`, so `opQueue` served
    it to neither tier and it would have sat until Sweep's slow repair. Tiered junior and promoted
    into the single free slot **ahead of the strict rank-5 FIFO** (LOOP-28/LOOP-30 keep their
    position): with the ratchet gone, that wall-clock race is the remaining source of red CI on the
    landing path, and §5's own tiebreak is *defects beat features*. Junior unblocked-`Todo`
    **10/10, at cap**; senior 1 → 2 (QA's LOOP-33 landed there mid-fire). LOOP-34/LOOP-35 filed to
    `Backlog` for the next fire's B2, per §5a.
  - **Still with the operator: LOOP-18**, fourth fire with no verdict. `Goals` stays untouched and
    the quality-gauntlet line stays out-of-mandate for Job C filings; neither ticket filed this
    fire depends on that ruling.

- **(pm, 2026-07-30) Consistency lens — the loop's own artifacts disagree about where they live,
  and the strategy doc is the worst case.** Product moved for real this fire (`3cfc250 → 6b4b1e5`,
  four merges), so the swept-lens list reset and `consistency` ran first. Both findings are the
  same shape: **a contract stated in prose, with two or three implementations of it on disk.**
  - **The doc-landing gap (LOOP-36) is the sequencing call of the fire.** §20 D4 says PM lands a
    repo-file strategy doc *by committing*; §12b says nothing reaches `defaultBranch` except
    through a PR, and §7 branches every dev worktree off `origin/<defaultBranch>`. Both rules are
    individually right; together they mean **PM is the only writer in the workspace with no
    landing path at all**. This is not a projection — the 60,523 vs 41,004-byte split between PM's
    checkout and the `LOOP-32` worktree is on disk right now (recorded in `Current state`). Routed
    **senior `Mode: design`** rather than "just push": the four candidate fixes (PM pushes
    doc-only / PM opens a doc PR / move to the hub `doc` kind / detect-and-report) have genuinely
    different blast radii, and the cheapest one makes PM the single actor that bypasses this
    repo's stated human gate. The design must also rule on senior-dev's `docs/design/*.md`, which
    is autonomously committed through the identical gap, and on recovering the existing
    divergence without a destructive reset.
  - **Worktrees under two roots (LOOP-37), neither the documented one.** `wsWorktree()`
    (`workspace.ts:74`) builds `<ws>/.dev-loop/wt/<ticket>/<ref>` and four live worktrees sit
    there; three more sit at `<ws>/worktrees/<ticket>`, a shape that appears **nowhere** in
    `hub/src/`; conventions §7 documents a **third** shape again. The cause is the same as the
    LOOP-20 class: `wsWorktree()` is correct but **not reachable from the CLI surface**, so an
    agent implementing §7 hand-builds a path and three fires built three. Consequence already on
    disk: **LOOP-7 is `Canceled` and its worktree + branch are still live** — land-time cleanup
    never fires for a ticket that never lands, and `prune` only drops entries whose directory is
    already gone. Routed junior; the reaper must enumerate from `git worktree list` rather than
    from a computed root, or it inherits the blind spot it is fixing.
  - **The §17 boundary bit twice, and both tickets say so in-body.** LOOP-36's real fix may imply
    a §20 D4 prose change and LOOP-37's certainly implies a §7 one — neither of which an agent may
    make. Both carry an explicit `Out of scope (§17)` section routing the prose delta to the
    operator as a proposal. This is the third fire in a row where the correct code change sits
    next to a governing-prose change the loop cannot apply; **LOOP-34/LOOP-35 exist because that
    boundary is enforced by prose too.**
  - **Job A / Job B — nothing to do, verified rather than assumed.** LOOP-18 is now on its
    **fifth** fire with no operator verdict (still correctly parked `In Review`/`investigation`,
    not re-commented). No `needs-pm` intake, no team (`_team`) intake. Every §9c edge re-resolved
    from its markers rather than from the state file: LOOP-4 (LOOP-12/13/14/15), LOOP-13/14/15
    (LOOP-12), LOOP-19 (LOOP-12 + LOOP-23), LOOP-31 (LOOP-26) — **every blocker still open, so
    zero unparks**, which is the correct outcome and not a stall.
  - **Job B2 — promoted strictly by priority within rank, no exception this time.** Junior had one
    free slot and took **LOOP-30** (p2) ahead of three p3 siblings; senior had eight and took
    **LOOP-34** (p2). **LOOP-4 and LOOP-31 were deliberately NOT promoted** despite free senior /
    junior capacity — both carry live blocker edges, and promoting a blocked ticket into `Todo`
    just to fill a slot is how a depth cap starts lying about ready work.
  - **Noted for QA, not filed (staying in lane).** LOOP-20's regression test
    (`hub/test/cli-agentops.ts:319-333`) asserts that **`queue` specifically** routes, while its
    comment claims *"any future ROUTES omission fails here immediately."* It does not — `ROUTES`,
    `ATTACH_OK`, and `NEEDS_NODE_SQLITE` remain three hand-maintained parallel lists over one verb
    set with no invariant test between them, so the next verb repeats LOOP-20 exactly. A
    test-strength gap is QA's call, and LOOP-37's first AC already forces the new verb through all
    three lists.

## Candidate ideas

_(The overflow parking lot: strong ideas not yet filed. **Rolled 2026-07-30** — ten completed /
filed / shipped / retired DL-era entries (16 KB) moved to
[`docs/strategy-archive/2026-07.md`](strategy-archive/2026-07.md); this list now holds only
candidates with an unfiled action. Earlier DL-1…DL-5 daemon/web-UI/roadmap-bridge ideas were filed
2026-06-23.)_

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
