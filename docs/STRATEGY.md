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
  service backend + `dev-loop` CLI, **v1.15.0 line** (see `CHANGELOG.md`), with the full npm test
  suite; `docs/` for architecture, running, portability, daemon, design records, and reviews;
  `config/` for MCP templates and example workspace config.
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

- **Release history is `CHANGELOG.md`, not this section.** The 1.0 → v1.10.0 provenance that used
  to be restated here in three re-sync parentheticals is rolled to
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 41, block A). The
  always-current user-facing picture is `README.md` + `CHANGELOG.md`; this section carries only what
  a fire still needs to act.

- **[ARCHIVED] the 2026-07-30 → 2026-08-01 build and verification arc.** Roughly 60 dated entries
  covering the landing wedge and v1.11.0; the metering foundation and its join key; landing
  observability and `doc-land`; the merge-guard axes; the daemon port-band and spawn-idiom findings;
  the install-skew episodes and the v1.13.0 release; the `bundle export` dead safety gate; and the
  three earlier R2 rollups. **Every subject is verified-`Done` and superseded by the shipped code.**
  Full provenance in [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass
  41, block B). Three facts from that arc are still load-bearing and are kept here rather than
  archived: **(a)** the boot corpus is DELIVERED (`--assemble-boot`, 98–147 KB per fire) from
  2026-07-31T23:00:15Z, so a lessons rule scored before that timestamp measured a different regime;
  **(b)** the §22 reports tree keys on **local** `date +%F` while every artifact it indexes is UTC
  (**LOOP-214**, now STANDING RULE 1); **(c)** every cost surface bills fires killed mid-flight as
  delivered — 7.9% / 40.27 USD (**LOOP-219**), so a cost-per-change figure is an over-estimate and a
  floor on waste.

- **[ARCHIVED] fire journals, tenth through fiftieth fire (2026-08-01 → 2026-08-06).** Rolled
  whole to [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 41 block
  D; the forty-ninth is pass 42 block A, the fiftieth is pass 43 block M), replacing the thirteen
  per-period stubs they had left behind. §20 R2 prescribes one index entry per archived period;
  thirteen stubs for one archive is the residue pass 41 removed.

- **2026-08-06 — the release axes agree, and the agreement is no longer a property of a hand-built
  pin.** Install is a real npm directory at `/opt/homebrew/lib/node_modules/@dyzsasd/dev-loop`
  matching `origin/main` on version AND build commit, with `skills/` + `references/` verified
  byte-identical (`cmp`); the local-source-build pin is retired in fact. Provenance in
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 42, blocks C+D).
  **Four axes, not one** — CLI, SKILL corpus, daemons, and the `run-agents` scheduler (W36) — and
  §12b applies the moment any of them moves. The daemon axis is only checked at version
  granularity today: **LOOP-364**.

### 2026-08-06 (pm, fifty-first fire): a feature that shipped, passed its tests, and has never once run

`stale-exempt` — LOOP-335, in `main` since `434a125` — has never fired on this workspace and cannot,
because `deltaIsCiIrrelevant()` reads `repos.<ref>.ciIrrelevantPaths`, which is unset here and named
in no doc, no `--help`, and no failure message. The gating itself is correct and was specified that
way (an unconfigured repo keeps v1 behaviour byte-for-byte); nothing carried the switch to a reader.
Measured this fire: 8 of the last 60 commits on `origin/main` are `docs(strategy)`, and the union of
every file they touch is exactly `docs/STRATEGY.md` + `docs/strategy-archive/2026-08.md` — the delta
LOOP-335 was built to exempt. At 14:01Z merge-guard staled PR #236 (LOOP-360, the fix that unblocks
the LOOP-348 design chain) on that exact two-file delta; its head has since been force-rebased from
`b054d51` to `27e1774`, discarding a green two-job matrix. Filed **LOOP-365**. The immediate remedy
is one operator `team set` and is recorded in the ticket, not executed here — config mutators refuse
agent writes inside a fire.

### 2026-08-06 (pm, fifty-second fire): a scope claim that only a docstring enforces

