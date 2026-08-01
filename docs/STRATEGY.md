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


### 2026-08-01 (tenth fire + mid arc) — [ARCHIVED]

Rolled whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 10) —
the tenth-fire entry and the `2026-08-01 (mid)` arc, ~20 KB. The `2026-08-01 (early)` arc was rolled
earlier under pass 6 (verified present in the archive at its reworded heading before this fold was
taken). Clauses from those fires still in force:

- **An upgrade has THREE axes on this host, not one** — the CLI (fresh process, instant), the hub
  daemons (restart required), and the long-lived `run-agents` scheduler (restart required, nothing
  detects it). Never answer "is this host current?" with `dev-loop --version`. This rule was earned
  twice and paid a third time on 2026-08-01 (see the eleventh-fire entry below).
- **`merged` ≠ `published` ≠ `installed` ≠ `running`.** Attribute runtime behaviour from
  `dev-loop events` and the installed tree, never from repo source.
- **The bottleneck is landing, not idea supply.** A deep Backlog with an idle tier is a routing or
  infrastructure problem; filing more tickets is padding, not throughput.
- **Aggregates hide the worst event.** Every cost surface bills fires killed mid-flight as delivered
  (LOOP-219), and a mean can never reveal that the smallest number was the most expensive mistake.
- **A correction must travel with the thing it corrects.** The merge-guard producer named in that
  arc was exonerated, then found guilty on the third pass; the record keeps all three steps because
  the middle one is what made the last one findable.


### 2026-08-01 (pm, eleventh fire) — the third staleness axis stopped being theory: a stale daemon has been silently rewriting board writes, and it killed split-dev delegation

`origin/main` moved to **`57af9a7`** — PR #141 (LOOP-103), merge-commit CI green on both matrix
nodes. Product moved for the second consecutive fire.

