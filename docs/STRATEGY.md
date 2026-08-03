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

**Top priority (operator, 2026-08-01): CUT PER-FIRE COST — context and prompt compression.**
Recorded under the explicit §9a authorization in **LOOP-228** (*"this intake IS the §9a authorization
for the direction-section edits it implies"*). **Measured baseline — a snapshot, not a constant; re-derive it, do not quote it forward:** as of
**2026-08-01T07:25Z**, **$627.42 across 131 priced fires = $4.79/fire** (ledger
`.dev-loop/team/fires.jsonl`, metered era only — metering came on 2026-07-31T~14:00Z, and earlier
fires carry no price at all). Per agent, mean $/fire: senior-dev 9.20, pm 7.44, reflect 4.60,
junior-dev 4.41, sweep 2.90, qa 2.58. `cacheRead` is **41–61%** of every fire's bill;
`references/conventions.md` is 75% of a PM fire's context. **The prior "~$6.68/fire over 142 metered
fires" baseline was arithmetically impossible — two agents' stated means exceeded their own most
expensive fire ever recorded — and is withdrawn** (found by PM under LOOP-233; re-derived
independently and corrected by the operator, 2026-08-01 — LOOP-228 carries the corrected table).
This
outranks the current queue except correctness/security work already in flight. Program carried by
**LOOP-228** (umbrella, holds the acceptance criteria) → **LOOP-232** (senior design-and-delegate) and
**LOOP-233** (model tier — **CLOSED on the null, operator ruling 2026-08-01**: no tier change for
pm / senior-dev / reflect, and **the bill is driven by context VOLUME, not model tier** — junior-dev,
on the cheapest tier, reads more `cacheRead` per fire (8.69M) than pm (7.50M), senior-dev (7.12M) or
reflect (3.79M), and sweep on sonnet is the most expensive agent per hour on this board. Do not
re-open tiering on price; `effort` is refused on the same grounds, absent a measurement). Binding constraints from the operator: measure every
change; never trade correctness for bytes (verification classes, block-vs-guess, §16, the §2 label
stay); splitting files saves nothing; turns count as much as bytes; and `assembleBoot` is **not**
re-proposed — LOOP-211/212 measured push-mode a net loss here (+44% cacheWrite / +25% cacheRead). **LOOP-239 (the per-agent cost surface) must land before this program measures
anything against a baseline** — a figure no shipped surface can reproduce is unfalsifiable, and that
is precisely how the withdrawn one survived a day steering the top priority.
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
  service backend + `dev-loop` CLI, **v1.14.0 line** (see `CHANGELOG.md`; the installed binary is what the loop actually runs, and since 2026-08-01 this host installs it from a **local source build**, not npm — see the release-skew and pin notes below), with the full npm test
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

- **Fire journals through 2026-07-31 are archived in `docs/strategy-archive/2026-08.md`** (§20 R2,
  pass 5 — rolled 2026-08-01). Still in force from that arc, distilled: **(a)** the boot corpus is
  DELIVERED (`--assemble-boot`, 98–147 KB per fire, all six agents) — score a lessons rule only from
  2026-07-31T23:00:15Z on; **(b)** the reports tree keys on **local** `date +%F` while every artifact
  it indexes is **UTC** (LOOP-214, standing rule 1); **(c)** every cost surface bills fires killed
  mid-flight as delivered — 7.9% / 40.27 USD (LOOP-219), and an aggregate can never show that the
  smallest number was the worst event.


### 2026-08-01 (pm, tenth + eleventh fires) — [ARCHIVED]

Both rolled whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2
passes 10 and 12; the two stubs merged into one here under pass 13). Clauses still in force:

- **An upgrade has THREE axes on this host, not one** — the CLI (fresh process, instant), the hub
  daemons (restart required), and the long-lived `run-agents` scheduler (restart required, nothing
  detects it). Never answer "is this host current?" with `dev-loop --version`.
- **`merged` ≠ `published` ≠ `installed` ≠ `running`.** Attribute runtime behaviour from
  `dev-loop events` and the installed tree, never from repo source.
- **A stale hub daemon silently rewrites board writes.** Board writes execute *in the daemon*, so
  while it runs old code a dev-tier actor's cross-tier assignment collapses to self and senior-dev
  cannot stage junior children — split-dev delegation is disabled with no error anywhere. Tracked as
  LOOP-258; **still open, still stale, 2h17m parked as of the fifteenth fire.**
- **The bottleneck is landing, not idea supply.** A deep Backlog with an idle tier is a routing or
  infrastructure problem; filing more tickets is padding, not throughput.
- **Aggregates hide the worst event.** Every cost surface bills fires killed mid-flight as delivered
  (LOOP-219), and a mean can never reveal that the smallest number was the most expensive mistake.
- **A correction must travel with the thing it corrects.** The merge-guard producer named in that
  arc was exonerated, then found guilty on the third pass; the record keeps all three steps because
  the middle one is what made the last one findable.
- **A doc edit riding a correct code change is the least-guarded thing a ticket can ship** — LOOP-103's
  code was right and its CI green; the false claim entered through the *documentation* half. Closed by
  LOOP-257, which added the executable pins.
- **Verify against a fixture that can distinguish, not one that can only agree.**
### 2026-08-01 (pm, twelfth → fifteenth fires) — [ARCHIVED]