`hub/src/destructive-guard.ts` has stated since LOOP-305 that every verb destroying operator data
calls into it. Four do, and all four ask one question: did you mean this target? LOOP-367 established
that a fire answers that question by supplying the token the refusal names, and adds the second
question — may a fire destroy at all — to `board restore` alone. The verb that cascade-deleted 301
tickets on 2026-08-04 is `remove-project`, whose path is unchanged. The product's only fire-marker
refusal (`cli-agentops.ts:196`) is scoped to `AGENT_WRITE_OPS` and actor `operator`, and both
incidents were `qa` fires that miss it on both conditions. Call sites, greps and dates: **LOOP-368**
(senior, `sensitive`), blocked on LOOP-367 and consuming its `activeFireMarker()` relocation.

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

- **2026-08-06 (pm, fifty-second fire) — a module's coverage claim is enforced by an inventory test,
  or by nothing.** `destructive-guard.ts`'s claim to cover every destructive verb has been falsified
  twice by incident — LOOP-316 (`--force-reseed`), LOOP-367 (`board restore`) — and each repair
  extended the module by one call site, leaving the claim exactly as unenforced. Standing rule: a
  guard claiming to cover a SET ships a test that derives that set from the source and asserts
  membership, and names in its docstring the residual case the test cannot reach. LOOP-368 AC6/AC7
  carry the two halves.

- **2026-08-06 (pm, fifty-first fire) — a default-off feature is not delivered until something
  names the switch, and the failure it prevents is the cheapest place to name it.** LOOP-335 was
  right to default `ciIrrelevantPaths` off, right to validate it, test it, and give it a mutator.
  What no acceptance criterion covered is that the knob reached no reader: absent from the
  repo-field table in `references/config-schema.md` that documents both its siblings, absent from
  `--help`, and unnamed by the very branch that would have taken it. So the feature sat inert while
  the case it was built for recurred 8 times in 60 commits. **When a change ships default-off, its
  discovery path is part of the increment** — and the branch that would have used it is the one
  place a reader is already looking when it matters.

- **2026-08-06 (pm, fiftieth fire) — when several surfaces answer one question, the defect is
  usually in which of them was upgraded, not in whether the datum exists.** Three consumers asked
  *is the running daemon my installed code?* and gave three answers, because the finer datum
  (`buildCommit`) reached the wire and then only ONE consumer. Same shape in W35: `r.project` is on
  every ledger row and the grouping never reads it. Neither is a missing capability — both are a
  capability that landed at one call site and was never propagated to its siblings. **When a shared
  fact gains precision, the work is not done until every consumer of the coarser form is enumerated
  and moved.** The cheap version of that audit is a grep for the OLD predicate, run in the same fire
  that introduces the new one.

