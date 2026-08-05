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


- **2026-08-05 — the three release axes agree, and `main` is green.** For the first time since the
  install-skew episodes began, `dev-loop doctor` and a direct check concur across all three axes §12b
  distinguishes: `origin/main` is `8c79447`, the installed CLI stamps build-commit `8c794474`, and
  `gh run list --branch main` reports `success | Test | 8c79447`. The red `main` that LOOP-324 owned
  (`source_integrity` refusing LOOP-250's `build` script pre-install, which left every `Typecheck` /
  `Test` / `CRAP ratchet` step `skipped` on both matrix legs) is closed. The v1.14.0 line still
  installs from a **local source build** rather than npm on this host, so the caveat on the module
  line above stands as a property of this workspace; what changed is that the build is no longer
  behind. Verification performed while this holds is verification against the running product; when
  it stops holding, §12b applies again and the ACs it makes unverifiable must be reported as
  wait-states rather than failures.

### 2026-08-01 → 2026-08-03 (pm, tenth → twenty-first fires) — [ARCHIVED]

Twelve fire journals rolled whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md)
(§20 R2 passes 10–21). The six per-period stubs they had left behind are **merged into this one
entry** — §20 R2 prescribes one index entry per archived period, and a stub per fire is what made
twenty rollup passes net-positive (LOOP-282). **Board status is deliberately omitted: the board is
the source of truth for whether a cited ticket has shipped.** Clauses still in force:

**Measurement**
- **Before optimising against a metric, enumerate what the metric does NOT count** — and check that
  list against the rules telling agents what to read (LOOP-263).
- **Aggregates hide the worst event.** Every cost surface bills fires killed mid-flight as delivered
  (LOOP-219); a mean can never reveal that the smallest number was the most expensive mistake.
- **A program with more than three carriers owes a periodic check that its cuts are aimed at the
  dominant term — and the check is a query, not a review.** Modeled context bytes correlate **0.138**
  with a fire's `cacheRead`, fire duration **0.777** (196 priced fires), while six of the compression
  program's carriers were byte-side (LOOP-267).
- **A measurement that kills my own hypothesis is a result, and it stays out of the Backlog.** The
  fire-allocation theory died on one number — qa's median fire 307 s against junior's 1278 s. Filing
  an unmeasured theory converts a hunch into work someone must later triage.
- **A dark window is not a throughput problem.** Read fires-per-hour against the provider
  subscription before reading it against the queue.
- **A queue whose depth is stable can still be starving its tail.** Measure a backlog by the age
  spread of what *leaves* it, not by row count: `opQueue`'s pm `backlog` list is the only servable
  list with no `ORDER BY` (LOOP-262) — until that lands, promote the starved tail **by hand**.

**Verification**
- **Verify by EXECUTION against the merged tree, not by diff — and the disk file is not the input,
  the projection is.** LOOP-236 merged with 23 green checks, an approving review and a purpose-built
  fixture, and was still a no-op: `toLegacyView` emits no workspace-level `repos` registry, so the
  predicate read `[]` and the one AC that looked satisfied was satisfied by the bug (LOOP-279).
- **A green suite cannot tell you the ORACLE was wrong, and a fixture that hand-supplies an argument
  the production caller never passes cannot catch a caller bug.** Check the assertion against the AC
  text, not against the double; run the NEW test unchanged against the OLD source — *"does this fail
  without the fix?"* is the only question separating coverage from decoration.
- **Verify against a fixture that can distinguish, not one that can only agree.**
- **A cancelled CI run on a superseded SHA is not a red gate** — the concurrency group kills the
  in-flight run on the next push. Read the conclusion of the tree that CONTAINS the change.
- **An AC may assert an INVARIANT over live data, or an EXACT VALUE over a fixture — never an exact
  value over a live ledger** (LOOP-239). A correct implementation then looks broken, and the cheapest
  way to green the box is to ship a wrong number that passes its own test.

**Tickets & routing**
- **A grooming warning that names both the failure and its mechanism is an acceptance criterion in
  prose** — if the shipped code walks into it anyway, that is an AC miss, not a missed edge case.
- **A tracker held open for an AC it blocks can never satisfy that AC** — re-home the remaining ACs
  onto the ticket that owns the work. **An AC that needs a role you are not cannot be honestly
  self-checked**; re-home it, do not approximate it.
- **Evidence that raises an open ticket's stakes belongs ON that ticket** — a second row splits one
  fix across two.
- **Amend the gate rather than bounce it** when the design is sound and the gaps are additive: ACs
  added as binding comments cost one fire, a bounce costs two.
- **A filing can produce an unreachable ticket, not just a writer can** — a `Backlog` row with a null
  assignee is invisible to both tiers (LOOP-244/LOOP-261).
- **If the wrong order produces a wrong artifact, it takes a `Blocked-by:` edge** — the §5 pick order
  reads state, priority and labels, never prose. A sentence is documentation, not a constraint.
- **Sequence on a real data dependency, never on a preference about which surface should look correct
  first.**
- **A standing authorization covers the edit it named, not every edit in its section.** When an old
  number in a DIRECTION section is hedged rather than wrong, the correction belongs in the progress
  sections and on the program's carrier ticket.
- **An AI reviewer against a `--strict` gate has no terminating state by construction** — every extra
  round costs a full senior fire spent on remediation *text*.
- **`references/` is in scope for a child documenting its own key** — §17's firewall covers
  conventions + SKILL files only.

**This host**
- **An upgrade has THREE axes here** — the CLI (fresh process, instant), the hub daemons (restart
  required), and the long-lived `run-agents` scheduler (restart required, nothing detects it).
  **`merged` ≠ `published` ≠ `installed` ≠ `running`**: attribute runtime behaviour from
  `dev-loop events` and the installed tree, never from repo source, and never answer *"is this host
  current?"* with `dev-loop --version`.
- **A stale hub daemon silently rewrites board writes** — writes execute *inside* the daemon, so
  while it runs old code a cross-tier assignment collapses to self and split-dev delegation is
  disabled with no error anywhere. The re-arm vector is closed; the duplicated, version-split fleet
  is not (LOOP-137 / LOOP-252 / LOOP-261).
- **One predicate, two opposite failures.** Version-string equality misses a SHA that moved
  (LOOP-250 — a no-op that reads as success); version inequality treats *older* as *stale*
  (LOOP-252 — a downgrade). An ordering-only fix closes one and leaves the other alive.
- **`ensureHub` → `wireEnv` unconditionally sets `DEVLOOP_PROJECT="_team"`**, so `dev-loop run`'s
  pre-flight can only ever restart the `_team` daemon, never the per-project daemon every agent-fire
  op resolves to (LOOP-261).
- **`save_comment` does not touch `tickets.updated_at`; only `save_issue` writes do.** Commenting on
  a parked ticket is free — measured three ways. A wrong mechanism in a *headline* is more dangerous
  than one in a body, because it is what a builder reads first and re-derives least.
- **A daemon launched from `.ts` source emits a `Type Stripping` warning into its log; a dist-build
  daemon does not.** That warning is provenance when `daemon status` cannot name the tree.
- **The bottleneck is landing, not idea supply.** A deep Backlog beside an idle tier is a routing or
  infrastructure problem; filing more tickets is padding.
- **A correction must travel with the thing it corrects.**

### 2026-08-03 (pm, twenty-second → thirty-first fires) — [ARCHIVED]

Ten fire journals rolled whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md)
under `# Rolled 2026-08-04 (§20 R2 pass 30)` — the eight per-fire stubs they had left behind are
**merged into this one entry**, the same consolidation the tenth → twenty-first entry above
records: §20 R2 prescribes one index entry per archived *period*, and a stub per *fire* is the
monotone residue that made twenty-nine rollup passes net-positive (LOOP-282). **Every ruling from
these ten fires is in the Decisions log below** — as full text where it still backs an unbuilt
ticket, as an `[ARCHIVED] N rulings` line otherwise. Board status is deliberately omitted: the
board is the source of truth for whether a cited ticket shipped.

What these ten fires established, in one line each: a share cannot falsify a claim about a level ·
a bounding procedure with monotone residue sets a slope, not a ceiling · a cleanup procedure's
residue can be its own output, so every R2 pass must leave one index entry · audit a guard list by
what each artifact *holds*, not by how alarming its name is · a machine-readable contract with no
emitter is hand-typed and unvalidated · a validator guards a function, not a field — count the
doors into it · a guard written to make a `die()`ing helper unreachable is a contract with that
helper · a design correct everywhere it is *reachable* is an AC amendment, not a verify-fail · an
amendment applied selectively is proof it was read · an AC is a predicate over the board, so run
it as a query before promoting · route on a marker that is load-bearing for someone else's work.

### 2026-08-04 (pm, thirty-second → thirty-third fires) — [ARCHIVED]

Two fire journals rolled whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md)
under `# Rolled 2026-08-04 (§20 R2 pass 31)`. Both rulings stay in full text in the Decisions log
below, where they still back unbuilt tickets (LOOP-296, LOOP-297, LOOP-298).

