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

- **✅ Runner resilience is now complete and PM-verified (2026-07-30, `4917db6`).** **LOOP-23** —
  the LOOP-7 follow-up — landed and passed verify, closing the arc LOOP-1 opened: fires are killed
  by **process group** (no surviving descendants burning quota) and the retry-loop detector actually
  **rolls**. The original detector froze on its first 200 distinct lines and then read every
  subsequent line as new content, so a real fire that streamed thousands of tool lines before hitting
  a 429 loop could never trip the watchdog — it burned the full 1h timeout producing nothing. It is
  now a bounded FIFO window (`hub/src/seen-lines.ts`); `errorClass:"retry-loop"` reaches both ledgers
  and `byErrorClass`. Verified by re-running the suites against the merged commit **and** by
  reverting the module to the frozen semantics to confirm the new regression test genuinely fails
  against it. The scheduler's own SIGINT/SIGTERM path was **deliberately left a direct-child graceful
  signal** (documented at `run-agents.ts:1298-1306`): group-signalling would forcibly reap the
  helpers an agent spawns to checkpoint, which LOOP-10 made an explicit non-goal. A descendant that
  outlives a *graceful* stop stays **LOOP-19**'s job.

- **Two "merged ≠ what is actually running" gaps are now on the board together (2026-07-30).**
  LOOP-36 above is the doc side. The code side is **LOOP-38** (QA-filed, re-tiered by PM to
  senior + `sensitive`): the globally-installed `dev-loop` binary — the exact one every fire, the
  scheduler, and the operator invoke — is still **1.10.0**, five commits behind `origin/main`, because
  `release-npm.yml` is `workflow_dispatch`-only and nobody re-triggered it. So LOOP-20/21/25, all
  marked `Done`, are **not live**: `dev-loop queue` still fails from the installed binary, and PM/QA
  have been hand-working-around it for several fires. `Done` on a CLI-behavior ticket currently means
  "merged", not "runnable" — and nothing anywhere makes that skew visible.

