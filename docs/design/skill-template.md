# SKILL template — lean anchor-citing skills under enforced budgets

> Design record, 2026-07-12 (Phase 6 prep — operator task #8: control the per-fire
> context size). This doc fixes three things the migration can't drift on: the uniform
> SKILL layout, the `Sections:` line grammar, and the per-SKILL budgets. The two
> migration agents rewrite `skills/*/SKILL.md` to this template; the budget agent
> implements the §0a boot-rule change, the budget/Sections lint, and the context-bill
> generator. The conventions anchors the template cites were consolidated in the same
> prep commit (new §0a; degraded-verify moved into §3; design-gate promote-first
> ordering into §21a; strategyDoc form detection into §20 — since carved out as §20a, and
> tier routing as §21b, by the 2026-07 progressive-disclosure pass).

## 1. Baseline (measured 2026-07-12, pre-migration)

Cheat-sheet block = the `<!-- cli-cheatsheet:begin/end -->` span (generator-owned).
Prose = everything else in the file, frontmatter included.

| SKILL | total lines | cheat lines | cheat bytes | prose lines | prose bytes |
|---|---:|---:|---:|---:|---:|
| pm-agent | 723 | 89 | 4,985 | 634 | 47,361 |
| dev-agent | 518 | 63 | 3,445 | 455 | 32,126 |
| senior-dev-agent | 422 | 82 | 4,746 | 340 | 23,639 |
| sweep-agent | 377 | 91 | 4,917 | 286 | 19,117 |
| qa-agent | 376 | 63 | 3,414 | 313 | 22,028 |
| reflect-agent | 375 | 76 | 4,080 | 299 | 19,956 |
| junior-dev-agent | 367 | 63 | 3,590 | 304 | 20,662 |
| communication-agent | 357 | 71 | 3,645 | 286 | 12,056 |
| ops-agent | 332 | 79 | 4,308 | 253 | 17,060 |
| architect-agent | 294 | 57 | 3,081 | 237 | 16,013 |
| add-repo | 82 | — | — | 82 | 5,199 |
| add-project | 70 | — | — | 70 | 4,014 |
| sync-repo | 43 | — | — | 43 | 2,172 |
| sync-project | 42 | — | — | 42 | 2,097 |
| **Σ skills** | **4,378** | 734 | 40,211 | 3,644 | 243,500 |
| references/conventions.md | 2,949 | — | — | — | 205,547 |

Measured prose density ≈ 70–75 bytes/line (80-col wrapped prose incl. blank lines) —
this calibrates the byte budgets in §7. Roughly a third of the agent-SKILL prose
restates conventions protocols (each boot preamble alone runs 40–85 lines, of which
~15 are per-agent); that restatement is what the template deletes.

## 2. The one rule

**Any mechanic two agents share lives in `references/conventions.md` and is CITED
(one clause + a §-anchor), never restated.** A SKILL owns only: its role, its
per-fire jobs, and its hard limits. If a migration agent finds a shared mechanic that
has no conventions anchor, that is a prep bug — extend conventions (lettered
sub-anchor, no renumbering) first; do not inline the mechanic.

## 3. Canonical anchors for the known-duplicated mechanics

The blocks the audit found restated across SKILLs, and the ONE anchor each now cites:

| Shared mechanic | Cite | Notes |
|---|---|---|
| Fresh-fire posture | §0 | never trust conversation memory; hard-failure = log one line + exit |
| Standard boot sequence | §0a | new lettered anchor (was an unnumbered heading inside §0) |
| Safety boundary (`dev-loop` label scope) | §2 | every query/write |
| Verify-fail ⇒ close + follow-up; MISSING/EXTRA/MISUNDERSTANDING; degraded-verify (`testEnv.authConstraint`) | §3 | degraded-verify moved here from pm-agent Job A |
| Claiming (atomic, verify-after-write) | §7 | |
| Dedup before filing | §8 | |
| Blocked protocol + bail-shapes | §9 | W3 intake §9a; team intake §9b |
| W5 external-prereq tracker (park → block → auto-unpark) | §9c | PM runs it; Sweep backstops — both cite |
| REPLACE-labels + the 4 write hazards | §10 | labels replace the full set; verify state after write; one label filter; real newlines |
| Dry-run conduct | §12 | analysis yes, mutations no; mid-run override rule |
| Autonomy posture (ask vs full) | §12a | |
| Landing / PR wait-state ("merged ≠ deployed" is NOT a verify-fail) | §12b | + auto-merge §12c, deploy ceiling §12d |
| Lessons read/write + budgets | §14 | locked read-modify-write is in §22 |
| Coverage rule | §15 | |
| Self-evolution firewall | §17 | |
| Backend transports + per-backend encodings | §18 | |
| Multi-repo resolution | §19 | |
| strategyDoc form detection (linearDocument → hubDoc → repo file) + doc-base + D4 section policy | §20 | detection rule moved here from pm-agent §0 |
| Observe-and-file contract; verification recipes (`incident`, `tech-debt`) | §21 | |
| Split detection (explicit config, never inference); design gate (promote children FIRST, then parent Done); escalation ladder junior → senior direct-code → fix-exhausted → Human-Blocked | §21a | promote-first ordering moved here from pm-agent |
| Report mechanics: trees, cadence markers, 点评 review loop, lessons lock | §22 | team digest contract §22a; Linear sink §23 |
| Codex power tools | §24 | |