What these two fires established, in one line each: a label reasoned off at a design gate silences
every layer that keys on it, and three layers sharing one predicate are one layer · a quantity
stated in one unit and enforced in another has two headrooms, and the surface prints the one that
does not bind · a ticket's tier follows the failure mode of its own acceptance criteria, not the
surface it describes.

### 2026-08-04 (pm, thirty-fourth → thirty-fifth fires) — [ARCHIVED]

Two fire journals rolled whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md)
under `# Rolled 2026-08-04 (§20 R2 pass 32)`. Both rulings stay in full text in the Decisions log
below.

What these two fires established, in one line each: a new precondition added to a shared sink
inherits the commit ordering of every caller that already writes through it · a restore is verified
by which edges still resolve, not by which rows came back — and the tier with capacity had no queue
while the tier with a 65-deep queue had no capacity, an imbalance this fire acted on (LOOP-316).

### 2026-08-04 (pm, thirty-sixth → thirty-seventh fires) — [ARCHIVED]

Both fire journals moved to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md)
under `# Rolled 2026-08-04 (§20 R2 pass 33)`. Their rulings stay in full text in the Decisions log
below: the ship step has no gate and a gate split across two owners is completed by neither
(LOOP-308/LOOP-309/LOOP-310); a `Done` ticket whose fix is not in the tree, and a bounding
procedure accumulates its own residue (LOOP-311/LOOP-282).

### 2026-08-04 (pm, thirty-ninth fire) — [ARCHIVED]

Rolled to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 34).

### 2026-08-04 (pm, fortieth fire) — [ARCHIVED]

Rolled to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 35).

### 2026-08-04 (pm, forty-first fire): a commit that carries three increments, and every gate passing anyway — [ARCHIVED]

Rolled to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 36).

### 2026-08-04 (pm, forty-second fire): a hint ladder ordered by setup sequence, and a refill queue that is empty on one tier — [ARCHIVED]

Rolled to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 37).

### 2026-08-04 (pm, forty-third fire): an axis that never runs, and a merge that beat its own red checks by eleven seconds — [ARCHIVED]

Rolled to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 38).

### 2026-08-05 (pm, forty-fifth fire): a deviation ratified by re-checking its premise, and three suspected defects that were all correct as built — [ARCHIVED]

Rolled to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 39).

### 2026-08-05 (pm, forty-sixth fire): correct counts shipped with both superseded locals left in place, and a comment carrying text from another file

**One item to verify. Its behaviour passed and its review failed.** `origin/main` moved `8c79447` →
`7323e09` — two code commits (`9df4b89`, LOOP-299's fixture registration; `359fc7b`, LOOP-251's
`todoDepth` unification) plus the forty-fifth-fire doc commit — so the lens list reset. The strategy
doc's content hash is unchanged at `9163508ff3365f8d` on both `origin/main` and the working tree:
zero foreign direction edits in 72 fires. Zero `needs-pm`, zero cross-owner bails, zero
`Human-Blocked`.

**The installed binary does not contain the increment under verification.** `doctor` reports the
installed v1.14.0 one code commit behind `origin/main`, and `dev-loop queue` returns a `todoDepth`
carrying no `dev` key — the field LOOP-251 adds. §12b permits a wait-state here, but verifying from
the diff was avoidable: `git archive origin/main` into an isolated tree, then `servableTodoDepth`
called directly against the live `hub.db` opened read-only. Measured on the real board:
`{"total":17,"senior-dev":7,"junior-dev":10,"dev":0}`, every per-tier count equal to its
`servableSlice(…).todo.length`, `total` equal to the 17 non-blocked `Todo` rows. All four behaviour
criteria pass.

**The regression test discriminates, and the assertion carrying the coverage is not the obvious
one.** Two mutations were run against the shipped predicate. Removing the `sensitive` exclusion
yielded `junior=2` against an asserted 1 — caught. Reverting `servableTodoDepth` to the raw
`assignee ===` filter, the exact LOOP-169 defect, was caught by both the absolute count and the
parity assertion. Under the first mutation all three **parity** assertions still passed: both sides
of a parity check move together when the shared predicate changes, so the absolute `junior=1`
assertion carries that coverage alone. A parity-only rewrite of this suite would be a silent
regression.

**AC5 failed by reading, and it was the criterion the design gate named in advance.** LOOP-169
exists because two computations of "what is servable" drifted; LOOP-251's decisive criterion was
that the predicate end up in exactly one place, verified by reading. `isTodoServableFor` was added
correctly — and the `mine` it was extracted from is still at `servable.ts:57`, with zero call sites.
The same commit left the same residue in the other file: `agentops.ts:225`'s `todoOpen` had three
consumers before `359fc7b` and has none after, while still running a full filter over every open
ticket on each `pm` and `qa` queue call. The pattern in both files is that the new call was
substituted in place and the value it superseded was left declared.

**A comment now carries text copied from an unrelated file.** `servable.ts:68` reads *"is landable
by Step 0.5 even if the flag off (default-off, zero new surface)"*. No flag exists anywhere in that
file; the parenthetical is verbatim boilerplate from `hub/test/agent-api.ts:77/81/84`, and
`git log -S` attributes its arrival to `359fc7b` itself. It replaced the sentence documenting the
LOOP-244 label-fallback rule and left the following line a fragment with no antecedent. In the same
commit `servableSlice`'s seven-line documentation block was deleted with nothing put back, against a
pinned approach that specified no change to that function.

**Four deltas, and every automated gate is blind to all four by construction.** Two dead locals and
two comments pass `tsc`, the suite, the CRAP ratchet and both CI legs. `noUnusedLocals` is evidently
off for this project. LOOP-251 `Canceled`, superseded by LOOP-330 (senior-dev, `Mode: direct-code`)
per §3's junior-to-senior routing on a real criterion miss; the merged behaviour stays on `main` and
the follow-up is a deletion plus two comments.

**The consistency sweep found no third instance.** Every consumer of the shared predicate was
enumerated: `run-agents.ts`'s queue-depth gate and `agentops.ts`'s `opQueue` both import it, and the
only other tier-keyed assignee test in `hub/src/` is `ticketwrite.ts:164`, the Layer-1 sensitive
write gate, which is deliberately broader (it also matches the tier label). The LOOP-144/LOOP-169
single-source program is otherwise complete; what remains of it is the two dead residues above.

**Promoted zero, for the fourth consecutive fire, on the same two-sided cause.** junior is at its cap
(10/10 servable `Todo`) against 67 junior-assigned `Backlog` tickets; senior holds 8/10 with two idle
slots and zero senior-assigned `Backlog` candidates, so §5a permits nothing on either tier. The only
mechanism currently adding to senior's `Todo` is the §3 verify-fail carve-out, which supplied
LOOP-330 this fire. That signal gap is filed as LOOP-329 and is not re-derived here. Grooming ran
instead: LOOP-283 re-confirmed against the running CLI (all six verbs still emit raw stack traces,
`team import` still clean — accurate as filed), LOOP-284 reproduced including its fall-through to an
unrelated machine-global board, and LOOP-325 annotated because its instance count has decayed to zero
while its mechanism is untouched — the shared checkout is quiescent and `doc-land` succeeded
unassisted last fire, which is the property the ticket says cannot be relied upon.

**§9c pass.** Four edges, unchanged: 228←315←238←237←279. Every blocker open, zero auto-unparks due,
no dangling edges. LOOP-279 sits first in senior-dev's pick order, so the chain gating the operator's
stated top priority is at the front of the queue it depends on.

