# Job-scoped prompts — scheduler-routed playbooks + a tiny constitution

Status: **design / grounded, not yet implemented** (2026-08-27). Supersedes the byte-budget
approach of the WS-A "prompt economy" change (which sliced conventions per *agent* to ≤64KB); this
goes one granularity finer — per *job* — and deletes platform-exposition from the agent surface.

## The problem (restated)

An agent fire today loads its whole SKILL + a ≤64KB per-agent slice of `conventions.md`, then
*reasons* about which rule applies. Two wastes:

1. **Exposition tax.** ~21% (19.2KB) of the agent-facing convention surface is "how/why the
   platform works" the agent never acts on — and ~6.4KB of that rides *literally every fire*
   (the Topology block + the §0a boot-corpus mechanics). Measured, not estimated.
2. **Whole-role load.** An agent has many jobs; a pm fire ingests all 30 cited sections + the whole
   SKILL (**measured 106KB**, not 64KB — the delivery agents cite ~80% of the kernel), then the
   agent decides what to do. The process reasoning (which verb, what order, what a state means)
   burns tokens that should go to the *content* work (writing the ticket, judging acceptance).

**Principle:** the LLM should spend tokens on **content judgment**, never on **process derivation**.
Process = fixed, scheduler-injected scaffolding. Content = the LLM's job.

## The architecture — three tiers

1. **Constitution** (`skills/_constitution.md`, resident every fire, **floor ≈6.4KB, target ≤8KB**):
   the invariants that gate *every* action regardless of job — state machine + legal transitions,
   the `dev-loop` firewall (§2), write hazards (§10), isolation (§7 safety core), dry-run gate (§12),
   autonomy posture (§12a), deploy ceiling (§12d), security doctrine (§16), governing-file firewall
   (§17), report contract (§22), **no force-push / no history rewrite** (today only implicit —
   promote to an explicit line), identity/project resolution (§11). Rewritten tight and tabular.
2. **Job playbook** (one per fire, 3–10KB avg ~6KB): a self-contained procedure for one task —
   preconditions → ordered steps → exact verbs → exit criteria → the "when blocked" branch. ~52
   distinct playbooks, of which **12 are shared** (SH-boot, SH-report, SH-ship, SH-claim-groom,
   SH-fire-start, SH-block-park, SH-extprereq, SH-file-ticket, SH-verify-close, SH-change-gate,
   SH-split-gate, _constitution). Shared ones authored once in `skills/playbooks/<slug>.md`, referenced
   by slug from each agent's `RUNBOOK.md` job-index — never copied (a per-SKILL copy is a protocol fork).
3. **Reference stub** (pulled only on a specific trigger): the deep material stays in
   `references/conventions/<slug>.md` (already externalized by WS-A) + `references/*.md`, read only when
   a playbook step says "if you hit situation S, read R." Platform-exposition is **deleted** from the
   agent surface entirely and moves to `docs/` for humans.

Per-fire load: single-job fire ~23KB (vs 57–98KB, ~3–4× lighter); heaviest multi-job pm fire ~40KB
(~2.6×). The saving is largest exactly where cost is largest.

## The crux — can the scheduler decide the job? (grounded answer: mostly yes)

Two populations:

- **Single-purpose agents** (ops, reflect, architect, communication, sweep digest/mirror): **~100%
  deterministic today** — one job per fire; the scheduler already "picks the job" by picking the
  agent. The redesign just deletes the job-selection prose.
- **Multi-arm inward agents** (pm, qa, sweep-jobs-1–3, the dev sequence): **arm *selection* is
  ~80–90% deterministic** from row predicates the scheduler already computes (dev tiers are the
  proof — `servableSlice` + `PICK_RANK` give the arm AND the exact ticket for $0). The residual
  ~10–20% that genuinely needs an in-fire read is narrow and specific: **comment-marker routing** —
  PM/QA unblock (`decision-needed` vs `info-needed` lives in a *comment*), W3 intake classification,
  sweep type-setting. The within-job *verdict* (pass/fail, groom-into-shape) is the *work*, not
  job-selection, and should never be scored against the scheduler.

**The one high-leverage fix:** promote the bail-shape from a comment marker to a **label**
(`decision-needed`/`info-needed`/`external-prereq`/`fix-exhausted`). Then PM/QA unblock routing
becomes a row predicate and the last genuinely-ambiguous selection call collapses to deterministic.

