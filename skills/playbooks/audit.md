---
slug: AR-audit
kind: judgment-scaffold
pulls: skills/playbooks/file-ticket.md (the §6 tech-debt Improvement), references/conventions/two-tier-dev.md (§21b tier at filing), references/conventions/multi-repo.md (§19 per-repo children), references/codex-integration.md (§24 optional second opinion)
---

# AR-audit — the whole-codebase tech-health audit (Architect's one job)

Architect's single job, the executable expansion of the `job:audit` span. Each fire you audit the
codebase AS A WHOLE (not a diff) on ONE rotating dimension and file capped `tech-debt` Improvements
Dev implements and QA verifies later. "What is real, durable debt vs a nit?" is the JUDGMENT — this
playbook fixes the ENVELOPE (the change-gate, the rotation, read-the-baseline-first, dedupe, the cap)
and FRAMES that call. §21 observe-and-file: READ-ONLY on code — never implement, refactor,
bump/install a dependency, ship, or verify. `architect-state.json` is your ONLY cross-fire carrier
(§21): the per-repo audited-SHA map (§19), `swept` (dimensions covered per repo at that SHA), and
`cursor` (the round-robin position). Create it lazily as `{ "repoShas": {}, "swept": {}, "cursor": 0 }`
if absent (first-ever fire).

## Step 0 — change-gate preflight (bail fast on an unchanged tree)
Compute HEAD for every watched repo (§19) and compare to `repoShas`: ANY repo moved ⇒ reset its
`swept` (moved code deserves a fresh pass on every dimension); NO repo moved AND every dimension
already swept at the current SHAs ⇒ emit a terse no-op ("No repo moved since <shas>; all dimensions
swept.") and stop. A repo with no commits yet (no HEAD) is greenfield, not an error. **Honest bound:**
on an active repo HEAD moves nearly every fire, so the gate rarely short-circuits — dedupe + the cap,
not the SHA gate, are what keep you from flooding the board.

## Step 1 — pick this fire's dimension (rotate)
Audit ONE dimension per fire, chosen by `cursor % dimensions.length`, then advance + persist the
cursor (advance EVERY fire independently of SHA resets, or an active repo would only ever get the first
dimension). Skip a dimension already in `swept` at the current SHAs, but keep advancing. The set:
- **architecture-drift** — layering violations vs the stated structure, god-modules, circular deps.
- **duplication** — copy-pasted logic / parallel implementations of one concern.
- **dead-code** — unreferenced exports/modules/routes/flags, commented-out blocks, unreachable branches.
- **dependency-staleness + CVE** — outdated deps + known vulnerabilities via the READ-ONLY audit form
  (`npm/pnpm audit`, `pip-audit`, `go list -m -u`, `cargo audit` — list, never upgrade).
- **cross-module consistency** — divergent patterns for the same job (error handling, validation,
  naming, config access) across modules.
- **missing-abstractions** — repeated ad-hoc patterns that want a shared helper/type/boundary.
- **test-strength** — tests that don't bite: run `dev-loop quality` (per-function CRAP = complex ∧
  untested, worst first), then the mutation probe `dev-loop quality --mutate --sample 5` on the worst
  rows. A SURVIVING mutant = a behavior change no test noticed — file it (owner `qa` + `coverage`
  fits). READ-ONLY note: the probe self-restores byte-identically and refuses dirty files, so it counts
  as read-equivalent — the ONE sanctioned exception to "never mutate a working tree"; never hand-edit
  code yourself.

**EXCEPTION:** run the dependency-staleness + CVE scan EVERY fire regardless of cursor or `swept` — a
cheap read-only shell command, and the one dimension where a missed day has security consequences.
Multi-repo (§19): audit each repo on the chosen dimension AND the cross-repo coherence of it.

## Step 2 — audit the dimension (read-only), read the baseline FIRST
Read the baseline BEFORE judging drift, so "drift"/"missing-abstraction" is measured against the
INTENDED structure, not invented: the doc-base `Current state` + `Glossary` (§20), the repo's
`CLAUDE.md`, any `contributorSkill` (§19). THEN audit the codebase as a whole for the chosen dimension
— grep/read the relevant surfaces, run the read-only dependency/CVE scan when that's the dimension —
collecting concrete findings, each with a file/path locus and why it's debt. Favor high-signal, durable
findings over nits (a real layering violation or a CVE beats a style quibble). Optional Codex second
opinion (§24): `codex.review` may add an advisory read-only review of the dimension's surfaces —
sub-flag-gated, never a code edit or a board write.

## The judgment step — Step 3: file tech-debt Improvements (dedupe hard, capped)
Dedupe every finding before filing (§8): against existing non-terminal tickets on the same debt (bump,
don't refile); against `lessons.md` (a rule encoding an accepted trade-off ⇒ don't file — it's a
decided thing); against reality at current HEAD across ALL `repos[]` (the abstraction may already exist
in a sibling — but never collapse legitimate per-repo children). File each survivor as ONE Improvement
via SH-file-ticket (adapt the §6 template's Context/Acceptance/Affected-area shape to a refactor):
`dev-loop` + `Improvement` + `qa` + `tech-debt` (+ `sensitive` when it touches
auth/permissions/payment/PII/secrets/data-migration — §4, forces senior), in **`Backlog`** (§5a — PM
grooms + promotes at pace; a tech-debt burst never floods Todo). Owner is `qa`, not `pm`: the §21
`tech-debt` recipe (build/tests green + the named debt gone + no behavior change) is QA-checkable.
**Tier at filing (§21b):** split-dev ⇒ `junior-dev` (scoped, behavior-preserving refactors); a finding
needing cross-module DESIGN (a module-boundary change, a shared abstraction spanning modules, a
layering restructure) ⇒ `senior-dev` as a `Mode: design` design-and-delegate ticket, never junior;
legacy ⇒ no tier marker. Priority Low/Medium; High only for a security-class finding (a real CVE /
vulnerable dep). Body: the precise locus (files/paths), the debt + its risk/cost, and a crisp
**observable** acceptance criterion. Multi-repo (§19): set `repo:<name>`; a cross-repo finding files
per-repo children (`relatedTo` each other), never one ticket spanning trees.

*Good looks like* a high-signal, durable finding with an observable AC, correctly tiered and deduped.
*Avoid* nits, re-filing a decided trade-off, and dumping the whole audit on the board — honor the
per-run cap (default **≤3 filed/fire**), surfacing the rest as report candidates. Then record the
reviewed SHA (not end-of-run HEAD) per repo and add this dimension to `swept`.

## Exit criteria
The dimension audited against its baseline; ≤3 survivors filed to `Backlog` (deduped, tiered, repo
targeted); the state-file SHA/`swept`/`cursor` advanced. Filing zero is a valid run. A Step-0
short-circuit ⇒ terse no-op. `dry-run` ⇒ no writes (board, state file, or reports) — list the
would-file tickets.

## When blocked
Stay in your lane (§21): a product gap is PM's `Feature`, a live defect QA's `Bug`, loop process
Reflect's, board hygiene Sweep's — note misfits for the right agent instead of filing them as
`tech-debt`. A committed secret found during audit is a §16 stop-and-surface fact, not a routine
ticket.
