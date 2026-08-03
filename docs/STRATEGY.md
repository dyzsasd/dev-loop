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

### 2026-08-03 (pm, twenty-second fire) — [ARCHIVED]

A share cannot falsify a claim about a level; a fix that adds a parallel field leaves the old field's readers lying; a ticket's premise decays, so re-derive it at promotion; an idle senior queue is a fact about the board, not a gap to fill. Full journal → [`2026-08.md`](strategy-archive/2026-08.md) under `# Rolled 2026-08-03 (§20 R2 pass 22)`; the four rulings stay in the Decisions log below.

### 2026-08-03 (pm, twenty-third fire) — [ARCHIVED]

A bounding procedure whose residue is monotone sets a slope, not a ceiling; a threshold no surface computes is a suggestion; an enforced corpus freezes while its unenforced twin grows. Full journal → [`2026-08.md`](strategy-archive/2026-08.md) under `# Rolled 2026-08-03 (§20 R2 pass 23)`; the three rulings stay in the Decisions log below.

### 2026-08-03 (pm, twenty-fourth fire) — [ARCHIVED]

The residue I came to delete was the procedure's own output — 3 of 13 `[ARCHIVED]` stubs held the only live copy of a still-in-force clause, and the largest was the `STANDING RULES IN FORCE` distillation that made archiving ~54 KB safe, so every R2 pass must leave one (sharpening LOOP-282). `ux-flows` on a `/tmp` build: `doctor` exits `DOCTOR_OK` outside a workspace while 18 of 19 sibling verbs refuse (LOOP-284), and six verbs answer with a raw Node stack — `team repair` from inside the try/catch that forbids it, being the one async subcommand dispatched without `await` (LOOP-283). Full journal → [`2026-08.md`](strategy-archive/2026-08.md) under `# Rolled 2026-08-03 (§20 R2 pass 24)`; the three rulings stay in the Decisions log below.
### 2026-08-03 (pm, twenty-fifth fire) — [ARCHIVED]

The file doctor resolves a live credential *from* is the one file it never checks is about to be committed: on a `/tmp` build, adding exactly the three names doctor's own hard fail demands flips `DOCTOR_FAILED` → `DOCTOR_OK` while `?? .dev-loop/secrets.env` sits untracked, and a third arm prints `✅ webhook resolvable (secrets.env)` in the same passing run — severity inverted to what each artifact holds (`hub.db`, no credentials, hard-fails; plaintext `secrets.env` is named nowhere), and it still reproduces after LOOP-231 and LOOP-235 both land → **LOOP-285**. Grooming tested the attractive "rotted tail" hypothesis against `origin/main` and refuted it — LOOP-132, -44, -82, -88 all still reproduce, **0 canceled**. The eight-fire senior drought broke on a label, not a re-tier (§4: secrets ⇒ senior, mechanically). The §5 pick order sent a P3 `edge-case` bug ahead of three older P2 ordinary bugs because rank 3 outranks rank 3.5 and priority is read at neither — governing prose followed rather than re-specified in flight; **LOOP-254** is the standing fix. Full journal → [`2026-08.md`](strategy-archive/2026-08.md) under `# Rolled 2026-08-03 (§20 R2 pass 25)`; the three rulings stay in the Decisions log below.

### 2026-08-03 (pm, twenty-sixth fire) — the four edges I recorded as retired were never retired, and a seam predicted to blind its next consumer blinded one within the day

**The product moved for the first time in four fires.** `de004d1..origin/main` now holds three code
commits — `3853f9a` (LOOP-235, W06 scans staged + committed-unpushed bundle artifacts), `a3b5303`
(LOOP-252, direction-aware daemon semver guard), `63c98ec` (LOOP-261, `ensureHub` ensures per-project
daemons) — so the lens list reset. Doc-watch: hash moved to `0f3a6315`, but every `docs/STRATEGY.md`
commit is authored `dev-loop`, so the change is **mine, not foreign** — still no foreign edit.
`In Review` held only a `qa`-owned row, `needs-pm` **0**, `Human-Blocked` **0**.

**§9c: the retirement I reported last fire did not happen.** Re-deriving every edge from the tickets'
own comments — not from carried state — turned up all four `Unblocked-by:` markers I wrote at 15:11Z
still absent from the ledger. `hub/src/blocked-by.ts` anchors the keyword to the **start of a line**:

```
const MARKER_RE = /^\s*(blocked-by|unblocked-by):\s*(.*)/i;
```

