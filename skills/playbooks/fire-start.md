---
slug: SH-fire-start
kind: mechanical
pulls: references/conventions/landing-pr.md (pr-mode artifacts + §12b), references/conventions/auto-merge.md (the §12c merge pass + fix/rebase caps), references/conventions/worktree-landing.md (worktree prune/lock)
---

# SH-fire-start — reclaim orphans + merge eligible loop PRs (conventions §12c, §12b)

Shared by every Dev tier (legacy `dev`, `senior-dev` direct-code, `junior-dev`). This is the fire's
crash-recovery + landing pass, run BEFORE picking new work. Your slice is your own `In Progress` / open
PRs, resolved per backend (§18): the `dev-loop queue` `inProgress` list on `service`, or a
`project` + `dev-loop` + `In Progress` query in YOUR slice on `linear`.

## Step 0 — Reclaim your orphans (crash recovery)
For each `In Progress` ticket in your slice, check the target repo's resolved `defaultBranch` (§19) for a
shipped artifact: a commit referencing the ticket id, or a local commit when `autoPush:false`; in
`git.landing:"pr"` (§12b) the artifact is instead an open or merged PR referencing the id
(`gh pr list --search "<id>" --state all`) or the `dev-loop/<id>` branch on origin — not a `defaultBranch`
commit; in `landing:"direct"` an unmerged `dev-loop/<id>` branch/worktree also counts (finish by landing it
via the §7 merge-back, don't redo the work).
- **Artifact found** ⇒ the prior fire got far: verify and finish / hand it off rather than redoing it.
- **None** ⇒ orphan: clear the claim (unassign), reset to `Todo` (re-pass the FULL label set, §10), comment
  `Orphaned — state cleared from a prior aborted run; re-queued.`, and verify the move (§10).
- An **unresolvable repo target** in a multi-repo project ⇒ don't grep a guessed tree; leave it for
  SH-claim-groom (§19).

## Step 0.5 — Merge eligible loop PRs (feature + deploy, §12c)
Runs only when `git.autoMerge` and/or `deploy.style:"release-pr"` are set (both absent ⇒ no-op). Run the
§12c fire-start pass exactly; `git worktree prune` first (under the §7 lock). Pull
`references/conventions/auto-merge.md`.

**Feature PRs (`autoMerge`).** For each open `dev-loop/*` PR ⇒ `dev-loop pr merge <pr>` — readiness
(pending/conflicting/draft/unknown) AND the guard's axes run INSIDE the call; do not pre-filter on
green/mergeable. Exit codes:
- `0` ⇒ merged (or already): remove the ticket's worktree, move it to `In Review`.
- `1` ⇒ HELD — guard objections are already on the ticket (readiness-only holds write nothing; re-run once
  the forge settles). Remedies stay YOURS: a FAILED check ⇒ read the CI log, fix in the worktree, re-push
  (cap ~2 cycles; the 3rd is `fix-exhausted`, §9); `DIRTY` ⇒ rebase onto `origin/<defaultBranch>` +
  `--force-with-lease` (unresolvable ⇒ block); pending ⇒ next fire.
- `5` ⇒ landing lock busy, retry next fire.
- `2`/`3`/`4` ⇒ usage / nothing evaluable / squash failed — nothing merged.

**Re-freshen a `stale` hold** (`merge-guard --json` `ciFreshness.verdict:"stale"`: green was computed
against a base behind the tip, yet CLEAN/`mergeable` — LOOP-242) ⇒ rebase the PR branch onto
`origin/<defaultBranch>` + `--force-with-lease` so CI re-runs against the tip; leave it for the next fire.
Cap ~2 re-freshens per PR (the 3rd is a `fix-exhausted` block, §9). NEVER re-freshen a PR the merge-guard
holds for review (`forgeReview.trip`) or `boardState` — a held PR is the author's to resolve, not ours to
rebase. If the re-freshen itself fails: rebase CONFLICT ⇒ `git rebase --abort` + block per §9, no retry (the
tip only moves further ahead) and no slot consumed; `--force-with-lease` REJECTED ⇒ benign race (that push
re-ran CI itself) — re-fetch, `git reset --hard origin/<branch>`, no-op, re-evaluate next fire, no slot
consumed. Either way leave the worktree clean and on a real branch — never strand a detached HEAD.

**Deploy PRs (`release-pr`).** Merge only `auto:true` envs' NEWEST open deploy PR (never `--delete-branch`;
run the env's `healthCheck` after); `auto:false` (prod) is the operator's gate. Idempotent + race-safe;
these are the ONLY merge/deploy actions in this pass (no `deploy.command`, no post-deploy smoke here).

## Exit criteria
Every orphan is either finished/handed off or reset to `Todo`; every eligible loop PR is merged, held with
its objection on the ticket, or left for the next fire. Nothing half-landed and unrecorded.

## When blocked
A merge held on a FAILED check past its fix cap ⇒ `fix-exhausted` block (§9). A rebase conflict you cannot
resolve ⇒ block per §9. Never force-land past a guard hold, never re-freshen a review/board hold.
