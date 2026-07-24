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
| `mode` | Default `"live"` / `"dry-run"` for projects that do not override. | ✓ `team.mode` |
| `autonomy` | Default autonomy posture for projects that do not override. | — |
| `intake` | Team-wide default intake block (`mode`, `todoDepthCap`); seeded by `team init --intake-mode`. Projects override **field-wise** (nearest wins per field), so a project tuning only `todoDepthCap` keeps a team-level `"passive"`. | ✓ `team.intake.mode`, `team.intake.todoDepthCap` |
| `defaultCodingAgent` | Default executor CLI (`claude`, `codex`, or `opencode`) when an agent does not override. | — |
| `codingAgentDefaults` | Default `{ model, effort }` per executor CLI. | — |
| `providers` | Registry of **custom OpenAI-compatible model endpoints** for the opencode lane (E16; `docs/design/model-provider-routing.md`). Entry: `{ kind:"openai-compatible", baseUrl, authTokenEnv, models[], extraOptions?, effortMode? }` — the id doubles as the opencode provider key and the `agents{}.model` prefix (`<id>/<model-id>`). Rendered into `<workspace>/opencode.json` by `dev-loop team sync-opencode` with `{env:VAR}` auth indirection (§16 — value in `secrets.env`). Built-in opencode providers (openrouter, zhipuai, …) need **no** entry: auth + the model string suffice (`opencode models` lists the launchable ids). | — |
| `opencodePermission` | Whole-object override of the per-fire `OPENCODE_PERMISSION` injection (E16). Default is the certified wildcard-deny policy (PORTABILITY §5) — deny-by-default closes operator-installed custom exec tools; replace only with another deny-based shape. | — |
| `hub.agentInterface` | `backend:"service"` only: per coding agent, how a fire reaches the hub board — `"cli"` (the PATH-installed `dev-loop` write verbs; identity rides the fire env) or `"mcp"` (the scheduler-injected `dev-loop-hub` MCP server). Defaults: `claude`/`codex` → `"cli"` (codex since its 2026-07-11 P8 env-propagation certification, docs/PORTABILITY.md §4), `opencode` → `"mcp"`. This is also the rollback switch: set `"claude": "mcp"` / `"codex": "mcp"` to restore the injected-MCP behavior. Projects override per coding agent. | — |
| `agents` | Team-scope agent launch config, mainly cadence for Sweep/Ops/Reflect/Communication. `agents.<h>.manual:true` (P1-4) declares a role the operator runs BY HAND — owner-liveness (doctor `W16`, the Sweep digest) reports its stranded tickets as "awaiting a human" instead of warning. | — |

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
| `build` | Step-5 ship gates, run in order: `typecheck` → `build` → `test` → `quality`. `quality` is the optional CRAP/mutation gate (quality-gauntlet design): e.g. `"quality": "dev-loop quality --changed --threshold 30"` — per-function `CRAP = CC² × (1−cov)³ + CC` over native V8 coverage, exit 2 over threshold; `--mutate` adds the test-strength probe (self-restoring operator flips; a SURVIVED mutant = a test that doesn't bite). `add-repo --detect` maps package.json scripts named `typecheck`/`build`/`test`/`quality`. | — |
| `deploy` | Command or release-PR deploy shape. | ✓ `repos.<ref>.deploy.style`, `.deploy.healthCheck`, `.deploy.environments.<env>.{auto,deployPrPrefix,command,healthCheck}` |
| `ops` | Health checks, critical routes, and read-only logs command for Ops. | — |

`dev-loop team add-repo <ref> --project <key> --path <rel> --detect` fills the detectable fields
deterministically (no LLM): it clones from `--remote` when the path is missing, maps `package.json`
scripts named `typecheck`/`build` to runner commands (runner chosen by lockfile: pnpm/yarn/npm), and
lists `.github/workflows` job names as candidate `mergeChecks`. It registers with `landing:"pr"` and
no auto-merge; interview-only fields (`deploy`, `ops`, `owner`) stay unset and `dev-loop doctor`
surfaces the gap. Explicit flags always beat detection.

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
| `mode` / `autonomy` | Project overrides for team defaults. | — |
| `hub.agentInterface` | Project override of `team.hub.agentInterface`, merged **per coding agent** (a project flipping only `claude` keeps the team-level `codex` setting). | — |
| `agents` | Per-agent coding CLI, model, effort, and cadence overrides. | — |
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
resolves from `DEVLOOP_DATA_DIR`, else `DEVLOOP_HOME`, else `~/.dev-loop`. Re-pointing the
data dir therefore re-files intake at worst — it never corrupts hub state.

## Operator-tunable fields (`dev-loop team set`)

```bash
dev-loop team set <path> <value>     # e.g. dev-loop team set team.mode live
```

A validated single-field update: the value is type-checked (enum/boolean/number/string per field), the
edit is applied to a copy, and the WHOLE file is re-validated before writing — `team set` can never
leave `dev-loop.json` invalid. Only the whitelisted paths above (`team set` ✓ columns) are accepted:

- `team.mode` (`dry-run`|`live`) · `team.linearTeam` · `team.comms.provider` (`slack`|`lark`) ·
  `team.comms.webhookEnv` · `team.intake.mode` (`autonomous`|`passive`) · `team.intake.todoDepthCap`
- `projects.<key>.enabled` · `.weight` · `.devSplit` · `.testEnv.baseUrl` · `.testEnv.authConstraint` ·
  `.intake.mode` · `.intake.todoDepthCap`
- `projects.<key>.communication.{cadence,language,audience,tone,outputDir,repoOutputDir}` (strings) ·
  `.communication.{maxWords,sourceWindowDays}` (integers) · `.communication.output` (`data`|`repo`) ·
  `.communication.includeUnreleased` (boolean)
- `projects.<key>.notify.type` (`slack`|`lark`; first touch bootstraps the block with the standard
  `DEVLOOP_COMMS_WEBHOOK` env name) · `.notify.webhookEnv` · `.notify.secretEnv`
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

`~/.dev-loop/` keeps only the rebuildable workspace index.

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
