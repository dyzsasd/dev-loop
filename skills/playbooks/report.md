---
slug: SH-report
kind: mechanical
pulls: references/conventions/reports.md (on a roll-up, an un-acted 点评, or the lessons write), references/report-rollups.md (weekly/monthly roll-up), references/reports-linear-sink.md (reports.sink:"linear")
---

# SH-report — leave the durable trail + read the operator's critique (conventions §22)

Shared by every agent. Runs twice per fire: a **scan** at boot (SH-boot step 5) and an **append** at close.
No change to ticket / product / board behavior — this is the audit trail only.

## Preconditions
- Reports are machine-local, never committed, and §16-bound (no secrets, no verbatim PII).
- Tree: `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/reports/<agent>/{daily,weekly,monthly}/`, one file
  per period, `<agent>` = the full skill name (e.g. `pm-agent`). `reports.sink:"linear"` is the opt-in
  alternative (pull `references/reports-linear-sink.md`).

## Steps (boot — the scan)
1. Compute period keys from a UTC shell call, never date reasoning: `TODAY=$(date -u +%F)`,
   `WEEK=$(date -u +%G-W%V)`, `MONTH=$(date -u +%Y-%m)` (`-u` is load-bearing).
2. Match the newest report per level by the dated grammar ONLY (`^\d{4}-\d{2}-\d{2}\.md$` etc.), never a
   bare `*.md` glob. `WEEK`/`MONTH` newer than the newest file => a roll-up is due — pull
   `references/report-rollups.md` and finalize the prior period (prepend a one-line summary header). The
   first fire of a new day finalizes the prior daily.
3. Scan for an un-acted operator review: a sibling `<report>.review.md` with no `<report>.review.acted`
   sidecar (or newer than it). Found => read it and **change how you work** this fire; the §17 carve-out
   lets you write your OWN lessons section from a real 点评 (five limits: pull `references/conventions/reports.md`).

## Steps (close — the append)
4. Append to today's daily ONLY when the fire did material work (a no-op fire appends nothing). Entry shape:
   what you did · key outcomes/metrics · problems/blocks · one line "what I'll change".
5. Numbers come from code (`dev-loop metrics`) or explicit board queries — never from memory of what you did.

## Exit criteria
Boot scan done + (if the fire acted) one daily entry appended. `dry-run` writes NOTHING (no report, lessons
edit, sidecar, or proposal).

## When blocked
Reviews (点评) are ONLY operator-authored `<report>.review.md` files — you never write one, and inline prose
is never a review. Cannot resolve a 点评 into an action this fire => note it in the daily and carry it.
