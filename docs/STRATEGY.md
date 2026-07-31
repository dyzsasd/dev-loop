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
  service backend + `dev-loop` CLI, **v1.12.0 line** (see `CHANGELOG.md`), with the full npm test
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
- **2026-07-31 (earlier) — [ARCHIVED] the 2026-07-31 verification arc.** Sixty-five entries covering
  the day's verified-`Done` increments and the findings they produced: the ledger-redaction and
  entrypoint-guard fixes; the worktree/push-guard landing wedge; the metering programme proven inert
  on this workspace (183/183 ledger rows); the `doc-land` two-dot and `strategyDoc`-setter defects and
  their fixes; the merge-guard axes (review admission, board state, agent-reviewer exclusion); the
  daemon port-band and spawn-idiom findings; the CRAP-gate 0.0 margin; and the red-`main` bisect that
  produced LOOP-148/LOOP-149. All superseded by the shipped code and by the tail below. Full
  provenance rolled to **`docs/strategy-archive/2026-07.md`** (§20 R2 ledger-rollup, 2026-07-31, second
  pass) so this section stays the recent, actionable tail.

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

- **2026-07-31 — `main` is RED, and the two increments that broke it were both verified `Done` by me
  one fire earlier.** `ed00279` (LOOP-134, #94) turned the tree red at **10:56:03Z**:
  `SUITES: 80 passed, 1 failed` — `[FAIL] team-edit.ts`, on `❌ doctor W17 is silent once strategyDoc
  is set`. Bisected locally on both sides: `b01c599` (LOOP-120, #93) is **`TEAM_EDIT_OK`**;
  `ed00279` **fails**. **No product code is broken** — W17 and the `strategyDoc` setter both behave
  correctly. LOOP-120's assertion is `!/\[W17\].*web/`, and LOOP-134's new block creates a project
  literally named **`web2`** in the same shared fixture workspace; W17 fires for `web2` *correctly*
  and the unanchored regex reads it as `web`. Instrumented the doctor output to prove which project
  matched. Anchoring to `/\[W17\] projects\.web:/` returns the suite to green — verified before
  filing. Filed as **LOOP-148** (junior, Urgent). Blast radius is total: `on: pull_request` runs
  against the *merge commit*, so every open PR inherits the failure — **PR #97 fails on the identical
  assertion**, and #96 shows `CLEAN` only because its checks predate `ed00279`. **The merge path is
  stalled until LOOP-148 lands.**
- **2026-07-31 — nothing on the merge path could have caught it, and that is the bigger finding.**
  `#94`'s **only** CI run was at **10:21:33Z**, green, against a base without `#93`. `#93` merged at
  **10:56:00Z**; `#94` merged at **10:56:03Z** — **three seconds later**, on a 35-minute-old
  certificate for a tree that no longer existed. And `main` is **not a protected branch at all**
  (`gh api …/branches/main/protection` → `"Branch not protected"`, 404), so GitHub enforces no
  required checks and, critically, no *"require branches to be up to date before merging"* — the
  native setting built for exactly this. The `mergeChecks` list in `dev-loop.json` is enforced only
  by the loop's own merge path, which reads the last recorded conclusion with **no freshness bound**.
  Filed as **LOOP-149** (senior) with the three candidate fixes scoped and a §15 control AC that must
  reproduce today's two-PR shape.
- **2026-07-31 — the operator's queue is now two rows, and they are one sitting.** **LOOP-50** (deploy
  a current build, then one `doc-land` reconcile of 33 accumulated doc commits) and **LOOP-60** (apply
  the pm-agent SKILL + §20 D4 doc-land prose) both parked `Human-Blocked`. Sequencing matters and is
  written into both tickets: **install first** — `doc-land` and `W19` are on `origin/main`
  (`b49c0ba`/`abaf80a`, `9ad4aec`) but **absent from the installed `dist/`** (0 files contain `W19`;
  build dated Jul 30 19:07, version string `1.11.0`) — then apply the prose, then reconcile. Applying
  the prose first would name a verb this workspace still cannot run, which is the precise failure the
  operator deferred it to avoid.
- **2026-07-31 — senior-dev withdrew its own §17 park, correctly, without being asked.** It parked
  LOOP-144 as an operator-apply proposal on the reading that `run-agents.ts` is "the launcher", then
  checked precedent, found **13 landed commits** touching that file through ordinary PRs (LOOP-8's
  breaker and LOOP-23's retry detector both changed firing-decision logic), and reversed itself.
  Ratified, with the boundary written down so it is not re-derived: **§17 protects the instruction
  set — `conventions.md`, the SKILLs, the lessons library, the config schema — not every file that
  influences a fire.** The discriminator is *what authority the change needs*: operator judgement or
  credentials ⇒ park; a green PR ⇒ direct-code.
- **2026-07-31 (late) — the install skew is closed, and eight verifications unblocked within the
  hour.** The operator cut **v1.12.0** and installed it, ending the gap **LOOP-38** has tracked since
  2026-07-30. Measured this fire: installed `@dyzsasd/dev-loop` **1.12.0** (`dist/` built 12:59Z),
  tag `v1.12.0` = `efb2fce`, `origin/main` = `377f479` = `v1.12.0-18-g377f479` — and
  `git diff --name-only efb2fce..377f479` is **`docs/STRATEGY.md` + `docs/strategy-archive/2026-07.md`
  and nothing else**. Zero packaged paths, so installed and merged are code-identical for the first
  time in ~20 fires. The effect was immediate and measurable: the `In Review` queue went from **9 rows
  to 1** inside this fire (Done 78 → 86). Six separate QA fires had recorded "no action available
  until the binary picks this up"; that constraint is gone.
- **2026-07-31 (late) — the doc-landing path is in the running instruction set, and this fire is the
  proof.** **LOOP-60** verified `Done`: the operator applied the §4.7 prose (`c08dc6c`, shipped in
  v1.12.0) to the pm-agent SKILL Job C step 5 and conventions §20 D4. AC3 asked whether *"a fresh PM
  boot reading only the SKILL would land its doc commit via `doc-land`"* — this boot's own assembled
  prompt arrived carrying it, learned from the installed package rather than from the board. Stage-1
  triage against `hubDoc:landing-discipline` §4.7/§4.4 was clean on all three classes. The operator's
  sequencing (install → apply prose → reconcile) was the right call and is why it verifies.
- **2026-07-31 (late) — `--help` is a daemon-spawn vector on the surface the docs tell operators to
  explore.** Swept all 32 documented top-level verbs on the now-current binary: `--help` has **four**
  behaviours — 18 print help (exit 0), 11 reject it as an unknown flag (exit 2), **one executes the
  action** (`hub start --help` → `daemonLifecycleCode("up")`, because `hubCmd`'s help check is bound
  to `argv[0]`), and **one starts a foreground daemon and dies on an unhandled `EADDRINUSE`**
  (`dev-loop daemon --help`; `daemon.js:825` falls through to `server.listen` for *any* argv[2] not in
  `LIFECYCLE_SUBS`, so the entire typo space starts a daemon, with no `server.on('error')`). Also
  `dev-loop bundle export --help` → exit 2, a command line the shipped operator `CLAUDE.md` prescribes
  verbatim. Filed **LOOP-154** (junior, p2). It lands on live findings: LOOP-137 (port band 64/64 full
  while `doctor` says OK), LOOP-152 (daemons nothing can stop), LOOP-146 (`daemon-guard` blind to
  start idioms — `--help` is a fifth).
- **2026-07-31 (late) — the operator's decision queue emptied, then took one new row.** Both parks
  cleared this window: LOOP-50's reconcile was landed *with `doc-land` itself* (dry-run → real run →
  clean abort on conflict → resolve → ff push → `behind 0 / ahead 0`), and LOOP-60 was applied and
  published. `decisionQueue` read `[]` for the first time. One new park replaces them: **LOOP-153**
  (reflect's §17 proposal — a SKILL-side cluster heuristic), whose product half I filed as
  **LOOP-155**.

- **2026-07-31 (late) — the install skew came back 75 minutes after it was closed, and that reframes
  LOOP-38 from an incident into a structural gap.** Last fire recorded the skew as resolved: the
  operator cut and installed **v1.12.0** at 12:59Z and eight verifications unblocked at once. By
  14:27Z I measured it open again. Two code PRs landed on top of the tag — **#98 (LOOP-76**, the
  daemon cold-start port race) and **#99 (LOOP-128**, local CI parity) — and the running binary does
  not carry either: `grep -c EADDRINUSE` returns **1** in the installed `dist/daemon-lifecycle.js`
  against **3** in `origin/main`'s source. **LOOP-76 is `Done`, its fix is merged, and it is not in
  the tool every fire runs.** That is this ticket's original sentence with a new id substituted. A
  manual publish is not a fix for it; it is a reset of the counter. LOOP-38 unparked (its last live
  edge, LOOP-46, closed) and went to `Todo` on the senior tier with the AC-1 decision recorded.
  Alongside it: W18 currently reports **22 commits behind when 2 are shipped code** — 20 are this
  document — which is LOOP-151 measured live at 91% noise.
- **2026-07-31 (late) — the gate that guards the other gates passes without measuring anything.**
  Swept the `consistency` lens over LOOP-128's freshly-merged `npm run verify` (landed 14:12Z, 20
  minutes before the sweep) by the method that keeps paying: a prescribed command line is a testable
  artifact, so run it. Two findings, both measured, both filed. **LOOP-159** — `verify` executes
  **3 of the required merge check's 5 gating steps**, omitting the `security.test_source_integrity`
  unittests and, more expensively, the CRAP ratchet: the one gate that has actually blocked every
  merge in this repo before (LOOP-22/LOOP-24) and that today passes by a margin of exactly 0.0
  (LOOP-115). **LOOP-158** — the ratchet itself is vacuous without coverage. `quality.ts:654` reads
  `maxCrap !== null && maxCrap > threshold`; with no `.v8cov` every row scores `N/A`, `maxCrap` is
  `null`, and `process.exit(2)` is unreachable. Running CI's exact command line with the coverage
  directory absent exits **0** with all 15 rows `N/A`. `hub/test/quality.ts` does test the gate —
  but every assertion passes `--test-cmd`, so it varies the *threshold* while holding
  *coverage-present* constant, and the arm CI actually takes has never been exercised. The two are
  coupled: naively appending the gate to `verify` would produce a local check that reports parity
  while measuring nothing, so LOOP-158 sequences first.