**§20 R2 pass 38.** The forty-third-fire journal moved to
[`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md).

### 2026-08-05 (pm, forty-seventh fire): a follow-up that was destroyed and kept being referenced, and 45 references that resolve to nothing while the integrity surface reports zero

**Nothing to verify, nothing blocked, and two tiers with room for the first time in five fires.**
`origin/main` moved `7323e09` → `4c127b7`, which is this PM's own doc commit and nothing else, so the
product did not move and the lens list was NOT reset — the rotation continued to `strategy-gaps`. The
strategy doc's content hash is `656a42782c8710e1` on both `origin/main` and the working tree, matching
the stored pair exactly: still zero foreign direction edits. Zero `needs-pm`, zero cross-owner bails,
zero `Human-Blocked` at boot.

**Promoted two, after four consecutive zero-promotion fires.** Both tiers had room and a candidate:
senior-dev 6/10 with **LOOP-331** (the `ciFreshness` content-blindness defect senior-dev filed against
itself during its own landing attempt), junior-dev 9/10 with **LOOP-328** (W06's slashless directory
probe, re-confirmed firing this fire before it was promoted). Neither needed a priority change: both
are `Bug`s in tier slices otherwise composed entirely of `Improvement`s, so §5's rank 3.5 already puts
them first — LOOP-331 ahead of four P1 `Improvement`s. Raising a priority that changes no pick order is
churn, and it was not done.

**The `strategy-gaps` lens found the top priority's precondition sitting unowned.** `docs/STRATEGY.md`
names LOOP-239's per-agent cost surface as the binding precondition of the cost-compression program:
*"a figure no shipped surface can reproduce is unfalsifiable."* LOOP-239 is `Canceled`, superseded by
LOOP-292 — and **LOOP-292 did not exist**. Nor did LOOP-291, nor LOOP-233, which `docs/STRATEGY.md`
cites by name and LOOP-228 still points at.

The defect was still live and was re-measured on today's tree rather than inherited:

```
$ dev-loop metrics --flow
cost: $1744.1987  (450 of 746 fires priced)     <- 450 is costMetered, mislabelled "priced"
cost-per-fire: $4.5540/priced fire              <- divides by costPriced = 383
```

$1744.1987 ÷ 450 = **$3.8760** against a printed **$4.5540** — 14.9 % apart, two adjacent lines of one
command. `--cost --by agent` never divides at all and offers the inflated count as the divisor:
senior-dev reads $7.76 against a true $9.96 (−22.1 %), the fleet $3.88 against $4.55. The doc's
baseline is $4.79/fire and nothing from the compression program has landed, so an acceptance verdict
computed off that screen would have reported a **19 % cut that did not happen** — the same
unfalsifiable-table failure this program already paid for once, arriving by the same route. Re-filed as
**LOOP-332** (senior, `Mode: direct-code`, the §3 route-up LOOP-239's own closing comment recorded),
and wired to **LOOP-315** as a real second blocker edge so the acceptance ticket cannot unpark on
LOOP-238 alone while its instrument is missing.

**The first explanation was wrong, and the correction is on the ticket.** LOOP-292's absence from
`restore-candidate.db` was read as proof it had never been created. That artifact is a *partial*
`.recover` reconstruction — 282 of 301 cascaded tickets — so absence from it proves nothing.
`INCIDENT.md` in the same directory states the fact plainly: **19 ticket ids did not survive**, and
LOOP-291, 292 and 233 are all named. LOOP-292 existed, was filed on 08-03 as the §3 follow-up, and was
destroyed on 08-04. `orphaned-comments.json` holds 79 recovered comments belonging to 15 of the 19 —
the content survives even where the tickets do not.

**Nothing reads the only trace those tickets left.** `dependency-graph` reports `allDangling: []` while
**45 dangling `relatedTo` references** exist board-wide, because its integrity check covers `Blocked-by:`
edges only; `relatedTo` and `duplicateOf` are validated at no point by anything. Eight of the 19
destroyed ids are still referenced by non-terminal tickets — LOOP-1, 3, 42, 69, 76, 233, 291, 292 —
and LOOP-298 spends a paragraph reasoning about its relationship to LOOP-292, a dependency that had not
existed for a day when it was written. Detection filed as **LOOP-333** (junior); the question of which
destroyed tickets to reconstruct is not PM's to decide and is parked as **LOOP-334**, `Human-Blocked`,
with the inventory and a recommendation.

**§9c pass: five edges now, zero auto-unparks due.** LOOP-228 ← LOOP-315 ← {LOOP-238, **LOOP-332**},
LOOP-238 ← LOOP-237 ← LOOP-279; every blocker open, zero dangling blocker edges. **§20 R2 pass 39:**
the forty-fifth-fire journal moved to
[`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md).

**Landing this journal costs something, and the cost is now named.** `origin/main` moved once more
inside this fire — `4c127b7` → `0b301bf`, PR #188 merging **LOOP-279**, the head-blocker of the
top-priority chain, whose re-freshen cap was the exhausted one. That risk retired itself. Three PRs
remain open as this fire closes: #190 (LOOP-254) and #184 (LOOP-293) `CLEAN`, #189 (LOOP-281) still
running checks; #184 is already one behind from the previous fire's doc commit. This commit
false-stales all three on a docs-only delta, costing each a re-freshen. It is landed anyway: §20
requires the record, senior-dev's standing instruction on LOOP-279 covers the docs-only case
explicitly, and LOOP-331 — the root-cause fix — is now first in senior-dev's pick order. Suppressing
the journal to dodge the guard would treat the symptom. LOOP-279's ticket is still `In Progress`, so
the §9c edge gating LOOP-237 does not retire yet: an edge resolves when its ticket closes, not when
its prerequisite lands.

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

- **2026-08-05 (pm, forty-seventh fire) — a close that names a successor is not evidence the successor
  exists; the reference and the filing are two separate writes and only one of them was verified.**
  LOOP-239 was `Canceled` with *"superseded by LOOP-292"*, and `relatedTo` accepted `LOOP-292`
  unvalidated. LOOP-292 was destroyed the next day and never re-filed, so for two days the board
  carried a §3 obligation that resolved to nothing — while `docs/STRATEGY.md` named its content the
  binding precondition of the top priority, and LOOP-298 reasoned in detail about its relationship to
  it. The board-wide count is 45 such references against a `dependency-graph` that reports
  `allDangling: []`, because its integrity check covers `Blocked-by:` edges and no other kind. Where a
  close hands work forward, the hand-off is complete only when the successor id resolves to a ticket —
  verify it in the same fire that writes it.

- **2026-08-05 (pm, forty-seventh fire) — absence from a recovery artifact is not evidence of
  non-existence, and the artifact's own record says which.** LOOP-292's absence from
  `restore-candidate.db` was first read as proof it had never been created, and that reading was
  published on the re-filed ticket before it was checked. `restore-candidate.db` is a partial
  `.recover` reconstruction — 282 of 301 cascaded tickets — so it cannot distinguish "never existed"
  from "not recovered". `INCIDENT.md`, in the same directory, names all 19 unrecovered ids outright.
  A recovery artifact answers what was recovered; only the incident record answers what was lost.

- **2026-08-05 (pm, forty-sixth fire) — an increment whose behaviour is correct can still fail
  review, and the criterion that decides it is the one the design gate named in advance.** LOOP-251
  shipped correct counts: every per-tier number matched `servableSlice` against the live board, and
  its regression test survived two mutations. It was `Canceled` anyway, because the criterion it
  failed was *"the servable-Todo predicate lives in exactly one place — verified by reading, not just
  behavior"*, and that criterion is the whole reason LOOP-169 was filed. Two copies with one dead is
  a weaker end state than two copies both live: no test can ever fail on a divergence between a live
  computation and an unreachable one. The design-gate comment had already written down that this
  criterion, not the counts, would decide the ticket — which is what made the verdict a measurement
  rather than a judgement call at review time. Where a criterion is the point of the ticket, name it
  as such at the gate, before there is an implementation to weigh it against.

- **2026-08-05 (pm, forty-fifth fire) — a deviation from an acceptance criterion is ratified by
  re-checking the criterion's premise, never by weighing the implementer's argument.** LOOP-323 AC6
  ordered the `stale` verdict shipped advisory-only, on one stated premise: that LOOP-277's re-freshen
  remedy was unapplied and parked with the operator. The increment shipped `CI_FRESHNESS_STALE_TRIPS
  = true` with a reasoned case that the premise had lapsed. The argument was plausible and the
  verification did not rest on it — what was checked was the premise itself: LOOP-277 is `Done`, its
  edit is on `origin/main` in `42fdbc6`, and the `stale` bullet is present in
  `skills/dev-agent/SKILL.md` Step 0.5, which is the file the fires actually read. Only then was the
  flip ratified. An AC written against a world-state expires when that state changes, and the
  verifier's job at that point is to re-measure the state rather than to enforce the sentence.

- **2026-08-05 (pm, forty-fifth fire) — a flag's safety can rest on a branch its own acceptance
  criterion never mentions, so the dependency has to be written down where the next person will
  look.** Flipping `stale` to trip `--strict` is safe only because `applyTrip` treats a `ciFreshness`
  trip as comment-only, mutating no state, assignee, or label. Step 0.5 invokes
  `merge-guard --strict --apply`, and 79% of this repo's merges are behind the tip at merge time; had
  `ciFreshness` shared the forge-review routing path, the same one-line flip would have returned most
  landing tickets to `Todo`. AC6 could not have named this coupling because it predates the flip
  question. The verdict comment records it explicitly — anyone who later makes `ciFreshness` mutate
  board state must re-open AC6 — because a dependency that exists only in the verifier's reasoning is
  lost at the end of the fire.

- **2026-08-05 (pm, forty-fifth fire) — a measurement that must be re-derived by hand every fire
  belongs in a ticket, not in carried state.** The senior tier has now been measured three consecutive
  fires at partial depth with zero promotable candidates while the junior tier sits over its cap with
  66. Fires 42 and 43 recorded it in journal prose and carried the number forward in `pm-state.json`;
  each fire re-ran the same manual query to rebuild it. No product surface reports the Backlog side per
  tier, so the operator has never seen the finding at all. It was filed as LOOP-329 this fire. A
  finding that survives only because each fire happens to re-derive it is one interrupted fire from
  disappearing, and carrying it forward a fourth time would have been a decision to keep it invisible.

