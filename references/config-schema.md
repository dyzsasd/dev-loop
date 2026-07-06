# dev-loop — Config schema

Current dev-loop config lives in a workspace-local **`dev-loop.json`** using the 1.x workspace
schema. A workspace is one directory, one team, one backend, and the source of truth for every
repo/project the team runs.

The authoritative implementation lives in [`hub/src/team-config.ts`](../hub/src/team-config.ts);
this file is the operator-facing field reference.

## Discovery

Any dev-loop command resolves the workspace in this order:

1. `DEVLOOP_WORKSPACE` — absolute path to the workspace.
2. `DEVLOOP_TEAM` — team key resolved through the rebuildable `~/.dev-loop/workspaces.json` index.
3. Cwd ascent — walk upward to the first directory containing a valid `dev-loop.json`.

The index is only a convenience. The workspace folder itself is portable: copy it to another
machine, export the same env vars, run `dev-loop team repair`, then `dev-loop doctor`.

## Shape

```jsonc
{
  "schemaVersion": 2,
  "team": {
    "key": "jinko-devplatform",
    "backend": "linear",                     // "linear" | "service"
    "linearTeam": "Loop-1",                  // required for backend:"linear"
    "linearTeamId": null,

    "deployPolicy": {
      "dev": "auto",
      "prod": "manual"
    },

    "docSystem": "backend",                  // "backend" | "local"
    "docs": {
      "vision": null,
      "lessons": { "mirror": false }
    },

    "comms": {
      "provider": "lark",                    // "lark" | "slack"
      "webhookEnv": "DEVLOOP_COMMS_WEBHOOK"  // env var NAME, never the URL
    },

    "mode": "live",                          // "live" | "dry-run"
    "autonomy": "full",                      // team default; project may override

    "defaultCodingAgent": "claude",
    "codingAgentDefaults": {
      "claude": { "model": "opus", "effort": "high" },
      "codex": { "model": "gpt-5.5", "effort": "high" }
    },

    "agents": {
      "sweep": { "cadence": "30m" },
      "ops": { "cadence": "10m" },
      "reflect": { "cadence": "1d" }
    }
  },

  "repos": {
    "portal": {
      "path": "jinko-dev-platform",          // workspace-relative
      "remote": "git@github.com:org/portal.git",
      "owner": "devplatform",                // required when shared by multiple projects

      "landing": "pr",                       // "pr" | "direct"
      "autoMerge": true,
      "mergeChecks": ["Lint & Build"],

      "build": {
        "typecheck": "npm run typecheck",
        "build": "npm run build",
        "test": "npm test"
      },

      "deploy": {
        "style": "release-pr",               // "command" | "release-pr"
        "command": null,
        "healthCheck": "https://dev.example.com/health",
        "environments": {
          "dev": { "auto": true, "deployPrPrefix": "deploy/dev/" },
          "prod": { "auto": false, "deployPrPrefix": "deploy/prod/" }
        }
      },

      "ops": {
        "checks": [],
        "criticalRoutes": ["/health"],
        "logsCommand": null
      }
    }
  },

  "projects": {
    "devplatform": {
      "enabled": true,
      "weight": 1,
      "linearProject": "Dev Platform",
      "linearProjectId": null,

      "strategyDoc": { "path": "docs/STRATEGY.md" },
      "testEnv": {
        "baseUrl": "https://dev.example.com",
        "authConstraint": null,
        "notes": "Test personas and safe verification notes."
      },

      "intake": {
        "mode": "autonomous",
        "todoDepthCap": 10
      },

      "devSplit": true,
      "mode": "live",
      "autonomy": "full",

      "agents": {
        "pm": { "codingAgent": "claude", "model": "opus", "effort": "max", "cadence": "5m" },
        "junior-dev": { "codingAgent": "codex", "model": "gpt-5.5", "effort": "high" }
      },

      "reports": {
        "sink": "files"
      },

      "repos": [
        { "ref": "portal", "role": "primary" }
      ]
    }
  }
}
```

