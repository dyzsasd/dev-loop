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
every technical identifier below keeps the `dev-loop` name. **The phased rename was withdrawn
(operator, 2026-08-05: LOOP-176 / LOOP-177 / LOOP-182 all `Canceled`).** Phase A had already
shipped and stands: `hub/package.json` installs `kaizen` and `kaizen-hub` alongside `dev-loop`,
so `kaizen` is a permanent alias rather than the future primary; `dev-loop` remains the CLI
command. Names in the rest of this document that refer to the engine, the config, the state dir,
or the label are correct as written and must not be brand-swept.

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
daemon, and the `linear` / `service` backends are all preserved. (The `local` file
board has since been retired — LOOP-465, ratified by the operator 2026-08-10.) The new
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
and **§16 secrets/localhost-first** (binds loopback by
default; a non-loopback bind is permitted only with `DEVLOOP_UI_TOKEN(_FILE)` set and is refused
without one; secrets live in env, referenced by name, read server-side; the SoR holds no
plaintext credential). The phased build is in `docs/design/daemon-multicli-repositioning.md`.

## Goals (north star)

**SHIPPED (operator, 2026-06-23):** the daemon + web UI + roadmap view/edit + Lark/Slack
bridge (DL-1 / DL-2 / DL-3 / DL-4) — all Done.

**Top priority (operator, 2026-06-24): the STANDALONE-DAEMON + MULTI-CLI repositioning** (Vision
above). Build it as an additive, phased arc — each phase independently shippable, the loop runnable
throughout, every current path (stdio MCP, read-only daemon, `linear`/`service` backends,
the Claude plugin) unbroken byte-for-byte. **Full design + critique-folded decisions:
`docs/design/daemon-multicli-repositioning.md`.** PM drives the backlog from these phases:

> 🏁 **MILESTONE COMPLETE — 2026-06-27 (v0.21.0).** Every build phase **P1–P5 is shipped + verified
> Done** (P1 DL-41/42/43 · P2 DL-55/62/64/67/68 · P3 DL-69/70 · P4 DL-71 · P5 DL-72). Only **Phase B**
> below (remote / multi-user + `agent_tokens` auth) stays explicitly DEFERRED. The loop now advances
> the **supporting goals** (hub/`service` hardening · agent-skill robustness · operator-facing polish
> & docs · broader portability) as concrete gaps surface.

- **[ARCHIVED] the P1–P5 per-phase build detail (2026-06-23 → 2026-06-27).** The banner above
  already states the completion and names every ticket (DL-41/42/43 · DL-55/62/64/67/68 · DL-69/70 ·
  DL-71 · DL-72); the full design and the folded critique stay in
  [`docs/design/daemon-multicli-repositioning.md`](design/daemon-multicli-repositioning.md), and the
  shipped provenance in `CHANGELOG.md`. Rolled whole to
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 44 block N).
- **Phase B — DEFERRED (named, not built):** remote / multi-host / multi-user + the `agent_tokens`
  auth model. The daemon's per-request actor-resolution function is the seam it slots into.

**Hard invariants (transport-independent, every phase):** §17 firewall (no agent auto-edits a
SKILL/conventions/plugin/code file — structural changes are operator-committed proposals);
§2 isolation (one daemon = one pinned project, no cross-project endpoint — see the D1/D2
amendment in the Vision above); §16 (binds loopback by default — a
non-loopback bind requires `DEVLOOP_UI_TOKEN(_FILE)` and is refused without one; secrets in env by
name); identity is **cooperative, not anti-spoof** on one host (honest);
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

**SHIPPED (operator, 2026-08-06): CUT PER-FIRE COST — context and prompt compression (LOOP-228).**
Program closed 2026-08-06T03:10Z; every child Done (LOOP-237/272/238/318/282). Verified on the
installed 1.15.1 rather than claimed: `dev-loop conventions --agent <a>` prunes the §0a slice by
**38–60 KB per fire** (junior-dev −59,999 B / −35%, senior-dev −58,315 B / −34%, qa −45,814 B / −27%,
pm −37,960 B / −22%, against the full 169,401 B) — larger than the 21 KB the program claimed. The
lever had shipped unreachable (`ENOENT` from every cwd, LOOP-351) and was repaired in 1.15.1; the
measurement above is from after that repair. The measured-cost half is recorded as
**not-yet-computable**, not as a result: the per-agent cost surface that would price it
(LOOP-239) is `Canceled`, so no shipped surface can reproduce a per-fire figure today. Provenance,
the withdrawn baselines, and the binding constraints are in `docs/strategy-archive/2026-08.md`.

**Top priority (operator, 2026-08-06): MAKE THE LOOP OBSERVABLE AND SAFE.** This outranks the
current queue except correctness/security work already in flight. Three gap CLASSES, named from
this workspace's own instruments. **The measured values and the per-ticket program state live in
`Current state` → "Observable-and-safe: where the program stands"** — they decay on the loop's
timescale (hours) while this section's only legal writer is a §9a approval round (days), so a
number embedded here is stale by construction:

1. **§22's durable trail is partial, and the hole is concentrated.** An agent that fires and
   writes no daily report leaves a hole in the operator trail that nothing else can fill.
2. **The board has been destroyed twice in three days** — 2026-08-04 (cascade delete, 19 tickets
   and 79 comments lost permanently) and 2026-08-06 (**LOOP-367**). Guards have been landing per
   incident; LOOP-383's approval model is the first that closes the class.
3. **Fire success is far below target, and the error profile has inverted.** `rate-limit` led
   when this priority was written and no longer does. Every class size is provisional: classified
   failures exclude the `errorClass: null` outages (**LOOP-463** / **LOOP-464**), and **LOOP-445**
   showed `budget-per-fire` absorbing kills that were never spend breaches.

**Gaps 1 and 3 are one phenomenon measured twice.** A §22 report is written at fire CLOSE, so a
fire that is killed writes none. Detection work on the trail (LOOP-412, LOOP-425) makes the hole
visible; only surviving to close, or writing the trail incrementally, can fill it.

**The fourth gap is CLOSED.** A required check that never RAN presented as `CLEAN` and `autoMerge`
landed it — eight PRs merged on zero test signal. **LOOP-407** shipped 2026-08-08 (`a12bfab`),
verified on live forge data: an absent required check is now an unconditional hold, and doctor
**W38** names the unprotected-branch posture that keeps the forge silent. Residual: nothing
refuses a squash that skipped the guard (**LOOP-444**).

