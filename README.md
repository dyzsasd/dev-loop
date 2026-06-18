# dev-loop

Five autonomous agents — **PM**, **QA**, **Dev**, **Sweep**, and **Reflect** — that run
a software-development loop **coordinated entirely through Linear ticket state**. They
never call each other directly; Linear is the shared blackboard. Trigger each one
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

## The agents

| Skill | What it does |
|---|---|
| **`pm-agent`** | Reads the strategy doc, exercises the real product, files **Feature** tickets, proactively reviews for improvements, **verifies** features that reach `In Review`, unblocks its own blocked tickets, and keeps the strategy doc current. |
| **`qa-agent`** | Runs happy-path + edge-case tests in the configured test env, files **Bug** tickets (and `drift` → Improvement), **re-tests** bugs that reach `In Review`, and clears info-blocks for Dev. |
| **`dev-agent`** | Pulls `Todo` tickets in priority order, grooms (enough info? duplicate? already done?), implements, gates on build/test, **self-reviews the diff**, ships per config, **smoke-checks prod (auto-revert on a break)**, and hands off to `In Review`. Blocks rather than guesses. |
| **`sweep-agent`** | Lifecycle janitor (slower cadence). Owns the cracks between the owner-scoped agents: fixes missing/wrong owner labels (invisible to every other query), resets orphaned `In Progress` from crashed runs, nudges stale signals, reports board health. Hygiene only. |
| **`reflect-agent`** | Retrospective + self-evolution (slowest cadence, daily). Studies the loop's **own** behavior and **curates `lessons.md`** from recurring, evidence-cited patterns. Observe + curate only; may autonomously edit only `lessons.md` — structural changes are **drafted as proposals, never auto-applied**. |

> **`init` is a setup command, not a loop agent.** `/dev-loop:init` runs once (safe to
> re-run) to wire a product into dev-loop — config, Linear labels/project, strategy doc,
> test env, runtime files — and prints a readiness checklist. It never files tickets,
> verifies, or ships.

The full rules — state machine, label taxonomy, ticket templates, priority order, the
claim / dedupe / blocked protocols, and the self-evolution boundary — live in
[`references/conventions.md`](references/conventions.md). All five skills read it first.

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
`/dev-loop:sweep-agent`, `/dev-loop:reflect-agent`, and `/dev-loop:init`.

## Configure

Per-project settings live in a user-editable file at `${CLAUDE_PLUGIN_DATA}/projects.json`
(resolves to `~/.claude/plugins/data/dev-loop/projects.json`). Seed it from the example:

```bash
mkdir -p ~/.claude/plugins/data/dev-loop
cp config/projects.example.json ~/.claude/plugins/data/dev-loop/projects.json
# then edit: map each Linear project → repo, strategy doc, test env, git/deploy flags
```

Three orthogonal dials per project:
- **`mode`** — `"dry-run"` (analyze + print what it *would* do; no writes) vs `"live"`
  (create/transition tickets and, for Dev, commit/push/deploy per `git`/`deploy`).
- **`autonomy`** — `"ask"` (escalate human-only calls) vs `"full"` (decide and act; no
  interactive prompts — escalation narrows to genuine external prerequisites).
- **`backend`** — `"linear"` (default; coordinate through the Linear MCP) vs `"local"`
  (a machine-local file board in the data dir, same state machine + protocols, no
  Linear required). Absent ⇒ `"linear"`. See
  [conventions §18](references/conventions.md#18-backend--linear-vs-local).

Full schema + field reference: [`references/config-schema.md`](references/config-schema.md).

## Set up a project

**Run `/dev-loop:init` once.** It's an idempotent, operator-present setup command that
gathers the config, ensures the workflow labels + the Linear project exist (asking before
creating the project), verifies or scaffolds the strategy doc, smoke-checks the test env
+ build, creates the runtime files (`pm-state.json` / `qa-state.json` / `lessons.md`), and
prints a per-item **readiness checklist** before you flip `mode:"live"`. It creates only
what's missing and overwrites nothing.

(As a backstop, the loop agents also re-apply the label/project checks defensively on the
first `live` run — see `references/conventions.md` §13.)

## Run the loop

Onboard a project once with **`/dev-loop:init`** (above), then launch the agents. The
plugin **ships no harness** — choose how to fire them:

- **Agent View** (native, recommended) — `claude agents`, then dispatch each as a
  self-looping background session: `/loop 5m /dev-loop:pm-agent`, `/loop 5m
  /dev-loop:qa-agent`, `/loop 5m /dev-loop:dev-agent`, `/loop 30m /dev-loop:sweep-agent`,
  `/loop 24h /dev-loop:reflect-agent`. Monitor/attach/stop from one screen.
- **A local tmux launcher** — one pane per agent, mixed per-agent models in one command.
- **Manually**, one turn at a time, for a single pass.

Per-agent **models** (`models` in config): the model is chosen at launch — put `dev`/`pm`
on `opus` (judgment-heavy), `qa`/`reflect` on `sonnet`, `sweep` on `haiku`; tune to budget.

Cadence (they self-throttle, so idle fires are cheap no-ops): PM/QA/Dev ~5 min, Sweep
~30 min, Reflect daily.

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

## Status

**v0.6.0** — five agents (PM/QA/Dev/Sweep/Reflect) + the `init` setup command; validated
end-to-end in an isolated sandbox and battle-tested across long live runs. Autonomy
(push/deploy) is opt-in per project and gated on a green build. Coordination is
backend-pluggable — Linear (default) or a machine-local file board (`backend:"local"`,
conventions §18). Agents take **per-agent models** at launch (`models` config), run via
Agent View or a local launcher, and **resume by just relaunching** (stateless per fire) —
see [`docs/RUNNING.md`](docs/RUNNING.md). Full history in [`CHANGELOG.md`](CHANGELOG.md).