## Top-Level Fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Internal schema marker. Current 1.x workspace configs use `2`. |
| `team` | Team-wide backend, deploy ceiling, communication channel, reports defaults, and steward-agent launch defaults. |
| `repos` | Physical registry of git clones. Each repo is registered once and may be referenced by multiple projects. |
| `projects` | Virtual delivery units. A project references one or more repos and owns strategy/test/agent behavior. |

## `team`

| Field | Meaning |
|---|---|
| `key` | Stable team key, `^[a-z0-9-]{2,32}$`. |
| `backend` | `"linear"` or `"service"`. One backend per team. |
| `linearTeam` / `linearTeamId` | Linear team name/id for `backend:"linear"`. |
| `deployPolicy` | Per-environment ceiling. `manual` means no repo may auto-deploy that environment. |
| `docSystem` / `docs` | Where team/product docs live. |
| `comms` | Slack/Lark channel config. Store env var names only. |
| `mode` | Default `"live"` / `"dry-run"` for projects that do not override. |
| `autonomy` | Default autonomy posture for projects that do not override. |
| `defaultCodingAgent` | Default executor CLI (`claude`, `codex`, or `opencode`) when an agent does not override. |
| `codingAgentDefaults` | Default `{ model, effort }` per executor CLI. |
| `agents` | Team-scope agent launch config, mainly cadence for Sweep/Ops/Reflect/Communication. |

## `repos`

`repos.<ref>` describes physical repo facts. These facts live on the repo registry, not on each
project, so a shared repo has one build/deploy truth.

| Field | Meaning |
|---|---|
| `path` | Workspace-relative repo path. Must stay inside the workspace. |
| `remote` | Optional clone source for repair/sync. |
| `owner` | Required when a repo is referenced by more than one project. Used for ops/alert routing. |
| `landing` | `"direct"` or `"pr"`. |
| `autoMerge` | In PR mode, whether Dev may merge its own green PR. |
| `mergeChecks` | Required PR check contexts/job names. |
| `build` | Typecheck/build/test gates. |
| `deploy` | Command or release-PR deploy shape. |
| `ops` | Health checks, critical routes, and read-only logs command for Ops. |

## `projects`

`projects.<key>` is a virtual delivery unit. It points at repos, strategy, test environment, and
agent behavior.

| Field | Meaning |
|---|---|
| `enabled` | `false` removes the project from scheduling. |
| `weight` | Weighted round-robin weight. `0` pauses scheduling. |
| `linearProject` / `linearProjectId` | Backend project name/id. |
| `strategyDoc` | Strategy document reference, usually `{ "path": "docs/STRATEGY.md" }`. |
| `testEnv` | Base URL, auth constraints, setup notes, and verification hints. |
| `intake.mode` | `"autonomous"` (default): PM proactively reviews the product/strategy doc and files its own work. `"passive"`: PM originates nothing — it only responds to explicit `needs-pm` intake (conventions §5a); verification, unblocking, and grooming are unchanged. |
| `intake.todoDepthCap` | PM keeps committed `Todo` depth under this cap; default 10. |
| `devSplit` | `true` uses senior-dev + junior-dev. |
| `mode` / `autonomy` | Project overrides for team defaults. |
| `agents` | Per-agent coding CLI, model, effort, and cadence overrides. |
| `reports` | Report sink and review-channel config. |
| `repos` | Repo references: `{ "ref": "...", "role": "primary" }`. |

## Validation

`dev-loop doctor` is read-only and reports these schema errors:

