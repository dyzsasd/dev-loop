# The dev-loop model — a human orientation

Status: orientation doc (2026-08-27). Audience: operators and contributors, not agents.

This is the "how and why the platform works" narrative. It was deliberately **deleted from the agent
surface** — an agent spends its tokens on content judgment, not on re-deriving the platform's shape — and
lives here instead. Nothing in this file is an instruction to an agent. The invariants an agent must obey
live in [`skills/_constitution.md`](../../skills/_constitution.md); the fixed procedures live in
[`skills/playbooks/`](../../skills/playbooks/) and each agent's SKILL; the deep detail lives in
[`references/conventions.md`](../../references/conventions.md) and its `references/conventions/*.md` stubs.
The architecture this doc orients you to is specified in
[`job-scoped-prompts.md`](./job-scoped-prompts.md).

---

## What the loop is

dev-loop is an autonomous software team in a folder. A handful of agents — PM, QA, senior/junior Dev,
Sweep, Reflect, and the outward Ops/Architect/Communication — each wake on a recurring schedule, do one
slice of work, and go back to sleep. They **never call each other directly**. Every hand-off is a change to
a shared board of tickets: an agent moves a ticket's state, sets a label, or leaves a comment, and the next
agent to fire reads that and picks up where the board now stands.

Because the board is the only channel, any agent can run at any time, in any order, even concurrently. The
board is the blackboard; the ticket is the unit of work; the label is the routing. Work flows in one
direction:

```
strategy doc → Backlog (every discovery lands here) → PM grooms + promotes (depth-capped)
             → Todo → Dev claims → In Progress → ships → In Review → the owner verifies → Done
```

with three documented shortcuts straight to `Todo`: an owner's verify-fail follow-up, an un-block re-queue,
and a confirmed production incident. The verifier of a ticket is always **its owner** — the agent that
filed it (PM owns Features, QA owns Bugs), identified by the `pm`/`qa` label.

Two ideas are worth internalizing because agents are built around them:

- **Every fire is fresh.** An agent never trusts its own memory of "what I did last time." State lives in
  the board, in git, and in small on-disk `*-state.json` files, and every fire re-reads it from scratch.
  This is what makes the loop robust to crashes, restarts, and context compaction.
- **The `dev-loop` label is a firewall.** The same Linear/board workspace can hold real, human-owned
  tickets. Agents are hard-scoped to only ever touch tickets carrying the `dev-loop` label. That single
  label is the wall between the autonomous loop and the human backlog.

---

## Inward vs outward — the two halves of the team

The first five agents are **inward / build-facing**: a closed build factory that proposes work, tests it,
builds it, cleans up after itself, and reflects on its own behavior.

- **PM** — product direction and the strategy doc; the only Backlog→Todo gate; verifies its own increments.
- **QA** — breaks the product on purpose; files bugs; verifies its own bugs.
- **Dev** (by default split into **senior-dev** + **junior-dev**) — senior authors living per-module
  designs and handles escalations; junior ships pre-designed, scoped tickets.
- **Sweep** — the lifecycle janitor: hygiene only, never builds or verifies.
- **Reflect** — the meta-retrospective: studies the loop's own behavior and *proposes* structural change,
  never applies it.

The **outward** agents connect that factory to realities it cannot see from inside the board:

| Agent | Reality it watches | Cadence |
|---|---|---|
| **Ops** | running production over time (deploy-independent) | tight (~10–15 min) |
| **Architect** | the whole codebase's technical health over time | slow (daily-ish) |
| **Communication** | the public product narrative, from verified shipped facts | daily by default |

Ops and Architect are pure **observe-and-file**: they read external or whole-system reality and file (or
refresh) tickets for the right inward agent — they never implement, ship, verify, or roll back.
Communication drafts public-facing articles from verified facts and never publishes, commits, or deploys.
Keeping these axes distinct matters: Ops watches *running prod*, QA tests the *diff*; Architect watches
*code health over time*, PM watches *product gaps*. Different surfaces, different owners.

---

## The three-tier prompt architecture

Historically an agent loaded its whole SKILL plus a large slice of the shared conventions, then reasoned
about which rule applied — burning tokens on **process derivation** that should have gone to **content
judgment**. The job-scoped design (see [`job-scoped-prompts.md`](./job-scoped-prompts.md)) splits what an
agent reads into three tiers:

