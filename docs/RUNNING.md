# Running dev-loop

This is the operational guide for the **1.0 workspace model**. If you are setting up a new
team, use this flow. The old machine-global `~/.dev-loop/projects.json` runtime path is no
longer read by 1.0; use `dev-loop team import` once if you are migrating a v1 install.

## 1. Create a Workspace

A workspace is one directory, one team, one backend, and one `dev-loop.json`. Repos are real
git clones inside the workspace; projects are virtual delivery units that reference those repos.

```bash
npm i -g @dyzsasd/dev-loop        # Node >= 23.6

dev-loop team init --dir ~/work/my-team --key my-team \
  --backend linear --linear-team "My Team" \
  --deploy dev=auto,prod=manual --comms lark

cd ~/work/my-team
```

Use `--backend service` when you want the bundled local hub instead of Linear. For a Linear
team, configure the Linear MCP in Claude Code user scope; `dev-loop doctor` warns with `W05`
when steward agents cannot reach the board.

## 2. Add Projects and Repos

`team init` creates only the workspace. It does not call an LLM and it does not touch Linear or
the hub. Project/repo onboarding runs from a coding CLI because it may inspect code, create
backend objects, and interview you about build/deploy details.

In Claude Code or Codex:

```text
/dev-loop:add-project
/dev-loop:add-repo
```

What those skills do:

| Skill | Result |
|---|---|
| `/dev-loop:add-project` | Finds or creates the Linear/hub project, ensures labels, scaffolds the strategy doc, and writes `projects.<key>` in `dev-loop.json`. |
| `/dev-loop:add-repo` | Clones or registers the repo, detects build/typecheck/CI checks, records deploy and health probes, adds `repo:<name>` labels when needed, and runs `dev-loop doctor`. |
| `/dev-loop:sync-project` | Reconciles config vs backend project drift: names, archived state, labels, strategy doc location. |
| `/dev-loop:sync-repo` | Re-detects repo build/deploy/remote drift, repairs missing clones, and refreshes repo metadata. |

The CLI equivalents `dev-loop team add-project` and `dev-loop team add-repo` perform validated
config writes; the slash skills are the friendly coding-CLI wrappers around them.

## 3. Verify Before Running

Run these from the workspace root:

```bash
dev-loop doctor
dev-loop run --once --dry-run
```

`doctor` is read-only. It validates schema, repo paths, deploy-policy ceilings, health probes,
Linear MCP reachability for steward fires, and workspace layout. `--dry-run` prints the exact
command that would launch each agent, including its selected coding CLI, model, effort, project,
and cadence.

## 4. Run the Team

The scheduler is the normal 1.0 launch path:

```bash
dev-loop run
```

One scheduler drives the whole team. Delivery agents rotate across enabled projects with weighted
round-robin. Stewardship agents run at team scope. Press `Ctrl-C` to stop the scheduler and any
active agent subprocess.

Useful variants:

```bash
dev-loop run --agents core,ops
dev-loop run --project devplatform --agents pm,qa
dev-loop run --plan 8 --agents pm
dev-loop run --interval pm=2m --max-fires 50
dev-loop run --once --dry-run
```

Agent groups:

| Group | Agents |
|---|---|
| `core` | `pm`, `qa`, `senior-dev`, `junior-dev`, `sweep` |
| `outward` | `ops`, `architect`, `communication` |
| `legacy` | the old single `dev` agent, only for projects that explicitly opt out of split Dev |

## 5. Agent View

Claude Code Agent View is still supported, but it is now the alternate path. Each row should call
the shared project picker before firing, so Agent View and `dev-loop run` do not double-pick the
same project slot.

Typical rows:

```text
/loop 5m  /dev-loop:pm-agent
/loop 5m  /dev-loop:qa-agent
/loop 5m  /dev-loop:senior-dev-agent
/loop 5m  /dev-loop:junior-dev-agent
/loop 30m /dev-loop:sweep-agent
/loop 10m /dev-loop:ops-agent
/loop 24h /dev-loop:reflect-agent
/loop 24h /dev-loop:architect-agent
/loop 24h /dev-loop:communication-agent
```