`hub/test/skill-refs.ts` already pins every §-citation to a real anchor (39 numbered
anchors after this prep). The budget agent's lint adds the structural checks below.

## 4. The uniform SKILL layout

Every `skills/*/SKILL.md`, in this exact order:

```markdown
---
name: <skill-name>
description: <ONE line — what it runs + the invoke/trigger phrases>
# model/effort only if pinned (normally scheduler-applied per config, §21a)
---

# <Agent> Agent

ROLE: <one sentence — who this agent is in the loop>.

## MISSION

<One short paragraph: what a fire accomplishes and through which surface
(ticket state only). No protocol content.>

## BOOT

Every fire is fresh (conventions §0); run the standard boot sequence (§0a) with your
per-agent inputs: <≤5 bullets of agent-specific config fields / lessons section /
open-line items>.
Sections: §0 §0a §2 …

## JOBS

<The agent's actual per-fire jobs — the ONLY place substantive prose is allowed.
Job/Step structure stays (Job A/B/C…, Step 0–7). Each step states WHAT this agent
does and cites the §-anchor for every shared mechanic (one clause, no restatement).
Agent-owned mechanics (e.g. dev's ship-gate specifics, ops probe logic, reflect
curation heuristics) are written out here — they live nowhere else.>

## HARD LIMITS

- <one line each — the agent's own guardrails; shared guardrails are citations,
  e.g. "- Only `dev-loop`-labelled tickets, always project-scoped (§2).">

## REPORT

One line: close per conventions §22 (daily append at close; roll-ups + 点评 distill
at boot) + the agent's headline metrics (§22 names them per agent).

<!-- cli-cheatsheet:begin agent=<short-name> -->
… generator-owned; regenerate via `node hub/src/gen-cheatsheets.ts`; NEVER hand-edit …
<!-- cli-cheatsheet:end agent=<short-name> -->
```

