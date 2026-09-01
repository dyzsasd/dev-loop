# dev-loop — Config schema

Current dev-loop config lives in a workspace-local **`dev-loop.json`** using the 1.x workspace
schema. A workspace is one directory, one team, one backend, and the source of truth for every
repo/project the team runs.

The authoritative implementation lives in [`hub/src/team-config.ts`](../hub/src/team-config.ts);
this file is the operator-facing field reference.

## Discovery

Any dev-loop command resolves the workspace in this order:

1. `DEVLOOP_WORKSPACE` — absolute path to the workspace.
2. `DEVLOOP_TEAM` — team key resolved through the rebuildable workspace index at
   `${XDG_CONFIG_HOME:-~/.config}/dev-loop/workspaces.json` (`DEVLOOP_HOME` relocates it).
3. Cwd ascent — walk upward to the first directory containing a valid `dev-loop.json`.

The index is only a convenience. The workspace folder itself is portable: copy it to another
machine, export the same env vars, run `dev-loop team repair`, then `dev-loop doctor`.

## Shape

```jsonc
{
  "schemaVersion": 2,
  "workspaceId": "0f0e0d0c-…",               // workspace fingerprint; minted by `team init`, stable forever
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
      "webhookEnv": "DEVLOOP_COMMS_WEBHOOK"  // env var NAME, never the URL (value: .dev-loop/secrets.env or the env)
    },

    "mode": "live",                          // "live" | "dry-run"
    "autonomy": "full",                      // team default; project may override

    "defaultCodingAgent": "claude",
    "codingAgentDefaults": {
      "claude": { "model": "opus", "effort": "high" },
      "codex": { "model": "gpt-5.5", "effort": "high" }
    },

    "hub": {
      "agentInterface": {                      // service backend: how fires reach the hub board (D8)
        "claude": "cli",                       // the default — the dev-loop CLI write verbs
        "codex": "mcp"                         // the ROLLBACK shape — the default is "cli" (P8 certified 2026-07-11)
      }
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

      "communication": {                       // communication agent ARTICLE config (all fields optional)
        "cadence": "daily",
        "language": "en",
        "audience": "builders and product teams",
        "tone": "clear, specific, optimistic but not hypey",
        "maxWords": 900,
        "sourceWindowDays": 7,
        "output": "data",                      // "data" (state dir) | "repo" (doc-home repo)
        "outputDir": "communications",
        "repoOutputDir": "docs/communications",
        "includeUnreleased": false
      },

      "notify": {                              // per-project §9 webhook OVERRIDE (team.comms is canonical)
        "type": "slack",                       // "slack" | "lark"
        "webhookEnv": "MY_PROJECT_WEBHOOK",    // env var NAME, never the URL
        "secretEnv": null,                     // optional Lark sign-secret env NAME
        "events": ["human-parked"]             // optional event scope
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
| `workspaceId` | Workspace fingerprint: a random id `team init` mints once and keeps stable (even across `--force` re-init). On `backend:"linear"`, `add-project`/`sync-project` stamp it into the Linear project description as `[dev-loop:workspace:<id>]`; a foreign marker means another workspace already drives that project and dev-loop warns loudly instead of double-driving it. Unknown/extra top-level keys are tolerated, so older CLIs read fingerprinted configs unchanged. |
| `team` | Team-wide backend, deploy ceiling, communication channel, reports defaults, and steward-agent launch defaults. |
| `repos` | Physical registry of git clones. Each repo is registered once and may be referenced by multiple projects. |
| `projects` | Virtual delivery units. A project references one or more repos and owns strategy/test/agent behavior. |

## `team`

The `team set` column marks the fields `dev-loop team set <path> <value>` may update (the validated
single-field mutator; see [Operator-tunable fields](#operator-tunable-fields-dev-loop-team-set)).

| Field | Meaning | `team set` |
|---|---|---|
| `key` | Stable team key, `^[a-z0-9-]{2,32}$`. | — |
| `backend` | `"linear"` or `"service"`. One backend per team. | — |
| `linearTeam` / `linearTeamId` | Linear team name/id for `backend:"linear"`. | ✓ `team.linearTeam` |
| `deployPolicy` | Per-environment ceiling. `manual` means no repo may auto-deploy that environment. | — |
| `docSystem` / `docs` | Where team/product docs live. | — |
| `comms` | Slack/Lark channel config (`dev-loop notify`). Store env var names only — the values live in `<workspace>/.dev-loop/secrets.env` or the process env (env wins; loaded automatically at workspace resolution). Its presence is also the **§22a team-digest gate**: with `team.comms` set, the team-scope communication fire composes and pushes the daily director digest — a per-project `communication` block never gates the digest. `dev-loop doctor` checks resolvability (`W12`). | ✓ `team.comms.provider`, `team.comms.webhookEnv` |
| `mode` | Default `"live"` / `"dry-run"` for projects that do not override. Validated by `E19`. | ✓ `team.mode` |
| `git.defaultBranch` | Team-wide integration branch for repos that do not set their own. Resolution: `repos.<ref>.defaultBranch ?? team.git.defaultBranch ?? "main"` (§19). | ✓ `team.git.defaultBranch` |
| `autonomy` | Default autonomy posture for projects that do not override: `"ask"` (escalate genuine ambiguity, §12a) or `"full"`. `"guarded"` — what `team init` wrote before 1.15.1 — is accepted as a legacy **input alias** and resolves to `"ask"`; it is never stored by any current writer and never resolves to `"full"`. Validated by `E19`. | ✓ `team.autonomy` |
| `intake` | Team-wide default intake block (`mode`, `todoDepthCap`); seeded by `team init --intake-mode`. Projects override **field-wise** (nearest wins per field), so a project tuning only `todoDepthCap` keeps a team-level `"passive"`. | ✓ `team.intake.mode`, `team.intake.todoDepthCap` |
| `agentReviewers` | Comma-separated list of GitHub login names that belong to bots/agents and should be **excluded** from merge-guard's forge-review axis (§3.2). A reviewer in this list whose `CHANGES_REQUESTED` review or unresolved thread would otherwise block a merge is silently ignored — only human objections halt the guard. Example: `"github-actions[bot],renovate[bot]"`. Set with `dev-loop team set team.agentReviewers "login1,login2"`; stored as a JSON string array in `dev-loop.json`. | ✓ `team.agentReviewers` |
| `budget.dailyUsd` | Rolling 24 h spend ceiling in USD. When set to a positive number, the scheduler refuses to launch a new fire if the past 24 h ledger total exceeds this amount. `null` or unset = **OFF** (no ceiling, the default). Set via `dev-loop team set team.budget.dailyUsd <n\|null>`. Enforcement lands with Child 3 of the budget-ceiling design. | ✓ `team.budget.dailyUsd` |
| `budget.perFireUsd` | Per-fire estimated spend ceiling in USD. A positive number terminates a single fire whose elapsed estimated cost crosses this value; the fire is recorded with `errorClass:"budget-per-fire"` (exit `126`) — distinct from a wall-timeout (`"timeout"`, exit `124`) — and its claimed ticket is released back to `Todo`. Unset = **ON at the `$12.00` default** (unlike `dailyUsd`, this ceiling ships enabled: it bounds ONE fire, so it can never refuse every launch). Derivation: the worst observed runaway was `$18.21` in ~60 min while a normal fire costs pm `$6.43` / senior `$7.46`, so `$12.00` clears the priciest normal fire by ~61 % and still catches the runaway class at ~⅔ of its runtime. Mid-flight cost is unknowable, so the deadline is `perFireUsd / ratePerMs` where `ratePerMs` is this `(codingAgent, model)`'s median `costUsd/durationMs` over the last 7 d of the ledger. Set via `dev-loop team set team.budget.perFireUsd <n>`. | ✓ `team.budget.perFireUsd` |
| `approvals.enforce` | Which action classes the **approvals record actually gates** — a list of class names, **default empty (nothing is enforced)**. The record itself (`dev-loop approve` / `revoke` / `approvals`) has no switch and is always available; this list decides which enforcing consumers refuse without a grant. Legal classes: `npm-publish`, `push`, `reopen`, `board-restore`, `remove-project` — an unknown name is an `E18` error rather than an accepted string, because a typo here is enforcement you believe is on and that is off. Per class, not global, and deliberately: enabling `reopen` is nearly free, whereas enabling `push` changes what every fire in the workspace may land. Today's only enforced class is **`push`**, and it has TWO enforcing consumers: **`dev-loop push-guard --strict`** (the read-only check — exits `1` on an ungranted commit) and **`dev-loop push`** (LOOP-521 — the verb that runs that same gate AND issues the `git push`, so a ship path cannot reach the push without the gate; no flag waives it). With the class listed, a commit whose ticket carries a `push:` approval row needs a granted, unexpired approval keyed `push:<branch>:<sha>`. An approval names an END STATE, so the `<sha>` is load-bearing — a grant for one commit does not authorise the next. `doctor` `W40` warns when approval rows exist while this list is empty; `W41` warns on a grant that never expires. Set with `dev-loop team set team.approvals.enforce push` (comma-separated; the empty string clears it). | ✓ `team.approvals.enforce` |
| `defaultCodingAgent` | Default executor CLI (`claude`, `codex`, or `opencode`) when an agent does not override. | — |
| `codingAgentDefaults` | Default `{ model, effort }` per executor CLI. | — |
| `providers` | Registry of **custom OpenAI-compatible model endpoints** for the opencode lane (E16; `docs/design/model-provider-routing.md`). Entry: `{ kind:"openai-compatible", baseUrl, authTokenEnv, models[], extraOptions?, effortMode? }` — the id doubles as the opencode provider key and the `agents{}.model` prefix (`<id>/<model-id>`). Rendered into `<workspace>/opencode.json` by `dev-loop team sync-opencode` with `{env:VAR}` auth indirection (§16 — value in `secrets.env`). Built-in opencode providers (openrouter, zhipuai, …) need **no** entry: auth + the model string suffice (`opencode models` lists the launchable ids). | — |
| `opencodePermission` | Whole-object override of the per-fire `OPENCODE_PERMISSION` injection (E16). Default is the certified wildcard-deny policy (PORTABILITY §5) — deny-by-default closes operator-installed custom exec tools; replace only with another deny-based shape. | — |
| `hub.agentInterface` | `backend:"service"` only: per coding agent, how a fire reaches the hub board — `"cli"` (the PATH-installed `dev-loop` write verbs; identity rides the fire env) or `"mcp"` (the scheduler-injected `dev-loop-hub` MCP server). Defaults: `claude`/`codex` → `"cli"` (codex since its 2026-07-11 P8 env-propagation certification, docs/PORTABILITY.md §4), `opencode` → `"mcp"`. This is also the rollback switch: set `"claude": "mcp"` / `"codex": "mcp"` to restore the injected-MCP behavior. Projects override per coding agent. | — |
| `backup` | Board-snapshot cadence and retention. `everyHours` (number, default `6`; `0` disables) · `keep` (integer ≥ 1, default `10`) · `dir` (string, default `<state>/snapshots`). `everyHours` becomes a `setTimeout` delay, so it is bounded ABOVE by Node's 32-bit timer limit (~596.5h): a larger value would be coerced to 1ms and snapshot the board every millisecond, and `E18` refuses it for that reason. Note that each DAEMON runs this timer, so a workspace with two daemons writing to one directory consumes `keep` at twice the rate. Validated by `E18`. | — |
| `agents` | Team-scope per-agent launch config, and the TEAM-LEVEL DEFAULT for every project: `projects.<key>.agents.<h>` merges over it PER FIELD, so a project pinning only `model` keeps the team's `effort` for that lane. Fields: `codingAgent`, `model`, `effort`, `cadence`, `fireTimeout` (max wall-clock per fire; `"0"` = off; default `"1h"`), `stallTimeout` (kill if no stdout for this long; `"0"` = off; default `"10m"` for opencode, off for claude/codex), `enabled` (**the scheduling switch**: `false` ⇒ the scheduler does not fire this lane; doctor's W16 owner-liveness warning is UNAFFECTED, because a parked lane still strands tickets), `manual` (P1-4, marks operator-run roles — the scheduler skips the lane AND W16 downgrades, since "no fires in 7d" is expected for a human-run role), `codexSandbox` (`"safe"` \| `"bypass"` — this agent's codex sandbox posture, beats `team.codex.sandbox`), `conventionsPull` (LOOP-237; only meaningful with `bootCorpus:false`). `agents.<h>.manual:true` declares a role the operator runs BY HAND — the scheduler does not fire it, and owner-liveness (doctor `W16`, the Sweep digest) reports its stranded tickets as "awaiting a human" instead of warning. Use `enabled:false` to park a lane WITHOUT silencing that warning. Both resolve per project (`projects.<key>.agents.<h>`) as well as team-wide, and a park on a lane's owning ACTOR (`pm`) parks its lanes (`pm-groom`); a park on a STEWARD at project scope is refused by `E17` — stewards fire at team scope. There is no other off switch: `cadence: 0` is refused as "a hot loop, not a disable". Validated by `E17` — a bad duration value names the offending agent + field. | — |
| `bootCorpus` | The §0a **boot corpus** — the scheduler pre-assembles each fire's conventions slice (config-pruned, ≤ 64 KB per agent), the **Resolved config** block (§0a step 2), the backend contract and the agent's lessons slice, and inlines them into the prompt's byte-constant segment so consecutive fires of one agent share a prompt-cache prefix. **Default `true` on every lane** (claude, codex, opencode; the prompt then rides stdin). `false` is the explicit opt-out: fires boot in §0a *pull* mode and read the files themselves (`doctor` `W03` then notes the push budget is not being delivered against). A run can override either way with `dev-loop run --assemble-boot` / `--no-assemble-boot`. | ✓ `team.bootCorpus` |
| `humanBlocked` | **`"on"` (default) \| `"off"`** — whether `Human-Blocked` is a PARKING PLACE. The state always exists and existing parked tickets are never migrated. `"off"` means nobody is coming: agents may not move a ticket into it (the write layer refuses, naming the route), **PM** may record the `Ruling:` that replaces the park (only pm, only while "off"), the daemon's Human-Blocked reminder goes silent for the project, and doctor drops `W20` for it in favour of one informational line (which also lists tickets parked before the switch). Only a prerequisite ONLY a human can supply still waits — at `Backlog` + `blocked` + its `external-prereq`/`external-access` labels, which is the §9c tracker, not the decision queue. **Orthogonal to `autonomy`**: `autonomy` decides how boldly an agent decides, `humanBlocked` decides whether there is anybody to wait for, so `autonomy:"ask"` + `humanBlocked:"off"` is a legal pair (PM decides cautiously, by itself). `approvals.enforce` is unaffected. Per project: `projects.<key>.humanBlocked`. Validated by `E19`. | ✓ `team.humanBlocked` |
| `codex.sandbox` | The codex lane's sandbox posture: **`"safe"` (default)** passes NO approval/sandbox bypass flag — `codex exec` then runs under its own non-interactive defaults, **`approval: never` + `sandbox: read-only`** (codex-cli 0.147.0 prints exactly those header lines), so an **unattended** fire's write-shaped shell/MCP calls are refused inside the fire, the model ends its turn, and the process **still exits 0** — the ledger records a success and the breaker never trips. `"bypass"` adds `--dangerously-bypass-approvals-and-sandbox` to every codex fire (the pre-WS-A unattended shape — **set this to restore an unattended codex lane**). `--skip-git-repo-check` rides on EVERY codex fire regardless (it only lifts codex's startup refusal outside a git tree — a team-scope steward's cwd is the workspace root, which is not one). Per agent: `agents.<h>.codexSandbox`. A run-wide `dev-loop run --codex-unsafe` beats both; `--codex-safe` is accepted as a no-op. **Unset while any enabled project routes a handle to codex ⇒ doctor `W45`**, and `dev-loop run` prints one `NOTICE codex sandbox=safe (default)` line at boot. Validated by `E18`. | ✓ `team.codex.sandbox` |
| `claude.allowedTools` / `claude.permissionMode` | The claude lane's permission surface, passed through as `--allowedTools <a,b,…>` (a non-empty array of tool strings, e.g. `["Read", "Bash(git log:*)"]`) and `--permission-mode <default\|acceptEdits\|plan\|bypassPermissions\|dontAsk>`. Absent ⇒ no flag — claude's own settings apply, exactly as before. Validated by `E18`. | — |
| `pricing` | Optional per-lane price table for `dev-loop metrics --usage`'s **cost-by-channel** estimate: `{ "<claude\|codex\|opencode>": { inputUsdPerMTok, cacheWriteMultiplier?, cacheReadMultiplier?, outputMultiplier? } }`. `inputUsdPerMTok` is the price of one million UNCACHED input tokens; the channel multipliers default to the Anthropic-style **1.25× cache write / 0.1× cache read / 5× output**. A lane with no entry reports tokens only and says `unpriced`. Validated by `E18`. | — |

## `repos`

`repos.<ref>` describes physical repo facts. These facts live on the repo registry, not on each
project, so a shared repo has one build/deploy truth.

| Field | Meaning | `team set` |
|---|---|---|
| `path` | Workspace-relative repo path. Must stay inside the workspace. | — |
| `remote` | Optional clone source for repair/sync. | — |
| `owner` | Required when a repo is referenced by more than one project. Used for ops/alert routing. | — |
| `landing` | `"direct"` or `"pr"`. | — |
| `autoMerge` | In PR mode, whether Dev may merge its own green PR. | — |
| `mergeChecks` | Required PR check contexts/job names. | — |
| `ciIrrelevantPaths` | Repo-relative paths whose changes cannot affect any check result: an exact file (`docs/STRATEGY.md`) or a directory prefix ending in `/` (`docs/strategy-archive/`). No globs — a glob language is a second thing to get wrong, and every case this exists for is a file or a directory. **Stored as a JSON string array** — `"ciIrrelevantPaths": ["docs/STRATEGY.md", "docs/strategy-archive/"]`; a comma-joined string in `dev-loop.json` is refused with `E08` ("must be an array of strings"), so comma separation is the `team set` VALUE form only. When absent, every delta stales (v1 behaviour). | ✓ `repos.<ref>.ciIrrelevantPaths` (dot-free ref only — below) |
| `defaultBranch` | This repo's integration branch — what dev worktrees branch off, what PRs target, and what a rebase-on-`DIRTY` rebases onto. Per-repo override; resolves `repos.<ref>.defaultBranch ?? team.git.defaultBranch ?? "main"` (the §19 resolution rule). Set it when a repo integrates on something other than `main` (e.g. `master`, `develop`). | — |
| `build` | Step-5 ship gates, run in order: `typecheck` → `build` → `test` → `quality`. `quality` is the optional CRAP/mutation gate (quality-gauntlet design): e.g. `"quality": "dev-loop quality --changed --threshold 30"` — per-function `CRAP = CC² × (1−cov)³ + CC` over native V8 coverage, exit 2 over threshold; `--mutate` adds the test-strength probe (self-restoring operator flips; a SURVIVED mutant = a test that doesn't bite). **Language is per FILE**: `.ts/.js` ride the typescript AST + V8 coverage; `.go` rides a token scanner + `go test -coverprofile` (block-level claimed-bytes — an untested Go fn is a true 0%), same formula/report/gate; a Go repo needs only `"quality": "dev-loop quality --changed --threshold 30"` like any other. `add-repo --detect` maps package.json scripts named `typecheck`/`build`/`test`/`quality`. | — |
| `deploy` | Command or release-PR deploy shape. | ✓ `repos.<ref>.deploy.style`, `.deploy.healthCheck`, `.deploy.environments.<env>.{auto,deployPrPrefix,command,healthCheck}` |
| `ops` | Health checks, critical routes, and read-only logs command for Ops. | — |

`dev-loop team add-repo <ref> --project <key> --path <rel> --detect` fills the detectable fields
deterministically (no LLM): it clones from `--remote` when the path is missing, maps `package.json`
scripts named `typecheck`/`build` to runner commands (runner chosen by lockfile: pnpm/yarn/npm),
lists `.github/workflows` job names as candidate `mergeChecks`, and infers `defaultBranch` from
`git symbolic-ref refs/remotes/origin/HEAD`. It registers with `landing:"pr"` and
no auto-merge; interview-only fields (`deploy`, `ops`, `owner`) stay unset and `dev-loop doctor`
surfaces the gap. Explicit flags always beat detection — `--default-branch <name>` sets
`repos.<ref>.defaultBranch` directly, skipping inference.

## `projects`

`projects.<key>` is a virtual delivery unit. It points at repos, strategy, test environment, and
agent behavior.

| Field | Meaning | `team set` |
|---|---|---|
| `enabled` | `false` removes the project from scheduling entirely — both delivery rotation and steward coverage. | ✓ `projects.<key>.enabled` |
| `weight` | Weighted round-robin share of delivery fires. `0` pauses delivery rotation only (maintenance mode) — stewards (sweep/ops/reflect/communication) keep covering the project. | ✓ `projects.<key>.weight` |
| `linearProject` / `linearProjectId` | Backend project name/id. | — |
| `strategyDoc` | Strategy document reference, usually `{ "path": "docs/STRATEGY.md" }`. Under `intake.mode:"passive"` + `backend:"service"` the daemon watches the repo-file form for operator edits (see [Hub daemon notifier settings](#hub-daemon-notifier-settings-backendservice)). | — |
| `testEnv` | Base URL, auth constraints, setup notes, and verification hints. | ✓ `projects.<key>.testEnv.baseUrl`, `.testEnv.authConstraint` |
| `intake.mode` | `"autonomous"` (default): PM proactively reviews the product/strategy doc and files its own work. `"passive"`: PM originates nothing — it only responds to explicit `needs-pm` intake (conventions §5a); verification, unblocking, and grooming are unchanged. Falls back to `team.intake` field-wise. | ✓ `projects.<key>.intake.mode` |
| `intake.todoDepthCap` | PM keeps committed `Todo` depth under this cap; default 10. | ✓ `projects.<key>.intake.todoDepthCap` |
| `devSplit` | `true` uses senior-dev + junior-dev. | ✓ `projects.<key>.devSplit` |
| `mode` / `autonomy` | Project overrides for team defaults; same token sets and same `E19` validation as the `team` block. `autonomy` normalizes the legacy `guarded` → `ask` at resolution. | ✓ `projects.<key>.mode`, `projects.<key>.autonomy` |
| `hub.agentInterface` | Project override of `team.hub.agentInterface`, merged **per coding agent** (a project flipping only `claude` keeps the team-level `codex` setting). | — |
| `agents` | Per-agent overrides ON TOP of `team.agents.<h>`, merged per field (this side wins). Fields: `codingAgent`, `model`, `effort`, `cadence` (**team-scope only** — rejected by `E17` at project scope; use `team.agents` or tune the project's rotation `weight` instead), `fireTimeout` (**delivery fires only**; max wall-clock per fire; `"0"` = off; default `"1h"`), `stallTimeout` (**delivery fires only**; kill if no stdout for this long; `"0"` = off; default `"10m"` for opencode, off for claude/codex). Duration strings: `"30m"`, `"1h"`, `"10s"`. **A bare number means MINUTES** — `"600"` is ten hours, not
ten minutes; write the unit. Three of these do not take effect at the resolution they are written with,
and the difference is not small enough to leave unsaid:
`stallTimeout` is checked on a **fixed 15s poll**, so any value below 15s behaves as 15s and a value
between ticks rounds up to the next one (`3s` fires at 15s, `20s` at 30s); `fireTimeout` is a real timer
and IS exact; and `cadence` is measured from a fire's **completion**, so a lane's actual period is
`cadence + the fire's own duration` (a senior-dev lane at `cadence: "10m"` whose fires run 20 minutes
repeats about every 30 minutes, not every 10). Resolution order for timeouts: project-scope per-agent config (delivery fires only) > team-scope per-agent config > explicit `--fire-timeout`/`--stall-timeout` CLI flag > per-lane/global default. Validated by `E17` — a bad value names the offending agent + field. | — |
| `reports` | Report sink and review-channel config. | — |
| `communication` | The communication agent's **article** config (see [`projects.<key>.communication`](#projectskeycommunication--article-drafting) below). Presence of this block is what makes per-project article drafting fire; it is **not** the §22a digest gate. | ✓ `projects.<key>.communication.*` (every scalar field) |
| `notify` | Per-project §9 webhook **override** (see [`projects.<key>.notify`](#projectskeynotify--the-9-webhook-override) below). Absent ⇒ `team.comms` is bridged in automatically. | ✓ `projects.<key>.notify.{type,webhookEnv,secretEnv}` |
| `repos` | Repo references: `{ "ref": "...", "role": "primary" }`. | — |

### `projects.<key>.communication` — article drafting

Read by the communication agent (`skills/communication-agent`) each fire. **All fields are
optional**; the block's *presence* is what opts a project into per-project article drafting
(no block + no explicit user request ⇒ the agent no-ops for that project). Keys are validated
**strictly** (`E14`): an unknown key is a hard config error, because a typo here would silently
change what a fire does. Edit path: `dev-loop team set projects.<key>.communication.<field> <value>`.

| Field | Type / values | Default | Meaning |
|---|---|---|---|
| `cadence` | string | `"daily"` | How often an article is drafted. |
| `language` | string | `"en"` | Article language. |
| `audience` | string | `"current and prospective users"` | Who the article addresses. |
| `tone` | string | `"clear, concrete, human, and restrained"` | Style directive. |
| `maxWords` | integer ≥ 1 | `900` | Article length budget. |
| `sourceWindowDays` | integer ≥ 1 | `7` | How far back shipped-work sources reach. |
| `output` | `"data"` \| `"repo"` | `"data"` | Draft destination: the project state dir, or the doc-home repo. |
| `outputDir` | string | `"communications"` | Subdir under the state dir (`output:"data"`). |
| `repoOutputDir` | string | `"docs/communications"` | Repo path (`output:"repo"`). |
| `includeUnreleased` | boolean | `false` | Whether roadmap items may appear (clearly framed as upcoming). |

**The §22a director digest is NOT gated on this block.** The team daily digest (conventions
§22a) keys on **`team.comms` presence**: a team-scope communication fire composes and pushes
the digest whenever `team.comms` is configured, whether or not any project carries a
`communication` block — the scheduler stamps the comms fact into every team-scope fire's
context. A missing per-project block therefore never silently suppresses the director's one
message a day; conversely, without `team.comms` there is no digest channel and the fire
reports the missing channel instead.

### `projects.<key>.notify` — the §9 webhook override

The one-way webhook the hub daemon's notifiers (Human-Blocked pings, no-progress alerts) send
over. On the 1.x workspace schema **`team.comms` is canonical**: when a project has no `notify`
block, `team.comms` is bridged into it automatically, so most workspaces never write this block.
Set it only to point ONE project at a different channel. Keys are validated strictly (`E15`).
Edit path: `dev-loop team set projects.<key>.notify.<field> <value>` (setting `type` first
bootstraps the block with `webhookEnv` defaulted to `DEVLOOP_COMMS_WEBHOOK`).

| Field | Type / values | Meaning |
|---|---|---|
| `type` | `"slack"` \| `"lark"` | Provider (required). |
| `webhookEnv` | env-var NAME | Where the webhook URL lives at runtime (required). **Never a URL** — inline `webhook`/`secret` literals are rejected (`E15`, §16). The value itself goes in `<workspace>/.dev-loop/secrets.env` or the process env (env wins). |
| `secretEnv` | env-var NAME | Optional Lark sign-secret env name. |
| `events` | string array | Optional event scope (e.g. `["human-parked"]`); omitting an event name opts it out. |

## Hub daemon notifier settings (`backend:"service"`)

The hub daemon's background notifiers read two per-project knobs from the hub DB's
`projects.settings_json` (operator-set via seed/CLI — deliberately **not** part of
`dev-loop.json`; see `docs/DAEMON.md` → *Background notifiers*):

| Field | Meaning |
|---|---|
| `humanBlockedReminderHours` | Cadence (hours) of the daemon's **decision-queue** reminder — Human-Blocked tickets ∪ `In Review` assigned to the operator (P1-3, each shape with its own marker/wording): the first ping when an item is parked plus the periodic repeats (conventions §9a). **Default: `24` whenever a comms channel is configured (`team.comms` present — it is bridged to the daemon as the §9 `notify` webhook), else `0` (off).** An explicit `0` stays the opt-out even with comms configured; an explicit positive value always wins over the default. |
| `noProgressWindowHours` | Rolling window (hours) for the loop no-progress circuit-breaker; `0`/absent ⇒ off (no default flip). |
| `fireHealth` | The loop fire-health self-monitor (P0-1c): `{ windowHours, minFires, threshold }`. **Default ON** — `<50%` fire success over `2h` with `≥6` fires alerts once per degradation episode (with the errorClass tallies) and the first healthy window sends one recovery line, whenever a send target + the team fires ledger exist. `windowHours: 0` opts out. |

The passive-intake doc-edit notifier keys off the project's effective `intake.mode`
(`"passive"` only) and the drafts-pending notifier runs whenever a send target exists —
neither has a `settings_json` field. The doc-edit notifier has a sibling **strategy-FILE
watch** (same `"passive"`-only gate, also no `settings_json` field): it additionally
requires the project's `strategyDoc` to be the **repo-file form** — a plain string or
`{ "path": … }` (NOT `{hubDoc}`/`{linearDocument}`, not a `linear.app/…/document/` URL,
and not when `hub.docs:true`) — resolved ONCE at boot via the doc-home rule (the repo
with `role:"docs"`, else `"primary"`, else `repos[0]`; an explicit `"<repo-name>:path"`
overrides; conventions §19). It watches the file's **content hash** with a 15-minute
settle window (an editing burst collapses to one line), seeds a SILENT baseline on first
observation (a boot never announces pre-existing content), dedupes by hash in the hub
events ledger, and its one line names the configured path ONLY — never file content
(§16).

**Migration note:** the daemon resolves these values — including the comms presence that
drives the 24h default, `intake.mode` for the doc-edit notifier, and the `strategyDoc`
form/path for the strategy-file watch — once at **boot**. An
already-running daemon does not pick up the new 24h default, nor any later change to
`settings_json`, `team.comms`, `intake.mode`, or `strategyDoc`, until it restarts
(`dev-loop hub stop && dev-loop hub ensure`).

## Linear mirror (`mirror`, `backend:"service"` only)

The optional one-way hub→Linear projection (conventions §18). Sweep Job 5 drives it —
`mirror.push` then `mirror.pollComments`, both every Job 5 fire (see
`skills/sweep-agent/SKILL.md` for the cadence contract and
`docs/HUB-ARCHITECTURE.md` §15 for the mechanism). The D5 doc mirror + comment poller are
a **semantics extension of the existing keys — no new keys were added**:

| Field | Meaning |
|---|---|
| `mirror.teamId` | The Linear team id the mirrored issues are created in. |
| `mirror.tokenEnv` | The env-var **NAME** of the Linear token — never the secret value; the hub reads it server-side, and it is reused by BOTH `mirror.push` and `mirror.pollComments`. |
| `mirror.projectId` | Optional Linear project id — parents the mirrored issues AND, since D5, is REQUIRED for the doc mirror: without it the published `strategy`/`roadmap`/`decisions` + latest `design` docs are skipped wholesale with a visible `docs.note` (config guidance, never a push failure). |
| `mirror.stateMap` | Hub State → Linear workflow-state id map; a missing entry leaves the state in the mirrored body only (never a push failure). |
| `mirror.limit` | Cap on the tickets considered per push. |

The poller's dedup state is **machine-local**, not hub state:
`<dataDir>/mirror-state/<projectKey>.json` (the reports-state pattern), where `<dataDir>`
resolves from `DEVLOOP_DATA_DIR`, else `DEVLOOP_HOME`, else the discovered workspace's
`.dev-loop/`; with none of the three the command reports that it resolved no data dir.
Re-pointing the data dir therefore re-files intake at worst — it never corrupts hub state.

## Operator-tunable fields (`dev-loop team set`)

```bash
dev-loop team set <path> <value>     # e.g. dev-loop team set team.mode live
```

A validated single-field update: the value is type-checked (enum/boolean/number/string per field), the
edit is applied to a copy, and the WHOLE file is re-validated before writing — `team set` can never
leave `dev-loop.json` invalid. Only the whitelisted paths above (`team set` ✓ columns) are accepted:

- `team.mode` (`dry-run`|`live`) · `team.autonomy` (`ask`|`full`; `guarded` accepted, stored as `ask`) ·
  `team.linearTeam` · `team.git.defaultBranch` ·
  `team.comms.provider` (`slack`|`lark`) ·
  `team.comms.webhookEnv` · `team.intake.mode` (`autonomous`|`passive`) · `team.intake.todoDepthCap` ·
  `team.agentReviewers` (comma-separated logins; stored as string array) ·
  `team.budget.dailyUsd` (positive number USD or `null` to disable; rolling 24 h ceiling) ·
  `team.budget.perFireUsd` (positive number USD; per-fire estimated spend ceiling — ON by default at `$12.00`) ·
  `team.approvals.enforce` (comma-separated action classes the approvals record gates; **empty = enforce nothing**; unknown class refused at the gate) ·
  `team.bootCorpus` (boolean; **default true** — `false` opts a team out of the pre-assembled §0a boot corpus) ·
  `team.codex.sandbox` (`safe`\|`bypass`; **default safe** — `bypass` restores the unattended codex lane's bypass flag; unset with a codex lane routed ⇒ doctor `W45`) ·
  `team.agents.<a>.codexSandbox` (`safe`\|`bypass`; this handle's posture, beats `team.codex.sandbox`)
- `projects.<key>.enabled` · `.weight` · `.devSplit` · `.mode` (`dry-run`|`live`) ·
  `.autonomy` (`ask`|`full`; `guarded` accepted, stored as `ask`) ·
  `.testEnv.baseUrl` · `.testEnv.authConstraint` · `.intake.mode` · `.intake.todoDepthCap`
- `projects.<key>.communication.{cadence,language,audience,tone,outputDir,repoOutputDir}` (strings) ·
  `.communication.{maxWords,sourceWindowDays}` (integers) · `.communication.output` (`data`|`repo`) ·
  `.communication.includeUnreleased` (boolean)
- `projects.<key>.notify.type` (`slack`|`lark`; first touch bootstraps the block with the standard
  `DEVLOOP_COMMS_WEBHOOK` env name) · `.notify.webhookEnv` · `.notify.secretEnv`
- `repos.<ref>.ciIrrelevantPaths` (comma-separated paths; stored as string array) — **dot-free refs
  only.** The whitelist entry is `^repos\.[^.]+\.ciIrrelevantPaths$` and `team set` splits the path on
  dots, while a repo ref may itself contain one (`KEY_RE` permits `web.app`), so
  `repos.web.app.ciIrrelevantPaths` names a knob the validator accepts and the mutator cannot address.
  For such a ref, edit `dev-loop.json` directly and re-run `dev-loop doctor`; `merge-guard`'s stale
  reason detects the case and prints the description instead of a command to copy.
- `repos.<ref>.deploy.style` · `.deploy.healthCheck` ·
  `.deploy.environments.<env>.{auto,deployPrPrefix,command,healthCheck}`

Non-whitelisted paths are rejected with a pointer here: structural changes go through
`team add-project` / `team add-repo`, and interview fields are edited directly in `dev-loop.json`
(validated by `dev-loop doctor`). Setting `team.linearTeam` on a linear backend also re-runs the
workspace-fingerprint mismatch check against every mapped Linear project.

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
| `E10` | Duplicate repo paths or duplicate `linearProjectId`. |
| `E11` | Reserved/invalid project key or repo ref. `_team` is the hub-only intake row (seeded by `team init` into hub.db) and is rejected as a config project. |
| `E12` | Bad `intake` block: `mode` not `"autonomous"`/`"passive"`, or `todoDepthCap` not a positive integer. |
| `E13` | Bad `hub` block: `agentInterface` key not a known coding agent (`claude`/`codex`/`opencode` — typos would silently not apply), or a value other than `"cli"`/`"mcp"`. |
| `E14` | Bad `projects.<key>.communication` block: an unknown key (strict — a typo would silently change what a communication fire does), a wrong type, or `output` not `"data"`/`"repo"`. |
| `E15` | Bad `projects.<key>.notify` block: an unknown key, missing/bad `type` or `webhookEnv`, an env name that looks like a URL, or an **inline `webhook`/`secret` literal** (§16 — export the value in an env var and store its NAME). |
| `E16` | Bad `team.providers` entry (an unknown key, `kind` other than `"openai-compatible"`, a non-URL `baseUrl`, an `authTokenEnv` that is not an env-var NAME, an empty `models` list) or a non-object `team.opencodePermission`. Strict — a typo'd entry renders a dead opencode provider block. |
| `E17` | Bad `team.agents.<h>` / `projects.<key>.agents.<h>` block: a malformed `fireTimeout` / `stallTimeout` / `cadence` duration, a project-scope `cadence` (team mode ignores it), or a `codexSandbox` outside `safe`\|`bypass`. |
| `E18` | Bad team-level knob: a non-boolean `bootCorpus`, a bad `budget` / `backup` / `approvals.enforce` shape, a `codex.sandbox` outside `safe`\|`bypass` (or an unknown `codex` key), a bad `claude.allowedTools` (must be a non-empty string array) / `claude.permissionMode` (outside claude's enum), or a `pricing` table with an unknown lane, key, or a negative price. Strict — each of these changes what a fire is ALLOWED to do or what it is reported to cost. |
| `E19` | Bad `mode` or `autonomy` token, at `team` or `projects.<key>` scope — the message names the exact path. `mode` ∈ `dry-run`\|`live` (§12); `autonomy` ∈ `ask`\|`full` (§12a), plus the legacy input alias `guarded` which resolves to `ask`. Before 1.15.1 a typo here was accepted in silence and reached agent-facing prose as a posture no section defines. |

Common warnings:

| Code | Meaning |
|---|---|
| `E09` | Linear backend with a blank `linearTeam`. Since 1.2 this is a load-time **warning**, not an error — `team init --backend linear --yes` writes it blank on purpose, and the workspace must stay loadable so `dev-loop team set team.linearTeam "<Name>"` can repair it. The hard failure moved to launch time: `dev-loop run` (and anything projecting the runtime config) refuses with `[E09]` until it is filled. |
| `W01` | Project has no repos. |
| `W02` | Repo is referenced by nobody. |
| `W03` | Lessons INDEX/shard is over budget. |
| `W04` | Project sync is stale. |
| `W05` | Linear steward fires need the Linear MCP in user scope. |
| `W06` | Workspace root is inside a git worktree and `.dev-loop/` is not ignored. |
| `W07` | Deployed repo has no health probe for Ops. |
| `W08` | Service workspace: a config project has no hub.db row — its fires get no board access (the scheduler skips it at pick time); run the printed `dev-loop seed` command. |
| `W09` | Service workspace with `interface:"cli"` agents: `dev-loop` is not runnable on PATH — those fires have no board access. Install it: `npm i -g @dyzsasd/dev-loop`. |
| `W10` | The PATH-installed `dev-loop` predates the CLI write layer (needs >= 1.2.0) — `interface:"cli"` fires cannot write the board. Upgrade the global install. |
| `W11` | Identity smoke failed: `dev-loop project` exited non-zero under a fire-shaped env (`DEVLOOP_ACTOR`/`DEVLOOP_PROJECT`/`DEVLOOP_HUB_DB`) — the CLI fails closed, so every `interface:"cli"` fire would boot with no board access. |
| `W12` | `team.comms.webhookEnv` resolves to nothing in the process env **and** `.dev-loop/secrets.env` — every notification (`notify`, the daemon Human-Blocked reminder, the §22a digest) silently no-ops. Put the value in `<workspace>/.dev-loop/secrets.env` or export it. |
| `W13` | A `team.providers` entry's `authTokenEnv` resolves to nothing in the process env **and** `.dev-loop/secrets.env` — every opencode fire on that provider fails pre-spawn (`fireError: provider-env-missing`, zero tokens). Put the key in `secrets.env` or export it. |
| `W14` | The workspace `opencode.json` is missing/stale relative to `team.providers` — run `dev-loop team sync-opencode` (create-or-merge; hand-written providers survive). |
| `W15` | The config targets opencode but the binary is missing from PATH or predates the certified `1.2.24` — `--variant` / the injected `OPENCODE_PERMISSION` are unverified there (an older binary may silently ignore the policy). Install/upgrade opencode (PORTABILITY §5). |
| `W16` | Owner-liveness (P1-4): an owner label with open Todo/In Review tickets whose actor has NO fire in 7d — the tickets are stranded (nobody will ever verify/work them). Re-owner them, or declare the role human-run: `agents.<h>.manual:true` (the finding then downgrades to an "awaiting a human" info line). |

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
| `secrets.env` | Optional `KEY=VALUE` file supplying the values for the env-var NAMES in `dev-loop.json` (e.g. `team.comms.webhookEnv`). Loaded into the process env at workspace resolution; a key already in the real env is never overwritten. Keep it `chmod 600`; never committed (it lives in the gitignored `.dev-loop/`). |

Nothing else lives outside the workspace. The one exception is the rebuildable workspace index
(`${XDG_CONFIG_HOME:-~/.config}/dev-loop/workspaces.json`), which is what maps `DEVLOOP_TEAM=<key>`
to a workspace root and so cannot live inside one.

## Commands

| Command | Meaning |
|---|---|
| `dev-loop install-claude-plugin` | Register the npm-backed Claude Code plugin marketplace and print the two interactive `/plugin` commands. |
| `dev-loop team init` | Create a workspace. Pure CLI: no LLM and no backend calls. Mints the `workspaceId` fingerprint. |
| `dev-loop team set <path> <value>` | Validated single-field update over the whitelisted operator-tunable paths (see above). |
| `dev-loop team add-project <key>` | Validated project write. On `backend:"service"` it also auto-seeds the hub.db row (find-or-create; `--name`/`--prefix` override the derived hub name/ticket prefix). On `backend:"linear"` with `--linear-project-id` it stamps the workspace fingerprint. |
| `dev-loop team add-repo <ref>` | Validated repo write. `--detect` clones if needed and fills build/CI facts deterministically. |
| `dev-loop team repair` | Repair worktrees/index/WAL after a move. |
| `dev-loop doctor` | Read-only workspace verdict. Ends with a `NEXT:` line — the single most-blocking next step (fix config → fill `linearTeam` → add-project → seed → add-repo → flip `team.mode` → `dev-loop run`). |
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
| `E09` warning / `dev-loop run` refuses with `[E09]` | `team.linearTeam` is blank (e.g. `team init --backend linear --yes`). | Run `dev-loop team set team.linearTeam "<Team Name>"`, then rerun `dev-loop doctor`. |
| `W05` | Linear steward fires need the Linear MCP in user scope. | Configure Linear MCP in Claude Code user scope, then rerun `dev-loop doctor`. |
| `W06` | `.dev-loop/` may be committed by accident. | Add `.dev-loop/` to the workspace repo's ignore rules. |
| `W09`/`W10`/`W11` | The CLI-interface preflight failed — `interface:"cli"` fires depend on a current, identity-resolving `dev-loop` on PATH. | `npm i -g @dyzsasd/dev-loop@latest`, then rerun `dev-loop doctor`; a persistent `W11` means the fire env cannot resolve project/actor (check the printed stderr). |
| Service hub has no URL | Daemon is stopped or cwd/workspace resolution failed. | Run `dev-loop hub ensure && dev-loop hub status` from the workspace root. |

## Security Notes

- Secrets never live in `dev-loop.json`; store env var names only.
- `team.comms.webhookEnv` must be an env var name, not a URL.
- Inline webhook/secret literals are rejected from workspace config.
- Copying the workspace folder should never copy credentials.
