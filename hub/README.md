# dev-loop

The standalone local **coordination hub** for the [dev-loop](https://github.com/dyzsasd/dev-loop)
agents. It is a **zero-build, zero-native-dependency** MCP system of record over `node:sqlite`,
with **per-agent identity**, a localhost **web UI daemon**, an opt-in agent **op-API + thin stdio
shim**, and a transport that works across CLIs (Claude Code · Codex · opencode).

> One trusted host, localhost-only. Identity is **cooperative attribution**, not anti-spoofing.
> Secrets live in env by **name** only. See the security envelope in
> [`docs/HUB-ARCHITECTURE.md`](https://github.com/dyzsasd/dev-loop/blob/main/docs/HUB-ARCHITECTURE.md).

## Install

```bash
npm install -g @dyzsasd/dev-loop   # requires Node >= 23.6 (built-in node:sqlite + .ts type-stripping; zero build); installs the `dev-loop` + `dev-loop-hub` bins
```

This installs two binaries on `PATH`: **`dev-loop`** for the CLI and **`dev-loop-hub`** for the
MCP server entrypoint. The package also ships the agent skills and shared references used by
`dev-loop run`, so Codex/opencode scheduler runs do not need a separate Claude plugin checkout.

## CLI

```
dev-loop serve                       run the stdio MCP server (the agent transport)
dev-loop shim                        the thin stdio MCP shim → the loopback daemon op-API
dev-loop daemon up|down|status       per-project daemon lifecycle — idempotent, auto web UI
dev-loop init-service <key> <name> <PREFIX>   turnkey-bootstrap a service-backend project
dev-loop run --cli claude|codex [--project <key>] [--agents core,outward]   schedule agents with your own runner
dev-loop mcp-merge <args>            merge dev-loop-hub into a product .mcp.json (never clobbers)
dev-loop seed <key> <name> [PREFIX]  seed a project + actors + labels
dev-loop doctor                      health-check the system-of-record (DOCTOR_OK)
dev-loop identity-check [--expect <actor>[/<project>]]   the portability gate
dev-loop version | help
```

## Identity & project (the env contract)

Every launcher sets the write identity **per pane**:

| Env var | Meaning |
|---|---|
| `DEVLOOP_ACTOR` | the per-agent identity (`pm`/`qa`/`dev`/...) — the attribution |
| `DEVLOOP_PROJECT` | the pinned project key (or resolved from the cwd) |
| `DEVLOOP_HUB_DB` | the SQLite system-of-record (default `~/.dev-loop/hub.db`) |

Register it as an MCP server for your CLI with `{ "command": "dev-loop", "args": ["serve"] }`,
or use `["shim"]` for the daemon transport. Per-CLI recipes and the identity gate live in:
[`docs/PORTABILITY.md`](https://github.com/dyzsasd/dev-loop/blob/main/docs/PORTABILITY.md).

For an unattended loop without Claude/Codex `/loop`, run the built-in scheduler:

```bash
cd /path/to/product-repo   # project is inferred from repoPath / repos[].path
dev-loop run --cli claude --agents core,communication
dev-loop run --cli codex  --agents core,outward
```

It owns cadence itself and shells out to the selected CLI once per agent fire. Use
`--project <key>` only when launching from outside the repo or overriding cwd detection.

## Docs

- [Architecture + safety envelope](https://github.com/dyzsasd/dev-loop/blob/main/docs/HUB-ARCHITECTURE.md)
- [Running the loop](https://github.com/dyzsasd/dev-loop/blob/main/docs/RUNNING.md) ·
  [The daemon](https://github.com/dyzsasd/dev-loop/blob/main/docs/DAEMON.md) ·
  [Portability (Codex / opencode)](https://github.com/dyzsasd/dev-loop/blob/main/docs/PORTABILITY.md)

MIT © Shuai
