---
name: add-project
description: Add a virtual project to a dev-loop workspace and SYNC it to the backend at add time. Use when the user invokes /dev-loop:add-project, or asks to "add a project", "create a new project in the team", "onboard a new product area", or "set up <project> in the loop". Operator-present — it find-or-creates the Linear/hub project, ensures the team's dev-loop label taxonomy, scaffolds the strategy doc, interviews test-env / dev-split / intake / launch config, and writes through the VALIDATED `dev-loop team add-project` mutator; repos are added separately with /dev-loop:add-repo. 1.x workspace schema only.
---

# add-project — register a virtual project + backend sync

ROLE: You are the operator-present setup skill that creates a workspace project AND aligns
it with the backend in the same pass, so config and backend never drift.

## MISSION

A **project** is a virtual unit (a Linear/hub project + delivery semantics) that later
references repos (workspace model, §27). This skill interviews the operator, find-or-creates
the backend project, ensures the label taxonomy, scaffolds the strategy doc, and persists
the project through the validated mutator. Repos are added separately with
/dev-loop:add-repo.

## BOOT

Operator-present, but each invocation is fresh (§0); boot per §0a (the Topology block + the
sections cited below). Inputs:
- The workspace `dev-loop.json`, resolved from cwd — none ⇒ tell the user to
  `dev-loop team init` first and stop.
- `references/config-schema.md` (the field shapes the mutator writes).
Sections: §0 §0a §2 §4 §5a §9c §20 §21a §27

## JOBS

### 1. INTERVIEW

- **key** — a lowercase project key (state-dir + config key; not a reserved name): the
  workspace-internal handle.
- **linearProject / hub project name** — the human name in the backend.
- **testEnv** (base URL + any auth constraint), **devSplit** (two-tier senior/junior dev?),
  optional per-agent launch overrides.
- **intake.mode** (§5a): `autonomous` (default — PM proactively reviews the product and
  files its own work) or `passive` (PM only responds to explicit `needs-pm` intake; nothing
  is originated). Passive suits maintenance projects or teams where a human owns the
  roadmap; a passive project may skip the strategy doc.
- **blockedStateName** — did the operator add a real "Blocked" column in Linear? Record its
  name; else leave null (the `blocked` label park applies). Do not skip silently.
- **comms** — confirm `team.comms` is set (or explicitly declined); without it human-park
  pings and digests have no channel.

### 2. BACKEND SYNC (the reason this is a coding-CLI skill, not pure CLI)

- **linear:** if this is the FIRST project in the team, reconcile the Linear team first —
  verify `team.linearTeam` exists, ensure the dev-loop label set (`dev-loop`, `needs-pm`,
  `Feature`/`Bug`/`Improvement`, `pm`/`qa`, `senior-dev`/`junior-dev`, `blocked`,
  `external-prereq` + `external-code`/`external-access` (§9c), `sensitive` (§21a),
  `env:dev`/`env:prod`, …), and record `team.linearTeamId`. Then **find-or-create** the
  Linear project by name; record its id.
- **service:** `dev-loop seed <key> "<name>" <UNIQUE_PREFIX>` into the workspace hub.db
  (the prefix must be unique across the team's projects — doctor enforces it).

### 3. STRATEGY DOC

Scaffold the project strategy doc with the exact §20 field-set headings (§20 defines them
once — Vision through Candidate ideas), per `team.docSystem` (a Linear document, a hub
doc, or a repo file). Leave "Current state" for /dev-loop:add-repo to fill per repo.

### 4. PERSIST (validated write)

```
dev-loop team add-project <key> [--linear-project "<name>"] [--linear-project-id <id>] \
  [--test-url <url>] [--dev-split] [--weight <n>] [--enabled true|false] \
  [--intake-mode autonomous|passive]
```

The mutator re-validates the whole `dev-loop.json` and refuses an invalid result. It writes
the project with **zero repos**; then run /dev-loop:add-repo to clone + register each repo.

### 5. VERIFY

Run `dev-loop doctor` (a repo-less project warns W01 until you add a repo — expected).

## HARD LIMITS

- Never hand-edit `dev-loop.json` — persist only through the validated mutator.
- Idempotent on the backend: a matching existing project is REUSED (record its id), never
  duplicated; on a name clash or missing permission, list candidates and let the operator
  choose.
- Label provisioning stays within the dev-loop label taxonomy (§4) — the human backlog is
  untouched (§2).

## REPORT

Report the recorded backend id, the doctor result, and the next step (/dev-loop:add-repo)
to the operator.
