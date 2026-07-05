# Team / Workspace 1.0 — GA readiness

> Status at `1.0.0-rc.1`: the team/workspace model is **code-complete and fully tested**. The remaining
> GA gates are operator-run (soak + real migrations on live infra) or explicitly-deferred service-only
> polish. This doc is the release checklist.

## What shipped (code + tests, all on PR #20)

| Milestone | Delivered | Test suites |
|---|---|---|
| **M1** config kernel | `team-config.ts` (schema v2, E01–E11, resolution API, `toLegacyView`), `workspace.ts` (discovery + `.dev-loop/` paths + self-healing index), `team init/import/repair`, doctor workspace checks, config wiring (server/daemon/run all read v2) | team-config (56), workspace (25), team-cli (27) |
| **M2** operator skills | validated `team add-project`/`add-repo` mutators, skills add-project/add-repo/sync-project/sync-repo, init 1.0 signpost, `export-desktop-skill --team` | team-cli (+9) |
| **M3** team scheduling | `rotation.ts` (nginx smooth-WRR), team-mode `run` (rotation / `--plan` / `--project` filter / enabled+weight / mtime hot-reload / team run lock), `next-project` shared picker, `fires.jsonl` ledger, `locks.ts` + `with-repo-lock` | rotation (16), team-scheduler (14) |
| **M4** stewardship + lessons + comms | steward-slot team-scoping, `lessons.ts` (INDEX/shards/archive + budgets, doctor W03), `comms.ts` + `dev-loop notify` (slack/lark), steward+delivery SKILL rewrites | lessons (8), comms (9) |
| **M5** hub + intake | `dev-loop hub start/stop/status/ensure` (workspace daemon + WAL checkpoint), `run` auto-ensure, team intake (conventions §9b + pm/sweep) | hub-lifecycle (8) |

**Full suite: 48 test files green (`npm test`, exit 0). Typecheck clean.** The pre-existing suite (daemon,
lifecycle, agent-api, shim, migrate, …) is byte-identical green — the v1 fixed-project path and the daemon
lifecycle were never behavior-changed (only additively wrapped).

## Invariants held

- **I4 portability** — all run state (incl. the service `hub.db`) lives under `<workspace>/.dev-loop/`;
  `~/.dev-loop` holds only a rebuildable index. `team import` moves legacy state in; `team repair` fixes
  worktree absolute paths + truncates the WAL after a move.
- **I5 secrets** — `comms.webhookEnv` (and all secrets) are env-var NAMES; a `://` value is rejected (E07);
  `notify` never prints the URL. Copying the workspace folder carries no secret.
- **I3 one-team-one-backend** — `team import` refuses a backend mismatch; no cross-team collaboration.
- **toLegacyView de-risk** — every existing consumer reads v2 through the compat view; the fire behavior
  diff is "where config comes from", not "what it looks like".

## GA gates — operator-run (cannot be done in-repo)

1. **Soak**: run devplatform (linear) + backoffice (service) as workspaces for ≥1 week; fire success-rate
   ≥95% (read `<ws>/.dev-loop/team/fires.jsonl`), zero P0 escalations, lessons INDEX within budget.
2. **backoffice service migration** (D5.5): `dev-loop team init --backend service` + `dev-loop team import
   --hub-db <old>` on the real backoffice; verify the events re-key + web board.
3. **Second-machine drill** (§10.3): copy a workspace folder to another machine, set env vars, `dev-loop
   team repair`, `dev-loop doctor` green, one live fire. No step 6.
4. **Cut 1.0.0**: `node hub/src/release-version.ts 1.0.0`, then publish the plugin marketplace update.

## Explicitly deferred (service-only polish; linear path is complete)

- **Web team overview** (D5.3): the daemon serves the `_team` board + the op-API today; a multi-project
  overview page (project cards + intake genealogy) is UI polish, not a blocker.
- **Service op-API steward `project` override** (D4.2→M5): lets a service steward write to a specific
  project's board from the `_team` identity. Linear stewards already route cross-project via the Linear
  MCP; on service, ops records alerts on `_team` tagged with the owner key until this lands. Broadens the
  MCP tool contract, so held for a focused change with the backoffice migration.

## Migration quickstart (devplatform, linear)

```
dev-loop team init --dir /Users/shuai/workspace/loop --key jinko-devplatform \
  --backend linear --linear-team Loop-1 --deploy dev=auto,prod=manual --comms lark
cd /Users/shuai/workspace/loop
dev-loop team import        # folds projects.devplatform → registry + project, moves state
/dev-loop:sync-project      # (in a coding CLI) records linearProjectId / linearTeamId
dev-loop doctor             # green
dev-loop run                # one team scheduler; or Agent View /loop rows (share the rotation cursor)
```
