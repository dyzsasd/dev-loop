# Backend — Linear or the hub service — conventions §18 pointer file

> Moved out of `references/conventions.md` §18 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §18's contract: read it at the trigger moment the §18 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

Everything above describes the loop coordinating through **Linear** (the MCP, the
state machine §3, labels §4, claim §7, dedupe §8, blocked §9, querying §10). That
substrate is one **backend**. The loop can equally coordinate through the **hub service**
(an MCP system of record — see
`docs/HUB-ARCHITECTURE.md`) — with the *same* state machine, label semantics, and
protocols; only the storage primitive changes. This section is the **single
abstraction point**: every "ticket operation" each skill performs maps to one of these
backends, defined once here. Each SKILL's BOOT carries just one line — "all ticket
operations go through the configured backend (§18)" — instead of re-stating every job
in backend terms.

**Default is `linear`.** `backend` absent ⇒ `"linear"`; `service` is strictly opt-in via per-project config
(§11) and bootstrapped by `dev-loop team init` + `/dev-loop:add-project`. Every rule elsewhere in this document is
backend-agnostic — this section is the only place they diverge.

### Backend parity — the work plane, the surface plane, and switching

The **work plane is identical** across `linear`/`service` (states, transitions,
pick/claim/dedupe/blocked, labels, reports); the **surface plane deliberately diverges**
(per-agent identity / web UI / versioned docs are `service`-only; the Linear app is
`linear`-only). Choosing a backend and switching one
later (a data migration, not a config edit) are operator decisions —
`docs/ARCHITECTURE.md` §Backends carries the comparison; agents never choose or switch.
The one cross-backend notification floor: the §9 one-way operator webhook.

**`park-for-operator(ticket, bail-shape)` — one abstract op, realized per backend.** Parking a
ticket for a human-only block is **real-state-if-present-else-label**: on `service` it is the real
**`Human-Blocked` state** (daemon-reminded); on `linear` it is the `blocked`+`needs-pm`
label park **unless** the operator added a real Blocked column and set `blockedStateName` (then a
real state). The
**abstract behavior is invariant** ("the ticket leaves Dev's pick set until the human resolves it,
then resumes to `Todo`"); only the mechanism + the reminder differ.

### Per-backend implementation detail (pay-per-use)
Resolve `backend` at boot (§0a step 2), then read the matching reference **before your first
board operation of the fire**:
- `service` ⇒ **`references/backend-service.md`** — the agent contract: ops + cheat-sheet
  invocation surface, exit codes, identity/attribution, project scope, write semantics,
  hub docs + the `design` doc-kind.
- `linear` ⇒ no extra file: the Linear MCP is the native substrate described throughout this
  document (§3/§4/§7/§8/§9/§10 apply as written).

### Per-backend dev-tier encoding (a cross-backend contract — resident)
**Per-backend dev-tier encoding (split-dev projects only, §21b).** A two-tier project must encode
*which dev* owns a ticket's implementation so each dev's pick-query selects only its own slice (§5).
The carrier differs by backend because Linear is one shared identity:
- **`service`** — the ticket's **`assignee`** field is the actor `senior-dev` / `junior-dev` (real
  per-agent identity). PM files the ticket with `assignee` pre-set to the tier; when that dev claims
  it (`assignee:"me"`, §7) it claims its own pre-assignment — no conflict. The §4 `pm`/`qa` owner
  label still names the **verifier** (orthogonal). Each dev's pick filter is `assignee = <its actor>`.
- **`linear`** — a **`senior-dev` / `junior-dev` label** in the ticket's label set (the shared Linear
  identity means `assignee` can't distinguish the tier; the label does). Each dev scopes its pick
  query by its own label + `project` (REPLACE-style full-set discipline on every write, §10 #1).

The §4 `senior-dev`/`junior-dev` labels are provisioned on **all** backends for one code path
(harmless extras on `service`, the routing carrier on `linear`). A **legacy single-dev
project carries no dev-tier encoding** — the sole `dev` agent picks the whole queue, unchanged.
