---
slug: SW-sweep
kind: mechanical
pulls: skills/playbooks/file-ticket.md (the mirror-poller intake shape), skills/playbooks/block-park.md (the §9c external-prereq tracker), references/conventions/labels.md (the §4 taxonomy), references/conventions/two-tier-dev.md (§21b dev-tier faults), references/conventions/multi-repo.md (§19 repo target), references/conventions/strategy-doc.md (§20 direction sections + the D4 section-level write policy)
---

# SW-sweep — the lifecycle hygiene sweep (Sweep's one job)

Sweep's single job, the executable expansion of the `job:sweep` span. Owner agents are each scoped
to their own owner label (`pm`/`qa`) or to `Todo`-minus-`blocked`, so a ticket missing its owner
label, mislabeled, or stranded mid-lifecycle has NO caretaker and stalls forever. Find exactly those
cracks, re-route them so the right agent picks them up, and report board health. **When in doubt,
report — don't mutate.** Every op rides the configured backend (§18); every query is project-scoped
(§2); every write re-passes the FULL label set and re-fetches to verify the move (§10 hazards).

## Preconditions
- Hygiene ONLY: your mutations re-route EXISTING work — never verify, implement, ship, or file
  product work. The ONE sanctioned create is Step 5's mirror-poller `needs-pm` intake (a human's
  words, not yours), filed via SH-file-ticket.
- Terminal tickets (`Done`/`Canceled`/`Duplicate`) are never touched.

## Steps (run in order)

1. **Stranded & mislabeled** (the core pass). Query `project` + `dev-loop` in non-terminal states;
   inspect each ticket's labels against the §4 taxonomy:
   - *Stranded design child* — a `Backlog` ticket whose FIRST-token `Design:` bare line points at a
     `relatedTo` design parent that is `Done` ⇒ finish the crashed promotion: `Backlog → Todo` (§21a
     design-gate residue; Backlog is invisible to every dev pick-query). A ticket that merely mentions
     `Design:` in prose (backticks / mid-sentence) is NOT a design child. Parent `Canceled` ⇒ cancel
     the child too (it references a superseded design).
   - *Un-owned `Todo`* (`pm`/`qa` both absent) — intake that bypassed the §5a gate: move to `Backlog`
     + `needs-pm`, comment `routed to PM intake (§5a): un-owned Todo ticket`. In `Backlog`/other
     states, assign the owner by type (`Feature`→`pm`; `Bug`→`qa`; `Improvement`→`pm`, `qa` if
     `coverage`/`tech-debt`).
   - *Owner/type contradiction* (a `Bug` tagged `pm` only, a `Feature` tagged `qa` only) ⇒ fix the
     owner label to match the type.
   - *Missing type label* ⇒ set it only when title/body are unambiguous; else comment + report for the
     operator — never guess a type.
   - *Missing/contradictory `repo:<name>`* (multi-repo only, §19) ⇒ flag for the owner + report; never
     guess a repo (a wrong target ships to the wrong tree). Single-repo projects have no `repo:*`; skip.
   - *Dev-tier faults* (split-dev only — §21b explicit signals, tier encoded per §18): NEITHER
     `senior-dev` nor `junior-dev` on a `Todo` dev ticket (not `blocked`, not a design parent awaiting
     its gate) ⇒ invisible to both dev pick-queries — route it: `sensitive` (or plainly
     auth/payment/PII/secrets/data-migration) ⇒ `senior-dev` ALWAYS (§21b override); else default
     `junior-dev`; `senior-dev` only when title/body clearly describe a new module/feature needing
     design ("borderline ⇒ junior"). BOTH tier labels ⇒ concurrent double-implementation — keep the
     §21b-correct tier, drop the other. Comment every fix; legacy single-dev projects carry no tier
     labels — skip. A ticket stuck `In Review` is usually this bug — fixing its owner label is what
     lets PM/QA finally verify it.

2. **Orphaned `In Progress`.** A claimed-then-crashed fire (§7) strands its ticket; a Dev's own
   reclaim only covers tickets assigned to THAT dev. For an `In Progress` ticket with **no shipped
   artifact** on the target repo's resolved `defaultBranch` (the repo named by `repo:<name>` §19 —
   unresolvable ⇒ flag for the operator, never reclaim a guessed tree), no commit referencing the
   ticket id, AND no `updatedAt` movement for a clear interval (default ≥6h): unassign, reset to
   `Todo`, comment `Orphaned — reset from a stalled/aborted run; re-queued.` **In `git.landing:"pr"`
   an open or merged `dev-loop/<id>` PR IS the shipped artifact** — check `gh pr list --search
   "head:dev-loop/<id>"` before treating a pr-mode ticket as an orphan (it legitimately sits `In
   Progress` while CI/auto-merge runs). Reset only with no PR AND no commit AND no movement; a shipped
   artifact ⇒ leave it (Dev reconciles it).

3. **Stale workflow signals** (conservative). `needs-pm`/`needs-qa` WITHOUT `blocked`, un-acted for a
   clear interval ⇒ a one-line resurfacing comment for the owner; strip a routing label only when
   plainly contradictory (both at once). Owners run their own blocked queues (§9) — make work visible,
   never pre-empt their judgement.

