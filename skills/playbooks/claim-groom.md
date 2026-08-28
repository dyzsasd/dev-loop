---
slug: SH-claim-groom
kind: mechanical
pulls: references/conventions/querying.md (the §5 pick order + slice query), references/conventions/blocked-protocol.md (the block bail-shape), references/conventions/multi-repo.md (repo target §19), references/conventions/two-tier-dev.md (tier slice §18)
---

# SH-claim-groom — pick, claim, and groom the next ticket (conventions §5, §7, §8, §9, §19)

Shared by every Dev tier. Turns the ranked queue into ONE claimed, groomed ticket ready to ship — or a
clean block/duplicate that consumes no cap. Your pick set is YOUR slice only (§18): the single legacy `dev`
picks the whole `Todo` queue; a split tier picks only its own (`junior-dev`/`senior-dev` assignee on
`service`, the tier label on `linear`).

## Step 1 — Pick the top ticket
On `backend:"service"` ONE call returns it: `dev-loop queue` — `todo` arrives already in the §5 pick order
(blocked excluded); take the first. On `linear` compose it yourself: `Todo`, `project` + `dev-loop`, YOUR
tier filter (§18), excluding `blocked`, ranked by the §5 pick order. Never a ticket outside your slice, and
never a `Backlog` ticket — staged design children are invisible until PM promotes them at the design gate
(§21a). Pull `references/conventions/querying.md`.

## Step 2 — Claim it (atomic, §7)
`In Progress` + claim (`assignee:"me"`; on `service` a split tier claims its own pre-assignment — the
assignee stays your tier). Re-fetch — lost the race ⇒ pick the next. Apply the §10 verify-after-write to
EVERY state move this run (the hand-off and any block included), and re-pass the FULL label set on any label
change (labels are REPLACE-style).

## Step 3 — Groom it
Walk these gates in order; any hit resolves the ticket and you pick the next (a cheap grooming outcome
consumes no cap):
- **Duplicate (§8)?** ⇒ `Duplicate` + `duplicateOf` + a comment; pick next.
- **ACs already satisfied by current code** (docs / test plans go stale)? Don't rebuild: comment the
  evidence (files / refs), move it straight to `In Review` for its verification owner (or `Cancel` if truly
  obsolete); pick next. Re-implementing done work is waste.
- **Multi-repo target missing or contradictory (§19)?** ⇒ block (§9 — `info-needed`, or `scope-design` when
  the work spans repos and needs splitting), routed to the owner; NEVER default to `repos[0]` (wrong-tree
  hazard). Pull `references/conventions/multi-repo.md`.
- **Under-specified** (no testable ACs / no real repro for a bug)? ⇒ block per §9: `blocked` +
  `needs-pm`(feature) / `needs-qa`(bug), unassign, back to `Todo`, comment exactly what is missing with the
  `Bail-shape:` line first; an `external-prereq` park also carries the `External-kind: code|access` line +
  the matching kind label — the §9c tracker keys on them. Don't guess; pick next. Pull
  `references/conventions/blocked-protocol.md`.
- **A real design decision needed** (a new module shape, cross-cutting architecture, un-specced product
  behavior)? That is not an implementer's call — block `decision-needed`/`scope-design` to the owner for
  routing to the design tier; never quietly design your way out.

## Exit criteria
Either you hold ONE claimed, groomed ticket with testable ACs and a resolved repo target, ready for
SH-ship — or the top ticket was resolved as a duplicate / satisfied / block and you have picked the next.

## When blocked
Ambiguity you cannot resolve into a concrete implementable spec BLOCKS via the board (§9), never an
interactive prompt and never a guess. Splitting is for clear-but-large work (that happens in SH-ship, Step
4), not for unclear work — unclear always blocks here.
