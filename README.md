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

```bash
npm i -g @dyzsasd/dev-loop        # Node ≥ 23.6; installs the `dev-loop` CLI
```

A **workspace** is one directory = one team = one Linear team (or one local hub) = one
`dev-loop.json`. Repos are real clones inside it; projects are virtual groupings of repos.
All state lives under `<workspace>/.dev-loop/`, so **copying the folder migrates machines**.

```bash
# 1. Create the workspace (pure CLI — no LLM, no backend calls)
dev-loop team init --dir ~/work/my-team --key my-team \
  --backend linear --linear-team "My Team" --deploy dev=auto,prod=manual --comms lark
cd ~/work/my-team

# 2. In a coding CLI (Claude Code / Codex): create + backend-sync a project, then add repos
#      /dev-loop:add-project      — find-or-creates the Linear/hub project, labels, strategy doc
#      /dev-loop:add-repo         — clone + detect build/CI checks + deploy & ops-probe interview

# 3. Verify, preview, run
dev-loop doctor                   # read-only health verdict
dev-loop run --once --dry-run     # preview every agent's exact command (model + effort each)
dev-loop run                      # ONE scheduler drives the whole team; ^C stops everything
```

For a **linear** team, configure the Linear MCP in Claude Code **user scope** (doctor warns
`W05` if the stewards couldn't reach the board). For a **service** team, `dev-loop run`
auto-starts the local hub (`dev-loop hub status` to inspect it).

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
- **`gh` CLI** authenticated (Dev opens/merges PRs with it).
- A backend: **Linear** (the Linear MCP configured in Claude Code user scope) or nothing —
  the bundled **service hub** (local sqlite + web UI) needs no external service.
- Per project: a git repo, a strategy doc, and a test environment URL.

## Configure

Everything lives in the workspace's **`dev-loop.json`** (the 1.x workspace schema), written by `team init`
and the validated mutators — you rarely hand-edit it:

- `team` — backend, deploy-policy ceiling (`prod` stays manual unless you say otherwise),
  `comms` (Slack/Lark channel as an env-var *name*), per-agent cadences.
- `repos` — the physical registry: path, build/typecheck commands, PR merge checks,
  deploy shape, health probes.
- `projects` — virtual delivery units referencing repos: strategy doc, test env,
  `intake.todoDepthCap` (how deep PM keeps the committed queue, default 10), launch overrides
  per agent (`agents.pm = { model, effort, cadence }` …).

Full field reference: [`references/config-schema.md`](references/config-schema.md). The agent
behavior spec: [`references/conventions.md`](references/conventions.md).

## Run the loop

One `dev-loop run` drives the whole team: delivery agents rotate across enabled projects
(weighted round-robin), stewardship agents (sweep/ops/reflect/communication) fire at team
scope, and every agent runs with its own model + reasoning effort from config.

```bash
dev-loop run                              # everything, default cadences
dev-loop run --agents core,ops            # pick agents/groups (core = pm,qa,senior,junior,sweep)
dev-loop run --plan 8 --agents pm         # preview the next 8 project picks (no fires)
dev-loop run --interval pm=2m --max-fires 50   # cadence override + cost cap
dev-loop run --once --dry-run             # print every resolved command, launch nothing
```

Prefer Claude Code's Agent View? Each `/loop` row calls `dev-loop next-project --agent <a>`
first — the rows and the scheduler share one rotation cursor and never double-fire.

### Command reference

| Command | What it does |
|---|---|
| `dev-loop team init / repair` | create a workspace / fix after a machine move |
| `dev-loop team add-project / add-repo` | validated config writes (the `/dev-loop:*` skills call these) |
| `/dev-loop:add-project` · `/dev-loop:add-repo` · `/dev-loop:sync-project` · `/dev-loop:sync-repo` | coding-CLI skills: backend sync, clone + detect, drift reconcile |
| `dev-loop run [--plan n] [--project k] [--once] [--dry-run]` | the team scheduler |
| `dev-loop doctor` | read-only health verdict (config validation, probes, fire success) |
| `dev-loop metrics [--window 7d] [--json]` | team KPIs: fire success, throughput, accept rate, QA escape ratio |
| `dev-loop notify [--level info\|warn\|error] [--title t] <text>` | push to the team's Slack/Lark channel |
| `dev-loop hub start\|stop\|status\|ensure` | the local hub daemon (service backend; `stop` checkpoints the WAL) |
| `dev-loop next-project --agent <a>` | the shared rotation picker for Agent-View `/loop` rows |
| `dev-loop with-repo-lock <ref> -- <cmd>` | serialize base-clone operations on a shared repo |
| `dev-loop export-desktop-skill <agent> --project <k> [--team]` | render a self-contained Claude Desktop skill |

## What you'll see day to day

- **New work lands in `Backlog`**; PM grooms, dedupes, and promotes to `Todo` under the depth
  cap — the board never floods. File your own asks as a `Backlog` ticket labelled
  `dev-loop`+`pm`+`needs-pm`; PM picks them up (never file work straight to a dev).
- **Sensitive changes** (auth, payments, PII, secrets, data migrations) always get a senior
  design before any code — autonomously, no confirmation prompts.
- **A daily digest** on your Slack/Lark channel: team KPIs (from `dev-loop metrics`), QA
  quality, board flow, the north-star delta, and a "needs the director" section that is
  empty on a good day. Incidents page you immediately; recoveries close the bracket.
- **Reports** accumulate per agent (files, or Linear docs via `reports.sink`) with weekly
  team retrospectives from Reflect.

## The agents

| Agent | Job | Fires |
|---|---|---|
| **PM** | strategy doc → tickets; grooms + promotes the Backlog; verifies features | 5m, per project |
| **QA** | tests the product, files bugs, re-tests fixes | 5m, per project |
| **senior-dev** | designs modules + sensitive work; delegates; takes escalations | 5m, per project |
| **junior-dev** | implements designed/scoped tickets | 5m, per project |
| **Sweep** | board hygiene, lifecycle repairs, tracker upkeep | 30m, team scope |
| **Ops** | polls prod health, files + pages confirmed incidents | 10m, team scope |
| **Reflect** | retrospectives, lessons library, north-star delta | daily, team scope |
| **Architect** | whole-codebase tech-debt audits | daily, per project |
| **Communication** | the daily director digest + article drafts | daily, team scope |

Full role contracts and protocols: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) +
[`references/conventions.md`](references/conventions.md).

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, workflows, backends, safety, self-evolution.
- [`references/conventions.md`](references/conventions.md) — the agent spec (state machine, labels, every protocol).
- [`references/config-schema.md`](references/config-schema.md) — the `dev-loop.json` field reference.
- [`docs/design/`](docs/design/) — design records for the 1.0 team/workspace line (proposal, engineering spec, GA checklist).
- [`docs/RUNNING.md`](docs/RUNNING.md) · [`docs/PORTABILITY.md`](docs/PORTABILITY.md) · [`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md) · [`docs/DAEMON.md`](docs/DAEMON.md) — operational deep dives for running, portability, and the service hub.
- [`CHANGELOG.md`](CHANGELOG.md) — version history.

## Release

Releases are cut by the **Release npm package** GitHub Actions workflow from `main`
(stamps the version, runs the suite, publishes with provenance, tags). See
[`docs/RELEASING.md`](docs/RELEASING.md).

## License

[MIT](LICENSE).