**LOOP-103 verify-FAILED on AC3, and the code is not the reason.** The implementation is right and
stays: project-scope `fireTimeout`/`stallTimeout` are honoured on delivery fires, `cadence` is
rejected at project scope, and the BINDING AC6 steward guard I attached at the design gate was
resolved the cheap way (`!teamScope`) with the rule stated beside the lookup. I exercised it on a
**three**-project fixture rather than reading the diff: `proj-a` → `45m/13m`, `proj-b` → `20m/4m`
(isolated), a project with no `agents` block → `1h/off` (defaults byte-unchanged), and the steward
`sweep` fire → team `55m/7m`, not `proj-a`'s `33m/3m`. What failed is the Change-3 doc edit: the
`projects.<key>.agents` row now claims the resolution order is *project > **CLI flag > team-scope**
> default*. It is not. `--fire-timeout 5m` against `team.agents.sweep.fireTimeout:"55m"` renders
`55m` — the flag loses — and this repo's own green test says so by name (`LOOP-9: per-agent config
(30m) beats explicit --fire-timeout 2h`). The ticket's own spec had the order right; the sentence
transposed two terms. That matters because it is the **only** precedence statement in the schema
doc: an operator reading it will expect their command-line flag to win, and it is silently ignored —
the same validate-then-drop surprise the ticket existed to remove, relocated from the code into the
docs. `Canceled`, superseded by **LOOP-257** (senior direct-code per the §3 junior-escalation rule,
carrying the doc fix, the `stallTimeout` test variant the shipped block omitted, and one assertion
that makes the corrected claim executable on the v2 path).

**The daemon axis has been corrupting writes, not just serving old reads.** The `loop` hub daemon is
pid 89725 on **v1.13.0** while the CLI is **v1.14.0**. Board writes execute in the daemon, so this
is not a stale-read problem: a dev-tier actor writing a cross-tier assignment had it **silently
collapsed to self**, which means **senior→junior delegation has been impossible** — senior-dev hit
exactly this staging a child for LOOP-172 and had to cancel the half-staged LOOP-256. The same stale
build is why merge-guard kept nulling assignees on hold, and why LOOP-235 needed unparking three
times: the fix shipped in the **CLI**, and `--apply` writes through the **daemon**. Four fires of
churn, one canceled ticket, and a dead delegation path from one un-restarted process. Filed
**LOOP-258** — `Human-Blocked`, assigned to the operator, one command
(`DEVLOOP_PROJECT=loop dev-loop daemon up`). I did not restart it myself: shared infra, other fires
may be mid-write, `autonomy: ask`.

**I re-pointed LOOP-172's blocker edge, because it was aimed at a ticket that cannot resolve it.**
It carried `Blocked-by: LOOP-235`, but LOOP-235's deliverable is the W06 bundle-leak guard — it is
where the diagnosis was *recorded*, not what *fixes* it. Left alone, LOOP-172 would have auto-unparked
the moment LOOP-235 went `Done`, daemon still stale, delegation still impossible: the second churn on
the same root cause. Both edges now stand, and §9c unparks only when all are terminal, so the
AND-gate is strictly safer than swapping one for the other.

**Corrected a handoff claim rather than repeating it — `doctor` is not blind here.** senior-dev's
hardening note said a W-check on "daemon code-version ≠ CLI version" would have caught this three
fires ago. That check already exists (`doctor.ts:840`) and it fired correctly this fire, naming both
versions and the exact remediation. The defect is its **classification**: it is an *unnumbered* warn
inside the section header that reads *"best-effort; informational, not a hard-fail gate"*, so
`DOCTOR_OK` prints anyway. Its sibling **W18** — the npm-publish skew, whose blast radius is merely
running old *read* code — is numbered and prominent, while the skew that silently corrupts the
system of record is neither. The operator console tells the human to *"fix every ❌ and read every
W-code"*; this line is neither. Filed **LOOP-259** (junior tier — a scoped classification change, no
`sensitive` signal, and §21b's "when borderline, junior" holds).

**Last fire's tier-feeding worry resolves differently than I framed it.** Senior is not starved: it
holds **8 unblocked `Todo`** rows against a cap of 10, so the two open slots are an allowance, not
an emptiness — filing senior work to fill them would be padding. The real constraint is narrower and
worse: while the daemon is stale, senior can design but **cannot delegate**, so any
design-and-delegate ticket filed now stalls at the staging step exactly as LOOP-172 just did. Until
LOOP-258 clears, the only *completable* senior work is direct-code shaped. That is a routing fact,
not a capacity fact, and it is why I filed one junior ticket and no senior ideation this fire.

- **2026-08-01 (eleventh fire) — board state.** Verify **1 → 0** (LOOP-103 closed). Unblock **0**;
  `needs-pm` **0**; `_team` carrier **0**; `Human-Blocked` **0 → 1** (LOOP-258, the first item to
  reach the operator's queue in ten fires). §9c: **10 edges, 0 unparked, 10 held** — every blocker
  non-terminal, and one edge re-pointed. Depth at close: senior **8/10**, junior **13/10 (over
  cap)**, Backlog **60**. Promoted **0** — junior is over cap and the Backlog holds no senior-tier
  row (LOOP-256 was canceled by its author). Doc-watch: content hash matched the stored cursor —
  **thirty-five fires with no operator doc edit**. `DOCTOR_OK` with W01/W18/W20 + the unnumbered
  daemon warn; W20 notes there is no `team.comms`, so LOOP-258 surfaces only in `doctor` and
  `dev-loop metrics`, never as a push reminder — doctor's own `NEXT:` line does route to it.
- **§20 R2 rollup pass 10.** Rolled the tenth-fire entry and the whole `2026-08-01 (mid)` arc to
  `docs/strategy-archive/2026-08.md`: **109.0 KB → 90.7 KB (−16.8%)**. Current state had never been
  rolled and was the growth; it now is. Before folding I verified the pass-6 fold it cited was
  genuinely performed — it is, at a **reworded** heading in the archive, which is why a
  phrase-match against the live doc's wording finds nothing. Cite folds by arc, not by title.



### 2026-08-01 (pm, twelfth fire) — the promotion queue has never been ordered, and the cost program is measuring against a denominator missing its largest input

`origin/main` is **`626f6f4`** — my own doc commit from the eleventh fire. **The product did not
move this fire** (`57af9a7..626f6f4` is docs-only), so this was a lens rotation on an unchanged SHA,
not a review of new code. Doc-watch: `docs/STRATEGY.md` hash unchanged — **36 consecutive fires with
no operator doc edit**.

**Nothing to verify, nothing to unblock, nothing promotable.** In Review was empty board-wide (Job A
= 0). `needs-pm` = 0. The §9c tracker pass ran all 10 parked rows: **10 edges, 0 unparked, 10 held**
— every park still has ≥1 live blocker, unchanged from the eleventh fire. Both open
`[reflect-proposal]` tickets carrying `## Deferred findings` (LOOP-213, LOOP-218) were already
triaged in earlier fires; no §17 debt outstanding. **Promoted 0**: junior sits at **12/10** unblocked
Todo (over cap → §5a says promote nothing), and senior has 3 free slots but **zero senior-tier
Backlog rows to promote into them**.

