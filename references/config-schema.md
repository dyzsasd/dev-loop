# dev-loop — Config schema

The dev-loop agents (PM / QA / Dev / Sweep / Reflect / Ops / Architect / Signal) read
`${CLAUDE_PLUGIN_DATA}/projects.json`. It maps each product to its Linear project, its
repo, its test environment, and its ship/deploy settings. One file, many products.
`/dev-loop:init` gathers and writes this file with you (operator-present setup).

## Schema

```jsonc
{
  "defaultProject": "monpick",        // used when the user doesn't name one and >1 exist
  "projects": {
    "<key>": {                        // short slug you'll refer to (e.g. "monpick", "geo")
      "linearTeam":    "Citronetic",  // Linear team name (required)
      "linearProject": "MonPick",     // Linear project name — must exist (required)
      "repoPath":      "/abs/path/to/repo",   // where Dev works (required for dev-agent). SINGLE-repo (default). For multi-repo, add repos[] below.
      "repos": [                      // OPTIONAL — multi-repo only (conventions §19). Absent ⇒ single-repo: top-level repoPath/build/git/deploy are authoritative, 100% unchanged.
        {
          "name":          "web",                 // repo target name → becomes a `repo:<name>` label on tickets (both backends)
          "path":          "/abs/path/to/web",    // this repo's working copy (Dev commits here for repo:web tickets)
          "role":          "primary",             // "docs" | "primary" | other. LOAD-BEARING: "docs" else "primary" else repos[0] is the DOC-HOME repo (roots strategyDoc)
          "lang":          "ts",                  // INFORMATIONAL contributor hint only — no logic reads it
          "contributorSkill": null,               // optional per-repo skill Dev reads before coding; absent ⇒ top-level contributorSkill, else read this repo's CLAUDE.md
          "defaultBranch": "main",                // per-repo override; absent ⇒ git.defaultBranch (autoCommit/autoPush/autoDeploy stay product-level in git)
          "build":         null,                  // per-repo override of the top-level build gates; absent ⇒ top-level build
          "deploy":        null                   // per-repo override; absent ⇒ top-level deploy. A repo resolving to NO deploy SKIPS deploy (never inherits another repo's)
        }
      ],
      "strategyDoc":   "docs/strategy.md",    // PM's north star (required for pm-agent). Either a
                                               //   repo file relative to repoPath (shown), OR a Linear
                                               //   document: { "linearDocument": "<id|slug|url>" } or a
                                               //   "https://linear.app/.../document/..." string. PM reads
                                               //   it (file | get_document) and maintains it (commit |
                                               //   save_document) — see pm-agent §0 + Job C.
      "contributorSkill": null,       // optional: a Claude skill carrying this repo's conventions (test cmds, architecture). Dev invokes it before coding; absent ⇒ Dev reads the repo's CLAUDE.md. Per-repo override lives in repos[].contributorSkill (§19).
      "mode":          "live",        // "live" | "dry-run"  (see conventions §12)
      "autonomy":      "ask",         // "ask" (default) | "full" — who decides vs escalates (see conventions §12a)
      "backend":       "linear",      // "linear" (default when absent) | "local" — coordination substrate (see conventions §18)
      "localBoard":    null,          // local backend only: override board dir; null → ${CLAUDE_PLUGIN_DATA}/<key>/board/
      "ticketPrefix":  "DL",          // local backend only: ID prefix for board tickets (e.g. "DL-1"); ignored for linear
      "models": {                     // optional: per-agent model, applied by the LAUNCHER at session start (--model). DEFAULT is opus for EVERY agent; tune an agent DOWN to economize.
        "pm": "opus", "qa": "opus", "dev": "opus", "sweep": "opus", "reflect": "opus", "ops": "opus", "architect": "opus", "signal": "opus"
      },

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
        "command":     "vercel --prod --yes",  // run after a successful push when autoDeploy
        "healthCheck": null                     // optional: a URL that must return 2xx, OR a command
                                                //   that must exit 0, run by Dev Step 6.5 after deploy.
                                                //   null → Dev hits testEnv.baseUrl root (non-5xx).
      },
      "ops": {                        // OPTIONAL — ops-agent only (conventions §21). Absent ⇒ Ops polls only the resolved deploy.healthCheck + testEnv.baseUrl root.
        "checks":         [],         // optional: extra synthetic probes — each a URL (must return 2xx) or a command (must exit 0)
        "criticalRoutes": [],         // optional: core user-flow paths/URLs that must be up — string path/URL or { "url": "...", "expectStatus": 200 }
        "logsCommand":    null        // optional: a READ-ONLY logs/metrics command for an error-rate/5xx signal (never mutating)
      },
      "signal": {                     // OPTIONAL — signal-agent only (conventions §21). Absent OR sources empty ⇒ Signal gracefully NO-OPs.
        "sources": [                  // each: one external real-user signal source + how to read it (MCP tool / API / command). Read-only.
          { "name": "support", "type": "inbox",  "read": "<mcp-tool-or-command>" },
          { "name": "sentry",  "type": "errors", "read": "<mcp-tool-or-command>" }
        ]
      },
      "codex": {                      // OPTIONAL — Codex companion (conventions §24). Absent OR enabled:false OR codex CLI not on PATH ⇒ never invoked (today's behavior).
        "enabled":   true,            // master switch (false/absent ⇒ off)
        "review":    true,            // Dev Step 5.5 + Architect may run an INDEPENDENT codex review (advisory; Critical/High block like Dev's own)
        "rescue":    false,           // Dev may delegate ONE rescue pass to codex before a fix-exhausted block (still gated on Dev's own gates)
        "imageGen":  true,            // PM mockups + Dev production assets via codex's native image_generation tool
        "assetsDir": "public/generated", // repo-relative dir Dev commits generated assets into (multi-repo: the ticket's repo:<name> tree)
        "model":     null,            // optional: pin a codex model (e.g. "gpt-5.4-mini"); null ⇒ codex's own default / its config.toml
        "effort":    null             // optional: none|minimal|low|medium|high|xhigh; null ⇒ codex default
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
  behavioral corrections, sectioned per agent (`Shared`/`PM`/`QA`/`Dev`/`Sweep`/`Reflect`/`Ops`/`Architect`/`Signal`).
  Each skill reads it at run-start and applies its section that fire
  (conventions §14). Local machine state — never committed. The **Reflect** agent (the
  daily retrospective role) is the one agent that *writes* this file — it curates it
  from recurring, evidence-cited patterns it observes across runs (conventions §17).
  Reflect may edit only `lessons.md` autonomously (reversible, per-operator); it must
  NOT auto-edit the SKILLs or `conventions.md` — those changes are drafted as proposals
  for the human. Reflect bounds its window from Linear + git (always present) and the
  `*-state.json` files; if a launcher happens to tee agent output to
  `logs/<agent>-<date>.log` in the data dir, it reads that too, but degrades silently
  when absent. It writes no new config keys.
- **`models`** (optional): a per-agent model map the **launcher** applies at session
  start (`claude --model <m> …`) — the model is a *launch-time* choice, not something a
  SKILL sets, so this is consumed by `run-loop.sh` / your launch command, not by the
  agents. **The default is `opus` for EVERY agent** (the launcher applies `--model opus`
  per pane unless you override) — maximize correctness across the whole loop. Tune an
  agent **down** (`sonnet`/`haiku`) only to economize — e.g. the mechanical/high-frequency
  ones (`sweep`, `qa`, `ops`, `signal`) tolerate `sonnet` well; the reasoning-heavy ones
  (`dev`, `pm`, `architect`, `reflect`) are where `opus` earns its keep. Omitting an
  agent ⇒ it falls back to the launcher's opus default.
- **`backend`** (optional; default `"linear"`): the coordination substrate
  (conventions §18). `"linear"` is the Linear MCP, exactly as today — absent ⇒
  `"linear"`, so existing projects are unchanged. `"local"` uses a machine-local file
  board under `${CLAUDE_PLUGIN_DATA}/<key>/board/` (one markdown file per ticket; state
  in the frontmatter; same state machine, labels, and protocols). `localBoard`
  overrides the board path; `ticketPrefix` sets the ID prefix (default `"DL"`). Both
  are ignored under `"linear"`. In `"local"` mode `strategyDoc` must be a **repo file**
  (a Linear document can't back a local board), and `/dev-loop:init` scaffolds `board/`
  while skipping the Linear label/project steps.
- **`repos`** (optional; default absent ⇒ single-repo, conventions §19): an array of
  `{ name, path, role, lang, contributorSkill?, defaultBranch?, build?, deploy? }`
  entries for a **multi-repo** product. Absent (or a single entry) ⇒ the top-level
  `repoPath`/`build`/`git`/`deploy` remain authoritative and the loop emits **zero**
  routing artifacts (no `repo:<name>` labels, no provisioning) — single-repo is 100%
  unchanged. **Resolution:** each per-repo-overridable setting (`build`, `defaultBranch`,
  `deploy`, `contributorSkill`, `lang`) is the repo's value if present, else the
  top-level value; `autoCommit`/`autoPush`/`autoDeploy` stay product-level in `git`.
  `role` is load-bearing (`"docs"`/`"primary"` picks the **doc-home** repo that roots
  `strategyDoc`); `lang` is informational. Multi-repo tickets carry a `repo:<name>`
  label (the authoritative target). If both `repoPath` and `repos` are set, `repos`
  wins and init verifies `repoPath` is among them.
- **`deploy.healthCheck`** (optional): a URL (must return 2xx) or a command (must
  exit 0) that Dev runs in Step 6.5 right after an unattended prod deploy. On a
  repeated failure Dev rolls the deploy back (revert + redeploy) rather than leaving
  prod broken. Absent → Dev smoke-checks `testEnv.baseUrl` root for a non-5xx.
- **`ops`** (optional; `ops-agent` only, conventions §21): probes for the Ops/SRE
  watcher of RUNNING prod. `ops.checks` (extra synthetic probes — URL/2xx or
  command/exit-0), `ops.criticalRoutes` (core user-flow paths that must be up), and a
  read-only `ops.logsCommand` (error-rate/5xx signal) are **all optional**; absent ⇒ Ops
  polls only the resolved per-repo `deploy.healthCheck` + `testEnv.baseUrl` root. Ops
  re-checks before filing (anti-flap), files/refreshes ONE `Bug`+`qa`+`incident` (Urgent
  when prod is down), dedupes via `ops-state.json`, and never rolls back. Opt-in to launch.
- **`signal`** (optional; `signal-agent` only, conventions §21): `signal.sources[]`
  lists external real-user signal sources (a support inbox, an error tracker, a feedback
  channel, app-store reviews) and how to read each (an MCP tool / API / command —
  **read-only**). **Absent or empty ⇒ Signal gracefully NO-OPs** — so a project that
  configures nothing is unaffected. Signal tracks a per-source last-seen cursor in
  `signal-state.json` (never re-ingests), dedupes hard (one ticket per issue, reports
  linked), files a defect → `Bug`+`qa`+`signal` or a request → `Feature`+`pm`+`signal`,
  and is **PII-strict** (§16). **Architect needs no new config** — it reuses
  `repos[]`/`build`.
- **`codex`** (optional; conventions §24 + `references/codex-integration.md`; **absent ⇒
  off, 100% unchanged**): wires the **Codex** companion (`codex` CLI + the codex-plugin-cc
  plugin) as an optional accelerant. Used **only** when `codex.enabled:true` **and** the
  `codex` CLI is on `PATH` — otherwise every agent behaves exactly as today (a missing
  Codex is a graceful fallback, not an error). Sub-flags gate each capability independently:
  `review` (Dev Step 5.5 + Architect run an **independent, advisory** codex review — a
  second model on the diff/codebase; Critical/High block like Dev's own, never a veto),
  `imageGen` (PM mockups + Dev production assets via Codex's native `image_generation` tool
  — the one thing the loop can't do itself; assets land in `assetsDir` and ship through the
  normal gates), and `rescue` (Dev delegates **one** pass to Codex before a `fix-exhausted`
  block; its patch ships only if it passes Dev's own gates + self-review). `assetsDir` is
  the repo-relative dir Dev commits generated assets into; `model`/`effort` optionally pin
  Codex's model/reasoning (null ⇒ Codex defaults / its `config.toml`). **No secret here** —
  Codex uses your local `codex login` auth (§16). Codex is **advisory and never touches
  Linear** — it only ever touches code/files/a review of them; the agent owns every ship.
  Prereqs (install `@openai/codex`, `codex login`, install codex-plugin-cc) are
  operator-present and one-time; `/dev-loop:init` notes the option but won't install the
  vendor CLI.
- **`models`** now covers eight agents and **defaults to `opus` for all of them** (the
  launcher applies `--model opus` per pane unless overridden); tune an agent down to
  economize. The three outward agents are **opt-in to launch** (off by default in the
  launcher) and don't change any inward agent's behavior.
- **Agent state files** (`pm-state.json`, `qa-state.json`, and the outward agents'
  `ops-state.json` / `architect-state.json` / `signal-state.json`, §21) live next to
  `projects.json` and hold per-project loop state: last-reviewed/swept SHA, swept
  review lenses (PM), swept surfaces (QA); Ops's open incidents + last-check;
  Architect's per-repo SHA map + swept audit dimensions; Signal's per-source last-seen
  cursors + source→ticket map. **Multi-repo (conventions §19):** the
  last-reviewed/swept SHA becomes a **per-repo map** `{ "<repo-name>": "<sha>" }` (one
  entry per `repos[]`); a new SHA in *any* watched repo re-opens the sweep. Single-repo
  keeps the single-SHA form, unchanged. Local per-operator runtime state — never
  committed, never shared. Created lazily on first run, or up-front by `/dev-loop:init`
  (which also seeds the `lessons.md` skeleton next to this file and gathers/writes back
  the per-project fields above WITH the operator — operator-present setup, so asking
  for unknowable values like `repoPath`/`linearProject`/`deploy.command` is expected
  there, unlike the unattended loop agents). Creates only what's missing. The default
  **`files`** report sink (§22) adds **NO new state-file field** — the daily/weekly/monthly
  report cadence and acted-review status live entirely in the reports tree (newest file per
  level; `<report>.review.acted` sidecars), so there is no marker to key per-project or
  reconcile. The opt-in **`linear`** sink (§23) adds one machine-local file,
  `reports-state.json` (doc-id cache + acted-review ledger + `lastReviewPollAt`) — also
  never committed.
- **Reports** (optional output, conventions §22; **on by default, no config needed**):
  every agent writes daily / weekly / monthly reports to
  `${CLAUDE_PLUGIN_DATA}/<project-key>/reports/<agent>/{daily,weekly,monthly}/`
  (machine-local, never committed, located by `reports.sink` — independent of the §18
  backend, **§16-bound — no secrets/PII**), created lazily on first write (or scaffolded by
  `/dev-loop:init`). The operator may critique any report by dropping a sibling
  `<report>.review.md`; the agent reads an un-acted review at run-start and distills it into
  a `lessons.md` rule under its own section (§22). Retention default ≈ **90 days of dailies**
  (tune per product); roll-ups preserve the summaries. No config key is required — an
  operator who writes no review just gets dated files to read or ignore.
- **`reports.sink`** (optional, conventions §23; **absent ⇒ `"files"`**): `"files"` (the
  default machine-local tree above) or `"linear"` (route the report **body** + the 点评
  channel to Linear — for a **cloud / remote** runtime where the operator can't reach the
  data dir; reads/reviews happen in a browser). **Decoupled from the §18 `backend`** (a
  `linear` backend does not auto-enable it). The `linear` sink trades away a §16
  defense-in-depth layer (Linear is hosted/shared/searchable), so it is **opt-in, never the
  default**, and carries the §23 guardrails. Linear-sink-only keys:
  `reports.linearProject` / `reports.linearInitiative` (the **dedicated** reports container,
  never the §20 doc-base), `reports.localOnlyAgents` (agents pinned to files regardless —
  **defaults to `signal-agent` + `ops-agent` + `dev-agent`**, the highest-PII authors), and
  `reports.reviewToken` (the operator's **opaque** high-entropy 点评 sentinel — not a
  dictionary word). `lessons.md` stays machine-local in both sinks.
