# Conventions stubs — fidelity audit (WS-A A3, Review 2)

**Decision under review.** To bring every agent's §0a conventions slice under 64 KB, 26 section bodies of
`references/conventions.md` were moved verbatim into 24 pointer files under `references/conventions/<slug>.md`
and each original section now holds a *stub*: a compressed restatement of the rules plus a pointer line naming
the file and the trigger moment at which it must be read. The stub is what rides the prompt; the pointer file
is read only at its trigger. The risk: a stub that dropped or altered a rule changes an agent's behaviour.

**Method.** Ground truth = `origin/main:references/conventions.md` (identical to the parent of the A3 commit).
For each stub, every normative statement in the original (MUST/NEVER/ALWAYS, thresholds, durations, state
and label names, config keys, actor names, orderings, carve-outs, verbs to run) was classed as
**preserved** in the stub, **deferred** to the pointer file behind a trigger that fires before the rule can
matter, or **dropped/altered** (a defect). Rules that govern the first action of a fire (boot order, claim /
dedupe, sensitive-ticket routing, the §12c fire-start merge pass, the §22 run-start review scan, the §9 owner
scan, §5a promotion, §12d) were additionally checked to be resident, not deferred. Pointer-file text was
line-diffed against the original. Measured with `hub/test/context-budget.ts`'s fixture (service backend,
`landing:"pr"`, `autoMerge:true`, single repo).

## Fidelity table

Counts are the reviewer's tally of normative statements in the original section. "Deferred" means the pointer file carries the
rule and the stub's trigger guarantees the read before the rule matters.

| § | Section | Rules | Preserved | Deferred (trigger) | Dropped → fixed |
|---|---|---|---|---|---|
| 3 | State machine / verification | 34 | 33 | 0 | 1 — "junior retries transient/flaky/infra errors" |
| 4 | Label taxonomy | 31 | 29 | 1 (labels.md — **trigger was missing**, added) | 1 — incident Urgent "/ a core flow is broken" |
| 5a | Backlog-first intake + intake mode | 22 | 19 | 3 (intake-mode.md under `passive`) | 0 |
| 7 | Claiming / worktree landing | 27 | 22 | 5 (worktree-landing.md at land time) | 0 |
| 9 | Blocked protocol | 27 | 27 | 0 | 0 |
| 9 notify | Human-park notify | 11 | 10 | 1 (human-park-notify.md transport matrix) | 0 |
| 9a | W3 human intake | 20 | 16 | 4 (human-intake.md at intake time) | 0 |
| 9b | Team intake | 13 | 13 | 0 (trigger added: split / close a team intake) | 0 |
| 9c | W5 tracker | 16 | 14 | 2 (external-prereq-tracker.md at track/block/unpark) | 0 |
| 10 | Querying + write hazards | 12 | 12 | 0 | 0 |
| 11 | Per-project config | 12 | 11 | 1 (project-config.md — **file was not verbatim**, restored) | 0 |
| 12 | Dry-run vs live | 7 | 7 | 0 | 0 |
| 12a | Autonomy | 9 | 9 | 0 | 0 |
| 12b | Landing mode | 21 | 17 | 4 (landing-pr.md at PR-open / pr-mode verify) | 0 |
| 12c | Auto-merge + release-PR | 24 | 21 | 3 (auto-merge.md at the fire-start pass) | 0 |
| 14 | Lessons file | 16 | 16 | 0 | 1 — the multi-writer lock mechanics lived only in reports.md |
| 17 | Self-evolution boundary | 12 | 12 | 0 | 0 |
| 18 | Backend | 11 | 11 | 0 | 0 |
| 19 | Multiple repos | 25 | 19 | 6 (multi-repo.md when a repo target decides the action) | 0 |
| 20 | PM doc-base (D4) | 17 | 15 | 2 (strategy-doc.md at doc-base edit time) | 0 |
| 20a | strategyDoc form detection | 9 | 8 | 0 | 1 — "a flat file with the §20 headings IS the doc-base; a larger product may split it into a doc set" (absent from stub AND pointer) |
| 21 | Outward agents | 22 | 18 | 3 (outward-agents.md at incident-file / draft time) | 1 — incident Urgent "/ a core flow is broken" |
| 21a | Two-tier Dev | 30 | 25 | 5 (two-tier-dev.md at design / gate / escalation) | 0 |
| 22 | Reports & operator review | 35 | 20 | 12 (reports.md at roll-up / review / Reflect retro) | 3 — `<agent>` = full skill name; "finalize" = prepend a one-line summary header; the daily entry shape |
| 22a | Team daily digest | 10 | 6 | 4 (team-digest.md when composing the digest) | 0 |
| 24 | Codex | 19 | 17 | 2 (codex.md at invoke time) | 0 |
| 27 | Workspace model | 14 | 14 | 0 | 0 |
| **Total** | | **506** | **440** | **58** | **8** |