**LOOP-258 is still Human-Blocked on the operator (26m at boot), and the daemon is still v1.13.0
against CLI v1.14.0.** The eleventh fire's constraint therefore stands unchanged: senior-tier
filings stay direct-code shaped, because a stale daemon collapses a dev-tier actor's cross-tier
assignment to self and `Mode: design` work provably cannot stage its children. PM writes remain
unaffected — both tickets filed this fire kept `assignee: junior-dev`.

**The finding: PM's promotion list is the only servable list in the codebase with no ordering.**
`opQueue`'s pm `backlog` array (`agentops.ts:212`, `:221`) is built from a `SELECT` with **no
`ORDER BY` at all** and is then filtered and capped with **no sort applied** — while all three
sibling reads order correctly (`agentops.ts:196` and `servable.ts:53` both `ORDER BY created_at`;
`servable.ts:60` sorts the dev-tier slice by pick rank *then* `created_at` FIFO). §5a instructs PM
to "promote the top of the §5 pick order", and the list it is handed carries no pick rank and no
aging term.

Measured consequence, all 260 board rows: **zero Todo rows survive from 2026-07-30, while 13
Backlog rows from that day have never been promoted** — through ~500 fires and two days. 16 rows
filed *today* are already Todo. The served order's first 13 positions are all 2026-08-01 rows; the
tail is 2026-07-30 (LOOP-31, -98, -97, -96, -91, -90), and the order is provably neither
`created_at` ASC nor DESC. The starved rows are not stragglers — LOOP-98 (`acceptRate` wrong in
both implementations), LOOP-97, LOOP-90 tie on rank with the rows that overtook them and lost
purely on list position. Filed **LOOP-262**. Note this is the *third* copy of the same
rank/order drift after LOOP-144 and LOOP-169/251 — and that **LOOP-254 landing makes it worse**,
since new p1 rows will jump a tail that is still unordered.

**The second finding is on the operator's own top priority.** `dev-loop metrics --context` is the
surface LOOP-228 guardrail 1 makes the compression program measure against, and it omits the
largest PM-specific per-fire read. `hub/src/context-bill.ts:14–16` states its scope exactly (SKILL
prose + cheat block + cited conventions spans + lessons caps); `grep -n 'STRATEGY\|strategyDoc'`
against it returns **nothing** — while `references/conventions.md:1667` (§20 R2) says in plain words
that "PM re-reads this whole doc-base every fire, so an unbounded `Decisions (running log)` is a
per-fire token tax." pm's modeled bill is 191 322 B (~47.8K tokens); this doc is 99 839 B (~25.0K
tokens) and uncounted — **pm is understated by ~52 %**. A −30 % target against that denominator can
be hit on paper while pm's real bill barely moves. And the doc regrows ~9 KB per PM fire against a
periodic manual fold (109.0 → 90.7 → 99.8 KB across pass 10 alone), which **LOOP-238's
conventions-only ratchet cannot observe**. Filed **LOOP-263**, back-linked onto LOOP-228.

**Groomed:** LOOP-236 raised p2 → p1. It is Lever 1 — the head of the compression program's only
chain (`LOOP-236 → LOOP-237 → LOOP-238`, each blocked on its predecessor) — and sat below its own
precondition LOOP-239 and the unrelated LOOP-254. Recorded honestly on the ticket that this changes
nothing today (all Improvements tie at rank 5 and FIFO decides) and only bites once LOOP-254 lands.

**Board shape, for whoever reads this next.** Intake exceeds completion every day — created
90 / 114 / 46 against closed 35 / 91 / 31 — so the Backlog grows and the unordered tail sinks
further out of reach each fire. 61 Backlog rows: **60 junior, 0 senior**, plus the LOOP-228 umbrella
(null assignee by design, not the LOOP-244 defect). The tenth fire's correction still applies —
senior's supply is PM's filing mix — but its prescription cannot be executed while LOOP-258 blocks
design-and-delegate work.
### 2026-08-01 (pm, thirteenth fire) — the board's "parked" counter has never once counted a park, and a P1 arrived unpickable because it was filed that way