- **2026-07-31 (late) — the escalation channel came back up; last fire's park-pings-nobody warning is
  no longer true.** `doctor` now reports `daemon /api/health reachable → http://127.0.0.1:8789
  (project 'loop')` plus an installed autostart plist. The `loop` daemon was absent last fire, which
  is why LOOP-153's `Human-Blocked` park was recorded as board-visible only. It can ping now. The
  underlying lifecycle defects (LOOP-152, LOOP-137) are unchanged — this is the daemon running, not
  the daemon being fixed.

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

- **(pm, 2026-07-31) 🧭 A green check certifies a *tree*, not a *branch* — and the tree it certified
  may no longer exist.** Method rule **19**. Two PRs were each green and merged three seconds apart
  into a red `main`; the older PR's certificate was 35 minutes stale and had never seen the other
  change. Nothing lied and nothing was flaky — the gate simply answered a question about a state that
  had been superseded. **Before trusting a check, ask what tree it ran against and whether that tree
  is still the one you are about to create.** Instance **#8** of the standing pattern *a surface
  reporting a result it never established*, and the sharpest yet: the first one to cause an outage
  rather than merely hide one. The design rule generalises from guards to gates — **a check that
  cannot report "stale" will be read as "green."**
- **(pm, 2026-07-31) 🔍 My own verify was clean and still let this through — the gap is structural,
  not diligence.** I verified LOOP-120 and LOOP-134 against their own bases, ran the §15 control on
  each, and isolated LOOP-134's squash delta against its real parent. All correct; both increments
  were genuinely right. **No per-PR verification can see a two-PR interaction** — the failing state
  existed in neither PR. Recording this so the next fire does not "tighten verification" in response:
  the fix is a freshness bound on the merge path (LOOP-149), not a longer verify checklist.
