# Querying without drowning + the write hazards — conventions §10 pointer file

> Moved out of `references/conventions.md` §10 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §10's contract: read it at the trigger moment the §10 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

`list_issues` with no filter can return hundreds of KB (the workspace has
250+ human tickets). Always:
- scope by `project` **and** `label:"dev-loop"`, plus `state` and/or other
  `label`s for the slice you want;
- pass a tight `limit` (e.g. 20–50);
- when you only need to act on one ticket, fetch that one with `get_issue`.

Never page through the whole workspace. If a result is still huge, your filter is
too broad — narrow it before reading.

**On the `service` backend, `list_issues` has extra levers (L3/L5):** it returns the 50
most-recent by default (250 max); pass `fields:"summary"` to drop the description body for a
cheap board scan (the full body stays on `get_issue`); `updatedSince:<ISO>` reads only what
changed; `relatedTo:<id>` finds a design parent's children; and `query` now searches
title + description **+ comment bodies** with whitespace-AND-ed terms — so a §8 dedup query
catches a reworded duplicate whose only match is a comment (e.g. a `review failed:` note).
On an `interface:"cli"` fire (§18) the same levers ride the read verbs — `dev-loop tickets
--json [--fields summary] [--updated-since ISO] [--related-to ID] [--q TEXT] [--limit N]`
is byte-identical to the `list_issues` op, and `dev-loop ticket <id> --json` is `get_issue`;
your SKILL's cheat-sheet block carries the exact flag surface.

### Linear MCP write hazards (read before any `save_issue`)

Four footguns that silently corrupt the loop — every skill must handle them. They are
**carrier-independent** (§18): on an `interface:"cli"` fire #1 and the `relatedTo`
append-only union surface verbatim as the `dev-loop ticket update` flags (`--labels`
REPLACES the full set; `--related-to` only ADDS), and the cheat-sheet block in each
SKILL repeats them as HAZARD lines:

1. **`labels` is REPLACE-style on update.** `save_issue(labels:[X])` overwrites the
   **entire** label set — it does not add X. (Unlike `blocks`/`relatedTo`, which are
   append-only with dedicated `remove*` params, `labels` has no add/remove
   primitive.) To add or remove ONE label (e.g. add `blocked`, drop `needs-pm`),
   first read the ticket's current labels, then re-pass the **full** intended set.
   Forgetting this drops `dev-loop` and breaks the safety firewall (§2) and pickup
   eligibility on the same call.
2. **State-name matching is fuzzy — verify after every move.** A `save_issue` with
   `state:"In Review"` can silently route to a different same-category state. After
   EVERY state transition, re-fetch the ticket (`get_issue`) and confirm `.state` is
   exactly what you set. If it isn't, retry once; if it still won't land, leave a
   one-line comment and treat the ticket as untouched this fire (don't build on an
   unverified move). (If the operator set `blockedStateName`/added real states, the
   same verify-after-write applies.)
3. **`list_issues` takes ONE label filter.** For a multi-label slice (e.g.
   `dev-loop` AND `pm` AND `blocked`), filter Linear by the **most specific** label
   plus `project`, then narrow the rest client-side. Never widen the query to dodge
   this — the `dev-loop` + `project` scope (§2) is non-negotiable.
4. **Pass markdown with real newlines, never escaped `\n`.**
