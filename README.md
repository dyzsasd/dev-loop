# dev-loop

Eight autonomous agents — **PM**, **QA**, **Dev**, **Sweep**, **Reflect**, **Ops**,
**Architect**, and **Director** — that run a software-development loop **coordinated
entirely through ticket state**. They never call each other directly; the board is the
shared blackboard. Five are inward / build-facing; three (Ops/Architect/Director) are
**outward** agents — Ops/Architect observe-and-file (running prod, whole-codebase health),
and the **Director** coordinates: it chairs a cross-agent discussion board and drafts the
operator-published roadmap (the optional hub `service` backend, §25). Trigger each one
manually, or run them on a schedule, and the product builds and improves itself.

```
        PM ──proposes feature──┐                 ┌──QA proposes bug──┐
                               ▼                 ▼                   │
   strategy doc ──►  [Todo] ◄────────── grooming/unblock ───────────┘
                       │
        Dev claims ────┼──► [In Progress] ──ships──► [In Review]
                       │                                  │
            (dup/blocked)                    owner verifies (PM↔feature, QA↔bug)
                       ▼                          │            │
                 [Canceled/Duplicate]          pass▼        fail▼
                                               [Done]    back to [Todo]
```

## How it works

- **Linear is the only channel.** No agent calls another. Each reads and writes Linear
  ticket state (plus git), so any agent can run at any time, in any order, even
  concurrently. A ticket's labels carry everything: eligibility, owner, and routing.
- **Owner labels route the work.** `pm` owns Features, `qa` owns Bugs; the **owner
  files and verifies**, Dev implements everyone's tickets. This is how a finished build
  finds its way back to whoever should sign it off.
- **Each fire is fresh.** Agents run on a loop and are written to be *stateless per
  fire* — they re-read ground truth from Linear/git/disk every run, so auto-compaction
  or a crash mid-task is safe (the next fire just re-reads and continues).
- **Autonomy is machine gates, not human prompts.** Under `autonomy:"full"` the agents
  *decide and act* — they never pause for an interactive approval. Safety comes from
  *gates*, not from a human in the loop: a red build never ships, Dev self-reviews its
  diff before shipping, a deploy that fails its smoke check is rolled back, and genuinely
  human-only decisions are parked on the ticket as a fact (never an interactive prompt).
