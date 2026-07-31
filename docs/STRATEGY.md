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

- **(pm, 2026-07-31) 📝 RULING — a fix that moves no number today is still a PASS, when the ACs say
  so.** LOOP-30 shipped correctly and changed nothing measurable: on the live board `labelOnly ==
  resolved` for all four handles, because every open ticket currently carries both the assignee and
  the tier label. The tempting verdict is "unproven — send it back for evidence". That is wrong, and
  the ticket's own **AC5** is why: it explicitly required *no behaviour change when a handle carries
  both signals*, which is the common case today. **The increment's value is a latent failure mode
  removed, and a latent failure mode is by definition not visible in current data.** The general
  rule: when an AC predicts "no observable delta in the common case", a zero delta is the AC passing,
  not evidence missing — verify the *mechanism* (the resolved set now structurally contains what the
  router serves, `SERVED ⊆ RESOLVED`), not the *integers*. Demanding a visible number here would
  have taught the loop to only ship fixes for failures already in progress.
- **(pm, 2026-07-31) 📝 The ownership model now has three rules and no single home — and a process
  correction about where dedupe has to look.** Between LOOP-30 (landed) and LOOP-102 (filed), the
  answer to *"who owns this ticket"* is state-dependent: `Todo → union(assignee, label)`,
  `In Review → label` (the verifier, not the implementer whose assignee still points at them),
  `In Progress → assignee` (the claimant), `Human-Blocked → nobody` (a deliberate park; LOOP-74's
  surface, not W16's), and `blocked → excluded in every state`. Five rules across `metrics.ts`,
  `agentops.ts` and `views/activity.ts`, discovered one lens at a time. LOOP-102 requires them
  written into **one** comment beside the filter; if a third axis appears, that comment is the
  evidence the model deserves a named function instead. **The process correction, which cost real
  tokens this fire:** I wrote two "new finding" comments on LOOP-88 and LOOP-74 about the doctor
  W-code collision — both re-deriving a FIFO allocation two earlier fires had already made *and
  recorded in this log*, and mine undercounted it (1 collision vs the recorded 4-on-6). Cause: I
  deduped against the board (`--q` search, neighbouring ticket **descriptions**) and never against
  the ticket's own **comment history** or this Decisions log. `dev-loop ticket <id> --json` returns
  description *and* comments together — I printed only the former. **The rule going forward: before
  commenting on a ticket, read its comments; before filing a finding, grep this log for its
  keywords. The board is where work lives; this log is where rulings live, and a ruling re-derived
  is worse than one not made — it competes with itself.** Both comments were superseded in place
  rather than left to contradict the record.
- **(pm, 2026-07-31) 📝 Three rulings from the LOOP-78 design gate, one of which corrected the design
  against conventions.** Gate **PASSED**; children LOOP-104/105 promoted, parent `Done`. R1–R3 verified
  seam-by-seam in code at `origin/main` (`metrics.ts:110-121` incl. the `/^Blocked-by:\s*(\S+)/gm`
  regex at `:114`, `cli-agentops.ts:313`, `agentops.ts:206,218`), and `Unblocked-by:` confirmed to have
  **no code reader or writer anywhere** — 19 such lines exist in the comment corpus and the shipped
  parser reads none. **The correction: the design's R4 recorded *"unpark-eligible iff the live blocker
  set is empty OR every live blocker is terminal"*, which contradicts §9c:844-847 — "A ticket with ZERO
  blocker edges is NEVER an unpark candidate".** The shipped code already sides with §9c
  (`metrics.ts:115` early-returns on empty → parked); R4 was the lone dissenting artefact, and
  **LOOP-101** is the live instance — `blocked` with zero edges by design, its prerequisite being a
  person. Left uncorrected, the deferred auto-unpark mover would have inherited the rule and released
  it. Bound on the child, with the follow-up instructed to take the rule from §9c and amend the doc.
  **The method that produced it:** running both parsers over all 330 comments before ruling. That also
  showed the R2 relaxations (leading whitespace, case) add **zero** edges on the live corpus, and that
  the refactor moves **no number** (`blockedNow=1 / sequencedNow=13` under both) while the underlying
  sets shrink materially (LOOP-4 8→2, LOOP-50 5→2) — recorded as an explicit expectation so nobody
  demands a delta that shouldn't exist, the LOOP-30 precedent applied a second time. Two further gaps
  became binding ACs rather than a gate failure (proportionality): the **partial-retirement** case the
  parent's own AC1 names but neither child tested, and the unstated behaviour of an **indented/fenced**
  marker — the corpus holds **63 prose near-misses against 58 real markers**, so the anchoring rule R2
  relaxes is the one doing the most work.
- **(pm, 2026-07-31) ⚖️ RULING: a concluded-red required check on an unmerged PR is a send-back, not a
  §3 verify-fail — when the defect is fixable on the same branch.** LOOP-56's checks failed on a CRAP
  ratchet breach of **0.4**; the PR is `MERGEABLE`, the ACs appear implemented, and the branch is
  correct. §3's close-and-follow-up exists for an increment that is **wrong**; applying it here would
  discard a good branch and buy a re-implementation. So: held `In Review`, diagnosed precisely, ACs
  explicitly **not** accepted, and the fix directed at lowering `doctorWorkspace`'s complexity rather
  than merely raising its coverage — because three queued W-code tickets sit behind that same function.
  **The boundary this sets:** verify-fail is for wrongness; a red gate on unlanded work is unfinished
  ship-work owned by the implementer. Both increments handed off this fire moved to `In Review` with
  checks unresolved and both had a landing blocker — that is now the normal case, and it is exactly
  **LOOP-89**'s ground, so it was recorded there rather than refiled.
- **(pm, 2026-07-31) 📝 Tier routing held against a standing temptation.** junior has been over its
  depth cap for **eleven consecutive fires** (13/10 at close) while senior idles (2/10). LOOP-106 went
  to **senior** because §21b's `sensitive` bullet names *"data migration/**deletion**"* and the ticket
  is entirely about unattended irreversible deletion — the explicit signal, which happens to coincide
  with the idle capacity. The coincidence is worth naming precisely so it is not mistaken for a
  precedent: **re-tiering to balance load remains the inference §21b forbids**, and the imbalance is
  still what the rules produce, not drift. Only the operator can change that.
- **(pm, 2026-07-31) ⚖️ RULING: the boundary between a send-back and a §3 verify-fail is *whether the
  ACs have been evaluated*, not how green the branch looks.** Last fire I held LOOP-56 `In Review` on a
  concluded-red CI gate and recorded that *"verify-fail is for wrongness; a red gate on unlanded work is
  unfinished ship-work the implementer owns."* This fire LOOP-99 arrived looking similar — clean branch,
  `MERGEABLE`, checks pending — and got the **opposite** treatment. The distinction is exact and worth
  keeping: on LOOP-56 I had evaluated **no** AC, so the blocker was ship-work; on LOOP-99 I evaluated
  every AC against the actual diff and one was **unmet against a design-enumerated line**. §3 is
  unconditional there — *"any MISSING hit = verify-fail, even when the code is clean … never leave the
  original in `In Review`"* — so it closed and re-filed. **The cost is real and worth naming:** a
  95%-correct, green, mergeable branch became a Canceled ticket plus a new senior `direct-code` ticket
  for two mechanical deltas. The state machine offers exactly two verify outcomes — `Done`, or
  Cancel + follow-up + escalate — and no proportionate middle for *"right, but one AC short."* Checked
  before closing that this is survivable: `worktreeReap` deletes only the **local** branch
  (`worktree.ts:209-213`, no `push origin --delete`), so `origin/dev-loop/LOOP-99` and PR #61 survive and
  LOOP-107 continues rather than re-implements. Not filed as a conventions change — that is a §17
  governing file and two operator decisions are already stalled; recorded here as an observed cost.
- **(pm, 2026-07-31) 📝 A safety rule that survived only by luck, now made explicit.** §9c's asymmetry
  (*"a ticket with zero blocker edges is never an unpark candidate"*) was ruled last fire on its merits,
  for LOOP-101 — a park whose prerequisite is a person. This fire it silently absorbed a **second**,
  unrelated failure: a truncated CLI read that returns zero edges for a ticket that has three. Same
  output, opposite cause, and the rule made both fail safe. **The generalisation, bound onto LOOP-104:**
  a parser must be able to say *"I could not read this"* in a way that is not spelled the same as
  *"there is nothing here."* Encoding failure as an empty collection is what let a transient read error
  masquerade as a factual answer about the dependency graph. LOOP-104 is the loop's single canonical
  source for that graph and LOOP-105's read-only surface renders it, so the requirement lands there as
  an AC with a truncated-payload regression test — deliberately **not** as a change to §9c's ruling
  (which stands) nor as a second CLI ticket (LOOP-43 is merged and awaiting LOOP-38's deploy).
- **(pm, 2026-07-31) 📝 Method note: the re-read caught a whole increment, and a hypothesis died in
  30 seconds.** Two habits paid this fire. **(1)** The mid-fire board re-read surfaced **LOOP-99**
  hitting `In Review` *after* boot — junior-dev was mid-fire — and it became the fire's only verify.
  Seventh of eight fires the re-read changed the outcome. **(2)** On finding three parks with zero
  edges I reached first for *"LOOP-43, 64 KiB truncation"* and **measured it before writing it down**:
  file and shell-pipe reads returned the full payload at every size, killing that hypothesis outright.
  Only re-running the failing call with errors surfaced instead of swallowed produced the real signature
  (`Unterminated string at position ~8100`, `exit 0`) and the actual 8 KB threshold. The reflex worth
  keeping is narrower than *"verify before filing"*: **when a diagnostic returns an empty result, prove
  the read succeeded before believing the emptiness** — my resolver's `catch {}` turned three failed
  reads into three confident wrong answers, which is the same defect I then bound onto LOOP-104.
- **(pm, 2026-07-31) ⚖️ There is a THIRD verify outcome, and last fire's ruling was one case of it.**
  Last fire recorded the boundary as *verify-fail vs send-back*, turning on whether the ACs had been
  evaluated. That is right but incomplete. This fire produced a case that is neither: **the increment is
  correct, the ACs pass, and the ticket is simply in the wrong STATE.** LOOP-73 was green, mergeable and
  verified; nothing was wrong with it except that it sat in `In Review` under a config (`autoMerge:true`)
  whose §12c contract says it should have been `In Progress`. Cancel + follow-up would have destroyed a
  finished increment; holding it `In Review` — what I did for two fires — kept it invisible to the only
  tier that could land it. **The correct move was to restore the state the convention specifies and say
  why.** So the trichotomy is: *wrong* ⇒ §3 verify-fail (Cancel + follow-up); *unfinished ship-work*
  ⇒ send back to the owning tier with the failure named; *mis-stated* ⇒ restore the invariant, banking
  the verify so nothing is rebuilt. The evidence that this is a real category and not a rationalisation
  is that it worked in four minutes after two fires of holding. Not filed as a conventions change (§17
  governing file, two operator decisions already stalled) — recorded here and applied.
- **(pm, 2026-07-31) 🧪 Method note: three hypotheses, two killed by measurement, one survived and
  became a ticket.** The fire's centre of gravity was *"why has nothing merged in three fires."*
  **(1) Killed:** *"the fire-start merge pass never runs because §12c is gated on `git.autoMerge`, a key
  no mutator writes."* The runner logs refuted it outright — Step 0.5 has landed PRs #51, #52, #56, #58
  and logs `git.autoMerge:true` explicitly. **(2) Killed:** *"junior-dev is hung"* — a fire had been
  silent for ~19 minutes, but the ledger's own distribution says junior's **median** fire is 1375 s and
  its max 3037 s, so the run was entirely normal. Reporting that as a stall would have been a false
  alarm to the operator. **(3) Survived, with receipts:** running the shipped predicate against the real
  config returned `§12c: active=false` while the registry literally reads `"autoMerge": true` — two
  independent shape bugs (`o.git.autoMerge` vs the flat `RepoEntry.autoMerge` every mutator writes; and
  `repoList()` inspecting `{ref}` pointers that carry no repo facts). Latent, because `--assemble-boot`
  is off here — stated as such on the ticket rather than dressed up. Filed as **LOOP-109**. The reusable
  part: **two of the three fell to a cheap measurement taken before writing anything down**, and the
  survivor is the one where I ran the real code against the real config instead of reading it.
- **(pm, 2026-07-31) 🔗 A coordination comment loses to the pick order; an edge beats it.** Twice now a
  landing-order hazard was recorded as a comment and twice the ranking overrode it. LOOP-84 (p1) edits
  the same call site as LOOP-94 (p2), so §5 would hand junior the *later* ticket first — the exact order
  the comment warned against. LOOP-46 (W18) adds an eleventh W-code block to `doctorWorkspace`, already
  CC 64 / CRAP 90.4 against a threshold of 90 — no longer a prediction, since LOOP-56 added exactly one
  such block and both required checks failed on `max 90.4 > 90`. Both converted to real `Blocked-by:`
  edges this fire (LOOP-84→LOOP-94, LOOP-46→LOOP-56), which the §9c pass retires automatically on `Done`.
  **The rule: if a sequencing note would be wrong to ignore, it belongs in the graph, not in prose** —
  prose is advisory to a ranked queue, an edge is not.
- **(pm, 2026-07-31) ⚠️ I asserted a cause from a four-minute correlation, and it was wrong. Withdrawn.**
  Last fire's headline — *"what unstuck the loop was a ticket state, not code"* — survived a whole fire
  and a strategy-doc commit before I tested it. It fails on one line of the convention it cites: §12c's
  merge pass reads `gh pr list … is:open`, so **board state cannot gate a merge**. My own entry said
  exactly that two bullets earlier, about PR #61 on a Canceled ticket. **The refutation was already in
  the document, in my own words, and I did not connect it** — because the claim arrived attached to a
  win (three frozen fires ended) and wins are the claims that get audited least. What made it feel
  causal was a four-minute gap; what actually closed it was a senior-dev fire already running since
  01:18:45Z. **The rule I am adopting: a hypothesis that explains a success gets the same cheap
  measurement as one that explains a failure — and "I predicted X, then X happened" is a correlation
  until the mechanism is read.** Three hypotheses died to measurement last fire; this one was never
  put in the queue, precisely because it was the good news. Withdrawn in `Current state`, on LOOP-89,
  and here. **What survives is the narrower, verified claim:** `In Review` hides an increment from the
  only tier that can *fix* it — which is why LOOP-56 and LOOP-57 are still stuck while LOOP-67 landed —
  and that is now owned by **LOOP-112**, not by my state file.
- **(pm, 2026-07-31) 🧭 The negative set is the bug pattern, and this codebase has four of them.**
  LOOP-113 came out of one question asked against freshly-landed code: *which states does this guard
  NOT name?* `db.ts:30` enumerates 8 legal states as the "one source of truth" that "can never drift" —
  and then `agentops.ts:198`, `cli-tickets.ts:20`, `push-guard.ts:73` and `merge-guard.ts:15` each
  partition those 8 with their own hand-written **negative** literal. A source of truth that only the
  *domain* references, never the partitions over it, does not prevent drift; it just centralises the
  list that the partitions fall behind. `Human-Blocked` is the receipt: added later (DL-25), it landed
  on the permissive side of every set written before it, silently. **The generalisation worth keeping:
  when a set is defined by what it excludes, adding a member to the domain fails OPEN — so the review
  question is never "is this set right?" but "what is in the complement, and was any of it chosen?"**
  Ruled: fix the one axis that is wrong and make *its* partition exhaustive against `db.ts`'s exported
  list; the wider four-site unification is noted on LOOP-113 as deliberately out of scope, for a
  tech-debt pass — a correctness bug should not be held hostage to a refactor.
- **(pm, 2026-07-31) 🚦 The §21a design gate outranks the §5a depth cap, and that is correct.** Junior's
  unblocked `Todo` depth closed this fire at **12/10** — over cap — because passing LOOP-89's design gate
  promotes LOOP-110 + LOOP-111 as part of the gate itself (§21a: promote every staged child, *then*
  close the parent), not as a §5a paced promotion. Recorded so the overshoot is not read as a grooming
  error and "corrected" by a later fire: the two paths are different, and Job B2 promoted **zero** this
  fire, which is the right behaviour at cap. Both tickets filed this fire (LOOP-112, LOOP-113) went to
  `Backlog` and wait their turn behind the pick order.
- **(pm, 2026-07-31) 🔬 "Already shipped" was verified against the code and not against the output — for
  170 fires.** The very first PM fire on this workspace declined to file the operator's `quota
  errorClass` intake item, recorded above as: *"already shipped — `classifyFireError` already emits
  `spend-limit`/`rate-limit`/`auth`/`network`. Reported, not refiled (§8 dedupe-against-reality)."* That
  check was correct about the code and wrong about reality. The classifier exists, is well-built, and
  **has never once matched this workspace's failures**: 25 of 26 ledger rows are the string
  `session limit`, which none of its patterns name. A feature can be fully implemented, fully tested,
  and have a **0% hit rate in production** — and reading the implementation cannot tell you that. Only
  the ledger can. **The rule I am adopting: when deduping a candidate against "we already built that",
  the evidence is the output column, not the source file — `SELECT class, count(*)` before
  `git grep`.** This also sharpens the standing lens habit: *find a value that crosses two paths and
  diff how each path treats it* found LOOP-113 by comparing two code sites; this one needed a code site
  compared against **the data it actually produced**, which is a path I had not been walking. Ruled:
  fix the classifier + set membership only (**LOOP-114**); the durable defense — a health warning when
  the unclassified share of failures is high — is **deliberately not filed**, because it belongs in
  `doctorWorkspace`, the CRAP ratchet's #1 entry at 90.4 where LOOP-56 already failed CI adding a
  single W-code block. Banked in `Candidate ideas` until that function is split.
- **(pm, 2026-07-31) ⏳ A measurement decays, and a park built on one inherits the decay.** Last fire
  I made the right call the right way: LOOP-46 was deferred on a *measured* CRAP of 90.4 with LOOP-56's
  CI failure as corroboration — not a guess, not a vibe. It was still wrong one fire later, because
  **LOOP-56 landing is what fixed the number** (its tests took `doctorWorkspace` to 83.4% coverage →
  CRAP 82.9). The deferral and its own remedy were the same event, and I filed the deferral without a
  re-check condition. This is the twin of last fire's lesson rather than a repeat: that one was
  *"'already shipped' was checked against the code and never against the output"*; this one is
  **"checked against the output, but an output that has since moved."** Neither is fixed by measuring
  more carefully — both are fixed by **attaching an expiry to any ruling that cites a number: what
  would have to change for this to stop being true, and when do I look again.** For a park the answer
  is nearly always *"when the blocking ticket lands"* — which is precisely the moment the §9c unpark
  already runs, and the moment I did not re-measure. **Standing rule from here: a §9c unpark re-reads
  the measurement that justified the park, not just the edge.**
- **(pm, 2026-07-31) 🎚️ The repo's merge gate has no headroom, and its two nearest entries fail in
  opposite ways.** Measured on `origin/main` @ `2dc6c7b`: `isError` (`fire-usage.ts:48`) CRAP **90.0**
  vs threshold **90** — margin 0.0 — and `daemon.ts:449` at **86.7**. The first is a *coverage* defect
  (CC 9, 0.0% covered, no `hub/test/fire-usage.ts` exists at all) and one test file erases it. The
  second is a *complexity* defect (CC 86 at 95.4% covered) and **no test can touch it**, because
  `CRAP = CC²·(1−cov)³ + CC` never falls below `CC`. I nearly filed these as one ticket; they share a
  symptom and share nothing else. Filed as **LOOP-115** (junior, tests + a headroom warning so a
  zero-margin pass is legible in CI instead of silent) and **LOOP-116** (senior + `sensitive`, split
  the handler; its closure holds the bearer gate and the SAFE_KEY traversal guard). **Method note that
  generalises past this repo: when a gate is a formula, read the formula's floor, not just today's
  value.** A threshold of 90 is not a quality bar, it is a hard cap on the cyclomatic complexity of any
  single function in the codebase — which nothing in the repo states.
- **(pm, 2026-07-31) 🧾 §20 R2 ledger rollup executed — the live doc was 10× its own budget.**
  `docs/STRATEGY.md` had grown to **203 KB** against §20's ~20 KB trigger, with the Decisions log alone
  at 111 KB; PM re-reads the whole doc every fire, so that is a per-fire tax paid ~35 times so far.
  Rolled the contiguous **2026-07-30 pm fire arc** (796 lines, 71.2 KB) to
  [`docs/strategy-archive/2026-07.md`](strategy-archive/2026-07.md), leaving a one-line index entry and
  the actionable 2026-07-31 tail live: **201 KB → 133 KB**. Verified by byte accounting in both
  directions and by asserting every archived entry header is present in the archive — zero entries
  lost. Prior state carried a note reading *"doc rollup is done — do not redo"*; that referred to the
  2026-06 arc and was being read as a standing prohibition. It is not one: **the rollup is a recurring
  chore keyed on size, not a one-time migration.**

- **(pm, 2026-07-31) 🧭 STANDING RULE: a `Done` capability is verified against the workspace's OUTPUT,
  not only against its code — and filed ZERO tickets this fire, deliberately.** This fire's lens found
  that five `Done` metering tickets produce nothing here (183/183 ledger rows carry no `fireId`, no
  `usage`), because the *launcher* is 44 commits behind while reporting the *same version string*.
  Every one of those tickets was correctly verified: the code was right, the tests were right, the
  reviews were right. What nobody checked was whether the running system's output ever changed. This
  is the third variant of one failure in three fires — "checked against the code, never the ledger"
  (LOOP-114), "checked against the output, but an output that had since moved" (LOOP-46/CRAP 90.4),
  and now "checked against the code of a version that isn't the one running." **The generalization:
  every verification names an artifact, and the artifact must be the one the operator actually runs.**
  Where an increment cannot be exercised on this workspace, say so in the verify comment instead of
  inferring a pass — as done on LOOP-93 this fire, and warned ahead of time on LOOP-85 and LOOP-4.
  **On filing zero:** the junior tier is at **14 unblocked Todo against a cap of 10** and the Backlog
  stands at 30, so the binding constraint is throughput and deployment, not idea supply — padding a
  deep backlog would have made the report look productive and the loop no faster. The strongest
  candidate found (the `DEVLOOP_*` env-scrub idiom hand-copied across ~9 sites in 4 idioms with
  mutually inconsistent key lists) was **tested and declined**: the suite passes under a live fire env
  at `origin/main`, so it is a latent inconsistency with no measured failure, in a class that already
  has three shipped fixes and one Canceled duplicate (LOOP-47). Banked, not filed.

- **(pm, 2026-07-31) 🧭 A `Canceled` prerequisite is not a satisfied one — §9c unpark must key on
  *why* an edge went terminal.** Verify-failing LOOP-57 put a `Canceled` ticket under two parked
  tickets (LOOP-60, LOOP-50) whose only live edge it was. The literal §9c rule — *auto-unpark tickets
  whose blocker edges are all `Done`/`Canceled`* — would have released both onto a capability that was
  never delivered, which is the worst kind of unpark: it looks like progress and hands an agent a
  ticket whose premise is false. **Ruling: on a `Canceled`-because-superseded edge, retire the dead
  edge and re-point it at the successor in the same action** (`Unblocked-by: LOOP-57` +
  `Blocked-by: LOOP-119` + `Blocked-by: LOOP-120`), never unpark. `Canceled` legitimately clears an
  edge only when the blocker was *abandoned* — the work is no longer needed — not when it was
  superseded. Both readings are terminal states; only one means the dependent can proceed, and the
  board does not record the difference. Worth encoding in the W5/§9c tracker rather than leaving to
  each PM fire's judgement — banked as a convention question, not filed, because it is a §17 governing
  surface.
- **(pm, 2026-07-31) 🧭 Verify-failing merged code is the right call, and the follow-up must say
  "fix-forward, not rebuild."** LOOP-57's code is on `main` and cancelling the ticket does not unmerge
  it, which makes `Canceled` feel wrong. It is not: §3 leaves exactly two exits from `In Review`, the
  ACs do not hold in the field, and the alternative — marking it `Done` because the diff is good and
  CI is green — is precisely the failure this doc has now recorded four times in four fires (checked
  against the code, not the ledger / against a moved output / against a version that isn't running /
  and now against a fixture that dodged the case). What the close **must** carry is the distinction
  between a failed *ticket* and failed *work*: LOOP-119 opens by naming the merged increment sound and
  the fence, the finding split and the structure as keepers, so the successor is two edits and three
  test cases rather than a re-implementation. **Also ruled this fire:** the routing of a real AC miss
  up a tier (§3) is about the *class* of defect, not the implementer — the two-dot/three-dot trap
  caught the spec author, the implementer, and me, since I passed this file once already and missed
  line 101 myself. Said so on the ticket; a routing rule that reads as a demotion will make the next
  hand-off less honest, not more.

## Candidate ideas

_(The overflow parking lot: strong ideas not yet filed. **Rolled 2026-07-30** — ten completed /
filed / shipped / retired DL-era entries (16 KB) moved to
[`docs/strategy-archive/2026-07.md`](strategy-archive/2026-07.md); this list now holds only
candidates with an unfiled action. Earlier DL-1…DL-5 daemon/web-UI/roadmap-bridge ideas were filed
2026-06-23.)_

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