Rules:
- **Frontmatter description is ONE line.** The trigger phrases survive; the mini-spec
  paragraphs (pm-agent's is 24 lines) do not — behavior lives in JOBS/conventions.
- **The cheat-sheet block is the LAST block of the file** (the generator inserts at
  end-of-file when markers are absent; `hub/test/cli-cheatsheet.ts` byte-checks it).
- **Team-mode addenda fold into JOBS/HARD LIMITS** — no separate `## Team mode`
  section survives; team behavior is §9b/§22a/§27 citations plus at most a few lines.
- Setup skills (add-project / add-repo / sync-project / sync-repo) keep their
  numbered-step body as JOBS; they use the same layout minus the cheat-sheet block.

## 5. The `Sections:` line — grammar

Machine-readable declaration of the conventions sections this SKILL needs, placed as
the **last line of the BOOT section**:

```
sections-line = "Sections:" 1*( SP anchor ) LF
anchor        = "§" 1*DIGIT [ letter ]        ; §5, §5a, §21a …
```

- **Exactly one** `Sections:` line per SKILL, starting at column 0.
- Anchors are **unique** and **ascending** (sort key: number, then bare-before-letter:
  §12 < §12a < §12b < §13).
- **Every anchor resolves** to a numbered heading in conventions.md (skill-refs rule).
- **Set equality with the body:** the line lists exactly the union of §-anchors cited
  anywhere in the SKILL (including the line itself is a no-op since its members are by
  construction cited; the lint compares the line's set against the set of §-references
  found in the rest of the file). A cited-but-undeclared or declared-but-uncited
  anchor fails the lint.
- **Mandatory minimum:** §0, §0a, §2 — present by construction, since the §4 BOOT
  template cites §0 + §0a and the HARD LIMITS template cites §2, and set-equality
  then forces them onto the line.
- **Span semantics** (for the boot rule and the bill): a cited anchor covers its
  heading through the line before the next numbered heading **of the same or
  shallower level** (headings inside fenced code blocks don't count — §6's ticket
  templates contain literal `## …` lines). A `###` lettered child (§5a, §9a–c, §20a,
  §22a, §0a) is nested inside its `##` parent: citing the parent includes it; citing
  only the child loads just the child. `##`-level lettered sections (§12a–d, §21a,
  §21b) are standalone. The unnumbered **Topology at a glance** block is part of the
  always-read preamble (below), not a citable anchor.

## 6. Boot rule + the context bill (budget agent implements)

- **Boot-rule change (conventions §0a step 1):** from "read this file" to "read the
  **Topology at a glance** block plus exactly the sections your SKILL's `Sections:`
  line names (§0/§0a/§2 are always among them)". Conflict rule unchanged: conventions
  overrides the SKILL. An agent that finds itself needing an uncited section mid-fire
  may read it (and that's a lint smell to fix in the SKILL), never guess.
- **Generator (shipped as `hub/src/context-bill.ts`):** for each agent emit `SKILL
  prose + cheat block + Σ cited section spans (union — overlaps counted once) +
  the lessons.ts caps` in lines and bytes — the per-agent per-fire context bill,
  printed by `dev-loop metrics --context` (`--json` for machines). Per-section span
  sizes measured 2026-07-12, pre the progressive-disclosure extraction pass (lines):
  §18=333, §22=222, §21a=189, §9=142, §19=135 were the heavy sections; a worker citing
  ~18 sections booted on ≈1,400–1,700 conventions lines instead of 2,949. Current
  figures: `dev-loop metrics --context`.
- **Budget lint (shipped as `hub/test/context-budget.ts`):** enforces §7's ceilings
  (prose measured excluding the marker span) and the `Sections:` grammar +
  set-equality of §5 (prose-only — the generated cheat blocks cite anchors of their
  own). Wired into `npm test` beside skill-refs. The machine authority for §7's
  numbers is the `BUDGETS` table in `hub/src/context-bill.ts`; this doc stays the
  design record — a budget change edits both.

## 7. Budgets (final numbers)

Prose budget = the whole file **minus the cheat-sheet marker span** (frontmatter
counts — it is boot context too). Both ceilings bind (lines AND bytes). Operator's
proposed numbers adjusted within the allowed ±20% against the §1 baseline:

| Tier | SKILLs | Lines | Bytes | vs proposal — why |
|---|---|---:|---:|---|
| PM | pm-agent | **300** | **22 KB** | bytes +10%: at the measured ~73 B/line, 300 lean lines ≈ 22 KB; 20 KB would silently bind at ~270 lines |
| Worker | qa, senior-dev, junior-dev, sweep | **220** | **16 KB** | bytes +7%: same density math (220 × ~73 ≈ 16 KB) |
| Legacy dev | dev-agent | **260** | **18 KB** | +18% lines / +20% bytes vs the operator-proposed worker numbers (220 / 15 KB): dev-agent hosts the CANONICAL Step 0–7 ship sequence (build/test gate, 5.5 self-review, ship-per-config, 6.5 rollback) that §21a makes senior/junior *inherit by reference* — spec weight no other worker carries; still a 43% line cut from its 455-line baseline |
| Observer | reflect, ops, architect, communication | **200** | **14 KB** | bytes +8%: density math; lines as proposed (all four fit — their contracts live in §21/§17/§22) |
| Setup | add-project, add-repo, sync-project, sync-repo | **150** | **10 KB** | as proposed; all four already ≤82 lines — this is a ceiling, not a target |
| Cheat-sheet block | generator-owned, per agent | **95** | — | +5: sweep's generated block is already 91 lines; 90 would force a generator-template trim mid-migration. Growth beyond 95 = trim the generator, never the budget |

Projected post-migration totals: the ten agent-SKILL prose ceilings sum to **2,240
lines** against a **3,407-line** measured baseline (−34% guaranteed by the ceilings
alone; most files should land well under them). The four setup skills (237 lines
today) already fit their 150-line ceilings. And the per-fire conventions read drops
from 2,949 lines to each agent's cited spans.

## Out of scope for the migration agents

- `references/conventions.md` content (anchors are frozen by this prep).
- The cheat-sheet generator/template and anything inside the marker blocks.
- The boot-rule §0a edit, the new lints, and the bill generator (budget agent).
- `hub/skills/` + `hub/references/` (build output — `npm run build` re-copies).
