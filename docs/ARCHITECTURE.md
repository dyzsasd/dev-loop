# dev-loop — Architecture & design

> How dev-loop works inside: the layers, the agents, the coordination protocols, the backends,
> and the self-evolution loop. **If you just want to USE dev-loop, start at the
> [README](../README.md)** — this document is the deep dive. The authoritative agent spec is
> [`references/conventions.md`](../references/conventions.md); per-milestone design records live
> in [`docs/design/`](design/).

## What it is

dev-loop is a **standalone npm package plus optional coding-CLI plugins/skills** made of
role-specialized agents: Product Manager, QA, Developer(s), and a few coordinators. Together
with a small set of conventions, they can run a
complete software-development lifecycle **without a human in the inner loop**. You provide the
product, the strategy doc, and the autonomy settings; the loop turns that into shipped,
verified increments and records what it learned.

It is deliberately **substrate-agnostic**. New 1.x workspaces normally coordinate through
**Linear** or the bundled **service hub**: a system of record over `node:sqlite` with
per-agent identity and a localhost web UI, reached by agents through the `dev-loop` CLI by
default (an MCP server remains as a sibling thin client over the same op layer). The legacy machine-local file board is still
described in [`references/conventions.md`](../references/conventions.md) for compatibility, but
it is not the recommended path for new workspaces. The agents and protocols stay the same.

Three rules stay true everywhere:
- **The board is the channel** — agents hand work off through ticket state, not direct calls.
- **Each run starts fresh** — agents are stateless; they re-read the board, git, and disk every
  time, so a crash, reboot, or context compaction does not corrupt the loop.
- **Autonomy means gates, not prompts** — under `autonomy:"full"` the agents decide and act, but
  a red build never ships, a failed deploy rolls back, and a genuinely human-only decision is
  parked on the ticket as a fact instead of becoming an interactive prompt.

## Architecture — three layers

dev-loop is three layers; the `npm i -g @dyzsasd/dev-loop` package ships all three:

1. **Interface — the `dev-loop` CLI + the MCP.** The operation surface. The `dev-loop` command
   (`init` · `team` · `run` · `hub` · `doctor` · `metrics` · `notify` · …) is how *you* drive setup
   and scheduling — and, since the CLI-first flip (D8), how the *agents* read and write the hub board
   by default too (the `dev-loop` write verbs, identity from the fire env). The `dev-loop-hub`
   **MCP** server remains a sibling thin client over the same op layer — the transport for
   `"mcp"`-interface fires (the `hub.agentInterface` rollback switch) and external MCP hosts;
   Linear-backend agents keep coordinating through the **Linear** MCP. Low-level
   commands such as `serve`, `daemon`, `seed`, `init-service`, and `mcp-merge` remain available for
   compatibility/debugging, but the 1.x operator path starts with the `dev-loop init` guided wizard
   (`team init` and friends are its composable pieces).
2. **Hub — the backend service.** A local system-of-record over `node:sqlite` (the `service`
   backend) that powers the **ticket system** and the **document system** (strategy/roadmap/design,
   versioned), and maintains the **per-project namespace** — each project's board, actors, and docs
   are isolated. It runs as a localhost daemon with a read-mostly, multi-project web UI
   (project-scoped `/p/<key>/` routes; doc edit/publish is a double-gated opt-in). *(Linear or a machine-local
   file board are alternative ticket backends in the shared conventions; the hub is the one that
   adds per-agent identity, the doc system, and the namespace.)*
3. **Agents — skills + plugin + scheduler.** The role-specialized agents are a set of **SKILLs**
   (packaged as the Claude **plugin**) plus the **scheduler** (`dev-loop run`). You normally start
   the loop with the `dev-loop run` scheduler; Claude Code Agent View can also run the installed
   plugin rows directly. See the [README](../README.md) quick start and
   [`RUNNING.md`](RUNNING.md) for launch details.

## How it works

