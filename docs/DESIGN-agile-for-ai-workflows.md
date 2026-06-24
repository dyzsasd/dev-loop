# Agile, Adapted for AI Agents — Target-State Design

**Status:** PROPOSAL. Every change in this document is STRUCTURAL hub/SKILL code and is applied by the OPERATOR via git (§17). No loop agent edits `hub/src/*` or the SKILLs/conventions directly. The mechanism for that is the `[agent-proposal]` ticket (filed `blocked` + `needs-pm` + `external-prereq`), exactly as the existing `topic.close`/`doc.publish` doctrine treats a decision as DATA, never auto-applied.

**Hard back-compat invariant (non-negotiable):** a project whose `projects.settings_json` is the default `'{}'` behaves byte-for-byte as today. Every feature here is keyed off an OPT-IN block inside `settings_json`; absent the block, the new code paths never run. The whole loop on Linear/local/service with zero workflow config keeps running unchanged (§18).

---

## 1. The model — "agile, adapted for AI agents"

Agile tooling layers a per-project **state machine** (columns + transition rules + conditions) over a free-form board, and tracks **two orthogonal axes** on each card: who is *accountable* (component/team) and who is *acting now* (current task owner on the sprint board). Today's hub is the free-form board: `save_issue` only checks that `state` is a legal enum member (server.ts:174) — nothing checks the from→to edge, who is making it, or under what conditions.

This design adds the agile layer as **declarative DATA in `projects.settings_json`**, enforced at the one write choke point (`save_issue`), with five composing subsystems:

| Axis | Mechanism | Today | Added |
|---|---|---|---|
| Work-state | `tickets.state` (CHECKed enum) | 7 states, any→any | per-project allowed-transition graph |
| Who acts NEXT | `tickets.assignee` (free-text actor) | detail-only | swimlanes + `issue.assign` events |
| Who VERIFIES | `pm`/`qa` owner label | rendered as Owner | unchanged (kept orthogonal) |
| Impediment | `blocked` / `human-blocked` labels | one `blocked` label | two-tier lane + Blocked badge |
| Release | `env:dev` / `env:prod` labels | none | deploy gate + prod-promotion gate |

The keystone is the **workflow-config engine** (§3 below). The other four subsystems are vocabulary + rendering + guards that plug into it. A genuine fork exists between modeling "blocked" / "deployed-to" as a real CHECKed STATE (free cycle-time metrics) vs. an orthogonal LABEL (zero migration). We choose LABEL everywhere because the schema has **no ALTER mechanism** (db.ts:33 is `CREATE TABLE IF NOT EXISTS`; a CHECK change forces a table rebuild) AND because a real Blocked state collides with the §3 rule that verify-fail and unblock both resume at `Todo`. Metrics parity is recovered by emitting events (`issue.assign`, `ticket.blocked`/`unblocked`, `issue.promote`) replayed exactly like `/activity` already replays `issue.transition` (daemon.ts:466-508).

---

## 2. Shared foundation (built first, depended on by all)

Three small, dependency-free pieces that every subsystem reuses, so the two write surfaces (MCP `server.ts` and daemon `daemon.ts`) provably cannot drift:

### 2.1 `hub/src/workflow.ts` (new shared module)
Side-effect-free, mirrors `docstore.ts`. Exports:
- `readSettings(db, projectId): Settings` — `JSON.parse(settings_json)`; returns `{}` on empty/malformed (fail-open), like `eventData()` (daemon.ts:434).
- `loadWorkflow(settings): WorkflowConfig | null` — validates and returns the workflow block, or `null` (engine OFF) on absence/malformation. Validation: `states ⊆ STATES` (db.ts:29); unknown gate refs → reject (fail-open). **Caches nothing globally** — each process (MCP server, daemon) calls it.
- `checkTransition(cfg, {from, to, role, labels}): {ok:true} | {ok:false, error}` — pure validator (see §3).
- `roleOf(handle): string` — returns the handle for the 8 agent actors; returns `"operator"` for `actors.kind='human'`. **There is exactly one human actor (`operator`); `roleOf` never invents a generic `human` role** — guards use the literal `operator`. This corrects the role-model overstatement: external humans act through the daemon as `DEVLOOP_ACTOR=operator` (daemon.ts:658).

