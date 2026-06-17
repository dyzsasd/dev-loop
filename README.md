# dev-loop

Three autonomous agents — **PM**, **QA**, and **Dev** — that run a software-development
loop **coordinated entirely through Linear ticket state**. They never call each
other directly; Linear is the shared blackboard. Trigger each one manually when
you want that role to take a turn.

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

## The agents

| Skill | What it does |
|---|---|
| **`pm-agent`** | Reads the product's strategy doc, exercises the real product, files **Feature** tickets, **verifies** features that reach `In Review`, and unblocks its own blocked tickets. |
| **`qa-agent`** | Runs happy-path + edge-case tests in the configured test env, files **Bug** tickets, and **re-tests** bugs that reach `In Review`. |
| **`dev-agent`** | Pulls `Todo` tickets in a fixed priority order, grooms them (enough info? duplicate?), implements, runs build/test gates, ships per config, and moves them to `In Review`. Blocks anything it can't act on rather than guessing. |

The full rules — state machine, label taxonomy, ticket templates, priority order,
and the claim / dedupe / blocked protocols — live in
[`references/conventions.md`](references/conventions.md). All three skills read it.

## Safety boundary

The agents operate **only** on tickets carrying the **`dev-loop`** label, scoped to
the configured Linear project. They never read, transition, or comment on any other
ticket. This is the firewall between the loop and your human backlog — treat it as
load-bearing.

## Install

**Quick / dev (this session only):**
```bash
claude --plugin-dir /path/to/dev-loop
```

**Personal, persistent** — via a local marketplace in `~/.claude/settings.json`:
```json
{
  "extraKnownMarketplaces": {
    "local": { "source": { "source": "local", "path": "/path/to/parent-of-dev-loop" } }
  }
}
```
then `/plugin install dev-loop@local`. Verify with `/plugin list`; the skills appear
as `/dev-loop:pm-agent`, `/dev-loop:qa-agent`, `/dev-loop:dev-agent`.

## Configure

Per-project settings live in a user-editable file at
`${CLAUDE_PLUGIN_DATA}/projects.json` (resolves to
`~/.claude/plugins/data/dev-loop/projects.json`). Seed it from the shipped example:

```bash
mkdir -p ~/.claude/plugins/data/dev-loop
cp config/projects.example.json ~/.claude/plugins/data/dev-loop/projects.json
# then edit: map each Linear project → repo, strategy doc, test env, git/deploy flags, mode
```

Schema + field reference: [`references/config-schema.md`](references/config-schema.md).

Each project has a `mode`:
- **`dry-run`** — agents analyze and print what they *would* do; no Linear writes,
  no push, no deploy. Use this for first contact with a new product.
- **`live`** — agents create/transition tickets and (for Dev) commit/push/deploy
  per the project's `git`/`deploy` flags. A red build/test gate never ships.

## First-run setup

On the first `live` run against a workspace the agents ensure the workflow labels
exist (`dev-loop`, `pm`, `qa`, `edge-case`, `blocked`, `needs-pm`, `needs-qa`,
`coverage`; `Bug`/`Feature`/`Improvement` are reused if present) and that the target
Linear project exists. See `references/conventions.md` §13.

## Status

v0.2.0 — validated end-to-end in an isolated sandbox (one full PM→Dev→QA cycle:
priority pick order, claim, block, per-run cap, verify→Done, cancel, propose+dedupe,
re-test+dedupe all exercised). Autonomy (push/deploy) is opt-in per project via
config and gated on green build/test.

**0.2.0** — hardening pass adapting the mature jinko-brain agent harness to our
autonomy-first posture (machine gates, never human prompts): a **prime directive**
(conventions §0) making each fire stateless-safe under auto-compaction; **Linear MCP
write-hazard** rules (§10: labels are REPLACE-style, verify-after-write on fuzzy
state-matching); an autonomous **self-review ship gate** (Dev Step 5.5: spec-
compliance + a code-review pass; Critical/High blocks the ship or blocks the ticket
as `fix-exhausted` — never waits for a human, never routes code-fixing to PM/QA); a
**test-coverage definition-of-done** (§15: every Bug/Feature adds a regression test
or files a `[coverage]` follow-up); a **per-operator `lessons.md`** every agent reads
at run-start (§14, tune behavior without forking skills); QA **result vocabulary**
(pass/fail/drift/inconclusive — `inconclusive ≠ pass`); Dev **orphan-recovery** (Step
0, reclaim crash-stranded In Progress tickets); a **bail-shape** taxonomy on blocked
tickets (§9, async routing, no human prompt); a **security doctrine** (§16); and a
**Topology-at-a-glance** map. (Deferred: per-ticket cooldowns, config genericisation,
queue-depth self-pacing.)