1. **The constitution** ([`skills/_constitution.md`](../../skills/_constitution.md)) — a tiny, always-resident
   kernel of the invariants that gate *every* action regardless of the job: the state machine, the
   `dev-loop` firewall, write hazards, isolation, the dry-run gate, the deploy ceiling, security, the
   governing-file firewall, the report contract, and so on. Loaded verbatim on every fire.
2. **A job playbook** — one fixed procedure for the one task this fire is doing (verify an In Review ticket,
   unblock, groom the backlog, review the product). Shared procedures are authored once in
   [`skills/playbooks/`](../../skills/playbooks/) (SH-boot, SH-report, SH-verify-close, SH-block-park,
   SH-file-ticket) and referenced by slug — never copied, because a per-SKILL copy is a protocol fork.
3. **Reference stubs** — the deep material in `references/conventions/*.md`, pulled only when a playbook step
   says "if you hit situation S, read R."

The scheduler picks the job (a "job-lane") the way it already picks the agent, and assembles constitution +
the right job playbook for that fire. The payoff is that the model spends its budget on the actual work —
writing the ticket, judging whether an increment meets its acceptance criteria — instead of on figuring out
the process. Two kinds of job exist, and the distinction is deliberate:

- **mechanical** jobs are fixed scripts (verify, unblock).
- **judgment-scaffold** jobs (groom, product review) fix the *envelope* — what to read, how to dedupe, the
  filing cap, the output shape, the safe default on ambiguity — and *frame* the judgment step without
  replacing the thinking. Roughly 15–30% of these jobs stays irreducibly in the model's hands; that bound
  is a feature, not a gap.

---

## One work plane, many substrates (the backend abstraction)

Every rule in the loop is written to be **backend-agnostic**. There is exactly one place where an abstract
"ticket operation" maps onto a real substrate:

- **`linear`** (the default) — tickets live in Linear, reached through the Linear MCP.
- **`service`** — tickets live in a bundled local hub (a `node:sqlite` service) that adds per-agent
  identity, a localhost web UI, and versioned docs.

The **work plane is identical** across both: states, transitions, the pick/claim/dedupe/blocked protocols,
labels, and reports behave the same no matter which substrate is configured. Only the **surface plane**
diverges — per-agent identity, the web UI, and versioned documents are hub-only. Agents never choose or
switch a backend; the operator configures it once. The one behavior that takes a substrate-specific shape is
parking a ticket for a human: it becomes a real `Human-Blocked` state on the hub (which reminds the operator
channel) and a `blocked`+`needs-pm` label park on Linear — but the *abstract* behavior ("it leaves Dev's
pick set until a human resolves it, then resumes to `Todo`") is invariant either way.

This abstraction is what lets the same prompts, the same constitution, and the same playbooks run a team on
a hosted tracker or on a self-contained local database with no change to how the agents think.

---

## Portability — not a Claude-Code-only loop

Because the hub is a plain stdio MCP server with **env-based identity**, the same agents, the same hub, and
the same per-agent identity run under a second coding CLI (Codex, opencode, …) against the *same* database.
The load-bearing idea for a human onboarding a new CLI:

- **One env contract** carries identity per pane — `DEVLOOP_ACTOR` (who this agent is), an optional
  `DEVLOOP_PROJECT`, the hub DB path, and the data dir. Any launcher can set it.
- **The identity gate is a safety control.** Per-agent identity is the headline capability, but it is also
  the thing that keeps writes correctly attributed. A CLI is onboarded only after it *passes* a `whoami`
  check through the CLI: set `DEVLOOP_ACTOR=dev`, ask it to call `whoami`, and require the answer to be
  `dev`. Anything else fails closed — a CLI that can't propagate identity would mis-attribute every write.
- **Everything else is CLI-independent.** The no-self-edit boundary is prompt-gated and git-backed; secrets
  stay in the environment; identity is cooperative attribution on every CLI. Claude Code needs none of the
  extra setup — second-CLI support is purely additive and opt-in.

---

## Where to look next

- The invariants an agent obeys, verbatim: [`skills/_constitution.md`](../../skills/_constitution.md).
- The shared procedures: [`skills/playbooks/`](../../skills/playbooks/).
- An agent's role, jobs, and job-lanes: its SKILL, e.g. [`skills/pm-agent/SKILL.md`](../../skills/pm-agent/SKILL.md).
- The full, deep rulebook: [`references/conventions.md`](../../references/conventions.md) and its
  `references/conventions/*.md` stubs.
- The architecture and build contract: [`job-scoped-prompts.md`](./job-scoped-prompts.md).