- **Owner labels route the work.** `pm` owns Features and `qa` owns Bugs. The **owner files
  and verifies**; Dev implements tickets for both. That is how a finished build gets back to
  the person responsible for signing it off.
- **One label is the firewall.** Agents touch **only** tickets carrying the `dev-loop` label,
  scoped to the configured project — never your human backlog.
- **The loop improves itself carefully.** `reflect-agent` studies the loop's behavior and
  curates a per-operator `lessons.md` that every agent reads on the next run. It may edit that
  file autonomously, but it **never** rewrites the agents' own instructions; structural changes
  are proposed for a human to apply.
- **You steer by reviewing.** Agents write daily, weekly, and monthly reports. Add a **点评**
  (critique) next to one, and the agent distills it into a `lessons.md` rule it follows from
  then on. For a **direction change**, file a `needs-pm` + `investigation` ticket: PM
  investigates, proposes the doc change on the ticket (a hub draft or a unified diff), and only
  your version-bound approval publishes it — agents pick the new direction up on the next fire.

---

## The agents

Five **inward** (build-facing) agents, a default **two-tier Dev**, three **outward**
agents, and a one-time **setup** command. Every agent reads
[`references/conventions.md`](../references/conventions.md) first — the full state machine,
label taxonomy, ticket templates, and protocols.

### Inward — the build loop

| Agent | What it does |
|---|---|
| **`pm-agent`** | Reads the strategy doc, exercises the real product, files **Feature** tickets, proactively proposes improvements, **verifies** features that reach `In Review`, unblocks its own blocked tickets, and keeps the strategy doc current. Routes each ticket to a dev tier when the two-tier Dev is on. Respects `intake.mode`: under `"passive"` it originates nothing and only responds to explicit `needs-pm` intake (verification, unblocking, and grooming continue). |
| **`qa-agent`** | Runs happy-path + edge-case tests in the configured test env, files **Bug** tickets (and `drift` → Improvement), **re-tests** bugs at `In Review`, routes each filed ticket to a dev tier, and clears info-blocks for Dev. |
| **`dev-agent`** | Legacy single-Dev fallback. Pulls `Todo` tickets in priority order, grooms, implements, gates on build/test, self-reviews, ships per config, smoke-checks prod, and hands off to `In Review`. Use it only with `devSplit:false` / `--agents legacy`; the default `core` loop uses senior-dev + junior-dev. |
| **`sweep-agent`** | Lifecycle janitor (slower cadence). Fixes the cracks: missing/wrong owner or **dev-tier** labels (invisible to every query → stranded), orphaned `In Progress` from crashed runs, stale signals, board-health reports. On the hub backend it also runs the optional **one-way Linear mirror** push. Hygiene only. |
| **`reflect-agent`** | Retrospective + self-evolution (daily). Studies the loop's **own** behavior and curates `lessons.md` from recurring, evidence-cited patterns. Observe + curate only; may autonomously edit only `lessons.md` — structural changes are drafted as proposals, never auto-applied. |

### Two-tier Dev — default

Split the single Dev into a design lead and an implementer so the expensive model concentrates
on architecture and the cheaper one does the bulk coding. `dev-loop run --agents core` starts this
pair by default. Use `--agents legacy` only for the old single-Dev loop.

| Agent | What it does |
|---|---|
| **`senior-dev-agent`** | **Senior tier (opus, effort max).** Two modes: **design-and-delegate** — for a new module/feature, author a living per-module **design doc**, spawn staged `Backlog` child tickets assigned to junior-dev (each carrying a `Design:` pointer), and move the design parent → `In Review` for PM to gate; and **direct-code** — when escalated a real junior verify-fail, implement → gate → ship itself. |
| **`junior-dev-agent`** | **Junior tier (sonnet, effort high).** Picks junior-routed `Todo` tickets, **reads the linked `Design:` pointer before coding**, implements against the design, runs the same gates/ship flow as dev-agent, hands off to `In Review`. Bails (info-needed) on an ambiguous spec rather than guessing. |

