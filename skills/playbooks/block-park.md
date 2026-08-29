---
slug: SH-block-park
kind: mechanical
pulls: references/conventions/blocked-protocol.md (on block/unblock), references/conventions/external-prereq-tracker.md (external-prereq track/block/unpark), references/notify.md (human-park notify), references/conventions/human-park-notify.md (the transport matrix)
---

# SH-block-park — resolve, route, or park a blocked ticket (conventions §9, §9c)

Shared by the owners (PM Job B / QA). This is the CONSUMER side of the blocked protocol: a Dev bailed, and
the owner must resolve it, route it, or park it for a human. Resolving MEANS unblocking — never reply and
leave it parked.

## Bail-shape is a LABEL now (coordinate with the labels workstream)
The bail-shape has been promoted from a comment marker to a first-class **label** so routing is a row
predicate, not an in-fire read. Route by the label:

| Bail-shape label | Owner / action |
|---|---|
| `decision-needed` · `scope-design` | **PM** — answer IN the ticket, encode safety into the ACs (flag-off, regression test), then remove `blocked`+`needs-pm` |
| `info-needed` | usually **QA** (repro/seed/account/clarification) — leave it if you are PM |
| `fix-exhausted` | re-scope or split; do NOT re-block. In split-dev this is the senior-direct-code exhaustion ⇒ human park |
| `external-prereq` | run the §9c tracker pass (below) |

(These labels — `decision-needed` / `info-needed` / `scope-design` / `fix-exhausted` — are added by the
labels workstream alongside the existing `external-prereq`. Reference them by name.)

## Preconditions
- Scans (all `project`-scoped, §2): your own owner-label + `blocked`; the cross-owner `blocked`+`needs-pm`
  scan (PM only, no owner filter); and `needs-pm`/`needs-qa` WITHOUT `blocked` (out-of-band resolutions —
  finish the job, clear the stale routing label).

## Steps
1. **Resolve** (the default): answer / fix, remove `blocked`+`needs-*`, leave the ticket `Todo` (full label
   re-pass + verify `.state`, constitution: Write hazards). Supplying the answer but leaving it parked is
   NOT resolution.
2. **A `[reflect-proposal]` with `## Deferred findings`** is a triage obligation (§17), not context: resolve
   EVERY entry — file it (SH-file-ticket) or write "not filing, because …" on that same ticket. `Deferred`
   is not a resting state.
3. **External-prereq — the §9c tracker** (every PM fire; Sweep backstops). Track ONE deduped tracker per
   need: `external-code` ⇒ a real ticket in the owning project (cross-project via §9b) IS the tracker;
   `external-access` ⇒ human-park the tracker + notify once (`notified`). Block with a REAL edge (linear
   `blockedBy`; service a `Blocked-by: <id>` comment line — `relatedTo` is never a blocking edge). Auto-unpark
   only tickets with ≥1 blocker edge ALL `Done`/`Canceled`, retiring the edge in the same write; a zero-edge
   ticket never unparks. Pull `references/conventions/external-prereq-tracker.md`.
4. **Human-only park** (irreversible prod, money, legal, security): `Human-Blocked` on service; the
   `blocked`+`needs-pm`+`external-prereq` label park + the one-shot `notify` webhook on linear (add `notified`
   only after a successful POST; drop it on unpark). Pull `references/notify.md`. A just-authorized
   sensitive/irreversible op you execute ATTENDED yourself this fire — never hand it to unattended Dev.

   **Under `humanBlocked:"off"` (the fire's knobs line says which) there is nobody to park for.** The write
   layer refuses the move. Instead: **PM decides it** from `team.docs.vision`/the project's strategyDoc and
   the ticket's own facts, records the call as a `Ruling: approve|reject — <why>` comment (PM is the one
   agent identity allowed to post one while "off"), and moves the ticket accordingly. The exception is a
   prerequisite ONLY a human can supply — a credential, an account, an approval (`external-prereq` /
   `external-access`): that still waits, but at **`Backlog` + `blocked` + those labels**, where the §9c
   tracker reads it, NOT in the decision queue. An irreversible prod/money/legal/security action you cannot
   take unattended is not a park either — leave the ticket `Todo` + `blocked` with the `Bail-shape:` comment
   saying what an attended operator must run.

## Exit criteria
Every scanned ticket is resolved (unblocked to `Todo`), routed to its owner, or parked with a real edge /
`Human-Blocked` + notify. No ticket left with a supplied answer still wearing `blocked`.

## When blocked
A genuinely operator-only call parks (step 4) rather than being decided; under `autonomy:"full"` only
missing EXTERNAL inputs park — everything answerable is answered (constitution: Autonomy).
