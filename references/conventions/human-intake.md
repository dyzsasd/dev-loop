# W3 — human-initiated intake — conventions §9a pointer file

> Moved out of `references/conventions.md` §9a (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §9a's contract: read it at the trigger moment the §9a stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

A human may file work **directly into the loop** by creating a `dev-loop`-labelled
ticket in **`Backlog`** assigned to PM (the intake owner) — never `Todo`: a human ticket is
ALWAYS routed through PM (groom → promote, §5a); no human-filed ticket goes straight to a
dev pick-query. (A stray `Todo` human filing is tolerated — PM's `needs-pm` scan finds it and moves it
to `Backlog` during grooming; an un-owned stray is additionally caught by Sweep Job 1 —
but `Backlog` is the contract.) This is **not** the §2 human
backlog — a `dev-loop`-labelled ticket born in this project's board is loop-fair-game;
only an *un*-labelled ticket in the separate human backlog stays off-limits (init-only
adoption).

**Make it discoverable — label the intake `dev-loop` + `pm` + `needs-pm`.** `needs-pm` is the
routing label PM scans every fire (pm-agent Job B), so it is the reliable **discovery signal**
for an intake — PM's owner-scoped queries only cover `In Review` + `blocked`, so a plain `Todo`
would otherwise sit unseen. PM tells a fresh intake (a human ask) apart from a stale `needs-pm`
on a Dev-blocked ticket by the latest comment (a human ask vs a Dev bail-shape), and **clears
`needs-pm`** once it has processed the intake. (A `Feature`/`Improvement` type helps signal a
build ask; a bare direction question needs no type.) PM **grooms** the parent into concrete Dev children, then **closes the
parent** — but the children must stay navigable back to it. Mechanics, in this order:

1. **File each child** with `relatedTo:[<parent-id>]` — **child→parent is MANDATORY.**
   The child's own `relatedTo` row is the link that survives the parent going `Done`
   (the board renders a ticket's `relatedTo` unconditionally, with no state gate), so a
   reader on any child can always reach the originating parent.
2. **Back-link the parent** in one write — `relatedTo:[<child1>,<child2>,…]` **and** a
   comment listing the child IDs (`Groomed into: DL-x, DL-y`). Strongly recommended: the
   dated comment is durable provenance after the parent closes.
3. **Only then** move the parent to `Done` (verify-after-write). **Closing the parent
   before the children are filed and back-linked is forbidden** — a late child with no
   `relatedTo` strands the lineage.

This rides entirely on the existing append-only `relatedTo` union (no `parentId` field —
deliberately, §18) and adds no new state. All human↔PM discussion on the intake flows
through the parent's comments.

**Direction / research intake (not every PM intake grooms into Dev children).** The
operator can also file a `Backlog` intake (+`needs-pm`) to PM that asks it to **think** — research a question,
weigh options, and **update the product docs** rather than spawn build work. PM does the
work on the ticket and records the conclusion in the `strategyDoc` (or a `kind:"roadmap"`
hub doc) **and** a dated `Decisions (running log)` entry (§20); the operator reviews that
change through the **normal doc/git path** (a repo-file `strategyDoc` lands via PM's commit
for the operator to read/revert — that review *is* the human sign-off; a hub doc uses the
operator-publish gate, §18). Then PM either **closes the parent** (a pure decision, no
build follow-on) or grooms children and closes per the steps above (build follow-on). When
the call is genuinely the operator's — irreversible / strategic / a credential or legal
decision — PM **parks it `Human-Blocked`** (§9) instead of deciding for them, and the
operator is pinged out-of-band: on `service` the **daemon** auto-reminds on the
`Human-Blocked` state (cadence `humanBlockedReminderHours` — default 24h once a comms
channel is configured, explicit `0` opts out, off without comms; resolved at daemon boot,
so a running daemon adopts the default on restart only — §3, config-schema.md "Hub daemon
notifier settings"); on `linear` (no
daemon) **PM** emits the §9 `notify` webhook once. This — a `Backlog` intake to PM, not a discussion
board — is how operator direction enters the loop.

**The investigation protocol (P4/D4) — propose → the operator approves → THEN the doc
changes.** A direction-**section** edit of a repo-file strategy doc (§20 D4 — Vision / Goals /
Non-goals / Appetite / No-gos), a `team.docs.vision` change (§20), or any ask filed with the
**`investigation`** label (§4) needs approval BEFORE it lands. On hitting one — an
`investigation` ticket in the `needs-pm` scan, or a D4 edit needing sign-off — read
**`references/investigation-protocol.md`** (file → investigate → propose a draft/diff +
`Proposes:` line → park `In Review` assigned to the operator → version-bound approve →
reject/revise → propagate). Resident rule: PM Job A treats an `investigation` ticket as
awaiting approval, never as work to verify-fail.

A team-scoped extension of §9a for an operator ask that spans several projects. Carrier: a `dev-loop`+`pm`+
`needs-pm` issue in **no project** (linear) or a `needs-pm` ticket in the `_team` project (service). At team
scope PM discovers it via the same `needs-pm` scan, then **splits it into one ordinary per-project W3
sub-intake per responsible project** (`relatedTo:[<parent>]`), back-links the children, and moves the
parent to **`In Review`** (not Done — a team intake tracks end-to-end). Each child is digested by its
project's normal §9a flow. Sweep closes the parent (`Done`) once **all** children are `Done`, or holds it
In Review and names the blocker if any child is parked. Split is idempotent (child back-links = already
split); responsibility comes from the `team.docs.vision` project descriptions, and PM parks to the operator
rather than guess. No new state machine — §9a mechanics, one level up. Same team (= same backend) only;
cross-team collaboration does not exist (I3).

**Mechanism on `service` (D1):** the carrier is the hub op-API **`project` override** — every hub tool
(`whoami` aside) takes an optional `project` argument, role-gated **server-side on both transports**
(stdio and the daemon op-API): the stewards (`sweep`/`ops`/`reflect`/`communication`, booted `_team`) may
name any seeded project key or `_team`; **PM may name `_team` only** — and uses it for exactly this
job. PM is never booted at team scope on `service`; instead **every per-project PM fire** scans the
`_team` board (`list_issues {project:"_team", label:"needs-pm"}`), files the child for **its own booted
project** on its own board (no override needed), back-links it on the parent via the override, and the
fire whose back-link completes the responsibility set moves the parent to `In Review`. Any other actor
naming a foreign key is refused (`FORBIDDEN`), and a forbidden actor gets the same refusal for a real and
a ghost key — key existence never leaks. Omitting `project` means the booted project, unchanged.
