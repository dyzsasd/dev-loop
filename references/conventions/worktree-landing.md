# Per-ticket worktrees — the landing sequences — conventions §7 pointer file

> Moved out of `references/conventions.md` §7 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §7's contract: read it at the trigger moment the §7 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

The worktree pattern (both cases): a dedicated `git worktree` on branch
`dev-loop/<ticket-id>`, at a path **outside the repo**. Ask for that path, never compose it:
`dev-loop worktree path <ticket-id> --repo <repo-ref>` prints it (`<workspace>/.dev-loop/wt/<ticket-id>/<repo-ref>`). It is created off the up-to-date
base before implementing and removed after the ticket lands. The shared checkout stays on
`defaultBranch` throughout; nothing worktree-related ever lands in the repo tree;
`git worktree prune` at fire-start reaps any left by a crashed fire. Base-clone mutations
(fetch / worktree add / remove / prune, and the direct merge-back below) run under
`dev-loop with-repo-lock <repo-ref> -- <cmd>` (§27); worktree-internal work needs no lock.
How a worktree LANDS depends on `git.landing`:

- **`"pr"`** — unchanged: push the branch, open the PR (§12b / dev-agent Step 6); the
  worktree is removed after the PR merges (§12c / dev-agent Step 0.5).
- **`"direct"` — the direct merge-back sequence.** The worktree merges back to the base
  branch; nothing is ever committed in the shared checkout. With the ticket's gates green
  and its files committed on `dev-loop/<ticket-id>` in the worktree (per `git.autoCommit`;
  staging discipline above — only that ticket's files):
  1. **Sync.** `dev-loop with-repo-lock <repo-ref> -- git fetch origin` (when a remote is
     configured — a fetch mutates the shared refs, so it takes the lock). If the resolved
     `defaultBranch` advanced since the branch was created (the other tier landed first),
     `git -C <worktree> rebase origin/<defaultBranch>` (the local `<defaultBranch>` when no
     remote) — worktree-internal, no lock. If the rebase pulled in ANY new commits, re-run
     the build/test gate before landing (the combined state was never built). An
     unresolvable rebase → `fix-exhausted` block (§9).
  2. **Land atomically** — ONE `dev-loop with-repo-lock` invocation wrapping the whole
     fast-forward + push:
     `dev-loop with-repo-lock <repo-ref> -- sh -c 'git checkout <defaultBranch> && git pull
     --ff-only && git merge --ff-only dev-loop/<ticket-id> && git push origin
     <defaultBranch>'` — drop the `git pull --ff-only` AND the final `push` when the repo has
     no remote configured; with a remote, the push is part of the landing and is not
     conditional on any flag (an unpushed `defaultBranch` is an unlanded ticket).
     `--ff-only` is load-bearing: if the merge refuses, the base advanced under you — go back
     to step 1 and retry (cap ~2 cycles → `fix-exhausted` block, §9); **never create a merge
     knot on `defaultBranch`** — rebase in step 1, never merge the base into your branch.

     **If the `git pull --ff-only` refuses**, the shared checkout's `<defaultBranch>` has DIVERGED:
     it holds commits origin does not — another lane's landing that has not been pushed yet. The
     only correct move is to PUBLISH them and retry: `dev-loop push --repo <ref>` (it runs the
     guard, takes the same lock and pushes fast-forward-only), then start again at step 1.
     **NEVER `git reset --hard origin/<defaultBranch>`, and never `git checkout -B
     <defaultBranch> origin/<defaultBranch>`, to "align" a shared checkout.** Both discard every
     unpushed landing in it, including other lanes'. Measured 2026-08-29 on one workspace: a lane
     landed at 15:50:00, a second lane reset the checkout to `origin/main` at 15:51:52, and the
     first landing was destroyed — recovered only because the same fire happened to re-merge the
     same branch seconds later. `push-guard` lists these commits immediately before the push, so
     the set you would be discarding is always named before you can discard it.

     **With a remote, prefer landing from the WORKTREE and never touching the shared checkout's
     branch at all:** `git push origin HEAD:<defaultBranch>` from the ticket's worktree is a
     fast-forward-only publish that origin itself arbitrates, so two lanes cannot race a local
     ref — the loser is refused by the server and retries from step 1. The shared checkout then
     only ever needs a read-only `git fetch`. The merge-back above remains the sequence for a repo
     with NO remote, where a local `<defaultBranch>` is the only place a landing can go.
     `push-guard` enforces this: a merge commit in the landing range is a refusal naming the
     sha, on any repo whose resolved `landing` is `direct`.
     **Pre-push ride-along gate:** a push carries every unpushed commit before yours,
     including work the operator has since Canceled (the MP-275 prod incident). Immediately
     before any `git push` on `defaultBranch`, run `dev-loop push-guard --repo <dir>
     --strict`; exit 1 ⇒ STOP — do not push; comment the finding on your ticket and park it
     `needs-operator` (the canceled commit is the operator's to drop/keep; §21 you never
     rewrite history).
  3. **Clean up** (under the same lock, or a second invocation): `git worktree remove` the
     ticket's worktree, then `git branch -d dev-loop/<ticket-id>`. Deploy (`git.autoDeploy`,
     dev-agent Step 6/6.5) runs from the base clone AFTER the merge-back — the Step-6 flag
     ladder is unchanged; a Step-6.5 revert
     mutates the base clone too — run it under the same lock.

**The legacy solo `dev` in `landing:"direct"` (split off — ONE writer) is explicitly
exempt:** it keeps today's in-place behavior, committing directly on `defaultBranch` in the
shared checkout (§12b). One writer has nothing to race with.
