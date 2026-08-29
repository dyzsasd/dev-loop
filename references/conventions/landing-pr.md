# Landing mode — the `pr` flow and its verification — conventions §12b pointer file

> Moved out of `references/conventions.md` §12b (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §12b's contract: read it at the trigger moment the §12b stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

- **`"pr"`** — Dev does **not** commit to `defaultBranch`. Per finished ticket it:
  1. `git fetch`, then branches **`dev-loop/<ticket-id>`** off the up-to-date
     `origin/<resolved defaultBranch>`.
  2. Commits **only** that ticket's files (staging discipline §7) with the ticket-id, the
     repo's commit convention, and the co-author trailer.
  3. Pushes the branch and opens a PR to the resolved `defaultBranch` via **`gh pr create`**
     (title per the repo's PR-title rules; body links the ticket + a one-line summary +
     how-to-verify). `gh` must be installed and authenticated.
  4. Comments the PR URL on the ticket, then moves it to **`In Review`** (Step 7).
  It **never deploys** in `pr` mode — `autoDeploy` is ignored and dev-agent **Step 6.5
  (post-deploy smoke + rollback) does not run**; the human's merge is what ships (their
  CI/CD deploys on merge). `pr` REQUIRES a remote — the branch has to reach origin before a PR
  can exist — so a repo with none cannot run this mode; it lands `direct` (§7) instead.

**Artifact / resume detection (every Dev fire's Step 0) in `pr` mode:** "already shipped
this ticket" = an **open or merged PR referencing the ticket id**
(`gh pr list --search "<id>" --state all`) or the `dev-loop/<id>` branch on origin — **not**
a commit on `defaultBranch`. Use that so a ticket whose PR is open (awaiting the human's
merge) is never re-implemented.

**Verification (PM/QA Job A) in `pr` mode:** an `In Review` ticket is a change **awaiting the
human's merge + deploy**. Gate verification on what is **actually observable on the running
target env** — **merging a PR is NOT the same as the change being deployed**: many pipelines
need a separate deploy step (a `deploy/*` PR to merge, a `workflow_dispatch`, a promotion
job), so a ticket can be merged-to-`main` yet not yet live on the test env. So:
- may pre-read the PR diff + the PR's own CI (build/lint) — but do NOT mark Done off the diff.
- **Change not yet observable on the running env** — PR still open, OR merged but the deploy
  step hasn't run yet (the env still shows the old behavior/version) → **NOT a verify-fail**:
  leave the ticket `In Review` and move on (the human is the gate). Comment the current
  wait-state **once** (`awaiting human merge (PR <url>)` while open; `awaiting deploy` once
  merged) — if that note is already there from a prior fire, skip it silently (don't re-comment
  every fire). When possible, confirm "not deployed yet" positively (e.g. the env's
  version/build endpoint still lags the merged change) rather than inferring it from the
  feature's mere absence.
- **Change observable on the env AND meets acceptance criteria** → `Done`.
- **Change observable on the env but wrong** → failed review: close + follow-up (§3).
- **PR closed-unmerged** (human rejected) → rejection: `Canceled` + follow-up (§3), noting it.

**On a repo that ships as a published artifact (e.g. an npm package), "merged" and "running"
are DIFFERENT states, and a verifier must say which one it established.** This rule governs the
WORDING of your verdict, never its timing:

- **Verified against the merged tree ⇒ close `Done` in that same fire.** State what you
  established — "verified against the merged tree at `<sha>`; merged, not yet published". That
  IS the increment's verification; the artifact it ships in is a separate concern.
- **Do NOT hold a ticket `In Review` waiting for a publish.** Publishing is an operator act on a
  manual gate, so a Done that waits on it stalls the board by construction — the wait is not a
  wait-state, it is a stall, and it is the thing this rule exists to prevent. An unpublished merge
  is tracked by the release-readiness surface (`doctor` W18 + its NEXT hint), never by parking
  tickets.
- **Never write "verified live" for a change that is only merged.** Claiming *live* requires
  exercising the artifact the fires actually run.

(The §12b wait-state above — "PR open" or "merged but the deploy step has not run" — is about an
env that will update on its own. A publish that only a human can trigger is not that case.)

This keeps the loop autonomous **up to the PR**, puts the human gate at **merge** (→ the
env the branch merges into) and again at **release** (→ prod, via the downstream pipeline's
own PR), and never pushes to `defaultBranch`. `pr` is the fit when a repo wants human review
before code lands; `direct` is the fit for fully-autonomous shipping.
