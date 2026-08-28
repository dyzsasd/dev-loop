# Self-evolution boundary — what Reflect may change — conventions §17 pointer file

> Moved out of `references/conventions.md` §17 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §17's contract: read it at the trigger moment the §17 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

The **Reflect** agent (the daily retrospective role) is the one agent that modifies
the loop's own operating instructions, so it carries a special hazard: a daily
self-modifying loop with no review compounds errors. The boundary is bright:

- **MAY edit autonomously: `lessons.md` only.** It is the scoped, **reversible**,
  **per-operator**, never-committed override layer (§14). Reflect curates it from
  **recurring** evidence (≥2 occurrences), every rule citing its evidence (ticket IDs
  / commit shas / window), superseding and pruning to keep it lean. Every change is
  reported so the operator can veto it.
- **MUST NOT auto-rewrite: this `conventions.md` or any agent's SKILL file** (the
  core, shared, committed instruction set). A change there is **drafted as a proposal
  in the report** — optionally a single `[reflect-proposal]` Linear ticket for the
  human — and **never applied** by an agent. That proposal ticket is filed **`blocked`
  + `needs-pm` with `Bail-shape: external-prereq`** so the firewall is mechanical, not
  aspirational: `blocked` keeps it out of Dev's pick set (§5), and `external-prereq`
  makes PM park it for the human (PM Job B) rather than unblock it back into Dev — a
  change to the plugin's own code is the operator's to apply. (Reusing `external-prereq`
  here is **deliberate**, not a misclassification — a plugin self-edit is a
  human-operator prerequisite; don't "correct" it to `decision-needed`/`scope-design`,
  which PM would resolve straight back into Dev.)
- **One ticket per fire, spent on the WORST finding — and nothing else is lost.** The
  single-ticket cap is anti-thrash (a daily self-observer is the easiest agent to turn
  into a firehose), so it stays; what it must not do is order findings by discovery. Two
  rules make it severity-aware:
  **(1) Rank, don't queue** — when a fire produces several structural findings, the one
  ticket goes to the **highest-severity** one, not the first one found.
  **(2) Nothing deferred is lost** — every other finding is listed in that same ticket
  under a literal `## Deferred findings` heading (fixed, so it is greppable), one entry
  each with its evidence and **Reflect's own severity assessment** — which also makes
  rule (1) auditable rather than trusted. **PM must triage every entry in the fire that
  reads the ticket**: each becomes a filed ticket or an explicit "not filing, because …"
  note on that same ticket. `Deferred` is not a state a finding may rest in. (A finding
  parked in a comment thread is reachable only if a human happens to read it — that is
  the failure this closes.)
  A correction that should
  hold for *every* operator belongs here (conventions) or in the `strategyDoc`
  (product direction), reached via that human-reviewed proposal — not via `lessons.md`.

**Operator-review carve-out (§22).** The one relaxation of "only Reflect writes
`lessons.md`": an agent distilling an explicit operator review (点评) of its OWN report may
write the rule into its OWN lessons section — the review IS the human authorization. The
five hard limits + the trust boundary live in §22's `### The §17 carve-out` (the canonical
copy); a structural change (a SKILL/conventions edit) is still drafted as the proposal
above, never an auto-edit.

This is the one principled exception to §12a's "decide and act": self-modification of
the core operating instructions is **surfaced, not executed**, exactly like the
security stop-and-surface case (§16). Reflect is otherwise **read-only on Linear
product tickets** — it observes the loop; it never files Features/Bugs, ships,
verifies, or relabels/re-routes (those are PM/QA/Dev/Sweep).
