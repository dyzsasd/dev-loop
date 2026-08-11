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
**W38** names the unprotected-branch posture that keeps the forge silent. Its named residual —
nothing refuses a squash that skipped the guard — has since shipped as well: **LOOP-444**
(`53077f0`, 2026-08-08) makes the gate the precondition of the squash rather than a step before it,
with no argv that skips it, and **LOOP-448** (`fba3170`) routed every dev tier's Step 0.5 through
that one verb. What remains is forge-side and deliberate: `main` carries no required-check
protection, so a squash issued outside the loop's own path is still unrefused — the posture W38
reports, not an open build item.

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
  Measured 2026-08-10T06:51Z over the 7d team ledger (**945 fires**) via `dev-loop metrics --window
  7d --json`: **fire success 46.3%** (65% over 538 fires when Goals was written 2026-08-08). **Report
  the window as a decomposition, never as a rate alone** — 945 = **438 delivered + 173 classified
  failures + 334 no-op** (`suspectError`, 0 interrupted). Classes: `stalled` ×89, `budget-per-fire`
  ×46, `rate-limit` ×30, `timeout` ×4, `network` ×2, `auth` ×1, `budget-deadline` ×1 — **18.3% of the
  window, 34.1% of the 507 non-successes** (LOOP-464 owns the real gap). `stalled` is the largest
  class and the only one with no owner (**LOOP-483**, parked behind LOOP-464 + LOOP-463). **The
  numerator is frozen, not lagging:** across eleven readings the window grew **831 → … → 933 → 945**
  while the classified count held at **exactly 173 every time** — 138 consecutive arrivals, none
  classified. The three `openrouter` lanes (junior-dev, qa, sweep) have returned in ~6 s with no class
  since the fixed anchor **2026-08-08 16:36Z** (39.0 h; **345** dead-lane fires, **zero** non-suspect),
  so the outage feeds the denominator and nothing feeds the numerator. **The provider attribution in
  that sentence is FALSIFIED as of pass 122 (2026-08-10T22:2xZ, 62 h after the anchor) — re-tested
  live, not re-read:** the key returns **HTTP 200** on `/credits` with **$4.19 remaining** (10 granted,
  5.81 used), the exact configured model `deepseek/deepseek-v4-flash` returns **HTTP 200** with a real
  completion, and `opencode` 1.2.24 runs. The kill is **local to the spawn/boot path**, and it is
  lane-exact: over 24 h the three `opencode` lanes emit **125 · 125 · 22** fires that **exit 0** with
  `bootBytes: 0` and `errorClass: null`, while the two `claude` lanes emit **zero** of that shape. A
  failure that presents as a success is why no classifier sees it. **The OUTAGE half of this paragraph
  is itself now over, and the `bootBytes` half is FALSIFIED, both measured at pass 123
  (2026-08-10T23:0xZ) by bucketing the same ledger HOURLY instead of over 24 h:** the last short
  opencode-lane fire is **2026-08-10T18:21:42Z**, and the 19Z–22Z window holds **32 opencode fires,
  zero short**, durations 677–1827 s — junior-dev ran 1827 s and posted a real approach decision on
  LOOP-517 at 22:50Z, thirteen minutes after pass 122 wrote that the lanes were producing nothing.
  **The executor tier is live again**; the dark window was 2026-08-08 16:36Z → 2026-08-10 18:21Z
  (~50 h), and it ended without intervention (原因未查明). And `bootBytes: 0` is a **lane constant, not
  a fault signal** — it holds on **345/345** opencode-lane fires across 24 h, the 309 broken ones *and*
  all 32 healthy ones, while `pm` is 12/58 and `senior-dev` 12/46 (those 12 each being exactly their
  `spawn-failed` rows). It separates `codingAgent`, not working from broken. **What survives is the
  detector gap** — 309 fires exited 0 having done nothing, every one `errorClass: null`, and no surface
  objected for 19.5 h; nothing was fixed, the shape simply stopped. **LOOP-543** is retitled and
  re-scoped to that; **LOOP-464**'s credit-exhaustion premise is corrected in place on that ticket.
  Why the `opencode` lanes assemble no boot corpus at all is a separate live question in LOOP-482's
  neighborhood, deliberately not merged into either. Compare two readings only
  alongside the fire counts they were measured over — and note that the per-agent half of this table
  is **anti-correlated** until LOOP-508 lands: qa and junior-dev report 89.2% and 82.4% "healthy"
  against a delivered 44.3% and 22.4%.
  **What the wait buys, measured rather than asserted (pass 104, the 39 h since the anchor).** The
  cost side: `--window 2d` prices the two claude lanes at **$737.93** (pm $365.52 · senior-dev
  $372.33) against **$0.08** for all three dead lanes combined — the 402'd fires are free, so the
  spend is entirely the lanes that work. The output side, from the event ledger over the same 39 h:
  **62 tickets filed** (pm 37 · senior-dev 25), **22 claims → 19 `In Review` hand-offs**, and **18
  verified `Done`, every one closed by `pm`** — i.e. **≈2 senior fires and ≈$33 per verified
  increment**. So the outage costs the loop its *executor and its bug-verifier*, not its throughput
  to date: senior implements, pm verifies, and that pair closed 18 increments while dark. What it
  cannot do is drain the half of the board that is junior-tier, or verify anything `qa`-owned — 5
  rows now sit `In Review`, all `qa`-owned, 0 Done since the anchor.
  First program: **3 of 5 shipped · 1 designed-but-unbuilt · 1 in flight** (re-derived pass 129 —
  this SUPERSEDES pass 122's "4 of 5", which counted a design gate as a delivery). LOOP-383 ·
  LOOP-385 Done, and **LOOP-386 shipped through its successor**: it was verify-failed and `Canceled`
  (it re-introduced the failure it closes), superseded by **LOOP-532**, which merged as `7d9c7cf` and
  is Done. **LOOP-384 is `In Progress`** (junior-dev, PR #292 open and mergeable), not Todo.
  **LOOP-382 is `Done` and none of it exists.** It is a §21a design parent, so its `Done` states that
  the design was verified and its children promoted — never that pause/resume was built. Rung-3
  checked this pass: `pause`/`resume` appears in no installed `dev-loop --help`, no file under the
  installed `dist/`, and no file under `hub/src/`, while its four children LOOP-401/402/403/404 have
  all sat in `Todo` since 2026-08-08 (three of them `blocked` behind LOOP-401, which is PICK_RANK 5
  and eighth in junior's slice). The wrong line was not a reading error but a surface one:
  `throughput` counts a design parent's `Done` as a delivered increment — **7 of 200 `→ Done`
  transitions in the 7d window**, and that 7 is a floor — and no surface reports how much of a design
  has landed, so re-deriving program state from ticket states reproduces this error every pass.
  **LOOP-555** owns the split. The pass-94 note that
  `PICK_RANK` rank 4.5 is "the only lever that reaches a picker" **is now inoperative, measured**:
  `Todo` holds **1** P1 ticket while `Backlog` holds **17** (16 junior-tier), because P1 is assigned
  in `Backlog` and §5a promotes only while depth is under the cap — with no preemption, a P1 filed
  after the cap saturated can never displace a promoted P3. The junior slice had been at its cap for
  twelve consecutive fires; **pass 129 is the first to find it UNDER cap** (8/10 — the executor tier
  came back and drained it) and promoted LOOP-547 + LOOP-388 into the two slots, restoring 10/10. The
  single P1 now in `Todo` is that promotion, not a preemption: the mechanism is unchanged, only its
  input was.
  **Pass 133 (2026-08-11T02:55Z) measures the half pass 123 did not.** "The executor tier is live
  again" was established on execution and never tested against delivery, and the two are separate
  facts. Over the 24 h to 02:55Z both tiers ran the same board: **senior-dev closed 27 tickets to
  `Done`, junior-dev 1** (LOOP-365), on 50 vs 110 fires at median durations **873 s vs 6 s**.
  junior-dev holds **10** tickets `In Progress` — LOOP-359/384/388/447/459/502/517/518/519/547, ages
  40–372 min — which equals its entire unblocked `Todo` depth, so the tier carries 20 tickets at a
  delivered rate of one per day. **207 of 215** logged junior fires exit 0. One mechanism is observed
  at rung 3 in `runner-logs/junior-dev.log`: working LOOP-447 the fire staged 275 insertions,
  confirmed them with `git diff --cached --stat`, then emitted its model's native tool-call markup as
  assistant text in place of a tool call, ended the step `reason: "stop"`, and exited 0 — the work
  remains uncommitted in the worktree and the ticket remains claimed (16 such events in the current
  rotation, 6 in `qa.log`). That is one mechanism; the full 1-vs-27 gap is not attributed to it
  (原因未查明). The lever is `team.agents.junior-dev.model`, a config and spend decision outside PM's
  authority, so **LOOP-560** carries it to the operator (`Human-Blocked`, P1) with the options and a
  re-measurement AC. Consequence for this board: ~60 of 72 `Backlog` tickets are junior-tier, and
  their promotion gate opens only as junior delivers.
  **Pass 134 (2026-08-11T03:12Z) locates that gap downstream of the model, and withdraws pass 133's
  stated lever.** The junior tier's work is not missing; it is in seven green pull requests. Measured
  this pass: **#292** (LOOP-384), **#297** (LOOP-459), **#300** (LOOP-502), **#304** (LOOP-517),
  **#306** (LOOP-518), **#309** (LOOP-519), **#315** (LOOP-388) — every one `CLEAN` with 3/3 required
  checks `SUCCESS`, **878 insertions across 30 files in 6.5 h**. All seven are **exactly 5 commits
  behind `origin/main`** (`git rev-list --count origin/dev-loop/<id>..origin/main`), and merge-guard
  refuses each on `ciFreshness`. Those ⛔ holds are posted **by the junior fires themselves**
  (LOOP-384 01:34Z/01:56Z, LOOP-519 01:35Z/01:56Z, LOOP-388 02:14Z), so the tier reaches the landing
  gate and is refused there rather than failing earlier. merge-guard's printed remedy names
  **dev-agent Step 0.5's re-freshen** — and **LOOP-553** (PM-verified 00:42Z, operator-approved
  01:30Z) establishes that Step 0.5 reaches no split-dev fire: `boot-prefix.ts` ships the
  ship-sequence slice at SKILL lines 109–260 while Step 0.5 sits at line 59. `ciFreshness` is
  therefore **terminal for this loop, not transient**, and the delivered-rate counter measures the
  last link of that chain while pass 133 attributed it to the first. **`team.agents.junior-dev.model`
  is withdrawn as the lever** — not refuted, unsupported: no junior increment has completed the
  delivery path, so junior *output quality* has never been observed and the model question is not
  currently answerable. The abandoned-claim mechanism pass 133 recorded at rung 3 stands as a
  **second, independent** defect — the fires that do reach a PR still skip §12b step 7, leaving the
  ticket `In Progress` with no `In Review` handoff — and the same change does not fix it. **The
  unlock is one operator action:** PR **#313** carries LOOP-553's fix and is itself held on
  `ciFreshness` (refused 02:29Z at 5 behind, 02:55Z at 2), so the PR that teaches fires to re-freshen
  a stale PR cannot be re-freshened by a fire; nothing in the loop will land it. **LOOP-454** is the
  same stall's third recurrence (8 PRs 08-08, 8 on 08-09, 7 now) and its first on the junior lane —
  `Backlog`, P1, junior-tier, behind a cap held full by the very PRs it would drain.
- **E20 shipped (LOOP-473, `36ba510`, PR #314, verified Done 2026-08-11T03:00Z)** — `doctor` reports
  a home-anchored `~/.dev-loop` tree that still holds state. The detector half only: LOOP-473 landed
  3 of its 7 ACs as a declared split, and **LOOP-556** (`Todo`, senior, `sensitive`) carries AC1/2/4/7
  verbatim plus the `devloopHome()` removal. Merged, not published.
- **The board's write surface has a supported switch (LOOP-479, `6b451ed`, verified Done
  2026-08-10)** — `dev-loop settings <path>`: allow-listed, off by default, refused inside a fire
  (exit 4). Merged, not published (`0cac647`/v1.15.1 runs the fires). `humanWrite.enabled` stays
  unset here, so the board is still read-only and the CLI is still the only way to rule.

### 2026-08-10 (pm, one-hundred-thirty-sixth fire): the block that bounds the doc has started carrying facts that decay, and the sawtooth measured end to end

**The doc's growth is a sawtooth, not a fix that decayed.** Measured per commit over every
`docs/STRATEGY.md` revision: the 🧭 block was distilled 07-31 at **299 lines / 27,039 B**, regrew to
425, was cut by the 08-06 rollup to **117 / 10,540 B**, held **flat at 186 lines / 16,929 B across
~40 commits and three days** — then grew **186 → 306 lines (+11,545 B) in the six hours to 07:47Z**,
one rule per pass. Whole doc: 147,966 B → **46,940 B** (08-06) → **83,325 B**, i.e. **77% of the way
back in four days**. The ramp is PM's own passes; rule 23 already states the test, this is its
number.

**Three in-force rules assert ticket states that are now false.** Rule 13 says the label/marker
divergence is "Open as LOOP-190"; rule 18 says the `Bug` design-parent owner split is "open as
LOOP-310"; rule 32's premise reads "LOOP-372 is `In Progress`". All three are `Done`. That is
**rule 35's own failure — a fact whose write rate (once, at distillation) does not match its decay
rate (the board, hourly) — occurring inside the block that holds rule 35.** Corrected in place, and
the correction is deliberately *not* a retirement: a close is not evidence the behaviour stopped, so
each now says to re-derive against the tree. The general form for the next distillation: **a
standing rule may cite a ticket as evidence; it may not depend on that ticket's STATE.**

**Board and protocol.** Job A empty for the ninth consecutive fire — all 5 `In Review` rows are
`qa`-owned and `qa` is dark. `needs-pm`/`_team` empty; no `## Deferred findings` pending; §9c
re-derived, no blocker in {401, 468, 472, 464, 463} terminal, so none of the six parked rows can
unpark. LOOP-463 stays at the operator (16:36Z review point ~8 h out at close, so no comment).
Promotion closed for the **twenty-eighth** fire: unblocked Todo **26** (13/13) against 10 per tier.
Two findings went as comments on the tickets that already own them (**LOOP-482** — W03's prescribed
remedy cannot make W03's claim true, because delivery ANDs in `codingAgent === "claude"` and 5 of 7
lanes are opencode; **LOOP-484** — the growth law above). **One filing, LOOP-519:** W06's leak scan
enumerates bundle artifacts and `moved.json` as literals, so an untracked, un-ignored `qa-state.json`
at the repo root is not merely unwarned but *certified* — `!leaks.length` is what unlocks the clean
line, and it has printed over that file for two days. It cleared the bar because it is the coverage
half of LOOP-231's shape and no other check can see it: W33 reads tracked files only, and Sweep, the
hygiene backstop for strays, is dark.

**Pass price: +352 B (83,325 → 83,677).** Rolled the 135th fire's journal whole to `2026-08.md`
block BI (3,969 B) against 4,321 B added. The pass landed at −409 B and then went positive when
LOOP-519 was filed after the land and this paragraph had to be corrected — stated rather than
absorbed, which is the whole point of the price line. Per rule
23's corollary a bounding pass must roll at least what the fire appends; every pass since 08-06 has
stated a positive price instead. At this rate the 49,152 B budget is still ~61 passes away — the
lever is LOOP-484, not the per-pass discipline.

**2026-08-10, 148th fire — the observable-and-safe program closed its last open control, and the
shared checkout was holding a revert of shipped code.** **LOOP-532 verified `Done`** against the
merged tree at `7d9c7cf`: the banner's two fault sources became state and `renderBanner()` the single
writer, so a healthy poll can no longer clear a banner raised by a lost stream. The five
`operator-design-review` controls now stand at **4 `Done`** and **1 `In Progress`** (LOOP-384) — and
that ticket's live branch is `c63f65d` on open PR #292, superseding the `f9fb354` this doc named at
the 144th fire. **Verified by mutation, not by reading:** three mutations of the shipped client,
each red (3 / 10 / 5 assertions), the third reconstructing LOOP-386's defect exactly and being named
by the suite's own AC — the power its predecessor's four `text.includes(…)` assertions never had.
**What the checkout was carrying:** a STAGED revert of shipped LOOP-468 code (`postinstall.cjs` +
its test, re-adding the autostart spawn PR #293 removed) left by the 147th fire's own mutation test,
plus a superseded half-applied `migrate.ts` edit. Restored to `HEAD` before any doc work; the
discarded diff preserved and reported on LOOP-384.
**Todo depth 23 — senior 13/10, junior 10/10.** Promotion closed for the 39th time in 40 fires;
Backlog steady at 74 for a fourth fire. `Human-Blocked` is zero for a fourth fire. Job C filed
nothing for a fourth consecutive lens sweep: the ux-flows finding — the projects index, the page an
operator lands on, renders three delivery counts and no decision-queue count at all — deduped into
LOOP-390 as AC5 rather than becoming ticket #75.

**Pass price: +5,044 B (132,940 → 137,984, this line included).** Rolled nothing. Larger than the ≤2.5 KB the 147th fire
committed to, and a deliberate trim pass recovered only 270 B — the entry is long because it carries
two findings and mints a standing rule, not because it is padded. Stating that rather than absorbing
it: the per-pass lever is nearly exhausted, and the doc has now grown every pass since 08-06. The
lever is LOOP-484 (Backlog, behind the cap), which argues the naive rollup is wrong because 244 of
284 Decisions lines are in-force doctrine rather than superseded history.

**2026-08-10, 144th fire — the observable-and-safe program, and what the board actually holds.**
The five `operator-design-review` controls now stand at **3 `Done`** (LOOP-382 pause/resume, LOOP-383
typed approvals, LOOP-385 release resilience), **1 `In Progress`** (LOOP-384 waiting-on discriminator,
committed and pushed as `f9fb354`), and **1 re-opened**: LOOP-386's banner merged as `b5cfca0` but was
verify-failed and superseded by **LOOP-532** (senior, `Mode: direct-code`, P1), which carries the
residual — the `streamLost` guard, a real daemon-harness test, and the duplicated remedy line. The
label marks six rows now, one of them terminal; nothing in `hub/src` counts it, so the terminal row
corrupts no surface — checked, not assumed.
**Board census, measured directly rather than through a capped read:** 513 tickets — 356 `Done`, 74
`Backlog`, 26 `Todo`, 48 `Canceled`, 5 `In Progress`, 3 `Duplicate`, 1 `Human-Blocked` (LOOP-473,
parked on the operator since 18:58Z for the migration ruling). The web board renders `showing 250 of
513` with true per-state pills, so LOOP-370's AC3+AC5 are working in production; `dev-loop tickets
--json` caps at the same 250 and says so on stderr with the remedy.
**Todo depth 22 — senior 12/10, junior 10/10.** Promotion opened for the first time in 35 fires and
closed again inside one fire: LOOP-459 promoted, junior 9 → 10.

**Pass price: +7,762 B (113,891 → 121,653).** Rolled nothing. Per rule 23's corollary a bounding pass
must roll at least what it appends; every pass since 08-06 has stated a positive price instead, and
this is the largest of them — the fire had a superseded increment, a canceled defect and a reopened
promotion gate to record. The lever remains LOOP-484 (Backlog, behind the cap), not the per-pass
discipline.

**LOOP-409 shipped and verified (fire 150, 21:31Z).** The resolved `mode`/`autonomy` now reach the
hub `projects` row through one reconciler (`hub/src/project-row-sync.ts`), so `dev-loop project
--json` — the first command every `interface:"cli"` fire runs — reports the operator's configured
values instead of the column default. Verified at `afc8bc6` in a detached worktree: 29 assertions,
plus a 10-assertion no-op mutant to confirm the suite discriminates. This board now reads
`mode:"live", autonomy:"ask"` from the row rather than from a default that happened to match.

**§9c edge integrity, measured board-wide at 21:40Z (fire 151):** four open tickets carry a live
`Blocked-by:` edge — LOOP-483 (→ LOOP-464, `Backlog`) correctly parked, and LOOP-402/403/404
(→ LOOP-401, `Todo`) which had been unparked in error 16 minutes earlier and were restored this fire.
No other open row on the board carries an edge, live or retired.


**Fire 155 (2026-08-10T23:2xZ) — the deferred land completed, and main is green.** §20 pass 123
(commit `4779725`) was held last fire because main's own CI run at `f40d237` was still in flight and
a docs-only push cancels the run beneath it (LOOP-486). That run completed **success**, so the pass
landed this fire and was verified by content hash against `origin/main` — `55019bbf260c371c` — never
by `--contains <local sha>`, since `doc-land` rebases. LOOP-443's fix (`f40d237`) is now both merged
and verified by main's own run; its new `findUnlandedDocCommit()` refuses a doc commit stranded on a
branch the shared checkout has left, which is the failure that used to exit 0 claiming success.

**Board at this fire's close: Todo 24 (senior 14/10, junior 10/10) — both tiers over cap, so nothing
was promoted; Backlog 71 (+1).** Job A was empty at boot and at close. The one operator park is
LOOP-542 (release tracker, `Human-Blocked`, 42 min old at boot, still uncommented) and LOOP-396 is
correctly blocked behind it — the edge is valid because LOOP-542's AC1 names `67d04e1` explicitly,
so its close condition implies LOOP-396's prerequisite. The §9c edge audit ran clean for the second
consecutive fire: 5 correct parks, 0 mis-unparks, 0 unpark candidates, 0 zero-edge parks.

**Doctor gained W38 and lost W42.** W42 no longer fires — LOOP-410's reconciler shipped and no hub
row now disagrees with config. W38 is new in the output but **not unowned**: it is the shipped
detector for the LOOP-407/LOOP-444 class (`main` has no branch protection, so `mergeChecks` is
enforced only by `merge-guard` at Step 0.5 and a never-dispatched check reads CLEAN). Its remedy is
an operator GitHub setting or the standing rule never to merge on CLEAN alone; no ticket is needed.


**Board at this fire's close: Todo 23 unblocked (senior 13/10, junior 10/10) — both tiers at or over
cap, so nothing was promoted; Backlog 72 (+1 filed, −1 closed Duplicate).** Job A was empty at boot
and at close: LOOP-443 was the fire-155 handoff and closed `Done` at 23:10Z before this fire booted.
Job B resolved nothing to `Todo` — the one `needs-pm` item (LOOP-396) is correctly blocked behind
LOOP-542, which remains the single operator park and is now commented for the first time with a
re-measurement of its own premise. The §9c edge audit ran clean for the third consecutive fire, with
one edge deliberately rewritten (LOOP-483: LOOP-464 → LOOP-543).

**Doctor gained a hard `❌`.** `repo 'web.app' path missing on disk` is new at 22:59Z and is the
first hard failure this workspace has carried; `dev-loop doctor` exits 1. It is owned by LOOP-546
for the remedy-text half. The half that is **not** a product defect — whether `projects.testproj` /
`repos.web.app` belong in this workspace at all — is the operator's call and is recorded here rather
than filed. `[W18]` now reads 10 code commits behind (up from 7 at LOOP-542's filing), and `[W17]`
(`testproj` has repos but no `strategyDoc`) arrived with the same row.

**Board at this fire's close: Todo 22 unblocked (senior 12/10, junior 10/10) — the junior tier had
one slot and it was used; Backlog 72 (−1 promoted, +1 filed).** LOOP-519 (W06 certifies a tree it
did not measure) was promoted Backlog→Todo as the junior tier's top pick by rank — a `Bug` at rank 3
ahead of sixteen P1 Improvements at rank 4.5 — and its evidence is still live in the tree
(`?? qa-state.json` remains untracked and un-ignored at the repo root). The senior tier stays over
cap at 12/10, so nothing was promoted there. Job A was empty at boot and at close: the sole
`In Review` item, LOOP-536, is a `Bug` with the `qa` owner label and is QA's to verify, not PM's.

**The §9c edge audit ran clean for the fourth consecutive fire.** All five parks hold at least one
open blocker edge and none is an unpark candidate: LOOP-396→542, LOOP-402/403/404→401, LOOP-483→543.
No zero-edge park exists, so no ticket is sitting behind a label with nothing that can clear it.

**LOOP-542 re-measured and unchanged at 10 code commits behind** (installed build `c7a9e11`, read
from `build-commit.json` rather than `--version`, which reads 1.15.1 on both sides and distinguishes
nothing). No new code commit landed since the previous fire, so the park did not decay further and no
comment was added — the tracker is re-measured every fire and commented only when the number moves.

**A false ⚠️ was added to the doctor surface's known set: `[W24]`.** It was previously attributed to
LOOP-543/483/466 as a taxonomy-coverage gap; this fire established it is a defect in W24's own
denominator and filed LOOP-547 for it. The standing inventory line — every doctor W-code has a
ticket or a named owner — now reads W24→547 (arithmetic) alongside 543/483/466 (the stall and
no-op classes, which consume these counts but do not compute them).

**The release skew closed and the operator's decision queue reached zero (one-hundred-fifty-eighth
fire).** The operator built and installed `a6b0a60` at 02:04:41 local on 2026-08-11.
**LOOP-542** — the second release tracker of the week, Human-Blocked since 22:36Z — is verified
`Done` on its own AC1–AC3: the three named commits (`4cf6130`, `7ec1d8c`, `67d04e1`) are ancestors
of the installed build; `doctor` emits no `[W18]`; the installed `dist/` carries the markers the
filing recorded absent (`DEVLOOP_WORKSPACE` 0→6, `defaultBranch` absent→19, `force-with-lease`
0→4). The running daemon serves the new build — checked, not assumed: `dist/*` written 02:04:41,
daemon pid 99389 `lstart` 02:04:42. **LOOP-396** unparked per §9c (`Unblocked-by: LOOP-542`),
releasing PR #291 and the stalled PR queue behind it. `metrics --json .decisionQueue` is now **0**
and `[W20]` is clear — the first empty operator queue recorded here. AC4 (the refresh push is
actually clean) is deliberately left open on LOOP-396: `push-guard` on that branch exits 0 today
only because it enumerated an empty range, which is the guard-checked-nothing shape, not evidence.

**The §9c edge audit ran clean for a fifth consecutive fire, after retiring one loaded edge.**
LOOP-483 carried two live `Blocked-by:` markers — LOOP-543 (open) and **LOOP-463 (Done since
08-10T18:43Z, never retired)**. Held today by 543, so nothing fired; but §9c releases on *"≥1 edge,
all resolved"*, so the next re-point of the 543 edge would have left a single `Done` edge and
unparked the ticket onto undone work. Retired (`Unblocked-by: LOOP-463`); LOOP-483 stays `Backlog`
+ `blocked`. Live parks are now LOOP-402/403/404→401 and LOOP-483→543.

**A second, outward-facing release gap was opened where the first one closed.** The npm-published
artifact — the only one that reaches the adopters `Goals` names — is **55 code commits** behind
`origin/main` (v1.15.1, published 2026-08-07T00:25Z; measured with W18's own machinery via its
documented `DEVLOOP_W18_PKG_JSON` injection). This workspace's `doctor` is silent about it: a local
source build sets `isSourceBuild`, which skips the `v<V>` tag baseline entirely, so
`publishRemedy()` — LOOP-247's fix, the only code in the product that asks npm what is released —
is never called here. The local rebuild is itself the remedy the loop applies to clear W18
(LOOP-525 and LOOP-542 both closed on one), so unblocking the loop is the act that blinds the
release check. Filed **LOOP-549** (P1, `Improvement`+`pm`, junior) for the missing measurement;
distinguished from LOOP-442 on that ticket and this one — 442 fixes two remedies disagreeing while
the alarm is ON, 549 fixes the alarm being OFF.

**The authorization system reached seven shipped tickets and zero enforced actions here.** The
approvals record (C1–C7) is present in the build and inert in this workspace: `team.approvals`
absent, 0 rows in the `approvals` table, 0 approval events, no `doctor` line. Default-empty
enforcement is the shipped design and the operator owns the opt-in, so the state itself is
permitted. What is missing is any report of it — W40 requires approval rows to exist, LOOP-495's
check requires an enforced class, and W42 requires `enforce` to include `push`, and empty
enforcement is what prevents all three preconditions from being met. Filed **LOOP-554** (P2,
senior, `sensitive`) for the check that asks the question without requiring the feature to already
be in use, keyed on the absent-vs-`[]` distinction the config schema already accepts.

**The watchdog-kill discriminator is now a recorded fact.** LOOP-462 verified `Done` against the
merged tree at `a47f76b`: `FireRow.watchdog` (`"timeout" | "stalled" | "retry-loop" | "budget" |
null`) is written unconditionally by the scheduler from the booleans that arm the kill, and the
per-profile $/ms median excludes a kill by reading it rather than by testing exit code 124/125/126,
which a child CLI returns on its own. Verified by mutation: deleting the one decoder line turns 9
assertions red. The decoder's three-state contract survives the read path — `readFireRows` is a bare
`JSON.parse`, so a present `"watchdog": null` is not collapsed into an absent key. A second
consequence is recorded on **LOOP-466**: `errorClass` and `watchdog` are now independent fields, so
letting the stall arm yield to a provider-scoped class no longer erases the record that a stall
watchdog fired, which removes the information-loss argument for that ticket's option (c) and leaves
only its evidence question. Not yet live on this host — the installed build is `a6b0a60` and 0 of
1723 ledger rows carry the field.

**The approvals consumer list is now a set the build derives, and correcting this section's own
count is what showed the sentence above had decayed.** LOOP-396 (C5) verified `Done` against the
merged tree at `2fc31aa`: `approvals.ts` exports `CONSUMER_INVENTORY` and
`hub/test/approvals-inventory.ts` derives the real `consultApproval` call sites from `hub/src/**`,
asserting SET EQUALITY against the migrated entries — so it fails in both directions, a new call
site with no entry and an entry whose call site was deleted. Verified by seven mutations rather
than by the four the handoff reported; the two added were the ones that decide whether the suite is
honest at all — a residual that quietly starts consulting goes red on AC3, and the same call
written only in a comment is correctly ignored, which is what stops the whole derivation from
passing off prose. Measured coverage: **1 of the 6 enforcing consumers is migrated** (push-guard);
the five residual are recorded in the module itself with what each migration needs, and design §12
sequences them per-verb after the switch has been exercised once, which C8/C9 own — so they are
deferred by the design, not unowned.

The count correction in the paragraph above came out of that measurement: this section had recorded
**"nine shipped tickets … (C1–C9) is present in the build"** while C8 (LOOP-522) and C9 (LOOP-523)
were still `Todo` and the program's Done set was **seven** (C1–C7). That is LOOP-555's defect class
— a child's *planned* place in a design read as its *built* state — reappearing in this doc's own
prose about the very module that just shipped a test to stop exactly this decay elsewhere. Re-derived
at rung 3 before the edit: 0 rows in `approvals`, 0 approval events, no `doctor` line. The enforcement
posture is unchanged; only the claim about how much of the chain exists was wrong.

**The fourth gap's named residual has shipped, and the clause that names it cannot be corrected where
it stands (pm, one-hundred-sixty-third fire).** `Goals` closes the fourth gap on LOOP-407 and then
adds: *"Residual: nothing refuses a squash that skipped the guard (**LOOP-444**)."* LOOP-444 has been
`Done` since **2026-08-08T16:53Z** — it shipped as `53077f0`, and LOOP-448 (`fba3170`) migrated Step
0.5 onto it. Checked at rung 3 this pass rather than read off the board, because rule 55 makes a
ticket's `Done` inadmissible on its own: the **installed** CLI carries `dev-loop pr merge <n>`, whose
own help states the gate and the squash are one operation — *"There is no argv that skips the gate"* —
and all three dev SKILLs in the installed tree (`dev-agent`, `senior-dev-agent`, `junior-dev-agent`)
route Step 0.5 through that verb. So the residual is closed **in the artifact the fires actually run**,
not merely on the board. The stale clause sits in `Goals`, a direction section only a §9a round may
write (§20 D4), so it is reconciled here instead — which is what that section's own preamble
prescribes when it says the per-ticket state lives in `Current state` and *"a number embedded here is
stale by construction"*. No ticket is filed: there is no work left to own, only a sentence whose write
rate is slower than its subject's.

**The outward gauntlet's core promise has a measured counterexample, and it is the third instance of
a class this doc has twice recorded as closed (pm, one-hundred-sixty-eighth fire).** `Goals` sells
the reusable CI workflow as *"adoptable on ANY legacy repo day one — what you touch must be clean"*.
Measured this fire on installed 1.15.1, in throwaway repos, using the exact argv
`quality-reusable.yml` builds in its default `mode: pr`: a PR that changes **two** files — one the
test suite imports, one it never does — exits **0** at `--threshold 30` while the untested file's
CC-7 function reports `N/A` and is excluded from the comparison. Its correct CRAP is
`7² × (1−0)³ + 7 = 56`. The controls are what make it a defect rather than a reading: the same repo
with **only** the untested file changed exits 1 on the existing `no rows are scorable` hard-fail,
green tests or red. So the guard exists and is all-or-nothing — `maxCrap` (`quality.ts:636`) is the
worst *scorable* row, and one scorable row is enough to certify a selection whose worst member was
never scored. LOOP-158 closed this for TS/JS and LOOP-192 for Go, both keyed on **every** row being
unscorable; this is the partial-selection residual they leave. The cause is backend-specific and
does not generalise: V8 emits no entry at all for a file no test loads, so "uncovered" and
"unmeasured" arrive as one signal, while Go's coverprofile enumerates 0%-covered functions — which
is why LOOP-192's Go repro could score 156.0 and the TS/JS path cannot. It is invisible inward
(`test.yml` scores coverage from a suite that loads substantially all of `hub/src`) and normal
outward, since a legacy repo's first PRs are exactly where untested files arrive. Filed as
**LOOP-561** (p1) with a self-contained `AC-exec` verified to exit 1 against `36ba510`. The
adoptability claim in `Goals` is not corrected here: no measurement contradicts the *path*, only the
verdict the gate returns once adopted, and LOOP-561 owns that.

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

- **2026-08-11 (pm, one-hundred-sixty-first fire) — the rollup premise inverted while the ticket
  that measured it waited in the Backlog, and the ceiling that ticket argues about is unreachable
  even after a complete roll.**

  **What was measured.** The doc-size curve over its own last 18 doc commits, read from git rather
  than from any prior pass's claim: **113,891 B at 2026-08-10 21:07Z → 195,699 B at 2026-08-11
  03:00Z** — +81,808 B in 5h53m, ~+4.5 KB per PM fire, at a fire cadence of roughly three per hour.
  W37's ceiling is 49,152 B, so the doc stood at **4.0× budget**, and every §20 R2 reader pays the
  whole file on every fire.

  **The inversion.** LOOP-484 is the ticket that owns W37, and its argument is a composition claim
  measured on 2026-08-09 at `origin/main@1740af4`: `Decisions` was 25,402 B / 284 lines, of which
  **244 lines (86%) were the three standing blocks or the archive index** — so the rollup W37
  prescribes "reaches 38 of 284 lines (13%)" and archiving more "would delete rules the loop
  currently runs on". That was true when written. Re-measured this fire: `Decisions` is **142,474 B
  / 1,609 lines — 73% of the doc's bytes** — and the standing blocks are still **434 lines**, very
  nearly the 244+ they were. The dated fire journals grew around them from 38 lines to **1,175**.
  The rollable fraction did not drift; it **inverted, 13% → 73%**, inside 48 hours, and the ticket
  recording the old split sat unpromoted the whole time.

  **What survives of LOOP-484, and what does not.** The composition and rate premises do not: they
  described a doc a third of this size and are not a basis for declining a roll. The **second half
  stands and is strengthened** — non-`Decisions` content is **53,225 B**, which is already **above
  the 49,152 B ceiling before a single line of `Decisions` is counted**. So the ceiling is
  unreachable by W37's own remedy even after rolling 100% of the log, standing blocks included.
  `hub/src/lessons.ts:32` fixes it as `48 * 1024` with no config key, so an operator who judges this
  doc's legitimate size cannot say so. LOOP-484's AC3 (make the ceiling operator-settable) is the
  part that answers the finding; its AC1 remedy-text arm now has a second false case to cover — a
  doc that is over *and* freshly rolled.

  **Acted, not just recorded.** This pass performed the roll §20 R2 assigns to PM: the 25 dated
  entries for fires 92–152 (850 lines / 76,410 B) moved to `docs/strategy-archive/2026-08.md` with
  an index line above, keeping the eight-entry working tail. No standing rule was touched — the
  distilled doctrine is what makes the journals safe to roll. Doc: **195,699 → ~123 KB.**

  **The generalisable call. A rollup's residue is not a stable fraction, so the split must be
  re-measured at the moment of rolling and never inherited from the fire that last looked.** The
  failure this closes is specific: a correct measurement was cited across several fires as a reason
  not to act, long after the thing it measured had changed shape. A composition claim carries an
  expiry the moment the population it describes is still growing — and here the agent citing it was
  the same one adding ~4.5 KB per fire to that population.

- **2026-08-11 (pm, one-hundred-sixtieth fire) — a design gate and a shipped increment are the
  same event to every delivery surface, so the north star recorded a control as shipped while none
  of it existed.**

  **What was measured.** `boardMetrics` (`hub/src/metrics.ts:658`) increments `throughput` on every
  `→ Done` transition in the window and discriminates nothing about the ticket. Over this
  workspace's own `events` table: 7d = **200 `→ Done`, 7 of them design parents**; 24h = **32, 1 of
  them** (LOOP-499). The 7 is a floor — it was counted from the `Mode: design` body marker alone (23
  such tickets on the board), while `isDesignParent` also admits parents derived through
  `designParentIds`. The same edge lands in `inReviewExits["Done"]`, so `acceptRate` carries it too.

  **Why it matters here rather than in general.** Under §21a a design parent's `Done` is a
  DIFFERENT contract: the design is the verified increment, PM promotes the staged children, and
  nothing has been built at that moment — correctly. `throughput` is also the figure the §22a
  director digest is instructed to quote verbatim. So the one delivery number the operator reads
  mixes two populations, which is the error LOOP-98 already corrected once in this same function for
  `throughput` vs `acceptRate`.

  **The observed instance.** LOOP-382 — "First-class pause/resume", control 1 of the operator's five
  — went `Done` and entered that 7d count. Three days later `pause`/`resume` exists in no installed
  `--help`, no installed `dist/` file and no `hub/src/` file (rung 3, not inferred), and all four
  children LOOP-401/402/403/404 are still `Todo`. Pass 122 re-derived program state from ticket
  states and wrote **"First program: 4 of 5 shipped"** into `Current state`. That line is corrected
  in this pass to **3 shipped · 1 designed-but-unbuilt · 1 in flight**. The correction is not the
  fix: any future re-derivation from ticket states reproduces it, because no surface answers "how
  much of this design has landed" — a Done parent's children are reachable only by walking
  `relatedTo` by hand.

  **The call.** Filed **LOOP-555** (Improvement, P2, junior-dev): split the `→ Done` count into
  delivered increments and design-gate closes across `--json`, the human render and `teamRollup`,
  and give a Done design parent a children-landed figure. Binding constraint on the build: it must
  call the EXISTING exported `isDesignParent` / `designParentIds` rather than add a fourth arm —
  LOOP-515 reports the three current consumers already disagree, and a private copy here would make
  this the fourth thing that fix has to reconcile. Sweep's §21a stranded-child rule is deliberately
  NOT extended: children promoted to `Todo` are the correct post-gate state, and calling that a
  strand would fire on every healthy design.

- **2026-08-11 (pm, one-hundred-fifty-ninth fire) — the authorization system is enforcing nothing
  here, and each of the three checks built to report that takes a precondition which empty
  enforcement removes.**

  **What was measured.** `team.approvals` is absent from `dev-loop.json`; `dev-loop approvals --all
  --json` returns `[]`; a direct read of `hub.db` gives **0** rows in the `approvals` table and **0**
  events whose kind matches `%approv%`; `doctor` prints no approvals line. The approvals record was
  built across nine tickets (C1–C9: LOOP-383, 391–396, 521, 522, 523) and gates no action in the one
  workspace that runs the loop.

  **That state is permitted; the absence of any report of it is the defect.** `approvals.enforce`
  ships default-empty by design (§8) and opting in belongs to the operator. Three W-codes report
  enforcement health and none can fire in this state: **W40** returns at `if (!rows.length) return;`
  (`doctor.ts`), **LOOP-495**'s check requires `enforce` to name a class, and **W42** (LOOP-522)
  requires `enforce` to include `push`. The precondition each takes is produced only by a workspace
  already using the feature, and the way a workspace acquires zero rows is that nothing refuses, so
  no agent ever files a `request`. Empty enforcement removes the evidence W40 needs in order to
  report empty enforcement.

  **LOOP-522's own table is what identifies the gap.** It assigns W40 the question *"is enforcement
  configured at all?"* with the predicate *"rows exist, `enforce` empty"*. Those are two different
  questions, and the table has no row for a workspace that has never adopted the feature. Filed
  **LOOP-554** (P2, `Improvement`+`pm`+`sensitive`, senior direct-code) as that fourth row, with the
  constraint LOOP-522 states — the codes must not absorb one another — carried into its ACs.

  **The discriminator needs no new configuration.** `team-config.ts`'s own E18 message already says
  *"omit it or use `[]` to enforce nothing"*, so an absent `enforce` and an explicit `enforce: []`
  are distinguishable today: absence records that the question was never asked, `[]` records a
  deliberate decision to enforce none. LOOP-554 AC2 requires this be measured through the mutator
  rather than assumed, because `config-schema.md` says the empty string "clears it" and whether that
  writes `[]` or deletes the key decides whether the opt-out exists at all.

  **This repeats a defect already solved twelve lines away in the same file.** `checkLessonsLiveness`
  (W30, LOOP-91) sits directly below `checkApprovalsHealth` and was written for this shape: *"a
  library that has never been written produces no warning anywhere … Absent and healthy were the
  same output — empty for 120 fires with every surface reporting healthy."* W40's own comment
  records the same failure mode — *"that state is INVISIBLE from either side"* — above an early
  return whose comment reads *"nobody uses the feature ⇒ nothing to say"*. The causality runs the
  other way: nothing is enforced, therefore nobody uses the feature.

- **2026-08-11 (pm, one-hundred-fifty-eighth fire) — the remedy for one release alarm is the thing
  that silences the other, so the loop cleared its own skew twice this week while the artifact
  outsiders install fell 55 commits behind, unreported.**

  **What was measured.** The operator installed a local source build at `a6b0a60` (02:04:41 local),
  which discharged **LOOP-542** and emptied the decision queue. In the same `doctor` run, `[W18]` is
  now entirely absent — no warning and no `✅ … matches origin/main` line. Using W18's own code
  through the injection hook the function documents (`DEVLOOP_W18_PKG_JSON`, "no real reinstall
  needed"), pointed at the *published* package's identity: **`installed @dyzsasd/dev-loop v1.15.1 is
  55 code commit(s) behind origin/main (63084b4) (+93 doc-only) … npm already has 1.15.1 and this
  host is on it — the merged commits are NOT released yet`**. npm's latest is 1.15.1 from
  2026-08-07T00:25:33Z; `hub/package.json` still reads 1.15.1; the newest tag is `v1.15.1` =
  `41e7bcc` (08-06 15:48Z).

  **The mechanism, and why it is self-inflicted.** `checkInstalledCliSkew()` reads the installed
  tree's `build-commit.json` first (`doctor.ts:1685`). A stamp sets `isSourceBuild` and makes that
  commit the baseline — the `v<V>` tag lookup at `:1691-1699` is the `else` branch and never runs.
  So the only distance computed is source-build→main, and `publishRemedy()` (`:725`, LOOP-247's fix,
  the sole `npm view` call in `hub/src/`) sits in the ternary arm a source-build host never takes.
  After the rebuild that distance is 0, W18 returns before line 1730, and the surface goes quiet.
  The trap is that the rebuild is the *prescribed remedy*: LOOP-525 and LOOP-542 were both release
  trackers and **both closed on a local install**. Every time the loop unblocks itself it resets the
  only alarm that could report the npm gap — which is how that gap reached 55 commits with nothing
  ever firing. This host has run source builds as steady state since the operator's 2026-08-01
  direction (LOOP-246 / LOOP-250), so it is not an edge case.

  **What was decided.** Filed **LOOP-549** (P1, `Improvement`+`pm`, junior): resolve the published
  baseline unconditionally and report it as its own W-code, leaving W18's two existing arms
  byte-identical (AC4 pins both). Explicitly **not** filed: whether release cadence should be
  automated. LOOP-542's Notes flagged that as the durable question if the class recurred, and it has
  — but landing-observability §9.7 kept the human release gate **on purpose** and paid for it with
  the promise *"make when to pull it a one-look call"*. Reversing that is a `Goals`-level call and
  rides §9a, not a PM filing. LOOP-549 makes the one-look call actually possible; whether to keep
  needing it is recorded for the operator under `Candidate ideas`.

  **What I will not repeat.** Two release trackers in one week were each treated as an instance to
  discharge. The recurrence itself was the finding, and the second close is what exposed it: a
  remedy that suppresses its own detector will keep the condition invisible for exactly as long as
  the remedy keeps being applied. When a tracker closes, ask what its closing turned off.

- **2026-08-10 (pm, one-hundred-fifty-seventh fire) — the failure-taxonomy alarm reported the
  taxonomy two-thirds blind on a window in which every failure carries a class, because its
  denominator counts fires that cannot carry the thing it measures.**

  **What was measured.** `dev-loop doctor` on this workspace prints `[W24] 419 of 630 failure-ish
  fires (67%) carry no errorClass — the taxonomy is blind here … the provider breaker … cannot
  engage on them`. Re-derived from the ledger the check itself reads
  (`.dev-loop/team/fires.jsonl`, same 7d window, 1072 rows): fires with `exitCode != 0` = **211**;
  of those, fires carrying an `errorClass` = **211**. Failed-and-unclassified in the window: **0**.
  The `top errors` line W24 calls incomplete sums to exactly 211 — `stalled×92 + spawn-failed×59 +
  budget-per-fire×46 + rate-limit×5 + timeout×4 + network×2 + budget-deadline×2 + auth×1`.

  **Root cause, in one expression.** `checkFailureTaxonomyBlind` (`hub/src/doctor.ts`) computes
  `failureish = fires.failures + fires.timeouts + fires.suspectErrors`. Those three counters are
  incremented in `hub/src/metrics.ts` by independent predicates over the same row, so they do not
  partition the fire set. Two consequences, measured: the 5 `timedOut` rows all also exit non-zero
  (exit 124), so they are counted twice; and the 414 `suspectError` rows all exit **0**, so they
  can never carry an `errorClass` — 414 of the 419 "unclassified" fires come from there. The share
  therefore tracks the no-op rate rather than the classifier's coverage.

  **Why it is recorded rather than treated as cosmetic.** The prescribed remedy is
  `grep '"exitCode":1' .dev-loop/team/fires.jsonl | tail`; run verbatim it returns rows that are
  100% classified, so the operator who follows the instruction finds nothing and learns to discount
  the code. The line also asserts that the provider breaker cannot engage, which is the actionable
  half and is false — the breaker keys on `errorClass` over failures, and every failure has one.
  And it lands on a surface that is already hard-red, where a false ⚠️ competes with `[W18]` and
  `[W20]` for the operator's attention: the same displacement measured one fire earlier under
  LOOP-546.

  **The neighbouring arm is correct, which is the evidence that the relation was known.**
  `successRate` (`metrics.ts:223`) omits `timeouts` from its subtraction precisely because they are
  already inside `failures`. The subset relation is honoured in one file and lost in the other.

  Filed **LOOP-547** (Bug, `qa` owner, junior tier, P2), `relatedTo` LOOP-543 and cross-commented
  there. The two are separable and the dedupe note says so in both directions: LOOP-543 owns whether
  an exit-0 no-op fire should be ledgered as a success at all; LOOP-547 owns W24's arithmetic. If
  543's remedy assigns those rows an `errorClass`, W24's warning disappears as a side effect while
  the denominator stays wrong, so 547 is not closable on 543 landing without re-measuring its AC3.

- **2026-08-10 (pm, one-hundred-fifty-sixth fire) — the workspace health gate went hard-red on a
  registry row whose printed remedy cannot be performed, and the ❌ displaced both live day-2
  signals from the one line the operator acts on.**

  **What was measured.** At 2026-08-10T22:59:25.915Z a repo registry row was added to
  `dev-loop.json` — `repos.web.app`, `{"path": "dot-repo"}`, referenced by a new
  `projects.testproj` — pointing at a directory that does not exist. `dev-loop doctor` now exits
  **1** with `DOCTOR_FAILED`, and its closing line reads `NEXT: fix the ❌ first: repo 'web.app'
  path missing on disk … (clone it, or /dev-loop:sync-repo)`. The row carries **no `remote`**, so
  there is no source to clone from; both actions the message names are unavailable. `hub/src/
  doctor.ts:431` builds that string unconditionally — `r` is in scope and carries `remote`, and the
  message never reads it, so a recoverable row and an unrecoverable one print the same prescription.

  **The consequence is not confined to one line.** `nextStep` (`doctor.ts:305`) returns
  `fix the ❌ first: ${fails[0]}` at rung 1, above the entire day-2 ladder. Two day-2 conditions are
  live in this workspace right now — `[W20]` (LOOP-542, one item waiting on the operator) and
  `[W18]` (10 merged code commits not installed) — and neither can reach the `NEXT:` line while an
  unclearable ❌ holds rung 1. Rung 1 is the correct position for a ❌ that can be cleared; the
  defect is the ❌ that cannot be. Filed as **LOOP-546** (P2, junior), scoped to make the remedy
  remote-aware and to leave the ordering and the verdict untouched.

  **Attribution is not established, and the ticket does not depend on it.** Neither `testproj` nor
  `dot-repo` occurs anywhere in `origin/main:hub/`, so the row is not one of this repo's own test
  fixtures. Who registered it is the operator's question. Doctor's response to the row is wrong
  regardless of the answer, so LOOP-546 was scoped to the response alone.

  **A parked premise decayed while parked, and the version string could not see it.** LOOP-542 was
  filed at 22:36Z reading "7 code commits behind". Re-measured this fire: the installed build is
  `c7a9e11` (from `build-commit.json`), origin/main is `a6b0a60`, and the gap is **10 code commits
  (21 total)** — doctor's own `[W18]` agrees. The installed version string and the repo's
  `hub/package.json` are both `1.15.1`, so the version comparison reports no gap at all. The
  decisive check is content: `force-with-lease` appears 4× in `origin/main:hub/src/push.ts`
  (LOOP-536, merged as `a6b0a60`) and 0× in the installed `dist/push.js`. §9c re-measures a
  tracker's premise every fire, not only its symptom; this is the case where re-measuring moved the
  number in the wrong direction.

  **Correcting a premise in a comment does not retire the ticket that premise created.** LOOP-464
  (P1) was filed on provider credit exhaustion; its own 22:38Z comment recorded that credit is not
  exhausted ($4.19 remaining, HTTP 200) and that the fires carry no error to classify. The surviving
  scope — an exit-0 fire that produced nothing carries `errorClass: null`, so every liveness surface
  reads healthy — is LOOP-543's scope, measured over a wider window with the falsified causal claims
  already struck. Two P1s were therefore open for one detector, the older one still naming a cause
  its own comments disproved. LOOP-464 closed `Duplicate` of LOOP-543 this fire. The
  **`Blocked-by` edge is the part that does not close itself**: LOOP-483 was blocked by LOOP-464
  and LOOP-463 (`Done`). Retiring the LOOP-464 edge alone would have left one blocker, `Done`, and
  §9c would then read "≥1 blocker, all resolved" and auto-unpark LOOP-483 onto work nobody has
  done. The edge was re-pointed (`Unblocked-by: LOOP-464`, `Blocked-by: LOOP-543`) in the same pass,
  and LOOP-483 stays parked.

  **RULE 51 — when a ticket's premise is corrected, close or re-scope the ticket in the same pass,
  and walk its blocking edges before you do.** Rule 49 required a control before a diagnosis is
  recorded; rule 50 required the control to run first. Both govern the diagnosis. Neither reaches
  the artifacts an incorrect diagnosis already produced: the ticket it opened, its priority, and any
  `Blocked-by` edge pointing at it. A premise correction that stops at a comment leaves a P1 in the
  queue and a dependency aimed at a ticket that will never be worked. Max rule number is now 51.

- **2026-08-10 (pm, one-hundred-fifty-fifth fire) — a correctly-ranked queue can still hold six
  tickets it will never serve, and the loop had no way to see it.**

  **What was measured.** Six `Todo` tickets — LOOP-359/376/377/380/387/389 — have been junior-dev's
  ranks 2 through 7 since 2026-08-06 and carry **zero `In Progress` transitions in their entire event
  history**, 105.9 h for the oldest. They are not stranded, mis-tiered, blocked or invisible:
  `DEVLOOP_ACTOR=junior-dev dev-loop queue` serves them at the top of a 10-row arm on every fire.

  **Both controls were run this time, and both cleared the obvious suspects.** *Is the lane dead?* No
  — junior-dev claimed **29 distinct tickets** in the same window, including six P3s and a P4, so
  neither a priority floor nor the executor outage explains it. *Is the ranking broken?* No — of the
  seven claims junior made in the 5 h after the outage ended (18:21Z), **every one legitimately
  outranks LOOP-359**: `Bug` is rank 3 and P1 `Improvement` is rank 4.5, and all six starved tickets
  are ordinary `Improvement`s at rank 5. `PICK_RANK` is behaving exactly as written.

  **The finding is therefore structural, not a defect: rank 5 is a starvation class at the current
  filing rate.** An ordinary `Improvement` is reached only in a window where the tier has no
  outstanding `Bug` and no outstanding P1 `Improvement` — a window that has not occurred in 105
  hours. The generating rate behind that imbalance: **原因未查明**; this pass measured the effect only.

  **Why it is worth a ticket rather than a shrug.** Nothing measures it. W16 covers the neighbouring
  arm (a stale `In Progress` claim, LOOP-450); a `Todo` ticket never claimed at all has no age, no
  W-code and no digest line. So PM reads junior 10/10 as a healthy full queue when 6 of those 10 are
  provably unreachable, and promotes against a cap whose composition it cannot see. **LOOP-545**
  (P2, junior) asks for the measurement — a Todo-age W-code plus a per-tier unreachable count on the
  `queue` pm arm — and explicitly does **not** reopen `PICK_RANK` or `intake.todoDepthCap`, which
  remain the operator's standing §5/§5a ruling (LOOP-254). Observability first, so the ruling can be
  made from data instead of from a fourth PM fire re-deriving this table by hand.

  **What did not happen, deliberately.** The six were checked against reality before anything else:
  LOOP-359's prerequisite is satisfied and its edges retired, LOOP-376's defect was explicitly left
  behind by LOOP-385, LOOP-389 is distinct from LOOP-451. All six are live work. None was canceled,
  and **no priority was bumped** — re-ranking to beat the queue is the one remedy this board has
  already ruled out.

- **2026-08-10 (pm, one-hundred-fifty-fourth fire) — the fix for a stale diagnosis was a fresh
  diagnosis recorded just as uncritically: the replacement cause was never given a control case.**

  **What happened.** Last fire falsified "the lanes are dead because the provider is down" and replaced
  it with "the lanes are dead because `bootBytes: 0` — the boot corpus is never assembled, so the agent
  never starts." This fire falsified the replacement, one pass later, by bucketing the same ledger
  **hourly** instead of over 24 h. Two things fell: (1) the outage had **already ended** at
  2026-08-10T18:21:42Z — four hours before LOOP-543 was filed asserting the lanes "have been producing
  nothing for 62 hours" — and junior-dev posted a substantive decision on LOOP-517 at 22:50Z, thirteen
  minutes after that sentence was written; (2) `bootBytes: 0` holds on **345/345** opencode-lane fires
  in 24 h, the **309 broken ones and all 32 healthy ones alike**, so it separates `codingAgent:
  opencode` from `codingAgent: claude` and says nothing about health. Had it stood, LOOP-543's AC2 —
  "evidence: a ledger row for junior-dev with `bootBytes > 0`" — would have been **unsatisfiable**: no
  opencode fire has ever carried a non-zero value, working or not. LOOP-543 is retitled and re-scoped
  in place to the one claim that survived, and it is still P1.

  **What survived, and it is the part worth having.** **309 fires exited 0 having done nothing, every
  one carrying `errorClass: null`**, and no surface objected for 19.5 hours. The recovery did not fix
  that — the shape simply stopped occurring. The next executor outage of this shape will be exactly as
  invisible, which is why the ticket keeps its priority even though its symptom is gone.

  **Mints STANDING RULE 49 — a diagnosis needs a CONTROL CASE before it is written down.** Rule 48
  (minted last fire) says re-test the cause, not just the symptom. This is the failure one level up:
  the cause *was* re-tested, and the finding that replaced it was recorded as fact without ever being
  checked against a healthy instance. **A field that reads the same on every broken case proves nothing
  until you have looked at what it reads on a working one.** The two-line check that would have caught
  it — group the field by lane, not by outcome — costs less than the sentence it protects. Applies to
  every attribution this doc carries, not just this one.

  **A method note that generalises past this incident:** a 24 h aggregate cannot distinguish "dead now"
  from "was dead for 19 of the last 24 hours and recovered." Both readings were available last fire;
  only the aggregate was taken. **When a claim is about the PRESENT state of something, the window must
  be short enough that the present dominates it** — or bucketed, so a change of regime is visible
  rather than averaged away.

- **2026-08-10 (pm, one-hundred-fifty-third fire) — the loop spent 62 hours waiting out an outage that
  had already ended, because the diagnosis was recorded once and the symptom was re-measured forever.**

  **What happened.** Since 2026-08-08 16:36Z this doc has carried one explanation for three dead lanes:
  an OpenRouter outage. Every pass since re-measured the *symptom* (fires returning in ~6 s, unclassified)
  and none re-tested the *cause*. This fire I tested it directly: the key returns HTTP 200 with **$4.19
  of credit left**, and the configured model `deepseek/deepseek-v4-flash` returns a real completion. The
  provider has been healthy for some time. The lanes are killed locally, before boot — `bootBytes: 0`,
  and **exit 0**, so the ledger counts each one as a success. The two `claude` lanes produce none of
  this shape; all three `opencode` lanes produce ~125/24 h each. Filed as **LOOP-543** (senior-dev
  direct-code, P1); **LOOP-464**'s credit-exhaustion premise corrected in place rather than duplicated.

  **The rule this earns.** *A cause recorded as a fact decays exactly like a number.* This doc already
  requires re-measuring values each pass (rule 35); the same discipline was never applied to
  attributions, so "the provider is down" hardened into an assumption while its subject recovered.
  **When a condition persists, re-test what you believe is CAUSING it — not just that it is still
  happening.** A cheap live probe (one HTTP call) would have closed 62 hours of this at any point.

  **A second-order cost worth naming:** while the executor tier was dark, the two live lanes billed
  ~$350/24 h filing work the stalled half of the board cannot execute — so the backlog inflated with
  17 junior-tier P1s that provably cannot be promoted.

  **Direction question for the operator — the promotion cap has no priority or staleness component,
  and I am not deciding it.** Measured: `Todo` holds **0** P1s; `Backlog` holds **18**. §5a promotes
  only while depth is under the cap and provides no preemption, so a P1 filed after the cap saturated
  waits behind promoted P2/P3 work indefinitely — and this doc names P1 as the only lever that reaches
  a picker. The lever is inoperative on the junior tier. Fixing it means changing §5a, which is a
  `conventions.md` rule and therefore outside the §17 firewall: **not an agent's to change.** The
  options are (a) leave it — the cap is a WIP limit and a stalled executor is the real bug (LOOP-543),
  (b) give the cap a priority carve-out so a P1 can always be promoted, or (c) allow PM to de-promote a
  stale Todo ticket back to Backlog. Recorded here for a ruling; no change made.

  **One protocol lesson, from a wrong unpark this fire avoided.** LOOP-540 was the tracker blocking
  LOOP-396, and it closed — but it closed on the operator's disposition **(a)** (remove the login item),
  while LOOP-396 was waiting on disposition **(b)** (cut a release). The mechanical §9c rule ("all
  blockers terminal ⇒ unpark") would have released a ticket whose prerequisite is untouched; the
  installed CLI is still 7 code commits behind and its `push-guard` still predates LOOP-535. Re-blocked
  on **LOOP-542**, a tracker whose ACs cannot be met without the release. **A blocker edge is only valid
  while its tracker's close condition IMPLIES the dependent's prerequisite — never point an edge at a
  ticket that offers the operator a choice of dispositions.**

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
     stops a pick** (`servableSlice`/`todoDepth` read the label; §9c reads the marker). **LOOP-190**
     is `Done` as of 2026-08-10 — a close is not evidence the divergence stopped; re-derive against
     the tree before relying on it.
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
     (W36), and §12b applies the moment any one of them moves. **The axes also bind the machine that
     judges you (fire 138).** A write-layer gate runs on the INSTALLED axis, so a refusal can enforce
     a predicate the merged tree already replaced, phrased exactly as a current one would phrase it:
     LOOP-499's close was held over five tickets that HEAD's own derivation attributes to a different
     parent. Before acting on any gate's stated remedy, establish whether the gate's own axis is
     current — and never satisfy a refusal by making board changes the merged tree does not ask for.
  16. **A commit is not verified to carry one increment.** A shared checkout leaks an unrelated
     fire's uncommitted edits into the commit, and every gate — build, test, CRAP, review — passes on
     the union. `git apply --reverse --check` against the claimed diff is the decisive
     did-this-and-only-this-land test.
  17. **A test that hand-supplies the dependency the delivery path fails to supply can only test the
     callee.** Where the suspected defect is in the WIRING, the fixture must exercise the production
     caller; injecting the argument the caller never passes converts a caller bug into a green suite.
  18. **A `Mode: design` prefix at the START of a description is the switch that routes a parent into
     PM's slice; a `Bug` design parent routes to PM by CONTENT while the write gate authorises by
     LABEL, so a single-owner `qa` design parent is visible to PM and closable only by QA**
     (**LOOP-310** is `Done` as of 2026-08-10; verify against the tree, not against the close). Correct the owner labels to the dual set rather than working around it silently.
  19. **A dedupe note is a prediction about code that has not been written** — it claims a sibling's
     fix, as specified, leaves this defect standing. Test it by opening the sibling's ACs, never by
     comparing titles; and re-check it at promotion, because a ticket's premises decay.
     **This runs in both directions, and the reverse one is where the yield is.** When the dedupe
     hit means you file NOTHING, opening the sibling's ACs is still the job: the output of a §8 hit
     is either "its spec already covers this" or an amendment to that spec — never silence. A
     re-sweep that stops at "already filed" discards its own finding. Weight the sibling's prose by
     how it was obtained: a ticket's MEASURED claims age well, its ASSERTED ones are where the ACs
     inherit an error (LOOP-390 pinned the markup verbatim and asserted "the values are right", and
     only the asserted half produced a wrong AC).
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
     Closed this fire: the hint names the knob, and the row sits beside its siblings. **A discovery
     path that is DELIVERED ONCE is the same defect one step later** — `operatorBrief()` documents
     the approvals verbs, and `scaffoldOperatorBriefs` is create-only at all three call sites, so
     the guidance reaches only workspaces that do not exist yet (**LOOP-520**).
  30. **A change to a shared datum — new precision OR a new bound — is not done until every consumer
     of the old form is enumerated and moved.** `buildCommit` reached the wire and then one of three
     consumers (**LOOP-364**); the board's 250-row cap is disclosed correctly beside per-state counts
     computed from the truncated array (**LOOP-370**, caught by the columns summing to exactly the
     cap). Third instance: LOOP-219's discarded-spend basis and LOOP-239's priced-row denominator
     each reached `--flow`/`--cost` and not `renderHuman`, so ONE command published two values for
     one named quantity (**LOOP-514**). The cheap audit is a grep for the OLD form in the fire that
     introduces the new one — here, `meteredFires` beside every `costMeteredFires`.
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
     place, and LOOP-372 was `In Progress` when this was distilled (it is `Done` as of 2026-08-10):
     on the `origin/main` of that moment the regression test each specifies could not reproduce what
     it is written to catch. Ask whether a spun-off finding's evidence reproduces on
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
     LOOP-488). **And the named successor can be GONE:** LOOP-239's `Canceled` handed its remainder
     to LOOP-292, destroyed in the 2026-08-04 wipe — the comment still reads as routing while
     nothing carries the work (LOOP-514). Resolve the successor before reading a Cancel as closed.
     **The named owner can also be "the next fire", which names nobody.** Pass 107 left LOOP-499's
     refused close "recorded on the ticket so the next fire retries it"; the board carried it on no
     queryable surface — `decisionQueue` is `Human-Blocked ∪ In Review@operator` and the ticket is
     `In Review@senior-dev` — so for two fires the only carrier was PM's private `pm-state.json`
     (LOOP-525, LOOP-526). **A wait is routed only when it lands in a set someone else QUERIES**;
     a comment, a report line, or an agent's own state file is memory, not routing. Its sibling:
     an exit condition is verified on the axis that will actually serve the code — pass 107's
     reinstall test was correct for the installed tree and silent about the running daemon, which
     loads that tree once at boot.
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
  - **2026-08-09 → 08-10** (fires 92–152; R2 passes 100–126) — the per-fire journals of the
    failure-taxonomy, release-axis, unpark-edge and design-gate arcs → `2026-08.md`. Rolled at pass
    130, when these 25 entries were 850 lines / 76.4 KB — 39% of the whole doc. Doctrine already
    distilled into the STANDING RULES above; no rule was retired by the roll.
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


- **Should the release cadence stay a human act? A `Goals`-level question for the operator, named
  rather than filed (2026-08-11, pass 127).** landing-observability §9.7 kept the human release gate
  **deliberately** and priced that choice as *"make when to pull it a one-look call"* — W18
  (LOOP-46), the `NEXT` hint (LOOP-167) and the npm-aware remedy (LOOP-247) are all instalments on
  that promise. The evidence now says the gate is not being pulled: **two release trackers in seven
  days** (LOOP-525, LOOP-542), each a Human-Blocked park that stalled the whole PR queue while it
  stood, and between them the published artifact drifted **55 code commits** behind `origin/main`
  with the loop's own instruments silent (LOOP-549). A one-look call nobody looks at is a cadence
  problem, not an observability one — but reversing a recorded design decision is not PM's to make.
  **REVERSAL CONDITION: the operator rules on whether publishing should be automated** (e.g. a
  tag-triggered `release-npm.yml` on a green `main`, or a scheduled release PR) — and if the answer
  is that it stays human, whether an un-cut release should escalate on a **clock** rather than
  waiting for a fire to notice. **File nothing against this until LOOP-549 has landed**: it makes
  the gap measurable, and a cadence argument should be made against a real series, not two
  anecdotes.

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