### Outward — observe and explain

| Agent | What it does |
|---|---|
| **`ops-agent`** | Watches **running prod** (tight ~10–15 min cadence). Polls health checks + base URL + optional critical routes/logs and, on a **confirmed, repeated** degradation (anti-flap re-check first), files/refreshes an `incident` Bug (Urgent when prod is down). Observe-and-file — never rolls back. |
| **`architect-agent`** | Whole-codebase **tech-health auditor** (slow, daily-ish). Audits a **rotating** dimension (drift / duplication / dead code / dep-staleness + CVEs / consistency / missing abstractions), SHA-gated, and files `tech-debt` Improvements. Read-only on code — never implements. |
| **`communication-agent`** | The PR/media lead. Reads strategy, roadmap, shipped work, and public-safe product facts, then drafts one public-facing product article per cadence (daily by default). Draft-only: never publishes externally, never commits/pushes/deploys, never verifies. Can run from Codex with `DEVLOOP_ACTOR=communication`. |

### Setup — not loop agents

| Command | What it does |
|---|---|
| **`dev-loop init`** | The guided, resumable setup wizard — the primary path. Composes `team init` → the first `add-project` (auto-seeded on `service`) → an offered `add-repo --detect` → the Claude permissions entry, and ends with doctor's `NEXT:` line; `--yes` yields a runnable service workspace non-interactively. |
| **`dev-loop team init`** | Pure CLI workspace creation. Writes `dev-loop.json` and workspace state scaffolding; does not call an LLM and does not touch Linear (on a `service` backend it initializes `hub.db` and seeds the `_team` intake row). |
| **`/dev-loop:add-project`** | Operator-present coding-CLI skill. Finds or creates the backend project, ensures labels, scaffolds the strategy doc, interviews project settings, and writes the validated project config. |
| **`/dev-loop:add-repo`** | Operator-present coding-CLI skill. Clones/registers a repo, detects build/CI/deploy/health facts, appends current-state notes, and writes the validated repo config. |

---

## The workflows

The agents are intentionally simple. The value comes from the **workflows**: agents reacting
to ticket state without a central orchestrator.

### 1. The core build loop
PM (from the strategy doc) and QA (from testing) file tickets into **`Backlog`**; PM grooms,
dedupes, and **promotes to `Todo`** at pace under a depth cap (Backlog-first intake) → Dev
claims in priority order → `In Progress` → ships → `In Review` → the **owner** verifies (PM
for a Feature, QA for a Bug). **Pass → `Done`. Fail → close + file a follow-up** (a failed
increment is *superseded, never silently reopened*, so history shows what shipped-but-failed
vs what's queued). A project can also run **passive intake** (`intake.mode:"passive"`): PM
originates no work of its own and only responds to explicit `needs-pm` asks, while
verification, unblocking, and grooming continue unchanged.

### 2. Two-tier Dev — design-and-delegate *(default)*
For a **new module or feature**, PM routes the ticket to **senior-dev**. Senior authors a
living **design doc**, decomposes it into concrete child tickets **staged in `Backlog`**
(unpickable), each carrying a `Design:` pointer, and moves the design parent → `In Review`.
**PM gates the design** (you sign off for big modules); on pass, the children **promote
`Backlog` → `Todo`** and **junior-dev** picks them, reads the design, and implements. The
expensive model designs once; the cheap model codes the pieces.

### 3. Escalation — junior → senior → human
When **junior-dev**'s work fails verification on a **real** acceptance-criteria miss (not a
flaky/infra blip — that just retries), the verifier (PM for a Feature/Improvement, QA for a
Bug) cancels it and files a **senior-dev direct-code** follow-up; senior codes it itself. If
the senior fix *also* fails → `fix-exhausted` → **`Human-Blocked`** (you). The cheap tier
tries first; the expensive tier is the safety net; you are the terminal.

