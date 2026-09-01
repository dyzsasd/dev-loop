# Team / workspace model — the rules in full — conventions §27 pointer file

> Moved out of `references/conventions.md` §27 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §27's contract: read it at the trigger moment the §27 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

- **Config source.** Runtime reads `dev-loop.json` (the 1.x workspace schema), resolved by discovery (`DEVLOOP_WORKSPACE`
  → `DEVLOOP_TEAM` index → cwd ascent). It is projected to the historical per-project shape internally
  (`toLegacyView`), so every existing agent contract (§3/§4/§12b/§12c/reports) is unchanged.
- **Portability (I4).** All run state is under `<workspace>/.dev-loop/` (per-project dirs, `team/`,
  `lessons/`, `wt/`, `locks/`, and for service `hub.db`). Copying the workspace folder migrates the
  machine; only env vars + credentials (§16) follow separately. The one file outside the workspace is a
  rebuildable index (`${XDG_CONFIG_HOME:-~/.config}/dev-loop/workspaces.json`) that maps `DEVLOOP_TEAM`
  to a workspace root. After a move run `dev-loop team repair` (fixes worktree absolute paths, re-registers the index,
  truncates the WAL).
- **Secrets (§16 extends).** `team.comms.webhookEnv` stores an ENV-VAR **name**, never the URL; a value
  containing `://` is rejected (`E07`). This is what keeps "copy the folder" safe — no secret ever lands
  in `dev-loop.json`. The VALUE lives in `<workspace>/.dev-loop/secrets.env` (dotenv `KEY=VALUE`; loaded
  into the process env at workspace resolution, real env wins) or the shell env — so the workspace stays
  self-contained: copy the folder (including `.dev-loop/`) and notifications keep working with zero
  machine-global setup.
- **Backend is strictly team-level (I3).** linear or service, never mixed. A workspace is initialized
  with exactly one backend, and there is no cross-team collaboration.
- **deployPolicy is a ceiling.** `team.deployPolicy.<env> = "manual"` forbids any repo auto-deploying
  that env (`E06`); `dev-loop doctor` and `/dev-loop:add-repo` enforce it at config time, and every
  deploying agent re-validates it at runtime before any deploy step (§12d).
- **`team.docs.vision` is operator-owned — PM propose-only (D7).** When the team vision doc drifts
  from reality, PM may file a §9a **investigation-flow** proposal against it at WORKSPACE scope (the
  §9b `_team` intake carrier: findings + the proposed diff on the ticket; the operator approves
  BEFORE any edit lands). PM never edits the vision doc autonomously — the doc registry marks it
  operator-owned.
- **MCP scope for stewards.** A linear team's stewardship fires (sweep/ops/reflect/communication) run
  with the workspace root as cwd, where a repo-level `.mcp.json` does not apply — the Linear MCP must be
  configured in **user scope** (doctor warns `W05`). Delivery fires still run inside a repo, unaffected.
- **Scheduling (1.0 team mode).** `dev-loop run` (or Agent View `/loop`) launches ONE scheduler for the
  whole team; each agent keeps its own cadence, and when it fires the target project is chosen by a smooth
  weighted round-robin (`weight` = share; `enabled:false` removes a project from BOTH delivery rotation
  and steward coverage; `weight:0` is maintenance mode — delivery rotation pauses while the stewards
  (sweep/ops/reflect/communication) keep covering it). `--project` narrows the delivery rotation only;
  steward fires always keep team-wide coverage. The rotation cursor is shared
  between `dev-loop run` and the `/loop` rows via `dev-loop next-project --agent <a>`, so the two run modes
  never double-fire or starve a project. Preview the order with `dev-loop run --plan <n>`. Every fire is
  recorded to `<ws>/.dev-loop/team/fires.jsonl`. A shared repo's base-clone mutations (fetch / worktree
  add / prune) must run under `dev-loop with-repo-lock <ref> -- <cmd>`; worktree-internal work does not.
- **The operator flow is:** `dev-loop team init` (pure CLI) → `/dev-loop:add-project` → `/dev-loop:add-repo`
  (both in a coding CLI; they do the backend writes) → launch the loop at the workspace level. `dev-loop
  doctor` is the read-only health gate; `dev-loop team repair` is the only mutating fixup.
