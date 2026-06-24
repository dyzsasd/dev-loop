# Repositioning design — standalone daemon + single-host multi-CLI (2026-06-24)

> The architecture for the operator's 2026-06-24 redirect: **dev-loop = a standalone coordination
> daemon with interchangeable AI-CLI clients** (single-host, multi-CLI now; remote/auth deferred).
> Designed via a Workflow (1 design + 2 adversarial critics — **architecture: SOLID**, **safety:
> needs-changes → fixes folded below**). The north star is `STRATEGY.md` → `## Vision`; PM drives
> a backlog from the phase plan here.

## Decisions

1. **Consolidated daemon.** ONE long-lived per-project process owns: the SoR (the single writable
   `node:sqlite` WAL connection), the web UI + read API (`query_only=ON`), the opt-in human write
   routes (DL-3/DL-29, `writeOriginOk`), and a NEW agent **op API**. It supersedes today's two
   thin callers (per-pane `server.ts` + read-only `daemon.ts`) of the already-factored core
   (`ticketwrite.ts`/`docstore.ts`/`channel.ts`). **Agents stay stateless per fire** — the daemon
   holds no per-agent session/memory; "session" = one in-flight HTTP/MCP connection. Zero-build
   (Node ≥23.6 type-strip) + zero native deps preserved.
2. **Transport = a thin stdio MCP shim → the loopback daemon** (default). The shim reads
   `DEVLOOP_ACTOR` from its own env and forwards it as an `X-Devloop-Actor` header on the internal
   loopback HTTP call **the shim** makes — so the CLI never makes an authed HTTP call and the
   headless `claude -p` Authorization-header-drop bug (HUB-ARCHITECTURE §6) never touches identity.
   The per-CLI `whoami` **identity gate** (P8) stays the onboarding test. MCP-over-HTTP is a
   secondary mount added at **P5 only**, and only for a CLI that passes the gate over headers.
3. **Three client surfaces** (all thin HTTP clients to the loopback daemon, no SoR/logic):
   the stdio MCP shim; a `dev-loop` CLI (`ticket update`, `board`, `send`, `doc`, `whoami`); a thin
   per-CLI plugin (registers the shim + ships the prompts).
4. **Daemon op API** = `POST /api/op/*` mirroring the MCP op-shapes 1:1 (ticket.*/doc.*/topic.*/
   channel.*/mirror.*/whoami). Every **mutating** endpoint: `writeOriginOk` (DL-19 CSRF/DNS-rebind
   wall) FIRST → reads the actor from `X-Devloop-Actor` → validates it against `actors` (G1) →
   pinned project (G2/§2) → appends an attributed event → honors `mode` server-side.
5. **Identity — cooperative, single-host.** Client declares `DEVLOOP_ACTOR` (env, per pane) →
   `X-Devloop-Actor` → daemon attributes per-request. Honest framing: on one host any local
   process can name any actor — accountability + accident-prevention, not anti-spoof.
6. **Packaging — MONO-repo, multiple distribution units** (NOT a split — prompts/conventions/hub
   must version together, §26): (a) the standalone CORE npm package `dev-loop` (the expanded
   `hub/`: SoR + daemon + `shim.ts` + the `dev-loop` CLI), `npm i -g dev-loop`, Claude-independent;
   (b) the SKILLs + `conventions.md` as CLI-agnostic shared content shipped IN the core; (c) thin
   per-CLI adapters (the Claude plugin becomes: shim registration + prompts + `marketplace.json`).

## Phase plan (additive; each independently shippable; the loop runs throughout; current paths unbroken)

- **P1 — Turnkey (the on-ramp; the in-flight Goals).** `dev-loop daemon ensure` (pidfile +
  `hub.port` + a real `/api/health` liveness check — DB-writable, not just a port bind — no
  double-start, one-per-project on a cwd-resolved port via DL-13) + auto-start the web UI (a Claude
  `SessionStart` hook → the hook half is a §17 `[pm-proposal]` for operator git-commit; the
  lifecycle/CLI half is Dev-buildable). Mount `POST /api/op/*` **DORMANT, gated on an explicit
  `hub.transport:"daemon"` project setting (default-off)** so a current read-only-daemon project
  gets ZERO new surface. E2E: install → web UI up → an MCP ticket change shows in the UI, zero
  manual `npm run daemon`.