- **2026-08-05 (pm, forty-fifth fire) — investigating a suspected defect and confirming the code is
  correct is a reportable result, and filing nothing is the correct output.** Three surfaces read as
  defective at first measurement this fire: `metrics` reporting `blockedNow: 0` against four
  `blocked` tickets, the four sequenced tickets forming one four-deep chain with no visible depth, and
  the provider breaker never tripping on 85 rate-limit failures. Each was measured to its definition
  and each was correct — the first by the documented parked/sequenced split, the second because
  LOOP-105's `dependency-graph` already reports transitive fan-out, the third because a five-consecutive
  -identical-failure threshold is aimed at sustained outages rather than intermittent limiting. Zero
  tickets were filed from the three. Recording the checks matters as much as recording findings, so
  that the next fire does not re-open them, and so that a low filing count is legible as coverage
  rather than as a quiet fire.

- **2026-08-04 (pm, forty-third fire) — a test that injects the dependency the delivery path fails to
  supply cannot see that the delivery path is dead.** LOOP-242's `ciFreshness` axis was correct as a
  function and inert as a feature: twelve assertions passed, `tsc` was clean, and the axis skipped on
  every real invocation because the CLI never resolved `mergeChecks` from the repo registry. The
  tests all called `mergeGuard(repo, { …, mergeChecks: MERGE_CHECKS, … })` — supplying, at the seam,
  exactly the input whose absence was the defect. The cost was not hypothetical: the same day, a PR
  merged eleven seconds after both required checks reported `FAILURE`, and the `verdict:"red"` branch
  that would have held it was already written, already tested, and never reached. **Rule: when a
  ticket names a delivery path — "Step 0.5 calls this", "the CLI passes that" — at least one test
  must drive that path end to end, with the injection seam placed OUTSIDE the wiring under test. A
  seam that supplies the wiring is testing the code on the assumption the bug is absent.** The
  companion check is cheap and was decisive here: run the shipped verb once, by hand, against a real
  input, and read the field the feature is supposed to populate.
  (LOOP-242 canceled → LOOP-323; LOOP-149 Amendments 1 and 2 both unimplemented in the same increment.)

- **2026-08-04 (pm, forty-third fire) — when two assertions that must disagree both fail, the third
  one that passed is not evidence.** LOOP-250 shipped a three-arm regression test: Arm A asserts W18
  is silent, Arms B and C assert W18 fires. B and C both failed, which means the mechanism never
  fired in that fixture under any configuration, which means Arm A's negative assertion was satisfied
  by the mechanism being inert rather than by the fix working. A suite whose positive arms are red
  cannot lend credibility to its negative arm — the arms are one instrument, and a negative-space
  assertion is only meaningful once its positive-space sibling has been shown to move. **Rule: read a
  test suite's arms as a set before reading any single verdict. A passing "X does not happen" is
  worth nothing until some sibling arm has demonstrated that X can happen in that same fixture; when
  the positive arms fail, the negative arm's pass is the first thing to distrust, not the one result
  to keep.** The generalisation of the older vacuous-oracle rule: there, the assertion matched the
  wrong code path; here, every assertion matched no code path at all.
  (LOOP-250 canceled → LOOP-324; same fire as the LOOP-299 finding, where a guard's test passed on an
  `[E04]` validation error by matching the word "repo" — two different ways to be green over nothing.)

- **2026-08-04 (pm, forty-second fire) — a hint that names one condition is a ranking, and appending
  a branch to a chain nobody ranked publishes a ranking by accident.** `doctor`'s `NEXT:` line is the
  single directed action in the health report; `nextStep()` picks it by returning the first match of
  a flat if-chain whose order is the first-run setup sequence. Three separate tickets each appended
  one day-2 operational rung to the tail of that chain — LOOP-167 the release hint, LOOP-41 the
  landing-aware NEXT, LOOP-74 → LOOP-207 the decision-first NEXT — and each was verified on a
  workspace whose day-1 rungs were clean, so none of them could observe that an unconditional return
  six rungs above makes all three unreachable. Live instance: one repo-less config stub kept `NEXT`
  on "seed `real-one`" while the same report carried 46 unpublished code commits and the words
  "dev-loop fixes marked Done are not live". **Rule: a surface that must choose ONE item to show is
  making a precedence claim, and the claim belongs in the source as a declared order, not in the
  order the branches happened to be written. When adding a branch to such a surface, state where it
  ranks against every existing branch and test it against the one most likely to mask it — the
  ranking is the feature, and a branch verified only in isolation has not been verified.**
  (LOOP-322, filed; LOOP-202 ranked one rung and is preserved.)

- **2026-08-04 (pm, forty-second fire) — a dedupe note is a prediction about code that has not been
  written, so it expires when the code lands.** LOOP-265's filing argued explicitly that LOOP-31
  "would not fix this", named a reading of LOOP-31 that would propagate the bug into the web UI, and
  asked to be landed first. LOOP-31 then shipped `parkedSplit()`, which satisfies every one of
  LOOP-265's acceptance criteria and is guarded by assertions naming three of its four fixture
  shapes. The prediction was reasonable when written and wrong once the sibling landed broader than
  its own title. **Rule: re-derive a ticket's premise against the merged tree before working it or
  closing it, and treat its dedupe section as dated evidence rather than a standing finding. The
  check that settles it is the shipped acceptance criteria plus the test that guards them — a live
  board reading only counts when the board currently contains the discriminating shape, which here it
  did not.** (LOOP-265 `Canceled` as superseded by LOOP-31.)

- **2026-08-04 (pm, forty-second fire) — a ticket deliberately given no dev tier still needs an
  owner, or its unpark lands in no queue.** LOOP-277 is a §17 proposal the operator applies, so it
  correctly carries no `senior-dev`/`junior-dev` marker; it also carried `assignee: null`, which on
  the `service` backend puts it outside both dev pick-queries and outside PM's own `pm`-owned unblock
  scan. The only thing hiding that was its `blocked` label: §9c strips the label the moment LOOP-278
  closes, and the ticket becomes servable with nobody watching. **Rule: "not for Dev" is a routing
  decision that must name the actor it IS for. When filing or grooming a ticket that intentionally
  omits the dev tier, set the assignee to the owner who can execute its next transition — for a §17
  proposal that is `pm`, because the §9a hand-off to the operator runs through PM. Check this at
  park time, not at unpark time; a park hides the defect for exactly as long as it lasts.**

- **2026-08-04 (pm, forty-second fire) — the senior tier's refill queue is empty, and the cap reading
  hides it.** Todo depth closed at junior-dev 10/10 and senior-dev 9/10, which reads as one tier at
  capacity and one nearly there. The Backlog behind them is 69 tickets: 68 junior-tier and one `pm`
  umbrella, **zero senior-tier**. The junior tier is cap-blocked at promotion nearly every fire, so
  its depth is a queueing artefact; the senior tier has an open slot and no candidate, so its depth
  is the whole supply. §21b forbids re-tiering to balance load and routes on explicit signals only —
  LOOP-322 went junior this fire because a scoped change to one function is junior work — so the
  lever is per-ticket at filing time and nothing in PM's pass can correct the ratio after the fact.
  **Recorded as a standing board fact for the operator rather than a proposed action: the split-dev
  filing rule and the observed supply disagree, and resolving that is a direction call.**

- **2026-08-04 (pm, fortieth fire) — a before/after is a claim about one regime, and a boundary no
  instrument records silently voids it.** Every agent's model changed on 2026-08-03T19:36–19:56Z. The
  measured effect on `$/fire` across that boundary, with zero compression landed, was −22.8 %
  board-wide, −99.9 % on junior-dev, and **+51.7 % on senior-dev** — larger in every direction than
  anything the compression program projects. The design written 19 h later grouped its cost model by
  `(agent, model)` and so saw the column, while its headline table, its target call and both
  children's era definitions treated the metered era as homogeneous. **Rule: before differencing two
  eras, enumerate the configuration facts that changed inside the span — model, effort, coding agent,
  cadence — and require the instrument to refuse a mixed-regime aggregate rather than average it. An
  era boundary the query cannot see produces a wrong number, not a missing feature.**

- **2026-08-04 (pm, fortieth fire) — a design that dedups against an existing ticket must be checked
  against that ticket's acceptance criteria, not its title.** Design §8.4 named LOOP-267 as the
  instrument resolving its one free parameter, the turn count, and filed nothing for it. LOOP-267's
  title is about "the turns half of cacheRead" and its ACs deliver `amplification` — cacheRead
  normalized by the modeled boot corpus — with an explicit AC that its doc comment must state it is
  **not** a turn count. The cited ticket's denominator was the quantity the design was solving for, so
  the dedup left a hole exactly where the program's arithmetic rests. **Rule: when a design or a
  grooming pass declines to file because an existing ticket "already owns this", open that ticket's
  ACs and name the one that delivers the quantity. Citing a source and reading it correctly are
  independent properties, and a dedup is the cheapest place for a gap to become invisible.**

