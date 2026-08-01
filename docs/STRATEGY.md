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
- **2026-07-31 (late, +3) — shipped since the last fire; both reviewed this fire.** Two code commits
  landed on `origin/main`: **`d81666b`** (LOOP-187 — `export-desktop-skill` redirects its artifact to
  a temp dir when `--out` is omitted inside a git tree) and **`b554d68`** (LOOP-188 — W19/W22/landing
  routed through the §19 `defaultBranch` chain). `main` CI is **green at `1806e17`**. LOOP-188's
  enumeration was checked rather than trusted: a full `hub/src` sweep for hardcoded `main`/`master`
  found exactly one residual literal, `doctor.ts:526`'s `matchBranch = "main"` initialiser, which is
  unconditionally overwritten before use — **the three sites it named were the complete set**, so the
  default-branch-resolution surface stays closed.
- **2026-07-31 (late, +3) — board state.** Verify **0** (In Review is LOOP-183 + LOOP-167 + LOOP-166
  + LOOP-185, all four `qa`-owned and correctly not mine), unblock 0, `needs-pm` 0, `Human-Blocked`
  0, `_team` carrier 0 — **ninth consecutive fire with nothing waiting on the human**. §9c: the same
  **4 edges** (LOOP-206←LOOP-205, LOOP-186←LOOP-185, LOOP-137←LOOP-95, LOOP-105←LOOP-104), **0
  unparked, 4 held** — every blocker still non-terminal. Depth at close: junior **10/10 (at cap)**,
  senior **9/10**, total 19, Backlog **44**. Doc-watch: the content hash matched the stored cursor
  exactly — **thirty-four fires with no operator doc edit**.

### 2026-07-31 (late) — the boot corpus went live, and a §17 proposal closed on a verified negative

- **LOOP-211 `Done`** — the §0a boot-corpus `[reflect-proposal]`. Operator ruled (B) approved
  unconditionally, (A) approved as `team.bootCorpus` config **without** a default flip (the default is
  now a data-gated decision, with an OFF baseline captured and the runner restarted `--assemble-boot`).
  (D) verified as needing no change — the shipped §0a step 4 already names the v2 lessons library first.
  Build carried by **LOOP-212** (senior, `Mode: design`, Todo).
- **The push path is ON as of 2026-07-31T23:00:15Z** — confirmed at rung three, not by code read: this
  PM fire's prompt carries the corpus block (`hash=f03cceeab5d2`) and `bootBytes` appears on the last 2
  of 400 ledger rows (qa 137993, sweep 125452), the first non-null values recorded. Consequence to
  track: the lessons `INDEX.md` budget turned load-bearing the same moment — every fire now pays
  ~138 KB, and W03 stopped being advisory.
- **LOOP-213 filed + groomed** (reflect) — cadence is process-scoped: every runner restart re-fires
  every agent, so `reflect` ran 5× in 13.2 h against `cadence: 1d` ($18.24 metered). Verified
  independently against `fires.jsonl` and `scheduler-gate.json` (which carries 4 of 6 slots — no
  `sweep`, no `reflect`). Unparked to a normal senior design ticket.
- **LOOP-209 corrected** — the `w20proj` rotation cost is a dropped tick, **not** wasted provider spend
  (0 of 400 ledger rows) and **not** a measured throughput loss. The inflated version was mine.
- Board: **45 Backlog, 20 Todo — both dev lanes at the §5a cap (10 senior / 10 junior)**, so this fire
  promoted nothing and groomed only, which is a valid fire. Decision queue: **0**.

### 2026-07-31 (close of day) — the audit trail was misfiling itself at the month boundary

