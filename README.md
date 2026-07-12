# dev-loop

**English** · [中文](README.zh-CN.md) · [Français](README.fr.md)

**An autonomous dev team in a folder.** Nine launchable agents (PM, QA, a senior/junior Dev
pair, Sweep, Reflect, Ops, Architect, Communication) build, test, ship, watch, and explain your
software, coordinating purely through ticket state (Linear, or a bundled local hub). You write
the intent in a strategy doc and read one daily digest; the team handles the rest.

You are the **director**, not the reviewer: work enters through the PM (never straight to a
dev), sensitive changes get a senior design first, verification is independent of the
implementer's claims, and everything the team does lands in reports and metrics you can read
in one message a day.

> How it works inside — layers, protocols, backends, self-evolution:
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). This README is about **using** it.

---

## Quick start

Three commands, nothing to configure — the default **service** backend (a bundled local
sqlite hub + web board) needs no external service, no plugin, and no MCP setup:

```bash
npm i -g @dyzsasd/dev-loop        # Node ≥ 23.6; installs the `dev-loop` CLI
dev-loop init                     # guided setup — Enter through the defaults (or --yes)
dev-loop run                      # ONE scheduler drives the whole team; ^C stops everything
```

`init` creates the workspace and your first project (hub board row auto-seeded), offers to
register your first repo (`--detect` reads build/CI facts straight from the clone), then ends
with the doctor verdict and a `NEXT:` line naming the single most-blocking step. What you get:

- a **multi-project web UI**: `dev-loop hub start` → `http://127.0.0.1:8787` — a project
  index at `/`, each project's board, ticket detail, activity, and docs pages under
  `/p/<key>/` (`dev-loop run` also auto-starts it; `dev-loop hub status` to inspect);
- agents that reach the board through the `dev-loop` CLI directly — with Claude Code or
  Codex on the service backend there is nothing else to install (`hub.agentInterface` is
  the per-coding-agent switch; `"mcp"` restores the injected-MCP wiring);
- safe defaults: `mode: dry-run` (preview with `dev-loop run --once --dry-run`, flip with
  `dev-loop team set team.mode live`), `prod` deploys stay manual, autonomy guarded —
  `dev-loop doctor` re-prints the verdict + `NEXT:` line any time.

A **workspace** is one directory = one team = one backend (the local hub, or one Linear team)
= one `dev-loop.json`. Repos are real clones inside it; projects are virtual groupings of
repos. All state lives under `<workspace>/.dev-loop/`, so **copying the folder migrates
machines**.

### Using Linear as the backend

`dev-loop init --backend linear` asks for the Linear team name (or defers it — fill later
with `dev-loop team set team.linearTeam "My Team"`). Linear onboarding runs in Claude Code,
so two one-time setups apply to this backend:

