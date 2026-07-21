# The `service` backend — the agent contract

Read when the resolved `backend` is `service`, before your first board operation of a
fire. This file is the CONTRACT an agent needs in order to act. The implementation record
— runtime/transport, threat model, decision provenance, mirror internals, MCP/env setup —
is `docs/HUB-ARCHITECTURE.md` and is operator/developer reading, not agent boot material.

- **Ops.** The op names are the same as the Linear MCP (`list_issues` / `get_issue` /
  `save_issue` / `save_comment` / `list_comments` / `list_issue_labels` /
  `create_issue_label` / `get_project`, plus the `doc.*` and `list_events` families) with
  the same args and semantics — every conventions rule applies as written: REPLACE-style
  labels (§10#1), verify-after-write (§7/§10#2). **Your invocation surface is your
  SKILL's generated cheat-sheet block**: on `interface:"cli"` fires (the default) each op
  is a `dev-loop` CLI command and NO hub MCP is injected; on `interface:"mcp"` fires the
  identically-named hub MCP tools appear instead. Run the cheat sheet's first command
  (`dev-loop project --json`) before anything else — exit `4` ⇒ identity/guard failure:
  stop the fire, touch nothing. Exit codes are the machine contract: `0` ok · `1` domain
  error · `2` usage · `3` `doc.save` CAS conflict · `4` identity/guard · `5` hub
  unavailable. Two deliberate divergences, both in your favor: a typo'd `state` ERRORS
  instead of silently mis-routing (kills the §10#2 fuzzy-match footgun), and ticket-id
  allocation is race-safe.
- **Identity.** You are a distinct actor (`DEVLOOP_ACTOR`, set by the launcher — already
  in your env when you wake). `assignee:"me"` (the §7 claim) resolves to YOUR actor, and
  every move / comment / event is stamped with it. Split-dev projects add
  `senior-dev` / `junior-dev` actors (§21b encoding); the operator is its own actor.
- **Project scope.** Your calls touch ONLY your own project — structural, not advisory.
  Stewards (`sweep`/`ops`/`reflect`/`communication`) may pass `project:<key>` or `_team`;
  PM may pass `_team` only (§9b); the operator may name any project; every other agent is
  refused `FORBIDDEN`.
- **Write semantics.** `save_issue` takes `duplicateOf` (scalar — set it with
  `state:"Duplicate"`, §8) and `relatedTo` (**append-only** — re-passing unions into the
  set, never replaces; §4 splits, §15 coverage). `parentId` / `blockedBy` / `blocks` do
  not exist — blocking is the `blocked` label (§9).
- **Docs.** `strategyDoc` defaults to a repo file. With `hub.docs:true` (or a
  `{ "hubDoc": "<kind>" }` strategyDoc) the strategy/roadmap become hub documents: any
  agent appends DRAFT versions via `doc.save` (optimistic CAS — a CONFLICT carries
  `latestVersion`; recover with `doc.get {version:"latest"}` → re-apply → re-save with
  that `baseVersion`), and ONLY the operator flips a draft → `current` (`doc.publish`).
  A senior-dev module design is doc-kind **`design`**: one doc per module slug, NOT
  publish-gated — the latest saved draft IS the live design; consumers read latest
  (§21a).
- **Mirror / events.** The optional one-way Linear mirror is **Sweep's job alone** — Job 5
  in its SKILL carries the full operational contract; no other agent touches it. Reflect
  reconstructs its retrospective window from **`list_events`** (append-only, actor-stamped
  transitions/comments). Neither concerns any other agent.

Dev-tier encoding (split-dev): a cross-backend contract, defined resident in §18 — not
re-stated here.