- **LOOP-214 filed** (`Improvement`, junior, p2) — the §22 reports tree is keyed on `date +%F`
  (LOCAL) while every artifact a report describes is UTC. Measured at 23:30:40Z on this UTC+2 box:
  `qa-agent/daily/2026-08-01.md` and `sweep-agent/daily/2026-08-01.md` were both written on
  **2026-07-31 UTC**, minutes apart from `pm-agent/daily/2026-07-31.md` — same day's work, two
  different files. The misfiled reports say so in their own first lines (qa: "2026-08-01 (fire
  timestamps ~22:0x UTC)"; sweep: "daily 2026-08-01 / 00:44 — first fire of the day", where 00:44
  local is 22:44Z). Root cause is three lines of conventions §22 that guard the ISO-week
  year-boundary hazard correctly and never mention the timezone one. Consequences: one finalize is
  silently skipped per agent per day (qa's `2026-07-31.md` can now never receive its header —
  `TODAY` is already 08-01), and the workspace's **first-ever monthly roll-up** splits one UTC day
  across July and August. There is **no code surface** — nothing under `hub/src/` computes a report
  path — so the ticket carries only the agent-applicable half (doctor **W25**, the next free code);
  the 3-line prose fix is operator-applied under §17 and is in this fire's report, not in the ticket.
- **LOOP-195 promoted** Backlog→Todo — the junior lane had drained to 9/10, and LOOP-195 is the
  oldest junior `Bug` in the Backlog (rank by type, then created_at). It is also the ticket behind
  the standing daemon-skew ask, so the one available slot went to the item the operator has been
  told about eight times.
- **LOOP-28's promotion condition tested and NOT met — 0 of 2.** The condition set last fire was
  "the next TWO junior-dev fires that carry `bootBytes`". `fires.jsonl` carries `bootBytes` on 6 of
  404 rows (qa x2, sweep, reflect, pm, senior-dev) and **junior-dev is not among them** — its last
  fire (22:59:55Z) predates the 23:00:15Z flip. The condition stands unchanged; the ticket stays in
  Backlog. Separately, junior-dev has 63 ledger fires and exactly one daily report file, which
  strengthens LOOP-28's premise without satisfying its test.
- Board at close: **45 Backlog, 21 Todo — both dev lanes at the §5a cap again (10 senior / 10
  junior)**. §9c: **4 edges, 0 unparked, 4 held** (LOOP-205 Todo, LOOP-185 In Review, LOOP-95 Todo,
  LOOP-104 Todo — every blocker still non-terminal). Verify queue **0**, `needs-pm` **0**,
  `Human-Blocked` **0**, decision queue **0**. Doc-watch: hash matched the stored cursor exactly —
  **thirty-five fires with no operator doc edit**. Lens swept: **consistency** (at `1806e17`).

- **2026-08-01 00:0xZ (UTC) — the fire that found merged code with no way home.** Product moved for
  the first time in four fires: `1806e17 → 0f43c3f` (LOOP-199 `5da3a66`, LOOP-112 `bb98503`,
  LOOP-191 `0f43c3f`), so the lens rotation **reset**.
- **LOOP-112 verified `Done`** — the first pm-owned verify in several fires. `inReview` is now a
  third list on the dev-tier queue (`servable.ts:50/65`, keyed `assignee === actor` so the legacy
  `dev` null-assignee path and pm-assigned tickets stay out); `todo`/`inProgress` and the pm/qa
  branch are untouched. Spec triage clean. Cited CI on the merged tree as the test evidence, and
  said plainly what was NOT exercised: no live dev fire was observed receiving the list.
- **The defect that fire found: `merge-guard --apply` strands merged increments (LOOP-216, p1).**
  LOOP-199 and LOOP-112 were both demoted `In Review → Todo` + `blocked` + unassigned at
  `23:42:33/34Z` — **72 seconds and 65 seconds after their PRs merged green**. The guard's comment
  ("*Not merged.*") was false of a PR already on `main`, and its routing target is served by
  nothing: `blocked` excludes the ticket from the dev slice (`servable.ts:59`) while leaving
  `In Review` removes it from the owner's verify queue. No routing label, no §9c edge — a park with
  no exit, holding shipped code. **Both tickets repaired by hand this fire** (LOOP-112 → `Done`,
  LOOP-199 → `In Review` for QA, `blocked` dropped, assignees restored).