All four rolled whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2
passes 13, 14, 15 and 16 — the fifteenth fire's journal block followed under pass 16;
four stubs merged into one here). Clauses still in force:

- **A queue whose depth is stable can still be starving its tail.** Measure a backlog by the age
  spread of what *leaves* it, not by row count: `opQueue`'s pm `backlog` list is the only servable
  list with no `ORDER BY` (LOOP-262, **still unshipped**), so rows filed 2026-07-30 have never once
  been promoted. Until it lands, promote the starved tail **by hand**.
- **Before optimising against a metric, enumerate what the metric does NOT count** — and check that
  list against the rules telling agents what to read (LOOP-263).
- **`dev-loop metrics` prints two contradictory answers about the same ticket, two lines apart**:
  `boardMetrics()` selects the `blocked` **label**, `decisionQueue()` the `Human-Blocked` **state**,
  so `parked` is a constant `0` rendered as a clean board (LOOP-265, still unshipped).
- **A filing can produce an unreachable ticket, not just a writer can** — a `Backlog` row with a null
  assignee is invisible to both tiers and must trip the same check (LOOP-244/LOOP-261).
- **`ensureHub` → `wireEnv` unconditionally sets `DEVLOOP_PROJECT="_team"`**, so `dev-loop run`'s
  pre-flight can only ever restart the `_team` daemon, never the per-project daemon every agent-fire
  op resolves to — the structural reason LOOP-258's class of incident cannot self-heal (LOOP-261).
- **`save_comment` does not touch `tickets.updated_at`; only `save_issue` writes do.** Commenting on
  a parked ticket is free. Measured three ways. The false version of this belief was load-bearing in
  LOOP-108's own headline — a wrong mechanism in a *headline* is more dangerous than one in a body,
  because it is what a builder reads first and re-derives least.
- **Run the NEW test file unchanged against the OLD source.** "Does this test fail without the fix?"
  is the only question separating real coverage from decoration (LOOP-207: 3 of 8 checks fail at the
  pre-fix base, and they are exactly the post-relabel assertions).
- **A measurement that kills my own hypothesis is a result, and it stays out of the Backlog.** The
  fire-allocation theory died on one number: qa's median fire is 307 s against junior's 1278 s —
  cheap short fires, not stolen capacity. Filing an unmeasured theory converts a hunch into work
  someone must later triage.
- **Sequence on a real data dependency, never on a preference about which surface should look
  correct first.**
- **A program with more than three carriers owes a periodic check that its cuts are aimed at the
  dominant term — and the check is a query, not a review.** For the compression program: modeled
  context bytes correlate **0.138** with a fire's `cacheRead`, fire duration **0.777** (196 priced
  fires). Six of its carriers were byte-side. Re-run once new priced fires land (LOOP-267).
- **An AC may assert an INVARIANT over live data, or an EXACT VALUE over a fixture — never an exact
  value over a live ledger.** A correct implementation then looks broken, and the cheapest way to
  green the box is to ship a wrong number that passes its own test (LOOP-239).
- **If the wrong order produces a wrong artifact, it takes a `Blocked-by:` edge** — the §5 pick order
  reads state, priority and labels, never prose. A sentence is documentation, not a constraint.
- **A standing authorization covers the edit it named, not every edit in its section.** When an old
  number in a DIRECTION section is hedged rather than wrong, the correction belongs in the progress
  sections and on the program's carrier ticket.
### 2026-08-03 (pm, sixteenth fire) — [ARCHIVED]

Rolled whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 17).
Clauses still in force:

- **The daemon downgrade is a scheduled event, not drift, and the vector is our own Claude plugin.**
  `~/.claude/settings.json` sourced the plugin from a stale checkout whose SessionStart hook runs
  `daemon up` from ITS tree on every fire — and the hook is silenced with `>/dev/null 2>&1 || true`,
  so the one action that corrupts every board write is the one guaranteed to be invisible.
  **Still live in a new shape:** this fire found **three** `_team` daemons at **v1.12.0** beside a
  `loop` daemon at v1.14.0. The re-arm vector was neutralised for the pinned path; a duplicated,
  version-split fleet was not. LOOP-252 / LOOP-261 own the causes; LOOP-137 now owns making the
  fleet observable at all.
- **A daemon launched from `.ts` source emits a `Type Stripping` warning into its log; a dist-build
  daemon does not.** That warning is provenance — it names which tree a daemon came from when
  `daemon status` cannot.
- **One predicate, two opposite failures.** Version-string equality misses a SHA that moved
  (LOOP-250: a no-op that reads as success); version inequality treats *older* as *stale*
  (LOOP-252: a downgrade). An ordering-only fix closes one and leaves the other alive.
- **A dark window is not a throughput problem.** The 40-hour gap was a provider weekly ceiling.
  Read fires-per-hour against the subscription before reading it against the queue.


### 2026-08-03 (pm, eighteenth fire) — two verifications closed, and one only closed because I broke a cycle the board could not

`origin/main` is **`f590b68`** — LOOP-173's own merge; the product moved on code for the second
consecutive fire, so the lens list resets here. Doc-watch: `docs/STRATEGY.md` unchanged from what I
landed (**43 fires, no foreign doc edit**) — but the operator wrote on the *board* this fire, which is
where the direction actually arrived.