- **2026-08-04 (pm, thirty-ninth fire) — a module that declares its own scope has made a testable claim,
  and the claim is the thing to audit.** `destructive-guard.ts` states that every verb destroying operator
  data calls into it. Auditing the *diff* would have established only that its two call sites are correct,
  which they are. Auditing the *claim* meant enumerating the verbs that destroy operator data and testing
  each for membership — which found `up --bundle --force-reseed` overwriting live config and secrets with
  no gate at all (LOOP-316), on a flag the operator-console SKILL already classified as destructive.
  **Rule: when a change ships a scope statement, the review artifact is the set that statement quantifies
  over, not the lines the change touched. A docstring that says "every X" converts mechanically into an
  enumeration of X plus a membership test, and that test is cheap enough to run every time one appears.**

- **2026-08-04 (pm, thirty-ninth fire) — the instance count of a defect and the defect itself are
  different facts, and only one of them decays.** LOOP-190 was filed as "(2 live instances)". Both have
  since been cleared by hand — one by a past fire's unpark, one by mine — while the code that lets the
  `blocked` label and the `Blocked-by:` edge diverge is untouched. An implementer inspecting the board
  today reproduces nothing, and the cheapest wrong conclusion is the one the ticket's own evidence now
  invites. **Rule: a grooming pass that re-measures a defect's instances must state which of the two facts
  it re-measured. Give the refreshed count, say in the same comment whether the mechanism still exists,
  and supply a synthetic repro — otherwise "no longer reproduces by inspection" reads as "fixed".**

- **2026-08-04 (pm, thirty-fifth fire) — a capability that ships without a cadence and without a
  doctor code is indistinguishable from an absent one at the moment it is needed.** The board was
  destroyed on 2026-08-04 and recovered by hand-running `sqlite3 .recover` over pages that
  happened not to be overwritten yet; 19 tickets and 79 comments were lost permanently. The
  reflex conclusion — "dev-loop has no backup mechanism" — is **false**, and checking it is what
  made the resulting ticket worth filing. `dev-loop bundle export --backup` has shipped for some
  time: live WAL-checkpointed snapshot, age-encrypted, no need to stop the loop
  (`bundle.ts:160`, `:261`). The measured facts are that it had been invoked **zero times** in
  this workspace's entire life (no artifact anywhere under the root), and that `doctor` carries
  **zero** W-codes mentioning backup or snapshot — so `DOCTOR_OK` was a truthful report on a
  workspace with no recoverable copy of 301 tickets. **Rule: for anything whose value is only
  realised on a schedule, "does the verb exist" is the wrong question — ask when it last ran and
  what reports its absence.** Filed as **LOOP-303**, and deliberately *not* as "add a backup
  feature": the ticket's load-bearing AC is the one that blocks the obvious implementation, since
  `bundle export` bundles `secrets.env` and the deploy key (LOOP-210, LOOP-162), so putting that
  artifact on an unattended repeating cadence creates a new secret-at-rest surface. **A recurring
  invocation of a safe one-shot verb is not automatically safe; re-audit the payload against the
  new frequency.**

- **2026-08-04 (pm, thirty-fifth fire) — a defect recorded in a ticket's prose but absent from its
  acceptance criteria will not be built, and the ticket will still close green.** LOOP-302 is a
  careful, operator-authored incident ticket. Its 附带记录 names the observability half of the
  incident exactly right — the daemon kept serving the deleted board for ~2h while `doctor`
  printed `DOCTOR_OK`, and it says outright that the observability gap and the transaction gap are
  two faces of one accident. **None of its five ACs mention it.** An implementer who satisfies
  every AC ships isolation, transaction and reseed handling, closes the ticket, and leaves the
  condition that made the deletion invisible for two hours fully intact — the completeness-of-
  acceptance failure LOOP-198 already describes, arriving here through sympathetic prose rather
  than through omission. **Rule: when reading a ticket authored by someone else, diff the prose
  against the AC list; a finding that appears only in the prose needs its own ticket, and the fix
  is a new ticket rather than an edit to theirs** — silently re-specing another author's ticket is
  how a review turns into a re-spec (the failure mode already recorded for Codex threads). Filed
  as **LOOP-304**, code-verified first: `daemon.ts:56` resolves `projectId` once at boot and every
  read keys off that cached value, so the row can vanish underneath it with no re-check.

- **2026-08-04 (pm, thirty-fifth fire) — a restore is verified by which edges still resolve, not
  by how many rows came back.** 283 of 301 tickets returned, which is the number that gets
  reported and the number that means least. The loop's parked work hangs off `Blocked-by:` edges
  encoded as **comment text** rather than as foreign keys, so a cascade delete cannot break them
  loudly: an edge naming a lost id simply never resolves, §9c never unparks that ticket, and no
  surface reports the ticket as anything but normally parked. That is the failure a restore can
  silently introduce, and it is invisible to any count-based check. Audited: **zero live blocking
  edges dangle** — all five parked tickets resolve to live, legitimately-open blockers — while
  **42 tickets (14 open) carry a `relatedTo` pointing at a deleted id**. The two classes deserve
  different responses, and conflating them is the error to avoid: the blocking edge is
  load-bearing for scheduling, `relatedTo` is context. **Rule: after any bulk board mutation,
  re-resolve the edge set before trusting the row count** — and note the corollary about where
  the risk lives: an edge that is text in a comment survives exactly as well as the comment does,
  which is why `LOOP-43 → LOOP-99999` has sat unnoticed since long before this incident.

- **2026-08-04 (pm, thirty-fourth fire) — a new precondition on a shared sink inherits every
  caller's commit ordering; before charging it with the bad end state, check whether a sibling
  precondition already produced that state.** LOOP-264 added `isCanonicalTicketPrefix` at
  `ensureProject`, the single INSERT that creates a project — the right sink, and AC3 explicitly
  authorised it. The consequence one caller up: `team add-project <key> --prefix loop` writes
  `dev-loop.json`, then fails at the sink, leaving a config-only project that the same command
  refuses to complete (`already exists`) and whose missing field is writable by **no** mutator
  (`projects.<key>.prefix` is not an operator-settable path, and `addProject` never puts a prefix in
  the config at all). The working recovery, `dev-loop seed`, is printed only by the command that
  failed. That is a real defect and it is filed (**LOOP-301**) — but it is *not* this commit's
  regression: `ensureProject`'s prefix-**clash** throw produces the identical half-created state and
  predates the work at `596f6dc:seed.ts:80`. **Rule:** a guard added at a shared sink is charged
  only with what its *own* predicate newly rejects; if a sibling precondition at the same sink
  already stranded the caller, the ordering defect belongs to the caller and is a separate ticket,
  not a verify-fail. **Companion rule, from the same verify:** when an AC names a sample to re-run
  ("the 10 parked tickets"), run the predicate over the *population* — the sample was chosen before
  the change, so it cannot testify about it. Here that meant both parsers over all 25 rows carrying
  an edge set, not the 10 the ticket listed.

- **2026-08-04 (pm, thirty-third fire) — a quantity stated in one unit and enforced in another has
  two headrooms, and the surface prints the one that does not bind.** Two instances landed on this
  board within a day of each other, both on cost governance, both correct in code. **LOOP-230**'s
  `perFireUsd` ships ON at `$12.00` and documents its headroom in dollars — 1.61× the `$7.46`
  priciest normal fire, "+61 %, a normal fire is never clipped". The watchdog does not compare
  dollars; it arms a timer at `perFireUsd / ratePerMs`. In the time domain that actually governs,
  measured against this workspace's own ledger: `claude/opus` arms at **27.8 min** against a p95 of
  **26.7 min** (**4 %**, not 61 %), and senior-dev's **40.7 min** is *inside* its 60-min wall, so
  the ceiling — not `fireTimeout` — now bounds senior-dev's long tail. **LOOP-298** is the same
  shape one line lower on the same screen: `metrics --cost` prints `overall` (priced rows only,
  ⇒ $205/day) directly above `budget: rolling 24h … / dailyUsd $500` (`rollingSpendUsd`, which
  *estimates* unpriced fires ⇒ **$389/day**). The enforcement basis is **1.90×** the reported one,
  and today's `$330` reads as a spike against the printed baseline when it is a below-average day
  against the enforced one. **Rule:** when a guard's threshold and its trigger are in different
  units or on different denominators, the derivation comment and the operator surface must state
  the *trigger's* quantity. Verifying that a threshold is well-chosen is a separate question from
  verifying it is legible, and the second one is the one that gets skipped — I passed both tickets'
  ACs before noticing either gap. Neither is a verify-fail; both are filed (LOOP-297, LOOP-298).

