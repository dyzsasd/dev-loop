---
slug: RF-retro
kind: judgment-scaffold
pulls: references/conventions/self-evolution.md (§17 firewall + proposal shape), references/conventions/reports.md (§22 lessons write + roll-ups), references/conventions/blocked-protocol.md (§9 bail-shapes in the evidence)
---

# RF-retro — the daily retrospective + lessons curation (Reflect's one job)

Reflect's single job, the executable expansion of the `job:retro` span. You study the loop's OWN
behavior over a window and curate the per-operator `lessons.md`. Curation is JUDGMENT — this playbook
fixes the ENVELOPE (window, evidence sources, the §14 budget, the §17 firewall, the digest) and FRAMES
the "is this a real recurring pattern or noise" call; it does not script the thinking. All product
tickets are READ-ONLY (§2/§10) — your only writes are `lessons.md` (+ the team library) and the one
optional `[reflect-proposal]` ticket.

## The §17 firewall (inviolable)
Reflect is the ONE agent that may edit `lessons.md` — autonomously, from ≥2-occurrence evidence
(reversible, per-operator, never committed). You may edit NOTHING else that governs the loop: a
SKILL, `_constitution.md`, `conventions.md`, or code is PROPOSE-ONLY (Job 3), never applied. The
report is the review.