- **2026-08-06 (pm, fiftieth fire) — a cap that is disclosed is not thereby made honest: every
  figure computed downstream of it must be re-derived, or it silently reports the page as the
  world.** The web board discloses its truncation correctly ("showing 250 of 333") and, beside that
  notice, prints per-state counts and "nothing here" hints taken from the truncated array — so the
  disclosure sits next to numbers it does not govern. The tell was arithmetic, not inspection: the
  column counts summed to exactly the cap. **After adding a bound, list what else reads the bounded
  set** — counts, empty states, aggregates, "is there any?" checks — because each of them silently
  changes meaning from *about the board* to *about the page*.

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
  15. **A commit is a local fact, a PR is a forge fact, and a running product is a third
     fact — a claim about delivery names which one it measured.** A ticket In Review may hold
     uncommitted work in a worktree; a merged PR may not be published; a published package may not be
     installed; an installed package may not be what the daemons or the scheduler loaded. Check
     delivery (branch/commit/PR + what the running env serves) BEFORE judging the code, and re-derive
     it per axis — `dev-loop --version` alone answers none of them.
  16. **A commit is not verified to carry one increment.** A shared checkout leaks an unrelated
     fire's uncommitted edits into the commit, and every gate — build, test, CRAP, review — passes on
     the union. `git apply --reverse --check` against the claimed diff is the decisive
     did-this-and-only-this-land test.
  17. **A test that hand-supplies the dependency the delivery path fails to supply can only test the
     callee.** Where the suspected defect is in the WIRING, the fixture must exercise the production
     caller; injecting the argument the caller never passes converts a caller bug into a green suite.
  18. **A `Mode: design` prefix at the START of a description is the switch that routes a parent into
     PM's slice; a `Bug` design parent routes to PM by CONTENT while the write gate authorises by
     LABEL, so a single-owner `qa` design parent is visible to PM and closable only by QA** (open as
     **LOOP-310**). Correct the owner labels to the dual set rather than working around it silently.
  19. **A dedupe note is a prediction about code that has not been written** — it claims a sibling's
     fix, as specified, leaves this defect standing. Test it by opening the sibling's ACs, never by
     comparing titles; and re-check it at promotion, because a ticket's premises decay.
  20. **A ticket deliberately given no dev tier still needs an owner label, and an idle senior queue
     is a fact about the board rather than a routing bug.** The senior tier is fed by escalations and
     by other agents' `sensitive` findings; §21b forbids re-tiering to balance load, so an empty
     senior Backlog is filed honestly and reported, never manufactured.
  21. **A quantity stated in one unit and enforced in another has two values.** Check the unit at the
     seam that ENFORCES, not at the one that documents — and for a size or cost limit, ask which
     surface actually computes it, because an unread limit and no limit produce the same artifact.
  22. **A restore, a revert, or any recovery is verified by which edges still resolve, not by the row
     count.** A close that names a successor (`superseded by LOOP-x`) is a §3 obligation only if the
     id resolves to a ticket; `relatedTo` accepts an unvalidated id, and `dependency-graph`'s
     integrity check covers `Blocked-by:` edges and no other kind. Verify the reference in the same
     fire that writes it.
  23. **A procedure that exists to bound something is audited against the artifact's total, never
     against whether the procedure ran.** §20 R2 ran correctly on forty consecutive passes and the
     doc it bounds still reached 3.0x its budget, because it rolls one journal per fire while a fire
     appends a journal *and* one to three rulings — every pass compliant, the aggregate a monotone
     climb. "Did it run?" and "is it bounded?" have different answers and only the second is the
     point. Ask for the number (W37), not the log. **Corollary, applied by pass 42: a bounding pass
     must roll at least what the fire appends.**
  24. **A `Candidate ideas` entry with a named reversal condition is a spec, and the fire that
     clears the condition reads the parking lot BEFORE designing anew.** LOOP-350's whole design —
     saving, objection, and the form that answered the objection — was sitting banked in the section
     the ticket was about. The lot earns its cost only if it is read at filing time; a cleared
     condition is a prompt to re-verify against the tree, not a licence to file (fire 50 discharged
     one banked entry into LOOP-364 and closed another with no ticket at all).
  25. **A delivery claim is made per artifact class, not per package.** Doctor's `no skew` line
     compares the installed CLI; it says nothing about whether the `skills/` and `references/` files
     a fire actually reads come from that tree. A CLI that matches and a SKILL corpus that does not
     are one green check and one silent regression — verify each class directly (`cmp`), never infer
     it from the version line.
  26. **When one decision retires several options at once, check which option each argument was
     actually about before treating the bundle as settled.** §9.7 retired auto-publish and the
     local-source build together on arguments that only applied to the first; the second was
     reinstated on its own merits three days later.
  **RETIRED, do not re-derive:** *"a new `hub/test/*.ts` is a two-file change, the second being
  `hub/package.json`"* — superseded by `run-all.ts`'s glob discovery (LOOP-138/LOOP-139): a new
  test file with no `package.json` script now runs. *"The release gate is the loop's single
  blocking constraint"* — v1.13.0 published 2026-07-31T20:06Z; the constraint is retired and the
  live successor is the DAEMON skew (below), not the npm one.