| Code | Meaning |
|---|---|
| `E01` | Bad or missing `schemaVersion`. |
| `E02` | Bad `team.key` or unsupported backend. |
| `E03` | Repo path is missing, absolute, or escapes the workspace. |
| `E04` | Project references an unknown repo ref. |
| `E05` | Shared repo lacks a valid `owner`. |
| `E06` | Repo auto-deploys an env pinned to `manual` by `deployPolicy`. |
| `E07` | Bad comms provider or webhook env var name; URLs are rejected. |
| `E08` | Bad `enabled` / `weight`. |
| `E09` | Linear backend without `linearTeam`. |
| `E10` | Duplicate repo paths or duplicate `linearProjectId`. |
| `E11` | Reserved/invalid project key or repo ref. |
| `E12` | Bad `intake` block: `mode` not `"autonomous"`/`"passive"`, or `todoDepthCap` not a positive integer. |

Common warnings:

| Code | Meaning |
|---|---|
| `W01` | Project has no repos. |
| `W02` | Repo is referenced by nobody. |
| `W03` | Lessons INDEX/shard is over budget. |
| `W04` | Project sync is stale. |
| `W05` | Linear steward fires need the Linear MCP in user scope. |
| `W06` | Workspace root is inside a git worktree and `.dev-loop/` is not ignored. |
| `W07` | Deployed repo has no health probe for Ops. |

## State Layout

Everything runtime-related lives under `<workspace>/.dev-loop/`:

| Path | Contents |
|---|---|
| `<project>/` | Per-project state, reports, runner logs, and agent working files. |
| `team/` | Team-scope steward state, rotation cursor, `fires.jsonl`. |
| `lessons/` | Team lessons index, shards, and archive. |
| `wt/<ticket>/<repo>/` | Worktrees. |
| `locks/` | Repo/team locks. |
| `hub.db` | Service backend system of record. |
| `daemon.json` | Service hub daemon runfile. |

`~/.dev-loop/` keeps only the rebuildable workspace index.

## Commands

| Command | Meaning |
|---|---|
| `dev-loop install-claude-plugin` | Register the npm-backed Claude Code plugin marketplace and print the two interactive `/plugin` commands. |
| `dev-loop team init` | Create a workspace. Pure CLI: no LLM and no backend calls. |
| `dev-loop team repair` | Repair worktrees/index/WAL after a move. |
| `dev-loop doctor` | Read-only workspace verdict. |
| `dev-loop run` | Schedule the team from the workspace config. |
| `dev-loop hub start|stop|status|ensure` | Manage the workspace service hub daemon; normal 1.x lifecycle for `backend:"service"`. |
| `/dev-loop:add-project` | Coding-CLI skill that syncs backend project/labels and writes project config. |
| `/dev-loop:add-repo` | Coding-CLI skill that clones/detects/registers repo config. |
| `/dev-loop:sync-project` | Reconcile config vs backend project drift. |
| `/dev-loop:sync-repo` | Re-detect repo build/deploy/remote drift. |

Low-level compatibility/debugging commands such as `dev-loop daemon ...`, `seed`,
`init-service`, `serve`, and `mcp-merge` are intentionally not the first-run path for new
workspaces.

## Troubleshooting Map

| Signal | Meaning | Next step |
|---|---|---|
| `/dev-loop:*` commands are missing in Claude Code | The dev-loop plugin is not installed or the session has not refreshed. | Run `dev-loop install-claude-plugin`, execute the printed `/plugin` commands, then restart/refresh Claude Code. |
| `W05` | Linear steward fires need the Linear MCP in user scope. | Configure Linear MCP in Claude Code user scope, then rerun `dev-loop doctor`. |
| `W06` | `.dev-loop/` may be committed by accident. | Add `.dev-loop/` to the workspace repo's ignore rules. |
| Service hub has no URL | Daemon is stopped or cwd/workspace resolution failed. | Run `dev-loop hub ensure && dev-loop hub status` from the workspace root. |

## Security Notes

- Secrets never live in `dev-loop.json`; store env var names only.
- `team.comms.webhookEnv` must be an env var name, not a URL.
- Inline webhook/secret literals are rejected from workspace config.
- Copying the workspace folder should never copy credentials.