Agent View applies the view's model/effort profile to every row in that view. If you need
per-agent model and effort settings, prefer `dev-loop run`; the scheduler resolves those from
`dev-loop.json`.

## 6. Models, Effort, and Cadence

Model and effort are launch-time choices. A skill cannot change its model after the executor
starts, so the scheduler pins them before each fire.

Defaults are role based:

| Agent | Default posture |
|---|---|
| PM, senior-dev, Reflect, Architect | strongest reasoning; product/design/audit judgment |
| junior-dev, QA, Sweep, Ops, Communication | cheaper repeated work with high-enough reasoning |

Override them in `dev-loop.json`:

```jsonc
{
  "team": {
    "agents": {
      "sweep": { "cadence": "30m" },
      "ops": { "cadence": "10m" },
      "reflect": { "cadence": "1d" }
    }
  },
  "projects": {
    "devplatform": {
      "agents": {
        "pm": { "codingAgent": "claude", "model": "opus", "effort": "max", "cadence": "5m" },
        "junior-dev": { "codingAgent": "codex", "model": "gpt-5.5", "effort": "high" }
      }
    }
  }
}
```

Resolution order:

| Setting | Most specific wins |
|---|---|
| Coding CLI | `projects.<key>.agents.<agent>.codingAgent` → `--cli` → project/team default → built-in default |
| Model/effort | `projects.<key>.agents.<agent>` → team/default maps → built-in role default |
| Cadence | `--interval` → `projects.<key>.agents.<agent>.cadence` → `team.agents.<agent>.cadence` → built-in default |

## 7. The Service Hub

With `backend:"service"`, `dev-loop run` automatically ensures the local hub is available. You can
also manage it yourself:

```bash
dev-loop hub start
dev-loop hub status
dev-loop hub stop
dev-loop hub ensure
```

The hub stores its SQLite database under `<workspace>/.dev-loop/hub.db`. The web UI is localhost
only and read-first; human write routes are opt-in. See [`DAEMON.md`](DAEMON.md) and
[`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md) for the HTTP surface and storage model.

## 8. Moving a Workspace

Secrets are not stored in the workspace. `dev-loop.json` stores environment variable names, not
secret values.

```bash
dev-loop hub stop                 # service teams only; checkpoints the WAL
rsync -a ~/work/my-team/ newhost:~/work/my-team/

# On the new machine:
cd ~/work/my-team
dev-loop team repair
dev-loop doctor
dev-loop run
```

Also install your coding CLI, authenticate `gh`, configure Linear MCP if using Linear, and export the
same environment variables referenced by `dev-loop.json`.

## 9. Logs and Reports

Runtime state lives under `<workspace>/.dev-loop/`:

| Path | Contents |
|---|---|
| `.dev-loop/team/` | scheduler state, rotation cursor, team-level steward state |
| `.dev-loop/<project>/reports/` | agent daily/weekly/monthly reports when using file reports |
| `.dev-loop/lessons/` | team lessons index, shards, and archive |
| `.dev-loop/runner-logs/` or project runner logs | scheduler subprocess logs, depending on backend/version |
| `.dev-loop/hub.db` | service backend system of record |

Reports may also go to Linear docs when `reports.sink:"linear"` is configured.

## 10. Stopping Safely

- Stop the scheduler with `Ctrl-C`.
- For service teams, run `dev-loop hub stop` before copying the workspace or doing maintenance.
- `dev-loop doctor` remains read-only. Use `dev-loop team repair` for post-move repair work such as
  worktree repair, index rebuilds, and WAL checkpointing.

## Legacy Migration

The 1.0 runtime does not read `~/.dev-loop/projects.json`. To migrate an old install:

```bash
dev-loop team init --dir <workspace> --key <team> --backend <linear|service> ...
cd <workspace>
dev-loop team import
dev-loop doctor
```

After that, run only from the workspace and treat `dev-loop.json` as the source of truth.