**LOOP-173 `Done`, and its own wire repro is the whole verdict.** Against a listener bound to this
box's non-loopback address: at `50a488c` it printed `authorization="Bearer <canary>"`; at `f590b68`
it printed **nothing at all** while the CLI exited 5 naming both remedies; with
`DEVLOOP_ATTACH_ALLOW_PLAINTEXT=1` the request arrives again. Leak real, closed, escape hatch intact
— three rows, no inference. Both suites green on the merged tree (28 new assertions), `main`'s own CI
green during the fire, and all five cited Codex thread resolutions re-derived as genuinely present.

**LOOP-258 `Done` — the operator closed the daemon-downgrade vector at its source**, repointing the
`dev-loop` marketplace `source.path` from the stale jinko checkout to the pinned 1.14.0 build, so
plugin and PATH CLI are now one artifact and skew is structurally impossible rather than fixed.
Verified from my own fire rather than their table: `loop` pid 45295 **v1.14.0**, `_team` pid 40984
**v1.14.0**, and the CLI's "running OLD code" remedy line — the surface that named this bug — is gone.
Third attempt, first that held under load.

**I closed it on AC1 alone because of a cycle, not a concession.** AC3 ("LOOP-172's junior child is
re-staged") can only happen inside LOOP-172, which was blocked **by LOOP-258**; holding the tracker
open for AC3 guaranteed AC3 could not occur. AC2 needs a real senior-dev cross-tier write, which I
cannot honestly produce as `pm`. Both were **re-homed onto LOOP-172** — one observable, on the ticket
that owns the work — rather than checked or dropped.

**The operator's loose end was real and worse than reported.**
`~/.claude/plugins/cache/dev-loop/dev-loop/1.9.0` is a real directory carrying `hub/package.json`
**1.9.0**, whose `hook-session-start.ts:16` spawns `daemon up` from *its own tree*; if it ever became
the resolved plugin source again it would downgrade a 1.14.0 daemon **five minor versions**. Filed
nothing — LOOP-252's AC1 neutralizes it and its AC4 is what would have made it visible without `ps`.
The verified writeup went **on LOOP-252**, whose stakes it raises; a second ticket would have split
one fix across two rows.

**Structural picture, ninth consecutive measurement, unchanged.** Junior **12** unblocked `Todo`
against a cap of 10 (over); senior **6**/10 with **zero** senior-tier Backlog rows to draw from;
Backlog **67** (66 junior + the untiered LOOP-228 umbrella). Promotion correctly **0** — not for want
of slots, but because the side *with* slots has nothing filed for it. §9c: all **11** parked rows hold
≥1 live blocker, **0 unparks**; LOOP-172 lost one edge when LOOP-258 closed and stays parked on
LOOP-235. **Filed 0** — the one candidate deduped into LOOP-252 on a real reading of its ACs.

### 2026-08-03 (pm, nineteenth fire) — both verifications survived execution; the loop's real stall is one unpopulated config key holding three green PRs

`origin/main` is **`367e4c3`**; the product moved on code for the first time in three fires
(`d00b786` LOOP-95, `8488a7b` LOOP-206 — both landed *during* my previous fire, after its review
SHA). Lenses reset. Doc-watch hash `c85bbe08` unchanged — **44 fires with no foreign doc edit**.

**Both In-Review items closed `Done`, verified by execution against the merged tree, not by diff.**
The decisive evidence in each case was outside the test suite: I ran the merged **reaper against
this machine's real four-daemon fleet** (it reaped nothing — the live daemons run an older build
with no `service` marker, so it could not identify them and correctly refused to act: fail-closed
on real infrastructure, a stronger statement than the fixture makes); and I ran the merged CLI's
`--kaizen --json` against the **live board** and compared every field to the rendered page
(identical, because both read one core — which is the literal claim AC4 makes, not the in-test
proxy). Per-AC detail lives on LOOP-95 / LOOP-206; it does not belong here.

**The real bottleneck this fire is not the board — it is one absent config key.**
`team.agentReviewers` is unpopulated, so merge-guard counts `chatgpt-codex-connector` as a blocking
human. Verified on the forge: **#134, #145 and #146 are ALL `MERGEABLE` + `CLEAN` right now**, each
held solely by unresolved Codex threads; #134 is at review **round 12** (10 fix commits, 9 senior
fires). senior-dev parked LOOP-235 `Human-Blocked` correctly — option A is a config mutation,
option B is risk-acceptance on a `sensitive` leak guard, and both are operator-only. What was
missing was the **size** of the decision, so I put it on the ticket: the gap holds **six** tickets,
and LOOP-236 → LOOP-237 → LOOP-238 is the context-compression chain under LOOP-228, **the
operator's own stated P1**. An AI reviewer against a `--strict` gate has no terminating state by
construction; every extra round is a full senior fire spent on remediation *text*.

**§9c: one unpark, ten correctly held.** LOOP-137's only blocker closed, so I dropped `blocked` and
retired the edge — but left it in `Backlog` rather than bouncing it to `Todo`: §9c's "back to Todo"
is for work parked *out of* Todo, and jumping a never-promoted ticket past the depth cap would
launder a promotion. I re-scoped it too: it was filed on "all 64 ports occupied", and today's fleet
is four listeners with a **version split** (three `_team` at v1.12.0 beside `loop` at v1.14.0), so
its check needs a duplication/skew axis alongside saturation.

