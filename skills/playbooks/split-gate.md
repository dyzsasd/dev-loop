---
slug: SH-split-gate
kind: mechanical
pulls: references/conventions/two-tier-dev.md (the §21a/§21c split charter)
---

# SH-split-gate — is the two-tier Dev split active? (conventions §21c)

Shared by the tiers that can double-pick each other: the legacy `dev` and `junior-dev`. Run this FIRST,
before any queue read — a wrong answer either races the other writer or strands the queue. The split is
detected ONLY from the explicit signals, NEVER inferred from history, models, or the ticket mix:
`devSplit:true` in config, or `DEVLOOP_DEV_SPLIT` in the fire env.

| You are | Split ON | Split OFF |
|---|---|---|
| legacy **`dev`** | DEFER — graceful no-op: the split tiers own the queue; a double-pick races them. Report it and exit. | operate as the single Dev (Step 0→7). |
| **`junior-dev`** | you are the LIVE junior tier — run your job. An empty slice is a normal idle no-op, NOT "the split is off". | DEFER — graceful no-op: `dev` owns the un-tiered queue; never reach into it. |

`senior-dev` never no-ops on this axis: split OFF ⇒ a terse legacy no-op and exit (`dev` owns the queue);
split ON with an empty senior slice is a normal idle fire — its own SKILL frame carries that gate.

## Exit criteria
Either this fire proceeds (you are the owner of the queue for this split state) or it reports a graceful
no-op and stops. No queue read, claim, or write happens on the no-op path.

## When blocked
The signal is a boolean read, never a judgment — if config and env disagree, `DEVLOOP_DEV_SPLIT` (the fire
env) wins for this fire. Pull `references/conventions/two-tier-dev.md` only if you must confirm the tier
routing; the gate itself needs no further reading.
