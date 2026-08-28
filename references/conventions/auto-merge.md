# Auto-merge + release-PR deploy — the fire-start pass — conventions §12c pointer file

> Moved out of `references/conventions.md` §12c (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §12c's contract: read it at the trigger moment the §12c stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

**Fire-start "merge eligible loop PRs" (every dev tier).** Both the feature-PR merge (`autoMerge`)
and the deploy-PR merge (`release-pr`) are async — the checks/build take minutes — so Dev drives
them here, at fire-start (alongside orphan reclaim, Step 0), never inline. In one pass:

First `git -C <repo> worktree prune` (§7). Then:
- **Feature PRs (when `git.autoMerge:true`):** `gh pr list --search "head:dev-loop/ is:open"` —
  for each open PR:
  - `dev-loop pr merge <pr>` — readiness (pending/conflicting/draft/mergeability-unknown)
    and the guard's axes all run INSIDE the verb; do not pre-filter on green or mergeable. It
    squashes only when the axes clear, deleting the feature branch. On exit 0 →
    `git worktree remove --force` the ticket's worktree, move the ticket
    `In Progress → In Review`. Exit 1 = HELD, not merged — each objecting
    guard axis is already on the ticket; a readiness-only hold writes nothing (re-run once the
    forge settles). Exit 5 = landing lock busy — a retry, not an objection. 2 usage · 3 nothing
    evaluable · 4 gate clear but the squash failed. The FAILED / DIRTY / Pending bullets
    below are the remedies for what the verb reports.
  - **a check FAILED** (CI is the build gate) → read the CI log, **fix in the worktree + re-push**;
    cap ~2 cycles → `fix-exhausted` block.
  - **`mergeStateStatus:DIRTY`** (conflicts `defaultBranch` — never self-heals) → in the worktree,
    rebase onto `origin/<defaultBranch>`, resolve, `git push --force-with-lease`; unresolvable →
    `fix-exhausted` block.
  - **Pending** ⇒ leave for the next fire.
- **Deploy PRs (when `deploy.style:"release-pr"`):** for every `deploy.environments` entry with
  **`auto:true`**, `gh pr list --search "head:<deployPrPrefix> is:open"` — the release pipeline's
  deploy PR (**per-release**, not per-ticket; it may bundle several merged tickets). If more than
  one is open, **merge the newest version** and leave older ones for the pipeline to auto-close. If
  **mergeable** and not failing, `gh pr merge <pr> --squash` (NOT `--delete-branch` — the pipeline
  owns those branches) → the repo's deploy workflow runs → the env deploys; then run the env's
  `healthCheck` if set. **`auto:false` envs (prod) are skipped entirely** — the operator's gate.
  (These PRs are `GITHUB_TOKEN`-created, so the PR checks don't run on them; merge on mergeable,
  don't wait for checks that will never report.)

**The machine gate on this pass runs INSIDE `dev-loop pr merge`**, and green checks are not
sufficient: the verb squashes only when the guard's axes clear — a **human's** unresolved
`CHANGES_REQUESTED` or review thread (agent reviewers are excluded — the loop may not merge over a
person's objection), a ticket **not merge-eligible** on the board (already `In Review`, `Canceled`,
or `Duplicate`), and CI freshness (green computed against a base behind the tip). Axes **degrade
silently to a pass** when their evidence is unreachable (no `gh`, forge
unreachable, no hub DB on `linear`). An axis OBJECTION is posted to the ticket once
(idempotent); readiness and CI-pending/unknown holds refuse the squash but write nothing — re-run,
don't wait. `dev-loop merge-guard` stays the read-only/diagnostic
surface (`--json`; `--strict`/`--apply` unchanged) — for inspecting a hold, not the merge path.
