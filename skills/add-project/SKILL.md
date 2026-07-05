---
name: add-project
description: >-
  Add a virtual project to a dev-loop workspace and SYNC it to the backend at add time. Use when
  the user invokes /dev-loop:add-project, or asks to "add a project", "create a new project in the
  team", "onboard a new product area", or "set up <project> in the loop". Runs operator-present:
  it find-or-creates the Linear (or hub) project and records its id, ensures the team's dev-loop
  label taxonomy (first project also reconciles the Linear team + linearTeamId), scaffolds the
  project strategy doc, interviews test-env / dev-split / launch config, and writes the project
  through the VALIDATED `dev-loop team add-project` mutator. Repos are added separately with
  /dev-loop:add-repo. 1.x workspace schema only.
---

# add-project — register a virtual project + backend sync

A **project** is a virtual unit (a Linear/hub project + delivery semantics) that later references
repos. This skill creates it AND aligns it with the backend in the same pass, so config and backend
never drift.

**Preconditions.** A workspace exists (`dev-loop.json`). Resolve it from cwd; if none, tell the user
to `dev-loop team init` first and stop. Read `references/conventions.md` §20/§27 and `config-schema.md`.

## 1. INTERVIEW

- **key:** a lowercase project key (state-dir + config key; not a reserved name). This is the
  workspace-internal handle.
- **linearProject / hub project name:** the human name in the backend.
- **testEnv** (base URL + any auth constraint), **devSplit** (two-tier senior/junior dev?),
  optional per-agent launch overrides.
- **blockedStateName** — did the operator add a real "Blocked" column in Linear? Record its
  name; else leave null (the `blocked` label park applies). Do not skip silently.
- **comms** — confirm `team.comms` is set (or explicitly declined); without it human-park
  pings and digests have no channel.

## 2. BACKEND SYNC (the reason this is a coding-CLI skill, not pure CLI)

- **linear:** if this is the FIRST project in the team, reconcile the Linear team first — verify
  `team.linearTeam` exists, ensure the dev-loop label set (`dev-loop`, `needs-pm`, `Feature`/`Bug`/
  `Improvement`, `pm`/`qa`, `senior-dev`/`junior-dev`, `blocked`, `external-prereq` + `external-code`/`external-access` (§9c), `sensitive` (§21a), `env:dev`/`env:prod`, …), and
  record `team.linearTeamId`. Then **find-or-create** the Linear project by name; record its id.
- **service:** `dev-loop seed <key> "<name>" <UNIQUE_PREFIX>` into the workspace hub.db (the prefix
  must be unique across the team's projects — doctor enforces it).
- Idempotency: if a matching backend project already exists, REUSE it (record its id); never create
  a duplicate. On a name clash or missing permission, list candidates and let the operator choose.

## 3. STRATEGY DOC

Scaffold the project strategy doc with the §20 headings (Vision / Goals / Non-goals / Current state
/ Decisions log), per `team.docSystem` (a Linear document, a hub doc, or a repo file). Leave
"Current state" for `/dev-loop:add-repo` to fill per repo.

## 4. PERSIST (validated write)

```
dev-loop team add-project <key> [--linear-project "<name>"] [--linear-project-id <id>] \
  [--test-url <url>] [--dev-split] [--weight <n>] [--enabled true|false]
```

The mutator re-validates the whole `dev-loop.json` and refuses an invalid result. It writes the
project with **zero repos**. Then run `/dev-loop:add-repo` to clone + register each repo.

## 5. VERIFY

`dev-loop doctor` (a repo-less project warns W01 until you add a repo — expected). Report the
recorded backend id + next step (add-repo) to the operator.
