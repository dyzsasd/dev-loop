# dev-loop — Config schema

The PM/QA/Dev agents read `${CLAUDE_PLUGIN_DATA}/projects.json`. It maps each
product to its Linear project, its repo, its test environment, and its
ship/deploy settings. One file, many products.

## Schema

```jsonc
{
  "defaultProject": "monpick",        // used when the user doesn't name one and >1 exist
  "projects": {
    "<key>": {                        // short slug you'll refer to (e.g. "monpick", "geo")
      "linearTeam":    "Citronetic",  // Linear team name (required)
      "linearProject": "MonPick",     // Linear project name — must exist (required)
      "repoPath":      "/abs/path/to/repo",   // where Dev works (required for dev-agent)
      "strategyDoc":   "docs/strategy.md",    // PM's north star, relative to repoPath (required for pm-agent)
      "mode":          "live",        // "live" | "dry-run"  (see conventions §12)

      "testEnv": {                    // where QA + verification run
        "baseUrl":     "https://monpick.vercel.app",
        "testCommand": "cd tests && python3 {suite}",  // {suite} filled per run; omit if N/A
        "notes":       "Personas: demo-creator@…/password123 (creator), demo-brand@… (brand)"
      },

      "build": {                      // gates Dev runs before shipping; all optional
        "typecheck": "npx tsc --noEmit",
        "build":     "pnpm build",
        "test":      "pnpm exec tsx tests/*.test.ts"
      },

      "git": {                        // how Dev lands code (autonomy choices live here)
        "defaultBranch": "main",
        "autoCommit":    true,
        "autoPush":      true,        // false → leave commits local
        "autoDeploy":    true         // false → skip deploy even if deploy.command set
      },

      "deploy": {
        "command": "vercel --prod --yes"   // run after a successful push when autoDeploy
      },

      "blockedStateName": null        // set to a real Linear state name if you add a "Blocked" column; else null → use the `blocked` label
    }
  }
}
```

## Notes
- **Required per project**: `linearTeam`, `linearProject`. `repoPath` is required
  for Dev; `strategyDoc` for PM; `testEnv` for QA. A skill prompts for any
  required field it's missing rather than guessing.
- **Autonomy** is expressed entirely through `git` + `deploy`. The fully-autonomous
  "push + deploy to prod" mode is `autoCommit/autoPush/autoDeploy: true` with a
  `deploy.command`. To put a human in the loop, set `autoPush`/`autoDeploy: false`.
- **Safety**: there is no MonPick Linear project yet. Either create a dedicated
  project (recommended) or point `linearProject` at one you own. The `dev-loop`
  label (conventions §2) is what actually protects the human backlog, but a
  dedicated project keeps the board clean.
- Secrets (passwords, tokens) are **not** stored here — reference how to obtain
  them (`.env.local`, a vault, "ask user") in `testEnv.notes`.