`origin/main` is **`4e6bde2`** — my own doc commit from the twelfth fire. The product *did* move
since the last lens sweep: that sweep was taken at `626f6f4`, and **`58b2eb0` (LOOP-104) landed
mid-fire on top of it**, so the swept-lens list reset and this fire ran a fresh rotation against the
current tree, as the twelfth fire's state note instructed. Doc-watch: `docs/STRATEGY.md` hash
unchanged — **37 consecutive fires with no operator doc edit**.

**Job A empty, Job B empty, §9c unchanged.** In Review was 0 board-wide. `needs-pm` = 0. The §9c
tracker pass ran all 10 parked rows: **10 edges, 0 unparked, 10 held** — every park still has ≥1
live blocker (LOOP-105 correctly stays parked: LOOP-104 went terminal but LOOP-264 now gates the
same parser contract). LOOP-218's `## Deferred findings` were confirmed already triaged; no §17
debt outstanding.

**LOOP-258 is still Human-Blocked on the operator — 1h at boot — and the daemon is still v1.13.0
against CLI v1.14.0.** I deliberately did **not** comment on it to nudge. On this board a comment
would be actively harmful: **LOOP-108** measures that the operator's decision-queue wait is derived
from `updated_at`, so any comment resets the age. LOOP-258's *whole value as a signal is its age* —
it is what puts it at the top of `dev-loop doctor`'s NEXT line and `metrics`' decision queue.
Writing "still blocked" would have reset a 1h wait to 0m and buried the thing I was trying to
raise. Recording the reasoning because the temptation recurs every fire the park survives. The
eleventh fire's constraint stands: senior filings stay direct-code shaped while the daemon is stale.

**The finding: `dev-loop metrics` prints two contradictory answers about the same ticket, two lines
apart.** Verbatim this fire: `board: … 0 parked, 10 sequenced` sits directly above
`decision queue (yours): 1, oldest LOOP-258 … waiting 1h`. Both describe LOOP-258.

The cause is two definitions of "the human park" inside one file. `boardMetrics()`
(`metrics.ts:257`) selects on the **`blocked` label**; `decisionQueue()` (`:285`) selects on the
**`Human-Blocked` state**. §9 makes the state the human park on `service` and the label park the
`linear`/`local` form — so `blockedNow`, whose own doc comment at `:216` claims "parked (need human
attention)", is **structurally incapable** of counting an operator park on this backend.
`decisionQueue()` is the newer surface and was never reconciled with the older field.

Measured against the full event ledger: **15 tickets have been parked `Human-Blocked` in this
board's life; 0 of them carry a `blocked` label — so the counter has missed 15 of 15, every one.**
It is not mis-derived, it is a constant `0` rendered as a clean board — the same family as
LOOP-122's `0 escaped to prod` and the same principle LOOP-42 already established (an unmeasurable
field must not print the reassuring reading). Filed **LOOP-265** (p2, junior).

**This re-orders LOOP-31 rather than duplicating it.** LOOP-31 (filed 07-30, before
`decisionQueue()` existed) frames the same area as *CLI-vs-web-tile* and asks for them to agree.
One reading of it — align the tile to `blockedNow` — would push a structural constant `0` into the
operator's primary dashboard. LOOP-265 fixes the definition first; LOOP-31 then aligns the tile to
something correct, and its own distinct contribution (the tile cannot see a §9 Dev bail at all)
survives intact. Noted on both tickets; no hard edge added, since LOOP-31 is implementable either
way.

**Groomed: a P1 Urgent bug arrived unpickable, and the cause is new.** qa filed **LOOP-261** at
12:45Z with `assignee: null` — no dev tier. For 43 minutes an Urgent bug was absent from both
tiers' `servableSlice`, and from `todoDepth`'s numerator *and* denominator; the only surface that
rendered it at all was my own `backlog` list, which filters the owner **label**, not the tier. I
assigned `junior-dev` per §21b (a QA-filed, scoped bug-fix; not `sensitive`).

This is the **fourth** measured instance of LOOP-244 and **the first caused by a filing rather than
by one of the three writers LOOP-244 catalogues** (Step-0 orphan reset / merge-guard bounce /
manual `op save_issue`). It strengthens LOOP-244's AC without changing it — the proposed W27 keys
on the unreachable *state*, not on any writer, so a filing-time null is caught by the same check —
and adds a test case: a `Backlog` row with a null assignee must trip it too, since a row that can
never be promoted to a tier that can pick it is stuck just as hard, only more quietly. Recorded on
LOOP-244.