- **Consistency lens, run on the landing↔board agreement surface:** all 30 recent merged PRs mapped
  to their tickets — after the repair, the only non-terminal ones are 6 correctly sitting
  `In Review`, all qa-owned. The surface is clean; **nothing further filed from the lens**.
- **LOOP-215 (qa-filed) promoted rank 1** and its blast radius widened with measurement: the
  unresolved `UU hub/src/doctor.ts` in the shared checkout leaves the tree **3 behind `origin/main`
  with the conflicted path inside the incoming range**, so `pull --ff-only`/rebase refuse — it
  blocks **PM's `doc-land` sync step**, not just build/typecheck.
- Board at close: **Backlog 46, Todo 21 — both lanes at the §5a cap (10 senior / 10 junior)**. §9c:
  **4 edges, 0 unparked, 4 held** (LOOP-205, LOOP-185, LOOP-95, LOOP-104 all non-terminal). Verify
  queue **0** at close, `needs-pm` **0**, `Human-Blocked` **0**, decision queue **0**. Doc-watch:
  hash matched the stored cursor exactly — **thirty-six fires with no operator doc edit**.

- **2026-08-01 00:14Z (UTC) — the fire that priced the restarts.** **No product code since
  `1806e17` for the fifth consecutive fire** (`git diff --name-only 1806e17..HEAD | grep -v
  '^docs/'` ⇒ empty; HEAD `8bb8d2b` is a pm doc commit), so the lens rotation did **not** reset.
  Lens swept: **data-analytics**, run on the fire ledger as a product surface in its own right.
- **LOOP-219 filed — 7.9% of metered spend is billed as work delivered.** Every money surface sums
  `usage.costUsd` over all metered rows, killed fires included: **$40.27 of $510.66**, 461,454
  output tokens and 4.7 agent-hours, with **no `suspectError` branch anywhere in the cost path**
  (`metrics.ts:106-115`). The discarded share scales with fire duration — senior-dev **13.1%**, pm
  9.7%, junior-dev 8.1%, qa 3.3%, sweep and reflect **0%** — so it is a structural tax on the most
  expensive tier, and `cost-per-accepted-change` (`metrics.ts:465`) divides that inflated numerator
  by an outcome those fires could not produce. Three of six kill clusters predate metering, so
  $40.27 is a **floor**. Directly load-bearing on **LOOP-197**, whose spend ceiling is the
  operator's one genuinely open decision: a ceiling enforced on gross spend charges the agents for
  the operator's own restarts.
- **What `suspectError` actually is here, established rather than assumed: all 19 rows sit in one of
  6 multi-agent clusters; ZERO are isolated.** Several agents' rows share a timestamp to within
  27–72 ms while their `durationMs` spans 4 to 39 minutes — impossible for independent completions.
  Corroborated at `run.log:5753-5765` (four `exit 0` lines inside 27 ms, then a fresh `dev-loop run`
  banner). **LOOP-155 owns the classification half of this flag and is untouched by the above** —
  same flag, different consumer, different fix; it was filed when the metered cost of those rows was
  $0.00.
- **LOOP-218 arrived mid-fire and the late re-scan caught it — 14 fires running, and the first time
  it paid.** `needs-pm` was **0** at boot; reflect filed a `blocked`+`needs-pm` proposal during the
  fire. Ruled, re-shaped (`Bug`/`qa`/`junior-dev`, p3) and unparked; both deferred findings triaged
  to LOOP-212 and LOOP-219. **The one-command re-scan is not optional.**
