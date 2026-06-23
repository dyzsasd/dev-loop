# Running dev-loop on a second CLI (Codex / opencode) — P8

The whole reason the loop's system-of-record is a **local hub** (a plain **stdio MCP server** over
`node:sqlite`, identity via **env vars**, no daemon — see [`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md))
is that it is **CLI-portable**. The same agents, the same hub, the same per-agent identity can run on
Claude Code **and** another coding CLI (Codex, opencode, …) against the *same* `hub.db`.

> **Status (v0.19.0).** The hub + the identity contract + the identity-check helper are CLI-agnostic
> and shipped. Claude Code is the validated CLI. Codex/opencode are **enabled by this contract but
> not yet live-validated** — the config snippets below are best-effort and marked ⚠️ VERIFY; the
> **identity gate** is how you confirm a given CLI before onboarding it. Claude Code is **100%
> unchanged** by any of this (P8 is purely additive).

---

## 1. The CLI-agnostic env contract (the one thing every launcher must do)

The hub and the SKILLs read everything they need from **environment variables**. A launcher for ANY
CLI sets these per agent pane — that is the entire portability contract:

| Var | Meaning | Who sets it |
|---|---|---|
| `DEVLOOP_ACTOR` | the per-agent identity (`pm`/`qa`/`dev`/`sweep`/`reflect`/`ops`/`architect`/`director`) — the attribution win | the launcher, **per pane** |
| `DEVLOOP_PROJECT` | the project key (pins this hub process to one project) | the launcher — **optional (DL-13):** when unset/empty the hub auto-resolves the project from the spawned process's **cwd** (the repo it was launched in), so a launcher that spawns the MCP server with `cwd` inside a repo need not set it. **Portability caveat:** this works only if the CLI spawns the MCP subprocess with that cwd; some CLIs spawn from a fixed dir, so the launcher exporting `DEVLOOP_PROJECT` (via `dev-loop-hub resolve-project`) stays the robust primary mechanism |
| `DEVLOOP_HUB_DB` | absolute path to the shared `hub.db` | the launcher |
| `CLAUDE_PLUGIN_ROOT` | the dev-loop checkout root — the SKILLs read `${CLAUDE_PLUGIN_ROOT}/references/conventions.md` | the launcher (despite the name, it's just the SKILLs' config-resolution var — **any** CLI's launcher can export it) |
| `CLAUDE_PLUGIN_DATA` | the data dir — the SKILLs read `${CLAUDE_PLUGIN_DATA}/projects.json` | the launcher (or rely on the SKILLs' `~/.claude/plugins/data/dev-loop/` fallback) |

**Why this gives zero SKILL edits:** the SKILL bodies already reference `${CLAUDE_PLUGIN_ROOT}` /
`${CLAUDE_PLUGIN_DATA}`. On Claude Code the plugin loader sets + substitutes them. On a second CLI a
small wrapper does the same two things: (a) **export** the env contract, and (b) **substitute** the
`${...}` placeholders into the SKILL body before feeding it as the prompt (the second CLI has no
plugin loader to do the substitution). No SKILL body changes.

Secrets are unchanged on every CLI: the channel (P6) / mirror (P7) tokens stay in env, referenced by
**name** only, read server-side (§16). Per-agent identity is **cooperative attribution** (any local
process can set its own env) — the same honest framing on every CLI, not stronger.

---

## 2. Register the hub MCP server

Pick the file for your CLI; each registers `node <dev-loop>/hub/src/server.ts` as a stdio MCP server.

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
the identity gate (§4) checks.**

---

## 3. Run an agent headless

On a second CLI there is no `/pm-agent` slash command — you feed the **SKILL body** as the prompt. A
minimal per-pane wrapper:

```bash
# launch-agent.sh <agent> <project>   (one pane = one agent identity)
AGENT="$1"; PROJECT="$2"
export DEVLOOP_ACTOR="$AGENT" DEVLOOP_PROJECT="$PROJECT"
export DEVLOOP_HUB_DB="$HOME/.dev-loop/hub.db"
export CLAUDE_PLUGIN_ROOT="/ABS/PATH/dev-loop"
export CLAUDE_PLUGIN_DATA="$HOME/.claude/plugins/data/dev-loop"
# strip the frontmatter, substitute the plugin-path placeholders, feed as the prompt:
PROMPT="$(sed '1{/^---$/!q};1,/^---$/d' "$CLAUDE_PLUGIN_ROOT/skills/$AGENT-agent/SKILL.md" \
  | sed "s|\${CLAUDE_PLUGIN_ROOT}|$CLAUDE_PLUGIN_ROOT|g; s|\${CLAUDE_PLUGIN_DATA}|$CLAUDE_PLUGIN_DATA|g")"

# then, per CLI (⚠️ VERIFY the exact run flags):
#   Claude Code: claude -p "$PROMPT"           (or /loop for a cadence)
#   Codex:       codex exec "$PROMPT"
#   opencode:    opencode run "$PROMPT"
```

Loop cadence (re-fire every N minutes) is the operator's launcher concern (cron / a `while sleep`
wrapper / the CLI's own loop facility) — the agents are **stateless per fire**, so a loop is just
"run the wrapper again". The Director's sync-panel already documents an **internal multi-lens
fallback** for any CLI that lacks a sub-agent/Task tool (conventions §25), so no agent hard-requires
a Claude-Code-only tool. Bash/Read/Edit are near-universal; confirm your CLI exposes them.

---

## 4. The identity gate (the §5 onboarding test — do this BEFORE trusting a new CLI)

Per-agent identity is the hub's headline win **and** a safety control: if a CLI silently fails to
propagate `DEVLOOP_ACTOR`, every write would be **mis-attributed** (or refused). So a CLI is
onboarded only after it passes this gate.

**Launcher-side sanity check** (does *this shell* resolve the identity the hub will use?):

```bash
DEVLOOP_ACTOR=dev DEVLOOP_PROJECT=<key> DEVLOOP_HUB_DB=<path> \
  node <dev-loop>/hub/src/server.ts identity-check --expect dev
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
- Each CLI's headless run flag(s) and loop facility (the wrapper above is a sketch).
- Whether a CLI needs a per-pane config override when it does **not** inherit the launching process
  env (the per-pane catch in §2).