- **2026-08-04 (pm, thirty-third fire) — a ticket's tier follows the failure mode of its own
  acceptance criteria, not the surface the ticket describes.** **LOOP-281** reads as safe work: it
  only *pins* `removeProject`'s nine-table cascade with assertions, changes no deletion code, and a
  wrong assertion destroys nothing. It sat `junior-dev`, unlabelled, while **LOOP-290** — which
  edits the guard on the same cascade — is `sensitive` + senior. Reading AC1 settles it: the
  builder is instructed to run `team remove-project <key> --force` **against a healthy `hub.db`**.
  On this board, suites picking up the live workspace instead of their fixture is a recurring,
  documented failure; here that mistake does not produce a red test, it deletes the board across
  nine tables. **The destructive risk was in what the test *runs*, not in what it *asserts*** — and
  that is invisible from the title, the type, and the surface being described. This is the
  companion to the thirty-second fire's ruling: that one said do not reason a `sensitive` label
  *off* when three enforcement layers share it; this one says read the ACs for the label you should
  have reasoned *on*. Both were fixed the same way — write the label, let `applySensitiveRetier`
  do the routing, and take the `issue.retier` event as the audit record instead of a hand-set tier.
  Corollary worth its own line: **senior's queue is fed only by `sensitive` labels, design parents
  and escalations — never by the ordinary Backlog**, which is 64 of 65 rows junior-tier by §21b's
  "when borderline, junior" default. Three fires running, senior has had idle slots against a
  60-row backlog. That is a capacity-allocation property of the tier-routing rule, not a grooming
  miss, and the only legitimate lever on it is finding rows whose ACs carry a senior-tier failure
  mode — as this one did.
- **2026-08-04 (pm, thirty-second fire) — defense-in-depth counted in layers is one layer when the
  layers share a predicate, and the predicate is written by a judgement call.** `sensitive` routing on
  this board is enforced three separate times: a write gate that auto-re-tiers junior→senior
  (LOOP-79), a queue filter that never serves a sensitive row to junior (LOOP-80), and a doctor W21 +
  Sweep backstop (LOOP-81) — deliberately built as three independent children of LOOP-34. Every one of
  them keys on `labels.includes("sensitive")`. On **LOOP-290**, the one live ticket that restructures
  the refusal path ahead of a ten-statement cascade delete, the label was never written: the design
  gate reasoned it off as *"sensitive-adjacent but not itself `sensitive`-labeled since the guard bar
  is inherited from the parent, not new surface"* — one defensible sentence that silently disarmed all
  three layers at once. No layer malfunctioned. They were never reached. **Rule: when you add the Nth
  enforcement layer, ask what all N read; if they share an input that a filer must remember to write,
  you have built one layer with N implementations, and the honest hardening is to make that input
  derive from something structural rather than from anyone's judgement.** Here the structure was
  already present and unused — the parent→child design link — so LOOP-296 specs inheritance along it:
  parent `sensitive` ⇒ child `sensitive`, additive only, never inferred from AC prose. Note the
  measurement that makes this safe to generalize: a board-wide sweep found LOOP-290 was the *only*
  such child, so this is a first occurrence and a forward-looking fix, not a backlog of mis-routed
  rows. Same family as the previous fire's LOOP-59 finding, one level up: that one was a routing
  marker nobody wrote, this one is a safety predicate nobody wrote.

- **2026-08-04 (pm, thirty-second fire) — when a guard refuses your write, the correct first move is
  to look for the board's precedent, not to acquire the authority the guard is asking for.** The
  verify gate blocked `In Review → Done` on LOOP-286 with *"'pm' is not the qa verifier-owner of this
  ticket"*. The mechanically easy response — flip the owner label to `pm` and close — is
  indistinguishable, in the diff, from defeating the guard by relabelling; it is exactly the move a
  guard like this exists to stop. What made it legitimate was evidence external to my own reasoning:
  **7 of 7** design parents on this board carry `pm`, including **LOOP-209**, a `Bug` converted to
  design-and-delegate and closed `Done` as `dev-loop, Bug, pm, senior-dev`. LOOP-286's `qa` was a
  leftover recording who verifies a *fix*, on a ticket whose deliverable had stopped being a fix — so
  correcting it made the gate's own premise ("the owner verifies") **true** rather than bypassing it.
  **Rule: a guard that blocks you is reporting a divergence between the record and reality; establish
  which of the two is wrong from evidence you did not author, and if it is the record, fix the record
  in a separate, visible write that says why.** The tell for the illegitimate version is that the
  label change rides *inside* the state transition and appears nowhere in the trail. This also
  reverses my own previous-fire call to hold the parent `In Review` on the grounds that a `Bug`'s ACs
  describe runtime behaviour: §21a is explicit that a design parent's verified increment **is the
  design**, the six ACs live on the promoted child with `qa` intact, and holding it further was the
  deadlock (QA had already declined twice, correctly) rather than the safety.

- **2026-08-03 (pm, twenty-sixth → thirty-first fires) — [ARCHIVED] 10 method rulings** — full text in [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) under `# Rolled 2026-08-04 (§20 R2 pass 28)`.

- **2026-08-03 (pm, twenty-seventh fire) — [ARCHIVED] 2 rulings** (a ticket's premises decay and a ruling that lives only in a comment is not a spec — re-derive a ticket's claims against the product at promotion, and fold any surviving ruling into the BODY, because the implementer builds the body; two reads of a live board minutes apart are not a contradiction but a claim about different instants — re-derive any cap or depth decision at the moment of the write, never from the boot number) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 29.

- **2026-08-03 (pm, twenty-fifth fire) — [ARCHIVED] 3 rulings** (audit a guard list against what each artifact HOLDS, not against how alarming its name sounds — doctor hard-fails on a credential-free `hub.db` while plaintext `secrets.env`, the file it resolves live keys FROM, is named nowhere in the commit guard (**LOOP-285**); retire a satisfied dependency edge when you OBSERVE it, not when the unpark sweep next runs — and re-derive edges with the real parser every fire rather than trusting your own prior report; a queue that cannot drain is not therefore stale — grooming may cancel only on an observed premise failure, never on age or queue pressure, since cancelling live work to make a depth number look healthy destroys the record and leaves throughput unmeasured) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 27.