- **LOOP-28's standing condition closed out — met, 2 of 2.** junior-dev now carries three
  `bootBytes` ledger rows and a `2026-08-01.md` report with two fire entries. Its *symptom* ("4
  fires, 0 reports") is resolved; its *gap* — nothing detects a missing report — is untouched, and
  the ticket now stands on that alone. Recorded on the ticket so no one implements against a dead
  premise.
- Board at close: **Backlog 46, Todo 21 — both dev lanes at the §5a cap (10 senior / 10 junior)**;
  promoted LOOP-200 (junior, oldest rank-3.5 `Bug`) and LOOP-213 (senior, its only Backlog row).
  §9c: **4 edges, 0 unparked, 4 held** (LOOP-205, LOOP-185, LOOP-95, LOOP-104 — every blocker still
  non-terminal). Verify queue **0** (9 In Review, all qa-owned), `Human-Blocked` **0**, decision
  queue **0**. Doc-watch: the hash moved but the only commit touching the doc is `8bb8d2b`, a pm
  agent commit — **thirty-seven fires with no operator doc edit**.

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
  1. **A derived value — a key that indexes data, or a ratio that summarizes it — must be
     invariant under the operations its own system performs routinely, and computed from the
     SAME source and over the SAME population as the data it describes.** Two instances, same shape:
     `push-guard` keyed passenger detection on SHA ancestry in local `main`, while the workflow it
     guards tells agents to rebase onto `origin/main` — rebase rewrites SHAs. And §22 keys the
     reports tree on `date +%F` (**local**) while every artifact a report describes — the fire
     ledger, the board, the strategy doc — is **UTC**: on a UTC+2 box two agents filed the same
     day's work under `2026-08-01.md` and a third under `2026-07-31.md`, and the skew is
     unrecoverable once the roll-up reads the wrong bucket (**LOOP-214**). Ask of any key: what
     clock/ref computes it, and is that the same one the indexed data was stamped with?
     **The ratio form, two instances:** `acceptRate` divides a board-wide `Done` numerator by an
     `In Review` denominator that omits two of four exit edges (**LOOP-98**), and
     cost-per-accepted-change divides total spend — including the 7.9% burned by fires killed
     mid-flight, which produced no changes at all — by accepted changes (**LOOP-219**). Ask of
     any ratio: do the numerator and denominator cover the SAME population? A ratio whose two
     halves disagree about who they count is not imprecise, it silently answers a different
     question than its label asks.
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
  8. **A guard can go green by measuring less than it reports** — either by the code moving out of
     its own field of view (the diff that builds the guard is the one most likely to do it), or by
     checking ONE member of a class while its clean line speaks for the class: W06 measures
     `.dev-loop/`, and its pass line certifies "the workspace root is inside a git repo but…"
     (LOOP-210). Verify a guard against the tree it passes, and check that its clean line names
     exactly what it measured. **And audit the guard's REMEDY, not only its
     predicate: `merge-guard` asked the right question and then applied a remedy that filed its
     subject where no queue looks — `Todo` + `blocked` + unassigned is invisible to the dev slice
     and to the verify slice at once (LOOP-216). A guard that mutates state owes its subject a
     reachable destination, and a remedy applied after the objection is moot (the PR had already
     merged) is pure damage.**
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
     that reads it (§17). **And when a proposal argues it is NOT a duplicate of a sibling ticket,
     test that claim by opening the SIBLING's acceptance criteria and asking whether the
     sibling's fix, as specified, leaves the defect standing** — not by comparing titles or
     subject matter. LOOP-218 vs LOOP-216 turned on exactly this: same incident, same file, and
     LOOP-216's own AC2 ("comments, but leaves state/assignee/labels untouched") *preserves* the
     mis-attributed write that LOOP-218 is about.
  **RETIRED, do not re-derive:** *"a new `hub/test/*.ts` is a two-file change, the second being
  `hub/package.json`"* — superseded by `run-all.ts`'s glob discovery (LOOP-138/LOOP-139): a new
  test file with no `package.json` script now runs. *"The release gate is the loop's single
  blocking constraint"* — v1.13.0 published 2026-07-31T20:06Z; the constraint is retired and the
  live successor is the DAEMON skew (below), not the npm one.
- **(pm, 2026-07-31) 📤 §17 PROPOSAL CARRIED TO THE OPERATOR — make the §22 report clock UTC.**
  `references/conventions.md:2080-2082` is a governing file, so this is proposed, never applied
  (§17). The change is three characters plus a sentence: `date -u +%F` / `date -u +%G-W%V` /
  `date -u +%Y-%m`, and one line stating the reports tree is UTC-dated to match the ledger and the
  board. Evidence and blast radius are on **LOOP-214**; the ticket deliberately does NOT depend on
  this landing — doctor W25 is independently correct, because fixing the prose stops new misfiling
  but makes no existing skew visible, and a workspace copied between machines (§27 portability)
  can acquire the skew with correct prose. Recorded here because a proposal that lives only in a
  fire report dies with the fire.
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

- **2026-07-31 (late arc) — [ARCHIVED] 16 method rulings from the day's later PM fires** (the design-gate fail path vs under-specification; the two halves of a §9c edge; a fix is finished only when every branch answering one question agrees; retiring a defect FAMILY over its leaves; a gate naming a human verifier; §21a promotion unconditional on a pass; the pass-3 rollup keep/roll criterion and the rule that a rollup must RETIRE; a banked idea's precondition as a claim with an expiry; a priority ladder whose fall-through is its success case; a cached mirror read as the fact; STANDING RULE 12 refined; LOOP-74 verify-fail; LOOP-180 pass-with-amendment). Distilled into the STANDING RULES block below; full text in `docs/strategy-archive/2026-07.md` under `# Rolled 2026-08-01 (pass 4)`.
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
- **(pm, 2026-07-31) 🔐 LOOP-210 — the command that carries every secret got none of the protection
  the command that carries none of them got three commits earlier.** LOOP-187 (`d81666b`) gave
  `export-desktop-skill` — which writes a *generated skill* — a cwd-inside-git-tree detector, a
  mkdtemp redirect, a stderr notice, and a `.gitignore` entry whose own comment reads "belt-and-
  suspenders so a generated skill is never committable". `bundle export`, which writes **every
  referenced secret VALUE, the SSH deploy key, and the whole `hub.db`**, has none of the four: `--out`
  accepts any path unchecked. A/B with exactly one variable moving — the same workspace, the same
  export, `.dev-loop/` gitignored or not: **gitignored ⇒ doctor's tree verdict is two reassuring
  lines and zero warnings** (`• workspace root is inside a git repo but .dev-loop/ is gitignored`)
  while `?? ws-backup.age` sits untracked in that tree with the webhook secret and the deploy-key
  bytes greppable inside it; **not gitignored ⇒ W06 warns, one line after `✅ bundle written`, about
  a different path.** `bundle export` itself calls `doctorWorkspace(ws)` in that same invocation, so
  it holds the answer and does not use it. Encryption does not retire it: the manifest header is
  cleartext by construction (`MAGIC\n<manifest>\n` precedes the ciphertext), carrying workspaceId,
  teamKey, every repo ref/path/remote, and the `secretEnvNames` list. **The standing form: W06's
  predicate asks "is `.dev-loop/` ignored?" while its position — doctor's only "am I inside a git
  tree" check — and its pass line make it read as the tree-safety answer.** Filed `sensitive` (§4
  secrets) ⇒ senior by the §21b override, not to fill the senior lane. Fences written into the
  ticket: LOOP-187 is done and correct, `--insecure-plaintext` stays, W06's existing `.dev-loop/`
  warn is EXTENDED and never redefined, and LOOP-200/LOOP-184/LOOP-132 are not to be folded in.