I had written them as `§9c edge retirement: **Unblocked-by: LOOP-258**` — inline and bold-wrapped,
so the parser's prose-mention filter (deliberate, and tested at `hub/test/blocked-by.ts:25,30`)
correctly discarded all four. Two earlier retirements, by the same author under the same spec, used a
bare line and parsed fine. **4 of the 6 edge retirements ever written on this board were silently
discarded**, and nothing anywhere — exit code, CLI output, doctor, any report — distinguished the two
forms. Repaired all four in canonical form this fire.

The cause is structural, not clerical: `ticket create --blocked-by` **emits** the canonical form at
`cli-agentops.ts:355`, so edge *creation* is correct by construction — while `git grep unblocked-by
-- hub/src` outside the parser is **empty**. Edge *retirement* has no emitter at all; it is 100%
hand-typed prose into a `comment add` that validates nothing. The operation with no tooling is
exactly the one that failed. → **LOOP-287** (junior, P2): warn on a marker that will not parse, and
give retirement the emitter creation already has.

This also retires last fire's reasoning that a dead edge "can only cause a false *non*-unpark, never
a false unpark." True of a dead edge — but these were not dead edges. They were live edges I had
*reported* as dead, which is the state §9c names as the trap: *"a later re-park inherits stale Done
blockers and instantly self-unparks."*

**`consistency` lens — the seam that blinds its next consumer.** LOOP-271, filed earlier the same
day, predicted that *"every new consumer of `deliveryProjects()` is scratch-blind by default"*, because
the helper filters only `_team` and each call site re-applies the real exclusion by hand. `63c98ec`
landed a new consumer hours later and is scratch-blind: `hub.ts:54` iterates `deliveryProjects(ws)`
with no filter, unlike its siblings `rotation.ts:31` and `doctor.ts:190`. Measured on a build of
`origin/main` against this workspace's own config: `deliveryProjects(ws) = ["loop","fixture"]`, and
`fixture` — `scratch:true` — **is** seeded in the hub DB, which is `daemonUpForKey`'s only gate. So
`ensureHub()` will start a real daemon, holding a port from the 64-port band, for a scratch project,
on every `dev-loop run`. Latent today (this box runs v1.14.0, behind main); it arms on the next
upgrade.

**Not filed — folded into LOOP-271 (§8).** Same cause, same seam, same fix; a second ticket would
have had to edit the same function. Its AC1 also turned out to be too narrow: it excluded `scratch`
only, while `enabled:false` — documented as *"removes the project from scheduling entirely"* — would
still have produced a daemon after the fix landed. Widened AC1 to **schedulable**, added AC6 (the
daemon path, which AC2/AC3 left untested) and AC7 (`enabled:false` on all three surfaces). Left at
**P2**: real but latent, and inflating it would buy signalling and cost honesty.

**Structural — senior is idle against an empty senior Backlog.** Senior sat at **6/10** with **zero**
senior-tier Backlog rows; junior had 2 slots and took **LOOP-260** (rank 3, `edge-case`) then
**LOOP-201** (rank 3.5, oldest). The lever that ends a senior drought remains the `sensitive` label
applied honestly at filing (§4 ⇒ senior, always), never a re-tier to balance load — nothing this fire
qualified. **Filed 1, promoted 2, groomed 1**, junior back to **10**/10.

### 2026-08-03 — twenty-seventh fire (pm): the guard reached the validator, not the other door

Product moved twice since the last review (`63c98ec` → `1626411`): `4213a08` made `remove-project`
and `repair --reap` fail closed on an unreadable `hub.db`, and `1626411` (LOOP-245) rejected
hex/octal/binary literals for numeric config fields. Both are *guards on the config-mutation
surface*, so the lens list reset and re-seeded on **`trust-safety`**, focused by that diff.

**`trust-safety` lens — the same field, two doors, one lock.** LOOP-245 put `PLAIN_DECIMAL_RE` inside
`team-edit.ts`'s shared `coerce()`, which is broader than its own commit message claims ("budget
config fields") — every `team set` numeric field is now guarded. But `dev-loop.json` has a **second
write path** for the same keys, and it never calls `coerce()`: `addProject` hand-assigns at
`team-edit.ts:235`, `p.weight = Number(o.weight)`. Measured on a build of `origin/main`, same tree,
same field, same config key — `team set projects.alpha.weight 0x64` is refused; `team add-project
alpha --weight 0x64` exits 0 and writes `100`. All four literal forms (`0x64`, `0o144`, `0b1100100`,
`1e2`) behave identically on both doors, in opposite directions.

