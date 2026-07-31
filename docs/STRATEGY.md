# dev-loop — Strategy

> PM's north star. Historically seeded by the pre-1.0 `/dev-loop:init` on 2026-06-23
> (operator-present setup); current workspaces use `dev-loop team init` +
> `/dev-loop:add-project` + `/dev-loop:add-repo`.
> `Current state` was seeded once from a read-only code map; `Vision` / `Goals` /
> `Non-goals` / `Personas` come from the operator interview. PM owns this doc thereafter
> (append-only — record shipped progress and new direction here so it stays a living
> north star, not a stale snapshot).

## Vision

**The product is named Kaizen Factory. The engine is named dev-loop.** (Operator decision,
2026-07-31, recorded under the §9a pre-authorization on LOOP-174 — see the dated Decisions entry
for the full rationale and the verbatim-identifier list.) Two Toyota-lineage words that are the
product thesis verbatim: **改善 kaizen** — a system that improves itself in small, evidence-cited
steps, daily — and the **lights-out factory (黑灯工厂)** — a plant so automated it runs with the
lights off. This loop is literally both: reflect / lessons / §17 IS a kaizen routine, and the
operator reads one digest a day while the team ships. **Brand ↔ engine, like Code ↔ `code`:**
every technical identifier below keeps the `dev-loop` name, and the CLI command becomes `kaizen`
in a two-release phased rename (`dev-loop` remaining a permanent alias). Names in the rest of this
document that refer to the engine, the config, the state dir, or the label are therefore correct
as written and must not be brand-swept.

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

- **2026-07-31 (mid/late) — [ARCHIVED] the 2026-07-31 build + verification arc (32 entries).**
  The release-path red and its clearing, the merge-guard wiring, `main` going red and recovering,
  the two install-skew episodes, the trust-safety credential findings, the self-accept hole, W22
  landing-stall, W18's doc-only fix, and the `hub`/`daemon` seam decomposition. Every subject is
  verified-Done and superseded by the entries below. Full provenance in
  **`docs/strategy-archive/2026-07.md`** (§20 R2, third rollup of the day).
- **2026-07-31 (late) — the release landed, and for the first time in this loop's recorded history
  `dev-loop doctor` reports ZERO skew between the installed CLI and `origin/main` (v1.13.0,
  `d1ceabb`).** The operator ran the `Release npm package` workflow off `1c1a2fd` at ~20:00Z; it
  stamped the manifests, typechecked, tested and built the *stamped* tree, then committed
  `chore(release): v1.13.0` and published. Measured here at 20:1xZ: `npm view @dyzsasd/dev-loop
  version` → `1.13.0`, `dev-loop --version` → `1.13.0`, `kaizen --version` → `1.13.0`, doctor →
  `✅ [dev-loop] installed @dyzsasd/dev-loop v1.13.0 matches origin/main — no skew`. **LOOP-38's
  release gap, tracked since 2026-07-30 and re-stated as a standing operator ask in four consecutive
  PM reports, is closed on the CLI axis.**
  **Six verified-Done fixes stopped being dark in the same instant** — LOOP-157 (the two-hop
  In Review→Done self-accept), LOOP-181 (the `kaizen` bin + doctor W23), LOOP-41 (W22 landing-stall
  detection), LOOP-151 (W18 counting code-bearing commits only), LOOP-156 (`scrubFireEnv`) and
  LOOP-158 (the CRAP gate failing loudly on absent coverage). Every one of them had been merged,
  verified, and unable to affect a single fire on this workspace.
  Two things were checked rather than assumed. **(a) The release commit carries no CI run of its own
  and does not need one:** `release-npm.yml` runs `typecheck` → `npm test` → `build` *after*
  `release-version.ts` stamps the version, so the tree that got tagged is the tree that got tested;
  the separate `Test` run attaches to the pre-bump SHA. **(b) The "what version is this?" multiplicity
  query came back clean** — `hub/package.json`, `hub/package-lock.json`, `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json` and `CHANGELOG.md` all read `1.13.0`, and no source file hardcodes
  a version at all. Four sites, one answer. That query has now found a defect three times out of five;
  the two clean results are worth the same recording.

- **2026-07-31 (late) — and the skew is not actually closed: the daemons serving this board are still
  v1.12.0, doctor prints a green check for them, and the field it needs is in the response it already
  parsed (LOOP-195).** In the same second, against the same pid on the same URL:

  ```
  $ dev-loop doctor         → ✅ daemon /api/health reachable → http://127.0.0.1:8789 (project 'loop')
                              DOCTOR_OK · NEXT: dev-loop run
  $ dev-loop daemon status  → 'loop' RUNNING → http://127.0.0.1:8789 (pid 83869, v1.12.0, actor=operator)
                              — running OLD code v1.12.0, CLI is v1.13.0; run `dev-loop daemon up` to restart
  ```

  `/api/health` returns `{ok, project, version, actor}`. `doctor.ts:680` casts the body to
  `{ ok?, project? }`, asserts those two, and drops the rest; `daemon-lifecycle.ts:163-171` parses the
  same body into `{version, actor}` and `daemonStatus()` turns them into precisely the two warnings
  doctor omits. **Two surfaces answer "is the daemon serving this board current?" and only the one
  nothing tells the operator to run gives the answer** — the operator console mandates `doctor` before
  every unattended run and mentions `daemon status` nowhere.
  **This is the sharpest instance yet of the board's recurring defect, and the timing is the point:**
  W18 measures the *installed CLI* against `origin/main`, so it truthfully reported `no skew` on the
  very same doctor run where half the skew was still open. The release closed the CLI axis and left
  the daemon axis untouched and unmeasured. An operator who upgraded, ran the mandated pre-flight, and
  was told `DOCTOR_OK` had no way to learn their board was still served by pre-upgrade code. Filed as
  **LOOP-195** (`Bug`, junior tier): consume `version` and `actor` in `reconcileDaemonHealth`, warn on
  mismatch, stay silent when the field is absent — no field, no claim.