**One ticket filed — LOOP-271 — and its value is that it names a cause, not an instance.**
`metrics --kaizen` printed a full panel for `[fixture]`, a project this workspace declares
`scratch:true` and `rotation.ts` guarantees can never fire. Cause: `deliveryProjects()` filters
`_team` **only**, so four consumers re-apply `!p.scratch` by hand and every consumer written since
is scratch-blind by default — metrics (3 sites) and the web (2 queries) already are.

**Structural picture — ninth consecutive measurement.** Junior **10/10** unblocked `Todo` (exactly
at cap, down from 12 — the two verifications drained it); senior **4/10** with **zero** senior-tier
Backlog rows. Promotion correctly **0** on both tiers: junior has no headroom, senior has headroom
and nothing eligible. I did **not** manufacture senior work to feed the idle tier — §21b routes by
the work's nature, and an idle expensive tier is a cheaper mistake than an invented design.

**Not filed, deliberately:** the duplicated `_team` fleet is LOOP-252 / LOOP-261 / LOOP-137, all
open — recorded as evidence on LOOP-137. The kaizen ratchet rendering `… → 90 (1.8.1) → 90` is a
display duplicate the implementer self-flagged; a nit, and I closed the correct increment rather
than holding it hostage.


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

- **2026-08-03 (pm, nineteenth fire) — a cancelled CI run on a superseded SHA is not a red gate; read
  the conclusion of the tree that CONTAINS the change, not of the commit that introduced it.** Both
  tickets I verified this fire had `conclusion: cancelled` on their own commit — GitHub's concurrency
  group kills an in-flight run the moment the next push lands, so on a busy branch the *normal* state
  of a mid-stack commit is "cancelled", not "green". Taking that at face value would have verify-failed
  two correct increments for an infrastructure artefact. **STANDING: resolve a merged change's CI by
  finding the newest ancestor-containing SHA with a completed conclusion and reading THAT
  (`git log <sha>..origin/main` to prove containment); never read a `cancelled` as a fail, and never
  read a green on a sibling branch as certifying your tree.**

- **2026-08-03 (pm, nineteenth fire) — an exclusion applied at the call site is a convention; only an
  exclusion applied at the seam is a contract.** `deliveryProjects()` filters `_team` and nothing
  else, so four separate consumers re-apply `!p.scratch` by hand and every consumer written since is
  silently scratch-blind (LOOP-271). The defect is not that metrics forgot — it is that the helper's
  signature made forgetting the default. **STANDING: when a marker means "exclude this everywhere",
  the shared accessor excludes it and callers opt IN to see it; a `filter()` repeated at N call sites
  is an N+1'th bug waiting for the next caller.** Same disease as the "third un-unified copy of what
  is servable" (LOOP-169) — count the copies of a predicate before fixing the instance you found.


- **2026-08-03 (pm, eighteenth fire) — when a tracker's remaining acceptance can only be satisfied by
  a ticket the tracker itself blocks, the tracker is the side that must yield.** LOOP-258's AC3 was
  "LOOP-172's junior child is re-staged"; LOOP-172 was blocked by LOOP-258. Held open for AC3, the
  tracker guaranteed AC3 could never happen — a cycle with no exit that does not run through closing
  it. **STANDING: before holding a ticket open for an unchecked AC, check whether that AC's work sits
  behind an edge this ticket owns. If it does, close on the ticket's own deliverable and RE-HOME the
  remaining ACs onto the ticket that owns the work — never leave orphaned boxes on a closed tracker,
  and never leave a cycle to the next fire on the theory that caution is free.** A second rule fell
  out of the same close: **an AC only another actor can honestly certify is not a box for the verifier
  to check** — AC2 needed a real senior-dev write, and producing it under a borrowed actor would have
  been worse evidence than leaving it open.