## Defects found and fixed

1. **Pointer file not verbatim — `references/conventions/project-config.md` (§11).** The old §11 body had been
   reordered (the interactive-ladder item pulled to the top, the preamble moved below the runtime-files
   block) and its "On startup … 2. Resolves the project" item was a paraphrase that pointed at
   *`references/conventions/project-config.md`* — the file itself. Restored the body as the verbatim old §11.
2. **§4 pointer had no trigger moment** ("Full definitions: labels.md."). Now: "read it at the moment you FILE
   a ticket carrying a sub-type or dev-tier label, or route on one."
3. **§4 / §21 `incident` priority threshold** lost half its condition — before: "Urgent when prod is down / a
   core flow is broken"; stub: "Urgent when prod is down". Restored in both stubs.
4. **§3 escalation** — before: "NOT a transient/flaky/infra error — junior simply retries those"; stub had
   only "(not a transient/flaky/infra error)". junior-dev cites §3 but not §21a, so the retry instruction
   was unreachable. Restored.
5. **§20a doc-set rule** — "A single flat file containing the §20 field-set headings IS the doc-base; a larger
   product may split it into a doc set under the same path" was in neither the stub nor `strategy-doc.md`.
   Restored in the stub (compressed) and in the pointer file (verbatim).
6. **§22 `<agent>` path segment** — before: "`<agent>` is the full skill name (`pm-agent` / `qa-agent` / …)";
   stub: bare `reports/<agent>/`. Added "(`<agent>` = the full skill name, e.g. `pm-agent`)" — a wrong segment
   forks the reports tree that metrics, Reflect and the operator read.
7. **§22 "finalize the prior daily"** had lost its meaning (before: "prepend a one-line summary header rolling
   up its entries") and the daily **entry shape** (what it did · key outcomes/metrics · problems/blocks ·
   "what I'll change") was gone; neither is behind a trigger (every close writes an entry). Both restored.
8. **§14 lock mechanics** — the §22 multi-writer rule (`O_EXCL lessons.md.lock` → re-read → own section →
   atomic rename → unlock; held ⇒ skip this fire; older than ~60 min ⇒ stale, remove) lived only in
   `reports.md`, while §14's own pointer (`lessons-curation.md`, read "at the moment you write or curate a
   lessons rule") does not carry it and Reflect's SKILL cites §22 for it. One compressed line added to §14.
9. **§9b** had no explicit trigger (covered only transitively by §9a's). Added "read it at the moment you
   split or close a team intake."

Funding trims (rationale-only text, no rule lived only there; the original wording was moved verbatim into
the section's pointer file so nothing is lost): the §9 `blockedStateName` blockquote (the rule stays in §3
and §18) → `blocked-protocol.md`; the §12b closing paragraph → one line, original → `landing-pr.md`; §18's
"Each SKILL's BOOT carries one line …" (a statement about SKILL files); §10's cheat-sheet aside.

## Slice bytes (fixture: service · `landing:"pr"` · `autoMerge:true` · single repo; budget 65,536 B)

| agent | before review | after review | headroom |
|---|---|---|---|
| pm | 64,771 | 65,052 | 484 |
| qa | 63,276 | 63,451 | 2,085 |
| senior-dev | 55,592 | 55,723 | 9,813 |
| junior-dev | 58,472 | 58,628 | 6,908 |
| sweep | 58,425 | 58,831 | 6,705 |
| reflect | 41,680 | 41,855 | 23,681 |
| ops | 55,327 | 55,527 | 10,009 |
| architect | 42,425 | 43,034 | 22,502 |
| communication | 34,678 | 35,207 | 30,329 |

No `CONVENTIONS_BUDGETS` row was raised. `conventions.md` is 90,120 → 90,425 B.

## Notes for the operator

- The fixture prunes §5, §19 and §24 for PM. A multi-repo project with a `codex` block would put PM's slice
  well past 64 KB (≈ +3.3 KB for §24, ≈ +2.6 KB for §19); the target is enforced on the fixture only.
- The pointer files are packaged: `hub/package.json` `files` lists `references/`, and the build's
  `cp -R ../references ./` copies the `conventions/` subdirectory.
- Trigger-less pointers that remain (§10, §12, §12a, §17, §18, §27) are fine — their stubs carry the full
  rule set; the pointer is the long-form text only.
