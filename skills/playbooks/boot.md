---
slug: SH-boot
kind: mechanical
pulls: references/conventions/project-config.md (step 2, config detail), references/backend-service.md (step 3, service backend), references/conventions/workspace-model.md (team workspaces)
---

# SH-boot — the standard fire boot (conventions §0a)

Shared by every agent. The constitution carries the 6-step summary; this is the executable expansion.
Run it top-to-bottom, every fire. Skip nothing you "remember" — the session may be freshly compacted (§0).

## Preconditions
- You are a fresh fire; state lives on the board, in git, and in `*-state.json`, never in memory.
- If the prompt already contains a `<!-- devloop-boot:begin … --> … <!-- devloop-boot:end -->` block, it is
  AUTHORITATIVE for steps 1–4 (the selective read, the resolved config, the backend contract, the lessons):
  do NOT re-read those files or re-derive that config. Steps 5–6 still run fresh.

## Steps
1. **Selective read.** Read the conventions **Topology** table + exactly the sections your SKILL's
   `Sections:` line names (§0/§0a/§2 always). A cited `##` includes its `###` children. A cited section may
   name a `references/…` stub — read it at the stub's trigger moment (that is cited material, not a gap).
   Mid-fire you MAY read an uncited section rather than guess a protocol — then flag it as a `Sections:`
   gap in your report.
2. **Config (§11).** Load the workspace `dev-loop.json` (env → index → cwd ascent; none ⇒ stop:
   `dev-loop team init`). Resolve the project: explicit `DEVLOOP_PROJECT`/`--project` > cwd-match >
   unresolved — never a guess (a cwd outside every configured repo stops with a setup hint). Load the
   per-project view (`linearProject`/`linearTeam`, repo path(s), `strategyDoc`, `testEnv`, `mode`,
   `autonomy`, `intake`, `notify`, `codex`, `repos[]`).
3. **Backend (§18).** `backend` absent ⇒ `linear` (the Linear MCP); `"service"` ⇒ the hub. Both route the
   SAME ticket ops; only the transport differs. Read the matching `references/backend-<backend>.md` before
   the first board op (`linear` needs no file).
4. **Lessons (§14).** Read the team lessons LIBRARY at `<workspace>/.dev-loop/lessons/`: `INDEX.md` always +
   this project's shard `<project-key>.md`. From each, read your own section (+ `## Dev` for split tiers) and
   `## Shared`. A legacy `<data>/<project-key>/lessons.md` is read when present; its absence is normal.
5. **Report start (§22).** Finalize any due daily/weekly/monthly roll-up; scan for an un-acted
   `<report>.review.md` (点评) and distill per SH-report.
6. **Open.** Emit your SKILL's one-line run summary (project, board, `mode`, and — when passive — the
   `intake.mode`), then run the job.

## Exit criteria
Config + backend + lessons resolved; the run summary emitted. Identity failed to resolve (a phantom
`DEVLOOP_ACTOR`, an unseeded project, the hub down) ⇒ STOP the fire, make no writes (constitution:
Identity & project).

## When blocked
A hard failure during boot (no config, hub unreachable) ⇒ log ONE line and exit cleanly; the next fire
retries. Never halt waiting for a human.