- Configure the **Linear MCP** in Claude Code **user scope** (doctor warns `W05` if the
  stewards couldn't reach the board).
- Register the npm-backed plugin marketplace for the `/dev-loop:*` slash commands, then run
  the two `/plugin ...` commands printed by the CLI inside Claude Code:

```bash
dev-loop install-claude-plugin
```

Then, inside Claude Code: `/dev-loop:add-project` (find-or-creates the Linear project,
labels, strategy doc) and `/dev-loop:add-repo` (clone + detect build/CI checks + deploy &
ops-probe interview). Verify and run exactly as above: `dev-loop doctor`,
`dev-loop run --once --dry-run`, `dev-loop run`.

### Moving to another machine

```bash
dev-loop hub stop                 # service teams only (checkpoints the WAL)
rsync -a ~/work/my-team/ newhost:~/work/my-team/
# on the new machine: install the CLI + your coding CLI, gh auth, export the env vars
cd ~/work/my-team && dev-loop team repair && dev-loop doctor && dev-loop run
```

Secrets never live in the workspace (config stores env-var *names*), so the folder is safe
to copy.

## Requirements

- **Node ≥ 23.6** and a coding CLI on `PATH`: `claude` (Claude Code) and/or `codex`.
- A backend: nothing — the bundled **service hub** (local sqlite + web UI, the default)
  needs no external service — or **Linear** (the Linear MCP configured in Claude Code
  user scope).
- **Linear backend only** (or if you want the `/dev-loop:*` slash commands inside Claude
  Code): `dev-loop install-claude-plugin`, then the printed `/plugin marketplace add ...`
  and `/plugin install ...` commands inside Claude Code. On the service backend agents
  reach the board through the `dev-loop` CLI itself — no plugin or MCP setup needed.
- **`gh` CLI** authenticated, for repos that land via PRs (`landing:"pr"` — the default
  `add-repo` shape; Dev opens/merges PRs with it). `landing:"direct"` repos don't need it.
- Per project: a git repo, a strategy doc, and a test environment URL.

## Configure

Everything lives in the workspace's **`dev-loop.json`** (the 1.x workspace schema), written by `team init`
and the validated mutators — you rarely hand-edit it. The edit path is
**`dev-loop team set <path> <value>`**, a whitelisted single-field mutator
(`team.mode`, `team.comms.*`, `projects.<k>.intake.mode`, `projects.<k>.communication.*` …):

- `workspaceId` — a fingerprint `team init` mints once; on Linear it marks the project so
  two workspaces double-driving one Linear team are detected.
- `team` — backend, deploy-policy ceiling (`prod` stays manual unless you say otherwise),
  `comms` (Slack/Lark channel as an env-var *name*; its presence is also what turns the
  daily director digest on), team-wide `intake` defaults (projects override field-wise),
  `hub.agentInterface` (service backend: how fires reach the hub board — `"cli"` for
  Claude Code and Codex by default; `"mcp"` is the rollback switch), per-agent cadences.
- `repos` — the physical registry: path, build/typecheck commands, PR merge checks,
  deploy shape, health probes.
- `projects` — virtual delivery units referencing repos: strategy doc, test env, `weight`
  (`0` = delivery rotation paused, stewards keep covering the project),
  `intake.mode` (`autonomous` default; `passive` = PM originates nothing and only responds
  to explicit `needs-pm` asks — verification and grooming continue), `intake.todoDepthCap`
  (how deep PM keeps the committed queue, default 10), launch overrides
  per agent (`agents.pm = { model, effort, cadence }` …), plus the optional strict-validated
  `communication` (article drafting) and `notify` (per-project webhook override) blocks.
  Don't declare a `_team` project: team intake lives only on the hub, and the config
  loader rejects the entry (`E11`).

Full field reference: [`references/config-schema.md`](references/config-schema.md). The agent
behavior spec: [`references/conventions.md`](references/conventions.md).

## Run the loop

One `dev-loop run` drives the whole team: delivery agents rotate across enabled projects
(weighted round-robin; `weight: 0` pauses a project's delivery rotation while the stewards
keep covering it), stewardship agents (sweep/ops/reflect/communication) fire at team
scope, and every agent runs with its own model + reasoning effort from config.

```bash
dev-loop run                              # everything, default cadences
dev-loop run --agents core,ops            # pick agents/groups (core = pm,qa,senior-dev,junior-dev,sweep)
dev-loop run --plan 8 --agents pm         # preview the next 8 project picks (no fires)
dev-loop run --interval pm=2m --max-fires 50   # cadence override + cost cap
dev-loop run --change-gate --fire-timeout 45m  # skip quiet fires + kill stuck ones
dev-loop run --once --dry-run             # print every resolved command, launch nothing
```

`--change-gate` (service backend) skips an inward fire when neither any repo HEAD nor the
board moved since its last run — except pm/qa, whose review/coverage work is at its best on
a quiet board: an unchanged board only *defers* them, and after `--change-gate-ttl`
(default 4h) they run once anyway. The dev tiers + architect keep the pure gate.

Prefer Claude Code's Agent View? Each `/loop` row calls `dev-loop next-project --agent <a>`
first — the rows and the scheduler share one rotation cursor and never double-fire.

### Command reference

| Command | What it does |
|---|---|
| `dev-loop init [--dir d] [--backend service\|linear] [--yes]` | guided onboarding: workspace + first project/repo, ends on doctor's `NEXT:` line |
| `dev-loop install-claude-plugin` | register the npm-backed Claude Code plugin marketplace and print the two `/plugin` commands |
| `dev-loop team init / import / repair` | create a workspace / migrate a v1 config / fix after a machine move |
| `dev-loop team set <path> <value>` | the whitelisted single-field config edit (e.g. `team.mode live`) |
| `dev-loop team add-project / add-repo [--detect]` | validated config writes; `--detect` reads build/CI facts from the clone |
| `/dev-loop:add-project` · `/dev-loop:add-repo` · `/dev-loop:sync-project` · `/dev-loop:sync-repo` | coding-CLI skills: backend sync, clone + detect, drift reconcile |
| `dev-loop run [--plan n] [--project k] [--once] [--dry-run]` | the team scheduler |
| `dev-loop doctor` | read-only health verdict (config validation, probes, fire success) + the `NEXT:` line |
| `dev-loop metrics [--window 7d] [--json] [--context]` | team KPIs: fire success, throughput, accept rate, QA escape ratio; `--context` = the per-agent per-fire context bill |
| `dev-loop notify [--level info\|warn\|error] [--title t] <text>` | push to the team's Slack/Lark channel |
| `dev-loop hub start\|stop\|status\|ensure` | the local hub daemon (service backend; `stop` checkpoints the WAL) |
| `dev-loop next-project --agent <a>` | the shared rotation picker for Agent-View `/loop` rows |
| `dev-loop with-repo-lock <ref> -- <cmd>` | serialize base-clone operations on a shared repo |
| `dev-loop export-desktop-skill <agent> --project <k> [--team]` | render a self-contained Claude Desktop skill |

The **hub write layer** — the same verbs agents use on the service backend
(`hub.agentInterface: "cli"`); handy for scripting the board yourself:

| Command | What it does |
|---|---|
| `dev-loop tickets [--state S] [--label L] [--q TEXT] [--json] …` | read-only board list (filter flags; `--json` = op-shaped output) |
| `dev-loop ticket <id> [--json]` | read-only single-ticket detail + comments |
| `dev-loop ticket create\|update …` | write sugar (careful: `--labels` REPLACES the full set; `--related-to` is append-only) |
| `dev-loop comment add <id>` · `comments <id>` | comment on a ticket / list its comments |
| `dev-loop labels` · `label create <name> [--kind K]` | list / create labels |
| `dev-loop project` · `events [--since ISO]` | the active project as JSON / attribution events |
| `dev-loop doc list\|get\|history\|diff\|save\|publish\|archive` | the doc family (`save` = optimistic CAS; `publish` operator-only; `archive` hides a retired design doc, never deletes) |
| `dev-loop mirror push\|poll\|status` | the one-way Linear mirror; `poll` converts human comments on mirrored docs into `needs-pm` intake |
| `dev-loop op <op-name> [--args-json '<JSON>']` | dispatch ANY hub op through the same `agentOp()` choke point (identity + guards included) |

Write-layer exit codes: `0` ok · `1` domain error · `2` usage · `3` doc CAS conflict ·
`4` identity/guard · `5` hub unavailable. Low-level compatibility/debugging commands such as
`dev-loop daemon ...`, `seed`, `init-service`, `serve`, `shim`, and `mcp-merge` still exist.
New 1.x workspace users should normally start from `init`, `team`, `hub`, and `run`.

## What you'll see day to day

- **New work lands in `Backlog`**; PM grooms, dedupes, and promotes to `Todo` under the depth
  cap — the board never floods. File your own asks as a `Backlog` ticket labelled
  `dev-loop`+`pm`+`needs-pm` — from the hub web ticket form, the CLI, or Linear; PM picks
  them up (never file work straight to a dev).
- **Direction changes ride the investigation protocol**: add the `investigation` label to
  your `needs-pm` ask and PM investigates first, posts findings, proposes the doc change
  (a hub doc draft + `Proposes:` line, or a unified diff on the ticket), and parks the
  ticket `In Review` for you — your version-bound publish (or approval comment) is the
  approval; nothing changes before it.
- **Sensitive changes** (auth, payments, PII, secrets, data migrations) always get a senior
  design before any code — autonomously, no confirmation prompts.
- **When the team parks on you** (`Human-Blocked`), the hub reminds you on your channel —
  every 24h by default once comms is configured — naming the exact resume command. Pending
  doc drafts show as a header chip in the web UI; a draft awaiting your publish for >24h
  gets one deduped comms line too.
- **A daily digest** on your Slack/Lark channel: team KPIs (from `dev-loop metrics`), QA
  quality, board flow, the north-star delta, pending investigation proposals, and a "needs
  the director" section that is empty on a good day. Incidents page you immediately;
  recoveries close the bracket.
- **Reports** accumulate per agent (files, or Linear docs via `reports.sink`) with weekly
  team retrospectives from Reflect.

## The agents

| Agent | Job | Fires |
|---|---|---|
| **PM** | strategy doc → tickets; grooms + promotes the Backlog; verifies features | 5m, per project |
| **QA** | tests the product, files bugs, re-tests fixes | 5m, per project |
| **senior-dev** | designs modules + sensitive work; delegates; takes escalations | 5m, per project |
| **junior-dev** | implements designed/scoped tickets | 5m, per project |
| **Sweep** | board hygiene, lifecycle repairs, drives the optional Linear mirror | 30m, team scope |
| **Ops** | polls prod health, files + pages confirmed incidents | 10m, team scope |
| **Reflect** | retrospectives, lessons library, north-star delta | daily, team scope |
| **Architect** | whole-codebase tech-debt audits | daily, per project |
| **Communication** | the daily director digest + article drafts | daily, team scope |

Full role contracts and protocols: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) +
[`references/conventions.md`](references/conventions.md).

## Docs

- [`docs/INDEX.md`](docs/INDEX.md) — which docs are current guides vs historical design records.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — local development, tests, build, and doc rules for contributors.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, workflows, backends, safety, self-evolution.
- [`references/conventions.md`](references/conventions.md) — the agent spec (state machine, labels, every protocol).
- [`references/config-schema.md`](references/config-schema.md) — the `dev-loop.json` field reference.
- [`docs/design/`](docs/design/) — design records: the 1.0 team/workspace line (proposal, engineering spec, GA checklist), the [2026-07 review decision record](docs/design/2026-07-review-decisions.md) behind 1.2.0, and the [SKILL template](docs/design/skill-template.md).
- [`docs/RUNNING.md`](docs/RUNNING.md) · [`docs/PORTABILITY.md`](docs/PORTABILITY.md) · [`docs/DAEMON.md`](docs/DAEMON.md) — operational deep dives for running, portability, and the service hub.
- [`CHANGELOG.md`](CHANGELOG.md) — version history.

## Release

Releases are cut by the **Release npm package** GitHub Actions workflow from `main`
(stamps the version, runs the suite, publishes with provenance, tags). See
[`docs/RELEASING.md`](docs/RELEASING.md).

## License

[MIT](LICENSE).
