# Running dev-loop

This is the operational guide for the **1.x workspace model**. A workspace is the starting
point: one directory, one team, one backend, and one `dev-loop.json`.

## 1. Create a Workspace

A workspace is one directory, one team, one backend, and one `dev-loop.json`. Repos are real
git clones inside the workspace; projects are virtual delivery units that reference those repos.

The fastest path is the guided wizard:

```bash
npm i -g @dyzsasd/dev-loop        # Node >= 23.6
dev-loop init                     # interactive on a TTY; --yes accepts every default (service backend)
```

`dev-loop init` composes everything below — `team init`, the first `add-project`, an offered
first `add-repo --detect`, the Claude permissions entry — and finishes with the doctor verdict
plus its `NEXT:` line. Re-running it on an existing workspace *resumes* (prints `NEXT:`) instead
of re-initializing. The rest of this section is the piece-by-piece manual path.

```bash
dev-loop team init --dir ~/work/my-team --key my-team \
  --backend linear --linear-team "My Team" \
  --deploy dev=auto,prod=manual --comms lark

cd ~/work/my-team
```

Use `--backend service` when you want the bundled local hub instead of Linear. For a Linear
team, configure the Linear MCP in Claude Code user scope; `dev-loop doctor` warns with `W05`
when steward agents cannot reach the board.

`team init --backend linear --yes` may leave `team.linearTeam` blank. The workspace still loads
(doctor reports it as the `E09` warning) so you can finish onboarding, but fires refuse to launch
until you fill it:

```bash
dev-loop team set team.linearTeam "My Team"
```

`team init` also mints a stable `workspaceId` fingerprint. On Linear backends, `add-project` and
`/dev-loop:sync-project` stamp it into the Linear project description; if another workspace already
stamped a project, dev-loop warns loudly instead of double-driving the same board.

**Where secrets go.** `dev-loop.json` stores env-var *names* only (`team.comms.webhookEnv`,
`notify.secretEnv`, …) — it is agent-ingested and shareable, so it must never hold a value. Put
the values in `<workspace>/.dev-loop/secrets.env` (plain `KEY=VALUE` lines, `#` comments; keep it
`chmod 600`):

```bash
echo 'DEVLOOP_COMMS_WEBHOOK=https://open.feishu.cn/…' > .dev-loop/secrets.env
chmod 600 .dev-loop/secrets.env
```

Every entry point (the CLI, the daemon, `dev-loop run`, and the agent fires they spawn) loads it
automatically when the workspace is resolved; a variable already exported in your shell wins over
the file. This keeps the workspace self-contained — copy the folder and notifications keep
working, no `~/.zshenv` exports needed. `dev-loop doctor` warns (`W12`) when a configured comms
webhook resolves to neither source.

## 2. Add Projects and Repos

`team init` creates only the workspace. It does not call an LLM and it does not touch Linear
(on a `service` backend it initializes `hub.db` and seeds the `_team` intake row). Project/repo
onboarding has two paths: the validated **CLI mutators** (`team add-project` / `team add-repo
--detect` — what `dev-loop init` composes; self-sufficient on `service`, no plugin needed), and
the **LLM-assisted skills** below, which can inspect code, create backend objects, and interview
you about build/deploy details. The plugin/MCP setup is only *required* for the `linear` backend.

For the LLM-assisted path, first make the dev-loop skills available in the coding CLI you will
use for onboarding. In Claude Code, install the npm-backed plugin marketplace once:

```bash
dev-loop install-claude-plugin
```

The command prints two interactive `/plugin ...` commands. Run those inside Claude Code, then
restart or refresh the session so `/dev-loop:*` commands are visible. Codex can run scheduled
agent fires through `dev-loop run --cli codex`; for operator-present onboarding, use an environment
where the same dev-loop skills are available, or call the validated `dev-loop team add-project` /
`dev-loop team add-repo` mutators directly after doing the backend sync yourself.

In the coding CLI:

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
config writes; the slash skills are the friendly coding-CLI wrappers around them. The CLI path is
self-sufficient for the common cases:

- On `backend:"service"`, `team add-project <key>` **auto-seeds** the hub.db row (find-or-create,
  with a derived unique ticket prefix; override via `--name` / `--prefix`), so fires get board
  access without a separate `dev-loop seed` step.
- `team add-repo <ref> --project <key> --path <rel> --detect` detects repo facts deterministically
  (no LLM): clones from `--remote` if the path is missing, maps `package.json` `typecheck`/`build`
  scripts to runner commands, and lists CI workflow job names as candidate merge checks. It
  registers with `landing:"pr"` and no auto-merge; interview-only fields (deploy, ops probes) stay
  unset and `dev-loop doctor` keeps the gap visible.
- `dev-loop team set <path> <value>` updates a single operator-tunable field with full re-validation
  (e.g. `team.mode`, `team.linearTeam`, `projects.<key>.weight`,
  `repos.<ref>.deploy.environments.<env>.auto`). See the whitelist in
  [`references/config-schema.md`](../references/config-schema.md).

## 3. Verify Before Running

Run these from the workspace root:

```bash
dev-loop doctor
dev-loop run --once --dry-run
```

`doctor` is read-only. It validates schema, repo paths, deploy-policy ceilings, health probes,
Linear MCP reachability for steward fires, workspace layout, and — on a service workspace with
`interface:"cli"` agents (the Claude default) — the CLI preflight: `dev-loop` resolvable on PATH
(`W09`), at a write-verbs version (`W10`), and an identity smoke under a fire-shaped env (`W11`).
Its final line is `NEXT:` — the
single most-blocking step in fix order: invalid config → the E-code fix; blank `linearTeam` → the
`team set` fill; no projects → `add-project`; an unseeded service project → the exact `dev-loop
seed` command; no repos → `add-repo`; an unresolvable comms webhook → the `secrets.env` line to
add (`W12`); everything wired but `team.mode:"dry-run"` → the
`dev-loop team set team.mode live` flip; all green → `dev-loop run`. `--dry-run` prints the exact
command that would launch each agent, including its selected coding CLI, model, effort, project,
and cadence.