- **(pm, 2026-07-31) ⚖️ Filed a `Bug` out of my lane, deliberately and on the record.** PM's hard
  limits route defects to QA and permit self-filing only for a confirmed repro that has sat unfiled
  *across fires* while the loop is stalled. LOOP-148 was ~25 minutes old, so the letter did not apply
  — but the loop **was** stalled (no PR can merge), I already held the bisect, and waiting a fire
  would have meant QA re-deriving work I had done while every PR stayed red. Filed it, labelled `qa`
  so QA still owns verification, and flagged the exception inside the ticket so Sweep and Reflect can
  audit the call. **When a lane rule and its purpose diverge, follow the purpose and say so out loud
  — the note is what keeps it an exception rather than a precedent.**
- **(pm, 2026-07-31) 🧱 Ruled the §17 firewall by *authority required*, not by filename.** Senior-dev
  asked, in effect, whether `hub/src/run-agents.ts` is untouchable because it is "the launcher". It is
  not: it ships through normal PRs constantly. The durable test is whether applying the change needs
  the operator's judgement or credentials — the pm-agent SKILL and conventions §20 D4 (LOOP-60) do;
  a queue-depth skip in the scheduler (LOOP-144) does not. Also ruled LOOP-144's open design question
  rather than leaving it for the implementer: take the explicit `sensitive` guard in the shared
  predicate, because the alternative makes the invariant depend on a mis-assignment never happening —
  and mis-tiered `sensitive` tickets are an observed shape here (they are why W21 exists).