**0.1.9** — Dev split-follow-up enforcement (from live experience): the dev-agent's
split rule already told Dev to *file* a follow-up ticket for the deferred slice, but
across a long live run Dev repeatedly shipped a backend/creator slice, wrote
"split to a follow-up — see handoff", and **never filed the ticket** (once even citing
an unrelated ticket number) — stranding the deferred ACs and forcing the owner (PM) to
reverse-engineer and file each follow-up (7×). Hardened the rule into a **mandatory,
enforced gate**: filing the follow-up is Dev's job and must happen **before** moving the
parent to `In Review`; the handoff comment MUST cite the new ticket ID filed *that run*
(verified to be the right one); a "split to a follow-up" with no filed ID is a defect,
not a split. Also added the check to the Step-7 hand-off so it's enforced at the moment
of `In Review`, not just in the split prose.

**0.1.8** — PM steady-state guard (from live experience): the change-gate stops a PM
re-running Job C on an *unchanged* `HEAD`, but a long live run exposed the adjacent
trap — once the structured backlog is exhausted, a PM legitimately runs a fresh Job C
on an unchanged HEAD (or when the user pushes back on cached no-ops), and could then
keep re-hunting a *feature-complete* product on every idle fire. Added a PM preflight
bullet: after a real hunt comes back near-empty, record it and revert to the terse
HEAD-unchanged no-op; re-hunt only on **material** HEAD movement or user redirect
(mirrors the QA agent's existing "once the whole testable surface is covered, stop
expanding"). Prevents the expensive multi-agent gap-hunt from becoming zero-signal
make-work.

**0.1.7** — project-scope every blocked/needs-* query template (from live experience).
The Safety callouts always said "scope every query by `project`", and the In Review /
Todo templates included it — but the PM Job-B (`blocked`, `needs-pm`) and QA Job-B
(`blocked`, plus the cross-owner widen) templates omitted it. An agent transcribing
them verbatim issued an **unscoped label query that returned another project's blocked
tickets** (observed live: a MonPick PM run surfaced `dev-loop-sandbox` tickets), risking
a touch on a backlog that's explicitly off-limits (§2). All five templates
(`pm-agent` ×2, `qa-agent` ×2, `conventions` §9) now carry `project` with an inline
"always include project" note.

**0.1.6** — anti-stall escape hatch (from live experience): the "defects are QA's to
file — note it, don't file" rule assumes QA actually runs. When a *confirmed,
reproducible* defect PM flagged stays unfiled across multiple fires **while the loop
is stalled** (Dev queue empty, nothing In Review — QA isn't picking it up), PM may
now file it **itself as a properly-typed `Bug` + `qa`** (QA still verifies), with a
repro + dedupe note + rationale. That's filing a defect *as a Bug for QA* (lane-legal)
to keep the loop moving — still never filing a defect as a Feature, never fabricating
one. Prefer it over a repeat no-op when there's real verified work to move.

**0.1.5** — added an optional per-project `autonomy` setting (conventions §12a),
orthogonal to `mode`. Default `"ask"` keeps the conservative escalate-to-user
posture. `"full"` grants standing authority to *decide and act, not ask*: the
agent resolves product-direction/scoping calls itself from the strategy doc and
files/builds them — no "standing items for you to approve". Caution becomes the
*method* (verify, prefer additive/reversible/idempotent, gate on green), not a
reason to defer; escalation narrows to genuine external prerequisites only (real
third-party credentials, money, legal, or a capability the run lacks).

**0.1.1** — hardened against stale strategy docs / test plans (from live-loop
experience): dedupe against the *current product*, not just tickets (conventions
§8); Dev grooming now detects already-built tickets and routes them to `In Review`
instead of rebuilding; PM/QA may legitimately file zero in a run and stay in their
lane (defects → QA, capability gaps → PM, business/infra-blocked items → the user)
rather than padding the backlog.

**0.1.2** — added a PM change-gate preflight (mirrors QA's): when In Review + blocked
are both empty and the repo HEAD is unchanged, PM skips the expensive product sweep
and reports a one-line no-op instead of re-exploring an unchanged build every fire.
Records the explored SHA (not end-of-run HEAD) so a commit shipped mid-run isn't
skipped.

**0.1.3** — PM Job B now *actually unblocks*: when Dev blocks a ticket on a question
or a design/scoping decision PM can answer, PM answers it **and** removes
`blocked`/`needs-pm` (encoding any safety as acceptance criteria — e.g.
build-behind-a-flag-off-by-default) so Dev can proceed. Escalate to the user only
for genuinely human-only calls (irreversible prod ops, money, legal, security
sign-off). Supplying the info **is** the resolution; "answered but left blocked" is
not.

**0.1.4** — close the escalation loop (from live experience). A standing
user-escalation usually resolves *out-of-band*: the human authorizes/decides in a
**comment** and `blocked` gets stripped while a stale `needs-*` lingers — so a plain
`label:"blocked"` query misses it. Job B now also re-reads parked tickets' latest
comments and treats a `needs-*` label without `blocked` as "finish the job" (PM
SKILL §Job B + conventions §9). And when the now-unblocked action is itself
sensitive/irreversible (e.g. a user-authorized prod DB migration), the **owner
executes it attended** — verify precondition → safe/records-only command form (never
the data-mutating variant) → verify end state — rather than routing an irreversible
op into another agent's unattended auto-pick set.