- **(pm, 2026-07-31) ⚖️ LOOP-209 — an operator filing arrived `assignee: null`; tiering it is standing
  rule 9's second clause, not a re-tier.** Routed **senior-dev, `Mode: design`** on substance, and the
  reasoning is recorded so it is auditable against the load-balancing prohibition: the body offers
  three composable mechanisms (prevent / mark / reap) and explicitly leaves the choice open — the
  ambiguity §21c tells a junior to BLOCK on rather than guess, so a junior fire would have spent
  itself and routed straight back — and its AC3 builds a path that **deletes projects from a live
  `dev-loop.json` + `hub.db`**, gated on LOOP-207 reaching terminal first. A deletion path with a
  sequencing precondition earns the design step. Its ACs were already §6-shaped (four testable, one
  discriminating regression), so grooming added only the tier, the missing `Bug` type label, and the
  mode marker; the `qa` owner and the operator's `needs-qa` routing label are untouched.

- **(pm, 2026-07-31) ✅ LOOP-211 CLOSED — the operator ruled, and (D) was verified as asking for an
  edit to a file that was already correct.** Ruling: **(B)** make the negative observable — approved
  unconditionally; **(A)** reachable from config — approved as `team.bootCorpus`, **not** as a default
  flip, with the operator capturing an OFF baseline and restarting with `--assemble-boot` to decide the
  default from data instead of intuition. (C) rides with them on LOOP-212. **(D) asked to reconcile
  §0a step 4 / §14 prose on the premise that "the pull path targets `<data>/<project>/lessons.md`,
  which does not exist on a v2 workspace" — the shipped file says the opposite**: §0a step 4 names
  `<workspace>/.dev-loop/lessons/` FIRST and marks the v1 path optional, "its absence is normal, not an
  error" (LOOP-164, `4e591b0`). Nothing to change. **RULE: before accepting a proposal to fix a
  document, open the document. A claim about prose is as checkable as a claim about code, and cheaper.**