- **📌 STANDING DECISIONS — the calls that must not be re-litigated.** Full text, with the evidence
  each rests on, in [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass
  41, block K).
  - **(pm, 2026-07-31) `dev-loop` will NOT auto-publish to npm on merge to `main`; the release stays
    operator-triggered.** Answers LOOP-38 AC-1. Two pieces of evidence: `main` is not a protected
    branch and a stale-green merge already left it red once (**LOOP-149**) — a push-triggered publish
    inherits that directly, into a registry where unpublish is a 72-hour window; and the release
    workflow was silently dead from `c02ba33` until LOOP-140 with every CI signal green throughout.
    **The chosen shape is the other half — keep the human in the release loop and make the signal
    that calls them trustworthy** (W18 → LOOP-151 → LOOP-167).
  - **(operator, 2026-07-31) §12b amended — "merged" and "running" are different states, and a
    verifier must name which one it established** (LOOP-170, `13bbc89`). senior-dev's original —
    make **"published"** the bar for CLI-behaviour ACs — was **declined**, because publishing is
    operator-triggered by the ruling above, so a blocking publish bar stalls every CLI fix's `Done`
    behind a human act. PM's amendment was adopted instead: stop conflating the two states, and
    forbid "verified live" for anything only merged. **Do not re-propose "published" as a blocking
    close bar.**
  - **(pm, 2026-07-31) 📤 §17 PROPOSAL STILL WITH THE OPERATOR — make the §22 report clock UTC.**
    `references/conventions.md` is a governing file, so this is proposed, never applied (§17). The
    change is `date -u +%F` / `date -u +%G-W%V` / `date -u +%Y-%m` plus one line stating the reports
    tree is UTC-dated to match the ledger and the board. Evidence on **LOOP-214**; doctor W25 is
    independently correct and does not depend on it. Recorded here because a proposal that lives only
    in a fire report dies with the fire.

- **📚 ARCHIVE INDEX — where the rolled provenance lives.** §20 R2 keeps one line per archived
  period here; the searchable per-fire recaps are the table of contents at the head of each pass in
  the archive file (pass 41, blocks F and G, carries every recap this section used to hold).
  - **2026-06-14 → 06-27** — the 2026-06 milestone arc (daemon foundation; the standalone-daemon +
    multi-CLI repositioning; hub buildout; the two-tier Dev split) →
    [`2026-06.md`](strategy-archive/2026-06.md).
  - **2026-07-30 → 07-31** — ~110 rulings and method notes (board search and ownership contracts;
    send-back-vs-verify-fail; §9c's `Canceled`-is-not-satisfied asymmetry; the validate-then-drop
    family; the brand decisions; R2 passes 1–8) → [`2026-07.md`](strategy-archive/2026-07.md).
  - **2026-08-01 → 08-05 (pm, sixth → forty-eighth fires)** — ~70 rulings across R2 passes 13–29,
    plus every fire journal and the full-text rulings of the thirty-second through forty-seventh
    fires, rolled by **§20 R2 pass 41** → [`2026-08.md`](strategy-archive/2026-08.md), blocks B–I.
    What still governs from that span is STANDING RULES 15–22 above.
  - **2026-08-06 (pm, forty-ninth fire)** — its journal, its three rulings, the local-source-build
    pin retirement record, and the release-axes-agree entry, rolled by **§20 R2 pass 42** →
    [`2026-08.md`](strategy-archive/2026-08.md), blocks A–D. What still governs is STANDING RULES
    **23–26** above; the pin's second clause is superseded by W36.

## Candidate ideas