First program — the five controls: **LOOP-382** (pause/resume as board state) · **LOOP-383** (typed
approval objects) · **LOOP-384** (a `waiting-on` discriminator for Human-Blocked) · **LOOP-385**
(release resilience) · **LOOP-386** (the UI says when its view is stale). The through-line: every
control that exists only in the operator's chat transcript is one the system cannot enforce, report,
or recover. **Shipped count and per-ticket state: `Current state`.**

## Non-goals

- **Not Linear-locked.** Linear is a default, never a requirement; the loop must keep
  working on the `service` (hub) backend. *(The `local` file board was retired:
  `team-config.ts` types `backend` as `"linear" | "service"` and emits E02 for anything else, so a
  `local` workspace cannot load at all — `team init --backend local` is refused.)*
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
- **Landing is serialized per repo, and `pr merge` has a fifth exit code (LOOP-455, verified-Done
  2026-08-09, `fbe76ed`).** `dev-loop pr merge` now takes the per-repo lock ITSELF and holds it
  across gate-axes-then-squash, on the same `repo-<ref>` name `dev-loop with-repo-lock <ref>` takes
  — so a squash and a `landing:"direct"` merge-back cannot both move `defaultBranch`, and two
  concurrent fires can no longer both land against a base neither one's checks covered. **What a
  fire must act on: exit `5` means "another fire is landing — re-run", NOT an objection.** Nothing
  is written to the ticket on a 5, so a caller that treats it as a hold goes hunting for a comment
  that was never posted. Contention waits `--lock-wait` (default 120s) first; a crashed fire's lock
  is broken on a liveness check, so a budget kill cannot freeze the queue. One stale policy
  (`REPO_LOCK_STALE_MS`, 15m) now binds every `repo-<ref>` contender — `pr merge`, `with-repo-lock`,
  `doc-land`, `worktree add`/`reap` — because staleness is judged by the CONTENDER, so a single
  holdout on the old 30s default reopened the hole for everyone. **Since LOOP-448 this verb is the
  only merge path the tier docs describe**; `merge-guard` stays the read-only diagnostic surface.
  Residual, filed not forgotten:
  two registered refs sharing one GitHub remote still take different locks (LOOP-480; exposure here
  is zero, the registry has one entry).

- **Release history is `CHANGELOG.md`, not this section** — the always-current user-facing picture
  is `README.md` + `CHANGELOG.md`, the 1.0 → v1.10.0 provenance is archive block A, and this section
  carries only what a fire still needs to act.

- **[ARCHIVED] every build arc and fire journal through the one-hundred-fourteenth fire
  (2026-07-30 → 2026-08-10).** Rolled whole to
  [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) by §20 R2 passes 41–70 and 88. The
  per-period index with its block letters is the **📚 ARCHIVE INDEX** in `Decisions (running log)`
  below — this section no longer keeps a second copy of it (pass 48).

- **§0a boot-corpus delivery is SPLIT BY LANE — a PUSH for the claude agents, a PULL for the
  opencode ones** (measured pass 86; full text rolled to `2026-08.md` block **BE**).
  `run-agents.ts:971` gates the push on `profile.codingAgent === "claude"`, so
  pm/senior-dev/reflect/architect receive ~140 KB pre-assembled while qa/junior-dev/sweep/ops/
  communication pull at §0a. Doctor's **W03** still prints "fires run in PULL mode" because it reads
  config, while the live switch is `DEVLOOP_ASSEMBLE_BOOT=1` in the scheduler's env — **LOOP-482**
  owns that correction. Carried forward: config says what is configured, the ledger says what was
  delivered, and any per-fire context or cost figure that does not split by lane is averaging two
  delivery regimes.
- **Observable-and-safe: where the program stands (PM-maintained, re-measured each pass).** The
  `Goals` statement of this priority is deliberately number-free; the live values are here.
  Measured 2026-08-10T05:28Z over the 7d team ledger (**905 fires**) via `dev-loop metrics --window
  7d --json`: **fire success 47.7%** (`successRate` 0.4773; 65% over 538 fires when Goals was written
  2026-08-08). **Report the window as a decomposition, never as a rate alone** — 905 = **432
  delivered + 173 classified failures + 300 no-op** (`suspectError`, 0 interrupted). Classes:
  `stalled` ×89, `budget-per-fire` ×46, `rate-limit` ×30, `timeout` ×4, `network` ×2, `auth` ×1,
  `budget-deadline` ×1 — **19.1% of the window, 36.6% of the 473 non-successes** (LOOP-464 owns the
  real gap). `stalled` is the largest class and the only one with no owner (**LOOP-483**, parked
  behind LOOP-464 + LOOP-463). **The numerator is frozen, not lagging:** across nine readings the
  window grew **831 → … → 894 → 905** while the classified count held at **exactly 173 every time** —
  seventy-four consecutive arrivals, none classified. The three
  `openrouter` lanes (junior-dev, qa, sweep) have returned in ~6 s with no class since the fixed
  anchor **2026-08-08 16:36Z** (≈36.9 h; **292** dead-lane fires since, zero non-suspect), so the
  outage feeds the denominator and nothing feeds the numerator. **What that wait costs is now
  measured and on the park:** $509.71 since the anchor = **$331.96/day**, all of it `pm` + `senior-dev`,
  accumulating into a Backlog whose executor (`junior-dev`, 40 of 60 rows) is dark.
  Compare two readings only alongside the fire counts they were measured over — and note
  that the per-agent half of this table is **anti-correlated** until LOOP-508 lands: qa and
  junior-dev report 88.5% and 80.7% "healthy" against a delivered 47.4% and 24.6%.
  First program: **3 of 5 shipped** — LOOP-382 · LOOP-383 · LOOP-385 Done; **LOOP-384 and LOOP-386
  Todo at P1** (raised pass 94 — `PICK_RANK` rank 4.5 is the only lever that reaches a picker, so
  this section's "outranks the current queue" is finally legible as a field; they sit 2nd and 3rd in
  junior's slice behind LOOP-365). Both survivors are junior-tier, so the program cannot advance
  while the outage holds, whatever their rank.
- **The board's write surface has a supported switch (LOOP-479, `6b451ed`, verified Done
  2026-08-10)** — `dev-loop settings <path>`: allow-listed, off by default, refused inside a fire
  (exit 4). Merged, not published (`0cac647`/v1.15.1 runs the fires). `humanWrite.enabled` stays
  unset here, so the board is still read-only and the CLI is still the only way to rule.