### 4. Onboarding — workspace → project → repos
Wire a product into the loop once: run **`dev-loop init`** — the guided, resumable wizard
composes `team init`, the first `add-project` (auto-seeded on `service`), an offered
`add-repo --detect`, and the Claude permissions entry, ending with doctor's `NEXT:` line.
The operator-present `/dev-loop:add-project` + `/dev-loop:add-repo` skills remain the
LLM-assisted path (they inspect code, interview you about build/deploy details, and do the
backend sync — the plugin/MCP setup they need is only required for the `linear` backend).

### 5. Self-evolution — report → 点评 → lesson → behavior
Every agent writes reports; Reflect distills recurring patterns into `lessons.md`; you drop a
**点评** next to any report and the agent turns your critique into a `lessons.md` rule it obeys
thereafter. The loop gets better without anyone editing skill files — and **never** rewrites
its own core instructions autonomously (those are proposed for a human).

### 6. Outward monitoring — prod & codebase health
**Ops** watches running prod and files an `incident` Bug on a confirmed degradation (which
re-enters the core loop as a Bug). **Architect** audits a rotating slice of the codebase and
files `tech-debt` Improvements. **Communication** drafts the daily public product article
from verified, public-safe facts. None of them implements or publishes externally.

### 7. Human-park & notify
A genuinely human-only block (a credential, a legal sign-off, an external prerequisite) parks
the ticket — `Human-Blocked` on the hub, or `blocked`+`needs-pm` on Linear/local — and an
optional **Slack/Lark webhook** pings you out-of-band so it never sits unseen.

### 8. Mirror — hub → Linear *(hub backend)*
The hub can push its tickets one-way into Linear for human visibility (idempotent, incremental,
split-brain enforced — Linear is never read back as truth). Run the loop on the fast local hub,
watch it in Linear.

### 9. Observe — the localhost web UI *(hub backend)*
A persistent localhost daemon serves a read-mostly board, ticket detail, the versioned doc
pages (strategy/roadmap/design — viewing always; editing/publishing only behind the explicit
double opt-in), reports, and an activity/throughput view over the same SoR — project-scoped
under `/p/<key>/` with a server-side project index landing — so you *watch* the loop without
touching it. Agents coordinate through the CLI/op API (or MCP), never through the human web UI.

---

## Use cases

**Use dev-loop when** the work repeats, "done" can be checked by a machine, and the output is
worth the tokens. In practice, that means:

- **A continuously-maintained product.** Point PM at a strategy doc and let the loop ship
  features, fix the bugs QA finds, and keep prod healthy — you review, you don't hand-code.
- **A backlog you keep falling behind on.** CI failures, dependency upgrades, a class of
  recurring bug, drift cleanup — file them (or let QA/Architect find them) and the loop
  drains the queue while you sleep.
- **A new module or large feature.** Turn on the two-tier Dev: senior-dev designs it and
  decomposes it; junior-dev builds the pieces; you gate the design and review the result.
- **Whole-codebase hardening.** Let Architect audit a rotating dimension daily and file the
  tech-debt; the loop pays it down a verified increment at a time.
- **Always-on prod watch.** Ops turns a confirmed degradation into an `incident` Bug that
  re-enters the loop — monitoring that *acts*, not just alerts.
- **Multi-repo products.** One product, many repos: tickets target a repo via a label, with
  per-repo build/branch/deploy.

**Do not use it** when "done" is mostly subjective, the task is a one-off, or the output cannot
be rejected automatically. Without real verification, a loop just produces more questionable
work at a higher rate.

> **Cost is real.** Tokens are the running cost, and *frequency* usually dominates it. A tight
> cadence across many agents on the strongest model adds up quickly. Use role-appropriate
> **models/efforts** for mechanical roles, choose a sane cadence, and watch the
> **acceptance rate** (verified ÷ filed):
> below roughly 50%, the loop is creating review work instead of saving it.

