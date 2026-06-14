# dev-loop — Shared Conventions

The single source of truth for the **PM / QA / Dev** agents that run an autonomous
software-development loop coordinated through **Linear**. All three skills load this
file. If a rule here conflicts with a skill's body, this file wins — keeping the
three agents interoperable is the whole point.

## Table of contents
1. [What the loop is](#1-what-the-loop-is)
2. [Safety boundary — the `dev-loop` label](#2-safety-boundary--the-dev-loop-label)
3. [Linear state machine](#3-linear-state-machine)
4. [Label taxonomy](#4-label-taxonomy)
5. [Priority & the Dev pick order](#5-priority--the-dev-pick-order)
6. [Ticket templates](#6-ticket-templates)
7. [Claiming a ticket (concurrency)](#7-claiming-a-ticket-concurrency)
8. [Deduplication](#8-deduplication)
9. [The Blocked protocol](#9-the-blocked-protocol)
10. [Querying Linear without drowning](#10-querying-linear-without-drowning)
11. [Per-project config](#11-per-project-config)
12. [Dry-run vs live](#12-dry-run-vs-live)
13. [First-run setup](#13-first-run-setup)

---

## 1. What the loop is

Three agents, each triggered manually by the user (`/pm-agent`, `/qa-agent`,
`/dev-agent`). They never call each other directly — they hand off **entirely
through Linear ticket state**, so any of them can run at any time, in any order,
even concurrently. Linear is the shared blackboard.

```
        PM ──proposes feature──┐                 ┌──QA proposes bug──┐
                               ▼                 ▼                   │
   strategy doc ──►  [Todo] ◄────────── grooming/unblock ───────────┘
                       │
        Dev claims ────┼──► [In Progress] ──ships──► [In Review]
                       │                                  │
            (dup/blocked)                    owner verifies (PM↔feature, QA↔bug)
                       ▼                          │            │
                 [Canceled/Duplicate]          pass▼        fail▼
                                               [Done]    back to [Todo]
```

- **PM** reads the product's strategy doc, exercises the real product, files
  **feature** tickets, and **verifies feature tickets** that reach `In Review`.
- **QA** runs happy-path + edge-case tests in the configured test environment,
  files **bug** tickets, and **re-tests bug tickets** that reach `In Review`.
- **Dev** pulls `Todo` tickets in priority order, grooms them (enough info? a
  duplicate?), implements, ships, and moves them to `In Review`.

The verifier of a ticket is always **its owner** (the agent that filed it),
identified by the owner label (§4). This is how PM picks up its features and QA
picks up its bugs for verification.

---

## 2. Safety boundary — the `dev-loop` label

**The Linear workspace contains real, human-owned tickets across multiple
products. The agents must never touch them.**

Hard rules, no exceptions:
- **Every** ticket an agent creates gets the `dev-loop` label, plus the
  configured `project` and `team`.
- **Every** query an agent makes is scoped with `label: "dev-loop"` AND the
  configured `project`. An agent may only read, comment on, transition, assign,
  cancel, or relate tickets that carry the `dev-loop` label.
- If a query would return tickets without the `dev-loop` label, the filter is
  wrong — fix the filter, never widen the blast radius.
- Agents never delete tickets (no delete capability exists anyway) and never
  bulk-mutate. State changes are one ticket at a time, each justified by this doc.

This single label is the firewall between the autonomous loop and the human
backlog. Treat it as load-bearing.

---

## 3. Linear state machine

The Citronetic team has these workflow states (use the **name** with
`save_issue`'s `state` field): `Backlog`, `Todo`, `In Progress`, `In Review`,
`Done`, `Canceled`, `Duplicate`. There is **no "Blocked" or "Processing" state** —
"Processing" maps to `In Progress`, and "Blocked" is a label (§9), not a state.

| State | Meaning | Who moves it here |
|---|---|---|
| `Backlog` | Idea captured but not yet ready for dev (optional parking) | PM/QA |
| `Todo` | Groomed, ready to be picked up | PM/QA (on create), Dev (on un-block), verifier (on verify-fail) |
| `In Progress` | A Dev has claimed it and is actively working | Dev (claim) |
| `In Review` | Dev finished; awaiting verification by the owner | Dev (done coding) |
| `Done` | Verified passing against acceptance criteria | Owner (PM/QA) |
| `Canceled` | Won't-do / obsolete / superseded | Any agent, with a comment why |
| `Duplicate` | Same as another ticket; set `duplicateOf` | Dev (during grooming) |

**Verify-fail** is a first-class transition: when an owner verifies an
`In Review` ticket and it does **not** meet acceptance criteria, move it back to
`Todo` and add a comment listing exactly what failed (so Dev knows what to fix).
Do not leave it in `In Review`.

---

## 4. Label taxonomy

Labels do triple duty: typing, ownership/routing, and workflow signalling.

**Marker (mandatory on every ticket):**
- `dev-loop` — the safety marker from §2.

**Type (exactly one):**
- `Feature` — new capability. Owner = PM.
- `Bug` — defect. Owner = QA.
- `Improvement` — polish / refactor / UX nit. Owner defaults to PM (`pm`) so it
  has a verifier; tag `qa` instead when QA filed it.

**Sub-type (optional, additive):**
- `edge-case` — a bug found off the happy path (affects Dev ordering, §5).

**Ownership / routing (every ticket carries exactly one owner label):**
- `pm` — PM owns it (PM verifies). On every `Feature`, and on `Improvement`s by
  default.
- `qa` — QA owns it (QA verifies). On every `Bug`, and on QA-filed `Improvement`s.

Every ticket **must** have an owner label, or it strands at `In Review` with
nobody to verify it. PM verifies In Review tickets tagged `pm` (Features +
Improvements); QA verifies those tagged `qa` (Bugs + Improvements).

**Workflow signalling:**
- `blocked` — Dev couldn't proceed; needs owner attention (§9).
- `needs-pm` / `needs-qa` — routes a blocked ticket to the right owner.

`Bug`, `Feature`, `Improvement` already exist in the workspace. The rest are
created once at setup (§13). Priority/urgency is **not** a label — it is Linear's
native `priority` field (§5).

---

## 5. Priority & the Dev pick order

Urgency lives in Linear's `priority` field: `1=Urgent, 2=High, 3=Medium,
4=Low, 0=None`. PM/QA set it on create.

**Dev pulls `Todo` tickets in this exact order** (the user's stated ordering):

| Rank | Class | Selector |
|---|---|---|
| 1 | Urgent bug | `priority=1` + `Bug` |
| 2 | Urgent feature | `priority=1` + `Feature` |
| 3 | Edge-case bug | `Bug` + `edge-case` |
| 4 | General feature | `Feature` |
| 5 | Improvement | `Improvement` |

Within a rank, oldest `createdAt` first (FIFO — don't let tickets starve).
A `Bug` without `edge-case` and without `priority=1` sorts just above general
features (it's still a defect); place it at rank 3.5 in practice: ahead of
features, behind explicit edge-case bugs. When in doubt, defects beat features.

---

## 6. Ticket templates

Tickets must carry enough for Dev to act without guessing — otherwise Dev will
(correctly) block them (§9). Use these Markdown bodies verbatim as scaffolding.

**Feature (PM):**
```markdown
## Context
Why this matters / which strategy-doc goal it serves.

## Acceptance criteria
- [ ] Observable, testable outcome 1
- [ ] Observable, testable outcome 2

## Affected area
Route / module / surface (e.g. `/checkout`, `productRouter.addByUrl`).

## How to verify
Exact steps PM will run in the test env to mark this Done.
```

**Bug (QA):**
```markdown
## Summary
One line: what's broken.

## Repro steps
1. ...
2. ...

## Expected vs actual
- Expected: ...
- Actual: ...

## Environment
URL / build / persona / device used.

## Severity & scope
Who/what is affected, how often.

## Acceptance criteria
- [ ] The repro above no longer reproduces
```

Set the title as a crisp imperative (`Add …`, `Fix …`). PM/QA fill the template,
set type+owner labels, set `priority`, attach `dev-loop`, and set `project`.

---

## 7. Claiming a ticket (concurrency)

Two Dev runs could race for the same ticket. The claim **is** the state move:

1. Dev picks the top-ranked `Todo` ticket (§5).
2. Immediately `save_issue`: `state="In Progress"`, `assignee="me"`.
3. Re-fetch the ticket. If `assignee` is not you or `state` isn't `In Progress`,
   another Dev won the race — drop it and pick the next one.
4. Only then start coding.

Same idea for verification: an owner verifying an `In Review` ticket should leave
a comment as it starts, so a second verifier sees it's in progress. For an
instantaneous verification/re-test you may fold that claim into your single
verify+verdict comment — the separate pre-claim matters mainly for long-running
work where a second agent could otherwise start in parallel.

---

## 8. Deduplication

Before **creating** any ticket, PM/QA must search for an existing one:
- `list_issues` scoped to `project` + `label:"dev-loop"`, with a `query` of the
  key nouns/verbs of the proposed ticket.
- If a substantively equivalent ticket exists in any non-terminal state, **do not
  create a new one** — add a comment with the new observation instead, or bump
  priority if more urgent.

During **grooming**, if Dev finds the picked ticket duplicates another, set
`state="Duplicate"`, set `duplicateOf` to the canonical ticket, comment, and move
on. Never implement the same thing twice.

---

## 9. The Blocked protocol

When Dev cannot proceed — missing info, contradictory acceptance criteria, a
dependency, or a suspected-but-unconfirmed duplicate — it does **not** guess:

1. Add the `blocked` label + the routing label (`needs-pm` for features,
   `needs-qa` for bugs).
2. Remove its own assignment and move the ticket back to `Todo` (it is not being
   worked) — the `blocked` label keeps it out of the normal pick set.
3. Add a comment stating **exactly** what's missing or wrong and what would
   unblock it.

PM/QA, on each run, check for **their** blocked tickets
(`label:"dev-loop"` + `label:"blocked"` + their owner label). For each: read the
comment, then either
- **resolve** — add the missing info / fix the criteria, remove `blocked` +
  `needs-*`, leave it in `Todo`; or
- **cancel** — if the block reveals the ticket is invalid, set `Canceled` (or
  `Duplicate`) with a comment.

Dev's pick query (§5) must exclude `blocked` tickets.

> Optional board nicety: the user may add a real "Blocked" workflow state in the
> Linear UI. If they do, set `blockedStateName` in config and the agents will use
> the state instead of the label. Until then, the label is authoritative.

---

## 10. Querying Linear without drowning

`list_issues` with no filter can return hundreds of KB (the workspace has
250+ human tickets). Always:
- scope by `project` **and** `label:"dev-loop"`, plus `state` and/or other
  `label`s for the slice you want;
- pass a tight `limit` (e.g. 20–50);
- when you only need to act on one ticket, fetch that one with `get_issue`.

Never page through the whole workspace. If a result is still huge, your filter is
too broad — narrow it before reading.

---

## 11. Per-project config

The agents are product-agnostic; everything product-specific lives in
`${CLAUDE_PLUGIN_DATA}/projects.json` (schema + example:
`${CLAUDE_PLUGIN_ROOT}/references/config-schema.md`, `${CLAUDE_PLUGIN_ROOT}/config/projects.example.json`).

On startup each skill:
1. Reads `projects.json`.
2. If the user named a project, uses it; if exactly one project is configured,
   uses it; otherwise asks which project to operate on.
3. Loads that project's `linearProject`, `linearTeam`, `repoPath`,
   `strategyDoc`, `testEnv`, `build`, `deploy`, `git`, and `mode`.

If `projects.json` is missing or the chosen project lacks a required field, the
skill asks the user for the missing value and offers to write it back to config —
it never guesses repo paths, URLs, or deploy commands.

---

## 12. Dry-run vs live

Each project has a `mode`:
- `"live"` — agents create/transition Linear tickets, and (for Dev) commit, push,
  and deploy per the project's `git`/`deploy` config.
- `"dry-run"` — agents do all the **analysis** and print exactly what they *would*
  do (tickets they'd file, code diffs they'd make, commands they'd run) to a
  report, but make **no** Linear mutations, no git push, and no deploy.

Always confirm the active `mode` in the run's opening summary. Use `dry-run` for
first contact with a new project and for all skill-eval runs, so testing never
mutates real Linear or ships real code.

---

## 13. First-run setup

Idempotent; safe to re-run. Before the first live run against a workspace:
1. Ensure the workflow labels exist (create only the missing ones via
   `create_issue_label` on the configured team): `dev-loop`, `pm`, `qa`,
   `edge-case`, `blocked`, `needs-pm`, `needs-qa`. (`Bug`/`Feature`/`Improvement`
   already exist — reuse, don't duplicate.)
2. Ensure the `linearProject` exists; if not, ask the user before creating it.
3. Confirm `strategyDoc` is readable and `testEnv`/`build`/`deploy` commands are
   correct with the user (these gate real deploys).
