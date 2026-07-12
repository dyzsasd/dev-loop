---
name: sync-project
description: Reconcile a workspace project's config with its backend (Linear/hub) project. Use when the user invokes /dev-loop:sync-project, or asks to "sync the project", "reconcile with Linear", "the project was renamed/archived in Linear", or "check config vs backend drift". Read-only by default — it reports drift (rename, archive, missing labels, strategy-doc divergence, a missing linearProjectId) and only writes after the operator confirms each direction. 1.x workspace schema only.
---

# sync-project — reconcile config ↔ backend

ROLE: You are the operator-present setup skill that detects and (only on confirmation)
repairs drift between a project's `dev-loop.json` entry and its backend project.

## MISSION

Fetch the backend truth, diff it against config, apply only operator-confirmed fixes in
each direction, and leave `dev-loop doctor` clean.

## BOOT

Operator-present, but each invocation is fresh (§0); boot per §0a (the Topology block + the
sections cited below). Inputs:
- The workspace + the named project (resolve the workspace from cwd); the project's
  `linearProject` / `linearProjectId` (or hub project) from `dev-loop.json`.
Sections: §0 §0a §2 §4 §18 §20

## JOBS

### 1. FETCH the backend truth (§18)

- **linear:** load the Linear project by id (or by name if id is missing). Read its name,
  state (active/archived), and the team's label set.
- **service:** read the hub project row + labels.

### 2. DIFF (report; change nothing yet)

Compare and list every divergence:
- **linearProjectId missing** in config but the project exists in the backend → offer to
  record it.
- **rename:** backend name ≠ `linearProject` → offer to update config (or rename the
  backend).
- **archived** in the backend → recommend `enabled:false` in config (stop delivery fires)
  rather than deleting; confirm.
- **labels:** any missing dev-loop label → offer to (re)provision it in the backend.
- **strategyDoc drift (§20):** if the doc ref in config no longer resolves, flag it.

### 3. APPLY (only what the operator confirms, per item)

- Config-side writes go through `dev-loop team add-project`/edit or a direct validated
  edit + `dev-loop doctor`. Backend-side writes go through the backend MCP (§18).
- Record `syncedAt` on the project so `dev-loop doctor` can later warn (W04) when a sync
  is stale.

### 4. VERIFY

`dev-loop doctor` clean.

## HARD LIMITS

- Read-only until the operator confirms each item — default to LEAST surprise; never
  silently overwrite a hand-edited field (present the diff and ask).
- Backend-side writes only (re)provision dev-loop taxonomy labels (§4) or rename the
  project — human tickets are untouched (§2).

## REPORT

Summarize what changed (and what you intentionally left) for the operator.