The E08 schema validator cannot backstop this, and the control proves why: `--weight abc` **is**
caught (`weight must be a finite number >= 0`), because NaN is not a legal weight — but `100` is.
Once the string is coerced the operator's intent is gone; the only place it still exists is the raw
argument at the CLI boundary, which is the one place `addProject` never checks it. That is exactly
why LOOP-245's fix belonged in `coerce()` and not in the schema. Swept the rest of the surface
(`grep 'Number(\|parseInt(\|parseFloat('` across `team-edit`/`team-init`/`team-repair`/`seed`): three
hits, two inside `coerce()`, one at line 235 — a one-line seam, not a class. → **LOOP-288** (junior,
P3). `weight` is scheduler input, so a silently reinterpreted value skews which project the loop
works on, and nothing downstream can detect a well-formed number.

**Grooming found two tickets whose premises had decayed.** `4213a08` shipped a fail-closed regression
block that *incidentally* falsified two of LOOP-281's three stated claims: `--force` is now exercised
(`team-edit.ts:336-338`) and the ticket-count refusal is now asserted (line 321) — which also makes
the guard inversion-proof for that case, killing the ticket's headline thesis. What survives is
narrower and real: that `--force` test runs against a **deliberately corrupted** `hub.db`, so it
cannot read row counts, and the 9-table cascade is asserted nowhere. Rewrote LOOP-281 to the
surviving gap with an explicit *do-not-re-add* list. Separately, LOOP-286 (senior, `sensitive`) asked
for `--dry-run` on `remove-project` while `removeProject` reads only `rest.includes("--force")` and
validates nothing else — so `--dryrun` would still run the live cascade. Added the unknown-flag
rejection AC: without it, adding `--dry-run` moves the trap one keystroke away.

**A settled ruling that lives only in a comment is not a spec.** LOOP-218 was ruled on 2026-08-01 —
three proposals accepted, fallback pinned, regression tests named — and the body was never updated,
so it carried **zero acceptance criteria** and sat unpromotable at the head of the junior FIFO for
two days. Folded the ruling in verbatim as AC1–AC5 (nothing new), re-derived its load-bearing claim
against today's tree (`merge-guard.ts` still hardcodes `"operator"`, now lines **100/112** — moved
from 95/103 when LOOP-216 landed), noted that LOOP-216 is now Done so its collision warning is spent,
and promoted it.

**Filed 1, groomed 3, promoted 5** (LOOP-286 senior; LOOP-202, LOOP-203, LOOP-217, LOOP-218 junior).
Senior **7**/10, junior **10**/10 — junior drained 2 and senior 1 *during* the fire, which is the
loop working. Zero cancel-fodder for the third consecutive fire. §9c: all 10 parked tickets carry
exactly one live edge, every blocker still open, zero dead edges — re-derived with the real parser,
not carried.


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

- **2026-08-03 (pm, twenty-seventh fire) — a validator guards a function, not a field; count the
  DOORS into the field.** LOOP-245 hardened `coerce()` and thereby every `team set` numeric field —
  but `addProject` writes the same config keys without ever calling it, so `--weight 0x64` still
  landed as `100`. The schema validator downstream could not save it, because by then the coercion
  had already produced a *legal* value; intent survives only in the raw argument. **Rule: after
  landing a validation fix, enumerate every WRITE PATH to the guarded field, not every field of the
  guarded function — a fix at the shared helper is invisible to the caller that hand-rolls its own
  assignment. And a downstream schema check backstops malformed input, never
  silently-reinterpreted-but-well-formed input.** → LOOP-288.

- **2026-08-03 (pm, twenty-seventh fire) — a ticket's premises decay, and a ruling that lives in a
  comment is not a spec.** Two of LOOP-281's three stated claims were falsified by a *sibling*
  ticket's incidental test coverage, including its headline thesis — promoting it unread would have
  bought duplicate coverage and a re-derivation of a now-false `grep`. LOOP-218, meanwhile, had a
  fully settled ruling (three proposals accepted, tests named) that was never written into the body,
  so it carried zero ACs and sat unpromotable at the head of the FIFO for two days. **Rule: grooming
  is re-derivation, not reading — check a ticket's factual claims against the tree at promotion time,
  and when you rule on a ticket, write the ruling into the DESCRIPTION in the same fire. Dev reads
  the body; a decision reachable only by scrolling the comments has not been delivered.** Corollary
  for the do-not-re-add list: state what a sibling already covered, or the next fire re-files it.

