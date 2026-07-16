# Running dev-loop on Another CLI

The 1.x workspace model is CLI-portable by design. A workspace owns the config
(`<workspace>/dev-loop.json`) and state (`<workspace>/.dev-loop/`). Claude Code and Codex are the
documented/certified execution surfaces today; opencode follows the same contract but should be
identity-gated on the installed version before unattended use.

For unattended operation, prefer the built-in scheduler:

```bash
cd <workspace>
dev-loop run --cli claude --agents core
dev-loop run --cli codex --agents core,outward
```

The scheduler reads `dev-loop.json`, chooses the next project, resolves each agent's model/effort,
injects the right MCP configuration, and starts one agent fire at a time. Manual wrappers are mostly
for debugging or certification of a new CLI.

## 1. The Portable Contract

Every agent fire needs three pieces of identity:

| Value | Meaning |
|---|---|
| workspace | where `dev-loop.json` and `.dev-loop/` live |
| actor | which agent is firing: `pm`, `qa`, `senior-dev`, `junior-dev`, `sweep`, `reflect`, `ops`, `architect`, or `communication` |
| project | which project the delivery agent is acting on; steward agents may operate at team scope |

`dev-loop run` supplies these automatically. If you build your own launcher, set:

| Var | Meaning |
|---|---|
| `DEVLOOP_WORKSPACE` | absolute path to the workspace |
| `DEVLOOP_ACTOR` | per-agent actor identity |
| `DEVLOOP_PROJECT` | project key for a delivery fire; optional only when cwd can resolve the project |
| `DEVLOOP_HUB_DB` | service backend SQLite file, usually `<workspace>/.dev-loop/hub.db` |
| `DEVLOOP_PLUGIN_ROOT` | bundled or checkout root used for skills/references |

The older `DEVLOOP_PROJECTS_JSON`, `DEVLOOP_DATA_DIR`, and `CLAUDE_PLUGIN_*` variables exist only for
compatibility paths. New 1.x launchers should use the workspace contract above.

Config stores environment variable names only; the values come from `<workspace>/.dev-loop/secrets.env`
(loaded automatically at workspace resolution) or the launching environment — a variable already set in
the real environment always wins over the file. `dev-loop.json` itself never holds a secret.

## 2. MCP Registration

Install the runtime once:

```bash
npm i -g @dyzsasd/dev-loop
```

For `backend:"service"`, how a fire reaches the hub depends on the configured agent interface
(`hub.agentInterface`, D8): coding agents on `"cli"` (the default for Claude Code and — since the
2026-07-11 P8 certification below — Codex) get **no** MCP injection — they call the PATH-installed
`dev-loop` write verbs, with identity exported in the fire env — while agents on `"mcp"` (the
default for opencode; the rollback setting for claude/codex) reach the hub over MCP: `dev-loop run`
injects the configuration inline per fire for claude/codex, while opencode registers it through the
operator's merged config (its template below), the scheduler passing only the identity env. Manual
MCP setup is needed when you bypass the scheduler for an `"mcp"`-interface claude/codex fire, or
once up front for opencode.

Templates:

| CLI | Template |
|---|---|
| Claude Code | [`config/mcp.example.json`](../config/mcp.example.json) |
| Codex | [`config/mcp.codex.toml.example`](../config/mcp.codex.toml.example) |
| opencode | [`config/mcp.opencode.json.example`](../config/mcp.opencode.json.example) |

For `backend:"linear"`, the scheduler does not inject Linear for you. Configure the Linear MCP in
your normal user-level CLI config; `dev-loop doctor` reports `W05` when steward fires cannot reach it.

## 3. Identity Gate

Per-agent identity is attribution, not anti-spoof security. It is still important: if a CLI drops the
actor, writes can be stamped as the wrong agent or refused.

Run the launcher-side check first:

```bash
DEVLOOP_WORKSPACE=<workspace> DEVLOOP_ACTOR=qa DEVLOOP_PROJECT=<project> \
  dev-loop identity-check --expect qa/<project>
```

Then prove the identity crosses the CLI boundary. The probe depends on the agent interface — a
`"cli"`-interface fire uses the CLI's spawned shell, an `"mcp"`-interface fire uses the MCP
subprocess, and a CLI may propagate env into one but not the other (Codex does exactly that):

```bash
# interface "cli": have the CLI run the same probe in its own shell (the P8 ceremony;
# see the Codex certification below)
DEVLOOP_ACTOR=qa DEVLOOP_PROJECT=<project> DEVLOOP_HUB_DB=<db> <cli-headless-run> \
  "run dev-loop identity-check --expect qa/<project> and print its output"

# interface "mcp": call the injected hub MCP server through the CLI
DEVLOOP_ACTOR=qa <cli-headless-run> \
  "call the dev-loop-hub whoami tool and print only its actor and project"
```