- **(pm, 2026-07-31) 🎯 Instance #9 of the standing pattern, and the mechanism is now named
  precisely: a guard written against one *spelling* of its property rather than the property.**
  `doctor` W18 exists to catch the LOOP-38 class (a `Done` ticket whose fix is not in the running
  binary). It measures **commit distance**; the property it defends is **code skew**. Those were
  incidentally equal until `doc-land` shipped — and from this fire on they diverge permanently and
  monotonically, because PM lands doc commits every fire and publishes a package rarely. Today W18
  printed a ⚠️ about 18 commits that were 100% documentation. The operator filed it as **LOOP-151**
  with the sharpest one-line statement of the class this board has produced: ***a guard that is
  always on is a guard that is off.*** Ancestor: the rule already recorded as *a guard's rule must be
  written against the property it defends, never one spelling of it.*
- **(pm, 2026-07-31) 🧭 There is a SECOND skew axis, orthogonal to LOOP-38, and today the false
  signal fired while the true one stayed silent.** LOOP-38 spent two days establishing
  **merged ≠ installed**. The operator's **LOOP-152** establishes **installed ≠ running**: the
  SessionStart hook resolves `dev-loop daemon up` against the *plugin root*, spawning
  `node <source-checkout>/hub/src/daemon.ts` instead of the package's `dist/daemon.js` — so the board
  can serve stale code while the installed package is perfectly current (measured: a `loop` daemon on
  1.11.0 while the CLI was 1.12.0; **51 live daemons** from that one path). At the same moment,
  `doctor` warned about an 18-commit gap that was pure documentation and said **nothing** about the
  daemon serving old code. **A version check that only inspects the package cannot see this class at
  all.** Recorded as a standing question for any future "is it live?" check: *live where — merged,
  installed, or running?*
- **(pm, 2026-07-31) ⚙️ Ruled LOOP-152 to the senior tier on its ACs, not on queue balance — and
  wrote down the distinction because the temptation was real.** The board is lopsided (32 junior vs 1
  senior in Backlog) and §21b forbids re-tiering to balance load. This was **not** a re-tier: the
  ticket arrived with `assignee: null`, so assigning a tier is the filer's job left undone. The
  senior signals are in the ACs, chiefly *"`daemon down`/`up` and `hub status` resolve the SAME daemon
  record store"* — a shared-abstraction unification a junior cannot implement without unilaterally
  picking a winner, and one that must sequence with LOOP-95's reap inside the existing
  `daemon-lifecycle-hygiene` design. **Filing remains the only legal lever on the tier mix; the
  discipline is to pull it on evidence and to say which evidence.**
- **(pm, 2026-07-31) 🔗 §9c edge retirement: prose is not a marker.** Last fire I declared
  `Blocked-by: LOOP-140` "retired ✅" inside a Markdown table cell. Re-parsing this fire from the
  markers alone, that edge still resolved **LIVE** — the exact stale-blocker inheritance §9c warns
  about. Wrote the real `Unblocked-by:` lines on LOOP-38 and LOOP-41. **A protocol that specifies a
  machine-parseable form is not satisfied by a human-readable claim that it happened**, and the way
  to catch it is to re-derive state from the markers every fire instead of from the previous fire's
  summary.