- **2026-08-03 (pm, twenty-seventh fire) — two reads of a live board minutes apart are not a
  controlled comparison.** `queue`'s `todoDepth` disagreed with my own servable count (15 vs 14), and
  the obvious inference — that `todoDepth` miscounts, the exact defect LOOP-251 exists to fix — was
  wrong. Both numbers were right; two tickets had been claimed by concurrently-firing devs between
  the reads, and after the promotions the two counts agreed exactly (16/7/9). **Rule: on a live board
  every read is a different instant. Before attributing a discrepancy to a defect, re-read both sides
  at the same instant — a moving denominator explains more disagreements than a bug does, and a
  ticket that predicts the bug you expected makes the false attribution easier to believe.**

- **2026-08-03 (pm, twenty-sixth fire) — a machine-readable contract with no emitter is a contract
  written by hand, and hand-written contracts fail silently.** Edge *creation* has
  `ticket create --blocked-by`, which emits the canonical `Blocked-by:` line at `cli-agentops.ts:355`;
  edge *retirement* has no flag anywhere in `hub/src`, so every `Unblocked-by:` is free text typed into
  a `comment add` that validates nothing. 4 of the 6 retirements ever written on this board were
  silently discarded as prose — same author, same spec, both forms, zero feedback. **Rule: when a
  format is machine-parsed, audit which side of it has a generator. The unassisted operation is where
  the corpus is wrong, and "I recorded it" is not evidence the record parsed — re-derive the ledger
  with the real parser, never from your own report of having written it.** → LOOP-287.

- **2026-08-03 (pm, twenty-sixth fire) — a shared helper that returns more than its callers want
  exports its blindness to everyone who arrives later.** `deliveryProjects()` filters only `_team`;
  every call site re-applies the real exclusion by hand, so LOOP-271 predicted the next consumer would
  be scratch-blind. One landed hours later and was — and at a worse blast radius than any instance the
  ticket listed, spawning a daemon and binding a port rather than rendering a wrong row. **Rule: a
  by-convention filter at N call sites is an N+1 problem; fix the seam so the default is the safe set
  and inclusion is opt-in. And when a ticket already owns the cause, a new instance is evidence plus an
  AC gap to close on it, not a new ticket — check whether the existing ACs would actually have covered
  the surface you just found.** → LOOP-271 (AC1 widened to *schedulable*, AC6/AC7 added).

- **2026-08-03 (pm, twenty-fifth fire) — audit a guard list against what each artifact HOLDS, not
  against what each check was written for.** Doctor's three committability guards hard-fail on
  `hub.db` (board content, no credentials), name an *encrypted* bundle and a marker file as W06
  leaks, and never name `.dev-loop/secrets.env` — the one artifact stored as **plaintext
  credentials**. A workspace that follows the hard fail's own remediation exits `DOCTOR_OK` with that
  file untracked and un-ignored. The guards grew one incident at a time, each enumerating the
  artifact that prompted it. **Rule: when a check works from a list of names, the audit is not "does
  each entry fire?" but "sort every artifact by what a leak would cost, and read the list against
  that order" — the gap is the artifact nobody has had an incident about yet.** → LOOP-285.
- **2026-08-03 (pm, twenty-fifth fire) — retire a satisfied dependency edge when you observe it, not
  when it finally blocks something.** Four §9c edges sat `Done`/`Canceled` for several fires with no
  `Unblocked-by:` marker. They were harmless — a dead edge can only cause a false *non*-unpark — and
  precisely because they were harmless, three consecutive fires each re-derived that and carried a
  note forward. **Rule: cosmetic state still costs a re-derivation every time it is read; clear it at
  first observation. A carried caveat is a tax paid per fire, not once.**
- **2026-08-03 (pm, twenty-fifth fire) — a queue that cannot drain is not therefore stale; test the
  tail before cancelling any of it.** Junior at cap for thirteen fires and 71 Backlog rows made a
  rotted tail the attractive hypothesis; four of the oldest rows all still reproduced against
  `origin/main`, one of them inside this fire's own transcript. **Rule: grooming may cancel only on
  an observed premise failure, never on age or queue pressure — cancelling live work to make a depth
  number look healthy destroys the record and leaves the real constraint, throughput, unmeasured.**
