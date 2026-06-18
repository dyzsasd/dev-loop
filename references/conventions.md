# dev-loop — Shared Conventions

The single source of truth for the **PM / QA / Dev / Sweep / Reflect** agents that
run an autonomous software-development loop coordinated through **Linear**. All five
skills load this file. If a rule here conflicts with a skill's body, this file wins —
keeping the five agents interoperable is the whole point.

## Table of contents
0. [Prime directive — every fire is fresh](#0-prime-directive--every-fire-is-fresh)
- [Topology at a glance](#topology-at-a-glance)
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
14. [Lessons file — per-operator corrections](#14-lessons-file--per-operator-corrections)
15. [Test coverage — every Bug/Feature earns a regression test](#15-test-coverage--every-bugfeature-earns-a-regression-test)
16. [Security doctrine](#16-security-doctrine)
17. [Self-evolution boundary — what the Reflect agent may change](#17-self-evolution-boundary--what-the-reflect-agent-may-change)
18. [Backend — Linear vs local](#18-backend--linear-vs-local)

---

## 0. Prime directive — every fire is fresh

These agents run on a recurring loop; each fire is a fresh, possibly-compacted
session. Treat this and the skill file as the **complete** instruction set — you
need no external context to proceed.

- **Each fire re-executes every step from the top.** Do NOT skip a step because
  you remember doing it last fire — you may be a fresh session with compacted memory.
- **Never trust conversation memory for state.** State lives in Linear (ticket
  state/labels/comments), in git (`HEAD`, `git log`), and on disk (the
  `*-state.json` files, §11). Go read it directly every fire — don't infer it
  from what the conversation "remembers".
- **Don't abort because context feels thin.** Missing conversation context is
  normal on a fresh fire; it is not a reason to stop.
- **On a genuine hard failure, log ONE line and exit cleanly** — the next fire
  retries. Never halt mid-flight waiting for a human (that violates the
  autonomous-loop posture, §12a). *If you had already taken a side-effecting
  action this fire* (filed/moved a ticket, committed, deployed), still write the
  normal close-report (each skill's §3) before exiting, so the state stays
  auditable. Genuine external-prerequisite blocks are recorded on the ticket
  (§9), not raised as an interactive prompt.

---

## Topology at a glance

The one-screen map every agent reads first. Detail is one hop away in the
numbered sections below.

| Agent | Owns (files + verifies) | Picks up | Hands off via |
|---|---|---|---|
| **PM** | `Feature`, `Improvement`(`pm`) | In Review `pm` items; `blocked`+`needs-pm`; review lenses (Job C preflight) | Linear state + labels |
| **QA** | `Bug`, `Improvement`(`qa`), `coverage` | In Review `qa` items; info-blocks; new-bug sweep | Linear state + labels |
| **Dev** | (ships everyone's tickets) | `Todo` in pick order (§5), excluding `blocked` | In Review, for the owner |
| **Sweep** | (nothing — hygiene only) | Tickets that fall through the cracks: missing/wrong owner label, orphaned `In Progress`, stale signals (cross-owner) | re-label/re-route → the right owner |
| **Reflect** | (nothing — observes the loop) | The loop's own behavior over a window: tickets/git/logs/throughput/QA outcomes (read-only) | `lessons.md` (autonomous) + a drafted proposal in the report (never auto-applies SKILL/conventions) |

State machine: `Todo → In Progress → In Review → Done` (verify-fail returns to
`Todo`; `Canceled`/`Duplicate` are terminal; `blocked` is a **label**, not a
state, §9). Eligibility = the `dev-loop` label (§2); owner = the `pm`/`qa` label
(§4); routing = `needs-pm`/`needs-qa`/`coverage`/`edge-case`.

**What NOT to confuse:**
- **Block ≠ cancel.** Block = needs info/decision, stays alive at `Todo`+`blocked`
  (§9). Cancel = invalid/obsolete, terminal.
- **Defect ≠ capability gap.** A defect is a `Bug` (QA's). A missing capability is
  a `Feature` (PM's). Stay in your lane (PM/QA guardrails).
- **Verify against the running product / the diff — not the claim.** Owners verify
  by exercising the product (PM/QA Job A); Dev self-reviews against its own diff
  (Dev Step 5.5). Never trust a hand-off comment's claim of what was done.
- **Inconclusive ≠ pass.** A check that couldn't actually run is not a green
  (QA Job A).

---

## 1. What the loop is

Five agents, each triggered manually by the user (`/pm-agent`, `/qa-agent`,
`/dev-agent`, `/sweep-agent`, `/reflect-agent`). They never call each other directly —
they hand off **entirely through Linear ticket state**, so any of them can run at any
time, in any order, even concurrently. Linear is the shared blackboard. (PM/QA/Dev are
the core producing loop; Sweep is a slower-cadence janitor layered on top; Reflect is
the slowest — a daily retrospective that observes the loop and curates `lessons.md`.)

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
- **Sweep** is the lifecycle janitor (slower cadence): it fixes tickets that fall
  through the cracks of the three owner-scoped agents — missing/wrong owner labels
  (invisible to every owner query), orphaned `In Progress`, stale signals — and
  reports board health. **Hygiene only**: it never verifies, implements, files
  Features/Bugs, or ships.
- **Reflect** is the retrospective + self-evolution role (slowest cadence — daily):
  it studies the loop's **own** behavior over a window (tickets, git/deploy, run logs,
  throughput, QA outcomes), emits a retrospective, and **curates `lessons.md`** (§14)
  from recurring evidence. **Observe + curate only**: no product work (never files
  Features/Bugs, ships, or verifies); may autonomously edit only `lessons.md` —
  structural changes to the SKILLs/this file are **drafted as proposals, never
  auto-applied** (§17).

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

**In `local` mode the board *directory* is the firewall** (§18): a dedicated,
machine-local ticket store with no human backlog in it, so the human-backlog axis of
isolation is structural rather than label-enforced. Tickets still carry `dev-loop` and queries still scope to
it for parity, but "scope by `project`" means "operate only within this project's
board dir" — and a glob must never escape it (the cross-project axis still applies).

---

## 3. Linear state machine

Your Linear team has these workflow states (Linear's defaults; use the **name** with
`save_issue`'s `state` field): `Backlog`, `Todo`, `In Progress`, `In Review`,
`Done`, `Canceled`, `Duplicate`. There is **no "Blocked" or "Processing" state** —
"Processing" maps to `In Progress`, and "Blocked" is a label (§9), not a state.
These same state names are authoritative in both backends — in `local` mode (§18) the
state lives in the ticket file's frontmatter `state:` field (a field rewrite, not a
folder move), using these exact names.

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
  has a verifier; tag `qa` instead when QA filed it (exception: a `coverage`
  Improvement is `qa`-owned even though Dev files it — see the sub-type below).

**Sub-type (optional, additive):**
- `edge-case` — a bug found off the happy path (affects Dev ordering, §5).
- `coverage` — a follow-up to add a regression test/flow for a shipped
  `Bug`/`Feature` that couldn't be covered in the fix itself (§15). Filed by Dev,
  owned by `qa` (QA verifies the test exists and passes); implemented like any
  other `Todo` ticket.

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

**Shared working copy ≠ isolation.** The Linear claim dedups *tickets*, but if two
Dev agents run against the **same git checkout**, their commits, `git add -A`, and
deploys interleave on one working tree — one agent can scoop up another's
uncommitted files, and concurrent prod deploys race (last one wins). So before
committing, `git status` and confirm the staged diff is **only your ticket's
files**. If you're knowingly running more than one Dev, give each an isolated
worktree/clone. If commits you didn't author appear mid-run, surface it in the
report rather than building on top blindly.

---

## 8. Deduplication

Before **creating** any ticket, PM/QA must search for an existing one:
- `list_issues` scoped to `project` + `label:"dev-loop"`, with a `query` of the
  key nouns/verbs of the proposed ticket.
- If a substantively equivalent ticket exists in any non-terminal state, **do not
  create a new one** — add a comment with the new observation instead, or bump
  priority if more urgent.

**Dedupe against reality, not just against tickets.** A capability can be *already
built* in the product with no `dev-loop` ticket tracking it — and strategy docs and
test plans are point-in-time snapshots that go stale as the product ships. Before
filing, confirm the gap (or bug) still exists in the **current** product/codebase,
not merely in the doc. Never file work that's already done; if it's done but
unverified, that's a line in your report, not a new ticket.

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
   unblock it, and **tag the bail shape** on the first line so the right owner
   routes it deterministically (no human prompt — async triage):
   `Bail-shape: <info-needed | decision-needed | scope-design | external-prereq | fix-exhausted>`.
   - **info-needed** (missing repro/seed/account/clarification) → QA can clear it
     (QA Job B), even if not tagged `needs-qa`.
   - **decision-needed / scope-design** (a product/scoping call) → PM (`needs-pm`)
     or the bug's owner.
   - **external-prereq** (real credentials/money/legal, or a capability this run
     lacks) → park for the user; report as a fact (§12a), don't retry.
   - **fix-exhausted** (tried, couldn't make the gates/self-review pass) → don't
     blindly re-attempt; it needs new info or a different approach. Cap blind
     retries at 2 — the 3rd is a block, not another attempt.

PM/QA, on each run, check for **their** blocked tickets
(`project` + `label:"dev-loop"` + `label:"blocked"` + their owner label — always
include `project`; an unscoped label query returns blocked tickets from *every*
dev-loop project and you must never touch another project's backlog, §2). For each:
read the comment, then either
- **resolve** — add the missing info / fix the criteria, remove `blocked` +
  `needs-*`, leave it in `Todo`; or
- **cancel** — if the block reveals the ticket is invalid, set `Canceled` (or
  `Duplicate`) with a comment.

**Resolving means unblocking.** A block that's really a question or a design/scoping
decision the owner can answer is resolved by answering it **and** removing `blocked`
+ `needs-*` (encode any safety in the acceptance criteria — e.g. a feature flag, a
regression test — so Dev proceeds safely), not by replying and leaving it parked.
Reserve a standing block / user-escalation for decisions only a human can own:
irreversible/destructive prod actions, money, legal, or security sign-off.

**A standing escalation can resolve out-of-band — re-scan, don't fire-and-forget.**
When you escalate to the user, the resolution often arrives as a **comment** on the ticket
(an authorization, the decision you asked for), and `blocked` may get stripped while a stale
`needs-*` lingers — so a plain `label:"blocked"` query misses it. Each run, also re-read the
latest comment on tickets you parked, and treat a `needs-*` label without `blocked` as
"finish the job." Once the human supplies the decision, the block is resolved: clear the
stale routing label and act. If the now-unblocked action is itself sensitive/irreversible,
the **owner executes it attended** (verify precondition → use the safe/records-only command
form → verify end state), rather than routing an irreversible op into another agent's
unattended auto-pick set.

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

**Local backend (§18): the same discipline, on files.** `list_issues` becomes a
glob+parse+filter over the board's `tickets/*.md`; still filter to the narrow slice
you need (by state/label/type) rather than parsing every file blindly, and `get_issue`
a single file when that's all you need. The write hazards below — labels are
REPLACE-style (re-pass the FULL set), and verify-after-write — apply equally to a
frontmatter rewrite (re-read the file to confirm `state:`/`labels:` landed).

### Linear MCP write hazards (read before any `save_issue`)

Four footguns that silently corrupt the loop — every skill must handle them:

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

---

## 11. Per-project config

The agents are product-agnostic; everything product-specific lives in
`${CLAUDE_PLUGIN_DATA}/projects.json` (schema + example:
`${CLAUDE_PLUGIN_ROOT}/references/config-schema.md`, `${CLAUDE_PLUGIN_ROOT}/config/projects.example.json`).

On startup each skill:
1. Reads `projects.json`. If `${CLAUDE_PLUGIN_DATA}` resolves to an empty or
   `-local` data dir (the install name and the data dir can differ), fall back to
   `~/.claude/plugins/data/dev-loop/projects.json`, or search
   `~/.claude/plugins/data/**/projects.json`, before asking the user.
2. If the user named a project, uses it; if exactly one project is configured,
   uses it; otherwise asks which project to operate on.
3. Loads that project's `linearProject`, `linearTeam`, `repoPath`,
   `strategyDoc`, `testEnv`, `build`, `deploy`, `git`, `mode`, and `autonomy`
   (optional — see §12; absent ⇒ the conservative `"ask"` default). It also loads
   `backend` (`"linear"` | `"local"`; **absent ⇒ `"linear"`**, so existing projects
   are unchanged) and, for `local`, the optional `localBoard` path and `ticketPrefix`
   (§18). (A per-agent `models` map may also be set, but it is applied by the
   **launcher** at session start — `claude --model …` — not loaded or chosen by the
   agents; see config-schema.md and `docs/RUNNING.md`.)

If `projects.json` is missing or the chosen project lacks a required field, the
skill asks the user for the missing value and offers to write it back to config —
it never guesses repo paths, URLs, or deploy commands.

**Runtime files in the data dir.** Alongside `projects.json`, each agent keeps
local per-operator state next to it: `pm-state.json` / `qa-state.json` (the
last-reviewed/swept SHA and swept review-lenses (PM) / swept surfaces (QA)), and an
optional `lessons.md` (per-operator behavioral corrections, §14). These are
machine-local — never committed, never shared; created lazily on first run. **In
`local` backend mode (§18) the ticket board also lives here** —
`${CLAUDE_PLUGIN_DATA}/<project-key>/board/` (`tickets/`, `counter.json`), or wherever
`localBoard` points — under the same machine-local, never-committed rule.

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

**Mid-run overrides.** If the user explicitly asks for live behavior while config
says `dry-run` (e.g. "actually move the ticket", "merge and deploy"), treat it as
an explicit, session-scoped override — honor it, and offer to persist `mode:
"live"` to `projects.json` so a recurring/looped run stays consistent. Because
crossing from `dry-run` to `live` unlocks irreversible, outward-facing actions
(commits to `defaultBranch`, pushes, and especially a **production deploy** that
may then run on every loop tick), confirm the blast radius **once** before the
first such action — then proceed hands-off per the autonomy the user granted.
Don't re-confirm every ticket once authorized.

---

## 12a. Autonomy — how much to decide vs escalate

Orthogonal to `mode`, each project has an optional `autonomy`:
- **`"ask"` (default when absent)** — the conservative posture this doc otherwise
  describes: escalate genuinely human-only calls to the user (§9) and surface
  open product-direction decisions in the run report.
- **`"full"`** — the user has granted standing authority to **decide and act, not
  ask**. Resolve product-direction, scoping, and prioritization calls yourself,
  grounded in the `strategyDoc`; file/build the work rather than parking it. Do
  **not** end runs with "standing items for you to approve" or "want me to…?"
  prompts.

`autonomy:"full"` changes *who decides*, never *how carefully*. Caution is the
**method**, not a reason to defer:
- Verify against the running product; prefer **safe, reversible, additive,
  idempotent** changes; never ship on a red build/test gate.
- For an irreversible prod op (the migration/backfill class), do it **attended,
  with pre- and post-verification and the records-only/safe command form** (§9) —
  yourself, not by escalating.
- The only things that still stop you are **missing external inputs, not missing
  courage**: real third-party credentials/contracts, spending money, legal
  sign-off, or a capability you lack this run (e.g. driving a real browser over
  third-party sites). Report those as *blocked on an external prerequisite* — a
  fact, not a request for permission — and proceed with everything else.

This setting tunes §9's escalation rule and the PM/QA "surface it to the user"
guidance; under `"full"`, escalate only the genuine external-prerequisite cases
above.

---

## 13. First-run setup

**Prefer `/dev-loop:init` over wiring a project by hand.** The `init` skill
(`skills/init/SKILL.md`) is the canonical one-time, idempotent, **operator-present**
bootstrap (NOT a loop agent): it turns this checklist into an explicit, verifiable
flow — gather/validate config, ensure labels + the Linear project, verify/scaffold
the strategy doc, smoke the test env + build, create the runtime files — and ends
with a per-item readiness report. The loop agents still re-apply the label/project
checks below defensively on a first live run, so this checklist remains the contract:

Idempotent; safe to re-run. Before the first live run against a workspace:
1. Ensure the workflow labels exist (create only the missing ones via
   `create_issue_label` on the configured team): `dev-loop`, `pm`, `qa`,
   `edge-case`, `blocked`, `needs-pm`, `needs-qa`, `coverage`.
   (`Bug`/`Feature`/`Improvement` already exist — reuse, don't duplicate.)
2. Ensure the `linearProject` exists; if not, ask the user before creating it.
3. Confirm `strategyDoc` is readable and `testEnv`/`build`/`deploy` commands are
   correct with the user (these gate real deploys).
4. Create the runtime files next to `projects.json` if absent: `pm-state.json`,
   `qa-state.json`, and a `lessons.md` skeleton (§11, §14). (`/dev-loop:init` does
   this for you.)
5. **If `backend:"local"`** (§18): skip steps 1–2 (no Linear labels/project to
   provision — labels are just strings, and the board dir is the project container)
   and instead scaffold the board — `${CLAUDE_PLUGIN_DATA}/<project-key>/board/` with
   `tickets/` and a `counter.json` (`{ "prefix": "<ticketPrefix|DL>", "next": 1 }`) —
   and ensure `strategyDoc` is a **repo file** (a Linear document can't back a local
   board). `/dev-loop:init` does this.

---

## 14. Lessons file — per-operator corrections

A `lessons.md` next to the loaded `projects.json` (§11) lets the operator correct
agent behavior per-product **without forking this plugin's skills**. Each skill
reads it at the very top of every fire (right after conventions + config) and
applies any rule under its section that fire.

**Reflect is the curator of this file.** Every other agent only *reads* its own
section; the Reflect agent (§17) also *writes* it — adding/superseding/pruning
evidence-cited rules from recurring patterns it observes across runs. Reflect may edit
`lessons.md` autonomously because it is reversible, per-operator, and never committed;
it must NOT auto-edit this conventions file or the SKILLs (it drafts those as
proposals — §17).

Layout — one section per agent plus a shared section:

```
## Shared
## PM
## QA
## Dev
## Sweep
## Reflect
```

Each entry is a short rule with a one-line **Why** and **How to apply**. A rule may
pre-empt an action: *if a rule would have skipped or changed work you were about to
do, honor it.* Keep it lean (supersede stale rules, don't accumulate) — a wrong
rule is worse than none.

(Backend-agnostic: `lessons.md` is unaffected by the §18 backend dial — it is
per-operator runtime state regardless of whether tickets live in Linear or a local
board.)

**Local vs durable.** `lessons.md` is **local per-operator** machine state — never
committed, never shared. Patterns that should hold for *every* operator of this
plugin go in this conventions file; product-direction that should hold for every PM
run goes in the `strategyDoc`. `lessons.md` is the fast, private override layer.

**Keep it bounded — `lessons.md` is a working set, not an archive.** It's read by
every agent on **every** fire, so its size is a running tax on the whole loop; an
ever-growing rule list also means agents start silently ignoring rules. Hold it to a
budget with two **outflow** valves, so inflow never wins:

- **Budget (a forcing function, not a suggestion).** Target **≤ ~6 rules per agent
  section** and **≤ ~150 lines total** (a sane default; tune per product). When a
  section is at budget you may **not** add a rule without first removing one —
  expire, merge, supersede, or promote.
- **Date every rule** — `added: <date>` and `last-seen: <date>` (the most recent date
  its pattern recurred), so staleness is *measured*, not guessed.
- **Two ways a rule leaves:**
  - **Promote** — a rule that has proven durable and should hold for *every* operator
    graduates **out**: draft a §17 proposal to fold it into this `conventions.md` (or
    the `strategyDoc` for product direction); once the human applies it, **delete it
    from `lessons.md`** — the core now carries it, so it no longer costs a line here.
  - **Expire** — a rule exists to fix a *recurring* pattern; if that pattern hasn't
    recurred for **~2 weeks** (`last-seen` gone stale), the fix held or the code moved
    past it → **prune it**.
- **Consolidate.** Merge near-duplicate rules on one theme into a single general rule;
  never restate a rule that already lives in conventions (redundant → prune).

The healthy steady state is a **small, churning** set of recent, evidence-backed
corrections — durable wisdom keeps graduating to conventions, stale patches keep
expiring, and the file stays roughly flat in size however long the loop runs.

If the file is absent, proceed normally — it is optional.

---

## 15. Test coverage — every Bug/Feature earns a regression test

A fix isn't done until a regression test exists, or one is tracked to be added —
otherwise the same bug silently regresses on a later ship. When Dev ships a `Bug`
fix or a `Feature`, it MUST do exactly one of:

- **(A) Same run** — add/extend a test in the repo's test harness
  (`build.test` / the `testEnv` suite) that fails before the fix and passes after,
  and run it as part of the Step-5 gate; **or**
- **(B) Default for the loop** — file ONE follow-up ticket titled
  `[coverage] add regression test for <ticket-id>: <one line>`, labeled `dev-loop`
  + `Improvement` + `qa` + `coverage`, priority Low, `relatedTo` the original, in
  `Todo`, with crisp ACs naming the flow to cover. It then flows the **normal**
  path: a later Dev fire implements the test, and QA (its owner) verifies it. File
  it (deduped, §8) **before** moving the parent to `In Review` — same mandatory-
  filing discipline as a split (Dev §4).

**Exemptions** (no follow-up needed; state it in the hand-off): docs-only changes,
pure refactors with no behavior change, and fixes in code with no externally
testable surface (add a unit test in the fix instead and note it).

---

## 16. Security doctrine

These agents hold real credentials (Linear, GitHub, deploy/Vercel, and possibly a
prod DB) and ship unattended. Hard rules:

- **No secrets in the repo or in tickets.** Never commit passwords/tokens/keys or
  paste them into Linear comments. Reference where to obtain them (`.env.local`, a
  vault, "ask user") — config (§11) holds none.
- **No PII in ticket bodies, commits, or the strategy doc.** A repro or commit
  message must summarize *around* real user data, never quote it verbatim. (The
  test env may be backed by production data — treat every record as real.)
- **Least-scope, read-where-possible.** Prefer the safe/records-only form of any
  command (§9/§12a); never run a data-mutating variant as a "gate" (Dev §5).
- **Stop-and-surface on unexpected access — don't probe.** If an agent finds it has
  broader access than the task needs (e.g. write where you expected read, a project
  outside `dev-loop` scope), **stop and surface the discrepancy to the user as a
  fact** before doing anything with it. Do **not** probe to confirm the access. This
  is the one case where surfacing is correct even under `autonomy:"full"` — it's an
  external safety fact, not a product decision.

---

## 17. Self-evolution boundary — what the Reflect agent may change

The **Reflect** agent (the daily retrospective role) is the one agent that modifies
the loop's own operating instructions, so it carries a special hazard: a daily
self-modifying loop with no review compounds errors. The boundary is bright:

- **MAY edit autonomously: `lessons.md` only.** It is the scoped, **reversible**,
  **per-operator**, never-committed override layer (§14). Reflect curates it from
  **recurring** evidence (≥2 occurrences), every rule citing its evidence (ticket IDs
  / commit shas / window), superseding and pruning to keep it lean. Every change is
  reported so the operator can veto it.
- **MUST NOT auto-rewrite: this `conventions.md` or any agent's SKILL file** (the
  core, shared, committed instruction set). A change there is **drafted as a proposal
  in the report** — optionally a single `[reflect-proposal]` Linear ticket for the
  human — and **never applied** by an agent. That proposal ticket is filed **`blocked`
  + `needs-pm` with `Bail-shape: external-prereq`** so the firewall is mechanical, not
  aspirational: `blocked` keeps it out of Dev's pick set (§5), and `external-prereq`
  makes PM park it for the human (PM Job B) rather than unblock it back into Dev — a
  change to the plugin's own code is the operator's to apply. (Reusing `external-prereq`
  here is **deliberate**, not a misclassification — a plugin self-edit is a
  human-operator prerequisite; don't "correct" it to `decision-needed`/`scope-design`,
  which PM would resolve straight back into Dev.) A correction that should
  hold for *every* operator belongs here (conventions) or in the `strategyDoc`
  (product direction), reached via that human-reviewed proposal — not via `lessons.md`.

This is the one principled exception to §12a's "decide and act": self-modification of
the core operating instructions is **surfaced, not executed**, exactly like the
security stop-and-surface case (§16). Reflect is otherwise **read-only on Linear
product tickets** — it observes the loop; it never files Features/Bugs, ships,
verifies, or relabels/re-routes (those are PM/QA/Dev/Sweep).

---

## 18. Backend — Linear vs local

Everything above describes the loop coordinating through **Linear** (the MCP, the
state machine §3, labels §4, claim §7, dedupe §8, blocked §9, querying §10). That
substrate is one **backend**. The loop can equally coordinate through a **local file
store** with the *same* state machine, label semantics, and protocols — only the
storage primitive changes. This section is the **single abstraction point**: every
"ticket operation" each skill performs maps to one of two backends, defined once here.
Each skill's §0 carries just one line — "all ticket operations go through the
configured backend (§18)" — instead of re-stating every job in backend terms.

**Default is `linear`.** `backend` absent ⇒ `"linear"`, so existing behavior is
**100% unchanged**; `local` is strictly opt-in via per-project config (§11) and
bootstrapped by `/dev-loop:init`. Every rule elsewhere in this document is
backend-agnostic — this section is the only place the two diverge.

### Local board layout
The local board is **machine-local per-operator runtime state** — it lives in the
data dir next to `projects.json` (§11), **never** in the product repo (a board of
ticket-state would otherwise churn the repo with coordination commits). Default:

```
${CLAUDE_PLUGIN_DATA}/<project-key>/board/
  counter.json          # ID hint: { "prefix": "DL", "next": 42 }  (a hint, not the source of truth — see ID allocation)
  tickets/
    DL-1.md             # one markdown file per ticket
    DL-2.md
```

`<project-key>` is the config key, so multiple local projects stay isolated. The path
is overridable via `localBoard` (§11). It is created by `/dev-loop:init` (or lazily on
first write) and **must be a dedicated dev-loop board dir on a single local
filesystem** — never a shared/pre-existing dir, and never a network mount (the
atomic-rename below needs one filesystem). Never committed, never shared.
`strategyDoc` in local mode is a **repo file** (read/edit/commit) — never a Linear
document; init rejects a `{linearDocument}` strategyDoc under `backend:"local"`.

### Ticket file format
One file per ticket, `tickets/<ID>.md`: YAML frontmatter (machine fields) + the §6
template body + an **append-only, dated** comments section. **State lives in the
`state:` frontmatter field** (a field rewrite — not folders-per-state, which would
invite move races). State names are exactly §3's (`Backlog`/`Todo`/`In Progress`/
`In Review`/`Done`/`Canceled`/`Duplicate`).

```markdown
---
id: DL-12
title: Add CSV export to the link manager
type: Feature                 # Feature | Bug | Improvement
state: In Review              # §3 names, verbatim
owner: pm                     # pm | qa (§4)
labels: [dev-loop, Feature, pm]   # FULL label set (§4); dev-loop always present
priority: 2                   # 1=Urgent 2=High 3=Medium 4=Low 0=None (§5)
assignee: null                # a per-fire claim token when claimed (§7), else null
relatedTo: [DL-9]             # append-only (merge on write)
duplicateOf: null
created: 2026-06-18T09:14:00Z
updated: 2026-06-18T11:02:00Z
---
## Context
…(the §6 Feature/Bug template verbatim)…

---
## Comments

### 2026-06-18T10:40:00Z — dev (run a1b2)
Claiming (§7). Implementing against ACs.

### 2026-06-18T11:02:00Z — dev (run a1b2)
state: Todo → In Review. Shipped in abc1234; coverage test added.
```

`labels` always carries the **full** set (§4). **Every state move MUST append a dated
comment recording the transition** (`state: X → Y`) — the dated comment log is the
board's activity history (frontmatter `updated:` is only point-in-time), and it is
what Reflect (§17, and its run logs) reconstructs the window's activity from in local
mode, in place of Linear's activity feed. Comments are append-only.

### Operation mapping (Linear MCP → local)
Same semantics — same filters, same REPLACE-style label discipline (§10), same
verify-after-write (§7/§10):

| Linear MCP op | Local op |
|---|---|
| `list_issues` (scoped `project`+`label`+`state`) | glob `tickets/*.md` **within this board dir only** (ignore temp/lock files — they are not `*.md`), parse frontmatter, filter in-process by the same predicates (label ∈ `labels[]`, `state`, `priority`, type) |
| `list_issues` with a free-text `query` (§8 dedupe / ideation) | the same glob+filter, then a substring/keyword scan over each candidate's `title` + body |
| `get_issue` | read `tickets/<ID>.md` |
| `save_issue` (create) | allocate an ID (below), exclusively create `tickets/<ID>.md` |
| `save_issue` (update) | read-modify-rewrite frontmatter under the per-ticket lock (below); **labels REPLACE-style** — re-pass the FULL set (§10 #1); **append-only lists (`relatedTo`) merge** — re-read, union, write; append a state-move comment; bump `updated` |
| `list_comments` / `save_comment` | read / append-only-write the `## Comments` section (chronological) |
| `create_issue_label` | **no-op** — labels are plain strings; no registry to provision (init skips the label step in local mode) |
| `get_document` / `save_document` | only the **repo-file** form applies — `strategyDoc` is a repo file (§11, pm-agent §0) |

The §10 query discipline still applies: fetch the narrow slice you need (filter by the
most specific predicate; `get_issue` one file when that's all you need), never read
every file blindly.

### ID allocation (race-safe via exclusive create)
`counter.json` (`{ "prefix": "...", "next": N }`, `prefix` from `ticketPrefix` (§11)
or `"DL"`) is a **start hint, not the source of truth**. The **atomic claim is the
ticket file's exclusive creation**:
1. Read `counter.json` for a starting `N` (1 if absent).
2. **Exclusively create** `tickets/<prefix>-N.md` (open with `O_CREAT|O_EXCL` — the OS
   guarantees exactly one creator wins). If it already exists, increment `N` and retry.
3. On success you own the ID; write the frontmatter+body, then best-effort bump
   `counter.json` to `next > N` (a hint for the next allocator — losing this race is
   harmless, step 2 still arbitrates). IDs are monotonic and never reused (a
   `Canceled`/`Duplicate` keeps its file + ID), mirroring Linear's server IDs.

### Concurrency — locks, claim token, verify
The §7 claim and §10 verify-after-write apply to files, with real atomicity (not just
re-read-after-write, which alone can't arbitrate two writers):
- **Per-ticket lock for read-modify-write.** Before updating a ticket, acquire a lock
  by exclusively creating `tickets/<ID>.lock` (`O_EXCL`); if it exists, another writer
  holds it — back off and retry. Read → modify → write via **temp file in the same
  dir + atomic rename** → release the lock (remove it). The temp/lock files are not
  `*.md`, so the list glob ignores them.
- **Claim uses a per-fire token (§7).** A bare `assignee:"dev"` can't tell two Dev
  fires apart. Each fire mints a unique run token (e.g. `dev (run <short-id>)`); the
  claim writes that token under the lock, re-reads, and proceeds only if the token is
  **yours**. Dev Step 0 orphan-reclaim is the **opposite** check — it must NOT require
  the token to be yours (a crashed prior fire's token is by definition not the current
  fire's, so requiring equality would reclaim nothing): it keys on `assignee` set +
  `In Progress` + **no shipped artifact** (Dev Step 0's existing test), then clears the
  stale token and re-queues.
- **Shared-checkout caveat (§7) still holds** — the claim dedups *tickets*, not the
  git working tree; stage only your ticket's files.

### Firewall in local mode (§2)
Local mode removes the **human-backlog** axis of the firewall (the board dir holds no
human-owned tickets — nothing to leak into) but **not the cross-project axis**: every
glob MUST be confined to *this* project's `board/` dir, never a parent or a shared
path, so one project's loop can't touch another's board. init guarantees the board dir
is **dedicated** (empty or dev-loop-scaffolded) before use. Tickets still carry the
`dev-loop` label for parity (same code path, templates, reports across backends). The
§2 rules — never widen the blast radius, no bulk-mutate, one ticket at a time — apply
verbatim; "scope by `project`" means "operate only within this board dir".
