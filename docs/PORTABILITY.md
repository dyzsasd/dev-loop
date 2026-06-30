# Running dev-loop on a second CLI (Codex / opencode) — P8

The whole reason the loop's system-of-record is a **local hub** (a plain **stdio MCP server** over
`node:sqlite`, identity via **env vars**, plus an optional localhost daemon for the web UI/autostart —
see [`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md))
is that it is **CLI-portable**. The same agents, the same hub, the same per-agent identity can run on
Claude Code **and** another coding CLI (Codex, opencode, …) against the *same* `hub.db`.

> **Status.** The hub + the identity contract + the identity-check helper are CLI-agnostic and shipped.
> **Claude Code** — validated (the default). **Codex — CERTIFIED 2026-06-25** (see §4a: the MCP transport
> + real data tools round-trip; per-pane identity works **via a `-c` override**, NOT via process-env
> propagation). **opencode** — enabled by the contract, not yet live-validated (config marked ⚠️ VERIFY;
> run the identity gate before onboarding). Claude Code is **100% unchanged** by any of this (additive).

---

## 1. The CLI-agnostic env contract (the one thing every launcher must do)

The hub and the SKILLs read everything they need from **environment variables**. A launcher for ANY
CLI sets these per agent pane — that is the entire portability contract:

| Var | Meaning | Who sets it |
|---|---|---|
| `DEVLOOP_ACTOR` | the per-agent identity (`pm`/`qa`/`dev`/`sweep`/`reflect`/`ops`/`architect`/`communication`) — the attribution win | the launcher, **per pane** |
| `DEVLOOP_PROJECT` | the project key (pins this hub process to one project) | the launcher — **optional (DL-13):** when unset/empty the hub auto-resolves the project from the spawned process's **cwd** (the repo it was launched in), so a launcher that spawns the MCP server with `cwd` inside a repo need not set it. **Portability caveat:** this works only if the CLI spawns the MCP subprocess with that cwd; some CLIs spawn from a fixed dir, so the launcher exporting `DEVLOOP_PROJECT` (via `dev-loop-hub resolve-project`) stays the robust primary mechanism |
| `DEVLOOP_HUB_DB` | absolute path to the shared `hub.db` | the launcher |
| `DEVLOOP_HOME` | dev-loop's unified home for machine-local state | optional; defaults to `~/.dev-loop` |
| `DEVLOOP_DATA_DIR` | dev-loop data dir for `projects.json`, reports, lessons, and runner logs | optional; defaults to `DEVLOOP_HOME` / `~/.dev-loop` |
| `DEVLOOP_PROJECTS_JSON` | explicit config file path; overrides `DEVLOOP_DATA_DIR/projects.json` | optional |
| `DEVLOOP_PLUGIN_ROOT` | bundled or checkout root used for skills/references | the launcher or scheduler |
| `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` | compatibility placeholders for older skill text and Claude plugin loading | `dev-loop run` sets them to the same root/data values; new config should not live under Claude data |

**Why this stays portable:** the SKILL bodies now resolve config through dev-loop's own paths
(`DEVLOOP_PROJECTS_JSON`, then `DEVLOOP_DATA_DIR` / `~/.dev-loop`). On Claude Code the plugin can still
provide the historical placeholders; on a second CLI, `dev-loop run` sets both the new `DEVLOOP_*`
variables and the compatibility `CLAUDE_PLUGIN_*` variables before feeding the SKILL body as a prompt.
The npm package ships the skills and shared references, so a source checkout is only needed for plugin
development or a hand-written wrapper.

Secrets are unchanged on every CLI: the channel (P6) / mirror (P7) tokens stay in env, referenced by
**name** only, read server-side (§16). Per-agent identity is **cooperative attribution** (any local
process can set its own env) — the same honest framing on every CLI, not stronger.

---

## 2. Register the hub MCP server

Install the runtime once, then pick the file for your CLI:

```bash
npm i -g @dyzsasd/dev-loop
```

The templates register `dev-loop serve` as a stdio MCP server. If PATH's `node` is too old for the
hub, set `DEVLOOP_NODE=/absolute/path/to/node`; the packaged CLI will re-exec through it. A source
checkout can still point at `node <dev-loop>/hub/src/server.ts`, but that is now the developer
fallback rather than the normal install path.

- **Claude Code** — [`config/mcp.example.json`](../config/mcp.example.json) → `.mcp.json` (the
  `${DEVLOOP_ACTOR:-…}` values are expanded per pane from the launching shell — this is the proven path).
- **Codex** — [`config/mcp.codex.toml.example`](../config/mcp.codex.toml.example) → merge into
  `~/.codex/config.toml` `[mcp_servers.dev-loop-hub]`. ⚠️ VERIFY the schema + env propagation.
- **opencode** — [`config/mcp.opencode.json.example`](../config/mcp.opencode.json.example) → merge
  the `mcp` entry into your opencode config. ⚠️ VERIFY the schema + env propagation.

**The per-pane catch.** Codex's `config.toml` and opencode's config are **global / shared across
panes**, so `DEVLOOP_ACTOR` (which differs per agent) **cannot** live there — it must ride the
**launching process env** each pane exports before starting the CLI, and the CLI must **propagate
that process env to the spawned MCP subprocess**. Claude Code's `.mcp.json` solves this with
per-pane `${VAR}` expansion; for the others it depends on env inheritance — **which is exactly what
the identity gate (§4) checks. (Certified result: Codex does NOT inherit the process env — supply identity
per-pane via the `-c` override instead; see §4a.)**

---

## 3. Run agents with the built-in scheduler

For unattended operation, prefer the built-in scheduler over a CLI's `/loop` feature:

```bash
# dev-loop owns cadence; Claude/Codex only executes one fire at a time.
cd /path/to/product-repo
dev-loop run --cli claude --agents core,communication
dev-loop run --cli codex  --agents core,outward

# One-shot preview, useful before leaving it unattended.
dev-loop run --cli codex --agents communication --once --dry-run
```

The scheduler expands each SKILL body from the bundled package assets (or `--root`), sets the
`DEVLOOP_*` env contract plus legacy `CLAUDE_PLUGIN_*` placeholders, and shells out once per due
agent fire.
For Codex it also injects the actor/project/db into the MCP config with `-c`, because
Codex does not inherit the process env into MCP subprocesses (§4a). Cadence stays in the
script: defaults match `RUNNING.md` §4 and can be overridden with
`--interval pm=2m` / `--interval communication=12h`. The project is inferred from cwd
by matching `repoPath` / `repos[].path` in `projects.json`; pass `--project <key>` or
`--cwd <repo>` when running from cron/systemd or another fixed directory. If no explicit
project is set and the cwd is outside every configured repo, the scheduler exits instead
of falling back to another project.

## 3a. Run one agent headless by hand

On a second CLI there is no `/pm-agent` slash command — you feed the **SKILL body** as the prompt. A
minimal per-pane wrapper:

```bash
# launch-agent.sh <agent> <project>   (one pane = one agent identity)
AGENT="$1"; PROJECT="$2"
export DEVLOOP_ACTOR="$AGENT" DEVLOOP_PROJECT="$PROJECT"
export DEVLOOP_HUB_DB="$HOME/.dev-loop/hub.db"
export DEVLOOP_DATA_DIR="$HOME/.dev-loop"
export DEVLOOP_PROJECTS_JSON="$DEVLOOP_DATA_DIR/projects.json"
export DEVLOOP_PLUGIN_ROOT="/ABS/PATH/dev-loop"
export CLAUDE_PLUGIN_ROOT="$DEVLOOP_PLUGIN_ROOT"  # compatibility with old placeholders
export CLAUDE_PLUGIN_DATA="$DEVLOOP_DATA_DIR"     # compatibility with old placeholders
# strip the frontmatter, substitute path placeholders, feed as the prompt:
PROMPT="$(sed '1{/^---$/!q};1,/^---$/d' "$DEVLOOP_PLUGIN_ROOT/skills/$AGENT-agent/SKILL.md" \
  | sed "s|\${CLAUDE_PLUGIN_ROOT}|$CLAUDE_PLUGIN_ROOT|g; s|\${CLAUDE_PLUGIN_DATA}|$CLAUDE_PLUGIN_DATA|g; s|\${DEVLOOP_DATA_DIR:-~/.dev-loop}|$DEVLOOP_DATA_DIR|g")"

# then, per CLI (⚠️ VERIFY the exact run flags):
#   Claude Code: claude -p "$PROMPT"
#   Codex:       codex exec "$PROMPT"
#   opencode:    opencode run "$PROMPT"
```

For the PR/media article writer, call the same wrapper with `communication`:

```bash
./launch-agent.sh communication <project>
```

Loop cadence (re-fire every N minutes) is the operator's launcher concern — the OS scheduler
(`dev-loop service`) or the `dev-loop run` supervisor own it; a bare wrapper can also be re-fired by
cron / a `while sleep` loop. The agents are **stateless per fire**, so a loop is just "run the
wrapper again". No agent hard-requires a Claude-Code-only tool; Bash/Read/Edit are
near-universal — confirm your CLI exposes them.

> The old `install-codex-prompts` / `~/.codex/prompts/*.md` compatibility layer was **removed in
> 0.23.0** (Codex deprecated custom prompts in favor of skills). For Codex, `dev-loop run --cli codex`
> is the single path — it injects each SKILL as the prompt and self-defines the hub MCP via `-c`
> (above). For an **unattended** loop it must run in the default (non-`--codex-safe`) mode: Codex
> auto-cancels MCP tool calls that need approval, so `--codex-safe` makes the agent unable to reach
> the hub. See [`RUNNING.md`](RUNNING.md) → "`--codex-safe`".

---

## 4. The identity gate (the §5 onboarding test — do this BEFORE trusting a new CLI)

Per-agent identity is the hub's headline win **and** a safety control: if a CLI silently fails to
propagate `DEVLOOP_ACTOR`, every write would be **mis-attributed** (or refused). So a CLI is
onboarded only after it passes this gate.

**Launcher-side sanity check** (does *this shell* resolve the identity the hub will use?):

```bash
DEVLOOP_ACTOR=dev DEVLOOP_PROJECT=<key> DEVLOOP_HUB_DB=<path> \
  dev-loop identity-check --expect dev
# → {"actor":"dev",...,"wouldStart":true,"matchesExpectation":true,"pass":true}
# exit 0 = the env resolves to a known actor AND matches the expected one; exit 1 = REFUSED or MISMATCH.
# Pass `--expect <actor>[/<project>]` (or DEVLOOP_EXPECT_ACTOR / DEVLOOP_EXPECT_PROJECT) so the gate
# catches a WRONG-but-valid actor (mis-attribution), not just an unknown/unset one — a launcher
# should always assert against the identity it INTENDED.
```

**The real per-CLI gate** (does the CLI propagate that env *through its MCP spawn*?): run a one-shot
task through the CLI that calls the hub's `whoami` tool, with a **distinctive** actor:

```bash
DEVLOOP_ACTOR=dev <cli-headless-run> "call the dev-loop-hub whoami tool and print ONLY its actor field"
```

- **PASS** → it prints `dev`. The CLI propagates per-pane identity; onboard it.
- **FAIL** → it prints `operator` (the hub's default when the env didn't arrive) **or any other
  value**. The CLI is **not** propagating per-pane identity → **do NOT onboard** until fixed (e.g. a
  per-pane config override, or a CLI flag that forwards the process env). Fail closed — a
  mis-attributing loop is worse than a single-CLI loop.

`whoami` is the probe because it simply **echoes the resolved `actor`/`project`** the hub will stamp
on every write. (`identity-check` reflects the *launcher's* process env; `whoami` proves the *CLI's
spawn* delivered it — both matter, run both.)

---

## 4a. Codex — CERTIFIED (2026-06-25)

Run end-to-end against the live hub on `codex-cli 0.142.0`. **Result: certified for per-agent identity
— with one caveat that changes the launch recipe.**

| Check | Result |
|---|---|
| MCP transport (codex connects to the hub, lists/calls tools) | ✅ works |
| Real data tool round-trip (`list_issues` → the actual board) | ✅ works |
| Per-pane identity via **process-env propagation** (`DEVLOOP_ACTOR=dev codex exec …`) | ❌ **fails** → `whoami` returns `operator` |
| Per-pane identity via a **`-c` config override** | ✅ works → `whoami` returns `dev`, project preserved |

**The finding:** Codex spawns the MCP subprocess with **only the `env` block from `config.toml`** — it
does **not** inherit the launching shell's process env. So the §1 contract's "ride the per-pane process
env" does **not** reach the hub on Codex, and every write would mis-attribute to `operator` (the gate
**fails** as written). But Codex's `-c key=value` override **merges** a dotted key into the config env
table, so identity rides there instead.

**Certified recipe** — register the server once (`[mcp_servers.dev-loop-hub]`, the
[`config/mcp.codex.toml.example`](../config/mcp.codex.toml.example) shape, `DEVLOOP_ACTOR` **absent**),
then make each pane inject its actor with `-c`:

```bash
# one pane = one agent identity (this is what replaces Claude Code's per-pane ${DEVLOOP_ACTOR} .mcp.json)
codex exec -c 'mcp_servers.dev-loop-hub.env.DEVLOOP_ACTOR="dev"' \
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$PROMPT"
# whoami → {"actor":"dev","project":"dev-loop",…}  (project/db from the static config env, merged)
```

For the Communication agent, the actor override is the only part that changes:

```bash
codex exec -c 'mcp_servers.dev-loop-hub.env.DEVLOOP_ACTOR="communication"' \
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$PROMPT"
```

`dev-loop run --cli codex ...` applies these `-c` overrides automatically for every
scheduled fire, including `DEVLOOP_PROJECT` and `DEVLOOP_HUB_DB`; use the explicit form
above only when you are launching one prompt by hand.

The npm registration uses `command="dev-loop", args=["serve"]` (a PATH bin). The `-c` actor override
is unchanged. **opencode** has the same per-pane question — run §4 against it and expect a similar
config-override answer; not yet certified.

---

## 5. What stays the same on every CLI

- **§17 self-evolution firewall.** No agent self-edits a SKILL/conventions/code file; structural
  changes are operator git commits. This is **prompt-gated + git-backed**, so it is CLI-independent —
  a second CLI's shell/edit access does not weaken it (the same as Claude Code).
- **§16 secrets / PII.** Tokens stay in env (referenced by name), read server-side. Mirrored/channel
  bodies must be §16-safe. Same on every CLI.
- **Cooperative identity.** Honest framing everywhere: attribution, not anti-spoof, on one host.
- **No daemon.** Each CLI spawns the hub as a per-pane stdio subprocess; the channel polls and the
  mirror pushes per-fire (P5–P7), exactly as on Claude Code.

---

## Open items (operator-verify)

- The exact Codex `config.toml` `[mcp_servers]` schema and its env-propagation behavior on your
  installed version (the template is best-effort).
- The exact opencode `mcp` schema and its env-propagation behavior on your installed version.
- Each CLI's headless run flag(s). Loop cadence can be owned by `dev-loop run`, so a CLI-native
  loop facility is optional.
- Whether a CLI needs a per-pane config override when it does **not** inherit the launching process
  env (the per-pane catch in §2).
