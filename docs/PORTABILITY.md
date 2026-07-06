# Running dev-loop on Another CLI

The 1.0 workspace model is CLI-portable by design. A workspace owns the config
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
compatibility paths. New 1.0 launchers should use the workspace contract above.

Secrets stay outside the workspace. Config stores environment variable names only; the launching
environment provides the values.

## 2. MCP Registration

Install the runtime once:

```bash
npm i -g @dyzsasd/dev-loop
```

For `backend:"service"`, `dev-loop run` injects the hub MCP configuration per fire. Manual setup is
needed only when you bypass the scheduler.

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

Then run a real CLI-to-MCP check:

```bash
DEVLOOP_ACTOR=qa <cli-headless-run> \
  "call the dev-loop-hub whoami tool and print only its actor and project"
```

Pass criteria:

| Result | Meaning |
|---|---|
| actor/project match expectation | safe to onboard that CLI path |
| actor falls back to `operator`, project is wrong, or the tool cannot run | do not run unattended until the launcher passes identity through |

`identity-check` proves your shell environment is coherent. `whoami` proves the CLI passed the same
identity into the MCP subprocess.

## 4. Codex

Codex is supported through `dev-loop run --cli codex`. The scheduler injects the actor, project, and
hub DB with Codex `-c` overrides because Codex does not reliably inherit per-pane environment
variables into MCP subprocesses.

Manual certified shape:

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

Unattended Codex runs need the default unsafe executor mode so MCP tool calls are not cancelled for
approval. Use `--codex-safe` only for attended runs where you want to approve each tool call.

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
3. A real `whoami` MCP call through the CLI returns the same actor/project.
4. A read-only board call succeeds.
5. A dry-run agent fire exits cleanly.

Only then add the CLI to the normal scheduler cadence.
