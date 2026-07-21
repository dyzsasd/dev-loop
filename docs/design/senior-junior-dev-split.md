# Design — senior-dev / junior-dev split (2026-06-27)

> **Status note (1.0.0):** this is the design record that introduced the two-tier Dev model.
> Current behavior is governed by [`references/conventions.md`](../../references/conventions.md)
> §21a and [`references/config-schema.md`](../../references/config-schema.md). Older roster details
> below, including references to the retired Director work, are preserved as design history.

> Operator-approved refactor: split the single **Dev** agent into a **senior-dev** (opus,
> effort max) that designs-and-delegates (and direct-codes on escalation) and a **junior-dev**
> (sonnet, effort high) that implements pre-designed tickets. The split is the NEW *recommended*
> per-project model — adopted via launcher panes + PM routing — **not** a global replacement:
> the legacy single **dev** actor and `dev-agent` SKILL stay ACTIVE as the fallback, so existing
> single-pane projects (e.g. monpick on Linear) are 100% unaffected. This file is the source of
> truth the parallel implementers (hub code, the two new SKILLs, PM/QA, config/launcher) read.

This design serves the dev-loop STRATEGY (`docs/STRATEGY.md` → throughput / cost-efficiency of the
build factory): two-tier dev lets the expensive reasoning model concentrate on *design + escalation*
while a cheaper model does the bulk implementation against a written spec — raising correctness-per-
dollar without weakening any gate. Traceability: **strategy → this design → the parent design ticket →
the child dev tickets → code.**

---

## 1. Overview

Today **Dev** (one actor, one SKILL, one launcher pane) does everything: pick a `Todo` ticket in the
§5 order, groom it, implement it, gate it, ship it, hand it to its owner at `In Review`. We split the
*implementation* role in two and add a *design* tier on top:

