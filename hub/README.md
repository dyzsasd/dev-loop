# dev-loop

The standalone local **coordination hub** for the [dev-loop](https://github.com/dyzsasd/dev-loop)
agents — a **zero-build, zero-native-dependency** MCP system-of-record over `node:sqlite` with
**per-agent identity**, a localhost **web-UI daemon**, an opt-in agent **op-API + thin stdio shim**,
and a **CLI-portable** transport (Claude Code · Codex · opencode).

> One trusted host, localhost-only. Identity is **cooperative attribution** (not anti-spoof). Secrets
> live in env by **name** only. See the security envelope in
> [`docs/HUB-ARCHITECTURE.md`](https://github.com/dyzsasd/dev-loop/blob/main/docs/HUB-ARCHITECTURE.md).

## Install

```bash
npm install -g dev-loop      # requires Node >= 23.6 (built-in node:sqlite + .ts type-stripping; zero build)
```

This puts two bins on `PATH`: **`dev-loop`** (the CLI) and **`dev-loop-hub`** (the MCP server entry).

## CLI

```
dev-loop serve                       run the stdio MCP server (the agent transport)
dev-loop shim                        the thin stdio MCP shim → the loopback daemon op-API
dev-loop daemon up|down|status       per-project daemon lifecycle — idempotent, auto web UI
dev-loop init-service <key> <name> <PREFIX>   turnkey-bootstrap a service-backend project
dev-loop mcp-merge <args>            merge dev-loop-hub into a product .mcp.json (never clobbers)
dev-loop seed <key> <name> [PREFIX]  seed a project + actors + labels
dev-loop doctor                      health-check the system-of-record (DOCTOR_OK)
dev-loop identity-check [--expect <actor>[/<project>]]   the portability gate
dev-loop version | help
```

## Identity & project (the env contract)

Every launcher sets, **per pane**, the identity the write is attributed to:

| Env var | Meaning |
|---|---|
| `DEVLOOP_ACTOR` | the per-agent identity (`pm`/`qa`/`dev`/…) — the attribution |
| `DEVLOOP_PROJECT` | the pinned project key (or resolved from the cwd) |
| `DEVLOOP_HUB_DB` | the SQLite system-of-record (default `~/.dev-loop/hub.db`) |

Register it as an MCP server for your CLI — `{ "command": "dev-loop", "args": ["serve"] }` (or
`["shim"]` for the daemon transport). Per-CLI recipes + the identity gate:
[`docs/PORTABILITY.md`](https://github.com/dyzsasd/dev-loop/blob/main/docs/PORTABILITY.md).

## Docs

- [Architecture + safety envelope](https://github.com/dyzsasd/dev-loop/blob/main/docs/HUB-ARCHITECTURE.md)
- [Running the loop](https://github.com/dyzsasd/dev-loop/blob/main/docs/RUNNING.md) ·
  [The daemon](https://github.com/dyzsasd/dev-loop/blob/main/docs/DAEMON.md) ·
  [Portability (Codex / opencode)](https://github.com/dyzsasd/dev-loop/blob/main/docs/PORTABILITY.md)

MIT © Shuai
