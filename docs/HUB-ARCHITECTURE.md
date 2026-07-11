# dev-loop Hub — Architecture

> **Status note (1.0.0):** this is a historical architecture record for the hub/service backend.
> The P0→P8 ladder shipped before 1.0, and later work added the workspace-managed service daemon
> (`dev-loop hub start|stop|status|ensure`) plus the localhost web UI described in
> [`DAEMON.md`](DAEMON.md). Some older sections below still discuss a daemon-free MVP and deferred
> daemon work; treat those as design history. For current operation, read
> [`RUNNING.md`](RUNNING.md), [`PORTABILITY.md`](PORTABILITY.md), [`DAEMON.md`](DAEMON.md), and the
> 1.0 workspace model in [`references/conventions.md`](../references/conventions.md) §27.
> The hub uses built-in `node:sqlite` (not better-sqlite3 — P0 found zero native deps possible).
>
> Original status: proposal for operator sign-off (LK8). The text below is preserved as the design
> rationale that led to the shipped hub.
> Audience: the operator, and the loop agents that coordinate through it.
> Companion: `references/conventions.md` (the shared brain — every section here references it by `§`).

The hub is a **local system-of-record** for the dev-loop. It replaces Linear-as-source-of-truth with a machine-local store the agents reach through an **MCP server** (LK1), exposing everything Linear gives the loop today plus **per-agent attribution, real per-project isolation, and versioned docs/discussion**. Linear is demoted to an optional, one-way, off-by-default **mirror** for human visibility (LK2).

This doc is deliberately conservative. It folds in three independent critiques (feasibility/MCP-reality, safety/identity, scope/phasing) whose combined verdict is: *the four facet designs over-built*. The result is a **ladder**, not a leap — each rung shippable, demoable, and gated by evidence.

---

## 0. How to read this — the headline decisions up front

1. **The `local` file board (§18) already delivers ~80% of this.** We steelman and keep it (§2). The "per-agent identity" win is a small additive field, not a 16-table daemon.
2. **Identity is attribution + accident-prevention, NOT an anti-spoof boundary.** On one machine, one OS user, one operator, any agent can read another pane's env or open the DB file directly. Every "cannot impersonate" claim from the facets is **deleted**. The threat model is honest-but-buggy agents + prompt-injection, not a hostile co-tenant (§4).
3. **Transport = stdio shim + shared SQLite-WAL, NO daemon, for the MVP.** Claude Code speaks stdio to our shim; identity rides a launcher-set env var, never an HTTP header — this dodges the confirmed Claude Code headless header-drop regressions (§6). The daemon arrives only when background work needs it (P5).
4. **The hub MIMICS the §18 op-contract verbatim** (REPLACE-style labels, verify-after-write). Agent SKILL bodies run unchanged via the existing §18 indirection. "Footguns designed out" is **not** an MVP win — it is a later, operator-driven, §17-gated SKILL rewrite with its own effort line (§12, §21).
5. **§17 is preserved verbatim, not "strengthened."** No hub tool ever writes a SKILL / conventions / plugin file. Direction docs are operator-published; agents draft, the operator flips draft→current out-of-band (§16).
6. **The MVP CUTS:** the always-on daemon, bearer tokens, server-enforced isolation, versioned docs, the discussion board, the Director, the channel, the Linear mirror, and multi-CLI. Each returns as its own gated phase (§22 roadmap).
7. **Durability regresses** from Linear's backed-up cloud to one local SQLite file. This is an explicit operator-signed RPO decision, with a backup/restore runbook (§18). The mirror is **never** sold as disaster recovery.

---

## 1. Why a hub at all — and what we are NOT building

Linear's ceiling, hit repeatedly:
- **Shared identity** — every agent and the operator are one Linear user (`shuai@citronetic.com`), so nothing is attributable. This forced the §23 file-channel-split provenance hack and the §9 self-mention suppression.
- **Weak document management** — last-write-wins, no diff/history the loop can reason over.
- **Isolation is a label convention (§2), not a boundary** — `label:dev-loop` + `project` is self-discipline, re-asserted in every query.

What the hub is **not**: it is **not Linear parity**. No cycles, SLAs, sub-issues, attachments, mobile app, notification fan-out, or saved views. The loop uses ~8 ticket operations (§12); the hub implements those plus the four named new capabilities (identity, isolation, versioned docs, discussion) plus a channel and a one-way mirror — and stops. Human-facing UI is **bought back** by the optional mirror (§15), not rebuilt.

> The single biggest risk to this project is the second-system trap: "rebuild everything Linear gives us, plus more." The hard scope cap above, and the kill/continue gate (§22), are the only defenses that matter.

---

## 2. The honest baseline — what the `local` file board already does (Alternatives considered)

Before proposing a database service, we owe the operator the cheaper option, steelmanned.

`backend:"local"` (§18) is **already shipped** and already provides, on a non-Linear substrate:
- The full §3 state machine (state in frontmatter), §4 labels, §5 priority, §6 templates.
- **An atomic claim** — `O_CREAT|O_EXCL` file creation arbitrates two writers; a per-fire run token (`dev (run a1b2)`) distinguishes fires (§18 "Concurrency").
- **Per-project isolation** — a dedicated board dir per project key; "scope by project" = "operate only in this board dir" (§18 "Firewall in local mode").
- **Dedupe** — glob + parse + substring/keyword scan over title+body (§8).
- **Attribution, today** — the append-only comment log already stamps `### <ts> — dev (run a1b2)` and every transition logs `state: X → Y`; Reflect reconstructs the activity window from it (§18 "Ticket file format").
- **Versioned docs, for free** — `strategyDoc` as a repo file gets git history, diff, blame, revert, and attribution at zero cost.

**So the "full per-agent identity" headline is a small additive change to the file board**, not a new runtime: change the comment author from self-asserted prose (`— dev`) to a structured `author:` field the SKILL body never writes — the **launcher** sets `DEVLOOP_ACTOR=dev` per pane (§8), and the backend stamps it. That is ~2–5 days, zero new dependency, zero daemon, zero migration, fully git-diffable.

