# dev-loop — Config schema

The dev-loop agents (PM / QA / Dev / Sweep / Reflect / Ops / Architect /
Communication) read
`DEVLOOP_PROJECTS_JSON` when set, otherwise `${DEVLOOP_DATA_DIR:-~/.dev-loop}/projects.json`.
Legacy Claude plugin data is only a compatibility fallback. The config maps each product to its Linear project, its
repo, its test environment, and its ship/deploy settings. One file, many products.
`/dev-loop:init` gathers and writes this file with you (operator-present setup).

## Schema

```jsonc
{
  "defaultProject": "your-product",   // optional legacy hint for interactive/operator flows;
                                      // scheduler launch does not use it as an implicit fallback
  "projects": {
    "<key>": {                        // short slug you'll refer to (e.g. "your-product", "api")
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
      "backend":       "linear",      // "linear" (default when absent) | "local" | "service" — coordination substrate (see conventions §18)
      "devSplit":      false,         // two-tier Dev (§21a): the AUTHORITATIVE flag the agents read. true ⇒ senior-dev/junior-dev own the queue + the legacy `dev` agent defers (no-op); absent/false ⇒ legacy single-dev. MUST be set together with the launcher's DEV_SPLIT=1 (which spawns the two panes) — the two halves of one switch. Agents NEVER infer the dev model from history/tickets, only from this flag.
      "localBoard":    null,          // local backend only: override board dir; null → ${DEVLOOP_DATA_DIR:-~/.dev-loop}/<key>/board/
      "ticketPrefix":  "DL",          // local/service backend: ID prefix for tickets (e.g. "DL-1"); ignored for linear
      "hub": {                        // service backend only (conventions §18; see docs/HUB-ARCHITECTURE.md). The local MCP system-of-record.
        "db":          null,          // path to the hub SQLite file; null → ${DEVLOOP_HUB_DB:-~/.dev-loop/hub.db}. Registered as an MCP server (`dev-loop-hub`) via .mcp.json; identity per-pane via DEVLOOP_ACTOR (see docs/RUNNING.md). Machine-local, never committed.
        "docs":        false,         // P4: false (default) ⇒ strategyDoc is a repo file (as P2/P3). true ⇒ the strategy + roadmap live as hub documents (versioned, attributable, optimistic-CAS, OPERATOR-PUBLISHED via doc.publish). Or pin one doc: strategyDoc: { "hubDoc": "strategy" }. §17: hub docs are PRODUCT docs only — never a SKILL/conventions/code file.
        "transport":   "stdio"        // DL-43/P2: "stdio" (default) ⇒ each pane's MCP server opens hub.db DIRECTLY (today's behavior, zero new surface). "daemon" ⇒ OPT-IN: the agent op-API on the loopback daemon (`POST /api/op/<op>`, read fresh per request) is live, and the thin stdio shim (hub/src/shim.ts) proxies tool calls to it instead of opening the DB — identity rides env→the `X-Devloop-Actor` header (dodges the `claude -p` Authorization-drop). Every mutating endpoint passes the writeOriginOk CSRF/DNS-rebind guard first (§16, 127.0.0.1-only). See docs/HUB-ARCHITECTURE.md + docs/design/daemon-multicli-repositioning.md.
      },
      "models": {                     // optional: per-agent model, applied by the LAUNCHER at session start (--model). DEFAULT is opus for EVERY agent; tune an agent DOWN to economize.
        "pm": "opus", "qa": "opus", "dev": "opus", "sweep": "opus", "reflect": "opus", "ops": "opus", "architect": "opus", "communication": "opus",
        "senior-dev": "claude-opus-4-8",   // two-tier Dev (launcher DEV_SPLIT=1): the design-and-delegate + escalation direct-code agent. Launcher effort = max. Absent ⇒ opus.
        "junior-dev": "claude-sonnet-4-6"  // two-tier Dev (DEV_SPLIT=1): implements pre-designed tickets against the linked design. Launcher effort = high. Absent ⇒ sonnet. `dev` stays the LEGACY single-dev default (kept active).
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
      "communication": {              // OPTIONAL — communication-agent only (conventions §21). Absent ⇒ no scheduled article drafts unless directly invoked by the operator.
        "cadence":          "daily",  // daily is the intended loop cadence; the agent dedupes by YYYY-MM-DD output path
        "language":         "en",     // article language, e.g. "en", "zh-CN", "fr"
        "audience":         "current and prospective users",
        "tone":             "clear, concrete, human, and restrained",
        "maxWords":         900,
        "sourceWindowDays": 7,        // how far back to look for Done tickets/events/changelog facts
        "output":           "data",   // "data" (default, machine-local drafts) | "repo" (write draft markdown under the doc-home repo)
        "outputDir":        "communications",       // data output: ${DEVLOOP_DATA_DIR:-~/.dev-loop}/<key>/<outputDir>/YYYY-MM-DD.md
        "repoOutputDir":    "docs/communications",  // repo output: <doc-home repo>/<repoOutputDir>/YYYY-MM-DD.md
        "includeUnreleased": false    // false ⇒ only published/verified/shipped facts; true ⇒ may mention roadmap items as upcoming, clearly labelled
      },
      "mirror": {                     // OPTIONAL — the P7 ONE-WAY Linear mirror (conventions §18/§23). Absent ⇒ no mirror (today's behavior). REQUIRES backend:"service" (the hub is the SoR being mirrored). Sweep Job 5 pushes it.
        "teamId":   "<linear-team-id>",     // the Linear team the mirrored issues live in
        "projectId": null,            // optional Linear project id to file them under
        "tokenEnv": "DEVLOOP_LINEAR_TOKEN", // ENV-VAR NAME of the Linear API key (§16 secret; read SERVER-SIDE; NEVER the literal)
        "stateMap": {                 // optional hub State → Linear state id; a missing state ⇒ no stateId (state stays in the body; the push never fails)
          "Todo": "<id>", "In Progress": "<id>", "In Review": "<id>", "Done": "<id>", "Canceled": "<id>"
        },
        "enabled":  true
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
      "notify": {                     // OPTIONAL — PM only (conventions §9). Absent ⇒ NO-OP (no out-of-band ping; full back-compat).
        "type":       "lark",         // "slack" | "lark" — picks the webhook payload shape
        "webhookEnv": "DEVLOOP_NOTIFY_WEBHOOK",  // PREFERRED: name of an env var holding the webhook URL (a §16 secret). Or inline "webhook": "..." (machine-local only; never commit/echo).
        "secretEnv":  null,           // lark only, optional: env-var name for the bot signing secret (if signature verification is on). Or inline "secret"; §16-class.
        "events":     ["human-parked"]  // default; the only event today — a ticket left blocked+needs-pm with Bail-shape: external-prereq
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
- **`lessons.md`** (optional) lives **per-project** at
  `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/lessons.md` (the same per-project home as `reports/`,
  conventions §14; the legacy root file next to `projects.json` remains only as a back-compat
  **fallback** for un-migrated single-project installs). It holds per-operator
  behavioral corrections, sectioned per agent (`Shared`/`PM`/`QA`/`Dev`/`Sweep`/`Reflect`/`Ops`/`Architect`/`Communication`).
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
  SKILL sets, so this is consumed by `dev-loop run` / your launch command, not by the
  agents. **The default is `opus` for EVERY agent** (the launcher applies `--model opus`
  per pane unless you override) — maximize correctness across the whole loop. Tune an
  agent **down** (`sonnet`/`haiku`) only to economize — e.g. the mechanical/high-frequency
  ones (`sweep`, `qa`, `ops`, `communication`) tolerate `sonnet` well; the reasoning-heavy ones
  (`dev`, `pm`, `architect`, `reflect`) are where `opus` earns its keep. Omitting an
  agent ⇒ it falls back to the launcher's opus default.
  **Per-agent EFFORT tiers** (the launcher's `--effort` per pane, distinct from the model):
  `pm=max` and `dev=max` (legacy single dev) reason deepest; `reflect`/`architect`=`xhigh`;
  `qa`/`sweep`=`high`.
- **Two-tier Dev** (`senior-dev` / `junior-dev`; conventions §21a): an opt-in split of the single
  Dev role, enabled at LAUNCH by the scheduler/launcher knob (`--dev-split` or equivalent) — it replaces
  the single `dev` pane with two panes: a **`senior-dev`** pane (`claude-opus-4-8`, effort **max**)
  that designs-and-delegates new modules/features and direct-codes escalations, and a
  **`junior-dev`** pane (`claude-sonnet-4-6`, effort **high**) that implements pre-designed tickets
  against the linked design. Their models come from `models{}` (`senior-dev`/`junior-dev`),
  defaulting to opus / sonnet respectively. The split is **per-project and opt-in**: with
  `DEV_SPLIT` off (default) the launcher keeps the **legacy single `dev` pane** and non-split
  projects are 100% unaffected — `dev` stays an active actor and `dev-agent` stays the canonical
  single-dev SKILL. PM routes each ticket to its tier at filing (new module / new feature ⇒
  `senior-dev`; improvement / bug-fix, or borderline ⇒ `junior-dev`), encoded per backend
  (the ticket `assignee` on `service`; a `senior-dev`/`junior-dev` LABEL on `linear`/`local`).
- **Design docs** (the two-tier Dev's `design` doc tier, conventions §21a): senior-dev authors a
  LIVING per-MODULE technical-design doc — autonomously, like PM commits the `strategyDoc` (it is
  NOT a §17 governing file and is NOT operator-publish-gated; the gate is the design parent ticket
  reaching `In Review`). Its **home depends on the backend**: on `backend:"service"` it is the hub
  **`design`** doc-kind (versioned, multi-instance by module slug, read at its latest version —
  `doc.save`/`doc.get`, not publish-gated); on `backend:"linear"`/`"local"` it is a committed repo
  file **`docs/design/<slug>.md`** under the doc-home repo. Small features get NO separate doc — the
  design lives in the parent + child ticket specs. Every child dev-ticket carries a `Design:`
  pointer line (`hubDoc:design/<slug>` | `docs/design/<slug>.md` | `parent <id>`) that junior-dev
  reads before coding.
- **`backend`** (optional; default `"linear"`): the coordination substrate
  (conventions §18). `"linear"` is the Linear MCP, exactly as today — absent ⇒
  `"linear"`, so existing projects are unchanged. `"local"` uses a machine-local file
  board under `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<key>/board/` (one markdown file per ticket; state
  in the frontmatter; same state machine, labels, and protocols). `localBoard`
  overrides the board path; `ticketPrefix` sets the ID prefix (default `"DL"`). Both
  are ignored under `"linear"`. In `"local"` mode `strategyDoc` must be a **repo file**
  (a Linear document can't back a local board), and `/dev-loop:init` scaffolds `board/`
  while skipping the Linear label/project steps. `"service"` routes to the **local hub**
  — a machine-local MCP system-of-record (`hub.db`, node:sqlite; see
  `docs/HUB-ARCHITECTURE.md`) registered as the `dev-loop-hub` MCP server, whose tools
  mirror the Linear op-shapes 1:1 so the SKILLs port unchanged. Its win over Linear:
  **real per-agent identity** — each pane sets `DEVLOOP_ACTOR` (launcher-set; see
  `docs/RUNNING.md`) so every write is attributable, not the single shared Linear user.
  `hub.db` path via `hub.db` / `DEVLOOP_HUB_DB`; `strategyDoc` is a **repo file** (as in
  `local`; first-class hub docs are a later phase); `ticketPrefix` applies. Like `local`,
  the hub is machine-local runtime state, never committed.
- **Project resolution (`backend:"service"`, DL-13).** The hub picks its project by this
  precedence: **explicit `DEVLOOP_PROJECT`** (a non-empty, trimmed value — `""` is treated as
  unset, and `"demo"`/`"default"` are NOT sentinels: an operator may legitimately pin a project
  keyed `demo`/`default`) **>** the spawned process's **cwd** matched against each project's
  `repoPath`/`repos[].path` (§19; realpath-canonical, segment-boundary safe so `/work/repo` ≠
  `/work/repo-2`, nearest-ancestor wins, an ambiguous tie or a cwd outside every repo → no match).
  A cwd that resolves to a **configured-but-unseeded** project **errors loudly** (it never silently
  falls through to `demo`), and scheduler launches with no explicit project + no cwd match stop with
  a setup hint rather than guessing `defaultProject` or another configured project. The shared
  matcher is exposed as
  `dev-loop-hub resolve-project [--cwd <path>]` so a launcher reuses exactly one rule. So
  `DEVLOOP_PROJECT` is **optional** when an agent is launched from inside a project's repo; the
  `.mcp.json`/launcher templates default it to empty for that reason (see `config/mcp.*.example`,
  `docs/RUNNING.md`).
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
- **`communication`** (optional; `communication-agent` only, conventions §21): enables the
  PR/media drafting agent. Its default job is one **draft** article per day, sourced from the
  strategy/roadmap, recent verified Done tickets, changelog/git facts, and the public product
  surface. It never publishes externally, never commits/pushes/deploys, and never edits product
  code. `output:"data"` writes machine-local drafts under
  `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/<outputDir>/YYYY-MM-DD.md`; `output:"repo"` writes the
  draft markdown under the doc-home repo at `repoOutputDir` for operator review. `language`,
  `audience`, `tone`, `maxWords`, and `sourceWindowDays` shape the article; `includeUnreleased`
  must stay false unless the operator is comfortable with clearly-labelled roadmap/upcoming
  language. Absent ⇒ scheduled Communication fires no-op, so existing projects are unchanged.
- **`mirror`** (optional; conventions §18/§23; requires `backend:"service"`): the P7 **one-way
  Linear mirror** — projects the hub's tickets to Linear so humans who live in Linear can SEE
  the loop without the hub ceasing to be the source of truth. **Strictly one-way** (hub →
  Linear): the hub WRITES Linear (and reads only to reconcile its own id mapping), NEVER imports
  Linear state; a human edit on a mirrored issue is **overwritten** on the next push (a banner
  says so). **Sweep Job 5** pushes it (idempotent + incremental — an unchanged ticket is skipped
  by content hash; cheap when nothing changed). `tokenEnv` is the env-var **NAME** of the Linear
  API key (§16 secret, read server-side, never returned/logged/persisted); `stateMap` maps hub
  states → workspace-specific Linear state ids (a missing one ⇒ state lives in the body, the push
  never fails). **§23 audience-widening (same as `reports.sink:"linear"`):** the mirror publishes
  ticket bodies to a hosted/shared/searchable Linear — so a mirrored body must already be §16-safe
  (no secrets/PII; the agents never put those in ticket bodies anyway). A hub Canceled/Duplicate
  is mirrored as a state change, **never** a hard-delete (no data loss). Absent ⇒ no mirror; a
  `mirror` under `backend:"linear"`/`"local"` is a config error (no hub to mirror from). Distinct
  from `reports.sink` (that mirrors *reports*, this mirrors *tickets*) — they may coexist.
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
- **`notify`** (optional; PM only, conventions §9): pings the operator **out-of-band** when
  a ticket is left human-parked (`blocked`+`needs-pm`+`Bail-shape: external-prereq`) — the
  fix for a parked ticket sitting unseen. `type` is `"slack"` | `"lark"`; the webhook URL is
  a **§16 secret** — set `webhookEnv` (an env-var name; **preferred**) or, since
  `projects.json` is machine-local/never-committed, an inline `webhook` (never commit or echo
  it). Lark signature verification uses `secretEnv`/`secret` (§16-class too). PM announces
  each parked ticket **once** (the `notified` label, §4), POSTs with a short timeout, treats
  only a 2xx (Lark: + body `code==0`) as success, and **never** writes the URL into a
  ticket/comment/report/log. **Absent ⇒ NO-OP** (no ping, no extra work — full back-compat).
  Out-of-band by design: a Linear @mention would be a self-mention (shared identity) and
  suppressed.
- **`models`** covers the eight base agents plus the two opt-in two-tier-Dev agents
  (`senior-dev`/`junior-dev`) and **defaults to `opus` for all of them** (the launcher applies
  `--model opus` per pane unless overridden; `senior-dev`→opus, `junior-dev`→sonnet defaults under
  `DEV_SPLIT=1`); tune an agent down to economize. The outward agents are **opt-in to launch**
  (off by default in the launcher), and the two-tier Dev split is also opt-in (`DEV_SPLIT=1`);
  none of these change any other agent's behavior, and a legacy single-dev project is
  byte-for-byte unchanged.
- **Agent state files** (`pm-state.json`, `qa-state.json`, and the outward observe-and-file
  agents' `ops-state.json` / `architect-state.json`, §21) live next to `projects.json` and
  hold per-project loop state: last-reviewed/swept SHA, swept
  review lenses (PM), swept surfaces (QA); Ops's open incidents + last-check;
  Architect's per-repo SHA map + swept audit dimensions. **Multi-repo (conventions §19):** the
  last-reviewed/swept SHA becomes a **per-repo map** `{ "<repo-name>": "<sha>" }` (one
  entry per `repos[]`); a new SHA in *any* watched repo re-opens the sweep. Single-repo
  keeps the single-SHA form, unchanged. Local per-operator runtime state — never
  committed, never shared. Created lazily on first run, or up-front by `/dev-loop:init`
  (which also seeds the per-project `lessons.md` skeleton (under `<project-key>/`, conventions §14) and gathers/writes back
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
  `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/reports/<agent>/{daily,weekly,monthly}/`
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
  **defaults to `ops-agent` + `dev-agent`**, the highest-PII authors), and
  `reports.reviewToken` (the operator's **opaque** high-entropy 点评 sentinel — not a
  dictionary word). `lessons.md` stays machine-local in both sinks.
