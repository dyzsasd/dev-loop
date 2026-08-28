# Operator rulings — the fixed reply grammar

The loop parks work for a human in exactly four places, and `dev-loop status --json` →
`.decisionQueue` lists all four. A ruling is how the operator (in ANY harness — Claude Code,
Codex, opencode, a shell agent, a person at a terminal) answers one. A ruling is always two
things: the **ruling comment** (the attributed record every later reader finds without reading the
thread) and the **state verb** (the transition that hands the item back to the loop, or closes it).
One verb writes both:

```
dev-loop rule <id> approve|reject|defer --reason "<the human's words>" [--to <state>] [--waiting-on human-action|external]
```

`approve` = do the thing / the answer is yes · `reject` = do not / the answer is no · `defer` = not now;
the reason says what would change the answer (a date, a dependency, a decision elsewhere). The reason
is the human's sentence, not a paraphrase — the record must read back later without this conversation.

The verb posts `Ruling: <verdict> — <reason>` on the ticket FIRST, then runs the transition the table
below prescribes, through the same two ops every sugar verb uses (`save_comment`, `save_issue`) — so
every gate still applies, and it works at the workspace home, over `hub.transport:"daemon"`, and over
an attach. If the transition is refused (a gate), the comment stays and the verb tells you the exact
`ticket update` that finishes it: the record is never lost, and the ticket is never moved unexplained.

## The table — queue item type → what `rule` does → what the loop does next

| Queue item (`status` field) | Ruling | What `dev-loop rule <id> …` does | What the loop does next |
|---|---|---|---|
| `humanBlocked[]` with `waitingOn: human-decision` | approve | `Ruling:` comment, → `Todo`, un-assigned from the operator | back in the dev pick set; PM sees the `Ruling:` comment on its next verify pass |
| | reject | comment, → `Canceled` | terminal; Sweep reaps the worktree; reopening later is a ruling too |
| | defer | comment, stays `Human-Blocked`, `waiting_on := external` (or `--waiting-on human-action`) | stays in your queue as that kind; nothing auto-unparks it — rule again when the condition in your reason is met. `--to Backlog` instead takes it out of the pick set for PM to re-rank |
| `humanBlocked[]` with `waitingOn: human-action` (you had to DO something — a key, a DNS record, a merge) | approve (= done) | do the action, then `rule <id> approve` → `Todo` | the fire that parked it re-verifies the prerequisite |
| `humanBlocked[]` with `waitingOn: external` | approve / defer | `rule <id> approve` when the external event lands; `rule <id> defer` re-states what it waits on | same as above; `external` items are never auto-unparked |
| `inReviewOperator[]` (In Review, assignee `operator` — a landing PM routed to you) | approve | comment, → `Done` | throughput counts it; the acceptance edge is recorded |
| | reject | comment, → `Canceled` (verify-fail close) — or `--to Todo` (rework, un-assigned) | dev tier picks the rework; Canceled from In Review is the verify-fail edge in the KPIs |
| | defer | comment, → `Human-Blocked` (assignee operator, `external`) | parked in your queue until you rule again |
| Done / Canceled (a reopen — operator-only) | approve | comment `Ruling: approve — reopen: <why>`, → `Todo` | back in the pick set; confirm intent with the human first |
| `approvalRequests[]` (an agent asked for an END STATE it may not grant itself) | approve | `rule <approval-id> approve --reason …` ≡ `dev-loop approve --request <approval-id> --note "<the human's words>"` | the gate that consults it (push/merge/publish) passes on the next retry — exactly that end state, nothing broader |
| | reject | `rule <approval-id> reject --reason …` ≡ `dev-loop revoke <approval-id> --note "<why>"` | the request leaves the queue; the agent's retry stays refused and files nothing new for the same key |
| | defer | leave it — nothing waits on it (the fire moved on); `rule … defer` refuses with that explanation | it stays in the queue, ageing, until you rule |
| `proposals.open` (a `dev-loop system propose` inbox item — a suggested change to a governing file) | approve | `dev-loop system resolve <id> --status accepted`, then apply it yourself as a git commit and `--status applied` | nothing automatic — the change is yours to commit (conventions §17); the count leaves `status` |
| | reject | `dev-loop system resolve <id> --status rejected --note "<why>"` | the proposer's next fire can read the note via `dev-loop system show <id>` |

