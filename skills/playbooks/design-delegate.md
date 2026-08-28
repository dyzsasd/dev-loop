---
slug: SH-design-delegate
kind: judgment-scaffold
pulls: references/conventions/two-tier-dev.md (the §21a design-and-delegate contract), references/conventions/strategy-doc.md (traceability), references/conventions/multi-repo.md (repo target §19), references/conventions/blocked-protocol.md (the block bail-shape + §9c external-prereq tracker — read at the block/bail-shape moment), references/conventions/auto-merge.md (the §12c fire-start merge pass — read when autoMerge/release-pr is set), references/ticket-templates.md (the child ticket body)
---

# SH-design-delegate — author the module design, stage junior children (conventions §21a)

Senior-dev's design mode. The design content is the JUDGMENT; this playbook fixes the ENVELOPE — where the
doc lives, what it must contain, how the children are staged, the gate it hands to — and frames the design
step without writing it for you. Self-contained for a design fire (reclaim → author → spawn → hand off); the
code path (`job:directcode`) is a different fire.

## Step 0 — Reclaim a design orphan (crash recovery)
Query `In Progress` in your slice (`project` + `dev-loop` + the §18 senior filter). For each design parent:
children spawned + parent back-linked ⇒ finish the hand-off (parent → `In Review`). Otherwise reset the
parent as an orphan (clear the claim, `Todo`, full label set §10, `Orphaned — …re-queued.`, verify §10) and
`Cancel` any half-spawned `Backlog` stragglers — find them by `relatedTo:<parent-id>`, NOT your slice filter
(they are junior-assigned; a slice query misses them and a re-design would double them).

**Merge eligible loop PRs (§12c).** When `git.autoMerge` and/or `deploy.style:"release-pr"` are set, run the
§12c fire-start pass here too (a design fire may be the only fire firing): merge **every open `dev-loop/*`
feature PR regardless of author** (not just your own), `auto:true` deploy PRs only — `git worktree prune`
first, then read `references/conventions/auto-merge.md` for the exact merge/fix/rebase caps. Both off ⇒ no-op.

## Steps 1–3 — Pick, claim, groom for design
Pick the top senior-assigned `Todo` in your slice (§5 order, §18 filter, `blocked` excluded); claim it
(`In Progress`; the assignee stays `senior-dev`), re-fetch — lost the race ⇒ pick the next (§7). Groom:
duplicate (§8) ⇒ `Duplicate`; already covered by an existing design ⇒ comment the doc + hand off/`Cancel`;
multi-repo target missing (§19) ⇒ block `info-needed`/`scope-design` to the owner (never `repos[0]`). A design
ticket that lacks **clear product intent + the strategy/roadmap item it serves** is under-specified ⇒ block
`decision-needed`/`needs-pm` (`Bail-shape:` first line); don't guess the product. Any block (§9): set
`blocked` + the routing label, **unassign**, move the parent back to `Todo`, and comment the exact gap with
`Bail-shape:` on the first line; an `external-prereq` park also carries the `External-kind: code|access` line
+ the `external-code`/`external-access` sub-label so the §9c tracker re-surfaces it — a park without the label
is invisible to the tracker. Read `references/conventions/blocked-protocol.md` at the bail-shape moment.

## Step 4 — Author the design & delegate
1. **Author the design at the §21a granularity.** Substantial / module-level work ⇒ the **LIVING per-module
   doc**, home per backend (§18): `service` ⇒ the hub `design` doc-kind (`doc.save` — multi-instance, NOT
   publish-gated: your saved draft IS the live design; CAS recovery per §18); `linear` ⇒
   `docs/design/<slug>.md` committed in the doc-home repo — commit ONLY that file (staging discipline) and run
   the commit (+ push) under `dev-loop with-repo-lock` (§7). A small feature ⇒ NO separate doc; the parent
   ticket body IS the design (`Design: parent <id>`).
   - It is a PRODUCT doc you author AUTONOMOUSLY (as PM commits the strategyDoc) — NOT a §17 governing file,
     NOT operator-publish-gated; the gate is the parent reaching `In Review`.
   - It MUST cite the strategy/roadmap item it serves (§21a traceability) — an uncited design bounces at PM's
     gate. Pull `references/conventions/strategy-doc.md`.
   - Write it **implementable by a cheaper model:** the module's responsibility, the data/contracts/types it
     touches, the file/route surface, the sequencing of the children, and each child's testable acceptance
     bar. Ambiguity you leave becomes a junior block routed back to you.
   - Retire, don't delete (§21a / D6): a superseded module's doc is ARCHIVED (`dev-loop doc archive --slug
     <module>` on `service`; a one-line commit moving it to `docs/design/archive/` on `linear`) and the
     superseding doc names what it replaced.
2. **Spawn the concrete child dev-tickets** (§21a contract): junior-assigned (§18); created in **`Backlog`**
   (staged — UNPICKABLE until the gate, never `Todo`); exactly ONE `Design:` pointer line (the three §21a
   forms); `relatedTo:[<parent>]` mandatory; the right type + verifier label (`Feature`/`Improvement`+`pm`,
   `Bug`+`qa`) plus `dev-loop`, the `junior-dev` tier marker, the `repo:<name>` target (§19), a priority, and
   crisp, observable, testable ACs — each child one verified increment. Pull `references/ticket-templates.md`.
3. **Back-link the parent in one write:** `relatedTo` all children + a `Designed into: <ids>` comment.
4. **Move the design PARENT to `In Review`** for PM's design gate (verify-after-write, §10) — you do NOT mark
   it `Done`; PM verifies and promotes the children `Backlog → Todo` on pass (operator sign-off for a
   big-module design is PM's call). Comment the design pointer + the child IDs so PM can verify.

## The judgment step (framed, not scripted)
You decide the module's shape and how to decompose it. *Good looks like* a coherent, traceable design a
cheaper model can implement child-by-child with no further design decisions, each child independently
verifiable. *Avoid* leaving architecture undecided (that becomes a junior block), promoting children to
`Todo` (skips the gate), or a design that cites no strategy item.

## Exit criteria
The design is authored (living doc or ticket-spec), every child is staged in `Backlog` with its `Design:`
pointer + `relatedTo` parent, the parent is `In Review` for PM's gate. Cap ≤3 tickets/run (a design parent +
its children counts as one).

## When blocked
Missing product intent / strategy item ⇒ block to PM (§9), the async path, never a prompt. A big-module design
needing operator sign-off is PM's call at the gate, not a mid-fire wait.