- **2026-08-03 (pm, eighteenth fire) — a verification step that only proves its worth when it fires is
  still cheap enough to always run.** Last fire the assertion-vs-tree check caught two Codex thread
  resolutions on LOOP-184 whose named symbols were absent from the merged tree. This fire the
  identical check on LOOP-173 confirmed **five of five** hardening claims genuinely present in
  `ui-token.ts` at the merge SHA. **STANDING: do not score a check by its hit rate. The LOOP-184 case
  cost two seconds and caught a permanent false claim on `main`; the LOOP-173 case cost the same two
  seconds and converted "the author says so" into "the tree says so" — which is what let me close a
  `sensitive` ticket without hedging.** Related and distinct: when an AC asserts a universal ("the
  token is NEVER sent over plaintext"), the named cases passing is not the invariant holding —
  enumerate the exits and prove there is only one.

- **2026-08-03 (pm, eighteenth fire) — I have been rolling up the second-largest section for fifteen
  passes.** Measured rather than assumed this fire: `Current state` is **40,201 B (38.1%)** and
  `Decisions (running log)` **36,782 B (34.8%)** of a 105,576 B doc — my carried belief that Decisions
  was the largest PM-ingested section was wrong, and the rollup discipline has been aimed accordingly.
  The doc has also grown **net** across recent passes despite every one of them. **STANDING: a
  retention discipline needs a periodic measurement of WHERE the bytes are, not just a ritual applied
  where they were once. Pass 16 therefore rolls a Current-state journal block for the first
  time (5.0 KB) alongside the sixteenth-fire rulings (3.5 KB): 8.5 KB out against 6.7 KB written
  back, taking the doc 105,576 → 103,759 B. A **measured** net reduction — the first pass in this
  arc whose arithmetic was checked rather than assumed.** This doc is read by every PM fire, so its size is a direct
  input to LOOP-228's per-fire cost program, not merely housekeeping.

- **2026-08-03 (pm, seventeenth fire) — a code-review thread is closed by an assertion, and nothing
  on this loop compares the assertion to the tree.** LOOP-184 landed with two Codex P2 threads
  resolved by a reply describing an `Object.hasOwn` guard and export-side `--run-agents` validation.
  Neither is in the merged commit `50a488c`, and neither is in the branch tip `21c061e` the handoff
  says it verified — the claims were specific, technically fluent, and false, and one of them is now
  permanent in the squash-merge commit message on `main`. merge-guard holds a PR while unresolved
  threads exceed zero and releases at zero; the resolution is prose, so **the merge gate was
  satisfied by a sentence.** No cheap mechanical check would have caught this one — the author cited
  the correct head SHA, it simply did not contain the change. **STANDING: a review thread's
  resolution is a claim of the same kind as a handoff comment, and §3 stage-1 triage already says to
  locate with the self-claim and never judge by it. Extend that to resolved threads: when a
  verification reads a thread as evidence, re-derive the named symbol from the tree — `git show
  <merge-sha>:<path> | grep <symbol>` is two seconds and it is the whole difference between
  "resolved" and "fixed".** Recorded on LOOP-198 (completeness of acceptance) as a second, distinct
  leak: unchecked ACs are one, review findings a reply can close are the other.

- **2026-08-03 (pm, seventeenth fire) — hardening the consumer of a two-ended mechanism, without the
  producer, converts a soft failure into a trap.** LOOP-184 correctly made `bundle` *load* refuse an
  invalid `run.agents`. `bundle export` still accepts any `--run-agents` value, and writes the bundle
  *before* `--move` retires the source workspace. So one typo now strands an operator between a
  workspace that refuses to run and a bundle that refuses to load — a failure mode that **did not
  exist before the fix**, because the old loader merely launched an unhelpful roster. **STANDING:
  when a ticket adds a refusal at one end of a produce→consume pair, its acceptance owes an explicit
  answer for the other end — either the producer is validated by the same predicate, or the ticket
  states why an artifact its own consumer will reject is acceptable to emit. And the severity lives
  in the ORDERING: validating at argument-parse time, before any filesystem or workspace effect, is
  what makes it safe; validating just before the write is not.** Filed LOOP-269 (`sensitive`, senior
  tier) carrying this plus the unshipped prototype-chain guard.

- **2026-08-03 (pm, seventeenth fire) — "fail-closed" and "refuses legibly" are independent
  properties, and a verification that checks only the first will pass a security fix that cannot say
  what it refused.** `parseAgentSpec` resolves group aliases with a plain property read, so every
  inherited `Object.prototype` key (`constructor`, `toString`, `__proto__`, …) is truthy and gets
  spread as a non-iterable. Executed end-to-end, that token class still exits 1 and still
  materializes nothing — the safety property holds — but it gets there by throwing an uncaught
  `TypeError`, so the operator loading a tampered bundle sees a stack trace instead of the message
  naming `run.agents`. Two of the three assertions in the real tamper arm pass; only "the refusal
  names the field" fails. **STANDING: for any refusal whose job is to tell a human that input was
  hostile, the acceptance test asserts on the MESSAGE, not only on the exit code and the absence of
  side effects — otherwise a crash and a diagnosis are indistinguishable to the suite.** This is also
  the cheapest generalisation available from this fire: it is the same defect shape as a gate that
  prints a plausible success, only inverted.

- **2026-08-03 (pm, sixteenth fire) — [ARCHIVED] 4 rulings** (one predicate failing in two
  opposite directions so an ordering-only fix leaves the silent half alive; a tracker whose
  prerequisite was satisfied and then reverted; find the CALLER before re-asking a human for a
  fix; when the bug IS invisibility, diagnosability is part of the fix). Rolled whole to
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 16).

- **2026-08-01 (pm, fifteenth fire) — [ARCHIVED] 4 rulings** (one correlation as the cheapest test
  that a program is aimed at the right variable; an AC pinning a live measurement is a test with an
  expiry date; a landing order that lives in prose is not a landing order; a standing authorization
  covers the edit it named, not every edit in the same section). Distilled into the merged
  twelfth–fifteenth stub under `Current state`; full text in
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) under `# Rolled 2026-08-03 (pass 15)`.

- **2026-08-01 (pm, fourteenth fire) — [ARCHIVED] 3 rulings** (test a procedural
  mechanism before letting it shape behaviour; a measurement that kills your own hypothesis is a
  result and stays out of the Backlog; sequence on a real data dependency, never on a preference).
  Distilled into the merged twelfth–fourteenth stub under `Current state`; full text in
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) under `# Rolled 2026-08-03 (pass 14)`.

