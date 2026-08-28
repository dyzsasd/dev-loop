---
slug: SH-ship
kind: mechanical
pulls: references/conventions/landing-pr.md (pr-mode ship + PR-CI gate §12c), references/conventions/worktree-landing.md (the §7 merge-back), references/conventions/codex.md (§24 review/rescue/imageGen), references/ticket-templates.md (the split / [coverage] follow-up body)
---

# SH-ship — implement, gate, self-review, ship, smoke, hand off (conventions §15, §12b/c/d, §7)

Shared by every Dev tier — the canonical Step 4→7 ship sequence. The constitution's invariants bind every step
(green gate, push-guard, deploy ceiling §12d, autonomy §12a, security §16); this is the procedure on top. One
verified increment per ticket.

## Step 4 — Implement
Work in the target repo (§19) — in the ticket's per-ticket worktree wherever §7 mandates one (a split tier, or
`git.landing:"pr"`); only the legacy solo dev in `landing:"direct"` works in the shared checkout. Read the
resolved `contributorSkill` first (else the repo's CLAUDE.md) and match its style. Make the **smallest change
that satisfies ALL acceptance criteria.**
- **Cover the change (§15):** a `Bug`/`Feature` gets a regression test THIS run (fails-before / passes-after,
  run in the Step-5 gate) OR a deduped `[coverage]` follow-up filed BEFORE hand-off; exemptions per §15, stated
  in the hand-off. **Codex (§24):** an AC-required image asset goes into `codex.assetsDir` and ships like any file.
- **Too big, or a part the gates can't verify? SPLIT:** ship the foundational, low-risk, testable slice now;
  file the deferred slice(s) — same type/owner labels + `dev-loop`, `relatedTo` the original, `Backlog` (§5a),
  crisp ACs, inheriting the parent's `repo:<name>` (§19). **Filing the follow-up is mandatory, YOURS, and BEFORE
  the parent moves to `In Review`** — the hand-off MUST cite the new ticket's ID. Still BLOCK (don't split) when
  the ticket is UNCLEAR — splitting is for clear-but-large.
- **Dormant-behind-a-flag** (a flag OFF by default ⇒ 404/no-op until a human flips it after manual QA): build
  the WHOLE ticket and ship it dormant — the gates verify the OFF state (zero public surface), unit-test the
  security-critical core (token/authz/rate-limit), and spell out the human enable-then-QA step in the hand-off.
  Don't re-split it.

## Step 5 — Gate before shipping
- **`git.landing:"pr"`: the PR's CI IS the build/test gate (§12c), not a local run.** Don't run — or require a
  local toolchain for — `build`/`test` here; open the PR (Step 6), let the repo's PR-validation build+test it,
  merge only on green at Step 0.5, iterate on a red check. Step 5.5 still runs.
- **`landing:"direct"` / `deploy.style:"command"`: the local gate is the only pre-land gate.** Run the resolved
  `build` commands (`typecheck`, `build`, `test`, `quality` — §19) in order; one you can't fix ⇒ revert your
  change and block the ticket with the failure (§9). NEVER push or deploy a red build.
- **Two under-test traps:** a glob test command may run only the FIRST file (`tsx tests/*.test.ts` / bare
  `node` treat extra args as argv) — verify the WHOLE suite runs, iterate file-by-file if not. Never run
  prod-mutating tests as a gate (real DB client / prod `DATABASE_URL` / live APIs can MUTATE prod) — run the
  safe subset + your regression test, report what you skipped.
- **Throttle:** the full suite is a SHIP gate, not an edit loop. Between edits run ONLY the affected file(s);
  the FULL suite runs exactly twice per ticket (first commit + here). Commit a green slice every ~30min; past
  ~45min stop adding scope — commit, hand off, note the remainder.

## Step 5.5 — Self-review the diff (autonomous gate, not a human wait)
After the build/test gates pass, before shipping:
1. **Spec compliance first:** read your actual diff line-by-line against the ACs — the §3 classes: fix any
   MISSING / MISUNDERSTANDING, trim unjustified EXTRA. Verify against the DIFF, not memory.
2. **Code quality:** run a code-review pass on the diff (a `code-review` skill/command at effort `medium` if
   available; else the equivalent — correctness, security, regressions). **Critical/High findings BLOCK:** fix
   them this run, or revert and block `fix-exhausted` (§9) with the findings — never route code-fixing to
   PM/QA, never wait for a human. Medium/Low/nits: apply the cheap ones, note the rest. Codex (§24):
   `codex.review` adds an independent second-model pass (its Critical/High block too — run both);
   `codex.rescue` is ONE gated pass before a `fix-exhausted` block (ship its patch only if it passes these
   same Step-5 gates + this self-review).
