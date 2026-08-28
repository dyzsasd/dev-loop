# The team daily digest contract — conventions §22a pointer file

> Moved out of `references/conventions.md` §22a (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §22a's contract: read it at the trigger moment the §22a stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

**The digest contract** (defined here once; the communication SKILL cites it, never restates
it). Numbers come from code; narrative comes from the communication agent. Compose EXACTLY
these sections, then push via `dev-loop notify --title "Daily <team> <date>"`:
1. **Team KPIs** — run `dev-loop metrics --window 24h --json` and quote its numbers verbatim
   (fires + success rate + suspectErrors; on service also throughput/accept-rate/blocked). On a
   linear team, compute the board numbers yourself via MCP: shipped (→Done, 24h), verify-fails
   (In Review→Canceled, 24h), Todo depth vs `intake.todoDepthCap`, blocked count by bail-shape.
2. **QA quality** — bugs filed (24h) vs escaped-to-prod (`incident`/`signal` Bugs); re-test fails.
3. **Board flow** — Backlog groomed/promoted by PM (its Job B2 close line), oldest In Review age,
   W5 trackers open.
4. **North-star delta** — one or two lines from reflect's latest weekly delta (see reflect); on
   days without one, the newest strategy-doc Decisions entry, or "no movement".
   Plus one line per doc version the operator published since the last
   digest, quoted as `published vN: <summary>` (the `doc history` summary field — the §9a
   investigation protocol's propagation line).
5. **Needs the director** — ONLY genuinely human-parked items (Human-Blocked / external-access
   trackers); an empty section is a good day. Compose it from these lines, each omitted when zero:
   · **Human-Blocked**: count + the oldest park's age (workflows P3 —
   from the board, never memory; the same numbers the daemon reminder carries).
   · **Awaiting your approval**: In Review tickets assigned to `operator` (the §9a
   board-approval stops), count + the oldest's age. `dev-loop metrics --json` carries the whole
   decision queue verbatim as `.decisionQueue` (Human-Blocked ∪ In Review@operator, oldest
   first) — quote it, never re-derive; the daemon pings the same set (`operator_review.notified`).
   · **Investigation proposals pending**: each open §9a `investigation`
   ticket parked for operator approval, with its doc + version (the ticket's
   `Proposes: doc:<slug> vN (published vM)` line).
   · **Drafts pending publish**: count of docs whose drafts trail the
   published version (`doc list`; mirrors the daemon's `doc_drafts.notified` one-liner).
   · **Unconsumed operator doc edits** (`intake.mode:"passive"` projects
   only): foreign doc versions no PM fire has digested yet (mirrors `doc_foreign_edit.notified`).
Keep it under ~25 lines — a director reads ONE message, not a log.
