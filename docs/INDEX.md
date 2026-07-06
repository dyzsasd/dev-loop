# Documentation Index

Start here when you are deciding which dev-loop document is current.

## Current Operator Guides

- [`README.md`](../README.md) — product overview and the shortest install-to-run path.
- [`RUNNING.md`](RUNNING.md) — workspace setup, plugin/skill activation, scheduler operation, logs, and safe stopping.
- [`PORTABILITY.md`](PORTABILITY.md) — running the same workspace from Claude Code, Codex, or another CLI.
- [`RELEASING.md`](RELEASING.md) — GitHub Actions release flow for the npm package.

## Current References

- [`references/config-schema.md`](../references/config-schema.md) — `dev-loop.json` schema and doctor codes.
- [`references/conventions.md`](../references/conventions.md) — authoritative agent protocol. Skills defer to this file on conflicts.
- [`DAEMON.md`](DAEMON.md) — low-level localhost daemon HTTP surface. Use `dev-loop hub ...` for normal 1.x workspace lifecycle; use raw `dev-loop daemon ...` only for compatibility/debugging.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — how to work on this repository locally.

## Historical Design Records

These explain why the 1.0 system looks the way it does. They are not the quickest way to learn how to run it.

- [`docs/design/`](design/) — design records for the 1.0 workspace line and related subsystems.
- [`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md) — historical hub/service architecture record. Its status note names later 1.0 changes.
- [`DESIGN-agile-for-ai-workflows.md`](DESIGN-agile-for-ai-workflows.md) — workflow design notes.
- [`strategy-archive/`](strategy-archive/) and [`reviews/`](reviews/) — archived strategy and review material.

## Current Backend Names

For new 1.x workspaces, treat `linear` and `service` as the current operator-facing backends. Older docs and compatibility code may still mention `local`; it is a legacy file-board backend kept in the shared conventions for compatibility, not the recommended path for new workspaces.