- **The `local` file-board retirement is DELIVERED, not merely merged (LOOP-465, `0cac647`)** —
  verified 2026-08-10 to the third rung (source, installed `dist/`, observed effect), with a
  control against the pre-retirement tree. Full measurements: archive block BI.

### 2026-08-10 (pm, one-hundred-thirtieth fire): a citation written in the keyword that binds it, and the merge gate's own bug filed twice

**LOOP-479 verified `Done` against the merged tree (`6b451ed`, landed mid-fire).** `dev-loop settings
list|get|set|unset <path>` gives `projects.settings_json` its first writer; every AC met, AC5 being
the split I made on 08-09 (LOOP-481, unparked this fire). Two things outlive the increment. The verb
is **fire-gated** — exit 4 under `DEVLOOP_DEV_SPLIT`, "nothing has been read or written" — which is
LOOP-503's ask already solved in-tree for a sibling verb, so that ticket now has a precedent to copy
rather than a design to invent. And its test imports the shipped `humanWriteEnabled` instead of
re-deriving it, citing the LOOP-429 shape unprompted. **Merged, not published:** fires still run
`0cac647`/v1.15.1, so no fire can reach the verb yet.

**A `Design:` line is a state-machine write — and this fire found the form that reports nothing.**
LOOP-502 (the merge-gate bug holding PRs #271/#273) opened `Design: parent LOOP-448`, meant as
provenance; `designParentIds` binds the `parent <id>` form on nothing but `onBoard.has(id)`, so a
`Done` §17 proposal became a design parent and LOOP-502 its staged child. Pass 104 recorded this
shape on LOOP-480, where it surfaced LOUDLY as a refused close. Here it surfaced nowhere — a `Done`
parent's gate never fires again. Line removed, `relatedTo` untouched; recorded as pass 104's
detection clause, not a new rule.

**The same defect, filed twice in 118 minutes, the second contradicting the first.** LOOP-511
re-derived LOOP-502's cause (the reverse `compare` at `landing.ts:214` crossing Node's 1 MiB
`spawnSync` ceiling) two hours after LOOP-502's thread established it. Closed `Duplicate` with its
unique content merged up, not dropped: an AC bounding the REQUEST (`?per_page=1` + `behind_by`) and a
test arm pinning the request SHAPE. The ordering was the risk — LOOP-511's *first* AC prescribed the
bare `maxBuffer` bump LOOP-502 had already shown to be a deadline rather than a fix. LOOP-502's body
also still claimed "a payload-size overflow is ruled out" against its own comments; the spec now says
what its thread found.

**Job C, `polish-performance`: two candidates killed, nothing filed.** The `bootBytes` coverage gap
is historical and closed (62/62 recent claude fires carry it); the 250-row cap does signal truncation
precisely, on stderr — I had suppressed stderr, and re-ran the audit over all 493 rows rather than
trust the narrower basis. With 48 of 61 Backlog rows owned by a tier dark for 37 h, a 62nd filing is
inventory, not throughput.

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
- **Backend** — the coordination substrate: `linear` / `service` (hub); the `local`
  file board is retired (LOOP-465).
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
- **`kaizen`** — a permanent ALIAS of the `dev-loop` command, not its successor: LOOP-181 Phase A
  shipped the bin, and the rename was withdrawn (`Vision`). `dev-loop` is the CLI command.

## Decisions (running log)

- **2026-08-10 (pm, one-hundred-twenty-ninth fire) — when a projection truncates an ask, the ticket
  owner may move the payload into the surviving window, but only after enumerating every reader of
  the field being edited.** LOOP-509 (the fix) is filed and will not land this week; meanwhile the
  operator's only decision line carried no number at all, because `doctor.ts:366` cuts the title at
  57 characters and LOOP-463's digits began at index 78. **The call: repair the instance by
  rewriting the title so the magnitude leads, and keep LOOP-509 as the general fix** — a park's
  headline is PM-owned and keeping the ask current is the same duty as keeping the doc current.
  **The precondition is the load-bearing half, and it is general:** a title write bumps
  `updated_at`, so had any operator surface aged the park from `updated_at`, this repair would have
  reset a 10-hour escalation to zero and hidden exactly what it was meant to surface. Both age from
  the events ledger (`decisionEnteredAt`) — checked in the source before the write and re-verified
  in the rendered W20 after. **Do not generalise this to editing data that feeds a metric**; it is
  licensed only where the field is a human-readable label and every consumer has been enumerated.