_(The overflow parking lot: strong ideas not yet filed, each with the condition under which it
becomes correct to file. **Rolled 2026-08-06** — the pre-pass-41 list is verbatim in
[`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 41, block J). Two
entries left this list by being FILED as the reversal condition they named had lapsed, and one by
being discharged: the `[ARCHIVED]`-index compaction it designed is this very pass.)_

- **Should a successful `board restore` restart the daemon, or is reporting enough?** LOOP-367's own
  open question, recorded here so it does not close with that ticket. LOOP-367 makes the daemon
  REPORT the inode swap (503 + remedy); the verb itself still only prints advice, and the 2026-08-06
  incident ran 69 minutes because advice was ignored. **REVERSAL CONDITION: LOOP-367 lands** — decide
  it against the shipped health check rather than against a description of it.

- **Close the config-mutator gap wholesale — an operator capability call, deliberately not filed.**
  `references/config-schema.md` marks each field with its `dev-loop team set` path: 13 rows carry a
  ✓, 26 are marked `—`. Writable by **no mutator at all**, at create time or after:
  `team.agents.<h>.cadence` (`team init` hardcodes `{sweep:30m, ops:10m, reflect:1d,
  communication:1d}` — this workspace has exactly those four);
  `agents.<h>.{fireTimeout,stallTimeout,manual}`; `team.hub.agentInterface` and its project override,
  which config-schema itself calls *"the rollback switch"*; `team.autonomy`; `team.deployPolicy`;
  `projects.<key>.{mode,autonomy,reports}`; `team.opencodePermission`; `mirror.*`; and the daemon
  alert cadences. **REVERSAL CONDITION: the operator asks for it** — widening the allowlist is real
  surface area and each field arguably wants its own validation rather than a blanket path setter.
  `strategyDoc` is the filed instance (**LOOP-120**), `agentReviewers` another (**LOOP-123**).

- **`worktree reap --dry-run` previews the worktrees but not the branch decisions** (recorded at the
  LOOP-106 verify). The dry-run path returns before the branch logic, so it prints `would remove
  worktree …` and never says which branches would be *deleted* versus *KEPT as unrecoverable*. Since
  LOOP-106 the reap is an opt-in destructive verb, and for that shape **the preview is the safety
  mechanism**. Not a LOOP-106 failure — no AC asked for it. **REVERSAL CONDITION: the next change
  that touches the reap path** picks this up with it.

- **Cross-store ticket migration (linear↔service) — DEFERRED epic, operator decision.** The blocker
  is structural, not effort: hub ids are a global PK minted from prefix+seq (`hub/src/db.ts`) and
  `ensureProject` hard-throws on a prefix clash (`hub/src/seed.ts`), so an importer cannot preserve
  source ids as the PK — they must ride a separate `externalId`. The only cross-store seam today is
  the one-way hub→Linear `mirror` (a projection, not a bridge). Scope as its own epic when
  prioritized: exporter/importer per direction + `externalId` carry + id-remap + a runbook.

- **A verify-fail should be reachable from a green suite — the "which case does the fixture dodge?"
  check.** LOOP-57 shipped 22/22 green and was still unusable: its case (c) chose a *doc* file for
  the divergence it tested, making the only distinction that mattered (tree comparison vs commit
  range) unobservable. The move that caught it costs one question per verify — **name the variable
  the fixture holds constant, then ask what the product does when it varies.** A review *method*,
  not code: its shippable form is a §15 convention or a Reflect lesson, so it is a §17-gated
  proposal, never a Dev ticket.

- **A 点评 write path from the web UI needs a conventions §22 carve-out.** §22 says agents never
  write `*.review.md` — that is exactly what makes an on-disk review operator-authored-by-
  construction — so a web-UI write path is a §17-gated proposal, never a naive Dev ticket. (Live
  remainder of six DL-era candidates rolled at R2 pass 18; the rest were filed or landed on the
  retired **DL-prefix** board.)

- **DISCHARGED 2026-08-06 (fire 50), both loop-cost-governance banks.** *Daemon serves stale VIEW
  code* → its condition lapsed (LOOP-195 Done, the operator still told by hand); re-verified against
  `origin/main` and filed as **LOOP-364**, which is the sharper form: `/api/health` already serves
  `buildCommit` and only `daemon up` reads it. *Accept-rate in the Reflect daily digest* → **no
  ticket needed**: reflect pastes `metrics --window 7d --json` verbatim, so LOOP-98's fix arrived by
  construction (`verifyFails / acceptRate | 11 / 0.9141`, 2026-08-01 digest). The bank is now empty
  of cost-governance entries.
