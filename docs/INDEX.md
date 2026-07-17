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
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how dev-loop works inside: layers, agents, workflows, backends.
- [`DAEMON.md`](DAEMON.md) — low-level localhost daemon HTTP surface. Use `dev-loop hub ...` for normal 1.x workspace lifecycle; use raw `dev-loop daemon ...` only for compatibility/debugging.
- [`design/2026-07-review-decisions.md`](design/2026-07-review-decisions.md) — the 2026-07 full-review operator decision record (D1–D11), shipped as 1.2.0. Current policy for the agent interface (CLI-first), web UI routing, doc-change flow, and retention.
- [`design/model-provider-routing.md`](design/model-provider-routing.md) — the 1.3.0 opencode-first model-provider routing design: decision trail (ZCode research → opencode as the vehicle), `team.providers` registry, `sync-opencode`, the certified permission posture, and the deferred claude-runner route (Appendix A).
- [`design/one-click-deployment.md`](design/one-click-deployment.md) — the 1.4.0 three-leg deployment model (as built): `dev-loop up` lands in a chat-driven operator console; `bundle export`/`up --bundle` MOVES the home (encrypted, board included); `attach` operates the remote home from anywhere. Deploy artifacts live in [`../deploy/`](../deploy/README.md).
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — how to work on this repository locally.

## Historical Design Records

These explain why the 1.x system looks the way it does. They are not the quickest way to learn how to run it.

- [`docs/design/`](design/) — design records for the 1.x workspace line and related subsystems, including [`design/skill-template.md`](design/skill-template.md) — the uniform SKILL template + per-fire context budgets shipped in 1.2.0.
- [`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md) — historical hub/service architecture record. Its status note names the later 1.x changes (through the 1.2.0 review).
- [`DESIGN-agile-for-ai-workflows.md`](DESIGN-agile-for-ai-workflows.md) — workflow design notes.
- [`strategy-archive/`](strategy-archive/) and [`reviews/`](reviews/) — archived strategy and review material.

## Current Backend Names

For new 1.x workspaces, treat `linear` and `service` as the current operator-facing backends. Older docs and compatibility code may still mention `local`; it is a legacy file-board backend kept in the shared conventions for compatibility, not the recommended path for new workspaces.
