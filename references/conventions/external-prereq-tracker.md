# W5 — the external-prerequisite tracker — conventions §9c pointer file

> Moved out of `references/conventions.md` §9c (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §9c's contract: read it at the trigger moment the §9c stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

An `external-prereq` park used to be a dead end: a label + a comment, resurrected only
if a human happened to read it. W5 makes the dependency a first-class, machine-walkable
edge with an owner and an exit condition. No new state machine — three steps:

1. **Track.** PM (Job B), on discovering an `external-prereq` park without a tracker:
   create ONE dedicated tracker ticket for the external need (dedupe first — several
   parked tickets can share a tracker). `external-prereq` + the kind sub-label; type
   `Improvement`; owner `pm`. By kind:
   - `external-code` → the need is actionable INSIDE the team: file the ask as a real
     ticket in the owning project (cross-project → a §9b team intake) — THAT ticket is
     the tracker; it flows through the normal loop.
   - `external-access` → only a human can clear it: tracker goes to the human park
     (`Human-Blocked` on `service`; `blocked`+`needs-pm` park on linear) and PM
     notifies the operator (§9 notify / `dev-loop notify`) — once (`notified`).
2. **Block.** Link the parked ticket to its tracker with a REAL blocking edge, not
   `relatedTo`: on **linear**, `save_issue(id: <parked>, blockedBy: [<tracker>])`
   (append-only; `removeBlockedBy` to clear). On **service** (no native relation),
   write a machine-parseable marker comment on the parked ticket —
   `Blocked-by: <tracker-id>` on its own line — the §18 per-backend encoding of the same
   edge. `relatedTo` remains for kinship; it is NEVER a blocking edge.
3. **Auto-unpark.** Every PM fire (Sweep backstops it): query open `blocked` +
   `external-prereq` tickets; resolve each one's blockers (linear: the issue's
   blockedBy relations; service: the `Blocked-by:` markers). **A ticket with ZERO
   blocker edges is NEVER an unpark candidate** — the empty set is vacuously "all
   resolved", but it just means step 1 hasn't run (or it IS a tracker): route it to
   step 1 / the digest instead. **≥1 blocker AND** ALL blockers
   `Done`/`Canceled` → unpark: remove `blocked` + `external-prereq` (+ kind), move back
   to `Todo`, drop `notified`, and **retire the edge** — linear: the SAME `save_issue`
   passes `removeBlockedBy: [<each resolved tracker>]`; service (comments are
   append-only): the unpark comment carries one machine-parseable line per resolved
   blocker — `Unblocked-by: <tracker-id>` — and edge resolution counts a `Blocked-by:
   <id>` marker as LIVE only when no later `Unblocked-by: <id>` exists. Without edge
   retirement, a later re-park inherits stale Done blockers and instantly self-unparks. Any blocker
   still open → leave parked (no comment spam). A tracker with no live parked
   dependents is closed by Sweep in its hygiene pass.

Trackers are ordinary tickets — visible on the board, reported in digests, countable.
The failure mode this kills: work silently rotting behind a label because the human
forgot which comment said what was needed.