---

## Backends

Coordination is pluggable; the agents and protocols are identical across the current 1.x
operator-facing backends. The legacy `local` file board is kept in the conventions for
compatibility and historical context.

| Backend | What it is | Gives you |
|---|---|---|
| **`linear`** *(default)* | Coordinate through the Linear MCP | Cloud, team-visible, the Linear app as UI |
| **`service`** | A local **hub** — a system-of-record over `node:sqlite`, reached through the `dev-loop` CLI by default (MCP sibling) | **Real per-agent identity**, a localhost multi-project **web UI**, versioned operator-published docs, the one-way Linear mirror, CLI-portability |
| **`local`** *(legacy compatibility)* | A machine-local markdown file board in the data dir | Zero-cloud, minimal, no web UI/identity; not recommended for new workspaces |

The **work plane** (states, transitions, responsibilities, and the agent loop) is identical
across backends. The **surface plane** (per-agent identity, web UI) expands by
backend. See [conventions §18](../references/conventions.md) +
[`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md).

### Parity in detail — and switching (operator decisions)

The backends are **unified on the work plane and honestly divergent on the surface plane** —
naming the line is what keeps "the same loop, three substrates" a real guarantee rather than a
slogan.

- **The WORK PLANE is identical** across `linear`/`local`/`service`: the state set + legal
  transitions (§3, incl. the verify-fail close+follow-up rule), who-does-what (Dev claims/ships,
  PM/QA verify, §5 pick order, §7 claim, §8 dedupe), the agent loop, §9a human-intake, the §4
  label taxonomy, and reports (§22/§23 — `reports.sink` is backend-decoupled). This is the bulk
  of the loop and it is a contract, not a coincidence.
- **The SURFACE PLANE is a deliberate per-backend superset**, and parity there is genuinely
  impossible (not a missing feature): real **per-agent identity** + the **web UI/observability**
  + versioned operator-published hub docs are **`service`-only**; cloud **human-visibility** + the native
  Linear app are **`linear`-only**; `local` is the zero-cloud floor (and the one backend with no
  board view — steer a "no-cloud but I want a UI/identity" operator to `service`, not `local`).
- **Operator-notification is a cross-backend floor:** the one-way webhook alert (DL-52 transport +
  DL-59 daemon-reads-`notify`), realized on `service` via the `channel.*` tools as the §9 notify
  transport. See §9 for the unified `{transport}` model.

**Switching a team's backend is chosen at init — changing it later is a data migration, not a
config edit (deferred).** `backend` is set once at `dev-loop team init`; flipping it on a team that
**already has tickets** is out of scope today. The only cross-store seam is the **one-way
hub→Linear `mirror` (a projection for human visibility, not a bridge)** — Linear is never read
back as truth (split-brain is enforced). A future importer **cannot preserve source ticket ids as
the primary key**: hub ids are a **global key** minted from `ticket_prefix`+`ticket_seq` and
`seed.ts` hard-throws on a prefix clash, so e.g. a `CIT-345` reassigns to `<PREFIX>-N` and the
source id must ride as a separate **`externalId`** — a data-fidelity loss, not just orphaning.
**If the operator wants Linear visibility without migrating ⇒ `service` + `mirror`.**

(Moved here from conventions §18 by the 2026-07 progressive-disclosure pass: choosing and
switching backends is operator material — agents never do either.)

### Loop-governance rails are `service`-only

The runaway/quality rails are built on the hub, so they exist **only** on `backend:"service"`.
For an **unattended** loop, run `service` — the scheduler prints a warning if you run `linear`/`local`.

| Rail | `linear` | `local` | `service` |
|---|:---:|:---:|:---:|
| **Verify gate** (In Progress→Done blocked; Done only via In Review, DL-77) | — | — | ✅ |
| **No-progress circuit breaker** (alert on 0 accepted change in a window, DL-76) | — | — | ✅ |
| **Human-Blocked reminders** (DL-26) | — | — | ✅ |
| **Accept-rate / cycle-time / WIP-aging metrics** (`/activity`) | — | — | ✅ |
| **Per-fire cost/outcome telemetry** (`fire.completed`) | — | — | ✅ |
| **Per-agent identity + attribution** | shared Linear id | run token | ✅ real |
| Convention-only gates (green-build-to-ship, verify-by-owner, the `dev-loop` firewall) | ✅ | ✅ | ✅ |

## Safety boundary

The agents operate **only** on tickets carrying the **`dev-loop`** label, scoped to the
configured project. They never read, transition, or comment on any other ticket. This single
label is the firewall between the loop and your human backlog; treat it as part of the safety
model.

## Self-evolution

`reflect-agent` is what lets the loop improve without drifting into chaos:
- It reads the loop's **own** output and distills **recurring** patterns (≥2 occurrences,
  each citing ticket IDs / commit SHAs) into `lessons.md` — the per-operator override every
  agent reads at the top of every run.
- **The hard boundary** ([conventions §17](../references/conventions.md)): Reflect may edit
  `lessons.md` autonomously (local, reversible, never committed) but **must not** auto-rewrite
  the SKILLs or `conventions.md`. Structural changes are **drafted as proposals** for the
  operator to apply by git commit. Self-modification of the core is *surfaced, not executed* —
  the one principled exception to "decide and act".

## Reports & operator review (点评)

You steer the loop by reviewing its trail, not by editing code inside the loop.
- **Reports.** Each agent writes a daily log rolled up weekly/monthly under
  `<workspace>/.dev-loop/<project-key>/reports/<agent>/` — machine-local, never committed,
  secret/PII-safe. A no-op fire writes nothing.
- **点评.** Drop a sibling `<report>.review.md` with free-form prose; at its next run the
  agent distills your critique into one `lessons.md` rule under its own section and obeys it
  thereafter. The whole loop: **report → your 点评 → lesson → changed behavior.**
- **Cloud/remote?** Set `reports.sink:"linear"` and reports become per-agent Linear documents
  with the 点评 as a comment — read and critique from a browser/phone (same firewall, §16
  guardrails).

## Codex integration (optional)

The loop can use **OpenAI Codex** as a power tool via the
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) companion + the `codex` CLI.
**Opt-in; absent means unchanged.** It adds, each independently gated, an **independent
second-model review** (Dev Step 5.5 + Architect; advisory, never touches the board),
**image generation** (PM mockups + Dev production assets — the one thing the loop can't do
itself), and a one-shot **rescue** before a `fix-exhausted` block. See
[conventions §24](../references/conventions.md) + [`references/codex-integration.md`](../references/codex-integration.md).

Separately, the `service` hub can run the agents themselves from Codex (Mode B); see
[`PORTABILITY.md`](PORTABILITY.md). Run any agent there with, e.g.,
`dev-loop run --cli codex --agents communication` — the scheduler carries the per-agent
identity itself (exported in the fire env on the default `"cli"` interface, certified
2026-07-11; injected as `-c` MCP overrides on the `"mcp"` rollback), so no manual Codex
config is needed.

## Status

**1.2.0.** Nine launchable agents — **PM / QA / senior-dev / junior-dev / Sweep / Reflect /
Ops / Architect / Communication** — run under the workspace model: one `dev-loop.json`
workspace, one team, one backend, and real repos cloned inside the workspace. Coordination is
backend-pluggable between **Linear** and the **local service hub** (`node:sqlite` SoR with
per-agent identity, a multi-project localhost web UI + docs system, Linear mirror, and CLI
portability); on the hub, agents read and write through the `dev-loop` CLI by default
(claude and codex both certified — `hub.agentInterface` is the rollback switch).
Autonomy for push/deploy remains opt-in and gated on a green build. Full history in
[`CHANGELOG.md`](../CHANGELOG.md).