- **2026-08-03 (pm, twenty-fourth fire) — [ARCHIVED] 3 rulings** (a cleanup procedure's RESIDUE can be its OUTPUT rather than its waste — establish which before stripping it, because load-bearing residue is a missing section in the procedure, not a discipline failure, and this is why every R2 pass must leave a `STANDING RULES IN FORCE` distillation; a pre-flight that never asserts its own SUBJECT can only ever be a green light — a verdict meaning "safe to proceed" must state what it examined, `dev-loop doctor` exiting `DOCTOR_OK` outside any workspace being the case (**LOOP-284**); a `try` cannot catch what it does not `await`, so an intent written as a comment is not an implemented intent — verify a stated intent by exercising the surface, not by reading the handler (**LOOP-283**)) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 27.

- **2026-08-03 (pm, twenty-third fire) — [ARCHIVED] 3 rulings** (a bounding procedure whose RESIDUE is monotone sets a slope, not a ceiling — compute what a cleanup leaves behind per invocation against what arrives per invocation, and run the procedure against its own residue; a threshold no surface computes is a suggestion — ask which surface computes a document's stated numeric limit, because an unread limit and no limit produce the same artifact (**LOOP-282**); when a corpus has an enforced home and an unenforced one, content migrates to the unenforced one and the migration looks like diligence — look for a WRITE PERMISSION asymmetry before concluding either corpus is mis-sized) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 26.

- **2026-08-03 (pm, twenty-second fire) — [ARCHIVED] 4 rulings** (a metric that is a SHARE cannot falsify a claim about a LEVEL — compute what the ratio would read under the hypothesis you mean to reject, and if the predictions are closer than the noise, pick a level not a share; when a fix ADDS a parallel field instead of repairing the original, review the OLD field's readers, not the new field's callers; a ticket's premise decays — grooming re-checks the premise against the product, the cheap version being to run the one command the ticket claims does not exist; an idle senior queue is a fact about the board, not a routing bug — the tier is fed by escalations and other agents' `sensitive` findings, never by manufactured work) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 25.

- **2026-08-03 (pm, twenty-first fire) — [ARCHIVED] 4 rulings** (a fixture that hand-supplies an argument the production caller never passes can only test the callee, never catch the caller bug; verify a config-driven predicate against the PROJECTION every runtime consumer reads, not the file on disk; adding a field to a type is not populating it, and a cast between two config views suppresses the error that would have caught it; the AC a handoff does NOT claim is the one to check first) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 24.
- **2026-08-03 (pm, twentieth fire) — [ARCHIVED] 3 rulings** (a prose warning naming both a failure and its mechanism is an acceptance criterion, and a test can pin the very trap it was written to avoid — argv-validating doubles do not help when the oracle is wrong; a design gate AMENDS spec-edge omissions and BOUNCES only incoherent design, and `references/config-schema.md` is NOT a §17 governing file; a program umbrella is not a Backlog row, and §9a's close-the-parent does not apply when the parent carries the baseline its children are measured against) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 24.
- **2026-08-03 (pm, nineteenth fire) — [ARCHIVED] 2 rulings** (a cancelled CI run on a superseded SHA is not a red gate — read the conclusion of the tree that CONTAINS the change, not of the commit that introduced it; an exclusion applied at the call site is a convention, only one applied at the seam is a contract) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 23.
- **2026-08-03 (pm, eighteenth fire) — [ARCHIVED] 3 rulings** (a tracker whose remaining acceptance can only be satisfied by the thing it blocks can never close; a verification step that only proves its worth when it fires still earns its cost; I had been rolling up the second-largest section for fifteen passes) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 23.
- **2026-08-03 (pm, seventeenth fire) — [ARCHIVED] 3 rulings** (a review thread is closed by an assertion and nothing compares the assertion to the tree; hardening the CONSUMER of a two-ended mechanism without the producer converts a soft failure into a trap; "fail-closed" and "refuses legibly" are independent properties) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 23.

- **2026-08-03 (pm, sixteenth fire) — [ARCHIVED] 4 rulings** (one predicate failing in two opposite directions; a reverted prerequisite; find the CALLER first; diagnosability is part of the fix) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 16.

- **2026-08-01 (pm, fifteenth fire) — [ARCHIVED] 4 rulings** (correlation as the cheapest aim test; an AC pinning a live measurement expires; a landing order in prose is not one; an authorization covers the edit it named) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 15.

- **2026-08-01 (pm, fourteenth fire) — [ARCHIVED] 3 rulings** (test a procedural mechanism before it shapes behaviour; a measurement that kills your hypothesis is a result, not a ticket; sequence on data dependencies) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 14.

- **2026-08-01 (pm, twelfth fire) — [ARCHIVED] 3 rulings** (the age-distribution test for a starving backlog; enumerate what a metric omits before optimising it; name the mechanism and date when betting on an unlanded one) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 13.

- **2026-08-01 (pm, eleventh fire) — [ARCHIVED] 4 rulings** (while the hub daemon is version-skewed senior filings are direct-code shaped only, and a tier holding open cap slots is not starvation — check whether its queue is *completable*; a doc that misdescribes config is the same defect class as code that drops it and earns the same verify-fail; a blocker edge must point at the ticket that RESOLVES the block, and a correction ADDS the true blocker rather than swapping it out; verify a handoff's claim about a shared surface before repeating it, including a negative one) → [`2026-08.md`](strategy-archive/2026-08.md), R2 pass 24.
- **2026-06-14 → 06-27 — [ARCHIVED] the 2026-06 milestone arc** (daemon foundation DL-1..DL-5; standalone-daemon + multi-CLI repositioning P1..P5; hub buildout; the two-tier Dev split) — all Done, superseded by **Current state** → [`2026-06.md`](strategy-archive/2026-06.md).
- **2026-07-30 — [ARCHIVED] the 2026-07-30 pm fire arc** (lens rotation `strategy-gaps`→`trust-safety`; the metering/landing/observability chains; that day's design-gate + §9c rulings) — superseded by **Current state** → [`2026-07.md`](strategy-archive/2026-07.md).

- **2026-07-31 (early arc) — [ARCHIVED] ~30 rulings and method notes** (board search / acceptance-rate / ownership contracts; send-back-vs-verify-fail and the third verify outcome; §9c's `Canceled`-is-not-satisfied asymmetry; §21a-gate-outranks-§5a-cap; the validate-then-drop family; the first R2 rollup) — doctrine in the STANDING RULES block below → [`2026-07.md`](strategy-archive/2026-07.md), R2 pass 2.
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

- **2026-07-31 (late arc) — [ARCHIVED] 16 method rulings** (design-gate fail vs under-specification; the two halves of a §9c edge; a fix finished only when every branch agrees; retiring a defect FAMILY; §21a promotion unconditional on a pass; the pass-3 keep/roll criterion; STANDING RULE 12 refined) — distilled into the STANDING RULES block → [`2026-07.md`](strategy-archive/2026-07.md), R2 pass 4.
- **2026-08-01 (mid arc) — [ARCHIVED] 14 fire-journal rulings** (merge-objection; machine-demotion-is-not-a-verdict; §5 rank-1; the §17-caution proposal; merge-guard's actor; the boot-corpus A/B cost axis; the discard-cost fix; "has the product moved" asked of `origin`; rollup pass 5; promotion-count-0 with an idle lane) → [`2026-08.md`](strategy-archive/2026-08.md).
- **2026-07-31 (fix-arc) — [ARCHIVED] 6 fire-journal rulings** (LOOP-208's ownership-vs-builder verify gate; LOOP-210's unprotected `bundle export`; LOOP-211 on the operator's ruling; the push path going live mid-fire; the throughput claim corrected in-fire; the R2 pass-4 parking lot) — doctrine in the STANDING RULES block → [`2026-07.md`](strategy-archive/2026-07.md), R2 pass 8.
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


- **2026-08-04 (pm, thirty-sixth fire) — a commit is a local fact and a PR is a forge fact, so the
  ship step can be gated without a network.** Two tickets reached `In Review` in one fire with no
  commit anywhere, under a repo configured `landing: "pr"`. The obvious gate — refuse a handoff
  with no PR — is unsafe, because LOOP-274 already documents `annotateTicketLanding` reporting a
  forge outage as `no-pr`; that gate would block every handoff whenever `gh` is unreachable. The
  usable predicate is the local one: `git log --all --grep=<ticket-id>` is deterministic, offline,
  and cannot be wrong about whether work was committed. **STANDING: when a check has both a local
  and a remote formulation, gate on the local one and annotate the remote one.** LOOP-309 is
  written to that split, and carries an explicit AC that a handoff with a real commit still
  succeeds with `gh` off `PATH`.

- **2026-08-04 (pm, thirty-sixth fire) — a verified diff and a delivered increment are measured on
  different axes, and passing one says nothing about the other.** LOOP-31's code passed every
  check it claimed and introduced no regression; it was still a verify-fail, because no acceptance
  criterion is observable on a product that never received the change. The correct sequence is to
  establish the delivery fact first — branch, commit, PR, and what the running env actually serves
  — and only then spend a fire on the code. Doing it in that order this fire produced a verify-fail
  comment that explicitly certifies the diff as good, so the escalation (LOOP-308) starts from the
  salvaged patch rather than re-deriving it. **STANDING: verify delivery before correctness; a
  handoff note locates the change and never evidences it.**

- **2026-08-04 (pm, thirty-sixth fire) — a workflow step addressed to one actor must be executable
  by that actor.** §21a tells the design-gate verifier to promote the staged children and then
  close the parent. On a `Bug`-typed parent, §5a reserves the promotion to PM and the verify gate
  reserves the close to the `qa` owner, so the instruction is not executable as written by either
  of them, and each ordering has a distinct failure: PM-first leaves the parent `In Review` after
  the children are released, QA-first strands the children in `Backlog` with no gate left to fire
  on them. It held this time only because senior-dev wrote a routing comment by hand.
  **STANDING: when a documented action crosses an authority boundary, name both actors and the
  ordering in the spec, rather than relying on the filer to notice.**

- **2026-08-04 (pm, thirty-seventh fire) — a blocking edge written against a ticket resolves when
  that ticket closes, which is not the condition the edge was protecting.** LOOP-296 was parked
  behind LOOP-294 so it would consume LOOP-294's design-parent predicate instead of authoring a
  second one. LOOP-294 went `Done` with the predicate uncommitted, so the edge went terminal while
  the hazard stayed exactly as it was: `origin/main` still carries the body-prefix check the edge
  existed to supersede. §9c's auto-unpark rule is deliberately mechanical — at least one blocker,
  all blockers terminal — and a mechanical rule reads the state field, not the artifact. The board
  was simply the only handle available when the edge was written; its referent was always the
  landed code. **STANDING: when a prerequisite is a landed artifact, name that artifact in the
  marker comment and re-check the artifact itself before unparking — a terminal blocker is
  evidence that someone closed a ticket, and closing is a board event.**

- **2026-08-04 (pm, thirty-seventh fire) — a procedure that bounds something accumulates its own
  residue, and nothing was measuring it.** §20 R2 bounds this doc by moving settled decision detail
  into a dated archive and leaving "a one-line index entry per archived period". After 28 passes
  the live log holds 26 such entries totalling 17,488 bytes — 673 bytes each, because each carries
  a parenthetical recap of what it archived — against 30,246 bytes of live rulings. The index is
  37% of the Decisions section. Pass 28 removed 11,966 bytes and added 216, and the arithmetic
  repeats: every pass removes a variable amount and adds one permanent entry, so the section's
  floor rises monotonically while its ceiling falls. Measured on this doc, not projected.
  **STANDING: when a procedure exists to bound a resource, hold its residue to the same budget as
  the thing it bounds, and measure both in the same pass.**


- **2026-08-04 (pm, forty-first fire) — a commit is not verified to be one increment, and every gate
  is blind to it.** `f1a6b70` shipped LOOP-105's dependency-graph surface plus the complete patches
  of LOOP-294 and LOOP-31 — five of sixteen files, proven by a clean `git apply --reverse --check`
  of both salvage patches against `origin/main`. CI on both matrix nodes, `main`'s own run,
  merge-guard, the implementer's self-review and a PM verify all passed, because each gate asks a
  different question than "is this commit one increment". The cost was already banked before it was
  found: a senior `Todo` for an already-landed patch, an implementer cancelling a `qa`-owned ticket,
  and one increment on `main` verified by nobody. **STANDING: verify that a commit's file set belongs
  to its ticket before verifying the code — the check is `git apply --reverse --check` against any
  known sibling diff, and it is decisive without reading either patch.**

- **2026-08-04 (pm, forty-first fire) — a verdict that makes the board less true is the wrong
  verdict.** §3 requires a verify-fail on any EXTRA "even when the code is clean". Applied literally
  to LOOP-105 it would have marked a complete, green, live-exercised increment `Canceled` as
  review-failed and opened a follow-up with nothing to build, because the EXTRA was a foreign fire's
  artifact rather than the scope creep the rule is written against. The contamination was routed to
  the tickets it affected and filed as its own defect instead. **STANDING: when a rule's remedy would
  record something false, apply the remedy the rule is protecting and write the departure into the
  ticket — an unexplained exception and a silent one cost the same next fire.**

## Candidate ideas

_(The overflow parking lot: strong ideas not yet filed. **Rolled 2026-07-30** — ten completed /
filed / shipped / retired DL-era entries (16 KB) moved to
[`docs/strategy-archive/2026-07.md`](strategy-archive/2026-07.md); this list now holds only
candidates with an unfiled action. Earlier DL-1…DL-5 daemon/web-UI/roadmap-bridge ideas were filed
2026-06-23.)_

- **W19 states an unpushed-commit count from an unrefreshed tracking ref — banked 2026-08-04, not
  filed (throughput, not severity).** Ran as the consistency lens off `38953d0`, which taught W18 to
  qualify its no-skew green with the sha + relative age of `origin/<branch>` and the words *"as of
  last fetch"*. The direct sibling analogue came back **clean**: W19's in-sync case (`ahead === 0`)
  prints **nothing** at all (`doctor.ts` — `// ahead === 0: in sync, silent`), so it makes no false
  green and is not the LOOP-203 shape. Recording that as a dead hypothesis. What remains is milder
  and one step over: W19's *warning* branch reads the same cached `origin/<defaultBranch>` and then
  states a flat count — `local main is N commit(s) ahead of origin/main` — so on a stale ref it can
  name already-pushed doc commits as unpushed and send the operator to `doc-land` work that is
  already landed. That is the LOOP-247 shape (a surface naming an action the operator does not need)
  on a warn-only path that never flips `DOCTOR_OK`, and `doc-land` is itself idempotent
  (fetch → rebase → ff-only), so the blast radius is a wasted look. Deliberately **not** filed:
  junior sits **12/10** over the depth cap against a **66**-row Backlog, so the constraint is
  throughput and a P3 message-accuracy row would be padding. Fix when the queue drains: adopt W18's
  own remedy — append the sha + age and "as of last fetch" to the W19 warning text.

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
- **[ARCHIVED] Six DL-era candidates** (inter-agent discussion daemon; hub/`service` hardening pass;
  multi-stakeholder roadmap auth; 点评-from-the-web-UI write path; board summary band; header-nav
  active-surface highlight). Rolled whole to
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 18) — each was either
  filed/landed on the retired **DL-prefix** board or is a vague future-persona note, and this section
  holds only candidates with an **unfiled, actionable** next step. One clause survives because it is a
  live firewall constraint: **a 点评 write path from the web UI needs a conventions §22 carve-out**
  (§22 says agents never write `*.review.md` — that is what makes an on-disk review
  operator-authored-by-construction), so it is a §17-gated proposal, never a naive Dev ticket.

- **Loop-cost-governance — Phase 2: PRECONDITION CLEARED 2026-07-31, and the bank entry is now a
  split verdict (rewritten 2026-07-31, was a 3.8 KB plan).** The blocking premise — *"not buildable
  until the hub has a per-fire cost signal"* — died when metering went live **2026-07-31T14:04Z**.
  **(a) Budget ceiling — FILED as `LOOP-197`** (`Feature`, `sensitive`, senior, `Todo`); the plan's
  own instruction *"a separate ticket built ON this signal once LOOP-2 lands"* is discharged.
  **(b) Cost-per-accepted-change — SHIPPED 2026-08-03 by another chain, and this entry named the
  WRONG blocker.** It was banked as "not filed until `LOOP-98` (`acceptRate` wrong in both
  implementations) reaches `Done`". LOOP-127 (LOOP-4 surface 3, `usage-surfaces` design) shipped it
  anyway and PM verified it live: `cost: $1162.7887 over 270 of 562 metered fires
  ($7.3594/accepted change)`. **`LOOP-98` was never its divisor** — the metric divides by
  `teamRollup.throughput` ("transitions → Done in the window", a plain count), not by `acceptRate`
  (`Done ÷ (Done + verifyFails)`). Two different quantities; this entry conflated them and deferred
  a metric on a blocker that did not apply. **The real caveat is the NUMERATOR, and it is already
  ticketed: `LOOP-219`** — window spend includes the ~7.9% burned by fires killed mid-flight, which
  produced no changes, so $7.36 is an over-estimate of the price of a change and a floor on waste.
  Nothing to file for (b). **(c) Accept-rate in the Reflect daily digest** — still not filed, and its
  blocker IS real: it surfaces `acceptRate` itself. **REVERSAL CONDITION for (c) only: `LOOP-98`
  reaches `Done`.** Lesson kept: check which quantity a surface actually divides by before banking
  it behind another ticket.
- **Daemon serves stale VIEW code until restarted — observe-surface lag after a Dev ship (ux-flows/ops lens, PM 2026-06-27 — banked).** The long-lived daemon (DL-41) loads `daemonviews.ts` + routes at boot, and `daemon ensure` is idempotent (never restarts a live process), so after a Dev commit that changes the web-UI rendering (e.g. DL-84's new `/activity` section, or DL-83's banner) the running daemon keeps serving the OLD view code until manually `down`+`up`'d — the operator sees fresh DATA (read per-request from the SoR) with **stale RENDERING**. Standard server behavior, but a real papercut for THIS dogfooding loop where Dev ships ~every 20min and the daemon IS the operator's observe surface (a new feature looks un-shipped until restart). **Options when filed:** a `dev-loop daemon restart` subcommand + a post-ship hint; OR a lightweight **served-commit-vs-HEAD banner** on the web UI so staleness is *visible* (the DL-83 surface-don't-prevent pattern); OR file-watch auto-reload (heavier — touches the lifecycle + the stateless contract). **Banked, not filed** — expected daemon behavior, low-severity (data is correct, only new view code lags); file if the operator finds the lag misleading or asks. **Re-tested 2026-07-31 (late): still banked, and the reversal condition is now NAMED rather than left to taste — the DETECTION half is already ticketed as LOOP-195 (doctor is blind to a daemon running pre-upgrade code), so file the REMEDIATION half (`daemon restart` verb / served-commit banner) only if LOOP-195 ships and the operator still has to be told by hand. Until then a second ticket would duplicate LOOP-195's surface.**
- **A verify-fail should be reachable from a green suite — the "which case does the fixture dodge?"
  check, banked 2026-07-31.** LOOP-57 shipped 22/22 green and was still unusable, because its case (c)
  chose a *doc* file for the divergence it was testing and thereby made the only distinction that
  mattered (tree comparison vs commit range) unobservable. The generalizable move that caught it costs
  one question per verify: **name the variable the fixture holds constant, then ask what the product
  does when it varies.** Here: "case (c) diverges origin — with *what kind of file*?" Possible shippable
  form is a §15 convention (a regression case must vary the dimension its assertion depends on) or a
  Reflect lesson; it is a review *method*, not code, so it is banked rather than filed as Dev work.

- **DL-CB1 — `metrics --context` counts only the repo-file form of `strategyDoc`.** LOOP-263 shipped
  `strategyDocRelPath`, which returns `null` for `{hubDoc}` and `{linearDocument}`; the bill then
  reports `absent (hubDoc — readable only in a live session)`. Honest and visible rather than a `0`
  masquerading as a measurement, and inert here (this project's doc is a repo file) — but a hub-doc
  project gets the same understated baseline LOOP-263 was filed to fix, and the stated reason is
  inaccurate: a hub doc lives in `.dev-loop/hub.db` and reads fine from disk without a daemon. File
  when the backlog drains. Second, smaller: `tryResolveStrategyDocStat` returns the FIRST project
  with a `strategyDoc` (`Object.keys` order) and `metrics --context` has no `--project`, so a
  multi-project workspace charges every agent one arbitrary project's doc (see LOOP-275).

- **Compact the `[ARCHIVED]` index to true one-line pointers (§20 R2 residue).** The 26 index
  entries in the Decisions log average 673 bytes because each carries a parenthetical recap of the
  rulings it archived; §20 R2 specifies one line. Collapsing them to
  `<period> → <archive file> § <pass heading>` recovers roughly 13.6 KB — more than pass 28 removed.
  Deliberately not done and not filed this fire: those recaps are currently the only way to locate
  an archived ruling without opening a 253 KB archive, so the saving costs discoverability of ~90
  rulings, and that trade was not measured. The version worth building moves the recaps into a
  table of contents at the head of each archive file, so the live doc keeps a pointer and the index
  stays searchable one file away. Depends on nothing; sized at one focused fire. Related: LOOP-282
  (a budget and a doctor code for this file's total size) and LOOP-228 (per-fire context cost).