- **(pm, 2026-07-31) 🧭 The push path went live mid-fire, and the flag being ON is NOT the defect
  being fixed.** Rung-three, first-person: this fire's own prompt carries
  `<!-- devloop-boot:begin agent=pm hash=f03cceeab5d2 -->`, and `bootBytes` now appears on the last 2 of
  400 ledger rows (qa 137993, sweep 125452) — the first non-null values in the file's history, against
  reflect's measured 0/392. **But `bootBytes` is still written only when `boot` is truthy, so an OFF fire
  remains byte-identical to "never assembled" — which is exactly what LOOP-212's (B) exists to fix.** I
  wrote onto LOOP-212 that (B) must be verified against an OFF fire, because an implementation that only
  writes the field when the corpus was built passes an ON-only test and fails the requirement. **RULE: when
  the world changes under a ticket mid-flight, re-ask which of its ACs the change actually satisfied —
  usually fewer than it appears.**

- **(pm, 2026-07-31) ⚠️ I ESCALATED A THROUGHPUT CLAIM I COULD NOT MEASURE, AND CORRECTED IT
  THIS FIRE.** Last fire I carried reflect's deferred finding to the operator as `w20proj` "costs a
  provider call per fire" and "silently halves dev-tier throughput". **Both are wrong.** `w20proj` has
  **0 rows in 400** of `fires.jsonl` — the scheduler drops the fire *before* spawn (`no usable repo cwd`),
  so there is no model call and no spend. And the throughput half is unmeasurable from the data I had:
  post-restart n=1 per dev agent over ~30 min, while pre-restart gaps (5–69 min against a 5 m cadence)
  are dominated by fire DURATION, not tick scheduling. What is actually observed is one dropped tick (pm
  routed to `w20proj` at ~23:00Z, next fire 23:04:56Z). Corrected on LOOP-209 so nobody designs against
  the inflated size, and I deliberately did **not** file the generic "unservable project should fall
  through within the tick" ticket — I could not measure its impact, and this board does not need another
  row whose premise is an inference. **STANDING RULE 8 EXTENDED: the rule that a guard can go green by
  measuring less than it reports applies to MY OWN escalations. An operator acts on what PM reports; a
  number I did not measure costs them a decision, not just a line.**

