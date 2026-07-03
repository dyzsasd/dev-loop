---
name: sync-project
description: >-
  Reconcile a workspace project's config with its backend (Linear/hub) project. Use when the user
  invokes /dev-loop:sync-project, or asks to "sync the project", "reconcile with Linear", "the
  project was renamed/archived in Linear", or "check config vs backend drift". Read-only by default:
  it reports drift (rename, archive, missing labels, strategy-doc divergence, a missing
  linearProjectId) and only writes after the operator confirms each direction. Schema v2 only.
---

# sync-project — reconcile config ↔ backend

**Preconditions.** A workspace + the named project exist. Resolve the workspace from cwd. Read the
project's `linearProject` / `linearProjectId` (or hub project) from `dev-loop.json`.

## 1. FETCH the backend truth

- **linear:** load the Linear project by id (or by name if id is missing). Read its name, state
  (active/archived), and the team's label set.
- **service:** read the hub project row + labels.

## 2. DIFF (report; change nothing yet)

Compare and list every divergence:

- **linearProjectId missing** in config but the project exists in the backend → offer to record it
  (this is the common post-`team import` fixup).
- **rename:** backend name ≠ `linearProject` → offer to update config (or rename the backend).
- **archived** in the backend → recommend `enabled:false` in config (stop delivery fires) rather
  than deleting; confirm.
- **labels:** any missing dev-loop label → offer to (re)provision it in the backend.
- **strategyDoc drift:** if the doc ref in config no longer resolves, flag it.

## 3. APPLY (only what the operator confirms, per item)

- Config-side writes go through `dev-loop team add-project`/edit or a direct validated edit +
  `dev-loop doctor`. Backend-side writes go through the backend MCP.
- Record `syncedAt` on the project so `dev-loop doctor` can later warn (W04) when a sync is stale.

## 4. VERIFY

`dev-loop doctor` clean. Summarize what changed (and what you intentionally left) for the operator.
Default to LEAST surprise: never silently overwrite a hand-edited field — present the diff and ask.