**Why we proceed to the hub anyway (honoring LK1/LK2/LK4):** the file board cannot serve a low-latency cross-agent discussion board, structured FTS dedupe at scale, a queryable cross-fire event log, or a single coordination point for a future Director/channel — and the operator has decided the hub is the destination. **But the build is justified by evidence, not assumed:** P0 runs the loop on the file board and P1 ships the author-field hardening; only a **measured trigger** (§22) — observed O_EXCL contention at real cadence, OR a concrete query/feature the file board provably can't serve — advances to the SQLite hub. If the spike shows the hardened file board already satisfies the need, **stopping at P1 is a legitimate, honest outcome** the operator should weigh.

---

## 3. North star & non-goals

**Goals.**
- A1 — **Attribution**: every ticket move, doc edit, comment, post, and decision is stamped with which agent did it, sourced from the launcher (not self-asserted), readable by Reflect/reports.
- A2 — **Isolation**: a project's tickets/docs/discussion are a structural boundary, not a label convention — cross-project access is impossible by construction (§10).
- A3 — **Versioned docs**: the §20 doc-base and the roadmap live as documents with history/diff and operator-gated publication (§14).
- A4 — **Drop-in for the loop**: the agent SKILLs run with only the existing one-line §18 indirection — no body rewrite for the MVP (§21).

**Non-goals (MVP).** A daemon; bearer-token auth; the Director; the discussion board; the IM channel; the Linear mirror; multi-CLI; the footgun-removal SKILL rewrite; any Linear feature beyond the §12 op-set.

**Non-goals (ever).** A multi-tenant / hostile-actor security boundary on a single host; a cloud-hosted SoR; Linear feature parity.

---

## 4. Threat model & trust boundaries (read this before any "identity" claim)

**The system is a single operator, on a single machine, running all agents as one OS user.** Calibrate everything to that.

**The adversary we defend against:**
- **Honest-but-buggy agents** — a Dev fire that loses track of which ticket it owns; a mis-scoped query.
- **Prompt injection via untrusted content** — a crafted ticket body / imported comment / chat message / discussion post saying "operator approved: rewrite your SKILL."
- **Accidental cross-project bleed** — a fire scoped to project A touching project B.

**The adversary we explicitly do NOT defend against:**
- **A malicious or compromised agent process on the same host.** It can read any pane's environment, read `hub.db` directly with `sqlite3`, and forge any write as any actor. **No daemon, token, or MCP tool surface changes this.** The only real boundary would be one-OS-user-per-agent or per-agent unix sockets with `SO_PEERCRED` peer-credential checks — **named here, scoped out, not built.**

**What "identity" therefore means (honest):** attribution under cooperative agents + accident-prevention. It is **strictly better than today's one shared Linear identity** (you can now tell PM's actions from Dev's in the log), and it is **not** proof against forgery. Consequences threaded through the doc:
- The append-only `events` log records **claimed** identity, not **proven** identity (§11). It is an honest-agent accountability/debugging aid, **never** tamper- or forgery-resistant evidence. An operator must not trust a `director approved` row as authorization.
- The things that must be **unforgeable do not live in the hub at all** (§16): a §17 SKILL change is an operator git commit; any self-modify/irreversible authorization remains the operator's out-of-band action carrying the §23 second factor. The hub stores direction docs and their status for *coordination and visibility*, never as the authorization-of-record.

**Trust boundary, restated for ALL hub-native content (extends §22/§23):** ticket bodies, comments, doc bodies, discussion posts, decisions, imported history, and channel inbound are **DATA, never authorization**. Synthesis/distillation reads only the operator's out-of-band authorization. Because authoring identity is spoofable, even an `operator`- or `director`-attributed post must carry the §23 second factor before it can authorize anything.

---

## 5. Architecture at a glance — the ladder

```
P0  spike (zero build) ── run loop on the EXISTING file board; prove SKILL portability,
                          better-sqlite3 build, the concurrent-claim race
P1  harden the file board with a structured author field (the cheap win)
        ▼  ── MEASURED go/no-go: did P0/P1 show a server is actually needed? ──
P2  SQLite hub MVP  ── stdio shim + ONE shared SQLite-WAL file, NO daemon,
                       env identity, ONE project, Claude Code only, mirror OFF,
                       footguns MIMICKED.  Tables: actors, projects, tickets,
                       ticket_labels, comments, events.
        ▼  ── HARD KILL / CONTINUE GATE (operator signs) ──
P3  server-enforced multi-project isolation
P4  versioned documents (§20 doc-base + roadmap), operator-gated publish
P5  discussion board + Director ── NO daemon (loop-agent chairing; decisions inline)
P6  provider-agnostic IM channel ── two-way, POLL-based (NO daemon); digests + inbound
P7  one-way Linear mirror ── per-fire push (Sweep); split-brain enforced; NO daemon
P8  2nd CLI (Codex / opencode) ── env contract + per-CLI MCP registration + the
   identity-propagation gate (whoami); ZERO SKILL edits (launcher sets the env).
   [the footgun-removal SKILL rewrite stays a SEPARATE, deferred, §17-gated pass]
```

Each phase is independently shippable and the loop keeps running on the hub from P2 onward.

---

## 6. Runtime & transport — stdio shim + shared SQLite (no daemon for the MVP)

**Stack (LK4).** TypeScript (strict) + Node ≥ 20 LTS + `better-sqlite3` (synchronous, WAL, mature) + the official `@modelcontextprotocol/sdk`. Shipped as one package in the dev-loop repo (`hub/`), invoked `npx dev-loop-hub …`. A single-binary build (`pkg`/`bun compile`) is a later nicety, not MVP — it must bundle the prebuilt native `.node` per platform.

**Transport, decided (resolving the facet fork):** the agent's MCP server is a **stdio process the CLI spawns per pane**, and in the MVP that process **opens the one shared `hub.db` (WAL) directly**. There is **no long-lived daemon** in the MVP.