`--to <state>` overrides the target row (any legal state). A `Todo`/`Backlog` target still assigned to
the operator is un-assigned so the dev tiers can pick it (the pick predicate is assignee-based, §18; a
tier label re-derives the assignee). Approval rulings are home-only (direct-db); over an attach the
verb says so. System proposals keep their own verb.

## What the write layer guarantees (so the grammar is not a convention you have to remember)

- **`waiting_on` lives and dies with the Human-Blocked state.** Every exit from Human-Blocked clears
  it (idempotent) and every entry with nothing set defaults it to `human-decision`; an explicit
  `waitingOn` on `save_issue` still wins. A re-park for a different reason therefore never shows a
  stale kind. Enforced in the ONE update path (`updateTicketRow`), so `ticket update`, the board's
  move form, merge-guard's demote and ticket-release all get it.
- **A `Ruling:` comment is the operator's act.** The comment op parses the grammar: from any agent
  identity it is refused (403); inside a fire (`DEVLOOP_TEAM_SCOPE` / `DEVLOOP_DEV_SPLIT` set) the CLI
  refuses it (exit 4) with no bypass — `--i-am-the-operator` does not reach a ruling, by design; a
  malformed one (`Ruling: maybe`, no reason) is refused (400) rather than stored half-parseable. A
  valid one from a human is RECORDED: an `issue.ruling` ledger event, and on a Human-Blocked ticket
  the `waiting_on` clear (the wait it was parked for is answered). It never moves state by itself.
- **Agents ask, they do not rule.** To request a ruling, park the ticket Human-Blocked with a
  `Bail-shape:` comment (conventions §9); to request an authorization, `dev-loop request <key>`.

## The two-step form (still legal; the fallback when you must do the halves apart)

```
dev-loop comment add <id> --body "Ruling: approve|reject|defer — <reason in the human's words>"
dev-loop ticket update <id> --state Todo|Backlog|Canceled|Done [--assignee '']
dev-loop op save_issue --args-json '{"id":"<id>","waitingOn":"human-action"}'   # a decision became an action, still parked
```

The ruling comment always comes first: a transition without the comment is a silent override, and the
next PM fire will treat the unexplained move as its own mistake to repair. A comment without the
transition leaves the ticket parked (Human-Blocked, `waitingOn: null` in `status` = "ruled, not yet
moved") — finish it with the state verb.

Rules that hold for every row:

- **Identity.** Rule as `DEVLOOP_ACTOR=operator` with no fire marker set. `rule`, `approve`, `revoke`,
  `system resolve` and the terminal-state reopen refuse inside a fire (exit 4) by design — that
  refusal is what makes a ruling worth consulting.
- **Direction, not tickets.** A ruling that changes the product's direction is a doc publish, not a
  comment: `dev-loop doc publish strategy …` after quoting the diff (conventions §20).
- **Dry-run mode** (`team.mode: dry-run`): write the ruling comment, report the state verb you WOULD
  run, run nothing else (`rule` is a write verb — use the two-step form's first line alone).

## Examples

```
dev-loop rule WEB-42 approve --reason "ship the CSV export without the date filter; filter is WEB-47"
dev-loop rule WEB-51 defer --reason "wait for the pricing decision on 2026-09-03"
dev-loop rule WEB-51 defer --reason "not this quarter" --to Backlog
dev-loop rule WEB-60 reject --reason "the AC list is missing the mobile case" --to Todo     # rework on an In Review item
dev-loop rule 3f1c0de9-… approve --reason "go ahead and publish 1.15.2"                      # an approval request
dev-loop system resolve 20260827T101500Z-dev-agent-step-4 --status applied --note "committed as a1b2c3d"
```