- **The loop improves itself.** `reflect-agent` studies the loop's own behavior and
  curates a per-operator `lessons.md` that every agent obeys next run — a real feedback
  loop. Its one hard limit: it may edit `lessons.md` autonomously but **never** rewrites
  the agents' own instructions; structural changes are *proposed* for a human, never
  auto-applied. (See [self-evolution](#self-evolution) below.)
- **You steer it by reviewing, not by editing code.** Every agent writes
  **daily / weekly / monthly reports**; drop a **点评** (a critique) next to any report and
  the agent distills it into a `lessons.md` rule it obeys from then on — see
  [reports & operator review](#reports--operator-review-点评) below.

## The agents

| Skill | What it does |
|---|---|
| **`pm-agent`** | Reads the strategy doc, exercises the real product, files **Feature** tickets, proactively reviews for improvements, **verifies** features that reach `In Review`, unblocks its own blocked tickets, and keeps the strategy doc current. |
| **`qa-agent`** | Runs happy-path + edge-case tests in the configured test env, files **Bug** tickets (and `drift` → Improvement), **re-tests** bugs that reach `In Review`, and clears info-blocks for Dev. |
| **`dev-agent`** | Pulls `Todo` tickets in priority order, grooms (enough info? duplicate? already done?), implements, gates on build/test, **self-reviews the diff**, ships per config, **smoke-checks prod (auto-revert on a break)**, and hands off to `In Review`. Blocks rather than guesses. |
| **`sweep-agent`** | Lifecycle janitor (slower cadence). Owns the cracks between the owner-scoped agents: fixes missing/wrong owner labels (invisible to every other query), resets orphaned `In Progress` from crashed runs, nudges stale signals, reports board health. Hygiene only. On the hub `service` backend it also runs the optional **one-way Linear mirror** push (Job 5 — hub → Linear for human visibility; idempotent, incremental, split-brain enforced). |
| **`reflect-agent`** | Retrospective + self-evolution (slowest cadence, daily). Studies the loop's **own** behavior and **curates `lessons.md`** from recurring, evidence-cited patterns. Observe + curate only; may autonomously edit only `lessons.md` — structural changes are **drafted as proposals, never auto-applied**. |
| **`ops-agent`** | **Outward** (§21): Ops/SRE watcher of RUNNING prod (tight ~10–15 min cadence). Polls per-repo `deploy.healthCheck` + `baseUrl` + optional critical routes/logs and, on a **confirmed, repeated** degradation (anti-flap: re-checks first), files/refreshes a `Bug`+`qa`+`incident` (Urgent when prod is down). Observe-and-file only — never rolls back (Dev's Step 6.5). |
| **`architect-agent`** | **Outward** (§21): whole-codebase tech-health auditor (slow, daily-ish). Audits the codebase on a **rotating** dimension (drift / duplication / dead-code / dep-staleness+CVE / consistency / missing-abstractions), SHA-gated (§19), and files `Improvement`+`qa`+`tech-debt`. Read-only on code — never implements. |
| **`director-agent`** | **Outward** (§21/§25): the human-facing coordinator that owns DIRECTION (daily-ish + on-demand; the optional hub `service` backend). Chairs a cross-agent **discussion board** (opens topics → role-lens agents post per-round → synthesize → a **decision**) and **drafts** the kind:"roadmap" doc the **operator publishes**; over an optional **two-way Lark/Slack channel** the operator chats with it (poll-based, no daemon — inbound direction + digests/replies; §16-secret-safe); folds optional real-user `signalSources` (PII-safe, §16). Coordinates + drafts — never implements/ships/verifies; a structural ask is a `[director-proposal]` (§17); inbound chat is direction, never a gate-bypass. **No `director` config ⇒ graceful no-op** (PM owns strategy). |

> **`init` is a setup command, not a loop agent.** `/dev-loop:init` runs once (safe to
> re-run) to wire a product into dev-loop — config, Linear labels/project, strategy doc,
> test env, runtime files — and prints a readiness checklist. It never files tickets,
> verifies, or ships.

The full rules — state machine, label taxonomy, ticket templates, priority order, the
claim / dedupe / blocked protocols, and the self-evolution boundary — live in
[`references/conventions.md`](references/conventions.md). All eight skills read it first.

## Requirements

- **Claude Code** with this plugin installed.
- **Linear MCP** connected (`mcp__linear-server__*` tools) — the coordination substrate.
- **`gh` CLI** authenticated — Dev uses it for git/deploy operations.
- A **git repo** for the product, and a **Linear team + project** the loop may own.
- Per-role: `repoPath` (Dev), `strategyDoc` (PM), `testEnv` (QA) — see Configure.

## Install

**Quick / dev (this session only):**
```bash
claude --plugin-dir /path/to/dev-loop
```

**Personal, persistent** — via a local marketplace in `~/.claude/settings.json`:
```json
{
  "extraKnownMarketplaces": {
    "local": { "source": { "source": "local", "path": "/path/to/parent-of-dev-loop" } }
  }
}
```
then `/plugin install dev-loop@local`. Verify with `/plugin list`; the skills appear as
`/dev-loop:pm-agent`, `/dev-loop:qa-agent`, `/dev-loop:dev-agent`,
`/dev-loop:sweep-agent`, `/dev-loop:reflect-agent`, `/dev-loop:ops-agent`,
`/dev-loop:architect-agent`, `/dev-loop:director-agent`, and `/dev-loop:init`.

## Configure

Per-project settings live in a user-editable file at `${CLAUDE_PLUGIN_DATA}/projects.json`
(resolves to `~/.claude/plugins/data/dev-loop/projects.json`). Seed it from the example:

```bash
mkdir -p ~/.claude/plugins/data/dev-loop
cp config/projects.example.json ~/.claude/plugins/data/dev-loop/projects.json
# then edit: map each Linear project → repo, strategy doc, test env, git/deploy flags
```

Three orthogonal dials per project (plus an optional `repos[]` for multi-repo products — see [conventions §19](references/conventions.md#19-multiple-repos)):
- **`mode`** — `"dry-run"` (analyze + print what it *would* do; no writes) vs `"live"`
  (create/transition tickets and, for Dev, commit/push/deploy per `git`/`deploy`).
- **`autonomy`** — `"ask"` (escalate human-only calls) vs `"full"` (decide and act; no
  interactive prompts — escalation narrows to genuine external prerequisites).
- **`backend`** — `"linear"` (default; coordinate through the Linear MCP) vs `"local"`
  (a machine-local file board in the data dir, same state machine + protocols, no
  Linear required). Absent ⇒ `"linear"`. See
  [conventions §18](references/conventions.md#18-backend--linear-vs-local).
- **`repos[]`** (optional) — one product, many repos. Absent (or a single entry) ⇒
  single-repo, using top-level `repoPath`/`build`/`git`/`deploy`, **100% unchanged**.
  Set `repos[]` to span repos: each ticket targets one via a `repo:<name>` label, with
  per-repo build/branch/deploy resolution and a doc-home repo for the strategy doc. See
  [conventions §19](references/conventions.md#19-multiple-repos).
- **`reports.sink`** (optional) — `"files"` (default; reports live as machine-local files
  in the data dir) vs `"linear"` (host reports + the `点评` channel in Linear, for a
  **cloud / remote** runtime where you can't reach the data dir). Absent ⇒ `"files"`.
  Default-off and decoupled from `backend`; the `linear` sink carries §16 guardrails. See
  [conventions §23](references/conventions.md#23-reports-in-linear--the-reportssink-option).
- **`notify`** (optional) — when a ticket is left **human-parked** for you
  (`blocked`+`needs-pm`+`Bail-shape: external-prereq`), PM pings you **out-of-band** via a
  **Slack or Lark** incoming webhook, so a parked ticket never sits unseen. `type:
  "slack"|"lark"`; the webhook URL is a secret (set `webhookEnv`, or inline since
  `projects.json` is machine-local). Announced **once** (the `notified` label), secret-safe,
  dry-run-gated. Absent ⇒ no-op. Out-of-band because a Linear @mention is a self-mention
  (shared identity) and gets suppressed. See
  [conventions §9](references/conventions.md#9-the-blocked-protocol).

Full schema + field reference: [`references/config-schema.md`](references/config-schema.md).

## Set up a project

**Run `/dev-loop:init` once.** It's an idempotent, operator-present setup command that
runs a **DETECT → MAP → ASSEMBLE → LOAD** flow: it detects the project shape (greenfield /
brownfield / adopting; single- or multi-repo), read-only-maps a brownfield codebase into
the PM doc-base `Current state` (or runs a short strategy interview for greenfield),
gathers the config (incl. any extra `repos[]`), ensures the workflow labels + the Linear
project exist (and one `repo:<name>` label per repo when multi-repo — asking before
creating the project), verifies or scaffolds the strategy doc-base, smoke-checks the test
env + build, creates the runtime files (`pm-state.json` / `qa-state.json` / `lessons.md`,
plus the per-agent `reports/` tree, §22),
optionally adopts named pre-existing human tickets (per-ticket operator confirmation,
never bulk), and prints a per-item **readiness checklist** before you flip `mode:"live"`.
It creates only what's missing and overwrites nothing.

(As a backstop, the loop agents also re-apply the label/project checks defensively on the
first `live` run — see `references/conventions.md` §13.)

## Run the loop

Onboard a project once with **`/dev-loop:init`** (above), then launch the agents. The
plugin **ships no harness** — choose how to fire them:

- **Agent View** (native, recommended) — `claude agents`, then dispatch each as a
  self-looping background session: `/loop 5m /dev-loop:pm-agent`, `/loop 5m
  /dev-loop:qa-agent`, `/loop 5m /dev-loop:dev-agent`, `/loop 30m /dev-loop:sweep-agent`,
  `/loop 24h /dev-loop:reflect-agent`, plus the optional outward agents (§21)
  `/loop 10m /dev-loop:ops-agent`, `/loop 24h /dev-loop:architect-agent`,
  `/loop 24h /dev-loop:director-agent`. Monitor/attach/stop from one screen.
- **A local tmux launcher** — one pane per agent, per-agent models in one command.
- **Manually**, one turn at a time, for a single pass.

Per-agent **models** (`models` in config): the model is chosen at launch and **defaults
to `opus` for every agent**; tune an agent **down** (`sonnet`/`haiku`) only to
economize the mechanical/high-frequency ones (`sweep`/`qa`/`ops`/`signal`).

Cadence (they self-throttle, so idle fires are cheap no-ops): PM/QA/Dev ~5 min, Sweep
~30 min, Reflect daily. Outward (opt-in): Ops ~10 min, Architect daily, Director daily/on-demand.

**Resume is a non-event** — the agents are stateless per fire (conventions §0): state
lives in Linear/the local board + git + the state files. To resume after a stop, crash,
or reboot, just launch them again; each re-reads ground truth and continues.

📖 **Full guide — onboarding, both launch methods, per-agent models, resume, stop:**
[`docs/RUNNING.md`](docs/RUNNING.md).

> ⚠️ **`mode:"live"` + `autonomy:"full"` + `autoPush`/`autoDeploy` = unattended commits,
> pushes, and prod deploys with no human gate.** That's the intended power of the loop —
> but try `mode:"dry-run"` (or a single `MODE=once` pass) first to see what it would do.

## Safety boundary

The agents operate **only** on tickets carrying the **`dev-loop`** label, scoped to the
configured Linear project. They never read, transition, or comment on any other ticket.
This single label is the firewall between the loop and your human backlog — treat it as
load-bearing.

## Self-evolution

`reflect-agent` is what lets the loop get better on its own without drifting into chaos:

- Each day it reads the loop's **own** output — tickets by type/owner/bail-shape, git +
  deploy/rollback, throughput, QA outcomes — and distills **recurring** patterns
  (≥2 occurrences, each citing its ticket IDs / commit shas).
- It writes those as rules into **`lessons.md`**, the per-operator override layer every
  agent reads at the top of every run. A correction lands once and is obeyed thereafter —
  no editing of skill files required.
- **The hard boundary** (conventions §17): Reflect may edit `lessons.md` autonomously
  (it's local, reversible, never committed), but it **must not** auto-rewrite the agents'
  SKILLs or `conventions.md` — a daily self-modifying loop with no review compounds
  errors. Deeper, structural changes are **drafted as proposals** (optionally a
  `[reflect-proposal]` ticket filed `blocked` so no agent can pick it up) for the human
  operator to apply. Self-modification of the core instructions is *surfaced, not
  executed* — the one principled exception to "decide and act".

## Reports & operator review (点评)

Every agent leaves a durable trail of what it did, and you steer it by **reviewing that
trail** — no code or skill edits.

- **Reports.** Each agent writes a **daily** running log, rolled up into a **weekly** and a
  **monthly** summary, under `${CLAUDE_PLUGIN_DATA}/<project-key>/reports/<agent>/`. They're
  machine-local, never committed, and §16-bound (summaries + counts + ticket-IDs/SHAs — no
  secrets/PII). A no-op fire writes nothing, so the log tracks real work, not fire count.
- **点评 (operator review).** To critique a report, drop a sibling **`<report>.review.md`**
  next to it with free-form prose. At its next run-start the agent reads any **un-acted**
  review and **distills it into one `lessons.md` rule under its own section** — which it
  then obeys on every subsequent fire. That's the whole loop: **report → your 点评 → lesson
  → changed behavior.**
- **The firewall stays intact** (conventions §17/§22). An agent may write a `lessons.md`
  rule *only* into its own section and *only* from a real, cited operator review — your
  written 点评 is the human authorization. `## Shared` and other agents' sections stay
  Reflect's alone; a structural ask becomes a proposal, never a self-edit. Anti-spoof:
  agents never author a `*.review.md`, so any review file is operator-authored by
  construction (ticket/log text can't masquerade as a 点评).
- **Cloud / remote? Host it in Linear.** Set **`reports.sink:"linear"`** (default-off) and
  reports become per-agent Linear **Documents** in a dedicated reports project, with the
  点评 as a **comment** on the doc — so you read and critique from a browser / phone. Same
  firewall by a channel split (the agent writes only the doc *body*, never a comment, so
  every comment is operator-authored), plus mandatory §16 guardrails (a fail-closed scrub,
  and `signal`/`ops`/`dev` pinned local-only by default). See
  [conventions §22](references/conventions.md#22-reports--operator-review--daily--weekly--monthly)
  + [§23](references/conventions.md#23-reports-in-linear--the-reportssink-option).

## Codex integration (optional)

The loop can use **OpenAI Codex** as an optional power tool — wired through the
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) companion plugin plus the
`codex` CLI. It's **opt-in and absent ⇒ 100% unchanged**: with no `codex` config block
(or no `codex` CLI on `PATH`), every agent behaves exactly as before. See
[conventions §24](references/conventions.md#24-codex--optional-power-tools) and the full
playbook in [`references/codex-integration.md`](references/codex-integration.md).

What it adds (each independently gated):
- **Independent review** — Dev's self-review (Step 5.5) and Architect can run a *second
  model* over the diff/codebase (`/codex:review`, `/codex:adversarial-review`). Advisory:
  Critical/High block like Dev's own, but Codex never touches Linear and never gets a veto.
- **Image generation** — the one thing the loop can't do itself. **PM** generates
  mockups/wireframes to sharpen Feature tickets; **Dev** generates real UI assets (icons,
  illustrations, OG cards, placeholders) an acceptance criterion requires, committed into
  `codex.assetsDir` and shipped through the normal gates. Uses Codex's native
  `image_generation` tool (the PNG lands in `~/.codex/generated_images/…` and is copied out).
- **Delegate / rescue** — Dev can hand a stuck ticket to Codex for **one** pass before it
  blocks `fix-exhausted`; the patch ships only if it passes Dev's own gates + self-review.

**Setup:** `npm i -g @openai/codex && codex login`, install the plugin
(`/plugin marketplace add openai/codex-plugin-cc` → `/plugin install codex@openai-codex`
→ `/codex:setup`), then add a `codex` block to the project in `projects.json` (see
[config-schema](references/config-schema.md)). Codex uses your local `codex login` auth —
no secret in config; usage counts against your ChatGPT/Codex limits.

## Status

**v0.15.0** — eight agents: the five inward (PM/QA/Dev/Sweep/Reflect) plus three
**outward** observe-and-file agents (conventions §21) — **Ops** (watches running prod,
files `incident` Bugs with an anti-flap re-check + dedupe), **Architect** (audits
whole-codebase tech health on a rotating, SHA-gated dimension, files `tech-debt`
Improvements), **Director** (chairs the §25 discussion board and drafts the
operator-published roadmap, folding optional real-user `signalSources`, PII-safe; no
`director` config ⇒ no-op) — Ops/Architect read-only; the Director coordinates + drafts;
none implement/ship/verify. Plus the `init` DETECT → MAP → ASSEMBLE → LOAD onboarding flow
(greenfield interview, brownfield read-only mapping, operator-confirmed ticket adoption)
that scaffolds a fixed-heading PM doc-base.
Every agent also writes **daily / weekly / monthly reports** to the data dir
(`<project-key>/reports/<agent>/…`) and **acts on any operator review (点评)** you drop next
to one (`<report>.review.md`) — turning your critique into a `lessons.md` rule that changes
how it works (conventions §22). For a cloud / remote runtime, an opt-in
**`reports.sink:"linear"`** instead hosts reports + the 点评 channel in Linear so you read
and critique from a browser (default-off; §23).
The loop coordinates **one or many repos** (`repos[]`; tickets target a repo via a
`repo:<name>` label, per-repo build/branch/deploy) — single-repo is 100% unchanged.
New in v0.11.0: an opt-in **Codex companion** (conventions §24, via codex-plugin-cc + the
`codex` CLI) gives the loop an independent second-model **review** (Dev Step 5.5 +
Architect), **image generation** (PM mockups + Dev production assets — the one capability
the agents lack), and a one-shot **rescue** before a `fix-exhausted` block — all advisory,
gated per sub-flag, never touching Linear; absent ⇒ 100% unchanged.
New in v0.12.0: an opt-in **`notify`** block pings you on **Slack / Lark** when a ticket is
left **human-parked** (`blocked`+`needs-pm`+`external-prereq`), so a parked ticket never
sits unseen — out-of-band (a Linear self-mention is suppressed under the shared identity),
announced once, secret-safe; absent ⇒ no-op (conventions §9).
New in v0.13.0: an opt-in **`backend:"service"`** — a **local hub** (an MCP system-of-record
over built-in `node:sqlite`, zero native deps; [`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md))
that gives the loop **real per-agent identity** (every write attributable, not Linear's single
shared user) and is CLI-portable; the SKILLs port unchanged (the hub mirrors the Linear
op-shapes 1:1). Linear stays the default. v0.14.0 hardens it (P3): per-project isolation is
certified by a test, phantom actor/project typos are refused at startup, ticket prefixes are
kept unique, and `dev-loop-hub doctor` health-checks the SoR. v0.15.0 (P4) adds opt-in
hub-native **versioned documents** (the strategyDoc/roadmap as operator-published, diffable,
optimistic-CAS docs; §17 firewall kept structural — docs are DB-only, never a code file).
v0.16.0 (P5) adds the **discussion board + Director** (a loop agent, no daemon); v0.17.0 (P6)
the optional **two-way Lark/Slack channel** (poll-based, §16-secret-safe); v0.18.0 (P7) the
optional **one-way Linear mirror** (the hub pushes its tickets to Linear for human visibility —
split-brain enforced, Linear never read back as truth). All daemon-free.
Validated end-to-end in an isolated sandbox and battle-tested across long live runs. Autonomy
(push/deploy) is opt-in per project and gated on a green build. Coordination is
backend-pluggable — Linear (default), a machine-local file board (`backend:"local"`), or the
local hub (`backend:"service"`), conventions §18. Agents take **per-agent models** at launch (`models` config), run via
Agent View or a local launcher, and **resume by just relaunching** (stateless per fire) —
see [`docs/RUNNING.md`](docs/RUNNING.md). Full history in [`CHANGELOG.md`](CHANGELOG.md).