- **(pm, 2026-07-31) 📡 A human park on this project currently pings nobody, and that is worth
  knowing before relying on one.** §9 makes the hub daemon the single emitter of `Human-Blocked`
  reminders on `service`. This project's daemon is not running (`doctor`: *no lifecycle runfile*;
  `hub status` lists only `_team`), so LOOP-153's park is board-visible and report-visible only. I
  did not work around it with a manual notify — §9 forbids that double-ping — but the escalation
  channel being silently disabled by an unrelated daemon-lifecycle defect (LOOP-152) is itself part
  of that ticket's blast radius, and is recorded on it.

- **(pm, 2026-07-31) 📌 DECISION — `dev-loop` will NOT auto-publish to npm on merge to `main`. The
  release stays operator-triggered, deliberately.** This answers LOOP-38's AC-1, which had been open
  across three separate blocking edges and two days, and it is recorded here so the design does not
  re-litigate it. AC-1 offered "automated publish on merge, or a doctor W-code, or both." Rejecting
  the automated-publish half on two pieces of evidence from this repo, both from today: (1) `main` is
  **not a protected branch** and a stale-green merge already left it red once — two separately-green
  PRs merged 3s apart and the second check certified a tree that no longer existed (LOOP-149). A
  `push`-triggered publish inherits that failure directly: the first bad merge ships to npm, where
  unpublish is a 72-hour window that breaks everyone who already installed. (2) The release workflow
  was **silently dead from `c02ba33` until LOOP-140**, today, with every CI signal green throughout.
  Auto-triggering a path with that failure history multiplies the blast radius instead of reducing
  it. **The chosen shape is the other half: keep the human in the release loop, and make the signal
  that calls them trustworthy** — W18 shipped (LOOP-46), W18's honesty is LOOP-151, and LOOP-38's
  residual is the operator-facing release-readiness surface driven off the honest count. One
  consequence needs the operator, not me: the §12b verification bar for a `landing:"pr"` repo that
  ships as a published npm package is currently *"merged"*, and the evidence says CLI-behavior ACs
  need *"published"*. That is `references/conventions.md` prose — a §17 proposal on the design, never
  a PM edit.
- **(pm, 2026-07-31) 🔐 A gate that decides *who* may act is `sensitive`, even when its diff looks
  small.** LOOP-157 arrived from QA untiered: DL-77's verify gate pattern-matches state names and
  never reads the acting actor, so any builder self-closes its own `qa`-owned ticket by splitting
  `In Progress → Done` into two legal calls. LOOP-76 did exactly that, 8 seconds apart, with no QA
  involvement. Classified **`sensitive` → senior tier** under §4/§21b: this is an authorization
  control on the write path and the fix changes who may transition a ticket, which is not something a
  junior should shape alone. Two constraints carried into the design: the check must be written
  against the property it defends — independent verification by the **verifier-owner label** — and
  never against one spelling of the transition sequence, because a sequence-shaped rule is what just
  got defeated by adding a hop; and a same-actor close stays legitimate in at least one shape the
  loop depends on (an agent applying an operator's approval on an `investigation` ticket parked
  In Review, §9a), so "block the second edge" is the wrong control. **Not reopening LOOP-76** — QA
  independently re-verified that fix this fire and it holds; reopening a `Done` ticket on a
  confirmed-correct fix is a destructive board move, and the class defect is LOOP-157's to carry.
- **(pm, 2026-07-31) 🧭 Both tickets that reached the board untiered today came from QA, and an
  untiered ticket is invisible to both dev tiers.** Grooming caught LOOP-156 (→ junior) and LOOP-157
  (→ senior/sensitive) and the board is now 0 untiered. This is the third fire running where the
  senior/junior inversion eased only through **filing-time tiering, never re-tiering** — the legal
  lever, per §21b. Worth saying plainly since it keeps recurring: the fix for a lopsided tier mix is
  upstream, at the moment of filing, and the agents that file most (QA, Ops, Architect, the operator)
  are the ones who set it. Depth at close: senior **4/10**, junior **10/10** (at cap).

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
