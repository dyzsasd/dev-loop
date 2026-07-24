# The Quality Gauntlet — metric gates for code nobody reads

**Status:** shipped (1.7.0) — items 1–4 below; item 5 (G5) is the recorded backlog.
**Origin:** field research on `unclebob/crap4java` (2026-07-24) after two days of
multi-provider unattended runs. Uncle Bob's stance — *"I don't read the code my agents
write; I surround them with extreme constraints"* — is the same doctrine dev-loop already
runs for COORDINATION (verify against the running product, observe-and-file, gates over
prose). What his gauntlet had that dev-loop lacked was the QUALITY layer: scalar,
thresholded, machine-judged metrics between "tests pass" and "ship it".

## Why binary gates aren't enough (two field incidents)

- **The fake-green suite.** MEETPOIN-29: every price in the suggest response was `null`
  and the 80-test suite stayed GREEN — the tests exercised the code paths but asserted
  nothing about the values. Coverage cannot see this. A mutation probe does: flip an
  operator in the pricing path and the suite still passes ⇒ the tests don't bite.
- **The null-crash trilogy.** The same missing-hotels guard crashed web, mobile, and MCP
  separately (MEETPOIN-89/91/92) — three tickets, three fixes, one underlying shape:
  complex rendering code with no covering test. Per-function CRAP flags exactly that
  intersection *before* QA trips over it three times.

## The tool: `dev-loop quality` (`hub/src/quality.ts`)

Modeled on crap4java, rebuilt for the Node/TS zero-build stack, dependency-free:

- **CRAP per FUNCTION**: `CRAP = CC² × (1 − coverage)³ + CC`. Complexity from the target
  repo's own `typescript` AST (decision points: if / loops / case / catch / ternary /
  `&&` / `||` / `??`; nested functions are their own rows). Fallback without a resolvable
  `typescript`: one honest per-file row.
- **Coverage from native V8** (`NODE_V8_COVERAGE`), no jacoco/c8/istanbul: ranges painted
  outer-first per process, OR-merged across processes. On Node's type-stripping, TS
  offsets are PRESERVED in the running file, so V8 ranges map 1:1 onto `.ts` source —
  the zero-build stack's free lunch.
- **Report**: worst-first table (crap4java shape), `--top`, `--json`.
- **Gate**: `--threshold N` ⇒ exit 2 when max CRAP exceeds it.
- **Selection**: default `src/**`; `--changed` (git status) is the cheap per-fire form;
  explicit paths.
- **Mutation probe** (`--mutate --sample N [--fail-on-survivors]`): for the worst-CRAP
  functions, flip ONE operator/boolean (`===`↔`!==`, `<`↔`<=`, `&&`↔`||`, `+`↔`-`, …),
  re-run the tests, restore the file **byte-identically** (sha-verified; SIGINT/crash
  traps restore; dirty files are refused). KILLED = a test caught the behavior change;
  SURVIVED = a test gap, loudly. Exit 3 on survivors with `--fail-on-survivors`.
- Exit codes: `0` ok · `1` usage/internal · `2` threshold exceeded · `3` survivors.

First self-run on dev-loop's own hub found two real gaps immediately: boundary flips in
`context-bill.parseConventions` (`<`→`<=`) and `splitSkill` (`||`→`&&`) survived the
context-budget test file — the tool paid for itself before it shipped.

## The five integrations

1. **`repos.<ref>.build.quality` — the fourth Step-5 ship gate** (typecheck → build →
   test → quality). Config-schema documents it; `team add-repo --detect` maps package.json
   scripts named `test`/`quality` (alongside the existing typecheck/build); `--test-cmd`/
   `--quality-cmd` flags for the explicit path; doctor nudges (info line) when a repo has
   a test gate but no quality gate. Recommended starting shape:
   `"quality": "dev-loop quality --changed --threshold 30"` (brownfield-lenient; tighten
   as the report drains).
2. **Architect dimension `test-strength`**: run the CRAP report, probe the worst rows
   with `--mutate --sample 5`, file survivors as `qa`+`coverage` tickets. The probe is
   the ONE sanctioned exception to architect's never-mutate-the-tree rule — it
   self-restores byte-identically and refuses dirty files (read-equivalent).
3. **§15 strengthened**: the STRONG form of "the regression test bites" is killing at
   least one mutant in the changed function (`dev-loop quality --mutate <file>`).
4. **Executable ACs (`AC-exec:`)**: the ticket templates carry an optional AC-exec block
   (one command; exit 0 = accepted); §7's verify gate runs it instead of interpreting
   prose — executable beats interpretation. Prose ACs stay as the human-readable intent.
5. **G5 (backlog, not shipped): method-level semantic hashes for incremental mutation.**
   crap4java's sibling `mutate4java` embeds a per-scope manifest (method span + semantic
   hash) in every source file, so mutation re-runs only scopes whose semantics changed —
   the same change-gate idea dev-loop runs at repo-SHA level, pushed down to method
   granularity. Adopt when probe runtime on large repos starts to hurt: store the scope
   hashes in `.dev-loop/<project>/quality-state.json` (NOT in source files — we have a
   state dir; Bob doesn't), diff at probe time, mutate changed scopes only.

## Known limits (honest edges)

- Repos whose tests run COMPILED output (`dist/`) get coverage on dist paths, not src —
  rows go N/A and the tool says so. Source-map remapping is future work; zero-build
  repos (and dev-loop itself) are unaffected.
- V8 counts a function's declaration line as executed, so "untested" functions show a
  few covered bytes — CRAP still ranks them worst; thresholds should assume ~5–10%
  floor, not 0%.
- The probe mutates ONE site per function (deterministic first-site) — a sampling probe,
  not exhaustive mutation testing. That's the point: minutes, not hours, every fire.
