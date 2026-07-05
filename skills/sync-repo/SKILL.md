---
name: sync-repo
description: >-
  Re-detect a registered repo's build / merge-checks / deploy shape and remote, and repair its
  clone/worktrees. Use when the user invokes /dev-loop:sync-repo, or asks to "sync the repo",
  "the CI checks changed", "re-detect the build", "the repo moved", or "fix the worktrees". Reports
  drift between the detected reality and the registry, writes only confirmed changes, clones the repo
  if it is missing, and runs `dev-loop team repair` for worktree/index/WAL fixups. 1.x workspace schema only.
---

# sync-repo — reconcile a repo's registry entry with reality

**Preconditions.** A workspace + the registered repo ref exist. Resolve the workspace from cwd; read
`repos.<ref>` from `dev-loop.json`.

## 1. ENSURE the clone

- If `repos.<ref>.path` is missing on disk and `repos.<ref>.remote` is set → `git clone <remote>
  <workspace>/<path>`. If no remote is recorded, ask the operator for one (and record it).

## 2. RE-DETECT (compare to the registry; report drift)

- **build/typecheck:** re-read `package.json` scripts / tsconfig; diff against `repos.<ref>.build`.
- **merge checks:** re-parse `.github/workflows/*` for the current PR `pull_request` job `name:`s;
  diff against `repos.<ref>.mergeChecks` (added/removed checks are the usual reason autoMerge stalls).
- **deploy:** re-check the release workflow / deploy prefixes vs `repos.<ref>.deploy`.
- **remote:** `git -C <path> remote get-url origin` vs `repos.<ref>.remote`.

## 3. APPLY (only confirmed changes; never silently overwrite hand edits)

Present the diff; for each accepted change, edit `repos.<ref>` (via `dev-loop team add-repo <ref>
--project <owner> …` for the flag-covered fields, or a direct validated edit) and re-run
`dev-loop doctor`. Respect the team `deployPolicy` ceiling (E06) — the validated write enforces it.

## 4. REPAIR

Run `dev-loop team repair` — it does `git worktree repair` + prune (fixes absolute-path breakage
after a machine move, §10.3), re-registers the workspace index, and (service) truncates the hub WAL.

## 5. VERIFY

`dev-loop doctor` clean; summarize the reconciled fields for the operator.