### 2.2 Extract shared validators out of `server.ts` into `workflow.ts`
`resolveAssignee` (server.ts:119-123) and the ticket-create/comment INSERT + `logEvent` mechanics are currently inline closures bound to `server.ts` module scope; the daemon cannot reuse them. Extract:
- `resolveAssignee(actor, a)` — `me→actor`, empty/whitespace→null, else passthrough (DL-6 parity).
- `applyTicketWrite(db, projectId, actor, args)` — the create/update read-merge-write incl. `nextTicketId` (db.ts:225, RETURNING-based, race-safe), `BEGIN IMMEDIATE`, the transition/update/assign event logging, and the new gate calls. `server.ts`'s `save_issue` and the daemon's human-write route BOTH call this — single implementation, no drift.

### 2.3 `get_project` exposes `settings_json`
`get_project` (server.ts:253) currently SELECTs only `id,key,name,ticket_prefix,mode,autonomy`. The PM intake job (W3) needs to read `intakeOwner` over MCP, so add `settings_json` to that SELECT. This is the ONE acknowledged `server.ts` read-surface addition; it is additive (a new field; no existing field changes).

---

## 3. Subsystem A — Workflow-config engine (THE KEYSTONE)

### Config shape (`projects.settings_json.workflow`)
```json
{
  "workflow": {
    "version": 1,
    "states": ["Backlog","Todo","In Progress","In Review","Done","Canceled","Duplicate"],
    "transitions": [
      { "from": "Todo",        "to": "In Progress", "roles": ["dev"] },
      { "from": "In Progress", "to": "In Review",   "roles": ["dev"], "requireGate": "staging-deploy" },
      { "from": "In Progress", "to": "Todo",        "roles": ["dev","sweep"] },
      { "from": "In Review",   "to": "Done",        "roles": ["pm","qa"], "requireLabelsAbsent": ["blocked","human-blocked"] },
      { "from": "In Review",   "to": "Todo",        "roles": ["pm","qa","dev"] },
      { "from": "*",           "to": "Canceled",    "roles": ["pm","qa","director","operator"] },
      { "from": "*",           "to": "Duplicate",   "roles": ["pm","qa","dev","sweep"] }
    ],
    "gates": { "staging-deploy": { "requireLabelsPresent": ["env:dev"] } }
  }
}
```

### Enforcement (server.ts ~L204, inside `applyTicketWrite`)
Runs ONLY when `WORKFLOW` is loaded **and** `next.state !== cur.state` (a real transition). Sits inside the existing `BEGIN IMMEDIATE` (server.ts:190) so a reject `ROLLBACK`s nothing-yet-written, returning `err()` exactly like the state/assignee validators (server.ts:174-175). `checkTransition` semantics:
1. Collect ALL transitions where `(from===cur.state || from==="*") && to===next.state`.
2. **Wildcard precedence = UNION of matches** (most-permissive). If no transition matches → reject (whitelist).
3. Role allowed if `role ∈ union(roles)` or `"*"`. Labels judged against the **post-write** set (`next.labels`): `requireLabelsPresent ⊆ labels`, `requireLabelsAbsent ∩ labels === ∅`, plus any named gate's bundles.

### Resolved verdict fixes (folded in)
- **Self-loop contradiction (FIXED):** enforcement guards on `next.state !== cur.state`, so same-state edits (label/priority/description) are ALWAYS ungated. The misleading `Todo→Todo` transition and `selfLoopAlwaysAllowed` flag are DELETED from the config surface. W2's "PM re-arms Dev" is a label edit at the same state (drop `blocked`) — never a gated self-loop.
- **Adopt-on-existing-project (FIXED):** because whitelist semantics DENY any unlisted edge, the operator MUST enumerate every edge running agents perform before flipping the engine on: Sweep's `In Progress→Todo` reset, verify-fail `In Review→Todo`, blocked re-routes, `*→Canceled`/`Duplicate`. Ship an **adopt-time validator** (`workflow.ts: auditCoverage(db, projectId, cfg)`) that lists edges observed in the last-N `issue.transition` events and warns on any not covered by `transitions`. Leniency on non-listed STATES is insufficient — it covers EDGES.
- **Label-guard staleness (DOCUMENTED):** guards see `next.labels`, which equals `cur.labels` when the caller OMITS `labels` (REPLACE-style, server.ts:199). A label-gated transition therefore REQUIRES the caller to re-pass labels. Documented in the SKILLs; the convention is that the move and the label set ship in one `save_issue`.
- **Config is OPERATOR-WRITE-ONLY (DECIDED, not deferred):** NO MCP tool and NO daemon route writes the `workflow` key. It is set only via seed/CLI/operator-git. This is a hard constraint so no agent — nor the W3 human-write POST (author is an unverified §16 id) — can rewrite its own permission gate.
- **Fail-open:** malformed/invalid config → logged + treated as ABSENT, never bricks the loop. CHECK(state) stays the hard outer floor.