- **2026-07-31 (late) — the design gate ran in the direction it is *supposed* to run: the senior
  design corrected the filer's spec, and taking my own words literally would have shipped a
  regression (LOOP-168 → LOOP-199, gate PASSED).** My ticket's AC4 read *"the board-read sites route
  through a single resolver (`resolveHubDbPath()` or an explicit successor)"*. Applied literally at
  `doctorWorkspace`, that **breaks bundle export**: the same function is called from two places with
  opposite requirements — `doctor.ts:55` (must read the db `runDoctor` selected and announced) and
  `bundle.ts:201` (must read the workspace's *own* db and never follow an ambient `DEVLOOP_HUB_DB`).
  senior-dev found the dual-use, rejected the literal instruction, and substituted an optional
  `opts.boardDb ?? wsHubDb(ws)` — caller-selected where selection is wanted, safe by default where it
  is not. **Worth recording because the gate is usually described as PM catching a bad design; here
  the design caught a bad spec.** Every referent the design named was opened and confirmed at HEAD
  before the pass (the standing rule: a design that says *"do it like `<file>`"* inherits every defect
  of `<file>`), and that is exactly how the next entry was found.

- **2026-07-31 (late) — a safety gate that cannot fail: `bundle export`'s doctor refusal has been dead
  code since 19:02Z and shipped in v1.13.0 (LOOP-200).** `bundle.ts:201` reads
  `if (!doctorWorkspace(ws) && !o.force) die(…)`. `doctorWorkspace` became `async` in `460f5cf`
  (LOOP-41's W22 work, 19:02Z), so the condition negates a **Promise** — always truthy — and is
  permanently `false`: a workspace failing its own health check exports anyway, and `--force` gates
  nothing. The refactor updated the caller it could see (`doctor.ts:55` gained both `await` and `.ok`)
  and left the second one behind. Two faults stacked, which is what makes it durable: **adding
  `await` alone does not fix it** — `!{ok:false}` is still `false`.
  **Why nothing caught it, measured with the repo's own `tsc` under the same `strict: true`:**
  `if (f())` errors **TS2801** (*"this condition will always return true…"*), but `if (!f() && !force)`
  — the shipped form — and `if (!(await f()) && !force)` — the naive fix — both typecheck **clean**.
  The negation that causes the bug is the negation that hides it, and the half-fix is invisible too.
  So the regression test is not belt-and-braces here; it is the only guard, and the ticket is written
  fail-before/pass-after against it. This is the standing pattern *a surface reporting a result it
  never established* in its purest form yet: the gate does not report a verdict loosely, it **cannot
  compute one**.

- **2026-07-31 (late) — two clean results, recorded because a clean result is evidence too.**
  **(a)** The general form of the LOOP-200 query — *"which other un-awaited `async` calls exist?"* —
  was run across all **114** `async` functions declared in `hub/src`, over `src/` **and** `test/`.
  After discarding the false positives (`.then()` process entrypoints; same-named *synchronous*
  helpers — `docstore.ts`'s `docSave`/`docPublish`, `hub-lifecycle.ts`'s local `team()` `spawnSync`
  arrow), **`bundle.ts:201` is the only real one**. The sync→async-refactor blast radius is one site,
  not a class. **(b)** `ab20afe` (LOOP-185) added `hub/test/daemon-ws-resolve.ts` with **no**
  `package.json` script — which on many repos means a test that never runs. Here it does run:
  `run-all.ts` globs every `hub/test/*.ts` minus an explicit, reasoned `NON_SUITES` map, and LOOP-139
  already added a `--list` surface asserted against `git ls-files`. Nothing to file.

- **2026-07-31 (late) — LOOP-195 confirmed still live, against the commit that looked most likely to
  have pre-empted it.** `ab20afe` (LOOP-185, "workspace-aware run-dir resolution for bare daemon
  verbs") lands in exactly the daemon-lifecycle neighbourhood LOOP-195 sits next to, so it was checked
  rather than assumed: it touches `hub/src/daemon-lifecycle.ts` + two test files and **does not touch
  `hub/src/doctor.ts` at all**. Doctor's `reconcileDaemonHealth` still drops the `version`/`actor`
  fields `/api/health` returns. The ticket stands as filed.
- **2026-07-31 (late) — the north-star doc is bounded again, and this time the rules were kept
  while the provenance left.** `docs/STRATEGY.md` had reached **165,079 B — 8x the ~20 KB §20
  budget** — four hours after the day's second rollup, because ~20 PM fires a day each append to
  two sections. Third R2 rollup executed: **165,079 -> 74,334 B (-55%)**. `Decisions` 78,542 ->
  29,346 B, `Current state` 54,871 -> 17,465 B, `Candidate ideas` 16,299 -> 12,210 B. **120 entries were
  accounted for mechanically — 35 kept, 85 archived, 0 lost** (verified by matching every removed
  entry against `docs/strategy-archive/2026-07.md` before the commit). The §20 D4 gate passed
  against **both `HEAD` and `origin/main`**: 8/8 sections, preamble byte-identical, all three
  DIRECTION sections byte-identical, deltas confined to `Current state`, `Decisions` and
  `Candidate ideas`. **What is different about this pass:** the previous two rollups moved
  provenance out and left the live log a thin index. This one first DISTILLED the archived arcs
  into a 14-rule **"Standing rules in force"** block, so the rules that still govern fires survive
  at ~5% of their prose cost — and it **explicitly RETIRED two rules that had gone stale**
  (see the Decisions entry below). An archive nobody re-reads is only safe if what it held that
  was still true came back out first.
- **2026-07-31 (late) — board quiet, and the one operator ask is unchanged.** Verify 0, unblock 0,
  `needs-pm` 0, `Human-Blocked` 0, `_team` carrier 0 — sixth consecutive fire with nothing waiting
  on the human. In Review is LOOP-166 + LOOP-185, both `qa`-owned and correctly not mine. §9c
  tracker: 3 edges checked, **0 unparked, 3 held** (LOOP-186<-LOOP-185 In Review; LOOP-137<-LOOP-95
  Todo; LOOP-105<-LOOP-104 Todo). Depth junior **11/10 (over)**, senior **7/10** with an **empty
  senior Backlog**, so Job B2 promoted 0 and groomed only. The daemons on this workspace still
  serve **v1.12.0** code under a v1.13.0 CLI (`daemon status` says so, `doctor` does not — that gap
  is LOOP-195, still Backlog); the 10-second fix remains `dev-loop daemon up` for `loop` + `_team`.
- **2026-07-31 (late, +1) — the product moved, and the operator's one action line was found blind
  to the operator's own verdict.** `78584f5` (LOOP-167) landed on `origin/main` — doctor now promotes
  W18's shipped-code skew into the `NEXT:` line. Reviewing that surface on the **ux-flows** lens
  produced two reproduced defects in the same release-readiness flow, both filed: **LOOP-202** —
  `dev-loop doctor` prints `NEXT: dev-loop run` one line under `DOCTOR_FAILED`, because `nextStep()`
  never receives `ok`; a failed run and a healthy run emit a byte-identical NEXT line (reproduced on
  two independent ❌ classes — a missing repo path, and the §17 guard for a hub DB about to be
  committed). **LOOP-203** — W18 prints a green `✅ … matches origin/main — no skew` off a
  remote-tracking ref it never refreshed; A/B on one workspace at one instant, ref at the release
  commit vs fetched, flips `no skew` to `3 code commits behind` and silences LOOP-167's new
  `cut a release` hint. Third filing, **LOOP-204**, discharges a §20 parking-lot entry: **64 of 82
  failed fires (78%) carry no `errorClass`**, so the LOOP-8 provider breaker is inert for four
  failures in five while the window meters **$338.71**.
- **2026-07-31 (late, +1) — board state.** Verify 0 (In Review is LOOP-167 + LOOP-166 + LOOP-185, all
  three `qa`-owned and correctly not mine), unblock 0, `needs-pm` 0, `Human-Blocked` 0, `_team`
  carrier 0 — **seventh consecutive fire with nothing waiting on the human**. §9c: 3 edges,
  **0 unparked, 3 held**, unchanged. Depth junior **12/10 (over)**, senior **7/10** against an
  **empty senior Backlog**, so Job B2 promoted 0 and groomed only. Backlog label integrity swept
  clean (0 of 44 malformed) and the tier split is **44/44 junior — now 47/47** with this fire's three;
  §21b forbids re-tiering to balance load, so it is filed honestly and reported, not rebalanced.
- **2026-07-31 (late, +2) — shipped since the last fire, and one of the two did not survive verify.**
  Two code commits landed on `origin/main`: **`af5a0e1`** (LOOP-183 — the verify gate's Vector A
  label-strip close and Vector B create-as-Done sink, both closed) and **`5350a75`** (LOOP-74 —
  doctor **W20**, the operator decision-queue warn plus the decision-first `NEXT` clause).
  **LOOP-74 verify-FAILED and is `Canceled`, superseded by LOOP-207** — the code stays on `main`
  (it is a net improvement over silence; the follow-up carries one field, not a revert). The
  **LOOP-180 `/kaizen` design gate PASSED with two amendments**, promoting **LOOP-205** and
  **LOOP-206**. Two new filings: **LOOP-207** (senior direct-code) and **LOOP-208** (senior,
  `sensitive`).
- **2026-07-31 (late, +2) — board state.** Verify **0 at close** (In Review is LOOP-183 + LOOP-167 +
  LOOP-166 + LOOP-185, all four `qa`-owned and correctly not mine), unblock 0, `needs-pm` 0,
  `Human-Blocked` 0, `_team` carrier 0 — **eighth consecutive fire with nothing waiting on the
  human**. §9c: **4 edges** (LOOP-206←LOOP-205 new this fire, LOOP-186←LOOP-185, LOOP-137←LOOP-95,
  LOOP-105←LOOP-104), **0 unparked, 4 held** — every blocker non-terminal. Depth at close: junior
  **10/10 (at cap)**, senior **8/10**, total 18, Backlog **46**, label integrity **0 of 47
  malformed**. The tier split is no longer 100% junior: **LOOP-208 is the senior Backlog's first
  entry in days**, filed senior on the `sensitive` override, not to balance load.
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
- **Kaizen Factory** — the product's commercial name (prose, title case; slug
  `kaizen-factory`). Use it when speaking about the PRODUCT.
- **dev-loop** — the engine name, and the name of every technical identifier: npm
  `@dyzsasd/dev-loop`, `dev-loop.json`, `DEVLOOP_*` env, `.dev-loop/` state dir, `dev-loop/<id>`
  branch prefix, `/dev-loop:*` slash commands, and the `dev-loop` §2 safety label. Use it when
  speaking about a COMMAND, CONFIG KEY, PATH, or LABEL. These are VERBATIM — never brand-swept.
- **`kaizen`** — the CLI command, from the phased rename (LOOP-181 Phase A ships the bin,
  LOOP-182 Phase B flips the prose). `dev-loop` stays a permanent working alias, never removed.

## Decisions (running log)

- **2026-06-14 → 06-27 — [ARCHIVED] the 2026-06 milestone arc** (daemon foundation DL-1..DL-5;
  the standalone-daemon + multi-CLI repositioning P1..P5 incl. the MCP↔daemon dispatch unification,
  npm packaging, Codex certification; the hub buildout; the two-tier Dev split). All verified Done and
  superseded by **Current state**. Full provenance rolled to **`docs/strategy-archive/2026-06.md`**
  (R2 ledger-rollup) so this live log stays the recent, actionable tail.
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
- **2026-07-31 (mid-arc) — [ARCHIVED] ~54 rulings and method notes from the day's middle PM fires**
  (the release-gate arc, the merge-guard wiring, the integrity-audit doctrine, the tier-inversion
  rulings, the §9c marker/label split, the `sensitive` gate call, and the reflect-quota ruling).
  All settled or superseded; full provenance rolled to **`docs/strategy-archive/2026-07.md`**
  (§20 R2, third rollup of the day). The rules from that arc that are **still in force** are
  distilled immediately below — read those, not the archive.
- **🧭 STANDING RULES IN FORCE (distilled 2026-07-31 from the archived arcs — this block replaces
  ~54 KB of provenance).**
  1. **A guard's predicate must be invariant under the operations its own workflow performs
     routinely.** `push-guard` keyed passenger detection on SHA ancestry in local `main`, while the
     workflow it guards tells agents to rebase onto `origin/main` — rebase rewrites SHAs.
  2. **When the ambiguity a §3 triage hit exploits is in PM's OWN acceptance criterion, passing is
     mandatory, not discretionary.** My ticket is also a claim; ambiguity I wrote is my defect.
  3. **A design gate promotes EVERY staged child, even blocked ones — and an increment whose ACs
     pass but which cannot land goes back to `Todo`, never `Canceled`.** (§21a + §12b.)
  4. **Integrity audits deny by default.** Extending an allow-list by the two names that leaked
     only moves the hole; the audit must refuse what it does not recognise.
  5. **An AC that the same ticket's own "Out of scope" section contradicts is a PM defect, and the
     implementer gets the benefit of it.**
  6. **A mutator that discards input and reports success is a CORRECTNESS defect, not a UX one** —
     and it outranks the missing capability next to it.
  7. **Before filing "X is undocumented / unwired", check whether the SIBLING surface is right,
     then check whether the FIXTURE is.** Two tickets came from that pair of questions alone.
  8. **A guard can go green by moving the code out of its own field of view** — and the diff that
     builds the guard is the one most likely to do it. Verify a guard against the tree it passes.
  9. **Tier at FILING time; never re-tier to balance load (§21b).** Assigning a tier to a ticket
     that arrived `assignee: null` is not a re-tier — it is the filer's job left undone.
  10. **§9c: prose is not a marker.** An edge is retired by a machine-parseable `Unblocked-by:`
     line, never by a ✅ in a table cell; a protocol with a parseable form must be written in it.
  11. **A gate that decides WHO may act is `sensitive`, even when its diff looks small.**
  12. **A P1 `Improvement` is not a prioritised ticket** — §5 ranks type first, and priority only
     elevates at rank 1 (`priority=1` + `Bug`).
  13. **A `Blocked-by:` marker and the `blocked` label are different mechanisms and only the LABEL
     stops a pick** (`servableSlice`/`todoDepth` read the label; §9c reads the marker). Open as
     **LOOP-190**.
  14. **Reflect's one-ticket-per-fire quota is severity-ORDERED and loss-PROOF:** everything it
     could not file is listed under `## Deferred findings`, and PM triages every entry in the fire
     that reads it (§17).
  **RETIRED, do not re-derive:** *"a new `hub/test/*.ts` is a two-file change, the second being
  `hub/package.json`"* — superseded by `run-all.ts`'s glob discovery (LOOP-138/LOOP-139): a new
  test file with no `package.json` script now runs. *"The release gate is the loop's single
  blocking constraint"* — v1.13.0 published 2026-07-31T20:06Z; the constraint is retired and the
  live successor is the DAEMON skew (below), not the npm one.
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
- **(operator, 2026-07-31) §12b amended — "merged" and "running" are different states, and a
  verifier must name which one it established.** LOOP-170 applied as `13bbc89`. Two positions were on
  the table and the ruling chose between them. senior-dev's original — make **"published"** the bar
  for CLI-behavior ACs — was **declined**. PM's amendment — stop *conflating* the two states, require
  the verifier to say which it established, and forbid "verified live" for anything only merged — was
  adopted, plus an operator clause pinning that **publishing stays an operator act and a `Done` never
  waits on it**. The reasoning for the decline is worth keeping so the branch is not re-proposed from
  the prose alone: publishing is operator-triggered by prior ruling (LOOP-38 AC-1), so a blocking
  publish bar would stall every CLI fix's `Done` behind a human act — the §12b human gate
  reintroduced at ticket granularity — and would additionally park LOOP-144-class tickets `In Review`
  for hours accumulating exactly the wait-state re-check noise that is already error-prone.
  **Do not re-propose "published" as a blocking close bar.** The visibility half proceeds unchanged:
  LOOP-151 (honest skew count) → LOOP-167 (release-readiness NEXT hint). The rule's own recursive
  footnote holds — it is not in the installed package, so today it binds the operator, this log, and
  anyone reading LOOP-170, but *not* the verifiers it addresses.
- **(pm, 2026-07-31) 📝 DECISION recorded: the product is named Kaizen Factory; the engine keeps
  the dev-loop name; the CLI command becomes `kaizen` over two releases.** Operator decision
  (LOOP-174, W3 intake), superseding an earlier "Dark Factory" candidate that collided with an
  active same-space npm product. **Name facts verified 2026-07-31:** npm `kaizen-factory` and
  `kaizenfactory` are both free; bare `kaizen` is a dead 0.1.5 stub declaring **no bin**, so
  nothing else claims `kaizen` on a developer's PATH. Domains/trademark are operator-side, out of
  loop scope. **The two-layer rule:** brand = Kaizen Factory, engine = dev-loop; the npm package
  name, `dev-loop.json`, `DEVLOOP_*`, `.dev-loop/`, `dev-loop/<id>`, `/dev-loop:*`, and the §2
  safety label stay VERBATIM — each of those is a separate future decision and none is user-visible
  typing. **This edit is a Vision (direction) change made WITHOUT an investigation round-trip
  because LOOP-174 carries the operator's explicit §9a pre-authorization for exactly this edit,
  citing that ticket** (§20 D4 — the standing rule is unchanged; this is an authorized instance of
  it, and the D4 audit trail is the ticket).

  **Why the CLI rename is phased, which is the load-bearing part of the decision.** A workspace's
  `.claude/settings.json` carries `Bash(dev-loop *)`, written once at init and never updated by an
  npm upgrade, while fires read their prose from the INSTALLED package. A single-release rename
  therefore breaks every already-initialized workspace the moment it upgrades: the prose says
  `kaizen queue`, the shell has the bin, the permission allow-list does not — denied, and the agent
  cannot reach the board at all. That is the LOOP-69 wedge and the LOOP-38 installed-vs-source class
  in one. **Phase A** (LOOP-181) ships the `kaizen`/`kaizen-hub` bins, provisions BOTH permissions
  at init, tops up existing workspaces through the existing `team repair` verb, and adds a warn-only
  doctor check — prose unchanged. **Phase B** (LOOP-182) flips the prose one release later, gated on
  `kaizen --version` actually resolving in a fire's environment here — published and installed, not
  merely merged (§12b).

  **Two consequences worth recording as direction, not just as tickets.** (a) Phase A was tiered
  **senior + `sensitive`** against the intake's junior estimate, because its ACs write into a
  permissions allow-list and §21b routes permissions work to senior unconditionally. (b) Phase B is
  **mostly not agent-appliable**: ~175 of its occurrences live in `references/` + `skills/`, and
  §17 forbids an agent auto-rewriting `conventions.md` or a SKILL file — so it splits into an
  agent-applied generator/test change and an operator-applied prose diff, on the same
  propose→operator-applies→agent-verifies path LOOP-161 / LOOP-164 / LOOP-170 already ran. The
  brand's load-bearing claim — "improves itself" — gets its evidence surface in the `/kaizen` panel
  (LOOP-180, senior design-gated), rendered from the board and ledger only, with honest empty
  states. **Nothing is built yet; `Current state` is deliberately untouched.**

- **(operator, 2026-07-31) The Kaizen Factory tagline is chosen — _"The lights-out dev team that
  improves itself."_ — and the runner-up is grafted rather than discarded (LOOP-179).** PM drafted
  five candidates on five deliberately different angles; the operator picked **A** on the ground
  that a brand-new commercial name has to explain itself, and A is the only one doing all three
  jobs at once: it **decodes "Factory"** (lights-out), **names the category** (dev team — without
  which "Kaizen Factory" cold-reads as manufacturing consulting), and **states the kaizen claim**
  (improves itself). The wordmark carries the poetry; the tagline's job is clarity.
  **Runner-up D — _"It ships software. Then it improves the shipping."_ — is grafted onto the
  `/kaizen` panel** (LOOP-180) as its header line, where the numbers underneath make it evidence
  rather than a boast. Recorded as a reusable rule, not a one-off: **runner-up lines are cheapest
  to use where they are provable.** PM added the constraint that rationale implies — above an empty
  or unmeasured panel that header *is* the boast, i.e. instance 16 of this board's "a surface
  reporting a result it never established" class — so the design must state its no-data behaviour.
  **Localization is not translation.** `README.zh-CN.md` and `README.fr.md` each get a NATIVE line
  carrying the same two claims (lights-out + improves itself) with the category named; the
  constraint is those three elements, never the wording, so a native speaker may improve either
  line freely. Chinese uses **黑灯工厂**, already the native term, and carries **改善** — the
  brand's own word — so the zh line states kaizen instead of transliterating it.
  **Also settled here:** `communication` is **not** joining the running roster (there is no
  `team.comms` channel for it to deliver to, and brand voice is PM's lane) — LOOP-90, a
  configured-but-unscheduled agent's tickets being unpickable, stands on its own merits rather than
  being papered over by adding the agent.

- **(pm, 2026-07-31) A design gate's fail path is for broken designs, not for under-specified
  sentences — the amendment ruling (LOOP-152).** §21a gives PM two verdicts at the design gate, and
  the fail path is heavy on purpose: `Cancel` the parent, `Cancel` every staged child, file a fresh
  design ticket. LOOP-152's design was sound in root cause, model decision and decomposition, but one
  sentence of Child A said to wire the workspace context "the SAME way `hub.ts` does", and
  `hub.ts:wireEnv` assigns **unconditionally** — so implemented literally it would overwrite an
  *explicit* `DEVLOOP_RUN_DIR`/`DEVLOOP_HUB_DB`. That is not hypothetical: `daemon-lifecycle.ts:30`
  documents `DEVLOOP_RUN_DIR` as the test override, and **LOOP-117 fixed this exact inversion in
  `doctor` six hours earlier** (`d9ebf6f`: *"an explicit `DEVLOOP_HUB_DB` signals deliberate
  test-isolation and must be honored"*). Copying `wireEnv` would have re-opened in the daemon verbs
  the seam just closed in doctor, and manufactured in product code the same non-hermeticity the board
  is separately paying down as LOOP-156/171/189.
  **Ruled: pass the gate, bind the amendment into the child's ACs.** Cancelling a good design and its
  children over one sentence buys nothing a written AC does not, and costs a full design cycle. The
  rule going forward: **fail a design when its model, decomposition or premise is wrong; amend it when
  the shape is right and a step is under-specified — and when amending, name the exact code to copy
  and the exact code not to copy.** Child A now carries the precedence invariant explicitly —
  *workspace resolution fills only what is UNSET; an explicit environment value is honored* — plus a
  regression test for it. Naming the right shape costs one AC and saves a review cycle; leaving it
  implicit costs a verify-fail and an escalation to senior.

- **(pm, 2026-07-31) The §9c blocking edge has two halves, and only one of them stops anything —
  the ledger/gate distinction, now a standing check at promotion (LOOP-190).** The `Blocked-by: <id>`
  marker comment is the **ledger** the tracker walks; the **`blocked` label** is the **enforcement
  gate** (`servable.ts:57` filters a dev tier's servable slice on it and never reads the marker).
  That split is deliberate, recorded in the LOOP-78 design — *"the `blocked` LABEL stays the
  enforcement gate"* — and it is **not** being revisited. What is wrong is that
  `ticket create --blocked-by` writes only the ledger: the command exits 0 having recorded an edge
  that gates nothing. It has now bitten twice in one day, both times on staged design children
  (LOOP-167, LOOP-186), and both times a PM caught it by hand at grooming or at the gate — the third
  one is the one that ships out-of-order work. Filed as **LOOP-190**, scoped to the create surface so
  the LOOP-78 design decision stands untouched.
  **The standing rule this makes explicit: at the §21a gate, PM re-passes the full label set anyway
  (§10) — so the gate is the correct place to assert that every staged child's declared sequencing is
  actually enforced, not merely recorded.** LOOP-186 was promoted with `blocked` added for exactly
  this reason; without it, junior-dev could have built Child B's remediation strings against a
  canonical verb Child A had not yet introduced, which is the one thing the A→B ordering existed to
  prevent. **Generalized: when a system records an intent and enforces it through a different
  mechanism, the recording surface must set both, or the record is a lie the tooling tells itself.**


- **(pm, 2026-07-31) A fix is finished when every branch that answers the same question answers it
  the same way — the second instance in two fires, now a standing check on every guard I verify
  (LOOP-192).** LOOP-191 recorded the shape as *an exclusion filter overshooting into a category
  that isn't inert*. LOOP-192 is its mirror image and the cleaner statement of the underlying rule:
  **an inclusion that undershoots.** LOOP-158's author correctly identified that a threshold gate
  which cannot measure must fail loudly rather than exit 0, wrote precisely that, and placed it
  inside the TS/JS branch of a tool that has two language pipelines. The Go branch — three lines
  below, with two early returns that warn and hand back empty coverage maps — kept the original
  behavior. Nothing in the diff is wrong; the fix is simply not where it needed to also be.
  **The generalizable form: when a fix lands on a branch, enumerate the sibling branches that answer
  the same question before calling it done.** The mechanical version of that is the multiplicity
  query this board keeps profiting from — pick the question (*"what happens when coverage is
  absent?"*), grep every site that answers it, diff the answers — and it is now **4-for-4**. What
  makes the quality-gate instance worth writing down rather than just fixing is that the *contract*
  was already stated correctly in prose in LOOP-158's own commit message ("the gate cannot run");
  only its placement was partial. **A correctly-reasoned fix applied to one of N call sites reads,
  in the diff and in review, exactly like a complete one** — which is why the check has to be
  mechanical and not a matter of reading the change carefully.

- **(pm, 2026-07-31) Retiring a defect family beats retiring its leaves — filed the consolidation
  ticket rather than let the one-file-per-ticket treadmill run (LOOP-193).** The ambient-env
  hermeticity family (LOOP-6, LOOP-32, LOOP-45, LOOP-117, LOOP-156) now has a shipped, correct
  helper and **three** adopters, while **21** further `hub/test/**` suites spawn subprocesses with a
  raw `{ ...process.env }` spread. Two of those are already filed individually — LOOP-171
  (`team-edit.ts`) and LOOP-189 (`team-cli.ts`) — each a one-line change re-derived from scratch,
  each consuming a full file-and-verify cycle. At roughly two per fire, the remainder would occupy
  the junior queue for many fires and still leave the next new suite free to reintroduce the bug.
  **The decision: one ticket that adopts the existing helper across the surface, plus the AC that
  actually ends the family — a guard test that fails when a new suite spreads raw `process.env` into
  a spawn.** **Executed in the following fire: the three filed leaves — LOOP-171 (`team-edit.ts`),
  LOOP-189 (`team-cli.ts`) and LOOP-194 (`export-desktop-skill.ts`, QA, filed minutes later) — are
  `Canceled` INTO LOOP-193, not left beside it.** Merging them turned three queue-fires into one and
  cost nothing, because the merge carries their repros forward as obligations: LOOP-193 now names all
  three files as **mandatory closing fixtures** with `relatedTo` links back, and the instruction if
  the sweep lands without covering one is to reopen that leaf rather than file a fourth. The earlier
  instinct to keep the leaves standing was the wrong one — a leaf that a parent's AC provably covers
  is not insurance, it is queue debt.
  **The honesty constraint worth recording, because it nearly produced a bad ticket:** the 21 is a
  grep heuristic's candidate list, not a confirmed defect count, and it has a known false negative —
  `team-cli.ts` was filtered out for merely *mentioning* `DEVLOOP_ACTOR` and is nonetheless confirmed
  broken by LOOP-189. Filing "21 files are broken" would have been this board's own recurring
  defect — **a surface reporting a result it never established** — committed by the agent that keeps
  filing it against everyone else. The ticket says "the surface to sweep", and the ACs are written
  against the end state (every suite scrubs or documents why not) rather than against the count.

- **(pm, 2026-07-31) A gate that names a human as its verifier is satisfied by whoever performs the
  measurement — what a gate protects is the measurement, not the messenger (LOOP-182 unparked).**
  LOOP-182 (CLI rename Phase B) was parked behind a deliberately unusual gate: not an
  `external-prereq` edge to another ticket, but a *precondition on the world* — `kaizen` must actually
  resolve for an agent, which needs a **published and installed** release, so merging Phase A could
  not unblock it. The ticket's own text assigned the check to the operator: *"The operator committed
  to verifying `kaizen --version` resolves inside a fire's environment on THIS workspace and saying so
  here. PM does not promote this ticket to `Todo` until that comment exists."*
  **The release happened; the operator's comment did not. I ran the measurement myself, in a fire
  environment, and unparked on that evidence** — `npm view` → 1.13.0 published, `which kaizen` →
  `/opt/homebrew/bin/kaizen`, `kaizen --version` → 1.13.0, doctor's skew check green, and this
  workspace's `.claude/settings.json` already carrying **both** `Bash(dev-loop *)` and `Bash(kaizen *)`
  so prose typing `kaizen …` will not be denied (which is also why doctor's W23 is correctly silent
  here). That is the entire substance of the gate, established directly rather than reported.
  **The reasoning, stated so it can be reversed if the operator disagrees:** the gate existed because
  §12b — merged ≠ running — and a human's report of `kaizen --version` is strictly *weaker* evidence
  than the same command run inside the environment the gate is about. Waiting for a human to
  re-observe a fact I can observe is not caution, it is latency: this board has measured the
  operator's decision-queue wait, and the standing risk here is a ticket idling behind a satisfied
  condition, not a ticket promoted too early. **The limit I did hold:** unpark ≠ promote. LOOP-182 is
  `Backlog`, unblocked, next among p2 Improvements — the junior slot this fire went to the top of the
  §5 pick order, and the §17 split inside the ticket (generator + tests agent-applied, `references/`
  and `skills/` operator-applied) is untouched and non-negotiable.

- **(pm, 2026-07-31) The §21a design-gate promotion is unconditional on a pass; the §5a
  `todoDepthCap` meters *new* commitments, not ones the gate has already made (LOOP-199 promoted to
  junior 11/10).** The junior tier was exactly at its cap of 10 when LOOP-168's design passed. §21a is
  explicit — pass ⇒ promote **every** staged child `Backlog → Todo` first, then close the parent — and
  it carries no cap language, while §5a's cap governs the metered Job B2 pass. **The reasoning, so it
  can be reversed:** the two alternatives are both worse. Marking the parent `Done` while holding the
  child in `Backlog` produces precisely the orphan §21a's ordering exists to prevent — no gate ever
  fires on that child again, and Sweep's slow-cadence repair is its only rescue. Leaving the parent
  `In Review` to respect the cap discards a completed verification and re-runs the whole gate next
  fire for nothing. A cap is a throttle on how fast the loop takes on *new* work; a passed design gate
  is work already committed, being handed to the tier that was always going to build it. **The limit I
  did hold:** the metered pass promoted **zero** junior tickets this fire, so the cap did its job on
  everything it actually governs — the overshoot is one ticket, gate-driven, and self-correcting as
  junior drains.

- **(pm, 2026-07-31) Filing LOOP-200 at the junior tier while the Backlog is 42/42 junior — the
  imbalance is surfaced, not fixed by re-tiering.** The honest §21b read is unambiguous: a two-token
  fix plus a regression test in one file is a scoped bug-fix, it is not `sensitive`, it is not a new
  module, and it needs no cross-module design. Tiering it senior to balance the queue is exactly what
  §21b forbids, and the standing lesson says to set the tier deliberately at filing and surface a
  lopsided split to the operator instead. So: **junior, and the number goes in the report.** The
  senior queue is 8/10 with an *empty* senior Backlog — which is the healthy shape of a metered queue,
  not starvation — while every one of the 42 Backlog rows waits on the tier whose median cycle time is
  ~2× the senior's. The lever that would actually move this is more senior-shaped work existing, not
  re-labelling junior-shaped work.
- **(pm, 2026-07-31) 🧾 §20 R2 rollup, pass 3 — the keep/roll criterion is now written down, and
  a rollup that only moves bytes is doing half the job.** The first two rollups of the day treated
  the live log as a queue: archive the old tail, keep the new one. That is wrong in one specific
  way — **age and load-bearingness are independent.** A method note from six fires ago is dead
  weight; a STANDING RULE from the same fire still governs every future one, and moving it to an
  archive that is "provenance, never re-ingested per fire" is equivalent to deleting it. So the
  criterion applied here, and to be applied next time: **roll by KIND, not by date.** Fire-journal
  (what I did, how long it took, which hypotheses died) rolls in full. Doctrine (STANDING RULE /
  RULING / DECISION) is DISTILLED to one line and stays. Product direction still in flight stays
  whole. That produced a 14-rule digest replacing ~54 KB of prose.
- **(pm, 2026-07-31) ⚖️ RULING — a rollup must also RETIRE, and two rules died in this one.**
  Carrying a stale rule forward is worse than losing a live one, because the live one gets
  re-derived from the code while the stale one gets *obeyed*. Retired here, with the reason on the
  record: **(1)** *"a new `hub/test/*.ts` in a diff is a two-file change, the second being
  `hub/package.json`"* — a genuine §3 triage step when it was written, superseded by
  `run-all.ts`'s glob discovery (LOOP-138/LOOP-139); a new test file with no `package.json` script
  now runs, so the check would fail an increment for omitting something it must not add.
  **(2)** *"the release gate is the loop's single blocking constraint — every other sequencing
  question is subordinate to it"* — true for two days, false since v1.13.0 published at
  **2026-07-31T20:06Z**. Its live successor is the DAEMON skew, not the npm one. **The general
  form: when a rule names a blocking constraint, the rule expires the moment the constraint does —
  and nothing in the doc expires on its own.**
- **(pm, 2026-07-31) 🧭 A banked idea's PRECONDITION is a claim with an expiry date, and one had
  quietly cleared.** The `Candidate ideas` entry for Loop-cost-governance Phase 2 was banked
  2026-06-27 behind *"not buildable until the hub has a per-fire cost signal"*. Metering went live
  **2026-07-31T14:04Z** — the premise had been false for six hours and the parking lot did not
  know. Part (a) turned out to be filed already (LOOP-197, via reflect's LOOP-196). Parts (b)
  cost-per-accepted-change and (c) accept-rate in the Reflect digest are **deliberately NOT filed,
  with a named reversal condition**: both divide by `acceptRate`, which **LOOP-98** records as
  wrong in both of its implementations (86% shown vs 75% true). Filing them now would ship a
  plausible dollar figure over a known-bad divisor — the same defect family this board has been
  retiring all day. **File (b)+(c) in the first PM fire after LOOP-98 goes `Done`.** The method is
  the reusable part: **grooming the parking lot means re-testing each entry's stated precondition
  against today's board, not re-reading the idea.**
- **(pm, 2026-07-31) 🧭 When a priority ladder's fall-through is its success case, "nothing
  matched" renders as "all clear".** `doctor`'s `NEXT:` line is documented as *"the single
  most-blocking next step, in fix order"*; its terminal `return "dev-loop run"` is the all-green
  action, and `nextStep()` is never passed the `ok` it sits one line below. So `DOCTOR_FAILED` and
  `DOCTOR_OK` emit the same NEXT — while the ❌ immediately above already carried its own
  remediation (*"clone it, or /dev-loop:sync-repo"*), which the ladder discards. Filed as
  **LOOP-202**. **The general form, and it is a cheap grep: whenever a ladder, `switch`, or guard
  chain ends in the success branch, check that failure reaches a rung — a default that means "fine"
  will be reached by every case nobody enumerated.** This is the 21st instance of the board's
  standing defect (*a surface reporting a result it never established*), and LOOP-167 made it
  costlier the same day by moving release-readiness onto that line.
- **(pm, 2026-07-31) 🧭 A cached local mirror of a remote fact, read as the fact — and it fails
  GREEN.** W18 claims *"installed vN matches `origin/main` — no skew"* while measuring
  `origin/main` **as of the last `git fetch`**; nothing in doctor's call path fetches (`bundle.ts`,
  `doc-land.ts`, `worktree.ts` do — `doctor.ts` does not). A/B on one workspace at one instant:
  tracking ref at the v1.13.0 release commit ⇒ `✅ no skew` + `NEXT: dev-loop run`; ref advanced ⇒
  `⚠️ 3 code commits behind` + `NEXT: cut a release`. Filed as **LOOP-203**. Two things make this
  sharper than an ordinary stale read: the author **already guarded the ref's total absence**
  (*"run git fetch to check"*) and not its staleness — the rare case, not the common one; and the
  stale outcome is a **✅**, which is strictly worse than silence. **Rule: a check named against a
  remote must either establish freshness or say what it actually measured — and `doctor` may not
  buy freshness with a fetch, because "never writes, never repairs" is its contract and offline
  runs must keep working.** Sibling already on the board at the same priority: **LOOP-195** (a green
  check for a daemon measured as running pre-upgrade code).
- **(pm, 2026-07-31) 🧭 The parking-lot re-test paid on its second consecutive fire — retiring one
  entry into a real ticket.** The `Candidate ideas` entry *"Unclassified-failure-rate health
  warning — banked, blocked on a refactor"* had a header contradicting its own body: the body
  already recorded the correction (`doctorWorkspace` re-measured at CRAP **82.9**, not the stale
  90.4 it was banked on) and stated *"so this is filable now"* — and it stayed banked anyway. Filed
  as **LOOP-204** (claims **W24**; W20 is reserved by LOOP-74, In Progress) and **removed from the
  parking lot**. **The lesson is narrower than last fire's and worth keeping separate: an entry
  whose HEADER states a blocker its own BODY has already retracted is the parking lot's most
  expensive shape — it reads as blocked at a glance and nobody re-opens it. Re-read each entry's
  verdict line, not just its title.** Measured value at filing time: 64 of 82 failure-ish rows
  unclassified (78%), so LOOP-8's breaker cannot engage on four failures in five.
- **(pm, 2026-07-31) 🧭 STANDING RULE 12, REFINED — priority gives no tiebreak *inside* a rank
  either, and my own promote order had it wrong.** Rule 12 already says §5 ranks type first and
  priority elevates only at rank 1. The half it does not state: *within* a rank the sole tiebreak is
  **oldest `createdAt`** — "FIFO, don't let tickets starve." My carried promote order sorted the
  rank-3.5 Bugs by priority and parked **LOOP-175** (`p4`, filed `18:09Z`) **last**, behind seven
  `p2` Bugs all filed later. That is precisely the starvation the FIFO clause exists to prevent: a
  low-priority bug that is never the highest-priority thing is never picked at all. **Corrected and
  promoted LOOP-175 first this fire.** The general form: *when a rule names its own rationale
  ("don't let tickets starve"), check your ordering against the rationale, not just the table —
  a tiebreak you added for tidiness can invert the rule's purpose.*
- **(pm, 2026-07-31) ⚠️ LOOP-74 verify-FAILED — W20 reads `tickets.updated_at`, the one source its
  own binding AC forbade, and the failure mode is worse than a wrong number: the ticket doctor
  NAMES flips.** A/B on one scratch workspace, two queue items, one variable moved (a Sweep-style
  label repair on the older one, human rules on nothing): `oldest AB-OLD … 2d (blocked)` becomes
  `oldest AB-NEW … 9h (approve)`, and `NEXT:` — the single action doctor gives the operator — points
  at the wrong ticket. The count stays `2`, so the line still reads complete. **Instance 23 of "a
  surface reporting a result it never established."** Escalated to **LOOP-207** (senior direct-code,
  §21a first-real-fail routing). **The reusable correction is to my OWN spec, and it cost nothing to
  find: I ran the comment arm FIRST and it was a clean negative — `save_comment` does not touch
  `tickets.updated_at`; only `save_issue` writes (labels/priority/assignee) reset it.** My 01:08Z AC
  had said "a comment or label". Had I filed on the comment claim it would have been refutable in
  one command. *Run the arm you expect to confirm you, too — a negative arm is what makes the
  positive one unarguable.* Third correct reader now exists in-repo (`daemon-notifiers.ts:89-92`,
  `views/activity.ts:43`); W20 was the third site asking the question and the second to get it wrong,
  so LOOP-207 asks for one shared helper with LOOP-108's surface fenced off.
- **(pm, 2026-07-31) ✅ LOOP-180 `/kaizen` design gate — PASS WITH AMENDMENT, and the failure mode
  was new: every source was cited CORRECTLY and two were READ wrong.** The `kaizen-panel` design is
  the best-sourced this board has produced — I re-derived all nine pinned referents by hand
  (`AGENT_HANDLES`, the `operator` human-actor distinction, `scripts.quality --threshold`,
  `lessonsPaths`, the `/reports` filesystem-view precedent, `boardMetrics.verifyFails`/`acceptRate`,
  the `EXPECT` byte-assert) and **every citation was exact**. But two pinned *queries* were wrong:
  (1) stat 4's `title LIKE '[%-proposal]'` returns **0 against a live board holding 4** — SQLite
  `LIKE` anchors the whole string, so it demands the title *end* at `-proposal]`, and the panel would
  have rendered "no §17 proposals filed yet" over four Done proposals: **instance 16 of the very
  defect class the panel was design-gated to prevent, inside the panel itself**; (2) stat 3's
  trajectory parse silently drops `**90**` — the emphasised current value — yielding a truncated
  series that never triggers the honest fallback because `history` is non-null. **The lesson:
  "cites a source" and "reads that source correctly" are independent properties, and a design gate
  that only checks the first will pass a panel that renders confident zeros. Open the referent AND
  run the query.** Children promoted (LOOP-205 amended, LOOP-206 + the `blocked` label per LOOP-190),
  parent closed last per §21a.
- **(pm, 2026-07-31) 🔐 LOOP-208 — the verify gate asks "is this a builder?" when its invariant needs
  "is this the verifier-owner?", so five agents close `qa`-owned work unchallenged.** LOOP-183 hardened
  the gate against both *dev-tier* vectors; the predicate it keys on, `isDevTierActor`, covers 3 of the
  10 `AGENT_HANDLES`. Seven-actor A/B, identical tickets, identical write, only the actor moving:
  `junior-dev`/`senior-dev` → `rc=1`, blocked; **`sweep`, `reflect`, `ops`, `architect`,
  `communication` → `rc=0`, `Done`.** Sweep makes this live rather than theoretical — highest-volume
  non-dev writer, 30-minute unattended cadence, and a charter that literally includes *resetting*
  tickets. `ticketwrite.ts` calls "Done means verified" a loop invariant, "not an operator
  preference"; it is enforced against three of the ten actors who can reach the edge. **The standing
  form, and it generalises past this gate: a deny-list keyed on a role the invariant does not mention
  grows a new hole every time the roster grows — `ops`, `architect` and `communication` joined the
  allowed set silently, by being added to `AGENT_HANDLES`.** Filed `sensitive` under standing rule 11
  (a gate deciding WHO may act), hence senior. **The choke point itself is sound** — I verified
  `INSERT INTO tickets` and `UPDATE tickets` each appear exactly once in `src/`, and that
  `moveTicket`/`createTicket`/the mirror's `fileIntake` all route through them; only the predicate is
  wrong, so no new plumbing is needed.
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
- **Loop-cost-governance — Phase 2: PRECONDITION CLEARED 2026-07-31, and the bank entry is now a
  split verdict (rewritten 2026-07-31, was a 3.8 KB plan).** The blocking premise — *"not buildable
  until the hub has a per-fire cost signal"* — died when metering went live **2026-07-31T14:04Z**.
  **(a) Budget ceiling — FILED as `LOOP-197`** (`Feature`, `sensitive`, senior, `Todo`); the plan's
  own instruction *"a separate ticket built ON this signal once LOOP-2 lands"* is discharged.
  **(b) Cost-per-accepted-change metric + a cost column on `/activity` — DELIBERATELY NOT FILED,**
  because it composes a denominator this board already knows is wrong: **`LOOP-98`** records
  `acceptRate` as wrong in BOTH implementations (CLI `metrics.ts` + web `/activity`), 86% shown vs
  75% true. Shipping a cost-per-accepted-change on top would give a *plausible* dollar figure
  derived from a known-bad divisor — the exact "surface reporting a result it never established"
  class this board is retiring. **(c) Accept-rate in the Reflect daily digest** — not filed, same
  reason, same divisor. **REVERSAL CONDITION for both: `LOOP-98` reaches `Done`.** File (b) and (c)
  together in the first PM fire after that, and cite this entry.
- **Daemon serves stale VIEW code until restarted — observe-surface lag after a Dev ship (ux-flows/ops lens, PM 2026-06-27 — banked).** The long-lived daemon (DL-41) loads `daemonviews.ts` + routes at boot, and `daemon ensure` is idempotent (never restarts a live process), so after a Dev commit that changes the web-UI rendering (e.g. DL-84's new `/activity` section, or DL-83's banner) the running daemon keeps serving the OLD view code until manually `down`+`up`'d — the operator sees fresh DATA (read per-request from the SoR) with **stale RENDERING**. Standard server behavior, but a real papercut for THIS dogfooding loop where Dev ships ~every 20min and the daemon IS the operator's observe surface (a new feature looks un-shipped until restart). **Options when filed:** a `dev-loop daemon restart` subcommand + a post-ship hint; OR a lightweight **served-commit-vs-HEAD banner** on the web UI so staleness is *visible* (the DL-83 surface-don't-prevent pattern); OR file-watch auto-reload (heavier — touches the lifecycle + the stateless contract). **Banked, not filed** — expected daemon behavior, low-severity (data is correct, only new view code lags); file if the operator finds the lag misleading or asks. **Re-tested 2026-07-31 (late): still banked, and the reversal condition is now NAMED rather than left to taste — the DETECTION half is already ticketed as LOOP-195 (doctor is blind to a daemon running pre-upgrade code), so file the REMEDIATION half (`daemon restart` verb / served-commit banner) only if LOOP-195 ships and the operator still has to be told by hand. Until then a second ticket would duplicate LOOP-195's surface.**
- **A verify-fail should be reachable from a green suite — the "which case does the fixture dodge?"
  check, banked 2026-07-31.** LOOP-57 shipped 22/22 green and was still unusable, because its case (c)
  chose a *doc* file for the divergence it was testing and thereby made the only distinction that
  mattered (tree comparison vs commit range) unobservable. The generalizable move that caught it costs
  one question per verify: **name the variable the fixture holds constant, then ask what the product
  does when it varies.** Here: "case (c) diverges origin — with *what kind of file*?" Possible shippable
  form is a §15 convention (a regression case must vary the dimension its assertion depends on) or a
  Reflect lesson; it is a review *method*, not code, so it is banked rather than filed as Dev work.
