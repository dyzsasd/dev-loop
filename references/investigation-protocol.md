# The investigation protocol (P4/D4) — approval-gated direction changes

Extracted from conventions §9a. The trigger list and the resident PM rule live in §9a;
this file is the full 7-step flow, read when an `investigation` ticket (or a D4
direction-section edit needing sign-off) is actually in hand.

**The investigation protocol (P4/D4) — propose → the operator approves → then the doc
changes.** The §9a direction intake lets PM digest an ask autonomously (edit the doc,
operator reviews after the fact). Some direction changes must be approved BEFORE they
land: a direction-**section** edit of a repo-file strategy doc (§20 D4 — Vision / Goals /
Non-goals / Appetite / No-gos), a `team.docs.vision` change (D7), or any ask the director
explicitly files for investigation. Those ride this flow — the same §9a machinery with one
approval stop, no new states or tools:

1. **File.** The director files the intake `Backlog` + `dev-loop`+`pm`+`needs-pm` +
   **`investigation`** (§4/§13) — by ANY entry: the hub web ticket form, the CLI, a Linear
   issue, or a comment on a mirrored doc (the §18 `mirror.pollComments` poller converts
   those into exactly this shape). PM opens one itself when a §20 direction-section edit
   needs sign-off (D4).
2. **Investigate.** PM's Job-B `needs-pm` scan picks it up; PM gathers real evidence — the
   board, the repo/code, the running product — and posts its **findings as a comment** on
   the ticket.
3. **Propose** (when a doc change is warranted). Hub-doc backends: PM saves a **DRAFT**
   (`doc.save`, optimistic CAS; the `summary` is **mandatory** here — it is what the
   approval and the §22a digest quote) and records **`Proposes: doc:<slug> v<N>
   (published v<M>)`** on the ticket. Repo-file backends: PM posts the **unified diff in a
   fenced block** on the ticket **without committing**.
4. **Park.** PM moves the ticket to **`In Review` assigned to the operator** — the review
   is the operator's, so PM's own Job A treats an `investigation` ticket as awaiting
   approval, never as work to verify-fail. When the approval needs the operator to act
   **outside the board**, use the §9 human-park semantics instead (`Human-Blocked` on
   `service` — the §9a daemon reminder carries the nudge).
5. **Approve.** Hub: the operator publishes the exact proposed version (`doc.publish
   {version:N}`, operator-only) — **version-bound**: the publish approves precisely the
   content PM proposed, even if newer drafts sit on top; the publish IS the approval, no
   separate comment needed. Repo file: the operator replies an **approval comment**; PM's
   next fire sees it (the Job-B re-read of parked tickets), applies the diff, **commits**,
   and closes the ticket `Done` citing the commit.
6. **Reject / revise.** A rejection is a comment; PM **revises** (a new draft/diff + a
   fresh `Proposes:` line) or **abandons** (`Canceled`, with the reason). Hub drafts are
   never deleted — `doc.history` keeps them as provenance.
7. **Propagate.** Nothing pushes: agents re-read the doc on their next fire (`doc.get`'s
   default read returns the published version, so a publish lands team-wide by itself; a
   repo-file commit is picked up the same way), and the §22a digest carries
   **`published vN: <summary>`** so the director sees the direction land.