3. Trivial diffs (docs-only / typo / one-line config) skip the full review — note why.

The §16 doctrine binds every ship (constitution: Security): no secrets or user PII in the diff, commits, or
hand-off.

## Step 6 — Ship (per config, only after green gates)
Any flag `false` ⇒ stop at that step and note it in the report.

**`git.landing:"pr"` (§12b — pull `references/conventions/landing-pr.md` for the mechanics):** in the ticket's
worktree on `dev-loop/<id>` (§7), commit only this ticket's files, push, open the PR via `gh pr create`,
comment the URL.
- `git.autoMerge:true` (§12c) ⇒ the ticket STAYS `In Progress` (you own landing it) until Step 0.5 merges the
  green PR — only then `In Review`. Poll the checks yourself; never GitHub `--auto`/branch protection.
- `autoMerge` absent/false ⇒ Step 7 now (a human reviews + merges); `autoPush:false` ⇒ commit locally, note a
  human must push + open the PR.
- NEVER deploy in pr mode — `autoDeploy` is ignored and Step 6.5 does not run.

**`landing:"direct"`:** a split tier lands via the §7 merge-back (sync / rebase-if-stale → ONE `with-repo-lock`
wrapping the `--ff-only` merge + push → cleanup; pull `references/conventions/worktree-landing.md`); only the
legacy solo dev commits in place.
- `git.autoCommit` ⇒ commit on the resolved `defaultBranch` (§19; if absent, on the current branch, noted —
  never a divergent branch), message referencing the id + co-author trailer. `git.autoPush` ⇒ push (the
  constitution's push-guard / fast-forward-only rule binds).
- **Before ANY deploy step apply the constitution's Deploy ceiling (§12d):** a `"manual"` `team.deployPolicy`
  env is a HARD BAIL + operator park, never a prompt (command-shape deploys with no env mapping = prod).
- `git.autoDeploy` + a resolved `deploy.command` ⇒ run it and confirm success. A repo with NO deploy skips it
  and NEVER inherits another repo's command/healthCheck (§19). Confirm the blast radius once on the first prod
  deploy of a session (and on any mid-run `mode` override) unless hands-off shipping is authorized — under
  `autonomy:"full"` (§12a) it is STANDING; ship and report the blast radius as a fact.

## Step 6.5 — Post-deploy smoke + autonomous rollback
Only if you actually deployed to prod this step (a `deploy.command` ran):
1. **Smoke-check prod:** the resolved `deploy.healthCheck` (a 2xx URL or exit-0 command); else GET
   `testEnv.baseUrl` root (non-5xx) ONLY when the target repo IS the deployed surface (§19). Tiny and
   high-signal: the homepage + at most one critical route.
2. On failure retry ONCE (a flaky cold start); still failing ⇒ roll back: `git revert --no-edit` ALL
   commit(s) you shipped this run on the resolved `defaultBranch`, push, re-run the `deploy.command` (§19; a
   split tier runs the revert + push under the §7 lock), confirm the smoke passes. Reopen the ticket to `Todo`
   with `Bail-shape: fix-exhausted` (§9), commenting what broke, the reverted sha(s), and that prod was
   restored.

## Step 7 — Hand off to In Review
`state:"In Review"` (verify, §10) + a comment: what changed, where (files/routes), how you verified the gates,
the commit/deploy ref if shipped, and a pointer to the ACs so the owner (PM for features, QA for bugs) can
verify. A partial ship MUST cite the follow-up ID filed this run (Step-4 split); a `Bug`/`Feature` hand-off
MUST state its §15 coverage outcome (the regression test, the `[coverage]` ID, or the exemption). Loop to the
next ticket.

## Exit criteria & when blocked
The ticket is `In Review` with a complete hand-off (or `In Progress` pending a Step-0.5 PR merge under
`autoMerge`), the gates were green, no Critical/High finding is unresolved, and any split/coverage follow-up is
filed and cited. Cap ≤3 shipped implementations per run — one ticket = one focused change. A gate you can't fix
or a Critical/High finding you can't resolve ⇒ revert + block `fix-exhausted` (§9), never a human wait; only
missing EXTERNAL inputs stop you (constitution: Autonomy), and an irreversible prod op you do ATTENDED yourself.