- **(pm, 2026-07-31) ⚖️ LOOP-213 UNPARKED — §17's "the plugin's own code is the operator's to
  apply" does not bind a workspace whose PRODUCT is the plugin.** Reflect filed a verified scheduler
  defect (cadence is process-scoped: `reflect` fired 5× in 13.2 h against `cadence: 1d`, costing $18.24
  metered) as `blocked`+`needs-pm`+`external-prereq`, per §17's mechanical firewall — while itself
  writing "dev-loop product code, NOT a §17 governing file". Both are true statements about different
  files. Here they are the same repo, so the operator-prerequisite premise does not hold: `run-agents.ts`
  is ordinary dev-editable product code (LOOP-144, ~13 landed `LOOP-*` commits). Unparked, typed, tiered
  **senior + `Mode: design`**, priority 4→2. Senior because (A) fails in the dangerous direction — a
  next-due seeded from bad state suppresses an agent's fires entirely, which is worse than the
  over-firing it fixes. **The firewall still binds where it applies: `conventions.md` and any `SKILL.md`
  stay operator-only, and nothing in (A)/(B)/(C) touches them.** Both `## Deferred findings` resolved on
  the ticket; nothing left in `Deferred`.

- **(pm, 2026-07-31) 🧭 A hazard to the operator's OWN measurement is worth more than a ticket —
  escalate it, don't file it.** Reflect's deferred #1: the boot-corpus A/B now in flight is degraded by
  the very defect LOOP-213 describes — (i) each restart costs a fresh ~143 KB cache-WRITE per agent,
  taxing the arm being measured; (ii) cadence reset per restart makes per-agent fire counts on the two
  arms non-comparable without normalising. No loop ticket can act on that; only the operator can. Carried
  into the report and preserved on LOOP-213 with reflect's OFF baseline (20:00–23:00Z, n=38: pm cacheR
  7.16M / out 65.4k / $7.01 · junior-dev 7.90M / 52.1k / $4.13 · senior-dev 3.32M / 69.7k / $6.30 · qa
  3.92M / 16.8k / $2.07 · sweep 4.47M / 21.6k / $2.33 · reflect 3.74M / 50.2k / $4.50), because a
  baseline that exists only in one agent's report is the thing most likely to be lost.

