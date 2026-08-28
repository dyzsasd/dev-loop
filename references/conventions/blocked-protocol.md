# The Blocked protocol — conventions §9 pointer file

> Moved out of `references/conventions.md` §9 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §9's contract: read it at the trigger moment the §9 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

When Dev cannot proceed — missing info, contradictory acceptance criteria, a
dependency, or a suspected-but-unconfirmed duplicate — it does **not** guess:

1. Add the `blocked` label + the routing label (`needs-pm` for features,
   `needs-qa` for bugs).
2. Remove its own assignment and move the ticket back to `Todo` (it is not being
   worked) — the `blocked` label keeps it out of the normal pick set.
3. Add a comment stating **exactly** what's missing or wrong and what would
   unblock it, and **tag the bail shape** on the first line so the right owner
   routes it deterministically (no human prompt — async triage):
   `Bail-shape: <info-needed | decision-needed | scope-design | external-prereq | fix-exhausted>`.
   - **info-needed** (missing repro/seed/account/clarification) → QA can clear it
     (QA Job B), even if not tagged `needs-qa`.
   - **decision-needed / scope-design** (a product/scoping call) → PM (`needs-pm`)
     or the bug's owner.
   - **external-prereq** → park + hand to the §9c tracker protocol; report as a
     fact (§12a), don't retry. The bail comment MUST add a second machine-parseable
     line naming the kind — `External-kind: code` (another repo/team must change
     code) or `External-kind: access` (credentials/money/legal/permission) — and apply
     the **`external-prereq` workflow label PLUS** the matching kind sub-label
     (`external-code`/`external-access`) — the W5 queries key on `blocked`+
     `external-prereq`; a park without the label is invisible to the tracker pass. The kind decides whether
     PM can route it as real work inside the team or must human-park it.
   - **fix-exhausted** (tried, couldn't make the gates/self-review pass) → don't
     blindly re-attempt; it needs new info or a different approach. Cap blind
     retries at 2 — the 3rd is a block, not another attempt.

**Block-cycle cap (mirrors the retry cap).** The info-needed↔resolve round-trip
(Dev blocks `info-needed` → QA/PM resolves → Dev finds the spec still ambiguous →
blocks again) is otherwise unbounded and burns a full fire each lap. Count the prior
`Bail-shape:` comments on a ticket (their first line is machine-parseable); on the
**3rd** `blocked` application to the SAME ticket, escalate instead of round-tripping —
to **senior-dev direct-code** in a split project (the ambiguity needs a design call,
not another Q&A lap), or a **`Human-Blocked`/`external-prereq`** park otherwise. Sweep's
board-health digest reports any ticket with ≥2 block cycles so the thrash is visible
before it is expensive.

PM/QA, on each run, check for **their** blocked tickets
(`project` + `label:"dev-loop"` + `label:"blocked"` + their owner label — always
include `project`; an unscoped label query returns blocked tickets from *every*
dev-loop project and you must never touch another project's backlog, §2).
**PM additionally scans `blocked`+`needs-pm` ACROSS owner labels** (same `project` +
`dev-loop` scope, no `pm` owner filter): a qa-owned Bug parked `decision-needed` routes
to PM via the `needs-pm` ROUTING label, not the owner label — without the cross-owner
scan it is invisible to every unblock query while QA is explicitly deferring it to PM.
For each:
read the comment, then either
- **resolve** — add the missing info / fix the criteria, remove `blocked` +
  `needs-*`, leave it in `Todo`; or
- **cancel** — if the block reveals the ticket is invalid, set `Canceled` (or
  `Duplicate`) with a comment.

**Resolving means unblocking.** A block that's really a question or a design/scoping
decision the owner can answer is resolved by answering it **and** removing `blocked`
+ `needs-*` (encode any safety in the acceptance criteria — e.g. a feature flag, a
regression test — so Dev proceeds safely), not by replying and leaving it parked.
Reserve a standing block / user-escalation for decisions only a human can own:
irreversible/destructive prod actions, money, legal, or security sign-off.

**A standing escalation can resolve out-of-band — re-scan, don't fire-and-forget.**
When you escalate to the user, the resolution often arrives as a **comment** on the ticket
(an authorization, the decision you asked for), and `blocked` may get stripped while a stale
`needs-*` lingers — so a plain `label:"blocked"` query misses it. Each run, also re-read the
latest comment on tickets you parked, and treat a `needs-*` label without `blocked` as
"finish the job." Once the human supplies the decision, the block is resolved: clear the
stale routing label and act. If the now-unblocked action is itself sensitive/irreversible,
the **owner executes it attended** (verify precondition → use the safe/records-only command
form → verify end state), rather than routing an irreversible op into another agent's
unattended auto-pick set.

Dev's pick query (§5) must exclude `blocked` tickets.

> Optional board nicety: the user may add a real "Blocked" workflow state in the
> Linear UI. If they do, set `blockedStateName` in config and the agents will use
> the state instead of the label. Until then, the label is authoritative.
