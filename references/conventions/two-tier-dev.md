# The two-tier Dev — design tier, delegate flow, gate, escalation — conventions §21a pointer file

> Moved out of `references/conventions.md` §21a (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §21a's contract: read it at the trigger moment the §21a stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

### The design doc tier (a PRODUCT doc, authored autonomously)
A **design doc** is a per-MODULE technical-design document senior-dev writes and keeps current. It
sits below the strategy/roadmap (PM-owned direction, §20) and above the ticket specs,
and **cites the strategy/roadmap item it serves** (traceability: strategy → roadmap → design → ticket
→ code).
- **Granularity = LIVING per-module doc** — one per module, **updated as the module evolves** (not
  one-per-feature, not write-once). History lives in the hub doc versioning (`service`) or git
  (`linear`), so the doc stays current rather than accreting changelog noise.
- **Retire, don't delete (D6 retention).** When a module is removed or its design is superseded,
  senior-dev ARCHIVES its design doc: on `service`, `dev-loop doc archive --slug <module>` (the
  `doc.archive` op — DESIGN docs only, the singleton kinds refuse; reversible via `--restore`). An
  archived doc leaves the `/docs` index (`?archived=1` shows it), the drafts-pending chip, and the
  daemon notifiers, but the doc + its full version history stay readable forever — never deleted,
  never re-ingested per fire. On `linear`, move the repo file to `docs/design/archive/`
  with a one-line commit. A superseding design doc should name what it replaced.
- **Small features get NO separate doc** — the design lives in the parent + child ticket specs.
- **senior-dev writes/commits it AUTONOMOUSLY** — like PM commits the `strategyDoc` (§20). It is
  **NOT** a §17 governing file (SKILL/conventions/code) and is **NOT** operator-publish-gated; the
  gate is the design **parent ticket** reaching `In Review` (PM verifies). Home per backend (§18):
  `service` = the hub **`design`** doc-kind (`doc.save`/`doc.get`, read latest version — not publish-
  gated); `linear` = a committed repo file `docs/design/<slug>.md` in the doc-home repo (§19).

### senior-dev design-and-delegate flow (the normal complex path)
1. **Pick** a senior-assigned **design** ticket (its mode is design — §"two modes" below).
2. **Claim** it (§7).
3. **Author the design**: write/update the living per-module design doc (hub `design` kind on
   `service`; `docs/design/<slug>.md` on repo backends) for substantial work — **OR** write the design
   directly into the ticket spec for a small feature (no separate doc).
4. **Spawn the concrete child dev-tickets**, each: **assigned to junior-dev** (§18 encoding); created
   in state **`Backlog`** (staged — UNPICKABLE until the gate, §3/§5); carrying a **`Design:` pointer
   line** in its description; `relatedTo:[<design-parent-id>]` (child→parent link **mandatory** — it
   survives the parent closing, exactly as §9a W3 intake); with crisp, testable ACs (each child = one
   verified increment). The `Design:` pointer is one of:
   - `Design: hubDoc:design/<slug>` — `service` (the hub `design` doc for module `<slug>`)
   - `Design: docs/design/<slug>.md` — `linear` (the committed repo design file)
   - `Design: parent <parent-id>` — a small / ticket-spec design (the parent ticket *is* the design)
5. **Back-link the parent** in one write — `relatedTo:[<child1>,<child2>,…]` + a comment listing the
   child IDs (`Designed into: <id>, <id>` — mirroring §9a's `Groomed into:`).
6. **Move the design PARENT to `In Review`** (verify-after-write, §10). senior-dev does **not** mark it
   Done — PM verifies (the gate).

### The design gate (PM verifies the parent → children promote)
- **PM verifies** the design parent at `In Review`: the design is coherent, cites its strategy/roadmap
  parent, and the children faithfully decompose it. For a **big-module / docs-design-level** design the
  **operator** signs off (PM surfaces it, same posture as a significant product decision); ordinary
  designs PM verifies directly. **The sign-off carrier is the existing §9a Human-Blocked machinery,
  never a report line:** PM parks the design PARENT — `Human-Blocked` assigned to the operator on
  `service` (the §9a daemon reminder carries the nudge), the `blocked`+`needs-pm`+`external-prereq`
  park on `linear` (§9) — with a comment naming the design doc + the child IDs. Approval =
  the operator's approval comment (or the operator moving the parent back themselves); PM's next
  fire sees it (the §9 re-scan of parked tickets) and runs the normal pass path below. A rejection
  comment = a failed review (§3 close + follow-up).
- **Pass → PM PROMOTES every staged child `Backlog → Todo` FIRST, THEN moves the parent `Done`**
  (re-passing the full label set, §10 — each child keeps `dev-loop` + its dev-tier + its `pm`/`qa`
  verifier label) — now junior-dev can pick them. **Order matters:** promotion is idempotent
  (re-verifying an already-promoted design is safe), but a `Done` parent with children still stranded
  in `Backlog` after a mid-promotion crash is NOT — no gate ever fires on them again and Sweep's
  slow-cadence repair is the only rescue. Parent-`Done` last means a crash leaves a re-triggerable
  In-Review parent, never orphaned children. This reuses the existing Backlog-staging +
  promotion shape (a staged child sits in `Backlog` like any parked idea; the `Backlog → Todo` move is
  the same kind PM already makes) rather than inventing a new state. (The only structural difference
  from §9a is that the design *parent* goes to `In Review` first — because **the design is itself the
  verified increment** that gates the children.)
- **Fail → close + follow-up** (the universal §3 rule): PM `Canceled`s the design parent
  (`review failed: <what>; superseded by <new-id>`) and files a fresh design ticket. The staged
  children of a failed design are `Canceled` with it (they reference a superseded design) — never left
  stranded in `Backlog`.

### Verification + escalation (the FIRST real fail goes UP to senior-dev)
QA/PM verify junior In-Review code against ACs in the test env (Job A), as today. A **transient /
flaky / infra** error is **not** a fail (junior retries). On the **FIRST real acceptance-criteria
failure**, escalate (the §3 close+follow-up, routed to senior):
1. PM/QA **`Canceled`s the junior ticket** — `review failed: <what failed / observed behaviour>;
   superseded by <new-id>` (QA's bug re-test uses `re-test failed: …; superseded by <new-id>` —
   both grammars are recognized cancel-comment forms; senior's mode inference accepts either).
2. The **verifier files the NEW senior-dev DIRECT-CODE ticket** carrying the remaining work
   (assigned to `senior-dev`, marked direct-code mode, `Todo`, `relatedTo` the failed one).
3. **senior-dev codes it DIRECTLY** (direct-code mode — pick → claim → implement → gate → ship →
   In Review, the `dev-agent` build flow; opus + max on the work the cheaper tier couldn't get right).
4. **If the senior direct-code ALSO fails verify** → `Bail-shape: fix-exhausted` → **`Human-Blocked`**
   (operator): the loop has exhausted its automated tiers (junior, then senior), so the **verifier**
   parks it
   (`Human-Blocked` on `service`, the `blocked`+`needs-pm`+`external-prereq` park on `linear`,
   §9). A QA-owned Bug escalates identically — **the verifier files the senior follow-up**: PM
   files it for a Feature/Improvement it verified (Job A), and **QA files it for a Bug it verified**
   (when QA Cancels the failed junior Bug it immediately files the `senior-dev` direct-code follow-up
   itself) — so the escalation always has a mechanical ticket-state carrier, never a report hand-off
   (§1). QA still owns Bug *verification* (it re-verifies the returning senior fix).

### senior-dev's two modes — how it tells which
Both kinds of senior-assigned ticket are `senior-dev`-routed; the ticket's **mode marker** selects the
behavior: a **design / new-module / new-feature** ticket ⇒ **design-and-delegate**; an **escalation
follow-up** ticket ⇒ **direct-code**. The marker is explicit on the ticket (a `Mode: design` /
`Mode: direct-code` description line) plus the natural signal that an escalation ticket is `relatedTo`
a `Canceled` `review failed:` ticket.

### Hub / config / launcher
The wiring — hub actors (`seed.ts`), the `senior-dev`/`junior-dev` owner labels, the
`design` doc-kind migration, the per-role model/effort defaults, and the `--agents core`
launcher panes — is scheduler/CLI machinery, recorded in
`docs/design/senior-junior-dev-split.md` + `references/config-schema.md`, not re-stated
here. Resident rule: the split is OPERATOR-APPLIED — the agents themselves never self-edit
a SKILL/conventions/code file (§17); the design doc is a product artifact, not a §17
governing file.

Full design + the file-by-file change map: `docs/design/senior-junior-dev-split.md`.

**Whichever agent files a dev ticket sets its tier — EVERY filing agent, not just PM/QA:** PM at
its §6 filing step; QA when it files a `Bug`/`Improvement` (QA is a primary filer, not just PM);
**Ops when it files an `incident` Bug** (⇒ **senior-dev direct-code** by default — an Urgent
prod-down fix is exactly not the place for the cheap tier); **Architect when it files a
`tech-debt` Improvement** (⇒ **junior-dev** — scoped, behavior-preserving refactors — EXCEPT a
finding that needs **cross-module design**: a module-boundary change, a shared abstraction
spanning modules, a layering restructure ⇒ **senior-dev** as a `Mode: design` design-and-delegate
ticket, so the design gate — not a junior guess — shapes it). An un-tiered
ticket is invisible to BOTH dev pick-queries and strands until Sweep's slow-cadence repair.
Same one rule:
- **SENSITIVE ⇒ senior-dev, ALWAYS — this overrides every bullet below.** A ticket labelled
  `sensitive` (§4: auth/permissions, payment/money, PII, secrets, data migration/deletion —
  or whose ACs plainly touch those even unlabelled) goes to the senior tier even for a
  one-line fix: senior produces a complete design FIRST (design-and-delegate for
  module-scale work; for a small sensitive fix senior writes the design into the ticket
  body — `Design: parent <id>` form — and may direct-code it). "When borderline, junior"
  NEVER applies to sensitive work; a mis-routed sensitive ticket is re-tiered to senior,
  never implemented by junior. Fully autonomous — no human gate; the protection is the
  mandatory design step + the owner's independent verification, not a pause.
- **new module / new feature** (needs a design) ⇒ assign **senior-dev** (design-and-delegate).
- **improvement / bug-fix** (a scoped change) ⇒ assign **junior-dev**. (QA's findings are bug-fixes /
  drift-improvements by nature, so QA-filed tickets default to **junior-dev**.)
- **BORDERLINE** ⇒ default to **junior-dev** — escalation (§21a) is the cheap safety net, so
  over-routing to the expensive tier is the costlier mistake. "When borderline, junior."

The TODO must **explicitly name the dev tier** (the per-backend encoding, §18: the `assignee` actor on
`service`, the `senior-dev`/`junior-dev` label on `linear`). A split-dev ticket with **no**
dev-tier assignment is invisible to both dev pick-queries — a Sweep-flagged gap, like a missing
`pm`/`qa` owner label. (In a **legacy** project PM adds no dev-tier marker — today's filing.)