- **2026-08-01 (pm, twelfth fire) — [ARCHIVED] 3 rulings** (the age-distribution test for a starving
  backlog; enumerate what a metric does not count before optimising against it; name the mechanism
  and its start date when a grooming action bets on an unlanded one). Distilled into the twelfth-fire
  stub under `Current state`; full text in
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) under `# Rolled 2026-08-01 (pass 13)`.

- **2026-08-01 (pm, eleventh fire) — while the hub daemon is version-skewed, senior-tier filings are
  direct-code shaped only.** A stale daemon silently collapses a dev-tier actor's cross-tier
  assignment to self, so senior-dev can author a design but cannot stage its junior children
  (observed: LOOP-172's child LOOP-256, canceled by its author). Filing `Mode: design`
  design-and-delegate work in that state creates tickets that provably cannot complete. Until
  **LOOP-258** (the operator restart tracker) clears, senior-tier ideation routes to direct-code or
  waits. This is a routing constraint imposed by infrastructure, **not** a revision of §21b — the
  tier signals are unchanged, and borderline work still goes junior. Corollary for reading the
  board: a tier holding open cap slots is not evidence of starvation; check whether its queue is
  *completable* before concluding PM has under-fed it.
- **2026-08-01 (pm, eleventh fire) — a doc that misdescribes config is the same defect class as code
  that drops it, and gets the same verify-fail.** LOOP-103 shipped correct, tested, merged code and
  still failed AC3, because its schema-doc row inverted two terms of the precedence chain. The
  ticket existed to stop `config-schema.md` making false claims about what config does; shipping a
  new false claim in it is not a rounding error on an otherwise-good increment. Recorded because the
  cheap call was to wave it through on the strength of the code.
- **2026-08-01 (pm, eleventh fire) — a blocker edge must point at the ticket that RESOLVES the
  block, not the ticket where it was diagnosed.** LOOP-172 was blocked on LOOP-235 because that is
  where the daemon root-cause was written up; LOOP-235's own deliverable would never have restarted
  the daemon, so the edge would have auto-unparked into the identical failure. When correcting such
  an edge, ADD the true blocker rather than swapping it out — §9c unparks only when every edge is
  terminal, so an extra edge is strictly safer and does not discard another agent's marker.
- **2026-08-01 (pm, eleventh fire) — verify a handoff's claim about a shared surface before
  repeating it, including a negative one.** senior-dev reported that `doctor` was blind to the
  daemon skew and suggested adding a W-check. The check already existed and had been firing; the
  real defect was that it is unnumbered and sits in a section explicitly stamped non-gating, so
  `DOCTOR_OK` prints over it (**LOOP-259**). Filing the suggested ticket as described would have
  added a duplicate check and left the actual defect in place.

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
  1. **A value the system routes or reports on — a key that indexes data, a ratio that
     summarizes it, or ONE FIELD CARRYING TWO MEANINGS AT ONCE — must be invariant under the
     operations its own system performs routinely, and computed from the SAME source and over
     the SAME population as the data it describes.** The overload form is the newest and the
     most dangerous, because each meaning has a legitimate operation that destroys the other:
     on the `service` backend `assignee` is BOTH the claim and the dev tier (§18/§21b), so the
     Step-0 orphan reset doing exactly what its prose says — *release the claim* — erases the
     routing key and returns the ticket to `Todo` servable by no actor at all (LOOP-223;
     `servable.ts:52` serves a null assignee only to the legacy `dev`). **Ask of any field two
     subsystems both write: is there a routine operation on one meaning that silently destroys
     the other?** Two older instances, same shape:
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
     merged) is pure damage. **And for an ADVISORY guard — one whose remedy the
     operator performs — the test is the ROUND TRIP: after doing exactly what the guard printed, is
     the guard silent AND the hazard gone?** W26 warns on unmerged paths and says *"edit each file,
     then `git add`"*; `git add` clears its predicate and leaves `git rebase` just as broken, so the
     advice converts a detected wedge into an undetected one (LOOP-224). A remedy that silences the
     guard without clearing the hazard is worse than no guard, because the silence is now evidence.**
     **And check the guard's ANCHOR as well as its predicate — the right question asked of the wrong
     object is indistinguishable from a pass.** W06 asks "is anything here committable?" of the
     workspace root rather than the tree that holds the artifact, and the §17 db guard asks about the
     db it *opened* rather than the class it *protects*; both then print reassurance (LOOP-231).
     (Recorded as folded on 2026-08-01 but absent from this block until 2026-08-01 later fire — a
     distillation claimed and not performed. Check the block, not the entry, when a fold is cited.)
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
- **2026-07-31 — [ARCHIVED] the brand decisions + 3 method rulings** (full text in
  `docs/strategy-archive/2026-07.md` under `# Rolled 2026-08-01 (pass 9)`). Live clauses kept here
  because nothing else carries them:
  - **Brand, two-layer rule:** brand = **Kaizen Factory**, engine = **dev-loop**. The npm package
    name, `dev-loop.json`, `DEVLOOP_*`, `.dev-loop/`, `dev-loop/<id>`, `/dev-loop:*` and the §2
    safety label stay VERBATIM — each is a separate future decision.
  - **Tagline (operator, LOOP-179):** _"The lights-out dev team that improves itself."_ Runner-up
    _"It ships software. Then it improves the shipping."_ is grafted onto the `/kaizen` panel header
    (LOOP-180), where the numbers make it evidence rather than a boast — so that design must state
    its no-data behaviour. Localization is not translation: zh uses 黑灯工厂 + 改善.
  - **CLI rename stays phased:** Phase A (LOOP-181) ships the bins + BOTH permissions; Phase B
    (LOOP-182) flips the prose one release later, gated on `kaizen --version` resolving in a real
    fire — published and installed, not merely merged (§12b).
  - **An operator filing that arrives `assignee: null` is TIERED under standing rule 9's second
    clause — that is not a re-tier**, and the load-balancing prohibition is not engaged.
  - **§17's "the plugin's own code is the operator's to apply" does NOT bind a workspace whose
    PRODUCT is the plugin:** `run-agents.ts` is ordinary dev-editable product code. The firewall
    still binds where it applies — `conventions.md` and any `SKILL.md` stay operator-only.
  - **A hazard to the operator's OWN measurement is escalated, not filed** — no loop ticket can act
    on it.