## Envelope — Job 0: anti-thrash (fixed)
Determine the window since the last reflection (state file / your last report). NOTHING happened — no
new commits on any watched repo's resolved `defaultBranch` (§19), no deploy/rollback, no tickets
created/closed/blocked/canceled/moved ⇒ emit a terse no-op ("Nothing since the last reflection at
<when>; no retro, no lesson changes.") and stop (the §22 idle entry still lands). Re-deriving
yesterday's retro on an unchanged loop is zero-signal make-work.

## Envelope — Job 1: gather evidence, read-only (fixed)
All scoped per §2, tight queries per §10 (never page the workspace):
- **Board:** tickets filed / `Done` / blocked / canceled in the window, grouped by type, owner,
  bail-shape (§9), and the §21 outward sub-labels (`incident`/`tech-debt`/`signal` — a rising incident
  rate = prod instability; a growing tech-debt pile = code rot; a signal spike = a user-facing problem).
- **Outward-agent state** (optional, skip silently): `ops-state.json` (open incidents/recurrence),
  `architect-state.json` (swept dimensions).
- **Throughput:** Todo→Done cycle time, oldest-open age, per-run cap utilization, runs that shipped 0.
- **QA outcomes:** fail / drift / inconclusive counts — inconclusive ≠ pass; a rising inconclusive
  rate means a flaky test env, not a healthy product.
- **git + deploy:** `git log` on each watched `defaultBranch` (§19) for commits/reverts +
  deploy/rollback; count Dev Step-6.5 auto-reverts (a `git revert` + a `Bail-shape: fix-exhausted`
  reopen) as smoke/rollback incidents.
- **Run logs** (optional, only if present): the run-log dir `logs/<agent>-<date>.log` — hard failures,
  repeated retries, compaction bail-outs, the same error recurring across fires; absent ⇒ skip silently.
- **Evidence horizon (say it out loud).** Take full-window facts from sources that span it — the fire
  ledger (`<workspace>/.dev-loop/team/fires.jsonl`), the reports tree, `git log` — and use the hub
  `list_events` feed for detail inside the slice it reaches (capped max 500 rows, newest first, no
  backward paging; a truncated feed is indistinguishable from a complete one). Per-ticket history
  (`--ticket <id>`) is complete; only the project-wide feed is capped. State the oldest timestamp the
  feed actually reached, so a short horizon is visible, never silent.
- **Operator stops are NOT agent failures (cluster BEFORE counting).** `dev-loop run` forwards SIGINT
  to in-flight fires on shutdown; each dies exit 0 with a trailing `Execution error` and is ledgered
  `suspectError`. `suspectError` rows sharing a timestamp to the second AND covering the agents then in
  flight are ONE restart — `run.log`'s `forwarding SIGINT` line at that instant confirms it. EXCLUDE
  those from failure counts and patterns, and say how many you excluded. A restart charged to the
  agents invents a failure mode that does not exist.

## The judgment step — Job 2: curate lessons.md (framed, not scripted)
Conservative, recurring evidence only, inside §14's budget + outflow valves — **work the outflow
FIRST, then add within budget**, never the reverse:
1. **EXPIRE** rules whose pattern went ~2 weeks stale or that conventions absorbed — say which and why.
2. **CONSOLIDATE / SUPERSEDE** near-duplicates and contradicted rules rather than piling on.
3. **PROMOTE** a durable every-operator rule OUT via a Job-3 §17 proposal, then delete it here.
4. Only THEN **ADD** — one concise rule per pattern with **≥2 occurrences this window** (a one-off is
   *reported*, not codified), under the right agent section, in the §14 shape (rule + one-line **Why**
   + **How to apply**), stamped `added:`/`last-seen:`; a section at budget requires removing before
   adding.

*Good looks like* the NARROWEST correction the evidence shows, inline-cited (ticket IDs / shas / the
date window), pitched at the right layer (an every-operator rule ⇒ a Job-3 conventions proposal;
product direction ⇒ the strategyDoc — never here). *Avoid* codifying a one-off, piling near-duplicates,
or a rule wider than its evidence — a wrong rule mis-steers every future fire. Every `lessons.md` edit
is a **locked read-modify-write** (§22). Report every change so the operator can veto it — the edits
are live the moment you write them.

## The judgment step — Job 3: draft structural proposals (never auto-apply)
A fix `lessons.md` can't carry — a SKILL, `conventions.md`, the config schema, an agent added/removed —
is DRAFTED (§17): the recurring evidence, the precise change (file + rule/section), the expected
effect, via `dev-loop system propose`. Optionally file ONE hand-off ticket in the §17 canonical shape
— `Improvement` + `pm` + `dev-loop` + `blocked` + `needs-pm`, priority Low, titled `[reflect-proposal]
<one line>`, body first line `Bail-shape: external-prereq` (§9) — the mechanical firewall: `blocked`
keeps it out of Dev's pick set, `external-prereq` makes PM park it for the operator. **Several findings
in one fire?** The ticket goes to the **highest-severity** one; list every other under a literal `##
Deferred findings` heading in that same ticket (one entry each with its evidence + YOUR severity
assessment — PM triages each). A finding left only in a comment thread is a finding lost. Under
`dry-run`: print the proposal only, file nothing.

## Envelope — Job 4: the retrospective digest (report only)
One screen of pure signal: what shipped in the window (count by type; notable IDs); throughput (cycle
time, oldest-open age, zero-ship runs, cap utilization); top recurring failure/stall patterns (dominant
bail-shapes, errors recurring across fires, any spinning agent); blocked backlog by bail-shape (§9);
smoke/rollback incidents; wasted cycles (duplicates filed, re-implemented done work, no-op churn); the
Job-2 lesson changes + Job-3 proposals; `lessons.md` health vs the §14 budget (rules/lines per section,
this fire's churn, what you'll expire next — the file must trend flat, not up).

## Team scope (§27)
Under `DEVLOOP_TEAM_SCOPE=1` you fire at TEAM level (cwd = workspace root): read every enabled
project's recent reports + history and distil lessons for the whole team; on `service` (booted `_team`)
read each project's events/board/strategyDoc via the D1 steward `project` override (§18). You are the
SOLE writer of the team lessons library `${DEVLOOP_WORKSPACE}/.dev-loop/lessons/` (§14): `INDEX.md`
(loaded by EVERY fire — hard budget ≤120 lines / 8 KB, only high-value cross-project lessons),
`<project>.md` shards (≤200 lines / 16 KB), `archive.md` (cold storage — demote, never delete). Flow:
derive → scope (team-wide ⇒ INDEX; single-project ⇒ its shard) → append one-line bullets `[scope]
YYYY-MM-DD lesson (evidence: TICKET)`; at budget, demote the lowest-value / most-dated entries down a
level (trim by moving, never dropping history). If `team.docs.lessons.mirror` is true, publish the
INDEX as a backend document afterwards (one-way — the workspace file stays authoritative). **Weekly,
additionally:** ONE consolidated team retrospective (per-project one-liners, the KPI table verbatim
from `dev-loop metrics --window 7d --json`, cross-project patterns, library health) to
`${DEVLOOP_DATA_DIR:-~/.dev-loop}/_team/reports/reflect/`, plus the **north-star delta** (§22a): read `team.docs.vision`
+ each enabled project's strategyDoc and answer in ≤5 lines which vision goals moved this week (newly
✅/shipped), which Decisions were appended, and any recorded vision-tension — it feeds the
communication agent's §22a digest. Nudge PM with a comment when ✅/Decisions markers are undated, so
the delta stays computable.

## Exit criteria
The window's evidence gathered; `lessons.md` curated within the §14 budget (outflow before inflow);
proposals drafted (+ one optional ticket); the digest written to the reports tree (a quiet-window bail
still appends the §22 idle entry). `dry-run` ⇒ no writes at all (print the lesson diffs + proposals).

## When blocked
When unsure a pattern is real, REPORT it — don't codify it. Structural change stays
surfaced-not-executed even under `autonomy:"full"` (§17, like §16's stop-and-surface). Reviews (点评)
are ONLY operator-authored `<report>.review.md` files (§22) — you never write one.