**Fallback where selection stays content-dependent:** a *thin* triage playbook — the scheduler hands
the agent the arm-eligibility vector (a short candidate list) + a dispatch playbook whose only charter
is "confirm the arm with one cheap read, then pull the real job playbook." Hard boundary: it resolves
*which job*, never *the verdict*; the moment it does pass/fail work it has already left triage. Applies
only to pm/qa/sweep marker-routing, never to dev tiers or single-purpose stewards.

## The mechanism — reuse what WS-A already built

writing-loop is the proof of the shape (scheduler-owned predicate → Sections-driven scoped digest →
constant body + variable "why-launched" tail); dev-loop pushes the key from `agent` to `agent+job`.
dev-loop already has the two hardest pieces: the A2 constant/tail split and the A1 config-pruned
slicer. Concretely:

- Add `jobSlice(skillText, job)` + `CONSTITUTION_ANCHORS` to `context-bill.ts` (one span authority for
  assembler, bill, and pull verb — matching the existing "one authority" invariant). Job markers in
  the SKILL: `<!-- job:verify:begin -->…<!-- job:verify:end -->`, reusing the `DEV_SLICE_MARKERS`
  machinery.
- `assembleBootCorpus(..., job?)`: when set, feed `CONSTITUTION_ANCHORS` (not the agent's 30 anchors)
  to `conventionsUnionText`, and push `jobSlice(skill, job)` as the body. The gap-marker that already
  says "read on demand per §0a" covers the dropped sections.
- New `pmJobGate(opts, project) → "verify"|"unblock"|"groom"|"review"|null` beside `devTierQueueSkip`,
  reusing `servableSlice` + `changeKey`. Thread the chosen `job` through `runAgent`/`readPrompt`/
  `assembleBootCorpus` and into the why-launched tail + `FireReason`.
- `dev-loop playbook <agent> <job>` pull verb beside `conventions` (same `process.exitCode` drain
  rule), reusing `jobSlice` + `conventionsUnionText` so a pushed and a pulled playbook are byte-identical.
- A2 invariant preserved: two `pm/verify` fires share a byte-identical cacheable prefix; `pm/verify`
  vs `pm/review` differ — which is correct, they're different work.

**Mid-fire job switch — one-job-per-fire (Option A) is the default**; discovered work changes the
board and the next tick's job-gate selects the next job (dev-loop already wakes on `changeKey`). The
`dev-loop playbook` pull verb exists as a narrow escape hatch (Option B), default OFF like the
conventions pull, for the genuine same-fire obligation (e.g. pm's `[reflect-proposal]` deferred-findings
triage). Its cost (broken cache prefix) is self-limiting.

## Migration order (pm first, prove end to end)

(a) `jobSlice` + `CONSTITUTION_ANCHORS` in context-bill.ts; (b) job markers in pm SKILL;
(c) `assembleBootCorpus(job?)` swap; (d) `pmJobGate` + thread `job`; (e) `dev-loop playbook` verb;
(f) flip flag for pm only; (g) migrate remaining agents; (h) drop now-unpushed exposition anchors from
every `Sections:` line, update the context-budget lint + `CONVENTIONS_BUDGETS` to the per-job shape.
The Sections↔cited-anchors set-equality lint fails loud on drift — that is the migration guardrail.

## Decisions the operator must make (not feasibility — product)

1. **Bail-shape: comment marker → label?** (collapses the last ambiguous selection call; touches §9,
   the write layer, and every unblock consumer). Recommended: yes.
2. **pm/qa one-fire-many-jobs → split into finer scheduler fires (`pm-verify`/`pm-groom`/`pm-review`)?**
   Or keep the multi-job bundle (constitution + the triggered playbooks, ~40KB)? Finer fires = cleaner
   per-job cache + accounting, more fires (cost/latency). This is the real architectural fork.
3. **How far to delete exposition** — move to `docs/` wholesale, or keep a 1-page "how the loop works"
   pulled once at onboarding? Recommended: delete from agent surface, keep a human doc.
4. **Judgment-core jobs** (PM ideation, senior design, QA bug discovery, communication authoring): their
   playbooks are *scaffolds around a judgment step*, never scripts — accept that ~15–30% of these jobs
   stays irreducibly in-fire. This bounds how far "fixed patterns" can go and should be explicit.

---

## CONFIRMED (2026-08-27) + build contract

All four decisions confirmed. Decision 2 refined: **`groom` is pulled out as its own fire too**
(grooming shapes a vague backlog item into a spec — ACs, type, owner, tier §21b, repo, promotion
order — that is design-ish judgment, not mechanical), so pm splits into **three job-lanes**, and the
split unlocks **per-job model tiers**:

| pm job-lane | jobs it runs | model tier | why |
|---|---|---|---|
| `pm-maintenance` | verify (Job A) + unblock (Job B) | cheaper/faster (sonnet-class) | mechanical; share one `queue` board read |
| `pm-groom` | groom+promote (Job B2) | stronger (opus-class) | design-ish shaping of backlog→spec |
| `pm-review` | product review (Job C) | stronger (opus-class) | judgment ideation; change-gated |

1. bail-shape → labels: **yes**. 2. pm split with groom separate + per-lane models: **yes**.
3. extract-then-delete exposition from agent surface (docs/ for humans): **yes**. 4. `kind:
mechanical` vs `kind: judgment-scaffold` front-matter guardrail: **yes**.

### Locked interface contract (all workstreams obey)

- **Job markers** in a SKILL/RUNBOOK: `<!-- job:<slug>:begin -->` … `<!-- job:<slug>:end -->`.
  pm slugs: `verify`, `unblock`, `groom`, `review`.
- **Job-lane** = the scheduler fire unit `(actor, lane)`, mirroring how the dev split made
  senior-dev/junior-dev fire units — EXCEPT a pm lane keeps actor identity `pm` (same owner label,
  same board slice); lanes differ only in cadence + model + which job playbook(s) load. Roster gains
  `pm-maintenance` / `pm-groom` / `pm-review`; all fire as `DEVLOOP_ACTOR=pm`.
- **Constitution**: a new file `skills/_constitution.md`, loaded VERBATIM as the resident kernel
  (target ≤8KB). Not a conventions anchor set — a real file we size-control. Additive for now;
  conventions.md is NOT thinned in the PoC (other agents still read it — deletion is rollout step h).
- **Playbooks**: shared ones authored once in `skills/playbooks/<slug>.md`; a pm job's procedure is a
  marked span in the pm SKILL that references the shared playbooks it uses. Each playbook/ job span
  carries front-matter `kind: mechanical | judgment-scaffold` and a `pulls:` list of reference stubs.
- **Per-lane model config**: `team.agents.<lane>.model` / `.effort` / `.cadence` reused wholesale
  (the lane is an agent-roster key). Defaults seeded: maintenance=sonnet, groom/review=opus.
- **Loading**: `assembleBootCorpus(..., job?)` — when job set, body = `_constitution.md` +
  `jobSlice(pmSKILL, job)` (+ the shared playbooks it references); conventions union is dropped to
  what the job pulls. Byte-stable prefix per `(actor, job)`; `pm-verify` fires share a prefix,
  `pm-verify` vs `pm-groom` differ (correct).
- **`dev-loop playbook <agent> <job>`** pull verb (mid-fire escape hatch, default OFF), byte-identical
  to the pushed slice.

### PoC scope (this increment) vs. follow-up

**PoC = prove on pm end to end:** decision-1 labels + the mechanism (jobSlice / CONSTITUTION /
assembleBootCorpus(job) / job-lane scheduling / per-lane model / pull verb) + the `_constitution.md` +
pm's four job playbooks + per-lane model seeding + tests + a measured `metrics --context` before/after.
conventions.md stays intact. **Follow-up (rollout):** migrate the other 10 agents to job-lanes, then
thin conventions.md (delete the extracted invariants + move narrative to docs/).

---

## PoC IMPLEMENTED (2026-08-27) — pm end to end

Built on `feat/prompt-slim-operator-harness`. Three workstreams merged: Decision-1 labels, the
constitution + pm playbooks, the mechanism (jobSlice / assembleBootCorpus(job) / pm job-lanes /
per-lane models / `dev-loop playbook` verb).

**Measured pm per-fire load** (pushed constant segment = `_constitution.md` + job span + pulled
shared playbooks), vs the whole-role pm fire (~106–118 KB):

| pm lane → job | kind | model tier | constant bytes |
|---|---|---|--:|
| pm-maintenance → verify | mechanical | sonnet/high | 18,945 B |
| pm-maintenance → unblock | mechanical | sonnet/high | 19,660 B |
| pm-groom → groom | judgment-scaffold | opus/max | 15,321 B |
| pm-review → review | judgment-scaffold | opus/max | 17,718 B |

**≈6–8× lighter**, and each fire loads exactly its job + a ≤8.5 KB constitution, with no
platform-exposition and no sibling-job load. Job-lanes keep `DEVLOOP_ACTOR=pm` (same owner label /
board slice) while being distinct scheduling units (own cadence/model/job) via a `laneActor()` map —
following the senior-dev/junior-dev precedent but without splitting identity.

### Integration decisions made during the build (operator-visible)
- **§4 de-duplication.** The Decision-1 label branch was based on origin/main (pre-WS-A), so the
  merge's keep-both resolution doubled §4's dev-tier-routing + workflow-signalling paragraphs (A3's
  compressed version AND the older verbose one). Collapsed to the compressed version, folding the
  new bail-shape-label line in. Net −2.7 KB.
- **Transitional conventions ceiling 64 → 70 KB.** review-2's fidelity audit RESTORED 8 invariants
  A3 had over-compressed, and Decision-1 added §9 bail-shape docs — pushing pm (66.6 KB) and qa
  (68.8 KB) over the old 64 KB target. Fidelity beats an arbitrary byte target; the ceiling is
  loosened rather than re-dropping restored rules. This entire per-agent conventions-UNION bound is
  superseded by the job-corpus bound once qa/sweep/dev migrate (rollout step h) — pm already doesn't
  load the union.

### Rollout remaining (deferred — the next increment, on operator go)
- Migrate qa, dev/senior/junior, sweep, ops, reflect, architect, communication to job-lanes +
  playbooks (mechanical repetition of the pm pattern; the single-purpose stewards are one lane each).
- Then thin conventions.md: delete the now-extracted invariants (they live in `_constitution.md`)
  and move the remaining exposition to docs/, dropping the union path — at which point
  CONVENTIONS_TARGET_BYTES / CONVENTIONS_BUDGETS retire.
- Optionally: qa/sweep triage-playbook for the marker-routing residual (mostly obviated by the
  Decision-1 labels).

---

## ROLLOUT COMPLETE + completeness-verified (2026-08-27)

All 10 loop agents migrated; default `dev-loop run` job-boots every agent (pm→3 lanes, qa→2 lanes,
per-lane models). A per-agent COMPLETENESS AUDIT (10 reviewers, each diffing the new job corpus
against the pre-migration whole-role SKILL) then caught what the byte counts and 161/161 tests could
NOT: two SYSTEMIC gaps — the job corpus silently dropped (a) the §14 **lessons** slice (the loop's
cross-fire learning) and (b) the **CLI cheat-sheet** (exact verb forms + exit codes) — plus a
handful of per-agent procedural steps (communication §22a team-digest, qa harness preflight,
senior-dev design block-protocol + §12c merge, junior-dev not-converging branch, pm review
stay-in-lane, ops/architect state-file shapes, reflect run-logs source). All fixed: `assembleJobCorpus`
now injects lessons + the cheat-sheet (one authority, pushed≡pulled byte-identical); the procedural
steps were restored to their spans/playbooks (pulling existing canonical stubs, no duplication).

### Honest before/after — per-fire instructional payload (vs the true PRE-migration whole-role load)

| agent | before (whole-role) | after (job-boot: constitution + job span + playbooks + cheat + lessons) | reduction |
|---|--:|--:|--:|
| pm | 120.5 KB | 22.1–26.5 KB (per lane) | 4.5–5.5× |
| qa | 111.7 KB | 20.9–26.4 KB | 4.2–5.3× |
| senior-dev | 127.3 KB | 24.4 (design) / 35.1 (directcode) KB | 3.6–5.2× |
| ops | 101.9 KB | 29.2 KB | 3.5× |
| dev | 118.1 KB | 35.4 KB | 3.3× |
| reflect | 89.7 KB | 27.7 KB | 3.2× |
| junior-dev | 128.9 KB | 40.7 KB | 3.2× |
| sweep | 109.6 KB | 35.8 KB | 3.1× |
| architect | 85.7 KB | 27.5 KB | 3.1× |
| communication | 72.9 KB | 26.1 KB | 2.8× |

**~2.8–5.5× lighter per fire, honest (the after includes cheat + lessons).** The core win is the
elimination of the 34–73 KB conventions UNION (now 0) — the single largest, most-wasteful term.
Each fire now carries exactly its job's procedure + the constitution + its verb reference + its
lessons, and nothing else. lessons in a real fire add this project's §14 slice (bounded by the W03
caps: INDEX 8 KB + shard 16 KB), 0 in the plugin-static measurement.

### The lesson from the audit
Byte counts and a green test suite do NOT prove semantic completeness. Extracting a whole-role SKILL
into a resident constitution + per-job playbooks silently stranded (a) anything in the un-loaded
SKILL frame (HARD LIMITS safety rules — QA-1; the cli-cheat-sheet) and (b) anything the extraction
thinned below the old procedure. A per-agent completeness critic against the pre-migration baseline
is the check that catches it. Future agents/jobs must put every normative rule in the constitution,
the job span, or a pulled playbook — never only in the frame.
