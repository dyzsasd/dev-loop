---
name: playbooks
description: NOT a launchable agent. The shared job-playbook library for the job-scoped-prompt architecture (docs/design/job-scoped-prompts.md). Each file here is a self-contained, reusable procedure that an agent SKILL's job span references by path (SH-<slug>) instead of restating. Loaded by the boot assembler alongside skills/_constitution.md, never invoked on its own.
---

# Shared playbooks (SH-*)

This directory holds the **shared** job playbooks: one fixed procedure per file, authored once and
referenced by slug from an agent SKILL's marked job spans — never copied into a SKILL (a per-SKILL copy is a
protocol fork). Every fire loads `skills/_constitution.md` (the resident invariants) + one job playbook (the
procedure for this fire's task) + the shared playbooks that job references.

This is a reference library, **not a launchable loop agent** — it has no `DEVLOOP_ACTOR`, boots nothing, and
is excluded from the agent roster.

Sections: §0a §3 §4 §5a §6 §9 §9c §19 §21a §21b §22

## Index

The full library — 17 playbooks. The **shared** playbooks (SH-\*) are referenced from more than one
agent's job spans; the **single-job scaffolds** (SW/RF/OP/AR/CM-\*) each back one steward/agent's one job.
Each row's kind is `mechanical` (a fixed script) or `judgment-scaffold` (the envelope is fixed, the
judgment is framed, not replaced). `Covers` names the governing conventions § where the procedure has one.

### Shared (SH-\*) — referenced by multiple agents' job spans

| Slug | File | kind | Covers |
|---|---|---|---|
| SH-boot | `boot.md` | mechanical | the standard fire boot — §0a steps |
| SH-report | `report.md` | mechanical | the durable trail + operator 点评 — §22 close |
| SH-claim-groom | `claim-groom.md` | mechanical | pick, claim, and groom the next ticket (the pick order + block bail-shape) |
| SH-file-ticket | `file-ticket.md` | mechanical | file one well-scoped ticket — §6 / §5a / §4 / §21b / §19 |
| SH-verify-close | `verify-close.md` | mechanical | verify In Review → Done, or close + follow-up — §3 / §21a |
| SH-block-park | `block-park.md` | mechanical | resolve / route / park a blocked ticket — §9 / §9c |
| SH-split-gate | `split-gate.md` | mechanical | is the two-tier Dev split active? (the split charter) |
| SH-fire-start | `fire-start.md` | mechanical | reclaim orphans + merge eligible loop PRs (the fire-start merge pass) |
| SH-ship | `ship.md` | mechanical | implement, gate, self-review, ship, smoke, hand off (the canonical Step 0–7 ship sequence) |
| SH-read-implement | `read-implement.md` | mechanical | resolve the Design pointer, then ship to it (junior's read-and-implement) |
| SH-design-delegate | `design-delegate.md` | judgment-scaffold | author the module design, stage junior children — §21a |
| SH-bug-hunt | `bug-hunt.md` | judgment-scaffold | the QA bug-discovery scaffold — §4 / §5a / §19 |

### Single-job scaffolds — one consumer, the owning agent's one job

| Slug | File | kind | Covers |
|---|---|---|---|
| SW-sweep | `sweep.md` | mechanical | the lifecycle-hygiene sweep — §4 / §21b / §9c / §19 (Sweep) |
| RF-retro | `retro.md` | judgment-scaffold | the daily retrospective + lessons curation — §22 (Reflect) |
| OP-poll | `ops-poll.md` | judgment-scaffold | poll prod health & run the incident (Ops) |
| AR-audit | `audit.md` | judgment-scaffold | the whole-codebase tech-health audit — §6 / §21b / §19 (Architect) |
| CM-article | `article.md` | judgment-scaffold | draft the product article + the team daily digest (Communication) |

## Contract

Each playbook carries front-matter `kind: mechanical | judgment-scaffold` and a `pulls:` line naming the
`references/…` stubs it reads on a specific trigger. A `mechanical` playbook is a fixed script; a
`judgment-scaffold` fixes the ENVELOPE (inputs, dedupe set, cap, output shape, safe default, exit) and
FRAMES the judgment step without replacing the thinking. The authoritative build contract lives in
`docs/design/job-scoped-prompts.md`; the human orientation to the loop lives in
`docs/design/loop-model-for-humans.md`.