---

## 4. Subsystem B — Assignment & swimlanes

`assignee` = who-acts-NEXT (routing pointer, drives swimlanes + handoffs); `pm`/`qa` owner-label = who-VERIFIES (unchanged). Two orthogonal axes, never collapsed. Reassign already works via `save_issue({assignee})` (server.ts:197: undefined=no-op, value=set, null=clear); validation already accepts known actors + `me`/null (server.ts:175). So W1 assign-to-Dev, reassign-to-PM, W2 assign-operator all work TODAY with zero hub change.

### Changes
- **`issue.assign` event (server.ts:207-210):** today an assignee-only change falls into the `issue.update` else-branch. Emit `issue.assign {from,to}` whenever `next.assignee !== cur.assignee`, IN ADDITION to the transition/update event, so `/activity` and cycle metrics see handoffs. `events.kind` is free text (db.ts:91); `activityPage`'s switch has a default branch (daemon.ts:458) — add an explicit case for a clean line.
- **Board `?group=assignee` (daemon.ts:150):** opt-in swimlanes — one `<section class="lane">` per distinct assignee (`unassigned` last), each containing the existing state columns (reuse the column-builder at daemon.ts:179-183). Absent/`group=state` → byte-identical single board. Add a toggle link in the deep-linkable controls (daemon.ts:160-171).
- **Card assignee chip (daemon.ts:134-140) — OPT-IN GATE (hard requirement):** render the chip ONLY when `group==='assignee'` OR `settings_json.assignment.defaultBoardGroupBy` is set, so default board markup stays byte-identical for byte-comparison back-compat tests.

### Resolved verdict fixes (folded in)
- **Run-token premise STRUCK:** on backend:`service` the §7 claim is `assignee='me'` → bare handle `dev` (server.ts:121); `actorExists` (server.ts:175) rejects `dev (run a1b2)` as an unknown assignee. The `dev (run <id>)` token is LOCAL-mode-only (a COMMENT author, not a hub assignee). All claims that it is "storable as free text" and the W1 step `assignee:"dev (run <id>)"` are removed. The `assigneeBase()` `split(' (run ')` normalization is DROPPED (guaranteed no-op on every real hub value); grouping is on the raw handle.
- **`/api/tickets` assignee filter (daemon.ts:592-599):** add `const assignee = url.searchParams.get("assignee"); if (assignee) out = out.filter(t => t.assignee === assignee);` — pure narrowing, mirrors the HTML board (daemon.ts:157) + MCP `list_issues` (server.ts:144). Documented: the read API matches the LITERAL handle (no `me` expansion — the daemon read conn has no actor identity).

---

## 5. Subsystem C — Blocked / human-blocked lane

Blocking stays ORTHOGONAL (a flag on a card that keeps its work-state), split into two tiers: `blocked` (agent-resolvable, §9 default) and `human-blocked` (needs operator). No new STATE → no table rebuild → no collision with the resume-at-`Todo` rule.