- **2026-08-03 (pm, twenty-fourth fire) — a cleanup procedure's residue can be its OUTPUT rather
  than its waste; establish which before stripping it.** I carried a plan to delete this log's
  `[ARCHIVED]` stubs as monotone residue — my own prior ruling. 3 of 13 hold the **only** copy of
  clauses still in force, and the largest (12 117 B) is the `STANDING RULES IN FORCE` distillation
  that made archiving ~54 KB safe. §20 R2 archives *detail* and gives an archived period's
  still-in-force *rules* no home, so every pass must leave one. **Rule: before deleting what a
  procedure leaves behind, establish whether the leftover is the procedure's product. Load-bearing
  residue is a missing section in the procedure, not a discipline failure.**
- **2026-08-03 (pm, twenty-fourth fire) — a pre-flight that never asserts its own subject can only
  ever be a green light.** `dev-loop doctor` exits **0** with `DOCTOR_OK` outside a workspace: it
  falls silently to the machine-global db, reports another workspace's projects, and skips
  W01/W18/repo/fires/landing entirely, while 18 of 19 sibling verbs refuse to act there.
  LOOP-117/168/199 fixed rungs 1–2 of that db ladder; nothing covers rung 3. **Rule: a surface whose
  verdict means "safe to proceed" must state what it examined — a green verdict over an unnamed
  subject is worse than no verdict, because it is trusted.** → LOOP-284.
- **2026-08-03 (pm, twenty-fourth fire) — a `try` cannot catch what it does not `await`, so an
  intent written as a comment is not an implemented intent.** `team.ts:49-53` catches `WsNotFound`
  under a comment reading *"NEVER a raw stack trace"*; `team repair` is the one async subcommand
  dispatched without `await`, so its rejection escapes the block written to contain it, while its
  async siblings carry `await` and behave. **Rule: verify a stated intent by exercising the surface,
  not by reading the handler — in all six cases the information was complete and only the framing
  was lost, which no unit test of the thrower would catch.** → LOOP-283.

- **2026-08-03 (pm, twenty-third fire) — a bounding procedure whose RESIDUE is monotone cannot bound
  anything; it can only slow it.** §20 R2 was run twenty times on `docs/STRATEGY.md` and the file
  still grew **+1 036 B per PM fire** across its last 22 lands (91 706 → 114 486 B). Not a discipline
  failure: R2 prescribes leaving "a one-line index entry per archived period", the practice left a
  multi-line `[ARCHIVED]` stub carrying its own clause list, and six such stubs held 10 424 B of
  *permanent* residue while each fire appended a fresh ~4.5 KB journal. **Rule: before crediting a
  cleanup procedure, compute what it leaves behind per invocation against what arrives per
  invocation. If the residue does not go to zero, the procedure sets a slope, not a ceiling** — and
  the fix is to run the procedure against its own residue, which pass 21 did (first net-negative
  pass: −4 319 B).
- **2026-08-03 (pm, twenty-third fire) — a threshold no surface computes is a suggestion, and the
  loop already knows the difference.** `docs/STRATEGY.md` is the only per-fire agent input with no
  budget constant, no doctor code and no line in `metrics --context`; at 114 486 B it is **14.0× the
  lessons INDEX budget that doctor W03 does police**, and 5.7× §20 R2's own "~20KB". The lessons
  library is the existence proof that the enforced shape works. **Rule: when a governing document
  states a numeric limit, ask which surface computes it — an unread limit and no limit produce the
  same artifact.** Filed as **LOOP-282** (blocked-by LOOP-263), and it is the
  `docs/design/conventions-to-code.md` thesis LOOP-228 already adopted: *prose is a weak mechanism.*
- **2026-08-03 (pm, twenty-third fire) — when a corpus has an enforced home and an unenforced one,
  content migrates to the unenforced one, and the migration looks like diligence.** §17 makes reflect
  the only autonomous curator of the budgeted, W03-policed lessons library; reflect has fired **6**
  times, last 2026-08-01T00:22 (~62 h against a configured `1d` cadence) and belongs to neither
  `GROUPS.core` nor `GROUPS.outward`, so no group name reaches it. PM cannot write that corpus, so
  PM doctrine accumulated here instead. **Rule: when one corpus is frozen at 93 % of budget while a
  sibling grows unbounded, look for a WRITE PERMISSION asymmetry before concluding either is
  mis-sized.** Evidence posted to LOOP-90 (its ACs already cover the fix — surface the dropped
  cadence); whether to add reflect to `--agents` is the operator's call and carries its own cost.

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
