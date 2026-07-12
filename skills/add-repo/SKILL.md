---
name: add-repo
description: Add a git repo to a dev-loop workspace project IN ONE PASS. Use when the user invokes /dev-loop:add-repo, or asks to "add a repo", "register a repo", "onboard <repo> into <project>", "wire up a new service into the loop", or "share <repo> with another project". Operator-present DETECT → INTERVIEW → REGISTER → MAP — it clones (or registers an existing clone), auto-detects build + PR merge-check names, interviews the deploy shape under the team deployPolicy ceiling, writes through the VALIDATED `dev-loop team add-repo` mutator, provisions the `repo:<name>` label, and appends the repo's current state to the strategy doc. 1.x workspace schema only.
---

# add-repo — register a repo into a workspace project (one pass)

ROLE: You are the operator-present setup skill that makes a git repo a first-class member
of a workspace project in one DETECT → INTERVIEW → REGISTER → MAP pass.

## MISSION

After this skill, `dev-loop doctor` is green and the repo is clonable, buildable,
deployable within policy, and mapped into the project's strategy doc.

## BOOT

Operator-present, but each invocation is fresh (§0); boot per §0a (the Topology block + the
sections cited below). Inputs:
- The workspace `dev-loop.json` (1.x workspace schema), resolved from cwd — none ⇒ tell the
  user to `dev-loop team init` first and stop. Target project missing ⇒ run
  /dev-loop:add-project first.
- `references/config-schema.md` (registry/reference field shapes).
- Conventions context: claiming/worktrees (§7), landing + auto-merge (§12b/§12c),
  multi-repo registry + doc-home (§19), workspace portability (§27).
Sections: §0 §0a §2 §4 §7 §12b §12c §19 §20 §27

## JOBS

### 1. DETECT — identify the repo and where it goes

- Ask (or take from args): the **project key**, a short **repo ref** (lowercase, the
  registry key AND the `repo:<ref>` label — must not collide with a reserved name:
  team/lessons/wt/locks), the **role** (`primary` for the main service, `docs`, or omit),
  and either a `--remote` git URL to clone or an existing path already inside the
  workspace.
- If a remote is given and the target dir does not exist:
  `git clone <remote> <workspace>/<ref>`. If a path is given, confirm it is INSIDE the
  workspace (relative path); a repo outside the workspace breaks the copy-the-folder
  portability rule (§27) — offer to `mv` it in.

### 2. INTERVIEW — build, merge checks, deploy (auto-detect first, confirm with the operator)

- **Build/typecheck:** read `package.json` scripts (`build`, `typecheck`/`tsc`), or the
  repo's equivalent. Propose `--typecheck-cmd` / `--build-cmd`; confirm.
- **Merge checks:** parse `.github/workflows/*` for the **required PR check names** (the
  `name:` of jobs that run on `pull_request`). These become `--merge-check` values — the
  gate `autoMerge` polls (§12c). List them; let the operator prune.
- **Landing (§12b):** `pr` (default; agent opens a PR, CI is the build gate) or `direct`.
  If `pr` + `--auto-merge`, the agent merges its own PR once checks are green (§12c).
- **Ops probes (don't skip — an unprobed deploy is invisible to ops-agent, doctor W07):**
  ask for the repo's health endpoint (probe it live once to confirm a 2xx before
  recording), an optional version endpoint, the critical user-flow routes the operator
  declares "can't be down", and an optional read-only logs/metrics command. Persist via
  `--ops-check <url>` / `--critical-route <path>` / `--logs-command "<cmd>"`.
- **Deploy:** interview the deploy shape (`release-pr` / `command` / none) PER environment.
  **Enforce the team `deployPolicy` ceiling:** if `deployPolicy.<env> = "manual"`, that env
  may NOT be `auto:true` — the validated write (below) will reject it (E06); surface it
  before writing.

### 3. REGISTER — persist through the validated mutator (never hand-edit dev-loop.json)

Call the deterministic, self-validating CLI — it re-validates the whole file and refuses an
invalid result (so you cannot corrupt config):

```
dev-loop team add-repo <ref> --project <key> [--path <rel>] [--remote <url>] [--role <role>] \
  [--landing pr|direct] [--auto-merge] [--merge-check "<name>"]... \
  [--typecheck-cmd "<cmd>"] [--build-cmd "<cmd>"] [--deploy-style release-pr|command] [--ops-check <url>]... \
  [--owner <project>]
```

- **Sharing:** if this repo is referenced by more than one project, the mutator REQUIRES
  `--owner` (which project owns ops/alert routing). It errors (E05) otherwise.
- Deploy `environments` beyond `style` (per-env `auto` / `deployPrPrefix`) are not yet
  flag-driven; after the mutator writes, edit `repos.<ref>.deploy.environments` if you need
  per-env detail, then re-run `dev-loop doctor` to re-validate.

### 4. LABEL + MAP

- **Label:** in the backend, ensure a `repo:<ref>` label exists on the team (linear) /
  project (service) — agents tag work by repo on multi-repo projects (§19). Skip for a
  project's first/only repo.
- **Mini-MAP:** read the repo's entrypoints, routes, and tests (read-only). Append a
  concise "Current state — <ref>" subsection to the project **strategy doc** (§20; via the
  backend doc or the repo file per `docSystem`). Adversarially double-check claims against
  the code before writing.

### 5. VERIFY

Run `dev-loop doctor`. It must show the repo path exists, the deployPolicy ceiling holds,
and the config is valid.

## HARD LIMITS

- Never hand-edit `dev-loop.json` — the validated mutator only (post-write per-env deploy
  edits are re-validated by doctor).
- Enforce the team deployPolicy ceiling (E06) before writing; a shared repo REQUIRES
  `--owner` (E05).
- The repo must live INSIDE the workspace (§27) — offer to move it in; never register an
  outside path silently.
- Backend label provisioning stays within the dev-loop label taxonomy (§4) — the human
  backlog is untouched (§2).

## REPORT

Report the green doctor result (and any W-warnings) and the registered entry to the
operator — the repo is in the loop.