| Role | Default launch profile | Picks up | Produces |
|---|---|---|---|
| **senior-dev** | Claude `claude-opus-4-8` / `max`; Codex `gpt-5.5` / `xhigh` | senior-assigned tickets: **design/new-module/new-feature** (design mode) **and** **escalation follow-ups** (direct-code mode) | a living per-module **design doc** + staged child tickets (design mode); shipped code (direct-code mode) |
| **junior-dev** | Claude `claude-sonnet-4-6` / `high`; Codex `gpt-5.5` / `high` | junior-assigned `Todo` tickets (the design's children + improvements/bug-fixes) | shipped code against the linked design |
| **dev** *(legacy, kept active)* | Claude `opus` / `max`; Codex `gpt-5.5` / `xhigh` | `Todo` in the §5 order — the whole queue | shipped code (the single-dev model, unchanged) |

The split is now the **default** for `dev-loop run --agents core`: a project either runs the two-tier
model (senior + junior panes, PM routes to them) **or** explicitly opts into the legacy single-dev
model (`devSplit:false` plus `--agents legacy`). The two never need to coexist on one project; both
must keep working across the fleet.

**Why keep `dev`/`dev-agent`.** Other projects still run a single dev pane. Retiring `dev` or deleting
`dev-agent/SKILL.md` would break them and would discard the proven fallback. So `dev` stays an **active**
hub actor, `dev-agent/SKILL.md` stays the canonical single-dev SKILL, and the §5 pick order, claim,
grooming, gates, and ship steps it documents are the shared substrate both senior-dev (direct-code mode)
and junior-dev inherit by reference rather than restating.

---

## 2. The agent-roster change (conventions §21 + seed.ts + §4 labels)

### 2a. Hub actors (`hub/src/seed.ts` `AGENT_HANDLES`)
At the time of this design, add **`senior-dev`** and **`junior-dev`** as **active** agent actors, alongside the then-existing eight
(`pm`, `qa`, `dev`, `sweep`, `reflect`, `ops`, `architect`, `director`). **`dev` is NOT moved to
`RETIRED_HANDLES`** — it stays active (unlike the `signal`→`director` retirement precedent). The
roster becomes ten active agent actors + the operator.

```ts
const AGENT_HANDLES = ["pm", "qa", "dev", "senior-dev", "junior-dev",
                       "sweep", "reflect", "ops", "architect", "director"];
```

`ensureActors` is `INSERT OR IGNORE` (idempotent), so an existing `hub.db` simply gains the two new
actor rows on the next open — no migration, no data change. The G1 phantom-actor guard
(`actorExists` filters `active=1`) then accepts `DEVLOOP_ACTOR=senior-dev` / `junior-dev` writes and
stamps every comment/event/transition with the real sub-role.

### 2b. Section-4 owner-kind labels
Add **`senior-dev`** and **`junior-dev`** as labels (used for Linear routing where assignee can't
distinguish, and for hub service tagging / filterability). In `seed.ts` `LABELS` they are
`kind:"owner"` (they name *which dev owns the implementation*, paralleling `pm`/`qa` as routing
labels) — but see the **caveat** in §6: these are **dev-routing** labels, NOT verification-owner
labels. The verifier of every ticket is still PM or QA (the `pm`/`qa` owner label is untouched).

```ts
{ name: "senior-dev", kind: "owner" }, { name: "junior-dev", kind: "owner" },
```

The labels table already permits `kind:"owner"` (db.ts CHECK), so this rides the existing
`ensureProject` / `ensureLabels` `INSERT OR IGNORE` backfill — no schema change. On `linear`/`local`
they are created once at setup (§13) alongside the other workflow labels.

> **Naming discipline.** The actor handle, the label name, the config `models` key, and the launcher
> pane name are all the **same string** — `senior-dev` / `junior-dev` — exactly as the then-existing eight
> agents (§26 one-env-contract). No agent invents a variant.

---

## 3. Routing — PM assigns at ticket creation

PM decides the dev tier **when it files the ticket** (the existing §6 filing step), by a single rule:

| Ticket nature | Assign to | Mode it triggers |
|---|---|---|
| **new module / new feature** (needs design) | **senior-dev** | design-and-delegate |
| **improvement / bug-fix** (scoped change) | **junior-dev** | implement |
| **BORDERLINE** (could go either way) | **junior-dev** (the default) | implement — escalation is the cheap safety net |

The bias is deliberate: **default down to junior-dev**, because a junior ticket that turns out to need
senior judgment is caught cheaply by the verify-fail escalation (§7) — whereas over-routing to senior-dev
spends the expensive model on work the cheap one could do. "When borderline, junior."

**The TODO must EXPLICITLY name the dev.** A reader (and the picking agent) must see at a glance which
tier owns it — via the per-backend encoding in §6. A ticket with **no** dev assignment in a split
project is a Sweep-flagged gap (it's invisible to both dev pick-queries), exactly as a missing
`pm`/`qa` owner label strands a ticket today.

> **Back-compat:** in a **legacy single-dev project** PM does NOT add a senior/junior assignment — it
> files dev tickets exactly as today (state `Todo`, no dev-tier marker), and the single `dev` pane picks
> the whole §5 queue. All agents detect the project's dev model from the authoritative config flag
> `devSplit:true` (§9; never inferred from `models{}`, panes, history, or any ticket); absent/false ⇒
> legacy, today's behavior. _(Updated post-`059cf3e`/DL-97: the original `models{}`-presence detection
> was too weak — agents over-rode it from board history — so it was replaced by the explicit flag.)_

---

## 4. The design doc tier (conventions §20-adjacent, a NEW doc kind)

A **design doc** is a per-MODULE technical-design document that senior-dev authors and maintains.
It sits *below* the strategy/roadmap (PM-owned product direction) and *above* the ticket specs.

- **Granularity = LIVING per-module doc.** One design doc per module, **updated as the module
  evolves** — not one-per-feature and not a write-once artifact. History lives in the hub doc
  versioning (service) or git history (repo backends), so the doc itself stays current rather than
  accreting changelog noise.
- **Small features get NO separate doc** — the design lives in the parent + child ticket specs
  themselves. A design doc is reserved for work substantial enough to warrant a module-level spec.
- **It is a PRODUCT doc, authored autonomously.** senior-dev writes/commits it the way PM commits the
  `strategyDoc` (§20) — it is **NOT** a §17 governing file (SKILL/conventions/code) and is **NOT**
  operator-publish-gated. The real gate is the **design PARENT TICKET reaching `In-Review`** (PM
  verifies it; §5/§7).
- **It cites its parent.** Every design doc names the strategy/roadmap item it serves (the
  traceability chain), so a reader can walk strategy → roadmap → design → ticket → code.

### Where a design doc lives (per backend)

| Backend | Design-doc home | Tools / mechanics |
|---|---|---|
| **service** (hub) | the hub **`design`** doc-kind (versioned, attributable, CAS) | `doc.save({ kind:"design", slug:"<module>", … })` / `doc.get({ kind:"design", slug })`. **NOT operator-publish-gated** — see the publish note below. |
| **linear** / **local** (repo backends) | a committed repo file **`docs/design/<slug>.md`** | senior-dev reads/edits/commits it in the doc-home repo (§19), like a repo-file `strategyDoc`. |
| any backend, **small feature** | **no doc** — the parent + child ticket specs carry the design | — |

> **Service publish semantics (important).** Today the hub's `docPublish` operator-gate applies to
> the whole `documents` table, and `kind` is UNIQUE per project (one doc per kind). The `design`
> kind needs **two** departures from `strategy`/`roadmap`: (1) it is **multi-instance** — one doc per
> module **slug** — so the `UNIQUE(project_id, kind)` constraint must **exclude** `design` (or `design`
> must be exempt from it); and (2) it is **not operator-publish-gated** — senior-dev's `doc.save`
> draft IS the live design (autonomous product-doc authorship), so the design tier reads the **latest
> version** rather than waiting for a `current` publish. The hub-code implementer owns reconciling
> these — the cleanest path is documented in §10 (migration plan) and §11 (file-by-file). The design
> CITES this departure so the implementer doesn't accidentally force design through the
> operator-publish gate that strategy/roadmap use.

---

## 5. The design gate + the senior-dev design-and-delegate flow

### 5a. senior-dev design-and-delegate (the normal complex path)
1. **Pick** a senior-assigned **design** ticket (a `Todo` ticket routed to senior-dev whose nature is
   design/new-module/new-feature — see §8 for how senior-dev tells design-mode from direct-code-mode).
2. **Claim** it (§7 — `In Progress`, assignee/own-token), exactly as Dev claims today.
3. **Author the design**: write/update the living per-module **design doc** (hub `design` kind on
   service, `docs/design/<slug>.md` on repo backends) for substantial work — **OR**, for a small
   feature, write the design directly into the ticket spec (no separate doc). Commit the repo-file
   design (service: `doc.save`).
4. **Spawn the concrete child dev-tickets**, each:
   - **assigned to junior-dev** (per-backend encoding, §6),
   - created in state **`Backlog`** (staged — UNPICKABLE; see §5c),
   - carrying a **`Design:` pointer line** in its description (§ contract: `designPointerFormat`),
   - `relatedTo:[<design-parent-id>]` (child→parent link, MANDATORY — survives the parent closing,
     mirroring §9a W3 intake),
   - with crisp, testable acceptance criteria (each child = one verified increment).
5. **Back-link the parent** in one write — `relatedTo:[<child1>,<child2>,…]` + a comment listing the
   child IDs (`Designed into: <id>, <id>` — mirroring §9a's `Groomed into:`).
6. **Move the design PARENT to `In-Review`** (verify-after-write, §10). senior-dev does **not** mark
   it Done — PM verifies (the gate).

### 5b. The design gate (PM verifies → children promote)
- **PM verifies** the design parent at `In-Review` (its **How to verify** = the design is coherent,
  cites its strategy/roadmap parent, and the children faithfully decompose it). On a **big-module /
  docs-design-level** design, the **operator** signs off (PM surfaces it; same posture as a
  significant product decision) — for ordinary designs PM verifies directly.
- **Pass → PM moves the design parent `Done`** and **PROMOTES every staged child `Backlog → Todo`**
  (re-passing the full label set, §10). The children are now pickable by junior-dev.
- **Fail → close + follow-up** (the universal §3 rule): PM `Canceled`s the design parent
  (`review failed: <what>; superseded by <new-id>`) and files a fresh design ticket (or, if the design
  was sound but a child is wrong, the per-child path). The staged children of a failed design are
  `Canceled` with it (they reference a superseded design) — never left stranded in `Backlog`.

### 5c. Why `Backlog` staging (reuse the existing pattern)
Children are filed in **`Backlog`**, not `Todo`, so junior-dev **cannot pick them before the design is
verified** — `Backlog` is already a §3 state ("idea captured but not yet ready for dev") and is outside
every dev pick-query (§5 selects `Todo`). This reuses the existing staging+promotion shape rather than
inventing a new state: a staged child sits in `Backlog` exactly like a parked idea, and PM's
`Backlog → Todo` promotion on design-gate-pass is the same kind of state move PM already makes. (The
§9a W3 intake closes the parent *immediately*; here the parent goes to `In-Review` first because the
**design itself is the verified increment** — that is the only structural difference, and it is what
the design gate adds.)

---

## 6. Per-backend dev-tier encoding (assignee vs label)

The dev tier must be **machine-filterable** so each dev's pick-query selects only its own tickets. The
encoding differs by backend because Linear is one shared identity:

| Backend | Dev-tier encoding | senior-dev pick filter | junior-dev pick filter |
|---|---|---|---|
| **service** (hub) | the ticket **`assignee`** field = the actor `senior-dev` / `junior-dev` (real per-agent identity) | `assignee = senior-dev` | `assignee = junior-dev` |
| **linear** | a **`senior-dev` / `junior-dev` LABEL** in the ticket's label set (one shared Linear identity ⇒ `assignee` can't distinguish the tier; the label does) | `label:"junior-dev"` … filter `senior-dev` client-side, OR scope by `label:"senior-dev"` + project | scope by `label:"junior-dev"` + project |
| **local** | the `senior-dev` / `junior-dev` string in the ticket file's `labels:[]` frontmatter (repo-as-label parity, §19) | label ∈ `labels[]` = `senior-dev` | label ∈ `labels[]` = `junior-dev` |

> **Caveat — the `assignee` field vs the `pm`/`qa` owner label.** On **service**, the dev tier rides
> the `assignee` field (the claim, §7, sets `assignee` to the *running* actor while In Progress). So:
> PM files a senior/junior ticket with `assignee` pre-set to the tier actor; when that dev **claims**
> it (`assignee:"me"`), the assignee stays the same actor (it claims its own pre-assignment) — no
> conflict. The §4 **`pm`/`qa` owner label is UNCHANGED** and still names the **verifier**; the dev
> tier is orthogonal routing. On **linear/local** the dev tier is a *label* (since assignee is shared
> / a per-fire token), so a linear/local ticket carries BOTH the `pm`-or-`qa` verifier label AND the
> `senior-dev`-or-`junior-dev` dev label. To keep one code path, the §4 `senior-dev`/`junior-dev`
> labels are provisioned on **all** backends (harmless extra labels on service; the routing carrier on
> linear/local).

**The `Design:` pointer line** (in every child's description; the contract `designPointerFormat`):
```
Design: hubDoc:design/<slug>          # service — the hub `design` doc for module <slug>
Design: docs/design/<slug>.md         # linear / local — the committed repo design file
Design: parent <parent-id>            # small/ticket-spec design (no separate doc) — the parent ticket IS the design
```
junior-dev reads this line FIRST and fetches the cited design before writing any code (§7 junior flow).

---

## 7. junior-dev flow + verification + escalation

### 7a. junior-dev implement flow
1. **Pick** a junior-assigned `Todo` ticket (its own pick-filter, §6), within the §5 pick order among
   its own tickets (urgent bug → urgent feature → edge-case bug → bug → feature → improvement).
2. **Claim** (§7).
3. **READ the linked design BEFORE coding** — follow the `Design:` pointer (§6): fetch the hub `design`
   doc / open `docs/design/<slug>.md` / read the parent ticket spec. Implement to the design + the
   ticket's ACs. (If the pointer is missing/broken in a split project, that's a **block** —
   `Bail-shape: info-needed` — routed to PM, exactly like a missing repo target, §19.)
4. **Gate / self-review / ship / smoke** — the full `dev-agent` Step-5 / 5.5 / 6 / 6.5 sequence,
   inherited by reference (junior-dev does NOT re-derive these gates; the build/test gate, the
   Critical/High self-review block, and the post-deploy rollback all apply unchanged).
5. **Hand off to `In-Review`** for the **verification owner** (PM for Feature/Improvement, QA for Bug —
   the `pm`/`qa` label, unchanged). Coverage rule (§15) and the split rule apply as today.

### 7b. Verification + escalation (rides the universal verify-fail rule, §3)
- **QA/PM verify** the junior In-Review code against ACs in the test env (Job A), exactly as today.
- **A transient / flaky / infra error is NOT a fail** — junior simply retries (or it's re-queued); the
  escalation below fires only on a **REAL acceptance-criteria failure**.
- **On the FIRST real fail, escalate to senior-dev** (the verify-fail close+follow-up, routed to
  senior):
  1. PM/QA **`Canceled`s the junior ticket** with `review failed: <what failed / observed behaviour>;
     superseded by <new-id>` (the standard §3 comment).
  2. PM **creates a NEW senior-dev DIRECT-CODE ticket** carrying the remaining work — assigned to
     **senior-dev** (per-backend, §6), marked as an **escalation / direct-code** ticket (§8), in
     `Todo`, `relatedTo` the failed ticket.
  3. **senior-dev codes it DIRECTLY** (direct-code mode — NOT design-delegate): pick → claim → implement
     → gate → ship → In-Review, using the `dev-agent` build/ship steps. (Opus + max on the work the
     cheaper model couldn't get right.)
- **If the senior direct-code ALSO fails verify → bail-shape `fix-exhausted` → `Human-Blocked`**
  (operator). This is the existing fix-exhausted terminal: the second failure means the loop has
  exhausted its automated tiers (junior, then senior), so PM parks it for the operator
  (`Human-Blocked` on service, the `blocked`+`needs-pm`+`external-prereq` park on linear/local; §9).

```
junior In-Review ──REAL fail──► PM Cancel + file senior DIRECT-CODE ticket
                                            │
                              senior-dev codes directly → In-Review
                                            │
                                  ┌─ pass ─► Done
                                  └─ REAL fail ─► fix-exhausted ─► Human-Blocked (operator)
```

> A QA-owned Bug that fails escalates the same way, but **QA itself files** the senior direct-code
> follow-up when it Cancels the failed junior Bug — the rule is **the verifier files the follow-up**
> (PM for a Feature/Improvement it verified; QA for a Bug it verified), so the escalation always has a
> mechanical ticket-state carrier (a QA-Canceled Bug is terminal + not pm-owned, so PM Job A never
> sees it). QA still owns Bug *verification* (it re-verifies the returning senior fix).

---

## 8. senior-dev's two modes — how it tells which

senior-dev picks senior-assigned tickets and runs in one of two modes, chosen by the **ticket
type/marker**:

| Marker on the senior-assigned ticket | Mode | senior-dev does |
|---|---|---|
| a **design / new-module / new-feature** ticket | **design-and-delegate** | author the design doc/spec, spawn staged junior children, move parent → In-Review (§5) |
| an **escalation follow-up** ticket (from a junior verify-fail, §7) | **direct-code** | implement → gate → ship → In-Review (the dev-agent build flow) |

The marker is explicit on the ticket (the SKILL/PM contract uses a description tag — the contract
field `seniorModeMarker`, e.g. a `Mode: design` / `Mode: direct-code` line, plus the natural signal
that an escalation ticket is `relatedTo` a `Canceled` `review failed:` ticket). Both kinds are
**senior-dev-assigned**; the mode marker (not a separate actor) disambiguates.

---

## 9. Models + scheduler

### 9a. `config-schema.md` model/effort overrides
`dev-loop run` has built-in role defaults. Use `models` / `efforts` only when a project or account
needs a different launch profile:
```jsonc
"models": {
  "senior-dev": { "claude": "claude-opus-4-8", "codex": "gpt-5.5" },
  "junior-dev": { "claude": "claude-sonnet-4-6", "codex": "gpt-5.5" }
},
"efforts": {
  "senior-dev": { "claude": "max", "codex": "xhigh" },
  "junior-dev": "high"
}
```
`dev` remains the explicit legacy single-pane agent. `senior-dev` defaults to opus-class/max and
`junior-dev` defaults to sonnet-class/high for Claude; Codex defaults both to `gpt-5.5` with
senior at `xhigh` and junior at `high`.

### 9b. Scheduler
The scheduler uses split mode by default for `dev-loop run --agents core`: it starts two Dev panes
and injects `DEVLOOP_DEV_SPLIT=true` into every fire:
- a **senior-dev** fire — Claude `--model claude-opus-4-8 --effort max`; Codex
  `--model gpt-5.5 -c model_reasoning_effort="xhigh"`,
- a **junior-dev** fire — Claude `--model claude-sonnet-4-6 --effort high`; Codex
  `--model gpt-5.5 -c model_reasoning_effort="high"`.

The legacy single `dev` pane remains available only when explicitly requested with
`dev-loop run --agents legacy` or an explicit `pm,qa,dev,sweep` list (Claude opus/max;
Codex `gpt-5.5`/`xhigh` unless overridden).
Older external launchers may still carry a knob such as `DEV_SPLIT=1`; split launchers should either
set `DEVLOOP_DEV_SPLIT=true` for every pane or persist `devSplit:true` in `dev-loop.json`. The
existing effort tiers are unchanged: `pm=max`, `reflect/architect=xhigh`,
`qa/sweep/ops/communication=high`, plus `senior-dev=max` / `junior-dev=high`. On the Codex
lane the scheduler normalizes `max` → `xhigh` (`model_reasoning_effort` has no `max`).

---

## 10. Migration plan (the hub `design` doc-kind — ADDITIVE, prod-safe)

The live shared `hub.db` must never be destructively rebuilt. Adding the `design` doc-kind touches the
`documents.kind` CHECK, which SQLite cannot `ALTER` — so it needs a **PRAGMA `user_version` migration**,
mirroring the DL-25 (v1, lossless table rebuild) and DL-52 (v2, additive ALTER) precedents in
`hub/src/db.ts`.

**Why a migration (not just `ensureLabels`).** Unlike the §4 labels (plain strings, `INSERT OR IGNORE`,
no schema), `documents.kind` is enforced by a **CHECK constraint** in the `SCHEMA` string (db.ts line
~109) and `DOC_KINDS` is the enum in `docstore.ts`. A new kind must (a) widen the CHECK and (b) extend
`DOC_KINDS` — and the CHECK can only be widened by the documented table-redefinition (rebuild) procedure.

**The v3 migration (bump `SCHEMA_VERSION` to 3):**
1. **Single source of truth for the kind enum.** Mirror the `STATE_CHECK` / `TRANSPORT_CHECK`
   no-drift pattern: derive the `documents.kind` CHECK clause from a single `DOC_KINDS`-style constant
   so the fresh `SCHEMA` and the migration can never diverge. (Today the CHECK is an inline literal;
   the implementer should hoist it to a derived `DOC_KIND_CHECK`, exactly as `STATE_CHECK` is built
   from `STATES`.) `DOC_KINDS` in `docstore.ts` becomes `["strategy","roadmap","decisions","notes","design"]`.
2. **Rebuild `documents`** (CHECK-widen ⇒ lossless rebuild, the DL-25 v1 shape): `PRAGMA
   foreign_keys=OFF`; `BEGIN IMMEDIATE`; create `documents_new` with the widened `kind` CHECK **and the
   adjusted UNIQUE constraints** (see step 3); `INSERT … SELECT` an **explicit column list** (never
   `SELECT *`) from `documents`; `DROP TABLE documents`; `ALTER TABLE documents_new RENAME TO documents`;
   recreate `idx_documents_project`. `document_versions` is untouched (its `kind` is not constrained).
3. **Relax the per-kind uniqueness for `design`.** The current `UNIQUE(project_id, kind)` enforces one
   doc per kind — correct for `strategy`/`roadmap`, **wrong** for `design` (one per module slug). The
   rebuild's `documents_new` must allow multiple `design` rows distinguished by `slug` while keeping
   `strategy`/`roadmap`/`decisions`/`notes` single-instance. Two acceptable shapes (implementer's
   call): (a) keep `UNIQUE(project_id, slug)` for all kinds + a **partial** unique index
   `UNIQUE(project_id, kind) WHERE kind != 'design'`; or (b) drop the table-level `UNIQUE(project_id,
   kind)` and add per-kind partial unique indexes for the four single-instance kinds. Either keeps
   `resolveDoc(kind)` correct for the singletons and lets `resolveDoc(slug)` address a specific design.
4. **`PRAGMA user_version=3`**; `COMMIT`; `PRAGMA foreign_keys=ON` — all keyed/guarded exactly as the
   existing `migrate()` does (re-check `userVersion` under the write lock; fresh DBs get the current
   schema with no migration via the `fresh` path in `openDb`).
5. **`docPublish` exemption / design-read path.** Because the design tier is NOT operator-publish-gated
   (§4), the hub-code implementer must ensure `docSave({kind:"design"})` drafts ARE the readable design
   (design consumers read the **latest** version, not a `current` publish). Cleanest: the `design` kind
   is simply never published — `doc.get`/the design-read helper returns the latest version for `design`
   (drafts), while `strategy`/`roadmap` keep the publish gate. No change to `docPublish`'s operator gate
   for the existing kinds.

**Idempotency / safety.** `ensureActors` (actors) and `ensureLabels` (labels) are `INSERT OR IGNORE` —
no migration, applied on every open. The doc-kind change is the ONLY schema bump; it is additive
(widens an enum + relaxes a constraint for one new kind), lossless (explicit-column rebuild), and
guarded by `user_version` so it applies exactly once across the server + daemon connections — never a
destructive rebuild of live data.

---

## 11. File-by-file change map

> This design edits only this file + `references/conventions.md` (the keystone deliverables). Every
> row below is the **contract** a parallel implementer applies — listed so the build is coherent.

| File | Change | Owner |
|---|---|---|
| `docs/design/senior-junior-dev-split.md` | **this design** (source of truth) | keystone (this) |
| `references/conventions.md` | roster (§21), routing + design-gate + escalation, the `design` doc-kind, §4 labels, per-dev pick-order + per-backend encoding, `Backlog`-staging of design children | keystone (this) |
| `hub/src/seed.ts` | add `senior-dev`,`junior-dev` to `AGENT_HANDLES` (active; `dev` stays); add `senior-dev`,`junior-dev` (`kind:"owner"`) to `LABELS` | hub impl |
| `hub/src/docstore.ts` | `DOC_KINDS += "design"`; design-read returns latest version (un-published); `docSave` allows multi-instance `design` by slug | hub impl |
| `hub/src/db.ts` | hoist `documents.kind` CHECK to a derived `DOC_KIND_CHECK` (no-drift, like `STATE_CHECK`); bump `SCHEMA_VERSION`→3; add the v3 migration (rebuild `documents` widening `kind` + relaxing `UNIQUE(kind)` for `design`) | hub impl |
| `skills/senior-dev-agent/SKILL.md` | **NEW** — design-and-delegate (normal) + direct-code (escalation) modes; §5 flow; §8 mode marker; inherits dev-agent gates by reference | senior SKILL impl |
| `skills/junior-dev-agent/SKILL.md` | **NEW** — pick own tickets; READ the `Design:` pointer before coding; dev-agent gate/ship flow; In-Review for PM/QA | junior SKILL impl |
| `skills/dev-agent/SKILL.md` | **UNCHANGED** — kept active as the legacy single-dev fallback | (none) |
| `skills/pm-agent/SKILL.md` | routing-at-filing (new-module→senior, improvement/bug→junior, borderline→junior); the design gate (verify design parent → promote `Backlog`→`Todo` children; operator sign-off for big designs); escalation (Cancel junior fail → file senior direct-code; 2nd fail → Human-Blocked); detect legacy-vs-split from config or scheduler context | PM SKILL impl |
| `skills/qa-agent/SKILL.md` | escalation on a junior Bug verify-fail: QA Cancels + **files the senior-dev direct-code follow-up itself** (the verifier files it — the qa→senior arm has no other carrier); transient ≠ real fail | QA SKILL impl |
| `references/config-schema.md` | `models` / `efforts` document role defaults plus project overrides; note split-dev as the default + explicit legacy single-dev | config impl |
| `dev-loop run` / launchers | default `core` uses senior-dev (Claude opus/max, Codex gpt-5.5/xhigh) + junior-dev (Claude sonnet/high, Codex gpt-5.5/high) and injects `DEVLOOP_DEV_SPLIT=true`; keep the legacy `dev` pane only for explicit `--agents legacy` / single-dev launchers | launcher impl |
| `skills/init/SKILL.md` *(if it provisions labels)* | provision `senior-dev`/`junior-dev` labels at setup (§13) | init impl (minor) |
| `skills/sweep-agent/SKILL.md` *(optional)* | flag a split-project dev ticket with NO dev-tier assignment (invisible to both dev queries), like a missing owner label | sweep impl (optional) |

---

## 12. The structured contract (verbatim names/states/formats — all implementers agree)

These are the exact tokens the hub code, the two new SKILLs, PM/QA, and config/launcher must use
**verbatim**:

- **actorsAdded** (seed.ts `AGENT_HANDLES`, active): `senior-dev`, `junior-dev` — `dev` stays active
  (NOT retired).
- **labelsAdded** (§4 / seed.ts `LABELS`, `kind:"owner"`, all backends): `senior-dev`, `junior-dev`.
- **docKindAdded** (docstore.ts `DOC_KINDS` + db.ts CHECK): `design`.
- **skillsNew**: `skills/senior-dev-agent/SKILL.md`, `skills/junior-dev-agent/SKILL.md`.
- **designPointerFormat** (the child-ticket `Design:` line, one of):
  - `Design: hubDoc:design/<slug>` (service)
  - `Design: docs/design/<slug>.md` (linear / local)
  - `Design: parent <parent-id>` (small / ticket-spec design)
- **childStagingState** = `Backlog` (staged, unpickable; promoted to `Todo` on design-gate pass).
- **routingRule** (PM, at filing): new module / new feature ⇒ **senior-dev**; improvement / bug-fix ⇒
  **junior-dev**; BORDERLINE ⇒ **junior-dev** (default). The TODO explicitly names the dev tier.
- **escalationRule**: on the FIRST real (non-transient) AC failure of a junior In-Review ticket → PM
  `Canceled`s it (`review failed: …; superseded by <new-id>`) + files a NEW **senior-dev direct-code**
  ticket (`relatedTo` the failed one). If the senior direct-code ALSO fails verify → `fix-exhausted` →
  **Human-Blocked** (operator).
- **perBackendRouting**: **service** = the ticket **assignee** field (actor `senior-dev`/`junior-dev`);
  **linear** = a **`senior-dev`/`junior-dev` label**; **local** = the same string in `labels:[]`
  frontmatter. Each dev's pick-query filters to its own (assignee on service, label on linear/local).
- **designParentReviewState**: the design parent reaches **`In-Review`** (PM verifies; operator signs
  off big-module/docs-design-level); on pass → parent `Done` + children promoted `Backlog`→`Todo`.
- **seniorModeMarker**: a `Mode: design` / `Mode: direct-code` line on the senior-assigned ticket (plus
  the natural signal that an escalation ticket is `relatedTo` a `Canceled` `review failed:` ticket)
  selects design-delegate vs direct-code mode.
- **devKeptActive** = TRUE — the `dev` actor + `dev-agent/SKILL.md` stay ACTIVE as the legacy
  single-dev fallback; non-split projects are 100% unaffected.
- **designDocPath** (this design) = `docs/design/senior-junior-dev-split.md`.
- **conventionsSectionsEdited**: §3 (state machine — `Backlog` staging + verify-fail→senior escalation
  note), §4 (labels), §5 (per-dev pick order), §18 (per-backend dev-tier encoding), §21 (roster +
  charters + design tier + design gate). (Exact set recorded in the conventions edit.)