### Changes
- **Seed `human-blocked` label** (`{name:"human-blocked", kind:"workflow"}`) alongside `blocked` (seed.ts:20).
- **`ensureLabels(db, projectId)` backfill (REQUIRED FIX):** `ensureProject` returns early `if (existing) return existing.id` (seed.ts:40), so the LABELS loop (seed.ts:49-50) NEVER runs for an existing project — the live `dev-loop` project would never acquire `human-blocked`. Add an idempotent `ensureLabels` (INSERT OR IGNORE over the full taxonomy for the resolved project) called unconditionally inside `ensureSeed`, and run it for existing projects. `migrationNeeded` is therefore "one additive seed/backfill code change," not NONE. (Gating matches on label NAME not taxonomy rows, so a missing taxonomy entry never breaks gating — but the stated "just re-seed" mechanism does not work.)
- **`ticket.blocked` / `ticket.unblocked` events (server.ts:207-210):** on the label-delta (`next` vs `cur` parsed sets), emit `ticket.blocked {lane:"agent"|"human"}` / `ticket.unblocked`. This is the metrics bridge — blocked-duration replays from `events` like cycle time (daemon.ts:474-494). No new validation rejects anything.
- **Mutual exclusivity normalize step:** in `applyTicketWrite`, a ticket carries `blocked` XOR `human-blocked` (escalation swaps, never both) so the synthetic Blocked board lane groups cleanly without double-counting.
- **Render (daemon.ts):** `lane(labels)` helper near `ownerOf` (daemon.ts:74) → `"human"|"agent"|null`; red `human-blocked` / amber `blocked` chip in `cardHtml` (daemon.ts:134-140, gated like the assignee chip); a synthetic "Blocked" lane in `boardPage` grouping either label (tickets keep `t.state`, so dropping the label snaps them back to their column); a "Blocked" row in `ticketPage` (daemon.ts:209-213). `/?label=human-blocked` already deep-links the operator queue (daemon.ts:156).
- **SKILL/conventions (§17 proposal):** Dev's pick query + §9 blocked-scan treat `human-blocked` as a SUPERSET of `blocked` (exclude both from Dev's pick set; route `human-blocked` only to the operator). Backfill of existing human-parked tickets: natural aging on next PM touch (zero-write on existing rows).
- **Escape hatch documented:** `blockedStateName` stays as the door to the real-state fork; if exercised, the labels-table rebuild MUST use an explicit column list (not `SELECT *`) and run with BOTH the MCP server and daemon STOPPED (WAL + busy_timeout=5000 at db.ts:214 cannot serialize a concurrent DROP TABLE against the daemon's two connections, daemon.ts:646/659).

---

## 6. Subsystem D — Human actor & comms-via-tickets (W3)

An OPT-IN human write surface on the daemon, reusing the DL-19 `writeOriginOk` CSRF/Host guard (daemon.ts:346-355) and the separate `writeDb` (daemon.ts:659), all attributed to `operator`. Ticket COMMENTS are the comms substrate; §9 notify and §25 channel become out-of-band POINTERS to the ticket, never the conversation. A localhost browser POST behind Host+Origin is a STRONGER operator-presence signal than the unverified provider id `channel.poll` ingests.

### Routes (daemon router, above the read-only 405 at daemon.ts:534)
`POST /ticket` (create), `/ticket/:id/comment`, `/ticket/:id/move`, `/ticket/:id/assign`, gated by `canHumanWrite` (from `settings_json.humanWrite.enabled`) AND `writeOriginOk` BEFORE any mutation. All go through the shared `applyTicketWrite` (§2.2) so they re-validate against the SAME rules and emit the SAME events as the MCP surface.

### Config (`settings_json.humanWrite`)
```json
{ "humanWrite": { "enabled": true, "actor": "operator", "allowCreate": true,
                  "allowMove": true, "allowAssign": true, "intakeOwner": "pm" } }
```
Absent → `canHumanWrite=false`, router block never entered, UI renders no forms → byte-identical to DL-3.

### Resolved verdict fixes (folded in)
- **`/move` enforces the §3 workflow-config transition guards (HARD REQUIREMENT, not an open question):** otherwise the human write path is a GATE-BYPASS — a human could POST a transition agents are forbidden to make. `applyTicketWrite` calls `checkTransition` with `role="operator"` (via `roleOf`). Until/unless a project has a workflow config, `/move` still honors the raw STATES CHECK.
- **`scrubChannel` NOT verbatim-ported:** `scrubChannel` (server.ts:565) is tuned for untrusted CHAT and would silently corrupt operator prose (a pasted stacktrace IP, a stakeholder email). The real XSS defense is `esc()` at render (already present, daemon.ts:199/214). Comments/descriptions are stored as operator-authored DATA with at most a gentle, opt-in secret-only scrub. There is deliberately NO command verb-parser on this path (contrast server.ts:549): "move this to Done bypassing review" is stored as TEXT; the only state change is the explicit `/move` POST, itself gate-checked.
- **Settings read path (FIXED):** the PM intake job reads `intakeOwner` via the §2.3 `get_project` `settings_json` addition (the daemon reads `settings_json` directly at bootstrap for its own gate; the SKILL needs the MCP-visible path).
- **Atomic create:** `applyTicketWrite` allocates the id via `nextTicketId` (db.ts:225) inside `BEGIN IMMEDIATE` (mirrors server.ts:177-190) so a concurrent agent write can't interleave.
- **PM intake idempotency:** reuse `needs-pm`, removed once groomed, so PM never re-grooms an already-processed parent across fires.

### W3 flow
Human → "New ticket" → `dev-loop`-labelled Todo, `owner=assignee=intakeOwner`, attributed to `operator` (`issue.create`). This is §2-clean: a dev-loop-labelled ticket BORN inside this project's hub is loop-fair-game; nothing crosses the human-backlog boundary, so the init-adoption carve-out does not even apply. PM intake job (SKILL behavior, not hub code): `list_issues(state=Todo, assignee=pm, label=dev-loop)` → groom into Dev children + doc draft. All discussion via comments. Needs-a-human-decision → park `human-blocked`; §9/§25 ping points back to the ticket.

---

## 7. Subsystem E — Release / environment gating (W1)

"Where a ticket's code currently lives" = a per-ticket `env:dev` / `env:prod` LABEL (NOT a column, NOT a state — no-ALTER), registered under the EXISTING `workflow` label kind (v1 avoids the `labels.kind` CHECK at db.ts:57 entirely). Two opt-in guards in `settings_json.workflow.release`, enforced in `applyTicketWrite`:

```json
{ "workflow": { "release": {
    "environments": ["dev","prod"], "stagingEnv": "dev", "prodEnv": "prod",
    "requireDeployBeforeReview": true, "prodPromotionGate": "human" } } }
```
Companion (skills-side `projects.json`) `testEnv.environments` maps env→baseUrl; absent → fall back to `testEnv.baseUrl` (today's single surface).

- `requireDeployBeforeReview`: `In Progress→In Review` demands the ticket carry the `env:dev` label (Dev's Step-6 ship earns it). Modeled as a named `gate` referenced by the §3 transition (`requireGate:"staging-deploy"`) so it composes with the engine, not a parallel mechanism.
- `prodPromotionGate:"human"`: ADDING `env:prod` (that `cur.labels` lacked) requires `ACTOR === "operator"`.

### Resolved verdict fixes (folded in)
- **Prod gate uses the EXISTING cooperative idiom `ACTOR === "operator"`** (mirror docstore.ts:75 / server.ts:306). There is NO `actorRole()` helper and no human/agent role authorization lookup — the invented "operator/human role" abstraction is dropped. Documented as a COOPERATIVE role-gate, NOT anti-spoof (an agent can set `DEVLOOP_ACTOR=operator`).
- **No-deploy carve-out is MANDATORY (not an open question):** `requireDeployBeforeReview` fires ONLY when the ticket's resolved repo has a `deploy.command` (dev SKILL:294). Otherwise docs-only / no-deploy tickets DEADLOCK (they legitimately never set `env:dev` and could never reach In Review).
- **Promotion-only gating:** only ADDING `env:prod` is gated; DEMOTION (revert `env:prod→env:dev`, dev Step-6.5 rollback) is ALWAYS allowed so a rollback can't trip the gate.
- **Label backfill:** `env:dev`/`env:prod` are NOT auto-seeded into existing projects (same seed.ts:40 early-return) — they ride the §5 `ensureLabels` backfill / `create_issue_label`.
- **`issue.promote` event:** on an `env:*` label-set change, emit `issue.promote {from,to}` for promotion cycle-time (no new state).
- **Two-source drift documented:** `settings_json.workflow.release` (hub gate) and `projects.json testEnv.environments` (skills verify URL) have no sync; the operator-maintained invariant is that `stagingEnv`/`prodEnv` names match the `testEnv.environments` keys.
- **Multi-repo (§19):** v1 assumes a single product-level env (the §19 known limitation); per-repo `env:<repo>:prod` is deferred.

---

## 8. How W1 / W2 / W3 are realized purely as config

The SAME code; the ONLY difference is the `workflow` block the operator sets.

**W1 HAPPY PATH:** `Todo→In Progress {dev}`; `In Progress→In Review {dev, requireGate:"staging-deploy"}` (needs `env:dev`, carve-out for no-deploy repos); `In Review→Done {pm, requireLabelsAbsent:[blocked,human-blocked]}`. Dev sets `env:dev` on the In-Review handoff + reassigns `pm` (`issue.assign`). PM verifies the DEPLOYED feature at `testEnv.environments[env]` and closes. Prod: `prodPromotionGate:"human"` → operator flips `env:prod`.

**W2 ESCALATION:** Dev blocks → `In Progress→Todo {dev}` + labels `[blocked,needs-pm]` + `assignee:pm` (label guards judge post-write set; `ticket.blocked` fires; card → amber Blocked lane / PM swimlane). PM can resolve → comment + drop `blocked`/`needs-pm` (same-state label edit, ungated) + `assignee:dev` (`ticket.unblocked`). PM can't → swap `blocked→human-blocked` + `assignee:operator` (red lane). Operator resolves via the daemon write path (comment the decision + `/move` to Todo + `/assign dev`), the SAME `applyTicketWrite` + `checkTransition`. PM-finds-in-review → `In Review→Done` (close) + create follow-up; human-decision follow-up parks `human-blocked`.

**W3 HUMAN-INITIATED:** human creates a Todo `dev-loop`-labelled ticket (`owner=assignee=intakeOwner=pm`) via the daemon → PM lane. Add `Todo→In Progress {pm,operator}`. PM grooms into Dev children + doc draft; ALL discussion via comments. The role list `["pm","operator"]` on the entry edge is exactly how W3 differs from W1's dev-driven entry — selectable purely by which transitions/roles the operator declares.

---

## 9. Rollout under §17 (operator-applied via git)

1. Architect/PM DRAFT this design + the per-ticket changes as `[agent-proposal]` tickets, filed `blocked` + `needs-pm` + `external-prereq`. No loop agent edits `hub/src/*` or the SKILLs.
2. Operator reviews and MERGES the code per the build order (§10), landing it DARK (every feature behind an absent `settings_json` block ⇒ zero behavior change on merge).
3. Operator runs the `ensureLabels` backfill against the live `dev-loop` hub (and any existing hub) so `human-blocked` / `env:*` exist in the taxonomy.
4. Operator opts a project IN by writing its `workflow` / `assignment` / `humanWrite` block into `settings_json` (seed/CLI/git — never an agent). Before flipping the engine on, run `auditCoverage` to confirm every in-flight edge is enumerated.
5. Operator applies the SKILL/conventions edits (Dev pick-query treats `human-blocked` as a superset; label-re-pass convention; PM intake job) in the same proposal batch.
6. De-adopt = delete the block ⇒ instant revert to today's behavior. No data rewritten, no ticket state migrated.

---

## 10. Operator decisions — round 2 (folds into §4 / §5 / §6)

Three operator decisions, each run through a grounded design + adversarial-verify pass. They **revise** the earlier subsystems: D1 sharpens §4, **D3 reverses §5's recommendation** (real state, not a label lane), and D2 details §6's intake. The implementation surface is `references/conventions.md` + the hub code (`hub/src/*`) + `skills/pm-agent/SKILL.md` — applied by the operator via git as `[pm-proposal]` tickets (§17), never auto-applied. (This design doc captures the decisions; the enforceable edits land in conventions/code through the tickets below.)

### D1 — Explicit per-agent `assignee` (who-acts-NEXT), with an opt-in auto-flip
- `assignee` = the explicit **who-acts-NEXT** handle, **MUST be set on every handoff**; the `pm`/`qa` owner label stays **who-VERIFIES**. Swimlanes and the daemon board filter key on `assignee`, never the owner label.
- Handoff assignment is a **per-transition workflow-config directive** `workflow.transitions["<From>-><To>"].assignTo ∈ { "owner" | "self" | "<handle>" | null }` in `projects.settings_json`.
- **Back-compat fix (mandatory):** ships **OFF by default** — when `settings_json` is `'{}'`, every edge behaves as `assignTo:null` (today's behavior, no implicit write). The recommended operator opt-in is `"In Progress->In Review": { "assignTo": "owner" }` (auto-flip to the verifier → swimlanes always meaningful, zero Dev burden). **I recommend you turn it ON.**
- **Claim-token reconciliation (the collision the adversary caught):** today `assignee` is contractually a *per-fire run-token* — but **only on the `local` file backend** (conventions ~L1021-1031). On the **`service` backend** (what dev-loop dogfoods), `assignee:"me"` already resolves to the **durable actor handle** (`server.ts:121`), so repurposing it as who-acts-NEXT **does not collide**; Dev's Step-0 orphan-reclaim keys on *assignee-set + In Progress + no artifact*, unaffected by `assignee=dev` vs `assignee=pm`. The local run-token contract is documented as untouched.
- **Enforcement:** new computed logic in `save_issue` (`server.ts`, after the assignee merge), gated on `a.state!==cur.state && a.assignee===undefined`. `ownerOf` lives only in `daemon.ts:74` (cross-process, not importable) → **re-implement it in `server.ts`**. `assignTo:"owner"` on a ticket with no owner label resolves to the `—` sentinel → **fail-closed** (leave `assignee` untouched, log id-only, never block the move). An explicit `assignee` in the call always wins. **No migration** (the column exists).

### D2 — W3: PM closes the parent after intake; children carry a durable back-link
- Use the existing **`relatedTo`** array as the parent/child link (**no `parentId`** — conventions deliberately omit it; adding one is a table rebuild). Zero hub schema/code change; byte-identical by default.
- **PM intake, strict order:** (1) file **each** child with `relatedTo:[<parent>]` — **child→parent is MANDATORY** (it is the row that survives the parent going Done and renders on the child, `daemon.ts:204`, no state gate); (2) in **one** write, back-link the parent `relatedTo:[<children>]` **and** comment the child IDs on the parent (`Groomed into: DL-x, DL-y`) — strongly recommended (durable provenance after Done); (3) **only then** move the parent to Done (verify-after-write). Closing before children are filed + back-linked is forbidden.
- §2 holds: W3 only touches a parent already carrying `dev-loop`; adopting a human ticket into the loop stays `init`-only. Edits: a new conventions W3 subsection + `skills/pm-agent/SKILL.md`.

### D3 — Real `Human-Blocked` STATE + daemon-side periodic Slack/Lark re-reminder  *(reverses §5)*
- **(a) A real `Human-Blocked` state** (not a label lane): added in lockstep to the `State` union (`db.ts:8`) + `STATES` (`db.ts:29`) + the `CHECK` (`db.ts:66`), plus `CORE_STATES`/`STATE_ORDER` (`daemon.ts:70-71`). A **parking state that resumes to `Todo`** on resolution; generalize the existing `blockedStateName` config to point at it (absent ⇒ label fallback = today).
  - **Migration:** SQLite can't ALTER a CHECK, so a **`user_version`-gated table rebuild in `openDb`** (idempotent, lossless; FK-toggle preserves `comments`/`mirror_map` children; serialized by `BEGIN IMMEDIATE` + `busy_timeout`). It **cannot** be a re-seed (`seed.ts:40` early-returns for existing projects). **Back-compat is BEHAVIORAL (additive/lossless), NOT byte-identical** — the DB file is rewritten once, even for config-less projects.
- **(b) Daemon-side periodic notifier:** a `setInterval` started after `server.listen` (`daemon.ts:665`), registered **only** when an enabled `channels` row **and** `humanBlockedReminderHours>0` both exist (else no timer = true no-op). Each tick: select `Human-Blocked` tickets; compute **due statelessly** (`now − MAX(human_blocked.notified event ts, else state-entry) ≥ cadence` — replayed from the events ledger like the §25 round budget, **never an in-memory counter** that dies on restart); build a §16 allow-list line (id, title≤80, in-state duration, localhost url — no description/labels/PII/secrets); `sendVia` the **same §25 `channels` row + creds**; on success insert a `human_blocked.notified` event (via the **writable** connection `daemon.ts:659`, never the `query_only` read db); on failure log id-only + retry next tick. Per-tick send cap + dry-run gate spam.
  - This **widens the daemon's "read-only by construction" charter to a writer** (events ledger) — deliberate and documented (the DL-3 roadmap editor already set the writable-connection precedent).
  - `channel.ts` helpers live in `server.ts` only (the daemon doesn't import them) → **extract a shared `channel-send.ts`** so the two send paths can't drift.
- **Notify reconciliation (operator-chosen: option (b) — daemon owns the whole lifecycle on `service`).** On the **`service` backend the daemon owns the entire Human-Blocked notification lifecycle**: it fires the **first ping immediately on first detection** (no last-sent marker ⇒ due now) **and** the periodic reminders thereafter — all from the one stateless events-ledger timer. The state `Human-Blocked` is therefore **authoritative**: PM moves the ticket to the state and does **not** also need to carry the `blocked+needs-pm+external-prereq` label triple to trigger a notification (the daemon keys on `state='Human-Blocked'`, not labels). The §9 PM one-shot webhook **stays only for the `linear`/`local` backends** (which have no daemon) — there it remains the first-and-only ping, de-duped by the `notified` label. So: **`service` ⇒ daemon-owned (first ping + reminders), state-authoritative; `linear`/`local` ⇒ §9 PM one-shot only.** No dual-owner seam, no label-triple dependency on `service`. *(Chosen over option (a) because the whole point of D3 is to make the state authoritative — requiring PM to also keep the labels would re-introduce the very label-coupling the real state was meant to replace. Trade-off accepted: two different notify owners across backends.)*

### Revised build order (supersedes §9's order for these items)
1. **D2** — conventions + SKILL prose, zero code, byte-identical. Ship first (lowest risk, immediate value). *Effort S.*
2. **D1** — `server.ts`-only, no migration, ships OFF by default. Re-implement `ownerOf` in `server.ts`; fail-close the `—` sentinel. *Effort S.*
3. **D3a** — real `Human-Blocked` state + `user_version` rebuild migration + daemon `STATE_ORDER`. Must land before D3b. *Effort M.*
4. **D3b** — daemon periodic notifier; extract the shared `channel-send.ts` first, then the `setInterval` + stateless due-ness + writable-connection event write. *Effort L.*

All four are structural ⇒ one operator-applied `[pm-proposal]` set via git (§17).

### Proposal tickets (supersede the earlier assignee / W3 / blocked items in §9)
- **`[pm-proposal] D1` — per-transition `assignTo` directive** (Feature, P3, S): `save_issue` resolves `owner|self|<handle>|null` after the assignee merge; re-implement `ownerOf` in `server.ts`; `—`-sentinel fail-closed; resolved handle into the `issue.transition` event. Conventions §3a/§11a/§7 + STRATEGY bullet.
- **`[pm-proposal] D2` — W3 parent-close + child→parent `relatedTo` back-link** (Improvement, P3, S): conventions W3 subsection (strict ordering) + `skills/pm-agent/SKILL.md`; rides existing `relatedTo` union (`server.ts:201-203`) + unconditional `relatedRow` render (`daemon.ts:204`). Zero code.
- **`[pm-proposal] D3a` — promote `Human-Blocked` to a real state** (Feature, P2, M): enum + CHECK + `user_version` rebuild migration in `openDb` + daemon `STATE_ORDER`; generalize `blockedStateName`; resume-to-`Todo`.
- **`[pm-proposal] D3b` — daemon periodic `Human-Blocked` notifier** (Feature, P2, L): `setInterval` (gated on channel + `humanBlockedReminderHours`), stateless due-ness via `human_blocked.notified` events, writable connection, extract shared `channel-send.ts`. **Depends on D3a.**
- The earlier §9 items covering assignee / W3 / blocked-lane are **superseded** by these; the workflow-config engine, swimlanes, and release/env-gating items remain valid and compose with `workflow.transitions` (D1's `assignTo` is the first directive under that map).
