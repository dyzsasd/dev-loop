# 2026-07 full review — operator decisions

> Decision record, 2026-07-10. Input: a six-dimension design review (init flow, concept
> model, hub web UI, project docs, agent SKILLs, workflow support — 24 critical/major
> findings adversarially verified: 9 confirmed, 15 partial, 0 refuted), a knowledge-base
> research pass for project docs, and a CLI-vs-MCP interface evaluation. Each decision
> below was made explicitly by the operator; implementation follows the phase ordering
> at the end.

## D1 — Hub op-API project override: role-based permission matrix

Hub agent identity is pinned to one project at boot, which makes the shipped team-scope
features (§9b team intake, ops owner-routed alerts, sweep per-project hygiene) dead
letters on `backend:"service"`. Fix: an optional `project` argument on hub ops
(deferred GA item D4.2), guarded **by actor role** — job-level conditions are not
server-enforceable:

| Actor | May pass `project` |
|---|---|
| stewards (sweep / ops / reflect / communication, booted as `_team`) | any config project key or `_team` |
| pm (regardless of booted project) | `_team` only (team-intake reads/writes) |
| all other delivery actors (senior/junior/dev/qa) | none — E_FORBIDDEN |

The "PM only during its team-intake job" restriction stays prompt-side in the PM SKILL.

## D2 — Daemon URL scheme: `/p/<key>/` prefix, index landing

Per-request project resolution from a `/p/<key>/` path prefix; bare paths fall back to
the boot project so existing URLs and tests survive. `GET /` renders a server-side
project index (`_team` presented as "Team intake", not a peer project); no
busiest-project redirect. Doc routes are project-scoped from day one
(`/p/<key>/docs`, `/p/<key>/doc/<slug>`) because `documents.slug` is unique per
`(project_id, slug)`. `/roadmap` becomes a redirect once the generalized doc pages land.

## D3 — Web doc edit/publish trust model: reuse the DL-29 double gate

New `/docs` edit and publish routes follow the `/roadmap` precedent exactly:
`humanWrite.enabled` config opt-in (default off) **and** daemon booted with operator
write capability. No new auth machinery (no session tokens). Without both gates the doc
pages are read-only with a banner naming the enabling command.

## D4 — Repo-file strategy doc: section-level edit policy

On backends where the strategy doc is a repo file (no publish gate exists), PM's write
policy is split by section: progress sections (Current state, shipped markers,
Candidate ideas) stay autonomous commits; direction sections (Vision, Goals, Non-goals,
Appetite, No-gos) require the investigation/proposal flow (diff on ticket → operator
approval) before the commit. Sweep audits doc-only commit diffs as the backstop.

## D5 — `doc:decisions` mirrors to Linear

The decisions log (split out of the strategy doc; numbered, append-only,
supersede-don't-edit) rides the same one-way Sweep mirror push as strategy/roadmap,
with the standard "edits here are overwritten" banner.

## D6 — Retention

Daily reports 90 days (unchanged) · weekly reports 52 weeks · monthly reports kept
forever · communications drafts 90 days · retired design docs get an `archived` flag
(hidden by default in the registry, never deleted) · strategy archive kept forever
(cold, never re-ingested).

## D7 — Team vision doc: PM propose-only

PM gains a propose-only path against `team.docs.vision` via the same investigation
flow at workspace scope (diff on ticket, operator approves). No autonomous writes; the
registry marks the doc operator-owned.

## D8 — Agent interface: CLI-first, three tracks

| Track | Interface |
|---|---|
| service backend + Claude Code | CLI (default flips) |
| service backend + Codex | MCP until the P8 env-propagation certification passes, then CLI |
| linear backend | Linear MCP, permanently (no wrapper CLI will be built) |

The hub MCP server and shim remain as sibling thin clients over the same
`agentOp()` layer (Claude Desktop export, third-party MCP hosts, future remote hub).
Rollback is the `hub.agentInterface` config switch. `team init`/`add-project`
provision `permissions.allow: ["Bash(dev-loop *)"]` in the workspace Claude settings.

## D9 — CLI rollout: direct full flip

All seven migration steps land in order without a single-project pilot; step 7
(before/after per-fire token + failure-rate measurement from fires.jsonl) is the
post-hoc guard. Known accepted risk: cheat-sheet defects hit all agents at once;
mitigation is CI-generating the cheat-sheet block from the CLI's own usage strings.

## D10 — `hub/undefined/` stray database

Root-cause the literal-"undefined" path segment, guard at the path-composition choke
point (reject undefined/null/empty segments with an error naming the culprit), add a
regression test, delete the stray directory (verified empty, schema-only).

## D11 — Repo hygiene

`examples/` and `evaluation.xlsx` (writing-loop material) moved out of this repo to
`~/workspace/jinko/writing-loop/`. Done 2026-07-10.

## Implementation ordering (cross-dimension synthesis)

- **Phase 0** — mechanical repairs (11 corrupted §-references in dev/qa SKILLs + lint;
  doc.get/doc.save CAS-semantics fix, additive, with regression test) plus D1/D2 as
  written here. *In progress 2026-07-10.*
- **Phase 1** — hub project override (D1) → `_team` structural cleanup → weight:0
  steward semantics.
- **Phase 2** (parallel with 1) — onboarding rail: `team set` → doctor `NEXT:` line →
  CLI parity for add-project/add-repo → `dev-loop init` wizard last; split-dev
  worktree isolation in `landing:"direct"`; CLI-first steps 1–6 (D8/D9).
- **Phase 3** — web UI system: views refactor → tokens v2 → multi-project routing (D2)
  → board → ticket detail → activity; docs viewer+editor as ONE work item (D3).
- **Phase 4** — PM/doc change flow: Human-Blocked resume loop → operator-edit
  propagation (self-trigger excluded) → investigation protocol (D4) → Linear doc
  mirror (D5).
- **Phase 5** — SKILL/content additions, anchor-first; digest contract relocation
  before digest amendments.
- **Phase 6** — the uniform SKILL template migration, last, as a pure consolidation
  pass.

Cross-cutting obligations from the review: every bug-fix proposal names its regression
test; semver classification per change (doc.get default must stay additive; `/roadmap`
redirect is a breaking URL change to note); README zh/fr translations follow the
English restructure; DAEMON.md / HUB-ARCHITECTURE.md / PORTABILITY.md updated where
their described surfaces change.