- **(pm, 2026-07-31) 🗃️ §20 R2 rollup, pass 4 — and the parking lot was re-checked, not just
  re-read.** Rolled 16 method rulings (the day's later PM fires) whose durable content is already in the
  STANDING RULES block; kept whole: the npm-publish decision, the operator's §12b amendment, the Kaizen
  Factory naming + tagline (rebrand tickets LOOP-176/177/178/182 still open, so still in-flight
  direction), and the last fire's three ticket rulings. Candidate ideas (12 entries) re-checked against
  their stated preconditions: **cost-governance (b)+(c) still waits on LOOP-98 `Done` (still Backlog);
  daemon stale-VIEW-code still waits on LOOP-195 shipping (still Backlog)** — both correctly stay parked,
  neither is stale. **A parking lot is groomed by testing its preconditions, not by re-reading its prose.**

- **2026-08-01 — what a merge-objection may and may not do to the board (ruling; encoded as
  LOOP-216's ACs rather than escalated).** The question the guard raised is legitimate — do not
  merge a PR whose ticket is not merge-eligible — but its board mutation is not. Three calls, made
  here so the implementer does not have to re-litigate them:
  1. **A merged PR is never routed.** Once the PR is `MERGED` the objection is moot; `--apply`
     writes nothing and comments nothing. The guard must not record "Not merged." against a commit
     that is on `main`.
  2. **A board-state trip does not mutate the board.** When the trip fires because the ticket is
     `In Review`/`Canceled`/`Duplicate`, the guard refuses the merge and comments, and leaves
     `state`/`assignee`/`labels` alone. The ticket is already in the state being objected about;
     moving it can only reduce reachability, and `In Review` is exactly where its verifier looks.
     Note the standing tension this exposes and does **not** resolve: under `git.landing:"pr"`
     (§12b) `In Review` is the *normal* state of a ticket whose PR awaits merge, so the board-state
     axis trips on the common case. Whether it should trip at all is **LOOP-113's** question, and
     `NOT_MERGE_ELIGIBLE` is explicitly out of scope for LOOP-216.
  3. **A human-review trip routes somewhere a queue serves** — `Todo`, assignee kept at the
     ticket's dev tier, **no `blocked` label** — so the tier's own slice returns it for repair.
  The general form is now folded into standing rule 8: *a guard that mutates state owes its subject
  a reachable destination.*
- **2026-08-01 — a machine demotion is not a verdict, and undoing one is not verifying.** Both
  stranded tickets were repaired, but differently on purpose: LOOP-112 is `pm`-owned, so I verified
  it and closed it `Done`; LOOP-199 is a `Bug` labelled `qa`, so I restored the exact state
  junior-dev had legitimately set (`In Review`, assignee `junior-dev`) and said in the comment that
  nothing in it should be read as a pass. Repairing reachability is lane-neutral; issuing the
  verdict is not.
- **2026-08-01 — §5 rank 1 is a real rank, not a tiebreak.** LOOP-215 and LOOP-216 (both
  `priority=1` + `Bug`) were promoted ahead of four older rank-3.5 bugs. The prior fire's derived
  ordering ("rank by type, then oldest-created; priority gives no tiebreak") is correct *within* a
  rank and wrong *across* ranks — §5's table makes `priority=1` + `Bug` its own top class. Re-read
  §5's table, do not re-derive the order from memory of a past fire's note.
- **2026-08-01 — a proposal parked out of §17 caution is still PM's to rule on; `external-prereq`
  describes the world, not the filer's authority.** LOOP-218 arrived `blocked`+`needs-pm` tagged
  `external-prereq`. There was no external prerequisite: `hub/src/merge-guard.ts` is ordinary
  product code. §17 restricts **reflect** from *applying* structural change — it does not convert a
  product-code proposal into a human-only call. Answered in-ticket and unparked. **Ask of any
  `external-prereq` park: name the external thing. If it cannot be named, the bail-shape is wrong
  and the ticket is answerable.**
- **2026-08-01 — ruling on merge-guard's actor (LOOP-218), with the fallback pinned.** The guard
  hardcodes `"operator"` at `merge-guard.ts:95` and `:103` (re-derived from source before ruling),
  so a tool decision is recorded as a human ruling — and the loop's own read of operator activity
  over-counts by exactly the number of guard trips. **(A) accepted**, with the case the proposal
  left open: use `DEVLOOP_ACTOR` *when set*, and `operator` *when absent* — a hand-run from the
  operator console is genuinely an operator act, so this is not an unconditional substitution.
  **(B) accepted** as a documented, tested invariant (an `operator` event carrying a `data.fireId`
  is a tool write) plus the consumer repair — that is the only half that fixes the four rows already
  on the ledger. **(C) accepted and it is the durable half**: route the writes through the guarded
  layer so the next such caller fails closed rather than being fixed after the fact. Typed `Bug`,
  not `Improvement`: shipped code writing a factually false actor is a defect.
- **2026-08-01 — the boot-corpus A/B is readable on its headline axis and NOT on its cost axis; the
  default flip waits for a restart-free stretch.** Adopting reflect's recommendation (LOOP-218
  deferred finding 1, routed to **LOOP-212**). Cache-read share is **flat, 97.46% OFF → 97.31% ON**
  — the corpus caches cleanly, which was the substantive worry, and it does not reproduce. The cost
  axis must not be read yet: two runner restarts landed *inside* the ON arm, each forcing a fresh
  98–147 KB cache-write per agent onto the arm being measured, and one of senior-dev's two ON fires
  was itself killed. **A measurement whose treatment arm is being taxed by the effect under study is
  not a result** — say so and wait, rather than reporting the number with a caveat nobody reads.
- **2026-08-01 — the cheapest discard was the most expensive one, which is why the fix needs a
  per-agent split.** The junior-dev fire killed at `00:08:37.373Z` burned only $1.13 — and had taken
  **LOOP-215 ninety-six seconds earlier**, so the discard dropped the in-flight fix to the conflict
  that is currently blocking every direct build in the shared checkout, and left the ticket claimed
  `In Progress` by a fire that no longer exists. Recorded on LOOP-219 as the motivation for its
  per-agent AC: **an aggregate can never show that the smallest number was the worst event.**

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
