# dev-loop

**English** · [中文](README.zh-CN.md) · [Français](README.fr.md)

**Ten autonomous agents that build and improve software on their own, coordinated entirely
through ticket state.** You write the intent (a strategy doc) and review the output; the
agents propose, implement, verify, ship, and learn — in a loop. This is *loop engineering*:
you stop hand-prompting a coding agent and instead run a system that prompts itself.

The agents never call each other. The **board is the only channel** — every agent reads and
writes ticket state (plus git), so any agent can run at any time, in any order, even
concurrently. A ticket's labels carry everything: eligibility, owner, routing, dev-tier.

```
        PM ──proposes feature──┐                 ┌──QA proposes bug──┐
                               ▼                 ▼                   │
   strategy doc ──►  [Todo] ◄────────── grooming / unblock ─────────┘
                       │
        Dev claims ────┼──► [In Progress] ──ships──► [In Review]
                       │                                  │
            (dup/blocked)                    owner verifies (PM↔feature, QA↔bug)
                       ▼                          │            │
                 [Canceled/Duplicate]          pass▼        fail▼
                                               [Done]    back to [Todo]
```

---

## Table of contents

- [What it is](#what-it-is) · [How it works](#how-it-works)
- [The agents](#the-agents) — the full roster
- [The workflows](#the-workflows) — how the agents actually combine
- [Use cases](#use-cases) — when (and when not) to reach for it
- [Quick start](#quick-start) · [Requirements](#requirements) · [Install](#install) · [Configure](#configure)
- [Set up a project](#set-up-a-project) · [Run the loop](#run-the-loop)
- [Backends](#backends) · [Safety boundary](#safety-boundary) · [Self-evolution](#self-evolution)
- [Reports & operator review (点评)](#reports--operator-review-点评) · [Codex (optional)](#codex-integration-optional)
- [Deep docs](#deep-docs) · [Status](#status)

---

## What it is

dev-loop is a **Claude Code plugin**: a set of role-specialized agents (Product Manager,
QA, Developer(s), and several coordinators) plus a small set of conventions that let them
run a complete software-development lifecycle **without a human in the inner loop**. You
supply a product, a strategy doc, and the autonomy dials; the loop turns intent into shipped,
verified increments and writes back what it learned.

It is deliberately **substrate-agnostic**: coordination runs through **Linear** (default), a
**machine-local file board**, or a **local hub** (an MCP system-of-record over `node:sqlite`
with real per-agent identity + a localhost web UI). Same agents, same protocols.

Three things stay true everywhere:
- **The board is the channel** — no agent calls another; they hand off through ticket state.
- **Each fire is fresh** — agents are stateless per run; they re-read ground truth (board +
  git + disk) every time, so a crash, a reboot, or context-compaction mid-task is a non-event.
- **Autonomy is gates, not prompts** — under `autonomy:"full"` the agents decide and act; a
  red build never ships, a failed deploy auto-reverts, and a genuinely human-only decision is
  *parked on the ticket as a fact*, never an interactive prompt.

## How it works

- **Owner labels route the work.** `pm` owns Features, `qa` owns Bugs; the **owner files
  and verifies**, Dev implements everyone's tickets. That's how a finished build finds its
  way back to whoever signs it off.
- **One label is the firewall.** Agents touch **only** tickets carrying the `dev-loop` label,
  scoped to the configured project — never your human backlog.
- **The loop improves itself.** `reflect-agent` studies the loop's own behavior and curates a
  per-operator `lessons.md` every agent obeys next run. Its hard limit: it may edit
  `lessons.md` autonomously but **never** rewrites the agents' own instructions — structural
  changes are *proposed* for a human, never auto-applied.
- **You steer by reviewing, not editing code.** Every agent writes daily / weekly / monthly
  reports; drop a **点评** (critique) next to one and the agent distills it into a `lessons.md`
  rule it obeys thereafter.

---

## The agents

Five **inward** (build-facing) agents, an optional **two-tier Dev**, three **outward**
agents, and a one-time **setup** command. Every agent reads
[`references/conventions.md`](references/conventions.md) first — the full state machine,
label taxonomy, ticket templates, and protocols.

### Inward — the build loop

| Agent | What it does |
|---|---|
| **`pm-agent`** | Reads the strategy doc, exercises the real product, files **Feature** tickets, proactively proposes improvements, **verifies** features that reach `In Review`, unblocks its own blocked tickets, and keeps the strategy doc current. Routes each ticket to a dev tier when the two-tier Dev is on. |
| **`qa-agent`** | Runs happy-path + edge-case tests in the configured test env, files **Bug** tickets (and `drift` → Improvement), **re-tests** bugs at `In Review`, routes each filed ticket to a dev tier, and clears info-blocks for Dev. |
| **`dev-agent`** | Pulls `Todo` tickets in priority order, grooms (enough info? duplicate? done?), implements, gates on build/test, **self-reviews the diff**, ships per config, **smoke-checks prod (auto-revert on a break)**, hands off to `In Review`. Blocks rather than guesses. The default single Dev; stays active as the fallback when the two-tier split is off. |
| **`sweep-agent`** | Lifecycle janitor (slower cadence). Fixes the cracks: missing/wrong owner or **dev-tier** labels (invisible to every query → stranded), orphaned `In Progress` from crashed runs, stale signals, board-health reports. On the hub backend it also runs the optional **one-way Linear mirror** push. Hygiene only. |
| **`reflect-agent`** | Retrospective + self-evolution (daily). Studies the loop's **own** behavior and curates `lessons.md` from recurring, evidence-cited patterns. Observe + curate only; may autonomously edit only `lessons.md` — structural changes are drafted as proposals, never auto-applied. |

### Two-tier Dev — optional (opt-in per project)

Split the single Dev into a design lead and an implementer so the expensive model concentrates
on architecture and the cheaper one does the bulk coding. Enable with `DEV_SPLIT=1` on the
launcher; the legacy single `dev` stays the default, so non-split projects are unaffected.

| Agent | What it does |
|---|---|
| **`senior-dev-agent`** | **Senior tier (opus, effort max).** Two modes: **design-and-delegate** — for a new module/feature, author a living per-module **design doc**, spawn staged `Backlog` child tickets assigned to junior-dev (each carrying a `Design:` pointer), and move the design parent → `In Review` for PM to gate; and **direct-code** — when escalated a real junior verify-fail, implement → gate → ship itself. |
| **`junior-dev-agent`** | **Junior tier (sonnet, effort high).** Picks junior-routed `Todo` tickets, **reads the linked `Design:` pointer before coding**, implements against the design, runs the same gates/ship flow as dev-agent, hands off to `In Review`. Bails (info-needed) on an ambiguous spec rather than guessing. |

### Outward — observe, coordinate, direct

| Agent | What it does |
|---|---|
| **`ops-agent`** | Watches **running prod** (tight ~10–15 min cadence). Polls health checks + base URL + optional critical routes/logs and, on a **confirmed, repeated** degradation (anti-flap re-check first), files/refreshes an `incident` Bug (Urgent when prod is down). Observe-and-file — never rolls back. |
| **`architect-agent`** | Whole-codebase **tech-health auditor** (slow, daily-ish). Audits a **rotating** dimension (drift / duplication / dead code / dep-staleness + CVEs / consistency / missing abstractions), SHA-gated, and files `tech-debt` Improvements. Read-only on code — never implements. |
| **`director-agent`** | The human-facing **coordinator of DIRECTION** (hub backend; daily/on-demand). Chairs a cross-agent **discussion board** (opens topics → role-lens agents post per round → synthesizes → a **decision**) and **drafts** the roadmap the **operator publishes**; over an optional **two-way Lark/Slack channel** the operator chats with it. Coordinates + drafts — never implements/ships/verifies. No `director` config ⇒ graceful no-op (PM owns strategy). |

### Setup — not a loop agent

| Command | What it does |
|---|---|
| **`/dev-loop:init`** | One-time, idempotent, operator-present setup. Runs **DETECT → MAP → ASSEMBLE → LOAD**: detect the project shape (greenfield / brownfield / adopting; single- or multi-repo), read-only-map a brownfield codebase into the PM doc-base, gather config, ensure labels + the project, scaffold the strategy doc + runtime files, optionally adopt named human tickets (per-ticket confirmation), and print a readiness checklist. Never files tickets, verifies, or ships. |

---

## The workflows

The agents are simple; the **workflows** are where the value is. Each is just agents reacting
to ticket state — no orchestrator.

### 1. The core build loop
PM (from the strategy doc) and QA (from testing) file `Todo` tickets → Dev claims in priority
order → `In Progress` → ships → `In Review` → the **owner** verifies (PM for a Feature, QA for
a Bug). **Pass → `Done`. Fail → close + file a follow-up** (a failed increment is *superseded,
never silently reopened*, so history shows what shipped-but-failed vs what's queued).

### 2. Two-tier Dev — design-and-delegate *(opt-in)*
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

### 4. Onboarding — `init` (DETECT → MAP → ASSEMBLE → LOAD)
Wire a product into the loop once: detect its shape, map a brownfield codebase into the PM
doc-base (or interview a greenfield one), provision labels/project, scaffold the strategy doc
+ runtime files, and print a readiness checklist — before you flip `mode:"live"`.

### 5. Self-evolution — report → 点评 → lesson → behavior
Every agent writes reports; Reflect distills recurring patterns into `lessons.md`; you drop a
**点评** next to any report and the agent turns your critique into a `lessons.md` rule it obeys
thereafter. The loop gets better without anyone editing skill files — and **never** rewrites
its own core instructions autonomously (those are proposed for a human).

### 6. Direction — the discussion board & roadmap *(hub backend)*
The **Director** opens a **topic**, the role-lens agents post a perspective per round, the
Director **synthesizes a decision** and **drafts** the roadmap; the **operator publishes** it.
Optionally the operator chats with the Director over a **two-way Lark/Slack channel**. Strategy
becomes a deliberated, operator-gated artifact rather than one agent's guess.

### 7. Outward monitoring — prod & codebase health
**Ops** watches running prod and files an `incident` Bug on a confirmed degradation (which
re-enters the core loop as a Bug). **Architect** audits a rotating slice of the codebase and
files `tech-debt` Improvements. Both observe-and-file; neither implements.

### 8. Human-park & notify
A genuinely human-only block (a credential, a legal sign-off, an external prerequisite) parks
the ticket — `Human-Blocked` on the hub, or `blocked`+`needs-pm` on Linear/local — and an
optional **Slack/Lark webhook** pings you out-of-band so it never sits unseen.

### 9. Mirror — hub → Linear *(hub backend)*
The hub can push its tickets one-way into Linear for human visibility (idempotent, incremental,
split-brain enforced — Linear is never read back as truth). Run the loop on the fast local hub,
watch it in Linear.

### 10. Observe — the localhost web UI *(hub backend)*
A persistent localhost daemon serves a read-only board, ticket detail, the roadmap editor,
reports, and an activity/throughput view over the same SoR — so you *watch* the loop without
touching it. The agents stay daemon-free (they coordinate through MCP, not the web UI).

---

## Use cases

**Reach for dev-loop when** work is repeatable, its "done" is machine-verifiable, and the
output is worth the tokens — the three filters of loop engineering. Concretely:

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

**Don't** reach for it when "done" is subjective (pure design/taste calls), the task is a
one-off (a good single prompt is cheaper than a loop), or the output can't be auto-rejected —
a loop with no real verification just produces more of what you shouldn't ship, faster.

> **Cost is real.** Tokens are the running cost and *frequency* is what dominates it — a tight
> cadence × many agents × the strongest model adds up. Tune per-agent **models** down for the
> mechanical roles, pick a sane cadence, and watch the **acceptance rate** (verified ÷ filed):
> below ~50% the loop is doing your review work, not saving it.

---

## Quick start

```bash
# 1. install the plugin (see Install for the persistent route)
claude --plugin-dir /path/to/dev-loop

# 2. onboard a product (operator-present, idempotent)
/dev-loop:init

# 3. dry-run first — see what it WOULD do, no writes
#    (set mode:"dry-run" in projects.json), then launch one pass:
/dev-loop:pm-agent      /dev-loop:qa-agent      /dev-loop:dev-agent

# 4. flip mode:"live" and run them on a loop (Agent View or the tmux launcher)
```

## Requirements

- **Claude Code** with this plugin installed.
- A **coordination backend**: the **Linear MCP** (`mcp__linear-server__*`) for the default,
  or nothing extra for the local file board / hub.
- **`gh` CLI** authenticated — Dev uses it for git/deploy.
- A **git repo** for the product, and (for Linear) a **team + project** the loop may own.
- Per role: `repoPath` (Dev), `strategyDoc` (PM), `testEnv` (QA).
- For the hub backend: **Node ≥ 23.6** (built-in `node:sqlite`, zero native deps).

## Install

**Quick / dev (this session only):**
```bash
claude --plugin-dir /path/to/dev-loop
```

**Personal, persistent** — add a local marketplace in `~/.claude/settings.json`:
```json
{
  "extraKnownMarketplaces": {
    "local": { "source": { "source": "local", "path": "/path/to/parent-of-dev-loop" } }
  }
}
```
then `/plugin install dev-loop@local`. The skills appear as `/dev-loop:pm-agent`,
`/dev-loop:qa-agent`, `/dev-loop:dev-agent`, `/dev-loop:sweep-agent`,
`/dev-loop:reflect-agent`, `/dev-loop:ops-agent`, `/dev-loop:architect-agent`,
`/dev-loop:director-agent`, the opt-in `/dev-loop:senior-dev-agent` +
`/dev-loop:junior-dev-agent`, and `/dev-loop:init`.

Standalone hub (Claude-independent, for non-Claude CLIs): `npm i -g @dyzsasd/dev-loop` gives the
`dev-loop` CLI (`serve`, `shim`, `daemon up|down|status`, `doctor`, …).

## Configure

Per-project settings live in `${CLAUDE_PLUGIN_DATA}/projects.json`
(`~/.claude/plugins/data/dev-loop/projects.json`). Seed from the example:

```bash
mkdir -p ~/.claude/plugins/data/dev-loop
cp config/projects.example.json ~/.claude/plugins/data/dev-loop/projects.json
# then map each project → repo, strategy doc, test env, git/deploy flags
```

The dials (all per-project):
- **`mode`** — `"dry-run"` (analyze + print, no writes) vs `"live"` (create/transition
  tickets and, for Dev, commit/push/deploy per `git`/`deploy`).
- **`autonomy`** — `"ask"` (escalate human-only calls) vs `"full"` (decide and act).
- **`backend`** — `"linear"` (default) / `"local"` (file board) / `"service"` (the hub). See [Backends](#backends).
- **`models`** — per-agent model at launch; **defaults to `opus`**. Tune mechanical/high-frequency
  agents down (`sonnet`/`haiku`). The two-tier Dev defaults senior=opus, junior=sonnet.
- **`repos[]`** *(optional)* — one product, many repos (else single-repo, 100% unchanged).
- **`reports.sink`** *(optional)* — `"files"` (default) vs `"linear"` (host reports + 点评 in Linear for a cloud/remote runtime).
- **`notify`** *(optional)* — Slack/Lark webhook to ping you when a ticket is human-parked.
- **`director`** *(optional, hub)* — enables the discussion board + roadmap + two-way channel.

Full reference: [`references/config-schema.md`](references/config-schema.md).

## Set up a project

**Run `/dev-loop:init` once** (above) — it scaffolds everything and prints a readiness
checklist before you go live. It creates only what's missing and overwrites nothing. As a
backstop, the loop agents also re-apply the label/project checks on the first `live` run.

## Run the loop

The plugin **ships no harness** — pick how to fire the agents:

- **Agent View** (native) — `claude agents`, then dispatch each as a self-looping session:
  `/loop 5m /dev-loop:pm-agent`, `/loop 5m /dev-loop:qa-agent`, `/loop 5m /dev-loop:dev-agent`,
  `/loop 30m /dev-loop:sweep-agent`, `/loop 24h /dev-loop:reflect-agent`, plus the opt-in
  outward agents (`ops`, `architect`, `director`).
- **A local tmux launcher** — one pane per agent, per-agent models in one command. Set
  `DEV_SPLIT=1` to run the two-tier Dev (senior-dev + junior-dev panes) instead of one `dev`.
- **Manually**, one turn at a time, for a single pass.

**Cadence** (they self-throttle, so idle fires are cheap no-ops): PM/QA/Dev ~5 min, Sweep
~30 min, Reflect daily; Ops ~10 min, Architect/Director daily/on-demand.

**Resume is a non-event** — agents are stateless per fire. After a stop, crash, or reboot,
just launch them again; each re-reads ground truth and continues.

> ⚠️ **`mode:"live"` + `autonomy:"full"` + `autoPush`/`autoDeploy` = unattended commits,
> pushes, and prod deploys with no human gate.** That's the intended power — but try
> `mode:"dry-run"` (or a single `MODE=once` pass) first to see what it would do.

📖 Full guide — onboarding, launch methods, models, resume, stop: [`docs/RUNNING.md`](docs/RUNNING.md).

## Backends

Coordination is pluggable; the agents and protocols are identical across all three.

| Backend | What it is | Gives you |
|---|---|---|
| **`linear`** *(default)* | Coordinate through the Linear MCP | Cloud, team-visible, the Linear app as UI |
| **`local`** | A machine-local markdown file board in the data dir | Zero-cloud, minimal, no Linear required |
| **`service`** | A local **hub** — an MCP system-of-record over `node:sqlite` | **Real per-agent identity**, a localhost **web UI**, versioned operator-published docs, the discussion board + Director, the two-way channel, the one-way Linear mirror, CLI-portability |

The **work plane** (states, transitions, who-does-what, the agent loop) is identical across
backends; the **surface plane** (per-agent identity, web UI, board/Director) is a deliberate
per-backend superset. See [conventions §18](references/conventions.md) +
[`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md).

## Safety boundary

The agents operate **only** on tickets carrying the **`dev-loop`** label, scoped to the
configured project. They never read, transition, or comment on any other ticket. This single
label is the firewall between the loop and your human backlog — treat it as load-bearing.

## Self-evolution

`reflect-agent` is what lets the loop improve without drifting into chaos:
- It reads the loop's **own** output and distills **recurring** patterns (≥2 occurrences,
  each citing ticket IDs / commit SHAs) into `lessons.md` — the per-operator override every
  agent reads at the top of every run.
- **The hard boundary** ([conventions §17](references/conventions.md)): Reflect may edit
  `lessons.md` autonomously (local, reversible, never committed) but **must not** auto-rewrite
  the SKILLs or `conventions.md`. Structural changes are **drafted as proposals** for the
  operator to apply by git commit. Self-modification of the core is *surfaced, not executed* —
  the one principled exception to "decide and act".

## Reports & operator review (点评)

You steer the loop by reviewing its trail — no code edits.
- **Reports.** Each agent writes a daily log rolled up weekly/monthly under
  `${CLAUDE_PLUGIN_DATA}/<project-key>/reports/<agent>/` — machine-local, never committed,
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
**Opt-in; absent ⇒ 100% unchanged.** It adds (each independently gated): an **independent
second-model review** (Dev Step 5.5 + Architect; advisory, never touches the board),
**image generation** (PM mockups + Dev production assets — the one thing the loop can't do
itself), and a one-shot **rescue** before a `fix-exhausted` block. See
[conventions §24](references/conventions.md) + [`references/codex-integration.md`](references/codex-integration.md).

## Deep docs

- [`references/conventions.md`](references/conventions.md) — the authoritative spec (state machine, labels, every protocol). Every agent reads it first.
- [`references/config-schema.md`](references/config-schema.md) — the full `projects.json` field reference.
- [`docs/RUNNING.md`](docs/RUNNING.md) — onboarding, launch methods, models, resume.
- [`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md) — the local hub / `service` backend.
- [`docs/DAEMON.md`](docs/DAEMON.md) — the localhost web UI + daemon.
- [`docs/PORTABILITY.md`](docs/PORTABILITY.md) — running the loop on a second CLI (Codex / opencode).
- [`docs/design/`](docs/design/) — the design records (backend choice, daemon repositioning, the two-tier Dev split).
- [`CHANGELOG.md`](CHANGELOG.md) — full version history.

## Status

**v0.22.0.** Ten agents — five inward (**PM / QA / Dev / Sweep / Reflect**) and three
outward (**Ops / Architect / Director**), with an opt-in two-tier **senior-dev / junior-dev**
Dev split — plus the `init` onboarding command.
Coordination is backend-pluggable: **Linear** (default), a **local file board**, or the
**local hub** (`node:sqlite` SoR with per-agent identity + a localhost web UI + versioned
docs + the discussion board/Director + a two-way Lark/Slack channel + a one-way Linear
mirror + CLI-portability). Recent: the **two-tier Dev** (senior designs / junior implements,
opt-in, back-compat); **standalone npm packaging** (`npm i -g @dyzsasd/dev-loop`) with a Codex-certified
multi-CLI path; and **loop-cost governance** (a runaway/no-progress circuit-breaker, an
acceptance-rate metric). Validated end-to-end and battle-tested across long live runs;
autonomy (push/deploy) is opt-in per project and gated on a green build. Full history in
[`CHANGELOG.md`](CHANGELOG.md).