## 4. Run the Team

The scheduler is the normal 1.x launch path:

```bash
dev-loop run
```

`team init` defaults to `mode: "dry-run"` for first contact; flip it once doctor's `NEXT:` line
says everything else is green:

```bash
dev-loop team set team.mode live
```

One scheduler drives the whole team. Delivery agents rotate across enabled, positively-weighted
projects with weighted round-robin. Stewardship agents run at team scope over every enabled project
regardless of weight: `weight: 0` pauses a project's delivery rotation only (maintenance mode) while
stewards keep covering it, and `enabled: false` removes it from both. `--project` narrows the delivery
rotation only — steward fires always keep team-wide coverage. On a service backend, a configured
project that was never seeded into hub.db is skipped at pick time (warned once, with the exact
`dev-loop seed` command; siblings keep rotating) — `dev-loop doctor` reports the same drift as `W08`.
Press `Ctrl-C` to stop the scheduler and any active agent subprocess.

Useful variants:

```bash
dev-loop run --agents core,ops
dev-loop run --project devplatform --agents pm,qa
dev-loop run --plan 8 --agents pm
dev-loop run --interval pm=2m --max-fires 50
dev-loop run --change-gate --fire-timeout 45m
dev-loop run --stagger 30s
dev-loop run --once --dry-run
```

Agent groups:

| Group | Agents |
|---|---|
| `core` | `pm`, `qa`, `senior-dev`, `junior-dev`, `sweep` |
| `outward` | `ops`, `architect`, `communication` |
| `legacy` | the old single `dev` agent, only for projects that explicitly opt out of split Dev |

Long-running options:

| Option | Use |
|---|---|
| `--change-gate` | On `service`, skip spawning inward agents when neither the board nor repo HEAD changed since their last fire — the biggest saver on quiet teams. pm/qa are REVIEW tiers whose lens-rotation / coverage-expansion do their best work when nothing changed, so a quiet board only defers them: after `--change-gate-ttl` (default 4h; 0 = never) they fire once anyway and the gate re-arms; dev-tier + architect keep the pure gate. |
| `--change-gate-ttl <dur>` | How long a quiet board may defer a gated pm/qa fire before it runs anyway (then the gate re-arms). Default `4h`; `0` = never — the pure change gate for pm/qa too. |
| `--fire-timeout <dur>` | Kill a stuck fire; default is `1h`, and `0` disables the timeout. |
| `--stagger <dur>` | Delay initial slots so a cold start does not launch every agent at once. |
| `--max-fires <n>` | Stop after a fixed number of fires, useful for trial runs and budget caps. |
| `--codex-safe` | For attended Codex runs, omit unsafe bypass flags so tool calls can ask for approval. |

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
only and read-first; human write routes are opt-in. One daemon serves **every** hub project:
`GET /` is a project index and each project lives under `/p/<key>/` (board, ticket detail, the
versioned doc pages, reports, activity); bare paths keep serving the boot project.

`dev-loop hub start|stop|status|ensure` is the normal 1.x workspace lifecycle. The older
`dev-loop daemon ...`, `seed`, and `init-service` commands are still present for compatibility and
low-level debugging; do not start there for a new workspace. See [`DAEMON.md`](DAEMON.md) for the
HTTP surface and raw daemon lifecycle, and [`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md) for the
historical storage rationale.

## 8. Moving a Workspace

`dev-loop.json` stores environment variable names, not secret values. The values live in
`.dev-loop/secrets.env` — which travels **with** the folder (that is the point: notifications keep
working on the new machine with no shell setup). Be deliberate about it: the copy below carries your
webhook URLs, so keep the transfer channel private, or exclude the file
(`rsync --exclude .dev-loop/secrets.env`) and recreate it on the new machine.

```bash
dev-loop hub stop                 # service teams only; checkpoints the WAL
rsync -a ~/work/my-team/ newhost:~/work/my-team/

# On the new machine:
cd ~/work/my-team
dev-loop team repair
dev-loop doctor
dev-loop run
```

Also install your coding CLI, authenticate `gh`, configure Linear MCP if using Linear, and export any
environment variables referenced by `dev-loop.json` that you keep outside `secrets.env` (`doctor`
warns `W12` if the comms webhook resolves to neither).

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

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/dev-loop:add-project` is not available in Claude Code | The plugin marketplace is not installed or the session has not refreshed. | Run `dev-loop install-claude-plugin`, execute the printed `/plugin` commands in Claude Code, then restart/refresh Claude Code. |
| `doctor` reports `W05` on a Linear team | Steward agents run from the workspace root, where repo-level MCP config may not apply. | Configure the Linear MCP in Claude Code user scope. |
| A service workspace has no web UI URL | The workspace hub daemon is stopped or the cwd does not resolve to the workspace. | Run `dev-loop hub ensure` and then `dev-loop hub status` from the workspace. |
| A copied workspace opens the wrong state | Absolute worktree paths or the workspace index still point at the old machine. | Run `dev-loop team repair`, then `dev-loop doctor`. |
| A quiet loop still spends tokens | Agents are firing just to discover no work moved. | Use `dev-loop run --change-gate` on `backend:"service"` teams. pm/qa still fire once per `--change-gate-ttl` window by design — raise the TTL (or set 0) to quiet them completely. |