Why this and not the always-on HTTP daemon the facets proposed:
- **It dodges the Claude Code headless regression.** Per-agent identity carried as `Authorization: Bearer` on HTTP MCP calls is **broken on the loop's primary CLI in its primary mode**: headless `claude -p` (the `(sdk-cli)` user-agent path) **drops** the configured `Authorization` header on tool calls (issues #50464, #48514, #39271; OAuth-instead-of-bearer #47424). `claude mcp list` shows "Connected" and `curl` works, but tool calls arrive unauthenticated — which would silently strip attribution from every headless Claude Code fire, destroying the one win we are building for. By speaking **stdio to our own shim**, Claude Code never makes an authenticated HTTP call to the hub; identity comes from the env var the launcher set on that pane, which our code controls end-to-end.
- **It removes "run a reliable daemon" from the entire MVP risk surface** — no cold-start, no wedged-but-listening process, no pidfile races, no `/healthz` identity probe, no launchd/systemd unit.
- **Multi-process WAL is correct, not "broken."** (Facet B's justification for rejecting stdio was technically wrong.) SQLite WAL is *designed* for multiple processes/connections against one file with full ACID. The §7 claim is atomic in this model (§7).

**The daemon did NOT arrive at P5 OR P6 (this paragraph's original prediction is superseded).**
P5 shipped the board + Director with **no daemon** (a loop agent that chairs on each fire over the
shared WAL db — the hub IS its state; termination is **state-free** off `round_opened_at`). **P6's
two-way channel is also daemon-free, by choosing POLL over push:** a loopback stdio process owns no
inbound endpoint, so the Director **reaches OUT** each fire — `channel.poll()` does an outbound
history read since the hub-stored `channels.inbound_cursor`, ingests new operator messages, and
returns them; `channel.send()` posts. Both are ordinary outbound HTTPS a stdio process makes fine.
The cost is **latency = the fire cadence** (a direction/status/digest plane, not real-time chat;
an on-demand `/director-agent` fire is the fast-turn escape). **A daemon arrives ONLY if a
PUSH-webhook channel is ever wanted** (sub-fire-latency operator chat needs a reachable endpoint a
loopback lacks) — which P6 deliberately does not build. When/if it does, the stdio shim becomes a
**thin proxy** to a loopback daemon (`127.0.0.1:4319/mcp`, written to `hub.port`) — **the
agent-facing transport stays stdio, identity stays via env**, so the broken HTTP-header path is
never used by Claude Code.

**Liveness (when the daemon is used):** liveness lives in the **launcher/lifecycle**, not in launchd alone. A process manager runs `dev-loop daemon up` or `dev-loop daemon up-all` as a **blocking pre-step** before `claude -p`/`codex exec`/`opencode run`: start-if-down AND `GET /api/health` must return the expected project + a **DB-writable** check (not just a port bind), else restart; stale runfiles are reclaimed by the lifecycle. A "hub unreachable mid-fire" is a **degraded-mode exit**: log one line, exit per §0, next fire retries — never a half-applied write.

---

## 7. Concurrency & the claim — how WAL makes it atomic

**The whole loop's correctness rests on one race (§7):** two Dev fires must not both claim one ticket.

**Pragmas:** `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`, `wal_autocheckpoint=1000`.

**The claim is a single conditional UPDATE, serialized by SQLite:**

```sql
UPDATE tickets
   SET state='In Progress', assignee_actor_id=:actor, claim_token=:run, claimed_at=:now
 WHERE id=:id AND state='Todo' AND assignee_actor_id IS NULL;
-- claimed iff changes() == 1
```

This is atomic in **both** runtime models — multi-process WAL serializes the write across processes (MVP); the single-threaded `better-sqlite3` daemon serializes it within one process (P5+). There is **no read-then-write window**, so the §7 "save-then-refetch" dance is unnecessary at the hub layer — though the MVP **keeps mimicking** the verify-after-write contract so the SKILL bodies run unchanged (§21).

**Concurrency model, stated honestly:** writes are **serialized** — by WAL across processes, and by the single-threaded daemon within one process. The doc's earlier "N concurrent sessions writing in parallel" framing is misleading and is dropped. The loop's write rate is **low** (tickets and transitions, not high-frequency events): even at Ops' ~288 fires/day × N projects, the actual writes per fire are a handful. This is ample headroom for serialized SQLite writes, but it is a documented ceiling to **measure** in P0, not assume. Mitigations if it ever saturates: short transactions, `busy_timeout` retry, periodic `wal_checkpoint(TRUNCATE)`; and because `backend` is just a dial (§13), the storage engine can be swapped without touching the tool surface.

**Unbounded growth is a concrete job, not a risk bullet.** `events` and (later) `document_versions` accumulate forever at loop cadence. The hub ships a **prune/rollup**: `events` older than 90 days fold into a monthly rollup row; doc versions are kept but body size is capped; this mirrors the §11 bounded-state discipline that the 330 KB `qa-state.json` incident taught us.

---

## 8. Identity & attribution — the mechanism (honest about its limits)

**The launcher is the identity source.** `dev-loop run` (or an external process manager / Agent View setup) starts one agent fire with an explicit actor identity (`docs/RUNNING.md §2`). It is the natural place to assert identity:

- **MVP:** the launcher exports `DEVLOOP_ACTOR=<agent>` and `DEVLOOP_PROJECT=<key>` into each pane's environment. The stdio shim reads them once at spawn and stamps `actor` as the author of every write + every `events` row. The SKILL body never sees or sets the actor — it just calls `save_issue` as today.
- **Bootstrap contract (the missing piece the critique flagged):** one **shared** `.mcp.json` (committed or in the data dir) registers the hub shim with a header/env *reference*, e.g. `"env": {"DEVLOOP_ACTOR": "${DEVLOOP_ACTOR}"}` — the value is **interpolated per pane from the launcher's exported env**, never hardcoded. So one config file yields **different identities per pane** purely from the launcher's per-pane env. (Agent View applies one model per view and cannot inject per-row env as cleanly; the tmux launcher is the supported path for distinct identities — noted as a constraint, not a blocker.)
- **No interactive secret entry.** Identity is an actor *name* in the MVP — there is no token to type. Provisioning never requires the operator to type a secret per fire (relevant because the operator's browser-MCP cannot type passwords): the launcher env is set once, at the launcher, by the operator.

**Honest limit (load-bearing).** On one OS user, `DEVLOOP_ACTOR` is readable by any co-resident process, and any process can open `hub.db` directly and write as anyone. So the MVP's identity is **cooperative attribution**, the same trust level as the file board (where any agent can edit any ticket `.md`). It is strictly better than one shared Linear identity, and it is not a wall.

**If a token model is ever added (a later phase, only on a real multi-actor/remote need — it may never come):** tokens are **hash-only at rest in the hub** (`sha256(token)` + a non-secret 8-char prefix for audit); the **raw token's lifecycle belongs to the launcher** (an operator-managed env file or OS keychain) — the hub **never writes a plaintext token file**. Tokens are **per-(agent,project) project-pinned by DEFAULT** (a leaked project-A token cannot name project B); an unpinned multi-project token is the explicit exception. `whoami`/`project_list` for a pinned token disclose **only** the pinned project (no cross-project membership leak). Even then: still cooperative-only on one host, documented as such. **`whoami()` exists in the MVP** (returning the env-asserted actor) so the identity wiring is testable from fire one.

---

## 9. Operator-only operations — no agent-reachable surface

Certain actions must never be performed by an agent. In the hub they have **no MCP tool** and are **`dev-loop-hub` CLI subcommands the operator runs**, using a credential the launcher **never exports** into any agent pane:

- mint / rotate / revoke a token (if tokens exist),
- grant / revoke project membership or role,
- flip `autonomy` (`ask`↔`full`) or `mode` (`dry-run`↔`live`),
- enable the Linear mirror,
- **publish a strategy/roadmap document draft→current** (§14, §16) — *(correction, as shipped:
  no such `dev-loop-hub` CLI subcommand exists; the operator publishes via the MCP `doc.publish`
  tool (`DEVLOOP_ACTOR=operator`) or the daemon web `/roadmap` page)*,
- apply a §17 SKILL/conventions change (this remains a git commit — see §16).

**Honest scope of this protection.** Because a determined/compromised agent can bypass MCP and write `hub.db` directly (§4), "no tool surface" defends against honest-but-buggy agents and prompt-injection-via-MCP — **not** a malicious process. That is why the *truly* unforgeable authorizations (self-modify, irreversible prod ops) are kept **outside** the hub entirely (§16), where the existing §17/§22/§23 firewalls already put them.

**Publish over the agent op-API is cooperative (DL-43/DL-62).** The list above is the stdio/CLI form, where the daemon process's own `DEVLOOP_ACTOR` gates publish. When `doc.publish` is instead reached over the opt-in **agent op-API** (`hub.transport:"daemon"` → `POST /api/op/doc.publish`), the operator gate is **cooperative/claim-based** — it trusts the client-declared `X-Devloop-Actor:operator` header — not a daemon-process identity. This is the accepted single-host posture (honest cooperative attribution, **not** anti-spoof), revisited only under the deferred remote/auth phase; the §17 firewall is unaffected (a doc is DB-only, `kind` ∈ a CHECKed enum, never a SKILL/conventions/code file).

---

## 10. Multi-project isolation — the §2 firewall, made structural

In the hub, isolation stops being label self-discipline and becomes a **WHERE clause the agent cannot widen**:

- `projects` is a real row. **Every** tool takes a **required** `project` argument; there is **no unscoped query** (project cannot be omitted). Every query is implicitly `WHERE project_id = ?`.
- The shim is **bound to one project** by the launcher (`DEVLOOP_PROJECT`), and the server validates membership; a call naming a different project is `FORBIDDEN`. *(Status 2026-07, D1: the FORBIDDEN default stands for delivery actors, but the `project` arg is now a shipped, role-gated override — stewards (sweep/ops/reflect/communication) may name any project or `_team`, PM may name `_team` only — enforced at the shared `agentOp()` choke point on both transports; see `docs/design/2026-07-review-decisions.md` D1.)*
- This removes the §18 "a glob must never escape the board dir" hazard entirely — it is a column predicate, not a filesystem path.
- The `dev-loop` label is **retained on tickets** only for cross-backend parity (so a mirrored/exported ticket still reads correctly); it is no longer load-bearing for isolation.

**Honest limit (consistent with §4):** in the no-daemon MVP, a buggy agent could still pass a wrong `project` arg if its launcher env said so, and any agent can open `hub.db` directly. So this is accident-prevention + a structural default, not a wall against a malicious process. P3 adds server-enforced membership checks (the daemon validating the caller against `project_members`), which raises the bar against honest-but-buggy misuse but still not against a co-resident attacker.

---

## 11. Data model — SQLite (MVP core, then additive)

WAL; the daemon (or the per-fire shim) is the writer; ids are ULID/uuid `TEXT`; timestamps ISO-8601 `TEXT`. **MVP core = six tables.** Everything else is an explicitly-later, additive phase.

```sql
-- ── MVP CORE (P2) ─────────────────────────────────────────────────────────
CREATE TABLE actors (                 -- distinct identities (env-asserted in MVP)
  id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL,        -- 'pm','qa','dev',… ,'operator'
  kind TEXT NOT NULL CHECK(kind IN ('agent','human')),
  display_name TEXT NOT NULL, active INT NOT NULL DEFAULT 1, created_at TEXT NOT NULL);

CREATE TABLE projects (               -- the §2 firewall as a row
  id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  ticket_prefix TEXT NOT NULL DEFAULT 'DL', ticket_seq INT NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live','dry-run')),
  autonomy TEXT NOT NULL DEFAULT 'ask' CHECK(autonomy IN ('ask','full')),
  settings_json TEXT NOT NULL DEFAULT '{}',                -- §11 config (NO secrets — env-var names only)
  created_at TEXT NOT NULL, archived_at TEXT);

CREATE TABLE tickets (                 -- state machine §3, claim §7, type/owner via labels §4
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  number INT NOT NULL, key TEXT NOT NULL,                  -- '<prefix>-<n>' display id
  title TEXT NOT NULL, body_md TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK(type IN ('Feature','Bug','Improvement')),
  state TEXT NOT NULL DEFAULT 'Todo'
    CHECK(state IN ('Backlog','Todo','In Progress','In Review','Done','Canceled','Duplicate')),
  priority INT NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 4),
  assignee_actor_id TEXT REFERENCES actors(id), claim_token TEXT, claimed_at TEXT,   -- §7 CAS
  duplicate_of TEXT REFERENCES tickets(id),
  related_to_json TEXT NOT NULL DEFAULT '[]',              -- append-only merge (§8/§10)
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, number), UNIQUE(project_id, key));
CREATE INDEX ix_pick ON tickets(project_id, state, type, priority, created_at);   -- §5 pick order

CREATE TABLE ticket_labels (           -- REPLACE-style set (§4/§10/§19 repo:<name>)
  ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  name TEXT NOT NULL, PRIMARY KEY(ticket_id, name));

CREATE TABLE comments (                -- append-only, attributable
  id TEXT PRIMARY KEY, ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES actors(id), body_md TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE events (                  -- append-only audit = the attribution win (records CLAIMED identity, §4)
  id TEXT PRIMARY KEY,                                      -- ULID (sortable)
  project_id TEXT NOT NULL REFERENCES projects(id), actor_id TEXT NOT NULL REFERENCES actors(id),
  verb TEXT NOT NULL,                                       -- 'ticket.create|transition|claim|label.set|comment.add|…'
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',                    -- diff payload (state X→Y, labels before/after); §16-scrubbed
  created_at TEXT NOT NULL);
CREATE INDEX ix_ev_time ON events(project_id, created_at);

-- FTS over title+body for §8 dedupe (FTS5 from the MVP — weak LIKE scans miss duplicates)
CREATE VIRTUAL TABLE tickets_fts USING fts5(title, body_md, content='tickets', content_rowid='rowid');
```

```sql
-- ── ADDITIVE, LATER PHASES (schema-shaped now, built when the phase lands) ──
-- P3: project_members(project_id, actor_id, role)  + (if tokens) agent_tokens(hash-only)
-- P3: labels(project_id, name, kind)   -- a registry, only if free-string labels prove insufficient
-- P4: documents(project_id, slug, kind∈{strategy,roadmap,decisions,notes}, status∈{draft,current}, current_version)
--     document_versions(document_id, version, body_md, author_id, summary, base_version)   -- optimistic CAS
-- P5 (SHIPPED): topics / posts (discussion; the DECISION is INLINE on topics, no separate table)
-- P6 (SHIPPED): channels + channel_messages (two-way IM; config_ref = ENV-VAR NAME, never the secret; inbound_cursor = the no-daemon poll cursor)
-- P7 (SHIPPED): mirror_map(project_id, hub_kind, hub_id, linear_id, last_pushed_hash, last_pushed_at) — the hash skips unchanged tickets; linear_id NULL = create pending (crash-safe, reconciled by the [hub:id] title marker)
```

Note the MVP **does not** ship `agent_tokens`, `project_members`, a `labels` registry, `documents`, `document_versions`, `topics/posts/decisions`, `channels`, or `mirror_map`. Labels are free strings in `ticket_labels` (init seeds the §4 set; `repo:<name>` on demand) — a registry is added in P3 only if free strings prove insufficient.

---

## 12. MCP tool surface — semantic 1-for-1 with the §18 op-contract

**The contract is: the hub mirrors the §18 operation set in SEMANTICS, so the SKILL bodies run unchanged.** It is **not** a name-for-name copy of the Linear MCP — the agents reason "`save_issue` → the configured backend op" (exactly how the `local` backend already works, §18); they do not pattern-match tool names. Every tool takes a required `project`, honors `mode` server-side, and appends an `events` row attributed to the caller.

| §18 op (how the SKILL thinks of it) | Hub tool | Note |
|---|---|---|
| `list_issues` (project+label+state+type) | `ticket.list({project,state?,type?,labels?,priority?,query?,limit?})` | `query` = FTS (§8); `labels` is a real AND filter |
| `get_issue` | `ticket.get({project,key})` | |
| `save_issue` (create) | `ticket.create({project,type,title,body_md,labels[],priority,repo?,related_to?})` | allocates `<prefix>-<n>` in-txn; auto-adds `dev-loop`; rejects ownerless/typeless ticket |
| `save_issue` (update) | `ticket.update({project,key,…,labels?,state?})` | **labels REPLACE-style (MIMIC §10#1)**; state enum-validated; **verify-after-write mimicked** |
| claim (§7) | `ticket.claim({project,key,run_token})` | atomic CAS (§7); `claimed:false` ⇒ lost race |
| orphan reclaim (§18/§19) | `ticket.reclaim({project,key,prev_assignee,run_token})` | the AGENT runs the git no-artifact check first; the server cannot |
| `save_comment` / `list_comments` | `ticket.comment.add` / `ticket.comment.list` | author attributed |
| relate / duplicate | `ticket.relate` / `ticket.set_duplicate` | `related_to` append-merge |
| `create_issue_label` | `label.ensure` | idempotent; no-op-equivalent for free strings |
| `get/save/list_document` | `doc.get/save/list` | **P4** (repo-file form until then) |
| — | `whoami()` | MVP — proves the identity wiring |

**Additive, hardened primitives are exposed but UNUSED until the §17-gated SKILL rewrite (§21):** `ticket.add_labels` / `ticket.remove_labels` (kill the §10#1 REPLACE footgun), `ticket.transition({to_state,comment})` (enum-safe, no re-fetch), and `events.list(...)` (the attribution feed Reflect/Director read). Shipping them additively while the MVP still honors the old REPLACE/verify-after-write shape is what lets us claim "zero SKILL rewrite" **and** "a clean path to remove the footguns later" without contradiction.

`channel.send/poll/status/register/ack` (P6, SHIPPED) build the §9 §16-safe allow-listed message **server-side** (notify: {project, ticket id, bail-shape}; digest: counts + bounded ids; reply: bounded text) and post via an env-referenced secret — the webhook/token **never** crosses the MCP boundary. `channel.poll` adds the inbound half: an outbound history read since the hub cursor (the no-daemon two-way READ).

---

## 13. The §18 backend dial — `service` joins `linear | local`

§18 already abstracts "every ticket operation maps to one backend, defined once." The hub is the **third value**:

```jsonc
"backend": "service",                 // "linear" (default, absent ⇒ this) | "local" | "service"
"hub": {                              // required only when backend:"service"
  "transport": "stdio",               // stdio throughout (P2–P6 are all daemon-free); "http" only if a PUSH-webhook channel is ever added
  "project": "monpick",
  "actorEnv": "DEVLOOP_ACTOR"         // the launcher-set env var (NO token literal — §16)
}
```

`backend` absent ⇒ `"linear"`, so **every existing project is byte-for-byte unchanged**; `"local"` still works. §18 gains a third operation-mapping column (the table in §12) so each agent's single §0 line — "all ticket operations go through the configured backend (§18)" — is the **only** thing that resolves differently. The agent SKILL bodies are untouched (§21).

---

## 14. Documents, discussion, Director — deferred, schema-shaped now (P4/P5)

These are **not** MVP. LK5 is reinterpreted as "shape the schema so they can attach cleanly," not "build them into core."

- **Versioned docs (P4).** `documents` + append-only `document_versions` with optimistic concurrency (`base_version != current` ⇒ `CONFLICT`, enforced server-side — as shipped, for **every** doc `kind`, not just the `{strategy, roadmap}` scope originally proposed here — so concurrent PM/Director edits can't silently lose updates). The §20 doc-base (Vision/Goals/Non-goals/Current state/Personas/Glossary/Decisions/Candidate-ideas) and the roadmap live here with `doc.history` / `doc.diff`. **Publication is operator-only (§9):** a doc carries `status ∈ {draft, current}`; agents (incl. the Director) may write **draft** versions, but only the operator flips `draft→current` via the CLI — this encodes LK8's "sign off before build" as a **persistent doc-state**, not a one-time event.
- **Discussion (P5 — SHIPPED v0.16.0, conventions §25).** `topics` / `posts` (per-project,
  attributable, per-round) — the **decision is INLINE** on the topic (`topics.decision` + `closed_at`,
  a 1:1 terminal conclusion), **not** a separate `decisions` table. "Topics addressed to me,
  unanswered this round" is a server-side query (`topic.list` returns each topic's `pending` +
  `youArePending`). A closed decision is a **recorded conclusion (data)**, never an applied
  direction change (§17).
- **Director (P5 — SHIPPED v0.16.0).** The repurposed Signal agent as a human-facing coordinator,
  running as a **loop agent (no daemon)**: it chairs the board, opens topics, drafts the
  kind:"roadmap" doc (operator publishes — the P4 gate), and reports. It is **not** a blocking
  second coordination plane — execution still flows through tickets independent of the Director
  (LK7); a missed board round is fine (the round budget guarantees termination).

---

## 15. The Linear mirror — SHIPPED v0.18.0 (one-way, split-brain enforced) (P7)

Built in P7 (`hub/src/linear.ts` + the `mirror.push`/`mirror.status` tools; **Sweep Job 5**
runs the push, daemon-free). **One-way (hub→Linear), opt-in (a `mirror` config), default-off,
human-visibility only — never disaster recovery.**

- **What syncs (SHIPPED):** per ticket — the title (+ a `[hub:<id>]` marker), a body carrying the
  split-brain banner + the hub fields (id/type/state/priority/owner-handle/labels/related/duplicate)
  + the ticket description, and the **state via a config `stateMap`** (hub State → workspace-specific
  Linear state id; a missing entry ⇒ no `stateId`, state stays in the body — the push never fails).
  Idempotent + **incremental** (an unchanged ticket is skipped by a HUB-derived content hash).
  **DEFERRED:** comment sync, and a `localOnly` per-author carve-out (`signal`/`ops`/`dev`) — for
  now the §23 rule that ticket bodies are already §16-safe (no secrets/PII) carries the
  audience-widening; the mirror inherits exactly that concern.
- **Anti-second-SoR (ENFORCED by construction):** the hub **never** reads Linear state as truth —
  there is **no** `mirror.pull`/import/sync-from-Linear tool, and the content hash is HUB-derived,
  so a human edit on Linear is overwritten on the next push; a pinned banner says "Mirrored — edits
  IGNORED and overwritten; give direction via the Director." The hub reads Linear ONLY to reconcile
  its own `mirror_map` id (the `[hub:id]` marker), never to import state.
- **Crash-safe idempotency:** `mirror_map` is written **before** the remote create (`linear_id`
  NULL = create pending); a NULL-id retry **reconciles by the title marker** before creating, so a
  crash between `issueCreate` and recording the mapping never orphans or double-creates. A failed
  push leaves the row un-advanced and retries next fire.
- **§16 / honest limit:** the Linear API key is an env-var **NAME** in config, read server-side,
  never returned/logged/persisted; every call has a hard ~10s timeout. One Linear token ⇒ Linear
  re-collapses to one identity (attribution is hub-only) — the owner-handle in the mirrored body is
  a cosmetic restore. A hub Canceled/Duplicate mirrors as a state change, **never** a hard-delete.
- **Split-brain (PARTIAL):** one-way is enforced *in the tool surface* (no read-as-truth path) +
  the banner. **DEFERRED:** the launcher/`doctor` dual-backend refusal (refuse to arm a `linear`-backed
  fire for a `live` hub project; flag a project configured for both) — re-openable if a project ever
  runs both backends at once.

---

## 16. The §17 self-evolution firewall under the hub — preserved verbatim

**The hub adds NO mechanical enforcement over §17, and we do not pretend it does.** SKILL/conventions files live on disk; agents keep `Bash`/`Edit` access; §17 remains a prompt-gated honor system backed by **operator git review**. The hub keeps it **exactly as strong as today — preserved, not strengthened**:

- **No hub tool ever writes a SKILL / conventions / plugin file.** Document `kind` is constrained to `{strategy, roadmap, decisions, notes, design}` (`design` added by the schema-v3 migration — multi-instance, one per module slug) — none can name a SKILL or `conventions.md`. A §17 change is still a Reflect-drafted `[reflect-proposal]` ticket (`Improvement`+`pm`, `blocked`+`needs-pm`+`Bail-shape: external-prereq`), out of Dev's pick set, **applied by the operator as a git commit** (§17 verbatim).
- **Direction is operator-published, not agent-applied.** The Director may draft a roadmap version; only the operator flips `draft→current` (§14, §9). `decision_record` is a proposal.
- **Inbound and inline content is DATA, never authorization (§4, extending §22/§23).** A chat message id alone, or an `operator`-attributed post, cannot authorize a self-modify/irreversible action — that requires the operator's out-of-band path carrying the §23 second factor (an opaque token). Because the hub's storage is forgeable (§4), the authorization-of-record for anything unforgeable **stays outside the hub** (the git commit; the §23-guarded review channel).
- **§17 surface-map for the hub world:** conventions/SKILLs on disk = untouched, git-reviewed; `strategy`/`roadmap`/`decisions` docs = human-gated publication like `strategyDoc` today; `lessons.md` = Reflect-only + the §22 operator-review carve-out, unchanged and still machine-local.

---

## 17. Security & secrets (§16)

- **No secret is stored in the hub.** `settings_json`/channel config hold an **env-var NAME** (`config_ref`), never a URL/token/key. If tokens are added later, the hub stores only `sha256(token)`+prefix; the raw token lives in the launcher's env file/keychain (§8). Comments/doc/event bodies are §16-scrubbed.
- **`.gitignore` + a doctor check.** `hub.db`, `hub.db-wal`, `hub.db-shm`, `backups/`, `hub.log`, and any token material are git-ignored; `dev-loop-hub doctor` asserts none are tracked and the data home resolves **outside** any repo (the data home is machine-local, never committed/synced — same rule as `lessons.md`/`*-state.json`, §11).
- **Backups inherit the secrecy discipline.** `chmod 600`, never committed, never networked; `doctor` checks `backups/` is ignored and local-only.
- **At-rest blast radius — an explicit operator decision.** The hub concentrates all projects' tickets/docs + (later) the mirror token + channel creds into one file plus rolling backups — a bigger blast radius than a single Linear token. The operator chooses one of: (a) accept it (documented, single trusted machine), or (b) encrypt at rest (e.g. SQLCipher for `hub.db` + backups). MVP default is (a) with the blast radius documented; (b) is a config option.
- **PII (§16) binds everything the mirror or a channel emits** — the only surfaces that leave the machine — at full §23 parity (§15).

---

## 18. Durability, backup & restore — the SoR regression, owned

**This is a genuine regression the operator signs for.** Today the SoR is Linear's durable, backed-up, multi-device cloud; the hub moves it to **one local SQLite file** — a disk/laptop loss wipes all coordination state.

- **RPO decision (operator-signed):** "a disk loss can lose up to N hours of loop state" — N is set by the backup cadence below. The MVP does **not** run a live loop with **zero** off-machine copy unless the operator explicitly accepts that RPO.
- **Backups:** daily `VACUUM INTO backups/hub-<iso>.db` (WAL-safe online snapshot) + on clean stop; retain the last 14. For an off-machine copy, the **recommended DR** is copying a snapshot off-box on a cadence (the operator's existing backup tooling) — **not** the lossy one-way mirror (§15), which is human-visibility only.
- **Restore runbook:** stop all panes → copy the chosen `backups/hub-<iso>.db` over `hub.db` (and delete stale `-wal`/`-shm`) → `dev-loop-hub doctor` (DB-writable, schema-version match) → relaunch. Documented as a real procedure, tested in P2.
- **Migrations can corrupt the SoR** — schema changes ship with a version stamp, a forward migration, and a pre-migration auto-backup; `doctor` refuses to start on a version mismatch.

---

## 19. CLI portability — Claude Code first; the shared-brain / wrapper split

**v1 targets Claude Code ONLY.** Proving the core value (the loop on the hub with attribution) needs exactly one CLI.

- **SHARED brain (one copy, CLI-agnostic):** `conventions.md`, the 8 agent-prompt bodies, the hub MCP op-contract, the config schema + doc-base.
- **PER-CLI (thin wrapper, generated):** only (a) how the CLI registers the hub MCP server, and (b) how it exposes the prompts as commands/skills (frontmatter differs, body verbatim).

Status of each target (web-verified; the blocker is flagged):
- **Claude Code [HOST, v1]** — stdio shim via `.mcp.json`; prompts = the existing plugin skills; headless `claude -p`. **Identity rides env, not an HTTP header, specifically because headless `claude -p` drops the Authorization header on tool calls (#50464/#48514/#39271)** — this is the load-bearing reason for the stdio+env design (§6).
- **Codex CLI [HOST, P8]** — HTTP MCP (`type="http"`, `bearer_token_env_var`/`http_headers`); `codex exec`; skills under `.agents/skills/`. On firmer header ground than Claude Code, but still gated by the test below.
- **opencode [HOST, P8]** — remote MCP with `headers`; `opencode run`; commands/agents/skills files.
- **zcode (Z.AI) [CONSUMER ONLY — scoped OUT]** — MCP-capable but a **GUI ADE with no documented headless run mode and no file-based command packaging**. It can consume the hub interactively; it **cannot** be a scheduled-fire loop host. Not targeted. (If Z.AI later ships a headless CLI, revisit.)

**The P8 gate (SHIPPED v0.19.0):** before any CLI is declared a host, a **per-CLI headless test asserts the per-agent identity lands on a TOOL CALL** (not merely on `mcp list`/connect) under that CLI's headless mode (`claude -p` / `codex exec` / `opencode run`). The probe is the hub's **`whoami`** tool (it echoes the resolved `actor`): set `DEVLOOP_ACTOR=dev`, call `whoami` through the CLI, expect `dev` — `operator`/anything-else ⇒ FAIL, do not onboard (fail closed). `dev-loop-hub identity-check` is the launcher-side sanity check; the full procedure + per-CLI config templates are in **`docs/PORTABILITY.md`** (conventions §26). A CLI/version exhibiting the header-drop class of bug is **unsupported for the header path** and must use the stdio shim (which the whole hub design already mandates).

---

## 20. Migration — monpick (idempotent, reversible, atomic-per-project)

monpick today: `backend` absent (⇒ linear), `linearProject:MonPick`, a Linear-document strategy doc, `mode:live`, `autonomy:full`, a Lark `notify` webhook, machine-local `*-state.json`/`lessons.md`/reports.

**Migration is non-destructive, idempotent (keyed on `external_id`), and resumable. Linear is never deleted; rollback = flip `backend` back.**

1. (P2+) Start the hub; create the isolated `monpick` project; register actors pm/qa/dev/sweep/reflect/ops/architect + operator; the launcher exports per-pane `DEVLOOP_ACTOR`.
2. `dev-loop-hub import linear --project monpick --team Citronetic --linear-project MonPick` (read-only on Linear, resumable): tickets + comments + relations → hub, preserving state/labels/priority/title/body/timestamps. **History attribution is honestly lossy:** pre-hub Linear comments were one shared identity → most import under a `linear-import` pseudo-actor; only comments carrying a `— <agent> (run …)` prefix recover an author. Go-forward history is fully attributable; imported history is not — do not oversell "no history lost" as "full provenance recovered."
3. Apply the config diff (`backend:"service"` + the `hub` block; `linearProject` retained only as a future mirror target; `notify` is the one-way operator ping; `strategyDoc`→a P4 hub roadmap doc the operator publishes).
4. **Cutover is atomic per project, and ENFORCED (§15):** the launcher refuses to arm both a `linear`-backed and a `service`-backed fire for monpick; `doctor` flags a dual-backend config. Never run two backends for one project concurrently.
5. Verify: one PM fire + one Dev fire on the hub — confirm `whoami` attribution, the §3 state machine, the atomic claim, and that Reflect/reports actually consume the author field. Resume the loop. Linear remains a read-only archive; nothing deleted.

`*-state.json`, `lessons.md`, and reports stay **machine-local and forward-only** (no backfill — mirrors §23).

---

## 21. How the existing agents & conventions change — the contract

**For the MVP (P2): almost nothing.** This is the whole point of mimicking the op-contract (§12).

- **SKILL bodies: unchanged.** Each agent's single §0 line — "all ticket operations go through the configured backend (§18)" — now resolves to the hub. The bodies still say `save_issue`, still re-pass the full REPLACE-style label set, still verify-after-write; the hub honors all of that.
- **conventions.md: one additive edit.** §18 gains the `service` value and the third operation-mapping column (§12/§13). §11 config gains the optional `hub` block. No existing rule changes meaning. (Applied by the operator under §17 — a human git commit, like any conventions change.)
- **The launcher: a small, real change.** `dev-loop run` exports `DEVLOOP_ACTOR`/`DEVLOOP_PROJECT` per fire and injects the hub MCP; an external launcher must do the same before each fire. This is operator-owned runtime wiring, not Claude plugin state.

**The footgun-removal SKILL rewrite is a SEPARATE, explicit, operator-driven, §17-gated phase with its own effort line — never an MVP byproduct.** Realizing the atomic-claim / add-remove-labels / enum-state benefits requires editing the bodies of the agent SKILLs (e.g. dev-agent's "re-fetch; if it's not yours, another Dev won" and "re-pass the full label set"). §17 forbids agents from rewriting their own SKILLs; only the operator may, in a coordinated, human-reviewed pass. Until that pass lands, the hardened primitives ship but sit unused, and the loop runs on the mimicked Linear-shaped contract. Presenting "footguns designed out" as a free win is the contradiction this section resolves.

---

## 22. Effort, steady-state maintenance, and the kill/continue gate

**Build effort (one operator + Claude Code, part-time; engineering-days/weeks):**

| Phase | Effort | Riskiest assumption it tests |
|---|---|---|
| P0 spike | 2–3 d | The Linear-shaped agent SKILLs run on a non-Linear backend with ~zero rewrite; better-sqlite3 builds; the claim race is correct |
| P1 file-board author field | 2–5 d | A structured author field is enough of the "identity" win to matter |
| P2 SQLite hub MVP | 2–3 w | The hub mimics the op-contract closely enough; native-dep build is stable |
| P3 isolation | 3–5 d | Project scope binds to the connection/shim, not an agent-passed arg |
| P4 versioned docs | ~1 w | Docs-as-rows beats a git-tracked markdown file enough to justify the build |
| P5 discussion board + Director (NO daemon — loop-agent) | ~1 w | Is multi-agent discussion signal not noise; topic termination |
| P6 channel (two-way, POLL-based, NO daemon) | ~1 w | Poll latency = fire cadence (a direction plane, not real-time chat); a push webhook would need a tunnel — deferred |
| P7 Linear mirror (one-way, Sweep push, NO daemon) | ~1 w | A lossy one-way mirror is useful, not confusing; split-brain stays enforced |
| P8 2nd CLI | 3–5 d / CLI | Per-CLI identity-on-tool-call parity (the headless test) |
| (parallel) footgun SKILL rewrite | 3–5 d | Coordinated, human-reviewed §17 pass over agent SKILLs |

Full P0–P8 ≈ **3–4 months part-time**.

**Steady-state maintenance (a first-class cost, not a footnote).** The build is not the expensive part. Today the loop is markdown prompts + someone else's MCP: zero build, zero deps, zero process, zero CVE surface, git-diffable. Past P2 the operator owns **a TypeScript service** (though P0's discovery of built-in `node:sqlite` + `.ts` type-stripping **eliminated the originally-feared native dependency AND the build step** — no `better-sqlite3`, no node-gyp/prebuild pain, no lockfile-of-natives), plus **schema migrations that can corrupt the SoR** (and, only if a PUSH-webhook channel is ever added, **a daemon to keep alive** — crash recovery, restart-on-boot, stale locks; through **P6 there is no daemon** — the channel is poll-based). The operator signed up for prompts and now runs a small database product. Mitigations: pin Node (≥23.6 for type-stripping), migration tests, keep the surface tiny — but the cost is permanent.

**The kill/continue gate (after P2 — the operator signs).** Continue to P3+ **only if all three hold:**
1. the loop demonstrably runs **at least as well** on the hub as on the file board (no regression in throughput, claim correctness, or dedupe quality);
2. the attribution is **actually consumed** — Reflect/reports read the author field and it changes an output (otherwise it is decoration);
3. the operator **accepts the measured steady-state maintenance cost** above.

If any fails, the honest outcome is to **stop at P1** (the hardened file board) and not carry a half-built database product. Every phase past P2 is gated on this sign-off, not assumed.

---

## Appendix A — How this supersedes the four facets (quick diff for reviewers)

- **Transport:** facets shipped two contradictory answers; resolved to stdio+env for MVP, daemon at P5 (§6). Ports unified to one (4319).
- **Identity:** "the token IS the identity / cannot impersonate" → honest cooperative attribution; tokens deferred and, if ever added, hash-only + project-pinned-by-default (§4, §8).
- **Tool surface:** "1:1 name+shape" dropped; replaced by "semantic 1-for-1 with §18, mimic the footguns" (§12). Footgun removal is a separate §17-gated phase (§21).
- **Scope:** the 16-table daemon "core" → a 6-table no-daemon MVP; Director/board/channel/mirror/tokens/multi-CLI all cut to gated phases (§5, §11).
- **Riskiest assumption:** SQLite concurrency → SKILL portability, spiked against the existing file board for zero build cost (P0).
- **Alternative:** the §18 file board is steelmanned as the cheap path and the measured-trigger fallback (§2), with a hard kill/continue gate (§22).

---

## Appendix B — Open questions for the operator (sign-off items)

1. **Durability RPO:** what off-machine backup cadence is acceptable, and do you want at-rest encryption (SQLCipher) given the concentrated blast radius (§17, §18)?
2. **The P1 off-ramp:** if the hardened file board (P1) satisfies the need, are you willing to stop there rather than build the SQLite service (§2, §22)?
3. **Mirror:** human-visibility mirror at all, given it re-collapses attribution on the Linear side and invites edit-and-lose confusion (§15)?
4. **Token model:** is per-agent attribution-via-env sufficient forever (single trusted host), or is a real multi-actor/remote need foreseeable that would justify tokens (§8)?