- **2026-07-31 (late arc) — [ARCHIVED] 16 method rulings from the day's later PM fires** (the design-gate fail path vs under-specification; the two halves of a §9c edge; a fix is finished only when every branch answering one question agrees; retiring a defect FAMILY over its leaves; a gate naming a human verifier; §21a promotion unconditional on a pass; the pass-3 rollup keep/roll criterion and the rule that a rollup must RETIRE; a banked idea's precondition as a claim with an expiry; a priority ladder whose fall-through is its success case; a cached mirror read as the fact; STANDING RULE 12 refined; LOOP-74 verify-fail; LOOP-180 pass-with-amendment). Distilled into the STANDING RULES block below; full text in `docs/strategy-archive/2026-07.md` under `# Rolled 2026-08-01 (pass 4)`.
- **2026-08-01 (mid arc) — [ARCHIVED] 14 fire-journal rulings from the day's middle PM fires** (the merge-objection ruling; machine-demotion-is-not-a-verdict; §5 rank-1; the §17-caution proposal ruling; merge-guard's actor; the boot-corpus A/B cost axis; the discard-cost fix; "has the product moved" asked of `origin`; the NEW-in-range marker test; rollup pass 5; the open condition tested NOT met; promotion-count-0 with an idle lane; the cost ordering and why it did not descend KB×agents; the late re-scan's third payday) — full text in `docs/strategy-archive/2026-08.md`.
- **2026-07-31 (fix-arc) — [ARCHIVED] 6 fire-journal rulings from the day's PM fires** (LOOP-208's
  ownership-vs-builder verify gate; LOOP-210's unprotected `bundle export`; LOOP-211 closed on the
  operator's ruling; the push path going live mid-fire, with the flag being ON not the defect; the
  throughput claim I escalated without measuring and corrected in-fire; and the §20 R2 pass-4 rollup
  with its re-checked parking lot). Doctrine kept in the STANDING RULES block above and in the
  entries retained around it; full text in `docs/strategy-archive/2026-07.md` under
  `# Rolled 2026-08-01 (pass 8)`.
- **2026-08-01 (early-to-mid arc) — [ARCHIVED] 14 fire-journal rulings from the day's early and
  middle PM fires** (the two standing-rule refinements; the design-gate MODEL-vs-PROSE axis; the
  §21a-handoff ruling; the program-carrier intake ruling; the guard-ANCHOR instance LOOP-231; the
  full LOOP-233 tier arc — impossible baseline, the refuted extrapolation, the tier rationale, and
  the operator's confirmation). Full text in
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) under
  `### 2026-08-01 (early-to-mid arc) … (§20 R2 pass 9)`. The ANCHOR rule is now genuinely folded
  into standing rule 8 above — it had been *recorded* as folded without being written there, which
  is why this pass checked the block rather than the entry. **The rulings from that arc that are
  still in force, so nobody has to open the archive to obey them:**
  1. **RULING (LOOP-233, operator-confirmed): no tier change.** opus is **~1.6x** sonnet per
     cacheRead token — not the 5-9x a since-withdrawn table claimed — and per HOUR the opus agents
     are not the expensive ones. **Compression is the lever; do not re-open tiering on price.**
  2. **Before a program's first measurement lands, re-derive its baseline from the raw ledger and
     state the denominator.** The withdrawn baseline would have booked LOOP-228 a ~28% saving on
     day one for changing nothing, and let a real regression measure as a win.
  3. **A default is not a decision.** senior-dev's opus has a documented, load-bearing rationale
     (§21a/§21c); pm's and reflect's have none — they inherit `config-schema.md`'s blanket
     `claude: opus`. Nobody decided and nobody overrode. Check which of the two you are looking at
     before defending a configuration.
  4. **An intake ticket carrying PROGRAM acceptance criteria does not close when its children are
     filed** — discharge the ask, keep the program. LOOP-228 is the live instance.
  5. **The §21a gate promotion is a HANDOFF, not the pace valve** — it may take a tier over the §5a
     cap, and that is correct; do not "repair" the overrun by demoting a child.
  6. **A design gate passes on its MODEL and amends on its PROSE** — the two are different axes, so
     a right model with a wrong preamble is pass-with-amendment, not a fail.

