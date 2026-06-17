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
      "strategyDoc":   "docs/strategy.md",    // PM's north star (required for pm-agent). Either a
                                               //   repo file relative to repoPath (shown), OR a Linear
                                               //   document: { "linearDocument": "<id|slug|url>" } or a
                                               //   "https://linear.app/.../document/..." string. PM reads
                                               //   it (file | get_document) and maintains it (commit |
                                               //   save_document) — see pm-agent §0 + Job C.
      "mode":          "live",        // "live" | "dry-run"  (see conventions §12)
      "autonomy":      "ask",         // "ask" (default) | "full" — who decides vs escalates (see conventions §12a)

      "testEnv": {                    // where QA + verification run
        "baseUrl":     "https://monpick.vercel.app",
        "setup":       "python3 -m venv .venv && .venv/bin/pip install -q playwright && .venv/bin/playwright install chromium",  // one-time harness bootstrap; QA runs it if the tooling is missing (optional)
        "testCommand": ".venv/bin/python3 tests/{suite}",  // {suite} filled per run; omit if N/A
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
- **`testEnv.setup`** (optional): a one-time command to bootstrap the test harness
  (install the browser driver, create a venv, etc.). QA runs it when the tooling
  named in `testCommand` is missing, so a fresh machine or a scheduled run isn't
  blocked by an absent harness. Keep it idempotent.
- **Two orthogonal kinds of autonomy** (conventions §12a):
  - *How code lands* — the `git` + `deploy` flags. Fully hands-off shipping is
    `autoCommit/autoPush/autoDeploy: true` with a `deploy.command`; to put a human
    in the loop on landing, set `autoPush`/`autoDeploy: false`.
  - *How much the agents decide vs escalate* — the top-level `autonomy` field.
    `"ask"` (default) keeps the conservative posture (escalate genuinely human-only
    calls to the user, surface open product-direction decisions). `"full"` grants
    standing authority to **decide and act, not ask**: resolve scoping/product-
    direction calls from the `strategyDoc`, do irreversible prod ops attended
    (pre/post-verify + records-only form), and stop only for genuine **external
    prerequisites** (real credentials, money, legal) — never an interactive prompt.
    Caution stays the method, not a reason to defer.
- **Safety**: there is no MonPick Linear project yet. Either create a dedicated
  project (recommended) or point `linearProject` at one you own. The `dev-loop`
  label (conventions §2) is what actually protects the human backlog, but a
  dedicated project keeps the board clean.
- Secrets (passwords, tokens) are **not** stored here — reference how to obtain
  them (`.env.local`, a vault, "ask user") in `testEnv.notes`. See the security
  doctrine (conventions §16).
- **`lessons.md`** (optional) lives next to `projects.json` and holds per-operator
  behavioral corrections, sectioned per agent (`Shared`/`PM`/`QA`/`Dev`). Each skill
  reads it at run-start and applies its section that fire (conventions §14). Local
  machine state — never committed.
- **Agent state files** (`pm-state.json`, `qa-state.json`) live next to
  `projects.json` and hold per-project loop state: last-reviewed/swept SHA, swept
  review lenses (PM), swept surfaces (QA). Local per-operator runtime state — never
  committed, never shared. Created lazily on first run.