LOOP-261 also matters on its own: it is the *structural* reason LOOP-258's class of incident cannot
self-heal. `ensureHub` → `wireEnv` (`hub.ts:20-24`) unconditionally sets
`DEVLOOP_PROJECT = "_team"`, so the one pre-flight `dev-loop run` performs can only ever restart
the `_team` daemon — never the per-project daemon (`daemon-loop.json`, port 8789) that every
agent-fire op actually resolves to. Re-derived against `4e6bde2` and against the running workspace
before grooming.

**Promoted 1: LOOP-244** — rank 1 of the junior slice (`priority=1` + `Bug`) and the oldest row at
that rank. Junior was **9/10** unblocked Todo at boot (one slot; it took it, now 10/10); senior sits
at **7/10** with, again, **zero senior-tier Backlog rows** to promote into its three free slots.
Promotion was done by hand in §5 pick order rather than off the top of the served list, because
**LOOP-262** — `opQueue` returning `backlog` in raw row order — is still unshipped.

**Board shape.** 64 Backlog rows at boot: **62 junior, 0 senior**, plus two null-assignee rows —
LOOP-228 (the cost-program umbrella, unassigned by design) and LOOP-261 (the real defect, now
fixed). The junior-tier monoculture the lessons file has tracked across six snapshots is unbroken,
and intake still exceeds completion. **Filed 1 this fire, not 5.** With junior at cap and 64 rows
already queued, the scarce resource is not ideas — the useful contribution was a measurement the
operator reads every fire, and one repair that made an Urgent bug reachable at all.

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

- **2026-08-01 (pm, twelfth fire) — "an ordinary Backlog ticket awaiting promotion is normal, not
  stranded" (§5a) is true per-ticket and false in aggregate; check the AGE DISTRIBUTION, not the
  depth.** For twelve fires this log treated a deep Backlog as a supply/throughput question and never
  asked whether the same rows were being skipped every time. They were: **zero Todo rows survive from
  2026-07-30 while 13 Backlog rows from that day have never once been promoted**, across ~500 fires.
  The cause is mechanical, not judgement — `opQueue`'s pm `backlog` list is the only servable list
  with no `ORDER BY`, no pick rank and no FIFO tie-break (`agentops.ts:212`/`:221`), so "promote the
  top of the §5 pick order" is an instruction PM cannot follow with the data it is handed, and
  whatever SQLite emits first wins. **STANDING: a queue whose depth is stable can still be starving
  its tail — measure a backlog by the age spread of what leaves it, not by how many rows are in it.
  A per-item "this is normal" rule cannot detect a systemic ordering fault.** Filed LOOP-262.
- **2026-08-01 (pm, twelfth fire) — a measurement surface that omits an input is worse than no
  surface, because it converts an unknown into a confident wrong number.** LOOP-228 guardrail 1 makes
  `dev-loop metrics --context` the method the whole compression program is judged by, and
  `context-bill.ts` does not count the strategy doc at all — the very file §20 R2 calls "a per-fire
  token tax". pm is understated by ~52 % (191 322 B counted, 99 839 B uncounted), so the operator's
  suggested **−30 % target is reachable on paper at a true saving near 20 %**, and LOOP-238's
  conventions-only ratchet would be seeded from that incomplete baseline. **STANDING: before
  optimising against a metric, enumerate what the metric does NOT count — and check that list against
  the rules that tell agents what to read. The program's own guardrail ("measure every change") is
  what makes the omission expensive rather than merely inaccurate.** Filed LOOP-263 against LOOP-228.
- **2026-08-01 (pm, twelfth fire) — encode intent at the priority even when the pick order cannot
  read it yet, and say plainly that it is inert.** LOOP-236 is the head of the top-priority program's
  only chain and sat at p2 beneath its own precondition. Raising it to p1 changes **nothing today** —
  every Improvement ties at rank 5 and `created_at` FIFO decides — and only bites once LOOP-254 lands
  its approved variant. Recording the inertness on the ticket is the point: a silent priority bump
  reads to the next fire as a steering action that already took effect. **STANDING: when a grooming
  action is a bet on an unlanded mechanism, name the mechanism and the date it starts working, or the
  next reader will mistake intent for effect.**

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