- **2026-08-01 (pm, fires ~6–11) — [ARCHIVED] 14 fire-journal rulings from the day's middle and
  later PM fires** (the `doc-land` lock contradiction on LOOP-217; `blocked` as two mechanisms and
  the zero-edge park; the reversal that a zero-edge park on a live PR must be CLEARED; `issue.update`
  recoverability; the LOOP-149 design gate passing on a mechanism expected to fail; the
  holding-guard remedy amendment; detect-vs-fix-every-writer; the release-gate defence; predicate
  sharpness for a new W-code; source-read-is-not-runtime-evidence; the pick-order non-call; the
  senior-supply correction; the dedupe family-growth note). Full text in
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) under
  `# Rolled 2026-08-01 (pass 11)`. The DIRECTION entry on this host's local-source-build pin is
  **kept live below** — it is operational, not historical. Clauses still in force, distilled:
  - **An instruction that names a mechanism is still a claim about the code** — check it before
    encoding it as an AC. A ruling can be contradicted with evidence and the ticket be better for it.
  - **Re-read the queue before acting on a boot snapshot**; check whether the thing you were told to
    do has already been done by someone with the authority to do it.
  - **A zero-edge `blocked` park on a ticket with a live PR must be CLEARED, not flagged** — a park
    with no `Blocked-by:` edge is a leak, not a park, and §9c can never unpark it. Split-dev
    corollary: also restore `assignee` to the tier named in the label, or it stays unreachable.
  - **`op list_events` DOES record `issue.update`** — attribution (actor + fire + time) is
    recoverable, content is not. Do not generalise a UI gap into a data gap; run the query first.
  - **A flagged finding nobody filed is a deferred one**, and **a W-code that cries wolf on its first
    day is worth less than no W-code** — check a new detector's predicate against the live board
    before it ships.
  - **A source read is not evidence about running behaviour; the installed artifact is.** Attribute
    from `dev-loop events` and the installed tree; treat repo source as a hypothesis.
  - **Before filing an "obviously broken" behaviour, check whether it is broken against its spec or
    IS its spec** — the second is a §17 proposal for the operator, not a ticket.
  - **When a tier's Backlog is empty, check its throughput before calling it a routing artefact.**
    An empty queue in front of a productive tier is a supply problem, and the supply is PM's filing
    mix. The no-force-routing half of §21b still holds.
  - **When a sweep ticket exists for a family, a new instance is a comment on the sweep** — but check
    whether the instance shows the family GROWING, which moves the fix to the shared seam.
- **2026-08-01 — DIRECTION: this host is pinned to a local source build. `landing-observability`
  §9.2 Option B supersedes §9.7 here.** *(Recorded under the §9a authorization in the operator's
  ruling comment on **LOOP-246**, 2026-08-01T10:26:17Z. The human's words: "instead of publish and
  test, let's install dev-loop directly from source code, then you can test it immediately.")*
  **Mechanism.** Build tree at **`/Users/shuai/workspace/dev-loop-build`**, pinned to a CI-green
  code commit (`64aebc2` at adoption — deliberately not `origin/main`, whose CI was still in
  flight); `npm i -g <tree>/hub` makes it the PATH `dev-loop`; the daemons are restarted onto it.
  The npm round-trip is removed from the loop; the human release gate survives, because what gets
  built is still a commit a human chose.
  **Refresh procedure** — `git fetch && git checkout <green sha> && npm run build &&
  npm i -g <tree>/hub && dev-loop daemon up`, **then restart the `run-agents` runner.** The runner
  step is mine, not the operator's: the scheduler caches its module graph at boot, so without it the
  orchestrator silently keeps the pre-refresh build (LOOP-253, found by this fire's verification).
  **One correction to how the pin was described, for whoever refreshes it.** The operator recorded
  it as *"a snapshot copy install, not `npm link`"*; `npm ls -g` shows a **symlink** into that live
  worktree, so the stated mechanism is wrong. The safety property survives for a different reason —
  `hub/dist/` is gitignored there, so `git fetch`/`checkout`/`pull` change no executable byte. The
  real exposure is narrower and must be respected: a stray **`npm run build`** in that tree
  re-points every fire on this host instantly, with no version bump, no reinstall, and no doctor
  signal. **That directory is not a scratch checkout.**
  **Why this is not the evidence being overruled.** §9.7 retired Options A and B together on
  arguments — unprotected `main` with a stale-green merge history, and a silently-dead release
  workflow — that are both about **A** (auto-publish to a public registry). Neither transfers to
  **B**: a local build publishes nothing, has no unpublish window, breaks no installer, and reverts
  in seconds. The reversal separates two options that were bundled, rather than contradicting the
  record. **STANDING: when a decision retires several options at once, check which option each
  argument was actually about before treating the bundle as settled.**
  **The measurable claim this makes.** LOOP-38 → LOOP-246 was 2 days and 22 commits of merged-but-
  not-running code. Under the pin that interval should not recur on the CLI axis. It recurred
  immediately on the other two (LOOP-252, LOOP-253) — so the standing test is now per-axis, and
  "is this host up to date" is not answerable by `dev-loop --version` alone.



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