- **P2 — The thin shim.** Ship `shim.ts` (stdio MCP → loopback op API, env→`X-Devloop-Actor`).
  RELIES on the existing WAL + `busy_timeout` serialization (the proven MVP model, §6) — the
  daemon-single-writer is a P3 optimization, NOT a P2 prerequisite.
- **P3 — Daemon as canonical single writer.** The daemon holds the one long-lived writable
  connection (the atomic claim serializes in one process). Cost: a persistent writable handle → add
  a periodic `PRAGMA wal_checkpoint(TRUNCATE)` (alongside the existing `startBlockedNotifier`
  interval). The direct-db stdio `server.ts` stays a back-compat fallback.
- **P4 — Standalone packaging.** Publish `npm i -g dev-loop`; reshape the Claude plugin to thin; a
  **single-version release script** stamps the repo-root version into `hub/package.json` +
  `.claude-plugin/{plugin.json,marketplace.json}`; the shim path resolves via a `dev-loop` PATH bin
  (`command:"dev-loop", args:["shim"]`), not a fragile relative path.
- **P5 — Multi-CLI hardening.** Certify a 2nd CLI (Codex) end-to-end on the daemon-primary path; add
  the MCP-over-HTTP mount ONLY if it passes the header identity gate; serve the shared prompts to
  non-Claude adapters.
- **Phase B (DEFERRED — named, not built).** Remote / multi-host / multi-user / network exposure +
  the `agent_tokens` auth model (per-(agent,project), hash-only at rest, project-pinned). The
  daemon's per-request actor-resolution function is the single seam where this slots in.

## Invariants (transport-independent)

- **§17 firewall — unchanged.** No endpoint/op/web-route/CLI ever writes a SKILL/conventions/
  plugin-config/code file; doc ops are DB-only with a CHECKed `kind` enum — the **live enum is
  `{strategy,roadmap,decisions,notes}`** (HUB-ARCHITECTURE §16's 6-value cite is a stale doc bug to
  reconcile). Structural changes stay operator-committed `[*-proposal]` tickets.
- **§2 isolation.** One daemon = one pinned project; no cross-project endpoint; a 2nd project = a 2nd
  daemon/port (process+port+pinned-project — stronger than per-pane env).
- **§16.** Binds **127.0.0.1 only** (never 0.0.0.0); secrets in env by name, read server-side; the
  SoR holds no plaintext credential.

## Folded critique fixes (safety lens, needs-changes)

- doc-kind enum corrected to the live `{strategy,roadmap,decisions,notes}`.
- op API mount **conditional on `hub.transport:"daemon"`, default-off** → no-regression for current read-only-daemon projects.
- **shim-only through P4**; MCP-over-HTTP only at P5 if a CLI passes the header identity gate (constrained by the same `writeOriginOk` + 127.0.0.1 bind).
- per-request `X-Devloop-Actor` is a **NEW capability** (multiplexing N agents over one writer), not a "preserved" one — framed honestly.
- exposing `doc.publish` over the op API with a client-set actor makes the operator-publish gate **cooperative (claim-based)** vs today's daemon-process-identity gate — named; revisit under Phase B auth.
- `PRAGMA wal_checkpoint(TRUNCATE)` on the long-lived writable connection (P3).
- `writeOriginOk` on **every** `/api/op/*` mutating endpoint (+ a cross-origin-rejected daemon test).
- single-version release-stamp mechanism; shim path via a `dev-loop` PATH bin.
- shim discovers the daemon port via the `hub.port` file.
- the IM channel's **inbound** messages stay per-fire DATA rows an agent reads + acts on — never daemon-acted (preserve the §25 instruction-source boundary).
- assert back-compat with a CI/test gate proving a current Claude-plugin stdio user (live `.mcp.json` → `node hub/src/server.ts` opening `hub.db` directly) is byte-for-byte unaffected.

_(Full workflow output: the design `wk14t9gu1` run — architecture + transport + identity + packaging + migration + safety, with both critiques.)_