Pass criteria:

| Result | Meaning |
|---|---|
| actor/project match expectation | safe to onboard that CLI path |
| actor falls back to `operator`, project is wrong, or the tool cannot run | do not run unattended until the launcher passes identity through |

`identity-check` in your own shell proves the launcher environment is coherent. The
through-the-CLI probe proves the CLI passed the same identity into the surface the fire actually
uses — its spawned shell (`"cli"`) or the MCP subprocess (`"mcp"`).

## 4. Codex

Codex is supported through `dev-loop run --cli codex`. On `backend:"service"` its fires default to
the `"cli"` interface (certified below): the scheduler injects no MCP and exports the identity env
per fire, and the agent reaches the board through the PATH-installed `dev-loop` write verbs.

### Codex CLI interface — CERTIFIED (2026-07-11, P8)

Run end-to-end against a scratch service workspace on `codex-cli 0.130.0`. **Result: certified —
`hub.agentInterface.codex` defaults to `"cli"`.**

| Check | Result |
|---|---|
| Launcher-side gate: `dev-loop identity-check --expect pm/certproj` under the exact fire env | ✅ exit 0, `pass:true` |
| Fire-shaped `codex exec` (the scheduler's own rendered shape: `--model gpt-5.5 -c 'model_reasoning_effort="xhigh"' --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`, cwd = the project repo, env = the `runAgent` identity block), prompt = run the same `identity-check` | ✅ the probe ran inside Codex's spawned shell and printed `{"actor":"pm","project":"certproj",…,"matchesExpectation":true,"pass":true}`, exit 0 |

**What was proven:** `codex exec` propagates the launching process env (`DEVLOOP_ACTOR` /
`DEVLOOP_PROJECT` / `DEVLOOP_HUB_DB` / `DEVLOOP_DEV_SPLIT`) into the shell commands the agent runs
(`/bin/zsh -lc …`) — the identity transport every interface=`"cli"` fire depends on. This is
distinct from (and does not overturn) the 2026-06-25 finding that Codex does **not** forward the
process env into MCP *subprocesses*: when Codex is rolled back to `"mcp"`
(`hub.agentInterface.codex: "mcp"`), identity must still ride `-c` config overrides, which the
scheduler applies automatically.

Manual certified shape for an `"mcp"`-interface (rollback) run:

```bash
codex exec \
  -c 'mcp_servers.dev-loop-hub.env.DEVLOOP_ACTOR="qa"' \
  -c 'mcp_servers.dev-loop-hub.env.DEVLOOP_WORKSPACE="/abs/workspace"' \
  -c 'mcp_servers.dev-loop-hub.env.DEVLOOP_PROJECT="devplatform"' \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check "$PROMPT"
```

Use manual `codex exec` only for attended tests or one-off debugging. For the loop, use:

```bash
dev-loop run --cli codex --agents core,communication
```

Unattended Codex runs need the default unsafe executor mode so shell/MCP tool calls are not cancelled
for approval. Use `--codex-safe` only for attended runs where you want to approve each tool call.

## 5. opencode

opencode follows the same contract, but its exact MCP schema and environment propagation should be
verified on the installed version before unattended use:

```bash
dev-loop run --cli opencode --agents qa --once --dry-run
```

Then run the identity gate above. If opencode does not pass per-pane environment variables into MCP,
use its config override mechanism, mirroring the Codex pattern.

## 6. What Stays the Same

- **Board semantics.** Ticket states, labels, owner responsibilities, and verify gates are identical
  across CLIs.
- **Self-evolution boundary.** Agents may curate `lessons.md`; structural changes to skills,
  conventions, or code remain operator git commits.
- **Secrets.** Tokens stay in environment variables, never in `dev-loop.json`.
- **Service hub trust model.** Single-host cooperative identity remains the model. The localhost web
  daemon is optional and remains bound to `127.0.0.1`.
- **Scheduler cursor.** `dev-loop run` and Agent View share the same rotation picker, so they do not
  intentionally double-fire a project slot.

## 7. Open Checks for a New CLI

Before leaving a new CLI unattended:

1. `dev-loop run --once --dry-run` prints the expected command.
2. `identity-check` passes with the expected actor/project.
3. The through-the-CLI identity probe for the fire's interface (§3: `identity-check` inside the
   CLI's shell on `"cli"`, `whoami` over MCP on `"mcp"`) returns the same actor/project.
4. A read-only board call succeeds.
5. A dry-run agent fire exits cleanly.

Only then add the CLI to the normal scheduler cadence.