4. **Backstops** (report the counts of each):
   - *W5 external-prereq unpark + tracker hygiene (§9c)* — backstop PM's tracker pass every fire: (a)
     **unpark** exactly per §9c — ≥1 LIVE blocker edge with ALL blockers `Done`/`Canceled` ⇒ labels
     off, back to `Todo`, `Unparked: blocker <id> resolved`, retire the edge; **zero live edges is
     NEVER a candidate**. (b) **tracker hygiene** — close a tracker whose dependents are all
     closed/unparked (provable only structurally by incoming `blockedBy`/`Blocked-by:` edges; no
     incoming edge ⇒ leave it). (c) **digest flag** — a `blocked`+`external-prereq` ticket with NO
     tracker edge and NO `External-kind:` line is a legacy park PM must re-triage. See SH-block-park.
   - *Bail-shape label backfill (Decision 1, §9)* — for a non-terminal `blocked` ticket carrying a
     parseable `Bail-shape: <x>` comment (first line) but NOT the matching bail-shape label
     (`decision-needed`/`info-needed`/`scope-design`/`external-prereq`/`fix-exhausted`), set that ONE
     label — REPLACE the full set (§10), keep `blocked` + owner/routing labels, drop any OTHER
     bail-shape label so exactly one remains (newest comment wins), re-fetch to verify. A `blocked`
     ticket with NO parseable bail-shape comment is the unroutable hole — leave it for the owner
     (don't invent a shape); count it in the digest.
   - *D4 direction-doc audit (§20, report-don't-mutate)* — repo-file `strategyDoc` projects only
     (hub-doc projects skip — the operator-publish gate already holds the direction line). Audit the
     doc-home repo's recent doc-only commits touching the strategy doc (bounded — since your last fire
     / a ~24h window; `git -C <repo> log -p -- <path>`). A diff changing a **direction section**
     (`Vision`/`Goals (north star)`/`Non-goals`/any `Appetite`/`No-gos` heading) must trace to an
     approved §9a `investigation` ticket; one with NO linked approval is a policy breach — flag the
     commit + section in the digest, NEVER revert or edit the doc. Progress-section commits are PM's
     autonomous lane — never flag those.

5. **Board-health digest** (report only, no mutation) **+ mirror.** The digest is one screen of
   systemic drift for the operator: `[coverage]` tickets outstanding in `Todo` (Dev behind on the
   regression net, §15); blocked tickets grouped by bail-shape (§9 — a stack of `external-prereq` =
   the loop is waiting on the operator); oldest `In Review` age (verification lag); owner-liveness
   strandings (an owner label whose actor never fires; suggest re-owner, or `agents.<h>.manual:true`);
   design docs still ACTIVE for retired modules (flag as `doc archive` candidates for senior-dev — you
   never archive a doc yourself); the Step-4 counts/flags; everything you fixed or flagged this fire.
   Then the **mirror** (`backend:"service"` + `mirror` config only, §18; absent or under `linear` ⇒
   skip, fail-closed): call `mirror.push(...)` once with the config's values (`tokenEnv` is an env-var
   NAME — the hub reads the Linear token server-side; you never see the secret, §16); with a
   `projectId` the push ALSO mirrors published strategy/roadmap/decisions + LATEST design docs as
   Linear Documents. Then `mirror.pollComments(...)`: it files ONE `needs-pm` Backlog intake per NEW
   human comment on a mirrored doc and ONE High `needs-pm` intake per detected Linear-side body edit —
   these carry a human's words (the ONE create Sweep may make), filed via SH-file-ticket, deduped via a
   machine-local ledger. The push is ONE-WAY hub→Linear, incremental (hash-skipped); a human edit on a
   mirrored issue is overwritten next push. Never block on the mirror: a `failed > 0` push/poll is
   logged + retried next fire. In `dry-run` the hub's `DEVLOOP_MIRROR_DRYRUN` makes push a no-network
   preview and poll read-but-preview (no ticket filed, no ledger byte).

## Team scope (§27)
Under `DEVLOOP_TEAM_SCOPE=1` you fire once for the whole team (cwd = workspace root): repeat Steps 1–5
per **enabled** project in your Scheduler context (same per-project scoping; skip disabled). On
`service` you boot as `_team` — reach each project's board via the D1 steward `project` override on
every hub call (§18); omit it only for the `_team` board itself. Also reconcile open §9b team-intake
parents (In Review, split by PM): every child `Done` ⇒ move the parent `Done` with a per-child outcome
comment; any child parked/blocked ⇒ leave it In Review and comment which child blocks; no child
back-links yet ⇒ not yet split — leave it for PM.

## Exit criteria
Every crack found is re-routed to an owner, reset, or flagged in the digest; nothing stranded outside
every owner query; the digest emitted and (where configured) the mirror pushed/polled. A clean board
is a terse no-op. `dry-run` writes nothing (board or ledger) — list intended fixes.

## When blocked
An ambiguous fix (type, owner, repo) is reported in the digest as a fact, never guessed — a wrong
re-label mis-routes work, which is worse than a flagged one. A §16 broader-access finding is a
stop-and-surface fact, not a probe.
