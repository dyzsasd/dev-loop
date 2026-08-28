# Per-project config — resolution ladder & runtime state files — conventions §11 pointer file

> Moved out of `references/conventions.md` §11 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §11's contract: read it at the trigger moment the §11 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

The agents are product-agnostic; everything product-specific lives in **the workspace's
`dev-loop.json`** (1.x workspace schema — §27; field reference:
`references/config-schema.md`). The runtime projects it to the historical per-project view internally, so the field
names below (`mode`, `autonomy`, `testEnv`, …) are unchanged. `DEVLOOP_PROJECTS_JSON` survives
only as an explicit internal injection for tests/CI; it is not an operator path.

On startup each skill:
1. Resolves the workspace (env → index → cwd ascent, §27) and loads `dev-loop.json`;
   if none resolves, stop and tell the operator to run `dev-loop team init`.
2. **Interactive skill project selection ladder** (in order): (a) if the user **named** a project, use
   it; (b) else if the cwd is at or under exactly one registered repo path in `repos.*.path`, select
   the project(s) that reference that repo — if exactly one project matches, use it; if several
   projects share the repo, ask; (c) else if exactly **one enabled project** exists, use it; (d) else
   ask. Precedence: **explicit choice > cwd-match > single enabled project > prompt**. For
   **unattended launchers** (`dev-loop run`, daemon lifecycle, and process managers), use the
   stricter machine rule: **explicit `DEVLOOP_PROJECT` / `--project` > cwd-match > unresolved**.
   They do not guess the first configured project or `demo`; a cwd outside every configured repo
   must stop/no-op with a setup hint.
3. Loads the resolved project view: `linearProject`, `linearTeam`, target repo path(s),
   `strategyDoc`, `testEnv`, repo `build`/`deploy`/`git` facts, `mode`, `autonomy`, `intake`
   (§5a), and backend (`"linear"` or `"service"` in the workspace schema). Per-agent `codingAgent` / `model` / `effort` /
   `cadence` may also be configured, but **`dev-loop run` applies them at process launch**; skills
   do not choose their own model mid-fire. See `config-schema.md` and `docs/RUNNING.md`.

If `dev-loop.json` is missing or the chosen project lacks a required field, the skill asks the
user for the missing value and writes it through the validated team mutator. It never guesses repo
paths, URLs, or deploy commands.

**Runtime files in the workspace.** Each agent keeps local per-operator state under
`<workspace>/.dev-loop/<project-key>/`: `pm-state.json` / `qa-state.json`
(last-reviewed/swept SHA and review-lens state), `reports/`, runner logs, and related working
state. Team-scoped state lives under `<workspace>/.dev-loop/team/`; lessons live under
`<workspace>/.dev-loop/lessons/`. These files are machine-local, never committed, and created
lazily on first run.

**Bounded retention + atomic writes (state files are a working set, not an archive).**
`pm-state.json` / `qa-state.json` exist to answer a fixed set of look-back questions —
*has any watched repo's HEAD moved since I last reviewed/swept?* (the per-repo SHA map,
§19) and *which lenses/surfaces have I already covered at that SHA?* — so they must stay
**bounded**, the same discipline `lessons.md` follows (§14). Persist only that look-back,
**overwritten in place**; do **not** accumulate one key per ticket touched (verification
scratch belongs in the Linear ticket and its comments, which dedup (§8) and re-test read
directly — never these files). If transient notes are kept, cap them to a small rolling
window (last ~20 / ~14 days) and prune the tail on each write. **Write atomically** —
serialize to a temp file in the **same directory**, then rename over the target — so a partial/interrupted write can never
leave invalid JSON. (An unbounded append already grew `qa-state.json` past 330 KB, and a
non-atomic write is the likely cause of the one `pm-state.json` corruption on record.)

