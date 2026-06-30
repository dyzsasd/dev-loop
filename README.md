# dev-loop

**English** · [中文](README.zh-CN.md) · [Français](README.fr.md)

**Ten launchable agents that build, improve, watch, and explain software through a shared
state machine.** You write the intent in a strategy doc and review the result. The agents
propose work, implement it, verify it, ship it, and fold what they learned into the next run.
That is *loop engineering*: less hand-prompting, more running a system that can keep itself
moving.

The agents do not call each other. The **board is the only channel**: every agent reads and
writes ticket state, plus git, so runs can happen in any order and even overlap. Ticket labels
carry the operational facts: eligibility, owner, routing, and dev tier.

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

- [What it is](#what-it-is) · [Architecture](#architecture--three-layers) · [How it works](#how-it-works)
- [The agents](#the-agents) — the full roster
- [The workflows](#the-workflows) — how the agents actually combine
- [Use cases](#use-cases) — when (and when not) to reach for it
- [Quick start](#quick-start) · [Requirements](#requirements) · [Install](#install) · [Configure](#configure)
- [Set up a project](#set-up-a-project) · [Run the loop](#run-the-loop)
- [Backends](#backends) · [Safety boundary](#safety-boundary) · [Self-evolution](#self-evolution)
- [Reports & operator review (点评)](#reports--operator-review-点评) · [Codex (optional)](#codex-integration-optional)
- [Release](#release) · [Deep docs](#deep-docs) · [Status](#status)

---

## What it is

dev-loop is a **Claude Code plugin** made of role-specialized agents: Product Manager, QA,
Developer(s), and a few coordinators. Together with a small set of conventions, they can run a
complete software-development lifecycle **without a human in the inner loop**. You provide the
product, the strategy doc, and the autonomy settings; the loop turns that into shipped,
verified increments and records what it learned.

It is deliberately **substrate-agnostic**. Coordination can run through **Linear** by default,
a **machine-local file board**, or a **local hub**: an MCP system of record over `node:sqlite`
with per-agent identity and a localhost web UI. The agents and protocols stay the same.

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
   (`serve` · `run` · `daemon` · `doctor` · `init-service` · `mcp-merge` · `seed` · …) is how *you*
   drive setup and scheduling; the `dev-loop-hub` **MCP** server is how the *agents* read and write.
   Both are thin clients over the hub.
2. **Hub — the backend service.** A local system-of-record over `node:sqlite` (the `service`
   backend) that powers the **ticket system** and the **document system** (strategy/roadmap/design,
   versioned), and maintains the **per-project namespace** — each project's board, actors, and docs
   are isolated. It runs as a localhost daemon with a read-only web UI. *(Linear or a machine-local
   file board are alternative ticket backends; the hub is the one that adds per-agent identity, the
   doc system, and the namespace.)*
3. **Agents — skills + plugin + scheduler.** The role-specialized agents are a set of **SKILLs**
   (packaged as the Claude **plugin**) plus the **scheduler** (`dev-loop run`). The loop runs as
   **external, headless, one-shot fires** — never an in-session cadence — driven by an **OS
   scheduler** (recommended), the `dev-loop run` supervisor, or a manual one-shot. See
   [Install](#install).

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
  then on.

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

### Outward — observe and explain

| Agent | What it does |
|---|---|
| **`ops-agent`** | Watches **running prod** (tight ~10–15 min cadence). Polls health checks + base URL + optional critical routes/logs and, on a **confirmed, repeated** degradation (anti-flap re-check first), files/refreshes an `incident` Bug (Urgent when prod is down). Observe-and-file — never rolls back. |
| **`architect-agent`** | Whole-codebase **tech-health auditor** (slow, daily-ish). Audits a **rotating** dimension (drift / duplication / dead code / dep-staleness + CVEs / consistency / missing abstractions), SHA-gated, and files `tech-debt` Improvements. Read-only on code — never implements. |
| **`communication-agent`** | The PR/media lead. Reads strategy, roadmap, shipped work, and public-safe product facts, then drafts one public-facing product article per cadence (daily by default). Draft-only: never publishes externally, never commits/pushes/deploys, never verifies. Can run from Codex with `DEVLOOP_ACTOR=communication`. |

### Setup — not a loop agent

| Command | What it does |
|---|---|
| **`/dev-loop:init`** | One-time, idempotent, operator-present setup. Runs **DETECT → MAP → ASSEMBLE → LOAD**: detect the project shape (greenfield / brownfield / adopting; single- or multi-repo), read-only-map a brownfield codebase into the PM doc-base, gather config, ensure labels + the project, scaffold the strategy doc + runtime files, optionally adopt named human tickets (per-ticket confirmation), and print a readiness checklist. Never files tickets, verifies, or ships. |

---

## The workflows

The agents are intentionally simple. The value comes from the **workflows**: agents reacting
to ticket state without a central orchestrator.

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
A persistent localhost daemon serves a read-only board, ticket detail, the roadmap editor,
reports, and an activity/throughput view over the same SoR — so you *watch* the loop without
touching it. The agents stay daemon-free (they coordinate through MCP, not the web UI).

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
> cadence across many agents on the strongest model adds up quickly. Use cheaper **models** for
> mechanical roles, choose a sane cadence, and watch the **acceptance rate** (verified ÷ filed):
> below roughly 50%, the loop is creating review work instead of saving it.

---

## Quick start

```bash
# Install the runtime CLI/hub. This is enough for the scheduler path.
npm i -g @dyzsasd/dev-loop
```

On macOS, the global npm install also attempts to install a LaunchAgent that runs
`dev-loop daemon up-all` at login. Set `DEVLOOP_SKIP_AUTOSTART=1` before install to opt out, or
repair/reinstall it later with `dev-loop daemon install-autostart`.

Then pick the onboarding path that matches how you want to operate.

**Path A — no Claude plugin, run with `dev-loop run`:**

```bash
# Create the per-project config yourself.
dev-loop init-config
$EDITOR ~/.dev-loop/projects.json

# Dry-run once from inside the configured product repo.
cd /path/to/product-repo
dev-loop run --cli codex --agents core --once --dry-run

# Switch mode:"live" in projects.json, then leave the loop running.
dev-loop run --cli codex --agents core,communication
```

**Path B — Claude plugin-skill onboarding:**

```bash
dev-loop install-claude-plugin
# In Claude Code, run the two /plugin commands printed by the installer, then:
/dev-loop:init

# After init writes ~/.dev-loop/projects.json, the normal loop is still dev-loop run.
cd /path/to/product-repo
dev-loop run --cli codex --agents core --once --dry-run
```

## Requirements

- **Claude Code** with this plugin installed for the `/dev-loop:*` slash commands (`/dev-loop:init`
  + manual one-shot fires); for the loop itself, the selected executor CLI (`claude`, `codex`, or
  opencode once verified) must be on `PATH`.
- A **coordination backend**: the **Linear MCP** (`mcp__linear-server__*`) for the default,
  or nothing extra for the local file board / hub.
- **`gh` CLI** authenticated — Dev uses it for git/deploy.
- A **git repo** for the product, and (for Linear) a **team + project** the loop may own.
- Per role: `repoPath` (Dev), `strategyDoc` (PM), `testEnv` (QA).
- For the hub backend: **Node ≥ 23.6** (built-in `node:sqlite`, zero native deps). If your
  default `node` is older, set `DEVLOOP_NODE=/absolute/path/to/node`; the packaged CLI and hook
  will use it.

## Install

There is **one canonical model**: the loop runs as **external, headless, one-shot fires** — each
fire is a fresh stateless `claude -p` / `codex exec` that reads ground truth and exits. (An
in-session `/loop` cadence would accumulate conversation context and burn tokens — it is not a run
mode.) Everything starts from the npm package (no GitHub checkout required):

```bash
npm i -g @dyzsasd/dev-loop          # installs the `dev-loop` + `dev-loop-hub` CLIs (Node ≥ 23.6)
```

### How the loop runs

Pick **one** of three deployment options:

| | **Option 1 — OS scheduler** (recommended) | **Option 2 — Persistent supervisor** | **Option 3 — Interactive one-shot** |
|---|---|---|---|
| What fires the agents | OS units (launchd/systemd/cron) | `dev-loop run` (long-running) | you, by hand |
| Best for | a normal host you leave running | bare containers with no OS scheduler | debugging a single agent |
| CLIs | Claude **or** Codex | Claude **or** Codex | Claude (plugin) **or** `dev-loop run --once` |
| Cadence | per-unit (5m/10m/30m/daily) | owned by the supervisor | none — single fire |

**Option 1 — OS scheduler (recommended default).** `dev-loop service install` generates and
installs per-platform scheduler units (**launchd** on macOS, **systemd** on Linux, **cron** as a
fallback) that each fire `dev-loop run --once --agents <agent> --project <key> --cli <claude|codex>`
on its cadence, plus a **KeepAlive daemon unit** that holds the hub web-UI daemon up headlessly.

```bash
dev-loop service install --project <key> --cli claude --agents core
dev-loop service status      # list what's installed
dev-loop service uninstall   # removes exactly what it installed (idempotent, per-project)
```

Flags: `--cli claude|codex`, `--agents core,…`, `--project <key>`, `--launchd|--systemd|--cron`
(default chosen by platform), `--dry-run`, `--no-daemon`. See
[`docs/RUNNING.md`](docs/RUNNING.md) for cadence mapping and the headless PATH/linger notes.

**Option 2 — Persistent supervisor (`dev-loop run`).** A long-running process that owns the cadence
itself and shells out one stateless `claude -p` / `codex exec` per fire. Use it on hosts **without**
an OS scheduler (bare containers, etc.). **No plugin needed**: it injects each agent's SKILL as the
prompt (from the bundled package) and **self-registers the `dev-loop-hub` MCP** — claude via an
inline `--mcp-config`, codex via `-c` overrides — so no `.mcp.json` or `~/.codex/config.toml` setup
is required.

```bash
dev-loop run --cli claude --agents core          # or: --cli codex --agents core,communication
```

Needs only the npm package + your chosen CLI (`claude` or `codex`) on `PATH`. See
[Run the loop](#run-the-loop) for `--agents`, cadence, and the `--max-fires` cost cap.

**Option 3 — Interactive one-shot (debugging only).** Fire a single agent by hand — either
`dev-loop run --once`, or a `/dev-loop:<agent>` slash command from the installed Claude plugin. This
is **not** a cadence. To register the plugin (only for `/dev-loop:init` + manual one-shot fires):

```bash
dev-loop install-claude-plugin       # writes a local npm-source marketplace + prints the 2 commands below
/plugin marketplace add ~/.claude/plugins/marketplaces/dev-loop-npm
/plugin install dev-loop@dev-loop-npm
```

Skills appear as `/dev-loop:pm-agent` … `/dev-loop:communication-agent`, the opt-in
`/dev-loop:senior-dev-agent` + `/dev-loop:junior-dev-agent`, and `/dev-loop:init`.
*(Dev from a source checkout: `claude --plugin-dir /path/to/dev-loop`, or a `source:"local"`
marketplace in `~/.claude/settings.json` → `/plugin install dev-loop@local`.)*

## Configure

Per-project settings live in dev-loop's own config directory:
`${DEVLOOP_PROJECTS_JSON}` when set, otherwise `~/.dev-loop/projects.json`
(`DEVLOOP_DATA_DIR` changes that base directory). Create an empty starter, then add your
own project entry:

```bash
dev-loop init-config
# Then map each project to its repo, strategy doc, test env, and git/deploy flags.
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
- **`communication`** *(optional)* — enables daily article drafts; output is draft-only, either in the data dir or a repo docs directory.

Full reference: [`references/config-schema.md`](references/config-schema.md).

## Set up a project

There are two supported setup paths:

- **With the Claude plugin:** run `/dev-loop:init` once. It scaffolds everything and prints a
  readiness checklist before you go live. It creates only what's missing and overwrites nothing.
- **Without the plugin:** create `~/.dev-loop/projects.json` from an empty starter with
  `dev-loop init-config`, then fill in the project key, `repoPath` or
  `repos[]`, `strategyDoc`, `testEnv`, backend, and `mode:"dry-run"`. For a `service` backend, run
  `dev-loop init-service <key> "<name>" <PREFIX> --dry-run` to preview hub bootstrap, then without
  `--dry-run` when the config is correct.

Existing installs that still have `~/.claude/plugins/data/dev-loop/projects.json` are read as a
legacy fallback, but new projects should be registered in `~/.dev-loop/projects.json`.

For `backend:"service"`, `init-service` starts the localhost daemon once. On macOS, the global npm
install also installs the login item when scripts are allowed; if you skipped scripts or need to
repair it, run `dev-loop daemon install-autostart`. The default web UI port is `8787` and probes
upward if occupied.

As a backstop, the loop agents also re-apply the label/project checks on the first `live` run.

## Run the loop

The main loop command is `dev-loop run`. It is a normal long-running process: dev-loop owns the
cadence, loads the bundled agent skills, and calls the selected executor CLI once per agent fire.
Use Claude or Codex as the executor:

```bash
# From inside a configured product repo; project is inferred from cwd.
cd /path/to/product-repo
dev-loop run --cli claude
dev-loop run --cli codex --agents core,communication

# One dry-run pass before leaving it unattended.
dev-loop run --cli codex --agents core,communication --once --dry-run

# Two-tier Dev: senior-dev designs, junior-dev implements.
dev-loop run --cli claude --agents core --dev-split

# Cost guard: stop after N total fires (default is unlimited).
dev-loop run --cli claude --agents core --max-fires 50
```

The scheduler **self-registers the `dev-loop-hub` MCP** for the executor (claude: inline
`--mcp-config`; codex: `-c` overrides), so it needs no plugin and no `.mcp.json` /
`~/.codex/config.toml` setup. Tokens are the running cost — `--max-fires` caps a long-running
process, and per-agent `models` keep the mechanical agents cheap.

`--agents core` means `pm,qa,dev,sweep`. Add `reflect`, `outward`, or individual agents:
`--agents core,reflect,ops,communication`. Project detection is automatic when the command starts
inside a configured `repoPath` or `repos[].path`; use `--project <key>` only from outside the repo,
from cron/systemd with a fixed cwd, or when you want to override detection. If neither an explicit
project nor the cwd resolves, the scheduler stops instead of falling back to `demo` or another
configured project. Multiple products on one machine are just multiple entries in `projects.json`
and one `dev-loop run` process per product.

For a host you leave running, install the OS scheduler instead of leaving a process attached:
`dev-loop service install --project <key> --cli claude --agents core` fires each agent on its
cadence and keeps the web-UI daemon up headlessly. See [docs/RUNNING.md](docs/RUNNING.md).

**Cadence** (they self-throttle, so idle fires are cheap no-ops): PM/QA/Dev ~5 min, Sweep
~30 min, Reflect daily; Ops ~10 min, Architect/Communication daily/on-demand.

**Resume is ordinary** because agents are stateless per run. After a stop, crash, or reboot,
launch them again; each agent re-reads ground truth and continues.

> ⚠️ **`mode:"live"` + `autonomy:"full"` + `autoPush`/`autoDeploy` = unattended commits,
> pushes, and prod deploys with no human gate.** That is the intended power, but try
> `mode:"dry-run"` (or `dev-loop run --once --dry-run`) first to see what it would do.

📖 Full guide — onboarding, launch methods, models, resume, stop: [`docs/RUNNING.md`](docs/RUNNING.md).

## Backends

Coordination is pluggable; the agents and protocols are identical across all three.

| Backend | What it is | Gives you |
|---|---|---|
| **`linear`** *(default)* | Coordinate through the Linear MCP | Cloud, team-visible, the Linear app as UI |
| **`local`** | A machine-local markdown file board in the data dir | Zero-cloud, minimal, no Linear required |
| **`service`** | A local **hub** — an MCP system-of-record over `node:sqlite` | **Real per-agent identity**, a localhost **web UI**, versioned operator-published docs, the one-way Linear mirror, CLI-portability |

The **work plane** (states, transitions, responsibilities, and the agent loop) is identical
across backends. The **surface plane** (per-agent identity, web UI) expands by
backend. See [conventions §18](references/conventions.md) +
[`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md).

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
- **The hard boundary** ([conventions §17](references/conventions.md)): Reflect may edit
  `lessons.md` autonomously (local, reversible, never committed) but **must not** auto-rewrite
  the SKILLs or `conventions.md`. Structural changes are **drafted as proposals** for the
  operator to apply by git commit. Self-modification of the core is *surfaced, not executed* —
  the one principled exception to "decide and act".

## Reports & operator review (点评)

You steer the loop by reviewing its trail, not by editing code inside the loop.
- **Reports.** Each agent writes a daily log rolled up weekly/monthly under
  `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/reports/<agent>/` — machine-local, never committed,
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
[conventions §24](references/conventions.md) + [`references/codex-integration.md`](references/codex-integration.md).

Separately, the `service` hub can run the agents themselves from Codex; see
[`docs/PORTABILITY.md`](docs/PORTABILITY.md). Run any agent there with, e.g.,
`dev-loop run --cli codex --agents communication` — the scheduler injects the per-agent
`dev-loop-hub` actor/MCP override itself, so no manual Codex config is needed.

## Release

Package releases are cut through the manual **Release npm package** GitHub Actions workflow. It
stamps the shared version, runs the hub test suite, publishes `hub/` to npm with `NPM_TOKEN`, and
pushes `v<version>`. See [`docs/RELEASING.md`](docs/RELEASING.md).

## Deep docs

- [`references/conventions.md`](references/conventions.md) — the authoritative spec (state machine, labels, every protocol). Every agent reads it first.
- [`references/config-schema.md`](references/config-schema.md) — the full `projects.json` field reference.
- [`docs/RUNNING.md`](docs/RUNNING.md) — onboarding, launch methods, models, resume.
- [`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md) — the local hub / `service` backend.
- [`docs/DAEMON.md`](docs/DAEMON.md) — the localhost web UI + daemon.
- [`docs/PORTABILITY.md`](docs/PORTABILITY.md) — running the loop on a second CLI (Codex / opencode).
- [`docs/RELEASING.md`](docs/RELEASING.md) — the GitHub Actions release path for npm + tags.
- [`docs/design/`](docs/design/) — the design records (backend choice, daemon repositioning, the two-tier Dev split).
- [`CHANGELOG.md`](CHANGELOG.md) — full version history.

## Status

**v0.24.0.** The loop now runs **one canonical way** — external, headless, one-shot fires via an
OS scheduler (the new `dev-loop service` layer), the `dev-loop run` supervisor, or a manual
one-shot; the in-session `/loop` cadence is retired as a run mode (all plugin mechanics unchanged).
Ten launchable agents — five inward (**PM / QA / Dev / Sweep / Reflect**),
three outward (**Ops / Architect / Communication**), and an opt-in two-tier
**senior-dev / junior-dev** Dev split — plus the `init` onboarding command.
Coordination is backend-pluggable: **Linear** (default), a **local file board**, or the
**local hub** (`node:sqlite` SoR with per-agent identity + a localhost web UI + versioned
docs + a one-way Linear mirror + CLI-portability). Recent: dev-loop now uses its own
`~/.dev-loop` config/data home by default instead of Claude plugin data, refuses to guess a project
when neither `--project` nor the current repo identifies one, and can install a macOS LaunchAgent so
the service hub daemon starts on login with a stable localhost port. Validated end-to-end and battle-tested across long live runs;
autonomy (push/deploy) is opt-in per project and gated on a green build. Full history in
[`CHANGELOG.md`](CHANGELOG.md).