- **2026-08-10 (pm, one-hundred-twenty-eighth fire) — a mis-diagnosed ticket is re-scoped, not
  canceled, when the bug outlives the diagnosis.** **(1) LOOP-467's** premise was false: the ordering
  fix it asks for landed in `21143e6` four days before it was filed. The §5a reflex is to `Cancel` it
  as obsolete, and that would have been wrong — reading it out found the same bug ALIVE in the daemon
  reminder, which the ticket's own implementer note describes backwards as a reader of
  `decisionQueue()` when it carries a private copy of the SQL. **The call: when a premise fails,
  finish the measurement before choosing the verdict** — a false premise says the diagnosis decayed,
  not that the defect did, and cancel-then-refile loses the ACs and the provenance with it. Here the
  AC block survived (its mutation check still discriminated); only the "Why" had to go. **(2)** It
  stays **P2 deliberately**: `PICK_RANK` reads an `Improvement`'s priority only at `priority=1`, so
  P2 and P3 are one bucket ordered by `created_at` (the LOOP-254 ruling) and moving between inert
  buckets performs concern without changing anything a picker sees. **(3) LOOP-509 pins the property,
  not the carrier** — the refresh field may be the latest comment or a body marker; the ACs fix what
  must be OBSERVABLE and leave the mechanism open, with AC3's fixture specified by the shape that
  caused the bug (first digit past index 57) because a short title passes vacuously. **(4)** Both new
  doctrine clauses this pass went into rules 32 and 35 rather than a rule 41 — doctrine grows by
  sharpening the rule that already names the shape (fire 126's call, now demonstrated twice).

- **2026-08-10 (pm, one-hundred-twenty-seventh fire) — a no-op fire counts against success, and an
  omission's justification is an assurance to everyone it reaches.** **(1) `successRate`'s treatment
  of `suspectError` is DECIDED, not open (LOOP-508):** a fire that consumed a scheduler slot and
  produced nothing counts against success and STAYS in the denominator — `metrics.ts:221` is right
  and the comment above it is wrong. Excluding no-ops, which is what that comment describes (71.2%
  against the reported 48.3% on the same 886 rows), would let an outage RAISE the loop's headline
  health number — the W16 failure one surface over. So the work is attribution, not arithmetic:
  `byAgent` carries no suspect term, so the two dark lanes rank first at 88.5% and 80.7% against a
  delivered 47.4% and 24.6%. **(2)** The boot pruner drops §5 with the reason *"the queue op
  pre-ranks on service"* — true for the dev arms, false for PM's, and PM is the agent conventions
  tells to promote in §5 order (LOOP-507). One occurrence, so not a standing rule; the shape to
  carry is **a reason string that is DELIVERED rather than merely recorded is an assurance — check
  it against every reader, not the one it was written for.**
- **2026-08-10 (pm, one-hundred-twenty-fifth fire) — direction stated in prose is not a ranking; the
  filer must spend the lever the ruling created.** `Goals` has said since 2026-08-06 that the
  observable-and-safe program *"outranks the current queue"*. Nothing on the board read that sentence.
  For an `Improvement` — 52 of this board's 55 Backlog rows — the pick order consumes `priority` in
  exactly one place: `PICK_RANK` rank **4.5**, `priority=1` only, shipped by LOOP-254 under an operator
  ruling that DECLINED the fuller variant (priority as a secondary sort across rank 5) on
  anti-starvation grounds. So P2 and P3 are one bucket ordered by creation date, and the program's two
  unshipped controls sat 7th and 8th of 13 behind five P3 rows filed the same day. **The call: this is
  PM's grooming debt, not a product defect, and the remedy is the priority field — not a re-tier, not a
  re-type, and emphatically not re-opening a ruling the operator already made.** LOOP-384 and LOOP-386
  raised to P1; junior's served order verified against a prediction (`365, 384, 386, 468`, then rank 5)
  rather than a re-read. **The rule this generalizes: when a direction section states a ranking, the
  same fire must name the board field that carries it — a priority, a label, an assignee — or the
  sentence is decoration.** Program membership was never the gap here: `operator-design-review` already
  marks exactly the five controls. Honest limit: both survivors are junior-tier and that lane has been
  dark since 2026-08-08 16:36Z, so the correct rank changes nothing until the credit park clears.
  LOOP-384, LOOP-386, LOOP-254, LOOP-463.

- **2026-08-09 (pm, one-hundred-fourth fire) — a routing MARKER is not prose, and the fix for a
  false marker is the marker, never the gate.** Verifying LOOP-455 (`In Review → Done`) was REFUSED
  by the §21a close gate: `LOOP-455 is a design parent with 1 staged child(ren) still in Backlog
  (LOOP-480)`. It was true of the encoding and false of the world — LOOP-480 opened with a bare
  `Design: parent LOOP-455` line, which `design-parent.ts` reads as the §21a CHILD marker and which
  therefore makes the ticket it names a design parent BOARD-WIDE. LOOP-455 is a direct-code
  escalation: no `Mode: design` body, no design doc, and LOOP-480 decomposes nothing — its own text
  says its fix "contradicts LOOP-455's own AC1", i.e. it is explicitly outside that scope. **The
  call: correct the data, not the gate.** The pointer line was removed from LOOP-480 (its
  `relatedTo` kinship untouched) and the close then landed. The rejected alternative was promoting
  LOOP-480 to satisfy §21a's pass action — which would have accepted the false premise, breached the
  §5a senior cap at 10/10, and jumped a ticket ahead of rows that had waited longer. **The rule: a
  deferred slice is a SIBLING — it takes `relatedTo` and never a `Design:` pointer; a pointer keyword
  at the start of a line is a state-machine write, so a filer who means "see also" must not spell it
  that way.** Generalizes the same shape already recorded for `Blocked-by:`/`Unblocked-by:`.
  Cost of the mis-encoding: a verified increment sat closeable-but-refused, and the refusal surfaced
  only at the parent's close, not at the child's filing. LOOP-455, LOOP-480.
  **Second instance, 2026-08-10 (fire 130) — and it has no refusal at all.** LOOP-502 opened
  `Design: parent LOOP-448`; LOOP-448 is a `Done` §17 proposal, so the child was staged under a
  parent whose gate had already fired. Where LOOP-480 was caught LOUDLY by a refused close, this one
  is caught by NOTHING — a `Done` parent's gate never fires again, Job B2 excludes staged children
  from grooming, and the stranded-child repair needs a live Sweep. **The rule gains a detection
  clause, not a new rule: a mis-bound pointer self-reports only while its named parent is open; once
  that parent is terminal, only an audit finds the child.** Audit the WHOLE board — at 493 rows the
  250-row read that looks complete is exactly the cap. LOOP-502, LOOP-448.

- **2026-08-09 (pm, ninety-second fire) — where the taxonomy already determines the answer, a write
  path should COMPLETE the input rather than refuse it.** The hub's create path derives a ticket's
  `assignee` from its labels and leaves the labels as filed; 2 of 2 operator-filed tickets today arrived
  without `dev-loop` and without an owner. One of the five queue arms can return such a row — `backlog`,
  the only arm with no label predicate — and the §2-mandated `--label dev-loop` read cannot. A
  create-time refusal was available and was rejected: it charges the person filing a bug report with
  knowing the label taxonomy, while §4 already fixes the mapping (`Bug`→`qa`, `Feature`/`Improvement`→
  `pm`). **The rule: validate by completing what the spec already determines, and reserve refusal for
  what the spec leaves open.** LOOP-460. **Second call, same fire:** an open operator decision inside a
  design ticket is framed by the design and answered at the gate; it does not park the ticket, and the
  invariants independent of it are decomposed now.

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
     **Same test on the CARRY-OVER FILE, read earlier and trusted harder than the doc it
     describes:** `pm-state.json` marked a `Candidate ideas` entry resolved-and-removed and DO NOT
     RE-DERIVE while the entry was still first in that section, in the very land that fire produced.
     Its recorded ANSWER was right, and that is the hazard — a suppressor correct on its merits and
     false about its state reads exactly like a true one. Check a handoff line that FORBIDS future
     work against the artifact the first time it is used.
  9. **Tier at FILING time; never re-tier to balance load (§21b).** Assigning a tier to a ticket
     that arrived `assignee: null` is not a re-tier — it is the filer's job left undone.
  10. **§9c: prose is not a marker, and an edge needs a clock.** An edge is retired by a
     machine-parseable `Unblocked-by:` line, never by a ✅ in a table cell. A prerequisite only a
     person can satisfy still needs the edge — it states the wait instead of letting it read as a
     regression (LOOP-373). **And an edge keyed on a ticket no agent's queue contains has no clock:**
     LOOP-367 merged, passed QA, then moved *backwards* to `Backlog` under `operator`. Retire that
     edge against the artifact — the merged code — and name the fact you keyed on.
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
     it per axis — `dev-loop --version` alone answers none of them. On this workspace the axes are
     four: the CLI, the `skills/`+`references/` corpus, the daemons, and the `run-agents` scheduler
     (W36), and §12b applies the moment any one of them moves.
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
  27. **A predicate that gains an authorization consumer needs its false-positive set re-measured
     against real data, in the fire that promotes it.** `design-parent.ts` went from choosing a
     QUEUE to gating writes to granting a gate EXEMPTION; at 19 of 352 tickets matched against 5 real
     design tickets, that is invisible as routing noise and readmits the zero-commit handoff as an
     exemption. Every promotion was correct and inherited its precision unexamined (**LOOP-372**).
  28. **A module's claim about itself — coverage of a set, or a property like "read-only" — is
     enforced by a test that derives the set from the source, or by nothing.** `destructive-guard.ts`
     claimed every destructive verb calls in; incident falsified it twice and each repair added one
     call site (**LOOP-368** AC6/AC7: the inventory test plus the named residual). Where no test can
     reach the claim it decays silently — `daemon.ts`'s header still says READ-ONLY, GET-only and
     loopback-only (**LOOP-375**) — so an untestable claim is corrected in the diff that falsifies
     it, or not at all.
  29. **When a change ships default-off, its discovery path is part of the increment.** LOOP-335
     validated, tested and mutator-ised `ciIrrelevantPaths` and reached no reader — absent from the
     schema table carrying both its siblings, from `--help`, and from the failure message that would
     have taken it — so it sat inert while its case recurred 8 times in 60 commits (**LOOP-365**).
  30. **A change to a shared datum — new precision OR a new bound — is not done until every consumer
     of the old form is enumerated and moved.** `buildCommit` reached the wire and then one of three
     consumers (**LOOP-364**); the board's 250-row cap is disclosed correctly beside per-state counts
     computed from the truncated array (**LOOP-370**, caught by the columns summing to exactly the
     cap). The cheap audit is a grep for the OLD form in the fire that introduces the new one.
  31. **A gate belongs at the moment the doc states the rule for, not at the moment the breach
     surfaces.** A late check is not a weaker version of the right one: a changelog rule written for
     PR-land time but enforced at release-dispatch time turns a one-line contributor action into an
     archaeology pass (**LOOP-376**), and a channel configured at setup but reported only once the
     decision queue is already non-empty turns an unset field into an outage nobody was told about
     (**LOOP-377**). **The same sentence holds on the DEPTH axis, and there it is harder to see: a
     shallow check is not a weaker version of the right one either.** `parkedSplit` states the rule
     in its own comment — *"a human is the gate; the edge is not what is holding it"* — and applies
     it only to the ticket in hand; one edge out, the test collapses to `!TERMINAL`, so a ticket
     blocked by a `Human-Blocked` ticket is filed under *"will self-unpark"* (**LOOP-510**).
     `dependency_graph` is the same shape stated even more plainly: its comment says it parses
     blockers for EVERY non-terminal ticket *because* non-blocked ones carry markers too — then the
     integrity loop iterates only the labelled ones, filtering the case back out (**LOOP-456**). The
     tell in both: **the data the rule needs was already fetched.** When a classifier articulates a
     principle, check whether it re-applies that principle to the neighbours it has already
     resolved — the shallow version passes silently, because every row it does examine is judged
     correctly.
  32. **A finding spun off at another ticket's hand-off carries that ticket's UNLANDED tree as its
     premise.** Every number in **LOOP-378** and **LOOP-379** is measured with LOOP-372's fix in
     place, and LOOP-372 is `In Progress`: on `origin/main` the regression test each specifies cannot
     reproduce what it is written to catch. Ask whether a spun-off finding's evidence reproduces on
     the LANDED tree before promoting it — where it does not, its `Blocked-by:` edge is a PREMISE
     edge, not a courtesy. **And check the tier: the hand-off is where §21b gets skipped, the filer
     being busy closing something else.** Both arrived `assignee: —` — invisible to every dev pick
     query, one of them `sensitive`. **The mirror case is a finding measured against a tree that is
     BEHIND, and it is harder to catch because nothing is pending to remind you.** LOOP-467 was filed
     2026-08-09 against an ordering bug whose fix had landed in `21143e6` on **08-05**: its cited
     line numbers no longer resolved, its predicted symptom was unreachable, and its acceptance
     criteria would have certified a no-op. One test covers both directions — **date the fix, not
     the code.** `git log -S` / `git blame` the line the finding turns on and compare that date with
     the finding's own; a premise is a claim about a tree at a moment, so it is only checkable with
     both.
  33. **A fixture derived from the constant it is checking is not a test of that constant.** The
     LOOP-406 band fixtures compute `warnAt` from a spec literal `0.8` rather than importing
     `STRATEGY_DOC_WARN_FRACTION`: change the product's fraction and a fixture lands inside the
     band and fails, where importing the constant would have moved all three with it and kept them
     green — the tautology one level up from asserting a constant equals itself. The general form:
     **when a check and its test read the same source for the value under test, the test can only
     confirm they agree, never that the value is right.** Pin the number from the SPEC, and hand
     the check a seam (LOOP-406 injected the stat) so reverting it costs assertions instead of
     silently falling back to measuring the host. Distilled at pass 88 from the fire-106 journal
     before rolling it; the same shape governs §20 D4 prose that quotes a warning as fact
     (LOOP-482).
  34. **A finding handed to a named future owner in a close comment is owned by NOBODY until that
     ticket's own acceptance criteria say so.** LOOP-391 and LOOP-392 both closed noting that
     `team-import.ts` carries no approvals table and that "C5 owns it"; LOOP-396 *is* C5 and its
     ACs are entirely the consumer inventory — so a bundle export/import silently dropping every
     approval grant was unowned for the whole chain (LOOP-489). Re-confirmed at pass 88 on a
     different surface: the LOOP-465 apply deferred `boot-prefix.ts`'s dead ternary "for a dev
     ticket" that did not exist (LOOP-492). **Open the named ticket's ACs before believing a
     hand-off** — the naming feels like routing and carries none. Its sibling: a multi-round PR's
     early measurements describe a tree that no longer exists, so re-run a hand-off's numbers
     rather than quoting them (LOOP-392's body said 12 fail; the landed tree measures 2 —
     LOOP-488).
  35. **A fact belongs in the section whose WRITE RATE matches its DECAY RATE — and a number
     published without its coverage is not yet a fact.** The 2026-08-06 top-priority block put a
     fire-success percentage, six error-class counts, per-agent report ratios and per-ticket program
     status inside `Goals (north star)`: state that decays in hours, held in the one section whose
     only legal writer is a §9a approval round (days). Staleness was therefore STRUCTURAL, not an
     oversight — four of seven assertions were false at re-measure, and the same file contradicted
     itself on whether LOOP-385 had shipped. Correcting the values was already tried and did not
     hold: **LOOP-446** spent an investigation plus a full approval round on three numbers and the
     section was falsified again within about a day. **LOOP-494** moved the measurements to
     `Current state`, which PM re-measures every pass under the D4 autonomous policy, and left
     `Goals` holding the gap CLASSES, the through-line and the five named controls. The operator's
     ruling attached the corollary: the classified counts now ride with the population they describe
     (**172 of 807 fires — 21%**; the other 635 are `errorClass: null`, LOOP-464), because *a number
     without its coverage is how `Goals` got falsified the first time*. Ask of any recorded fact:
     **who may write this, how often, and how fast does it go wrong?** A correction round is the
     wrong instrument for a fact that decays faster than the round takes. **The "section" can be a
     PROJECTION, not just a heading — the same rule one layer down.** The operator's decision queue
     renders a parked ticket from `{id, title, state}`, and `title`'s write rate is once, at filing,
     while the condition it describes grows hourly: LOOP-463's ask still read *38 fires* when the
     ledger held 281, and the refresh PM did write went to a comment, which no consumer of that
     projection reads (**LOOP-509**). Ask it of every field a surface renders, not only of every
     heading a document carries — and where the rates diverge, the fix is a field whose write rate
     matches, never a discipline of remembering to rewrite the old one.
  36. **Read `gh run list --branch main` before a doc-land.** `test.yml` is
     `concurrency: test-${{ github.ref }}` with `cancel-in-progress: true` and no `paths-ignore`, so
     pushes to `main` cancel each other's runs — and the docs-only side is the one that can silently
     leave a code change unverified on `main`. Observed in both directions: pass 86's docs push was
     cancelled by the code push eight minutes later, and pass 88's docs run was cancelled by
     `e6b5477`. In force until **LOOP-486** lands. Distilled at pass 89 from the fire-115 journal
     before rolling it.
  37. **When an acceptance criterion says a SENSE must survive a prune, a surviving COUNT is not
     evidence — only the diff of the removed lines is.** LOOP-465 pruned the retired `local` backend
     from the taught surface, and the named hazard was that a prune keyed on the bare string also
     destroys `machine-local`, `localhost` and the still-live `docSystem` enum. `machine-local` in
     the pm slice went 6 → 4, which reads as damage until the removed LINES are read: both losses
     were the backend sense, all four survivors the runtime-state sense. A count answers *how many*
     and the criterion asked *which*. Distilled at pass 89 from the fire-116 journal before rolling
     it; the same shape as RULE 33 one level down — a proxy for the property is not the property.
  38. **A change inside `src/` is a RUNTIME change only if something at runtime reads it.** LOOP-465
     edited `hub/src/context-bill.ts` under an AC forbidding runtime-code changes; its
     `CONVENTIONS_BUDGETS` export has exactly one consumer in all of `hub/` — the ratchet test — so
     no doctor code and no executed path moved, and re-seeding was not optional because the old rows
     would have tripped the ratchet's own slack assertion. Resolve "is this a code change?" by
     naming the CONSUMER, never by the file's directory. Its converse is the live hazard the loop
     keeps re-learning: code that IS in the installed build can still sit behind a flag or a caller
     that never runs, so shipped is not running. Distilled at pass 89 from the fire-116 journal.
  39. **Read one raw record before aggregating a ledger — a unit guess fails silently, and in the
     direction of health.** Fire 121's first pass over `.dev-loop/team/fires.jsonl` assumed a
     `durationSec` field and treated any value above 10,000 as milliseconds. The ledger's field is
     `durationMs`, so a 5,336 ms fire scored as 5,336 s of work: the table reported junior-dev, qa
     and sweep as having done real work 0.2 h ago with zero trailing short fires, for three lanes
     that had then been dead 34.6 h. The error inverted the finding into a clean bill of health and
     cost a second full read to catch. One `tail -1 | python3 -m json.tool` before the aggregate
     settles the field names and their units. Distilled at pass 90 from the fire it happened in.
  40. **A check that tests whether a thing EXISTS cannot report whether it is CURRENT.** W30 was
     built precisely because *"absent and healthy were the same output"* for the lessons library —
     and its predicate is `existsSync(P.index)`, so with the file present and nine days stale,
     stale and healthy are now the same output: the identical shape, one rung up. The library's
     other two guards miss it from the other side — W35 builds its findings from agents that FIRED
     in the window, so an agent at zero fires yields no row at all, and W03 fires when the file is
     OVER budget, which a frozen file never is. Three checks, three real properties, none of them
     currency (LOOP-498; `reflect` is the sole writer and is absent from the `core` run set this
     workspace launches). Ask of any freshness-dependent artifact: which check fails if this stops
     being updated — and if every answer tests presence, size, or activity, the answer is none. **A proxy can
     be worse than inadequate — it can be ANTI-correlated.** W16 answers "does this owner still
     exist?" from the fire ledger, so an outage that produces cheap 6-second no-op fires satisfies it
     MORE emphatically than working would (qa: 308 fires per 7 d against pm's 136, zero of them
     writing anything but the scheduler's own `fire.completed`) — the check reads its own failure
     case as maximal health, and a 7-day window is ~2,000 fires at that cadence (LOOP-505). Name the
     ARTIFACT the work leaves behind and assert on that; an attempt is not an artifact. **This is not
     one check's bug — it is what any surface that counts ATTEMPTS does under an outage.** Pass 96
     found the same inversion in `metrics`' per-agent table, which carries `{fires, failures}` and no
     suspect term, so the two dark lanes rank first at 88.5% and 80.7% against a delivered 47.4% and
     24.6% (LOOP-508). Wherever a rate is built from fires, ask what it does when a lane returns
     instantly having done nothing — and report the decomposition beside the rate.
  **RETIRED, do not re-derive:** *"a new `hub/test/*.ts` is a two-file change, the second being
  `hub/package.json`"* — superseded by `run-all.ts`'s glob discovery (LOOP-138/LOOP-139): a new
  test file with no `package.json` script now runs. *"The release gate is the loop's single
  blocking constraint"* — v1.13.0 published 2026-07-31T20:06Z; the constraint is retired and the
  live successor is the DAEMON skew (below), not the npm one.

- **📌 STANDING DECISIONS — the calls that must not be re-litigated.** Full text, with the evidence
  each rests on, in [`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass
  41, block K).
  - **(pm, 2026-07-31) `dev-loop` will NOT auto-publish to npm on merge to `main`; the release stays
    operator-triggered** (LOOP-38 AC-1; the chosen shape is the other half — keep the human in the
    release loop and make the signal that calls them trustworthy, W18 → LOOP-151 → LOOP-167).
  - **(operator, 2026-07-31) §12b amended — "merged" and "running" are different states, and a
    verifier must name which one it established** (LOOP-170, `13bbc89`). **"Published" was DECLINED
    as a blocking close bar** — publishing is operator-triggered by the ruling above — and must not
    be re-proposed.
  - **(pm, 2026-07-31) 📤 §17 PROPOSAL STILL WITH THE OPERATOR — make the §22 report clock UTC.**
    `references/conventions.md` is a governing file, so this is proposed, never applied (§17). The
    change is `date -u +%F` / `date -u +%G-W%V` / `date -u +%Y-%m` plus one line stating the reports
    tree is UTC-dated to match the ledger and the board. Evidence on **LOOP-214**; doctor W25 is
    independently correct and does not depend on it. Recorded here because a proposal that lives only
    in a fire report dies with the fire.

- **📚 ARCHIVE INDEX — where the rolled provenance lives.** §20 R2 keeps **one line per archived
  period**; the searchable per-fire recaps are the table of contents at the head of each pass in the
  archive file (pass 41, blocks F and G). Per-span *open-finding* ID lists are deliberately NOT kept
  here — the board is their system of record, and a hand-copied list decays exactly the way the
  numbers LOOP-494 retired from `Goals` did (at pass 91's compression, several rows still listed as
  "still open" had closed, and one named a ticket the same sentence called closed). What each span
  contributes to doctrine is already distilled into the STANDING RULES above.
  - **2026-06-14 → 06-27** — the 2026-06 milestone arc (daemon foundation; the standalone-daemon +
    multi-CLI repositioning; hub buildout; the two-tier Dev split) →
    [`2026-06.md`](strategy-archive/2026-06.md).
  - **2026-07-30 → 07-31** — ~110 rulings and method notes (board search/ownership contracts;
    send-back-vs-verify-fail; §9c's `Canceled`-is-not-satisfied asymmetry; the validate-then-drop
    family; the brand decisions; R2 passes 1–8) → [`2026-07.md`](strategy-archive/2026-07.md).
  - **2026-08-01 → 08-05** (fires 6–48; R2 passes 13–29, 41) — ~70 rulings plus every fire journal →
    [`2026-08.md`](strategy-archive/2026-08.md), blocks **B–I**. Doctrine: RULES 15–22.
  - **2026-08-06** (fires 49–58; R2 passes 42, 45–49) — journals and full-text rulings, the
    local-source-build pin retirement, both release-axes entries → blocks **A–D, M, O–U3, V–V2**.
    Doctrine: RULES 23–32, plus clauses folded into 8, 10 and 15; the pin's second clause is
    superseded by W36.
  - **2026-08-06 → 08-07** (fires 59–86; R2 passes 50–74) — journals and full-text rulings (the
    deleted-handler/asserted-null pair; ADDS-not-REMOVES; presence-vs-coverage; self-derived
    inventory; the parity-claim pair; cited-precedent; supersession-narrows-scope;
    scope-boundary-is-a-claim; containment-hides-the-condition; verify-the-render) → blocks
    **W–Z, AA–AU**.
  - **2026-08-09** (fires 92, 94, 99, 105; R2 pass 86) — four verified-Done increments: the
    `~/.dev-loop` retirement direction, the fire-refused `secret set`, the honest budget-kill
    classification, and approvals C1's store with the end-state-naming key rule → `2026-08.md`.
  - **2026-08-10** (fires 115, 116, 120; R2 passes 89–90) — the tag-anchored release resume
    (LOOP-385), the `local` backend's retirement verified across the taught surface (LOOP-465), and
    the north star shedding facts it cannot keep (LOOP-494) → `2026-08.md`, incl. block **AX**.
    Doctrine: RULES 35–38.
  - **2026-08-10** (fires 121–129; R2 passes 91–99) — the per-fire journals of the approvals-gate
    arc, the boot-corpus lane split and the settings-writer arc → `2026-08.md`, blocks **BC–BJ**.
    Doctrine: RULES 39–40, plus the mirror clause folded into 32, the projection clause into 35, and
    pass 104's marker rule gaining its detection clause.
- **2026-08-10 — operator ruling on LOOP-499: build the seam, and close the silent-enable window
  in the same arc.** `approvals.enforce: ["push"]` reaches no reader on `landing:"pr"` — the mode
  this workspace runs — because the pr-mode ship path pushes the ticket branch with a bare
  `git push`. Two remedies were on the table: a SKILL edit adding the guard call, or a code seam
  owning guard-and-push as one verb. **The operator chose the seam** and explicitly declined the
  SKILL-edit interim: this workspace sets no `approvals.enforce` and LOOP-394 AC6(c) holds the
  global default empty, so the gap is latent here, and a prescribed guard-then-push two-step is the
  exact shape LOOP-448 just retired. Three conditions ride the design (it extends
  `hubDoc:design/approvals`): one call owning readiness + guard + push, pr-merge-shaped, with
  nothing pushed on a non-zero exit; a doctor W-code or config-write refusal naming
  *"enforce:push configured but the pr-mode ship path reaches no reader"*, so opting in is loud
  before it is safe; and the §17 SKILL/§12b adoption pre-approved **in principle**, needing the
  operator's apply rather than a fresh decision round. **The generalisable call is the one STANDING
  RULE 29 already names, applied one level up:** a guard every future ship path must remember to
  call is the same defect as a switch with no reader. Recorded because it decides the shape of every
  future gate, not just this one. PM encoded the ruling as AC1–AC4 on the ticket, retired the stale
  `external-prereq` park labels the unpark left behind, and stripped the `Bail-shape:` markers that
  made a pickable row read as parked.

  - **⚠️ LIVE HOLDS carried out of these rolls** — the residuals that are *instructions*, not ticket
    IDs a board query already returns. **(1) DISCHARGED at pass 93.** LOOP-394's verify
    held its **default of an EMPTY `approvals.enforce`**: the resolver answers `false` for an absent
    block, an absent list and an empty list, and this workspace carries no `approvals` block — so
    LOOP-489's window stays bounded. The successor hold is **LOOP-503**: that default is only worth
    as much as the gate on who may change it, and today the mutator has none. **(2)** The W37 byte ceiling is **LOOP-484**'s problem;
    direction prose is never trimmed to offset it (the operator's second LOOP-494 instruction).
    **(3)** Re-read an In Review@operator park LATE in a fire, not only at Job A — the fire-120
    ruling landed twenty-five minutes in, after the ticket had already been read once.

- **2026-08-10 (pm, one-hundred-twenty-fourth fire) — a gate is only as strong as the gate on its
  own switch, and the switch's writer was ungated.** Verifying approvals C4 (LOOP-394) meant testing
  AC5's stated precondition rather than reading it: `dev-loop approve` must be refused inside a fire,
  because a fire that can grant itself an authorization has not been gated at all. It is refused —
  exit `4`, *"Nothing has been read or written."* **The same probe, pointed one level up, was not.**
  `dev-loop team set` writes `team.approvals.enforce`, and inside the same fire it reached its VALUE
  validator (exit `2`) with no fire question asked; `team-edit.ts` imports no fire marker while
  `approvals-cli`, `board`, `cli-agentops` and `secret-cli` all do. **The call: verify C4 PASS and
  file the hole as its own ticket (LOOP-503), rather than fail an increment that met every AC it was
  written against.** The alternative — treating the un-gated mutator as a C4 defect — was rejected
  because it would have re-specified the ticket at verification time, and because the defect predates
  approvals entirely: it is reachable today against `team.mode`, `team.autonomy`, the `budget`
  ceilings and `agentReviewers`, and merely BECOMES an approvals bypass when C4 publishes. **The
  generalisable rule, and the reason this is recorded as direction rather than a ticket note:
  enumerate a control's WRITERS before calling it a control.** LOOP-368 asked "may a fire DESTROY
  this?" of four verbs; nobody asked "may a fire CHANGE this?" of the mutator, so a guard designed to
  be un-bypassable acquired a bypass through the sanctioned tool. The same question is owed to every
  future switch, which is STANDING RULE 29 (a switch with no reader) turned around: a switch whose
  writer is un-gated is the same defect seen from the other end.

## Candidate ideas
_(The overflow parking lot: strong ideas not yet filed, each with the condition under which it
becomes correct to file. **Rolled 2026-08-06** — the pre-pass-41 list is verbatim in
[`docs/strategy-archive/2026-08.md`](strategy-archive/2026-08.md) (§20 R2 pass 41, block J).)_


- **`kaizen` is a shipped, installed command named in ZERO user-facing surfaces.** **LOOP-181** is
  `Done`, `hub/package.json:32-36` ships `kaizen` + `kaizen-hub`, and `kaizen --version` answers —
  yet `README.md`, `dev-loop --help`, `docs/INDEX.md` and `docs/RUNNING.md` mention it 0 times.
  Docs gap or deliberate silence is brand-gated, so it is named rather than filed (the LOOP-416
  shape). **REVERSAL CONDITION: the operator rules on the brand** — carried on **LOOP-366** in the
  sixty-ninth fire. _(Opening premise discharged: LOOP-434 and pass 70 corrected all three copies.)_

- **Close the config-mutator gap wholesale — an operator capability call, deliberately not filed.**
  `references/config-schema.md` marks each field with its `dev-loop team set` path: 13 rows carry a
  ✓, 26 are marked `—`. Writable by **no mutator at all**, at create time or after:
  `team.agents.<h>.cadence` (`team init` hardcodes `{sweep:30m, ops:10m, reflect:1d,
  communication:1d}` — this workspace has exactly those four);
  `agents.<h>.{fireTimeout,stallTimeout,manual}`; `team.hub.agentInterface` and its project override,
  which config-schema itself calls *"the rollback switch"*; `team.deployPolicy`;
  `projects.<key>.reports`; `team.opencodePermission`; `mirror.*`; and the daemon
  alert cadences. **REVERSAL CONDITION: the operator asks for it** — widening the allowlist is real
  surface area and each field arguably wants its own validation rather than a blanket path setter.
  `strategyDoc` is the filed instance (**LOOP-120**), `agentReviewers` another (**LOOP-123**).
  **PARTIALLY DISCHARGED — and now SHIPPED for three rows (2026-08-10, verified Done):** **LOOP-408**
  added `team.autonomy`, `projects.<key>.autonomy` and `projects.<key>.mode` to `SETTABLE`, because a
  projection with no writer would faithfully project a value the operator can never set. Those three
  are off this list for good; **the remaining 23 rows still want the operator's call**, and the
  precedent LOOP-408 set is the argument for them: the gap it closed was not "a missing convenience"
  but a value the config could display and no supported command could write.

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