- **The loop's board reads have been silently truncating, and that is now the most consequential
  open fault (2026-07-30, `polish-performance` lens).** `dev-loop tickets --json` and
  `op list_issues` emit their payload and then `process.exit()` while stdout still has buffered
  writes (`cli-tickets.ts:211`, `cli-agentops.ts:309`). Redirected to a file that is harmless;
  through a **pipe** — which is how every agent reads the board — Node's async stdout is discarded
  at exactly **65,536 bytes**, with **exit 0** and no warning. Measured on this board: 197,856 real
  bytes delivered as 65,536, so roughly **two thirds of the board disappears while looking
  complete**. The direct casualty is **§8 dedupe**: PM, QA and Sweep all check "is this already
  filed?" against a partial answer, which is the precise mechanism for filing duplicates and
  re-doing shipped work. It has already cost the loop once — a prior PM fire hit it and wrote the
  wrong root cause into `pm-state.json` ("a 38-ticket board blows the JSON parse — always pass
  `--fields summary`"), so a workaround has been propagating in place of a fix. Filed **LOOP-43**
  (p1, junior); the `--fields summary` mitigation is 19,376 bytes today and buys headroom only to
  roughly 140 tickets before failing the same silent way.

- **Landing observability is fully specified and gated (2026-07-30).** **LOOP-27**'s design passed
  PM's §21a gate — every load-bearing claim re-verified against `origin/main` rather than taken from
  the hand-off (zero `gh` references in `hub/src`, so the reader really is new code; `fail()` really
  is the only mutator of doctor's verdict, so the `DOCTOR_OK` fence is provable; `metrics.ts:205`
  really does print "shipped" for a Done-transition count). The increment is three junior children:
  **LOOP-40** (the `hub/src/landing.ts` forge reader owning the whole degradation contract),
  **LOOP-41** (doctor `W17` + a landing-aware `NEXT`), **LOOP-42** (metrics verified-vs-landed).
  Together they end the blindness recorded above: `doctor` gains its first forge glance, fenced
  three ways so the boolean gate CI depends on cannot move.

- **The health surfaces measure everything except the operator (2026-07-30, `strategy-gaps` lens).**
  `Current state` above already names the pattern — *"every health surface reports on a proxy, and no
  surface reports on the thing itself"* — and the board now carries a ticket for each proxy: landing
  (LOOP-27/40/41/42), ownership (LOOP-30), blocked (LOOP-26/31), reports (LOOP-28). The member that
  was missing is the one resource the loop cannot scale: **the operator's own latency.**
  `decisionQueue` (`hub/src/metrics.ts:126`) already selects the right population — `Human-Blocked` ∪
  `In Review`+assignee `operator` — and already returns `updated_at`. **Every surface downstream
  discards it:** `metrics` renders id + state with no age (`:206-207`); `doctor` never reads the
  queue at all (W05–W16, none of them this); and the daemon reminder is comms-gated — with no
  `team.comms` (the default shape, and this workspace's real config) `resolveBlockedReminderHours`
  returns **0, no timer, true no-op** (`daemon-notifiers.ts:46-51`), while W12 only warns when comms
  *is* configured but unresolvable. Measured this fire with two decisions pending: `doctor` printed
  `DOCTOR_OK` and `NEXT: dev-loop run` — *go fire more agents* — and reminders emitted were zero.
  Filed as **LOOP-49** (senior `Mode: design`; it lands in `doctor.ts` beside LOOP-41's W17 and the
  `DOCTOR_OK` policy call is a real one). The sharp edge is **LOOP-18**: under §20 D4 the doc's
  direction sections move only through the §9a investigation protocol, so one un-actioned approval
  has **frozen the north star's direction half** while PM appended to the progress half all day — the
  doc records reality and intent at different rates, and no surface reports that as a condition.

- **✅ The ship blocker cleared and the loop shipped its own work — v1.11.0 (2026-07-30 17:06Z).**
  Supersedes the "⚠️ Nothing has landed since v1.10.0 / the loop can build but cannot ship" entry
  above. LOOP-22 landed (`cec3598`, `stripGo` CRAP 113.8 → <15), the merge checks went green, and
  eight loop-built commits reached `origin/main` — LOOP-5, LOOP-20, LOOP-21, LOOP-22, LOOP-23,
  LOOP-25, LOOP-29, LOOP-33. The operator then cut **v1.11.0** (minor: the batch carries
  `feat(runner)` process-group kill + the retry-loop watchdog + errorClass `retry-loop`) and
  upgraded the global install. **`origin/main` == installed == v1.11.0, drift zero** — verified by
  PM this fire, not taken on report: `dev-loop --version` → `1.11.0`, `git rev-parse origin/main` →
  `685fee3` (the v1.11.0 release commit), and `grep -c queue …/dist/cli.js` → **4**, up from `0` at
  LOOP-38's filing. `dev-loop queue` — the boot call every agent skill documents, broken for ~10
  fires — now returns the ranked slice. **This is the first end-to-end proof that the loop can
  build, merge, release and run its own output.**

- **The publish→install skew is fixed as an instance, not as a mechanism (2026-07-30).** The
  reconcile above was manual. Nothing detects the next divergence, so LOOP-38 stays open behind
  **LOOP-46** (`doctor` W18) rather than closing on a green repro — its own AC says a "Done,
  verified merged" that isn't reflected in the installed tool is worse than a flagged pending state.
  Three sibling detectors now bound the same pipeline: **W17** (LOOP-41) *merged?* · **W18**
  (LOOP-46) *published?* · **W19** (LOOP-51) *pushed at all?*. None has shipped; the pipeline stays
  observable only by an agent noticing.
  > **Correction (2026-07-30, later fire):** W19 is **LOOP-56**, not LOOP-51 — the two were the same
  > detector filed 15 minutes apart, merged toward the design child. LOOP-51 is `Canceled`. W19 is
  > now `Todo`.

- **✅ The two-north-stars condition is cleared, and PM has an approved landing path — but not yet a
  mechanism (2026-07-30).** Supersedes the entry above on both counts. **LOOP-36's §21a design gate
  is `Done`**: the operator signed off the Part-B policy — *PM may push doc-only **progress** commits
  directly to `origin/<defaultBranch>` on this `landing:"pr"` repo, **exclusively via the `dev-loop
  doc-land` verb once it ships***. The fence that made it signable is the docs-only path assertion,
  and the operator flagged that widening that allowlist requires a **new sign-off, not a
  follow-up**. The operator then executed the one-time reconcile: `origin/main` == local `main` ==
  `e1177cd`, zero ahead / zero behind, `docs/strategy-archive/2026-07.md` on origin. For the first
  time since the divergence was found, PM and every dev worktree read the same `docs/STRATEGY.md`.
  **The honest residual:** the policy is approved and its only sanctioned mechanism does not exist —
  **LOOP-57** (`doc-land`) and **LOOP-56** (W19) are `Todo`, so this fire's doc commit is local-only
  again and `main` goes one ahead at close. The recurrence interval is still one PM fire; what
  changed is that it now has a dated ruling and four promoted tickets behind it (LOOP-54/55/56/57)
  instead of an open question. **LOOP-50** stays parked on exactly those four — its cleanup ACs are
  met, its prevention ACs are not, and unparking it on a resolved *design gate* would have been a
  false unpark.

- **The metering foundation landed with its join key uncarried (2026-07-30, `data-analytics` lens).**
  `e5669cb` (LOOP-12's merged work) mints a per-fire `fireId` and stamps it into `fires.jsonl` and
  the `fire.completed` event — the fire side of the ledger is complete. The work side is not.
  `db.ts:445` reads `process.env.DEVLOOP_FIRE_ID` **at the moment of the INSERT**, so the stamp
  survives only where the agent writes the database itself (MCP fires via `server.ts`, plain CLI —
  this workspace's path today). On every **daemon** transport the write executes in the daemon
  process, which has no such env: `op-client.ts` forwards `x-devloop-actor` and nothing else, and
  `daemon.ts` has never heard of `DEVLOOP_FIRE_ID`. Identity was deliberately carried env→header
  across that hop; the fire was not. The drop is **silent** — `fireId ? {...} : {...}` is a clean
  no-op — so a cost-per-change query returns *empty* rather than failing, which is indistinguishable
  from a loop that did no work. The affected list is P3b **"daemon as canonical single writer"**
  (a COMPLETE milestone) plus the `--attach` posture Phase B extends: the direction of travel is
  *toward* the transport that loses the key, while **LOOP-3** (per-ticket/actor/**fire** history) is
  In Progress and **LOOP-13/14/15 → LOOP-4** all join on it. Filed **LOOP-61** (senior, p2). Baseline
  to re-measure against: 477 events, **0** carrying a fireId.

- **✅ The silent kill-switch is off `origin/main`, and the metering chain is moving again
  (2026-07-30).** **LOOP-58 verified `Done`** against the merged artifact (`768a2d8`, PR #43): the
  `import.meta.url === ` + `` `file://${process.argv[1]}` `` entrypoint guard that turned `dev-loop
  run` into an exit-0 no-op on any URL-escaped checkout path is **deleted**, not corrected — shape
  (b), which kills the space *and* symlink cases together. Verified the way the ticket asked: `git
  archive 768a2d8` into a spaced directory prints the full 5587 B usage, the same tree at `e5669cb`
  prints **0 B**. The senior tier's stated reason for preferring (b) over `pathToFileURL` was
  **independently reproduced** — the pre-fix tree also no-ops from an *unspaced* path reached through
  a symlink (`/tmp`→`/private/tmp`), so (a) would have shipped a live residual. All four LOOP-12
  acceptance criteria re-confirmed on the merged tree, including the one LOOP-12's own comment flagged
  as untested: the **`fires.jsonl` ledger row now carries `fireId`**, asserted on a real `--once` fire.
  **Consequence for the roadmap:** LOOP-58 was the single live blocker edge on **LOOP-13/14/15**
  (per-lane measured usage) and **LOOP-19**; all four unparked this fire. This is a *shipped* unblock,
  not a closed-ticket one — `FireRow.fireId?`, `FireUsage` and `UsageAdapter` are live in
  `metrics.ts`. **LOOP-4** stays parked: it aggregates over lanes that have not yet emitted anything.

- **⚠️ Landing discipline shipped two verbs, and both are `main`-only (2026-07-30).** `origin/main`
  advanced `4a4b4b7` → **`2888dd8`** (LOOP-54: `dev-loop worktree add`, which cuts dev branches at
  `origin/<defaultBranch>` instead of local main) → **`35479b9`** (LOOP-55: `push-guard` passenger
  detection, flagging commits that branched off local main). Together they close the LOOP-48/LOOP-50
  divergence class **for this repo**. They do not close it for anyone else: **`repos[].defaultBranch`
  is documented in the §19 resolution table (`conventions.md:1485`, with a `git.defaultBranch`
  fallback) and exists nowhere in the code** — `grep -n "defaultBranch" hub/src/team-config.ts`
  returns nothing, `team add-repo` has no flag for it, and `--detect` does not infer it. Both new
  verbs substitute a hardcoded `"main"` (`worktree.ts:35` says so in a comment; `push-guard.ts:27,88`
  has a `--default-branch` escape hatch **no caller passes**). Measured against a real
  `master`-default repo: `worktree add` **cannot create a worktree at all** (`fatal: couldn't find
  remote ref main` → fallback → `fatal: invalid reference: main`), and `push-guard --strict`
  **fails silently open** — its passenger block is gated on `rev-parse --verify origin/main`, which
  exits 1, so the guard reports clean. A safety gate that lies is the worse of the two. Filed
  **LOOP-70** (senior, p2, `Mode: design`); **LOOP-56** and **LOOP-57** are queued consumers warned
  not to add copies three and four.

- **⚠️ The loop writes a dependency graph and never reads it (`ux-flows`, 2026-07-30, `6c926eb`).**
  The rotating lens closed on the mechanism a quarter of the board depends on. `Blocked-by:` has a
  **first-class writer and no reader**: `grep -rn "Blocked-by|Unblocked-by" hub/src/` returns exactly
  three hits, all in `cli-agentops.ts` — the `--blocked-by` help string (`:46`), a comment saying the
  marker *is* the edge (`:300`), and the writer itself (`:305`). What the code actually consumes is the
  flat `blocked` **label**: `metrics.ts:118` counts it (`blockedNow`, a scalar) and `agentops.ts:206,218`
  filters on it to gate the dev pick-queue. So the loop maintains a real dependency graph in comment
  markers, enforces a boolean shadow of it, and never reads the graph. **Measured now:** `dev-loop
  metrics` says `12 blocked open` — 27% of the 44 live tickets — and cannot say that **eight of them
  trace to LOOP-40**, which is `p2`, `Todo`, junior-assigned and *unblocked and pickable this minute*.
  The one fact that would change what the operator does next is the one no surface computes; `doctor`
  meanwhile prints `DOCTOR_OK` / `NEXT: dev-loop run`, correctly under its rules and uselessly here.
  Downstream: stale edges (a blocker already `Done`, the ticket still parked) are invisible and **have
  already occurred here**; dangling and cyclic edges are undetectable; and the §9c pass is a **manual
  re-derivation every PM fire** — this one cost 12 `dev-loop comments` calls plus a hand-written
  resolver to answer a question the database owns. Filed **LOOP-78** (senior, p2), scoped disjoint from
  LOOP-26 (*classifying* the count) and LOOP-31 (*reconciling* the count): both are about the number,
  this is about there being no graph underneath it. This is the `Current state` pattern's newest member
  — the proxy is a count, the thing itself is a graph.

- **✅ Two design gates and one verify gate passed; the fire ledger is now measurably in motion
  (2026-07-30).** `origin/main` advanced `4488894` → **`6c926eb`** (LOOP-9: per-agent
  `fireTimeout`/`stallTimeout`, resolution order *config > CLI flag > per-lane default*, `E17`
  validation naming the offending agent+field). Verified against the merged tree: AC-exec green, full
  suite **1373 pass / 2 fail**, and the two failures **proven not the increment's** — `test/lifecycle.ts`
  hardcodes `127.0.0.1:8787`, a live daemon holds that port here, and both failures reproduce
  identically at `4488894`, the commit before. Two §21a gates also passed: **LOOP-49** (decision-queue
  observability → LOOP-73 metrics-age + LOOP-74 doctor decision-stall, both promoted `Todo`) and
  **LOOP-61** (the `fireId` daemon-transport carrier → LOOP-75, promoted `Todo`). On LOOP-49 all seven
  load-bearing `file:line` citations were re-checked against `origin/main` and held. On LOOP-61 the gate
  **caught a fourth state the design did not name**: `AsyncLocalStorage` scopes the op dispatch, but the
  daemon's *own* eight `logEvent` sites in `daemon-notifiers.ts` run outside any scope and fall back to
  ambient env — and `daemon-lifecycle.ts:246` spawns the daemon with `{...process.env}`, whose own
  comment (`:240-244`) says *"`up` is often invoked from an agent fire's env"*, which is why
  `DEVLOOP_ACTOR` is pinned there. The fire id is not. **It is D5's bug one field over, in the same
  `env:` object** — so the daemon could stamp its entire notification history with one inherited stale
  fireId. A silently-*wrong* analytics key is worse than a silently-absent one: absent fails visibly
  under scrutiny, wrong returns a confident number. Written into LOOP-75 as required scope, not deferred.

- **📋 Two process gaps the fires themselves surfaced (2026-07-30).** (1) **W-code allocation has no
  allocator.** Three open tickets independently claimed **W19** — LOOP-56 (17:36Z), LOOP-74 (19:33Z),
  and my own gate ratified the third after verifying against `doctor.ts`, which emits only W05–W16
  because *none of the claimants have landed*. Checking shipped code is the wrong question when the
  namespace is allocated by unlanded tickets. Resolved by first-claim-wins on `created_at` (W19 stays
  LOOP-56; LOOP-74 → **W20**) and a ledger written onto both tickets: **W17 → LOOP-41, W18 → LOOP-46,
  W19 → LOOP-56, W20 → LOOP-74**. (2) **`validate-then-drop` is the sharper cousin of
  `documented-but-absent`.** LOOP-9 shipped `projects.<key>.agents.<a>.fireTimeout/stallTimeout`
  documented in the project-override table *and validated by E17* — and never applied on the v2 team
  path, the only path a v2 workspace takes. Reproduced with two identical workspaces differing only in
  declaration site; within one config object at project scope, `model` applies while `cadence` and both
  timeouts are dropped, and nothing says which. A schema that accepts a field is a promise it does
  something. Filed **LOOP-77** (senior, p2) — the second instance of this shape after LOOP-70, and worse,
  because a plain omission at least errors.

- **🔴 First double verify-fail, and the mechanism that let it happen (2026-07-30, conversion-retention
  lens at `6c926eb`).** Both metering children in flight failed the gate in one fire: **LOOP-13** (claude
  lane) and **LOOP-14** (opencode lane, stacked on LOOP-13's branch). Escalated to senior as LOOP-83 and
  LOOP-85. What makes this a **product** finding rather than a bad-day report is that *the loop already
  had the signal and did not consume it*: PR #48's checks concluded `FAILURE` before the hand-off
  landed, and the ticket moved to `In Review` anyway. **`npm test` is a 68-link `&&` chain** — LOOP-13's
  run halted at `test/team-scheduler.ts`, **segment 7 of 68**, so the 61 suites after it never executed,
  including `test/run-agents.ts` (the increment's *own* new acceptance tests, which the hand-off claimed
  were "all passing" on the strength of a local file-in-isolation run) and `test/quality.ts` at
  **segment 67 — the 4th Step-5 ship gate**. A partial run and a full run are byte-indistinguishable in
  the output. The regression itself was real and narrow: `suspectError` was *replaced* by the JSON
  adapter instead of *extended* by it, so an exit-0 claude fire whose output is `Execution error` — or
  empty — records as healthy on the one lane the loop actually runs. Filed **LOOP-86** (the chain),
  **LOOP-89** (senior `Mode: design` — where the CI signal gets consumed before `In Review`), and
  **LOOP-87** (PR #49 carried the Canceled `a5cd526` as a passenger toward `main`; `push-guard` checks
  branches cut from *local main*, not from another agent's feature branch). **First-pass yield to date:
  27 `Done` vs 4 verify-failed increments (~87%) — two of the four in this fire, both in one stack.**

- **🛡️ `sensitive` stops being decorative (2026-07-30).** The **LOOP-34 design gate passed**: the
  `sensitive ⇒ senior-dev, ALWAYS` invariant (§21b) — the rule whose violation the loop *cannot detect
  after the fact*, and the sole control on unattended auth/money/PII/secrets/migration work — gets
  auto-re-tier at the `ticketwrite.ts` write choke-point, logged as an `issue.retier` event, with an
  `opQueue` exclusion belt and a doctor/digest backstop for pre-gate rows (children LOOP-79/80/81,
  promoted). The design deliberately rejects *refuse-at-the-write*, on the grounds that for an
  **unattended** loop a filer mishandling a 4xx **drops the sensitive ticket entirely** — guaranteeing
  the ticket lands correctly tiered beats a loud failure that can lose it. Recorded because it is a
  standing policy: the gate is **not bypassable by anyone, including the operator**.

- **🔴 The loop has been running five of its nine agents, and the config file says eight
  (`strategy-gaps`, 2026-07-31, `8cc84c5`).** The lens closed on the gap between the product's own
  roster and what actually fires. `team init` seeds **four** agent cadences into every new workspace
  (`team-init.ts:132`: sweep 30m, ops 10m, reflect 1d, communication 1d); the default run set is
  `DEFAULT_AGENTS = GROUPS.core` (`run-agents.ts:87`), which contains **one** of them. The other
  three live in the `outward` group and are never scheduled — and `applyConfigCadence` iterates
  **`for (const agent of opts.agents)`** (`:1154`), the *selected* set, so their cadences are never
  read. **The output asymmetry is the whole defect:** an applied cadence prints a confirmation line,
  a malformed one warns, and one for an unselected agent produces *complete silence*. The single
  existing backstop (`:1439`) covers `ops` only, and only when health probes exist — this workspace
  has none. **Measured:** 120 fires over 9h; ops 0, reflect 0, communication 0, architect 0. The
  consequence is not cosmetic: **`reflect` is the only writer of the team lessons library**
  (`lessons.ts:2`), which `lessonsForFire()` injects into *every fire of every agent* —
  `.dev-loop/lessons/` is empty, so that injection has been the empty string 120 times and the loop
  has no cross-fire memory at all. The blindness is doubly guarded: `checkLessonsBudget` warns only
  when a file is **over budget**, and `budgetOf` returns `null` for a missing file — so absent and
  healthy are the same output; and W16 owner-liveness keys on **owner labels found on tickets**,
  while these four agents own no tickets by design, so they fall outside its input set entirely.
  `dev-loop doctor` prints `DOCTOR_OK` one line after listing `architect, communication, ops,
  reflect` as valid actors; `dev-loop metrics` renders a tidy 5-row table because a zero-fire agent
  is simply *absent* from it. Filed **LOOP-90** (the silent drop) and **LOOP-91** (the liveness
  blindness); the run-set ruling is **LOOP-92**, parked for the operator. This is the third member of
  the `validate-then-drop` family after LOOP-70 and LOOP-77, and the worst-behaved: the config is
  well-formed, correctly spelled, semantically meaningful, *and written by the product's own `init`*.

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

- **(pm, 2026-07-30) Competitive-parity lens — the loop can merge over a human's "Request changes",
  and the 2026-07-02 "do not re-propose" list correctly stopped everything else.** Filed **LOOP-39**
  (Feature, senior `Mode: design`, `relatedTo` LOOP-27/LOOP-35) on the one finding that survived.
  - **The finding.** §12c's fire-start merge pass merges on `mergeChecks` green **AND** `MERGEABLE`,
    and never reads `reviewDecision`. That is not an isolated oversight: §12c deliberately avoids
    GitHub branch protection (required-check gating deadlocks PRs whose checks never report, e.g.
    `GITHUB_TOKEN`-created deploy PRs) — a decision that should stand. But **without protection a
    `CHANGES_REQUESTED` review cannot make a PR non-mergeable**, so nothing stops the next dev fire
    from squash-merging over it. Verified: `gh api …/branches/main/protection` → **404 Branch not
    protected**. Separately, `grep -rn "gh pr\|pull_request\|prNumber" hub/src/` → **0 hits**: the hub
    has no forge concept, so review comments reach no agent and ticket→PR exists only as pasted prose.
  - **Why it is worth a ticket though it has never fired** (`reviewDecision: ""` on every loop PR,
    #30–#36): the Vision sells operator **点评** as the steering mechanism, and today that steering
    cannot reach the diff — the surface a reviewer actually uses. The failure mode is a human's most
    deliberate act of steering being discarded silently, with the change already on `main`.
  - **Checked against the standing non-goal, and it holds.** *"No default human step-by-step
    gating"* forbids requiring approval; it does not require ignoring refusal. LOOP-39 adds no wait:
    an unreviewed PR merges exactly as today.
  - **The 2026-07-02 Linear-parity skip list did its job.** Re-read before filing, as that entry
    instructs. Cycles/estimates, due dates, milestones, saved views, reactions, attachments, and SLAs
    were all considered and **not** re-proposed — no new concrete need. LOOP-39 is forge/review
    integration, which that entry never covered, so it is not a re-proposal.
  - **§17 split, deliberate.** LOOP-39 scopes only the *enforceable* half (a `push-guard`-style verb
    + board-visible review state + a structured ticket↔PR link). Wiring the guard into the merge rule
    edits `conventions.md` §12c and `skills/dev-agent/SKILL.md`, so it rides a `[pm-proposal]` for the
    operator — the same prose-not-code weakness **LOOP-35** is filed against.

- **(pm, 2026-07-30) Routing correction worth keeping: an un-tiered ticket is invisible, and
  `sensitive` is decided from the ACs, not the label.** LOOP-38 arrived p1 with `assignee: null` and
  no tier, so it was in **neither** dev pick-query (`opQueue`, `hub/src/agentops.ts:205`, filters the
  dev queues on assignee) — a p1 bug parked where nobody could see it. PM re-tiered it by hand at
  grooming, to **senior + `sensitive`**: its leading option turns `release-npm.yml` into a
  push-triggered publish, which changes when a credential publishes a public package (§4 → §21b:
  sensitive ⇒ senior, always — design before code). Two standing rules for future fires: **every
  QA/Architect/Ops-filed ticket gets a tier check during Job B2** until **LOOP-30** lands, and
  `sensitive` is judged from what the ACs plainly touch even when the filer did not label it.

- **(pm, 2026-07-30) The §21a design gate passed LOOP-27 but amended its children — and the
  amendment is the reusable lesson: a design can be right everywhere and still hand a junior an
  unbuildable contract.** Two defects, neither in the design's reasoning:
  - **`landed` had no data source.** Design §5.2 asked `metrics` for "loop PRs merged to base in the
    window" while §4 made the Child-A reader the **only** module permitted to touch the forge — but
    the `LandingState` type carried no merged count. Child C could satisfy its AC only by opening a
    second forge call and breaking the single-reader invariant, and its own test AC ("inject Child
    A's result → assert `landed`") was literally unbuildable. Fixed at the gate: **LOOP-40 now owns
    `mergedInWindow`** (fed by a `windowMs` option, `null` — never `0` — under `unknown`/`na`) and
    **LOOP-42 consumes it**.
  - **"Do not start until A lands" was prose, not an edge.** For the **fourth** time on this board
    (LOOP-13/14/15, LOOP-19, now LOOP-41/42) sequencing was written in English while the dev queue
    filters on the `blocked` **label** (`hub/src/agentops.ts:206,218`). Both children now carry a
    real `Blocked-by: LOOP-40` marker **and** the label. Four repeats is a product signal, not an
    agent-discipline one: **LOOP-35**'s neighbourhood should eventually make an unlabelled
    `Blocked-by:` marker impossible rather than merely discouraged.

  **Standing ruling — §21a "promote every staged child" vs §5a's depth cap.** They collide whenever a
  gate passes into a full queue, as it did here (junior at 10/10). **The cap wins for new capability;
  nothing is stranded.** LOOP-40 stays `Backlog` at the head of the promote order and rises the first
  fire junior drains; LOOP-41/42 sit behind live blocker edges that §9c releases automatically. §21a's
  anti-stranding rule is written against the *fail* path (cancel the children with the parent) — on the
  pass path a capped queue is the pace control working, not a dropped increment.

  **The counter-case, ruled the other way in the same fire, deliberately.** LOOP-43 — the 64 KiB
  stdout truncation — was filed straight to **Todo at p1**, taking junior to 11/10 by exception. The
  distinction is not severity but *kind*: the cap paces **origination** of new capability, and
  deferring a live fault that silently corrupts the dedupe input of **every** agent does not protect
  dev focus, it compounds damage across the whole team while they keep reasoning about a board that
  is two-thirds invisible. New capability waits for the queue; a poisoned shared input does not.

  **Lane note, flagged rather than quietly taken.** A defect is QA's `Bug`. PM filed LOOP-43 itself
  because the repro is deterministic, because the corruption is in the *shared* read path so QA's own
  scoped queries would likely never surface it, and because it had already written a false conclusion
  into the loop's durable state — active ongoing harm, not a first sighting. The reasoning is recorded
  in the ticket so QA or Reflect can overrule it cheaply.

  **Design-home ruling (asked for explicitly by senior-dev, settled here).** A `Mode: design` doc for
  this project lives as a hub `design` doc-kind, **not** a repo `docs/design/*.md`. The deciding
  argument is the senior's own: `main` is `landing:"pr"`, so a repo-file design needs its own PR to
  land — which would couple every design gate to the CI health that **LOOP-27 exists to detect**. It
  also matches the `metering` precedent. No repo mirror.

- **(pm, 2026-07-30) A merged PR carried nine commits nobody reviewed — dev branches are cut from
  local `main`, and a passenger commit is invisible to every gate we have.** Found on the preflight
  SHA sweep (`24d974f` → `d2e0732`), from an anomaly rather than a lens: `docs/STRATEGY.md` appeared
  in the *product* diff. PR **#28** — titled `fix(hub): wireEnv always overrides DEVLOOP_PROJECT` —
  merged **123 insertions of strategy prose** alongside its five lines of hub code, because the
  worktree was cut from local `main` and inherited two unpushed PM doc commits. This is live, not
  historical: the in-flight `dev-loop/LOOP-43` branch already carries **all nine** of PM's local-only
  doc commits and will ship them with a CLI truncation fix. Filed as **LOOP-48** (senior, `Mode:
  design`).

  **Why it earns a Decisions entry rather than just a ticket.** Every governance gate this project
  has built guards an actor's *own* commit path — §20 D4 routes PM's direction edits through the §9a
  investigation flow, §17 keeps SKILL/conventions files human-gated, and LOOP-35 proposes to enforce
  that firewall mechanically. **None of them inspects what a PR is merely carrying.** Any local-only
  commit, from any actor, lands on `origin/main` as a passenger with `autoMerge:true` and test-only
  merge checks. The gates are load-bearing on an assumption — that a branch contains only its own
  work — which nothing establishes, because §7's "branch off the up-to-date `origin/<defaultBranch>`"
  is prose with **no implementation anywhere in `hub/src/`**: `wsWorktree()` has no caller, so every
  fire hand-builds its own `git worktree add`. This is the same root as **LOOP-37** (worktree *paths*)
  seen on a second axis, and the inverse of **LOOP-36** (PM's doc commits never land *at all*).
  LOOP-36's fix does not close it — a correct PM landing path still leaves every other unpushed
  commit free to ride. Recorded because the conclusion generalises past the bug: **a convention that
  no code implements is not a control, and building further gates on top of it compounds the error.**

- **(pm, 2026-07-30) The §21a design gate passed LOOP-38's design and still refused to close the
  ticket — "the design is sound" and "the bug is fixed" are different claims.** LOOP-38 (installed
  `dev-loop` binary stale vs `origin/main`) came to the gate with a genuinely good design:
  `landing-observability` §9 extends the living module doc rather than duplicating it, rejects
  auto-publish-on-merge on *mechanism* (`release-npm.yml` computes a version per run and refuses
  without an `## Unreleased` section, so a `push:` trigger either churns public releases or
  fail-refuses), and stages one faithful child (**LOOP-46**, doctor W18). Gate: **passed**.

  It went **`Human-Blocked`**, not `Done`. Its AC4 is *"re-run this ticket's repro"* — and the repro
  fired during this very fire's boot (`dev-loop: unknown command 'queue'` from the installed
  `1.10.0`, while `origin/main` reached `d2e0732`). Marking it `Done` would have produced precisely
  the false-`Done` this ticket was filed to expose: a verified verdict invisible in the tool every
  agent runs. **A design gate certifies a plan, not an outcome; when a ticket's own acceptance test
  still reproduces, the honest terminal state is the human park, not `Done`.** What remains is
  genuinely operator-only — the A-vs-B sync-mechanism call, and the publish-or-pin action. PM concurs
  with senior-dev's **Option B** (pin agents to a local build): under A the public npm registry
  becomes a log of an internal loop's every green merge — an outward, irreversible side effect
  adopted for internal convenience, where B is contained and reversible.

- **(pm, 2026-07-30) Two agents filed the same bug eleven minutes apart; the dedupe rule that
  resolved it was "whose root cause is better", not "who was first".** QA filed **LOOP-45** and PM
  filed **LOOP-47** for the same defect (`hub/test/run-agents.ts` inherits the fire's `DEVLOOP_*`
  env). §8 dedupe cannot prevent this class — both agents deduped against a board snapshot taken
  before the other's write. PM's snapshot was simply older.

  Kept **LOOP-45** and canceled its own ticket, because QA's bisect was the stronger artifact
  (`DEVLOOP_PROJECTS_JSON` alone proven necessary *and* sufficient). PM's evidence was ported into
  it: the consequence is **not** 32 noisy assertions but that `npm test` is one `&&` chain of ~60
  suites with `run-agents.ts` ~21st — inside a fire it short-circuits there, so **~40 later suites
  including `test/quality.ts`, the fourth Step-5 ship gate, never execute at all.** Also corrected
  one wrong turn in LOOP-45's fix-shape reasoning: it assumed the assertions run in-process, but
  both sites `spawnSync` a child (`:13`, `:247`), so the fix is the plain `env:` scrub that
  `7c43c06` already landed for `hub-lifecycle.ts` — not a scrub-and-restore around resolution calls.
  **The general rule: when two filings collide, merge toward the better diagnosis and port the rest;
  seniority of timestamp decides nothing.** Routing was also repaired — LOOP-45 sat at P1 with
  `assignee: null`, invisible to both dev tiers (`agentops.ts:205`), the third instance of the
  LOOP-30 class this week.

- **(pm, 2026-07-30) Fifth instance: a blocker written as prose blocks nothing.** LOOP-4 and LOOP-31
  both carried correct `Blocked-by:` marker comments and correct prose, and **neither carried the
  `blocked` label** — so both would have read as promotable to a grooming pass that trusted the
  board over the ledger. Repaired this fire. The lesson is now old enough to state as an invariant
  rather than a reminder: **the marker comment is the ledger, the label is the enforcement, and
  writing one without the other is a no-op.** LOOP-26 (the blocked taxonomy) and LOOP-31 (its web
  surface) are the durable fix; until they land this is a per-fire manual audit, and it has caught
  something in five of five fires.

- **(pm, 2026-07-30) `strategy-gaps` lens — the loop schedules every resource except the human, and
  the audit's sixth hit was the mirror image of the first five.** Two calls this fire.

  **(1) The gap is the operator's latency, and it is filed as senior design work.** Reading `Goals`
  against the board: of the four supporting goals, three are densely covered and **"broaden
  portability" has zero tickets** — deliberately left that way, because filing portability work while
  the loop still cannot reliably ship itself would be padding, and this lens is not a quota. The real
  gap was elsewhere. Every proxy in the "no surface reports the thing itself" pattern now has an
  owner; the operator's own response time had none, even though `decisionQueue` already computes it
  with timestamps. Filed **LOOP-49** as senior `Mode: design` — not junior — for a reason worth
  recording, because the borderline default is junior (§21b): it edits `doctor.ts` in the same
  function as LOOP-41's W17, and the open question (may a *board* condition move `DOCTOR_OK`, when
  LOOP-27's gate fenced a landing stall to warn-only?) is a policy call with a CI blast radius. That
  is design work by the §21b test — "needs a design," not "is large." Scope was fenced explicitly to
  the `decisionQueue` population so it cannot drift into LOOP-26's `blocked` taxonomy.

  **(2) §9c, sixth instance — and this time the marker was there and the label was not needed.** The
  five prior fires all found the same shape: a correct `Blocked-by:` marker with no `blocked` label
  (ledger without enforcement). This fire's audit found the inverse on **LOOP-16** — a live
  `Blocked-by: LOOP-5` edge on a ticket sitting correctly unblocked in `Todo`, because LOOP-5 landed,
  a later fire promoted the ticket, and **nobody wrote the `Unblocked-by:` retirement line.** Also
  retired a resolved `LOOP-23` edge on LOOP-19 (which stays blocked behind LOOP-12). Neither was
  causing harm *yet*, which is the point: §9c warns that an un-retired edge set is one re-park away
  from resolving `{all Done}` and self-unparking instantly. **Standing correction to how this audit
  is run:** checking "does every `blocked` ticket have a marker?" only catches five of the six
  shapes. Walk it in **both** directions — every marker needs a live-or-retired verdict, including on
  tickets that carry no `blocked` label at all. LOOP-16 was invisible to the W5 query
  (`blocked`+`external-prereq`) for its entire held life and cleared only because a PM fire happened
  to notice its blocker had landed.

- **(pm, 2026-07-30) 📝 RULING — a fixed *instance* does not close a *visibility* bug; re-sequence
  it behind its own detector.** The operator resolved LOOP-38 out of band (released v1.11.0,
  upgraded the global install, drift → 0) and un-parked it to `Todo` for PM verify. I confirmed AC4
  independently and still did **not** close it `Done`: AC2/AC3/AC5 — *make the skew visible* — are
  carried entirely by LOOP-46, unshipped. Drift is zero only because a human re-published by hand;
  the next merge re-creates it silently, which is the defect. Closing would have re-asserted exactly
  the silent inheritance the ticket exists to kill. **Standing rule:** when a ticket's ACs split into
  *this instance is fixed* and *this class is now detectable*, the instance being green is not a
  close condition — block the parent on the detector (`Blocked-by: LOOP-46`) and let it auto-unpark.
  Second half of the ruling: it un-parks to **`In Review` for PM verify, not back to a dev `Todo`**,
  because the residual is verification, not code — a design parent whose children carry the build
  should never re-enter a dev pick queue.

- **(pm, 2026-07-30) 📝 RULING — the reconcile the operator proposed for the diverged doc-home clone
  does not work, and the two "parallel" git defects are one entangled defect.** LOOP-50 (operator
  intake) asked for `git pull --rebase … then push`, on the stated assumption that *"doc commits
  rebase cleanly over code PRs"*. Tested in a throwaway worktree: it **conflicts on commit 1 of 11**
  in `docs/STRATEGY.md`. Cause confirmed via `git log origin/main -S<line>` → **`7c43c06`** — PR #28
  already carried `b278db8`'s content onto `origin/main` as a passenger, so replaying it
  double-applies. **Therefore: passenger smuggling (LOOP-48) is not a parallel harm to the
  divergence (LOOP-36) — it is what makes the divergence unrecoverable by rebase.** Every smuggled
  PR that merges adds another conflict to the eventual reconciliation. Recorded so neither design
  lands assuming a clean replay. PM did **not** perform the reconcile: it conflicts, `push` to a
  shared `origin/main` is outward-facing and hard to reverse in an unattended fire, senior owns both
  designs in that repo, and `docs/strategy-archive/2026-07.md` exists only locally.

- **(pm, 2026-07-30) 📝 RULING — a groomed intake parent whose AC is an *outcome* stays open.** §9a
  closes an intake parent once its asks are routed to children. LOOP-50's AC is *"origin/main's
  STRATEGY.md history is linear and current"* — a state of the world, not a routing step. Closing it
  on routing alone would be **phantom-`Done`**, the precise failure the ticket was filed to name. So
  it stays open as an umbrella, `Blocked-by: LOOP-36 LOOP-48 LOOP-51`, and PM verifies the outcome
  directly at unpark. **Generalised:** route-and-close applies to asks; asks whose acceptance is an
  observable end-state get an umbrella with real blocker edges instead.

- **(pm, 2026-07-30) ux-flows lens — the operator's front door does not point at their own house.**
  `http://127.0.0.1:8787` is published as *the* board URL in all three READMEs, `docs/DAEMON.md`,
  `docs/HUB-ARCHITECTURE.md` and every `deploy/` manifest. On the dogfooding machine it currently
  serves a **13-day-old v1.2.1 daemon from a different workspace**, answering `{"ok":true}` and
  rendering a normal board for a project called `certproj`; this project's real board is on `:8840`,
  53 ports up the probe. The board page names the *project* but never the workspace, the `hub.db`,
  or the daemon version — and project keys are not unique across workspaces (`_team` exists in all
  of them), so a wrong board is indistinguishable from the right one. The discovery verb disagrees
  with itself too: `daemon status` honours `DEVLOOP_PROJECT`, `hub status` — the verb first-run setup
  teaches — is pinned to `_team`. Filed **LOOP-52** (identity + discoverability). **Root cause filed
  separately as LOOP-53:** the hub test suite starts detached daemons and never stops them — **58
  listening on 8787→8844, oldest 13d 21h, 53 of them holding throwaway `$TMPDIR` fixture databases**,
  several already deleted from disk and therefore unreachable by `daemon down` (its runfile went with
  the fixture). Scoped honestly: they hold *fixture* DBs, so there is **no** contention on any real
  `hub.db` — the harm is port/process/handle exhaustion and a documented URL that lies. Routed to
  senior `Mode: design` because the cleanup rule, not the teardown, is the hard part: three unrelated
  *legitimate* workspaces are listening on this machine right now (one 8 days old), so **age is not a
  liveness signal** and a naive reaper kills someone's live board.

- **(pm, 2026-07-30) conversion-retention lens — `main` is shipping a silent kill-switch, and the
  verify gate that caught it had no power to stop it.** Verifying LOOP-12 (metering increment A) found
  all five ACs passing and both suites green, but one **EXTRA delta** in the diff: to let the test
  `import { recordFire }`, the tail of `hub/src/run-agents.ts` became
  ``if (import.meta.url === `file://${process.argv[1]}`)``. That is naive string concatenation —
  `import.meta.url` is percent-encoded, `process.argv[1]` is a raw path — so on any checkout path
  containing a space, `#`, `?`, or non-ASCII the comparison fails, `main()` never runs, and
  **`dev-loop run` becomes a silent no-op that exits 0**. Proven, same file and command, only the
  directory differing: `"/tmp/pm space test"` → 0 bytes of output; `/tmp/pm-l12` → the normal 5587-byte
  help. macOS `Google Drive` / `iCloud Drive` checkouts make this an ordinary install shape, and its
  failure mode — a loop that looks healthy and does nothing — is the worst class this product can ship.
  Verify-failed and Canceled (LOOP-12); **fix-forward is LOOP-58** (senior, p1).
  - **The governing finding is not the bug, it is what happened next.** `autoMerge` merged PR #40 to
    `origin/main` as `e5669cb` **while the ticket sat In Review awaiting this very gate** — green CI
    was treated as sufficient authority to land. The gate produced the correct verdict and could not
    act on it: remediation became a fix-forward on `main` instead of a branch that never lands. The
    merge pass reads `gh pr checks` + `mergeable` and reads **neither `reviewDecision` nor the board**,
    so a human's "Request changes" and an owning agent's pending verify gate are the same blind spot.
    Evidence routed to **LOOP-39**, which already owns the merge-policy axis, with a suggested scope
    addition: gate the merge on **ticket state**, not only on review state — the board is already the
    system of record and needs no new forge concept to read.
  - **The lens's own answer.** Asked "does a new operator convert and stay?", the honest reading of
    this fire is that **every severe finding today was invisible to the operator until an agent
    happened to look**: `dev-loop doctor` printed `DOCTOR_OK` and `NEXT: dev-loop run` against a
    `main` that had just acquired the kill-switch. Retention risk here is not a missing feature, it is
    a health surface that is confidently wrong. That theme already has owners (LOOP-46/56 skew and
    divergence W-codes, LOOP-49 decision-queue ageing, LOOP-31/26 blocked-now contradictions), so it
    is recorded here rather than re-filed — **zero new tickets from this lens beyond LOOP-58.**
  - **Two design gates cleared (§21a).** `landing-discipline` v1 verified against the repo, not the
    hand-off. **LOOP-48 (Part A) PASSED → `Done`**, children LOOP-54/LOOP-55 promoted; its claims hold
    live — PRs #38 and #39 each carry **7 passenger `docs(strategy)` commits** and are conflicted,
    while #41 (cut after the base reconciliation) carries only its own work, which is exactly the
    behaviour the `worktree add` verb makes structural. One caveat recorded for the build: the design
    rests on *"`autoMerge` cannot fire on a `DIRTY` PR"*, which is true today but is a coincidence, not
    a rule — #40 proved how fast a clean PR lands. **LOOP-36 (Part B) design verified but parked
    `Human-Blocked`**: Option 1 makes PM the one actor pushing to `origin/main` outside the repo's PR
    gate, which is the operator's call, not senior's and not mine. Its AC3 (rescue the 12-commit
    divergence) and AC6 (PM and dev read the same doc) are **already satisfied** — `strategy-archive/
    2026-07.md` is on `origin/main` and both copies now hash identically — but by a manual one-time act
    with a recurrence interval of *one PM fire*, which is the whole argument for the mechanism.
  - **Board hygiene:** LOOP-51 and LOOP-56 were the same W19 detector filed 15 minutes apart by PM and
    senior; merged toward the design child (LOOP-56) with the loser's unique content ported, not
    dropped. And LOOP-48's design gate never reached PM's `queue` at all — its labels predated its
    `Mode: design` conversion, so a pure-label filter served it to QA and hid it from its §21a owner
    (QA caught it and filed **LOOP-59**). Cancelling LOOP-12 would have false-unparked five tickets
    behind a Canceled blocker; all five edges were re-pointed to LOOP-58 in the same fire.

- **(operator, 2026-07-30) 📝 RULING — PM may land doc-only PROGRESS commits on `origin/main`, via
  `doc-land` only.** The Part-B question LOOP-36 was parked on is answered: **APPROVED (Option 1 +
  Option 4).** Verbatim scope — *"PM MAY push doc-only progress commits directly to
  `origin/<defaultBranch>` on this `landing:"pr"` repo, **exclusively via the B2 `dev-loop doc-land`
  verb once it ships**."* The operator's stated rationale, which bounds any future reading of this:
  direction-section content is already human-gated at the CONTENT level (§9a), progress sections are
  PM's pen by design, and the doc-PR alternative was **empirically refuted in this workspace** —
  docs queued behind six-days-red merge checks land *less* often. So this is not a review bypass; it
  is the §20 D4-autonomous write finally reaching the branch everyone reads. **Two fences are part of
  the ruling, not commentary:** (1) the pushed range must touch ONLY the configured `strategyDoc` +
  `strategy-archive/` — *"that assertion is load-bearing; treat any future widening of that allowlist
  as a NEW operator sign-off, not a follow-up"*; (2) until `doc-land` exists there is **no** manual
  push — PM commits and leaves it local. **Consequence recorded for the next fire that reads only
  this entry:** the pm-agent SKILL and §20 D4 still describe the commit-only shape, so a fresh PM
  boot re-derives the old behaviour from the SKILL rather than from this ruling. That prose is the
  operator's to apply (§17) and is deliberately deferred until `doc-land` merges — carried as
  **LOOP-60**, blocked on LOOP-57, to be re-parked `Human-Blocked` when it lands.

- **(pm, 2026-07-30) `data-analytics` lens — the metering arc's join key does not survive its own
  canonical write path.** Reviewed at product HEAD `e5669cb`, the just-merged metering foundation.
  The lens question was *"will the data this arc collects answer the operator's question?"* and the
  answer is: on the direct-db transports yes, on the daemon transports no — silently. `fireId` is
  read from ambient `process.env` **at the INSERT**, so it is stamped by whichever process performs
  the write; identity, by contrast, was deliberately carried env→header→daemon (`op-client.ts` sends
  `x-devloop-actor`, `daemon.ts:345` reads it back, commented as *"the only attribution the daemon
  trusts"*). The fire is present one hop from the write and dropped at exactly the hop already
  solved for identity. Filed **LOOP-61** (senior, p2) to carry it the same way, with the explicit
  constraint that it is **attribution, never authorization** — it must not touch the G1 phantom-actor
  guard — and a concurrency AC, since a module-global would let one request's fire id leak onto
  another's write. **Deliberately NOT filed:** `events` keeps `fireId` in a JSON blob with no column
  or index and is never pruned (`db.ts:117`) — at **477 rows** that is not a problem, and filing it
  would be padding. Re-examine when the LOOP-4 join is measurably slow. Method note for the next
  lens: the empirical `0 of 477 events carry a fireId` on this hub is **confounded** by the
  LOOP-38/W18 skew (installed 1.11.0 predates `e5669cb`, so this workspace has not started stamping
  at all) — it is recorded as a baseline, and the finding rests on the code path, not on that count.

- **(pm, 2026-07-30) Board note — a design gate's close is not a delivery.** Three tickets resolved
  this fire without anything shipping: LOOP-36 `Done` (gate + sign-off), LOOP-48 `Done`, LOOP-51
  `Canceled`. By §9c's letter that unparks LOOP-50, whose remaining AC none of them satisfies. The
  edges were re-pointed to the four tickets that actually deliver prevention (LOOP-54/55/56/57)
  rather than letting resolved *designs* read as a delivered *fix* — the same failure shape as the
  cancel-a-blocker false-unpark caught last fire, arriving from the opposite direction.

- **(pm, 2026-07-30) `trust-safety` lens — the loop's own telemetry writes the one thing its secrets
  module promises never to write.** Reviewed at product HEAD `e5669cb`. The lens question was *"where
  does this product's autonomy get to do harm the operator cannot see?"*, and the answer was not in
  any of the guard surfaces — it was in a **sink asymmetry inside a single function**. `recordFire()`
  (`run-agents.ts:766-789`) writes the same `extra` object to two places: the JSONL ledger builds its
  row by **spreading `extra` whole** (`:775`), while the hub `fire.completed` event three lines below
  **enumerates** the fields and forwards only `suspectError`/`errorClass`/`bootBytes` (`:786`). So
  `outputTail` — a raw 400-byte slice of the coding CLI's combined stdout+stderr, attached to **every**
  non-clean fire (`:1125`) — is dropped on one path and lands verbatim on disk on the other, in a file
  created **world-readable (644)**. Meanwhile `secrets.ts:16` states the invariant *"values are NEVER
  logged"* and `warnLoosePerms()` nags the operator to `chmod 600` the very file whose contents the
  fire's env is hydrated from. **The sharpest fact: nothing reads the persisted field** — `grep -n
  outputTail hub/src/*.ts` is writers-only; the breaker takes the tail as a function *argument*, and
  neither `metrics` nor `doctor` touches it. It is stored liability with zero consumers, and the
  populated case is the credential-adjacent one, since `classifyFireError()` exists to bucket auth and
  quota failures. Filed **LOOP-62** (senior, `sensitive`, p2) — with the minimal fix named in the
  ticket: stop spreading, enumerate like the sibling. Live evidence bounded honestly: 71 rows, 4
  carrying tails, and **no `secrets.env` on this workspace**, so this is a code-path finding, not an
  observed leak — the ticket says so explicitly, so nobody closes it on "I grepped the ledger and
  found no key."
  - **Two candidates examined and deliberately NOT filed, both because the code already says they are
    not defects.** (1) The operator-write guard (`cli-agentops.ts:188-198`) keys on env markers the
    agent itself controls, and the agent SKILLs instruct agents to `env -u DEVLOOP_DEV_SPLIT` for
    their own test runs — but the code comments it as a *"Cooperative accident guard … not
    anti-spoof,"* matching `tooldefs.ts:89`'s cooperative `doc.publish` role-gate. Filing it would
    re-propose a deliberate design. **Re-examine trigger:** a compound command that strips the markers
    *and* performs a board write in one invocation, or any real `operator`-attributed write traced to
    an agent fire — that is the guard failing at its own stated job, and is filable. (2) The daemon's
    write surface is **already** correctly walled — `writeOriginOk()` (`daemon.ts:196-204`) refuses a
    foreign/rebound `Host` and a cross-origin `Origin`/`Referer`, allows absent-both as the non-browser
    client, and the bearer path is `timingSafeEqual` (`ui-token.ts:23-28`). Recorded as swept so a
    future trust-safety rotation does not re-audit it.
  - **Method note for the next lens.** This is the second consecutive finding produced by the same
    move: **find a value that crosses two paths and diff how each path treats it.** Last fire it was
    `fireId` (carried env→header for identity, dropped for the fire); this fire it was `outputTail`
    (enumerated out of the event, spread into the ledger). A neighbouring call that solved the same
    problem correctly is the strongest available evidence that the gap is an oversight and not intent
    — and the inverse holds too, which is how both non-filings above were settled: when the code
    *documents* the weaker treatment as chosen, it is a design, not a defect.

- **(pm, 2026-07-30) `consistency` lens — the fix landed in one file; the defect class is still
  shipping in twenty-five places.** The product moved for the first time in three fires (`e5669cb` →
  **`768a2d8`**), so the rotation reset and the diff chose the lens. LOOP-58 removed *one* entrypoint
  guard. `hub/src` still carries **25 guards across 22 files in three mutually inconsistent idioms**,
  and each was tested directly rather than reasoned about: form 1 —
  `` import.meta.url === `file://${argv[1]}` `` (2 sites) fails on **both** a space and a symlink;
  form 2 — `pathToFileURL(argv[1]).href` (8 sites) survives spaces, **silently no-ops through a
  symlink**; form 3 — `fileURLToPath(import.meta.url) === argv[1]` (14 sites) has the same symlink
  hole. `import.meta.url` is realpath-resolved and `argv[1]` is not, so two thirds of the codebase's
  guards share one latent failure mode.
  - **The live one:** `seed.ts:94` is form 1 and is spawned as a node entry from **21 test files / 23
    call sites**. On a spaced checkout of merged `main` it exits **0, prints nothing, and creates no
    database** — measured; the clean path seeds normally. Any suite run from such a checkout fails
    downstream with errors pointing nowhere near the cause.
  - **The trap:** `doctor.ts:492` carries the same broken form but is **unreachable** — `dev-loop
    doctor` routes `["server","doctor"]` and `server.ts` *imports* `runDoctor`. Checked before
    claiming an outage: this is a dead-but-wrong guard serving as a copy-paste template, and the
    ticket says so, so nobody files it as a live break.
  - **The one that is only safe by accident:** `daemon.ts` is the sole spawned-detached entry among
    the form-2 sites, and it matches today **solely because `lcDaemonEntry()` derives the path from
    `import.meta.url`** — both sides realpath'd. Nothing documents or tests that coupling; a spawner
    change turns `dev-loop hub start` into a detached process that silently never binds the board.
  - Filed **LOOP-63** (senior, p2, `Mode: direct-code`) with a **verified** prescription rather than a
    plausible one: `realpathSync(argv[1]) === fileURLToPath(import.meta.url)` was measured `MAIN RAN`
    on real / symlinked / spaced / spaced+symlinked paths and correctly `GUARD BLOCKED` on import.
    First preference stays LOOP-58's shape (b) — delete the guard where nothing imports the module.
    Enforcement belongs in `test/consistency.ts`, whose own header says it exists for "drift classes
    that have already shipped twice"; this one has now shipped and been *half*-fixed once.
  - **Examined and deliberately NOT filed:** the "am I source or published?" decision
    (`fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts"`) is duplicated in 5 files —
    but all five are **byte-identical**, so it is duplication with zero divergence and no defect.
    **Re-examine trigger:** any sixth copy that differs, or a published-package bug traced to one of
    them disagreeing. Do not re-file on a future `consistency` rotation without that.
  - **Board bottleneck, stated as a fact rather than padded around:** the four unparks put junior at
    **14 unblocked Todo against a cap of 10**, so nothing was promoted to it — including **LOOP-46**
    (p2), which is what unparks the p1 **LOOP-38**. Senior has capacity (6/10 after LOOP-63) but its
    entire Backlog (LOOP-4, LOOP-38) is blocked, so senior-shaped lens findings remain the only way
    to feed it. LOOP-46 is first in the junior promote order the moment depth drops below the cap.

- **(pm, 2026-07-30) The LOOP-39 design gate PASSED, and the strategy-gaps lens found a documented
  config field with no implementation.** Product SHA `35479b9`; the lens rotation was reset by the
  two new commits.
  - **§21a design gate — LOOP-39 (`merge-review-guard`) passed on the merits.** The 22 KB design is
    coherent, cites its strategy parents (Goals → *agent skill robustness* + *harden the hub*;
    Vision → *steered by operator review (点评)*), and its four staged children decompose it 1:1 with
    no parent AC orphaned (AC1/AC2/AC5 → LOOP-64, AC3 → LOOP-65, AC4 → LOOP-66, PM's board-state
    fold-in → LOOP-67). Its load-bearing claims were **checked, not accepted**: `hub/src/landing.ts`
    genuinely does not exist on `origin/main`, so the `Blocked-by: LOOP-40` edges are real; the
    `push-guard` precedent it cites is real (`TICKET_RE`, the `resolveHubDbPath` + `SELECT state` DB
    pattern); all five `cli.ts` registration points exist and `ATTACH_OK` genuinely excludes
    `push-guard`. Promoted all four children `Backlog → Todo` **before** closing the parent (the
    §21a crash-safe order). **One correction recorded on LOOP-64 rather than failing the gate:** §6
    prescribed the entry guard `fileURLToPath(import.meta.url) === process.argv[1]` — the best form
    in the tree, and the exact form **LOOP-63** measured as symlink-unsafe. Shipping it would have
    made `merge-guard.ts` the 26th instance of a guard LOOP-63 exists to convert. Cancelling a sound
    design and four children over one line would have been wildly disproportionate; catching it
    before the code is written is what the gate is for.
  - **The §17 wiring now has a ticket instead of a report line — LOOP-69.** The guard ships
    *enforceable but unwired*: calling it from the fire-start merge pass means editing
    `conventions.md` §12c and `skills/dev-agent/SKILL.md`, which no agent may touch. That is now a
    pm-owned carrier, `blocked` on LOOP-64 + LOOP-65, which re-parks `Human-Blocked` to the operator
    the moment the mechanism it would wire in actually exists. The operator is **not** pinged yet, by
    design — the same posture as LOOP-60's §4.7 hand-off.
  - **The strategy-gaps finding: `defaultBranch` is prose all the way down.** Detail in **Current
    state** above. What makes it a *strategy* gap rather than a bug: the Goals section commits to
    **"Broaden portability"** and to outward adoption by legacy repos, and legacy repos are exactly
    the population still on `master`. The loop's own landing machinery — 15 references to
    `defaultBranch` across the §7 merge-back, §12b landing modes, and the §12c merge pass — is
    specified against a value the config layer cannot express, so every implementation reaches for a
    literal instead. Filed **LOOP-70** as `Mode: design` (§21b: one config field, one resolution
    function, two shipped call sites to clean up, two queued consumers) rather than as a two-line
    patch, because patching the call sites without landing the seam first just relocates the
    duplication.
  - **Method note, four fires running:** *find a value that crosses two paths and diff how each path
    treats it* — `fireId` → `outputTail` → the entrypoint path → now `defaultBranch`. The new move
    that made it pay this time: **read the governing docs as a specification and grep the code for
    every field they promise.** The §19 resolution table has eight rows; seven are implemented on
    `RepoEntry` and one is not, and that asymmetry was visible in a single grep.
  - **Board bottleneck, unchanged and worth repeating:** junior is at **14 unblocked Todo against a
    cap of 10**, so B2 promoted nothing to it for a second consecutive fire — including LOOP-46 (p2),
    which is what unparks the p1 LOOP-38. Senior had room and now holds LOOP-70 (7/10). **LOOP-40 is
    the highest-leverage ticket on the board:** LOOP-41, 42, 64, 66 and transitively 65 all wait on
    it, and it is p2, `Todo`, junior-assigned and unblocked.

- **(pm, 2026-07-30) 📝 DECISION — §3's "any triage hit ⇒ verify-fail" is read against the contract the
  ticket actually set, not against every gap the increment leaves.** Ruled on **LOOP-9**. The shipped
  increment left a real hole (`projects.<key>.agents` timeouts validated, documented and never applied),
  and I passed it anyway. **The reasoning, recorded because it is a precedent:** LOOP-9's own Context
  scoped itself as *"the per-agent config plumbing already exists for `codingAgent`/`model`/`effort`/
  `cadence` … this extends that same shape rather than inventing one"*, and the shipped code has exactly
  `cadence`'s reach — it **inherited** the hole, it did not introduce one. Against the contract the
  ticket set there is no MISSING/EXTRA/MISUNDERSTANDING in the *behaviour*. Cancelling a correct, tested,
  CI-green, already-merged increment over an inherited gap trades a real increment for a bookkeeping
  purity that helps nobody. **What the rule still binds:** the two deltas that *over-reached* the scope —
  a docs sentence asserting a false resolution order, and `E17` validating the unsupported form — got
  their own ticket (**LOOP-77**), routed senior because the fix requires ruling whether a per-project
  *cadence* is even coherent with one scheduler over N projects. **The general form:** when a triage hit
  falls inside a gap the ticket's own scoping paragraph pre-authorised, pass and file; when it falls
  outside, fail and supersede. Verdicts that pass on a hit must say so in the open, with the reasoning,
  so the operator can overrule cheaply — LOOP-9's does.
- **(pm, 2026-07-30) 📝 DECISION — W-code allocation is first-claim-wins by `created_at`, resolved
  against the BOARD, never against `doctor.ts`.** Three tickets held a live claim on **W19** while
  `doctor.ts` still emitted only W05–W16, because a claimed code is invisible in shipped code until its
  ticket lands — my own LOOP-49 gate ratified a duplicate on exactly that mistake and this entry
  corrects it. Rule going forward: **sweep open tickets for the code, oldest claim keeps it**, later
  claimants take the next genuinely unused code and say so in their handoff. Current ledger: **W17 →
  LOOP-41, W18 → LOOP-46, W19 → LOOP-56, W20 → LOOP-74.** This is the escape hatch the
  `decision-queue-observability` design already wrote (*"the reconciliation rule, not the literal
  integer, is the contract"*) — exercised, not overridden. The durable fix is an allocator; until one
  exists the sweep is the procedure.
- **(pm, 2026-07-30) 📝 DECISION — the allocator from the entry above is now filed (LOOP-88), because the
  sweep procedure failed a second time in the next fire.** LOOP-81 (LOOP-34's child C) claimed **W17**,
  already held by LOOP-41; reassigned to **W21**. That is two consecutive design gates catching a
  collision by hand. The pattern is now evidence, not anecdote: *a procedure that only works when a
  human-shaped reader happens to look is not a mechanism.* Both catches landed on a design gate, which is
  luck — nothing catches a collision between two tickets that never share a gate, and nothing catches it
  at merge. LOOP-88 puts every code in one registry, fails a test on a duplicate or an unregistered
  emission, and adds `doctor --codes` so "what is free" is a command. Explicitly **out of scope**:
  reserving codes for unlanded tickets — the registry cannot know about tickets; the goal is that a
  collision fails a test the moment the second one *lands*, instead of shipping. Ledger now: **W17 →
  LOOP-41, W18 → LOOP-46, W19 → LOOP-56, W20 → LOOP-74, W21 → LOOP-81.**
- **(pm, 2026-07-30) 📝 DECISION — a verify-fail on a stacked branch fails BOTH tickets, and the
  follow-ups are sequenced, not merged.** LOOP-14 branched from LOOP-13's branch; when LOOP-13 was
  Canceled, most of what failed in LOOP-14 was inherited. The tempting shortcuts were to fold both into
  one senior ticket, or to fail only the parent and let the child ride the fix. **Both are wrong.**
  §3 binds one close+follow-up per verified increment — a merged ticket loses the second increment's ACs
  and its own distinct defects (LOOP-14 violated *its own* spec line, "keep the tail-regex as the
  fallback", independently of anything it inherited). So: **LOOP-83** (claude lane) and **LOOP-85**
  (opencode lane), with LOOP-85 `blocked` behind LOOP-83 by a real §9c edge, because it must build on the
  corrected wiring rather than re-derive it. **The generalisable rule:** when a stack fails, fail every
  ticket in it, file one follow-up each, and encode the stacking as a blocker edge — never as an implicit
  assumption that whoever picks the second one will remember the first. And the `blocked` **label** goes
  on with the marker: the marker is the ledger, the label is what the dev queue actually filters
  (`agentops.ts:206,218`). Corollary applied to **LOOP-4**: both its `Blocked-by` edges pointed at the
  now-`Canceled` LOOP-13/LOOP-14, so they were re-pointed to LOOP-83/LOOP-85 — a `Canceled` blocker reads
  as *satisfied* to the §9c unpark rule, and LOOP-4 is the aggregation ticket, the one place where
  false-unparking would surface as honest-looking zeros in `metrics --usage/--cost` rather than an error.

- **(pm, 2026-07-31) 📝 DECISION — the run set is the operator's call, but the config must stop
  claiming agents that never fire.** Having found that `ops`/`reflect`/`communication` carry seeded
  cadences and have never fired, the tempting move was to decide the fix myself. Two reasons not to:
  the launch invocation (`dev-loop run --agents …`) is the operator's, and turning agents on changes
  ongoing model spend. So the fire splits cleanly: **the product bugs are mine to file** — LOOP-90
  (never silently drop a configured cadence) and LOOP-91 (a never-written lessons library and a
  zero-fire agent must be visible) — and **the ruling is the operator's**, parked as LOOP-92 with the
  per-agent cost read. My recommendation on that ticket is deliberately narrow: schedule **`reflect`
  only** (`--agents core,reflect`), because it is the one whose absence has a *correctness* cost —
  it is the sole writer of the lessons library every fire reads. `ops` is genuinely skippable while
  this repo has no deploy or health probes (the product already warns about probes-without-ops), and
  `communication` has no channel configured. **Dropping the three unused cadences from
  `dev-loop.json` is an equally honest answer** and is offered as option 3 — what is *not* acceptable
  is the config asserting one thing while the loop does another. **The generalisable rule this
  fire adds to the `validate-then-drop` family:** a config field can be well-formed, correctly
  spelled, semantically meaningful *and still inert* — so the test is never "does the schema accept
  it?" but **"which code path reads it, and over what set does that path iterate?"** LOOP-70 was a
  field with no code, LOOP-77 was a field read at the wrong scope, and this is a field read over the
  wrong set.

- **(pm, 2026-07-31) 🚫 DECLINED — daemon self-exit when its `hub.db` path vanishes.** The
  `daemon-lifecycle-hygiene` design (§6) surfaced this as the most robust, port-agnostic prevention
  for the leaked-daemon problem — the daemon would `process.exit(0)` once its backing DB has been
  absent for K consecutive periodic checks, reusing the existing WAL-checkpoint timer — and
  explicitly routed the call to PM/operator rather than building it. **Decided here rather than
  parked, because it is answerable on the merits:** it is the **only** one of the four candidate
  layers that changes **live-daemon runtime behaviour**, and its failure mode is exiting a *real*
  operator's board on a transient `existsSync=false` (an atomic DB rename, a backup, an FS hiccup).
  The three layers actually built — test teardown (LOOP-94), the `reap` verb and `/api/health`
  identity, and the port-probe warning (LOOP-95) — add risk only to test-only and
  operator-invoked-attended paths, and they already close the problem. Trading a bounded janitor for
  a mechanism that can kill a live board is a bad trade at any leak volume. **Deliberately not filed
  as a fast-follow either** — a ticket nobody should build is backlog noise, and an unfiled decision
  gets re-derived every rotation, which is why it is recorded here and on LOOP-53. Reopen only with
  evidence that the three shipped layers leave a real leak. **The rule worth keeping: prefer the
  layer whose blast radius is confined to test and attended paths over the one that is more elegant
  but reaches production runtime — and when a design surfaces that tradeoff instead of silently
  taking it, that is the design working.**

- **(pm, 2026-07-31) 📝 RULING — an unlanded PR under `autoMerge:true` is a STATE error, not a
  verify-fail. Do not `Cancel`, do not escalate; return it to `In Progress`.** Both tickets in this
  fire's verify queue arrived `In Review` with open PRs (LOOP-19 CONFLICTING, LOOP-26 CI-red on its
  own delta). The tempting move is §3's Cancel + supersede + route-up-to-senior. **That is the wrong
  reading.** §3's close-and-supersede machinery exists for increments that actually *shipped* and
  then failed their ACs — one verified increment per ticket, a failed one superseded rather than
  silently reopened. Nothing shipped here: §12b gates verification on *what is observable on the
  running env*, and nothing merged, so there was nothing to verify. Meanwhile §12c states exactly
  where such a ticket belongs and what happens next — *stays `In Progress`; a FAILED check ⇒ Dev
  reads the CI failure, fixes it, re-pushes (cap ~2 cycles → `fix-exhausted`)*. Canceling LOOP-26 and
  spending a senior-tier ticket on a one-line `boolean | undefined` fix would have destroyed a sound
  increment to satisfy the letter of a rule aimed at a different situation. **The generalisable
  test: before applying a fail path, ask whether the thing it is designed to close actually
  happened.** A verify queue is not a claim that work landed — under `autoMerge` it is only a claim
  that some agent moved a state. Corollary for the verifier: **`In Review` is an assertion to be
  checked, not a precondition to be trusted** — check the PR before checking the ACs, because a
  wait-state, a red state, and a landed state need three different responses and only one of them is
  a verdict.

- **(pm, 2026-07-31) 📝 RULING — doctor W-code collisions resolve FIFO by `created_at`; W20 and W21
  reassigned.** Grooming found **two live collisions on four `Todo` tickets**: LOOP-41 and LOOP-81
  both claimed **W17**; LOOP-56 and LOOP-74 both claimed **W19**. Neither was gate-caught — both
  pairs were sitting in the commitment queue waiting to collide at implementation time. Cause is
  exactly what LOOP-88 predicted: shipped `doctor.ts` on `origin/main` tops out at **W16**, so every
  filer who correctly computes "next free" against the source gets the same answer, and the source
  structurally cannot see codes claimed by unlanded tickets. LOOP-81's body literally reads *"next
  free number, **W17**"*; LOOP-74's hand-rolls a workaround in prose — *"take the next unused code if
  they shifted"*. **Allocation, by `created_at` — the same FIFO tiebreak §5 already uses for the pick
  order, so it needs no judgement and cannot be re-litigated:** W17→LOOP-41, W18→LOOP-46,
  W19→LOOP-56, **W20→LOOP-74** (from W19), **W21→LOOP-81** (from W17). Ties broken toward whoever
  already has ACs and test assertions bound to the literal string, since moving them means editing
  test expectations for no product reason. That is **4 collisions on 6 claimed codes** — the number
  that belongs in LOOP-88's justification, along with a hazard learned applying the fix: the CLI can
  retitle a ticket but cannot rewrite its description, so the two reassigned tickets now carry the
  new code in the title and the old one in their AC text, reconciled only by a comment. **A registry
  that allocates codes but leaves the body stale has moved the collision, not removed it.**

- **(pm, 2026-07-31) ✅ SHIPPED — the "comment-body search" item DEFERRED in the (operator,
  2026-07-02) Linear-parity scope entry is built; the surviving gap is corpus parity, not the
  feature.** That entry listed two deferred-but-real items. Both have now landed: the default
  `list_issues` limit + summary-field mode (`agentops.ts:176-181`, confirmed last fire) and
  **comment-body search** — verified empirically, not from the code: `dev-loop tickets --q
  METRICS_OK` returns LOOP-26, where that string exists only in a comment written this fire.
  Recorded as a new dated entry rather than an edit to the operator's own entry. **What replaces it
  on the parity lens is narrower and sharper:** the feature shipped on the *agent* path only, so the
  gap is no longer "can the board search comments" but "**the two search surfaces disagree, in both
  directions, and neither documents its corpus**" — LOOP-97. The standing DO-NOT-RE-PROPOSE list in
  that entry (cycles/estimates, due dates, milestones, saved views, reactions/threads, attachments,
  SLAs) is untouched and still stands.

- **(pm, 2026-07-31) 📝 DECISION — the board's search contract: one shared predicate, corpus =
  id + title + description + comments, terms whitespace-AND-ed.** Encoded directly into LOOP-97's
  ACs rather than left open, because it is answerable and leaving it open would make the ticket a
  design ticket for no reason. Any per-row scan cap becomes a **parameter of the shared helper**,
  applied identically on both paths and named in one place — which settles the `Q_DESC_CAP=5000`
  question without pre-judging the performance tradeoff LOOP-96 owns. **The scope boundary between
  the two tickets, drawn deliberately:** LOOP-97 owns *what `q` matches*; LOOP-96 owns *how many rows
  come back and which fields*. LOOP-96's own non-goals already reserved filter semantics for a
  separate ticket — this is that ticket, and each names the other. **The rule this adds to the
  `validate-then-drop` family:** the family so far has been *a config field nothing reads*
  (LOOP-70), *a field read at the wrong scope* (LOOP-77), *a field read over the wrong set*
  (LOOP-90), and *a param accepted and ignored* (LOOP-96). This is the fifth shape — **two code
  paths implementing the same user-facing concept against different corpora**, where each one's
  behaviour is defensible in isolation and only the diff is the defect. It is invisible to any review
  that reads one call site, which is why the method that finds it is *run the same input through both
  paths and compare the outputs*, never *read the code and reason about it*.

- **(pm, 2026-07-31) 📝 DECISION — the acceptance-rate contract: numerator and denominator are drawn
  from ONE population, the set of `In Review` exits in the window.** A ticket that reaches `Done`
  without an `In Review → Done` transition contributes to **throughput** and not to **acceptRate**;
  every exit edge out of `In Review` is in the denominator, derived as `from === "In Review"` rather
  than a hard-coded destination list, so a future state cannot silently shrink it. `throughput` keeps
  its name and value — it is a board-wide Done count and correct as such (this also **corrects
  LOOP-42's stated premise** that `throughput` "is the verify count"; evidence added there). Encoded
  into LOOP-98's ACs rather than left open: it is answerable, and the two failing surfaces are the
  CLI and the web view of the *same* number. **Scope boundaries drawn deliberately so three live
  tickets can share two files without colliding:** LOOP-98 owns the ratio arithmetic (both sites) and
  is barred from the human `board:` render line; **LOOP-42** owns that line plus `landed`;
  **LOOP-31** owns the `blocked now` tile and, as of this fire, the *parked population* on the CLI
  side too — LOOP-26 shipped the split but not the population, so it fell back into LOOP-31's scope.
- **(pm, 2026-07-31) 📝 The `validate-then-drop` family gains its sixth shape — and the first one a
  test suite actively conceals.** The family so far: *a config field nothing reads* (LOOP-70), *read
  at the wrong scope* (LOOP-77), *read over the wrong set* (LOOP-90), *a param accepted and ignored*
  (LOOP-96), *two paths, one concept, different corpora* (LOOP-97). The sixth is **a correct-looking
  metric whose test fixture encodes the same wrong assumption as the code**. `test/accept-rate.ts`
  is not thin — 30 assertions, boundary cases, empty-state, malformed-event, and it *correctly*
  asserts the mirror case on the denominator (`Todo/Backlog → Canceled` excluded). It cannot see the
  numerator bug because its only Done-emitting helper hard-codes `In Review → Done`. **The rule:
  coverage counts assertions, never the input space they range over — so when two independent
  implementations of one number agree, that is not corroboration, it is a shared assumption, and the
  thing to audit is the FIXTURE, not the code.** The cheap detector, which is what found this: take
  the metric's own definition, recompute it from the raw event ledger with a five-line script, and
  diff. Do not read either implementation first.
- **(pm, 2026-07-31) 📝 RULING — a `governing-file-edit` prerequisite parks for the human, and PM is
  bound by the same §17 firewall it enforces on Dev.** senior-dev filed **LOOP-101** asking that
  `references/config-schema.md` document the three `defaultBranch` surfaces LOOP-70 designs
  (`repos[].defaultBranch`, `team.git.defaultBranch`, `add-repo --default-branch`) — verified absent:
  `grep -n defaultBranch references/config-schema.md` → nothing, while `conventions.md:1478` already
  states the resolution chain. Classification `external-prereq` **upheld, not downgraded to
  `decision-needed`**: the blocker is a human commit to a governing file, not a decision PM is
  withholding, and PM may no more edit `config-schema.md` than Dev may. Parked `Human-Blocked`, owner
  `pm`, `blocked` kept as defence-in-depth, `needs-pm` dropped so it stops re-entering the unblock
  queue. **No `Blocked-by:` edge written, deliberately** — §9c edges name tickets, this prerequisite
  names a person, and a zero-edge ticket correctly never auto-unparks. It unparks when the operator
  commits. This is the working precedent for the whole `governing-file-edit` kind.

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
