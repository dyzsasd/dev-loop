# Multiple repos — normalization, resolution, routing — conventions §19 pointer file

> Moved out of `references/conventions.md` §19 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §19's contract: read it at the trigger moment the §19 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

### Read-side normalization (never written back)
Wherever an agent needs "the repos of this project", normalize **on read**:
- `repos[]` present → use it verbatim.
- `repos[]` absent → synthesize a single implicit entry
  `[{ path: <repoPath>, name: <project-key> }]`.

This normalization is **read-side only**. init MUST NOT rewrite an existing
`repoPath`-only config into `repos[]` form — that is what keeps single-repo projects
byte-for-byte as today. `len(repos) == 1` is treated **identically** to the absent
case: one implicit target, no routing artifacts.

If **both** `repoPath` and `repos[]` are set: `repos[]` **wins**; init warns and
verifies `repoPath` is one of the `repos[].path` entries.

### Resolution rule (define once, used everywhere)
For any per-repo-overridable setting, the **effective** value for a given repo is:
the repo's own value **if present**, else the **top-level** value.

| Setting | Per-repo override | Falls back to |
|---|---|---|
| `build` (typecheck/build/test/quality — run in that order at Step 5; `quality` is the optional CRAP/mutation gate, e.g. `dev-loop quality --changed --threshold 30`) | `repos[].build` | top-level `build` |
| `defaultBranch` | `repos[].defaultBranch` | `git.defaultBranch` |
| `landing` (direct/pr, §12b) | `repos[].landing` | `git.landing` |
| `autoMerge` (§12c) | `repos[].autoMerge` | `git.autoMerge` |
| `mergeChecks` (§12c) | `repos[].mergeChecks` | `git.mergeChecks` |
| `deploy` (command/style/environments + healthCheck) | `repos[].deploy` | top-level `deploy` |
| `contributorSkill` | `repos[].contributorSkill` | top-level `contributorSkill` (absent ⇒ read the repo's `CLAUDE.md`, today's behavior) |
| `lang` (informational only) | `repos[].lang` | top-level `lang` |

**Multi-repo pr mode:** `landing`/`autoMerge`/`mergeChecks`/`deploy` all resolve per-repo, so one
repo can run `"pr"`+`autoMerge` with its own `mergeChecks` + release-PR deploy while a sibling runs
`"direct"` — Dev reads the **ticket's target repo** (its `repo:<name>` label) and applies that
repo's resolved landing/deploy. `autoCommit`/`autoDeploy` stay product-level in `git`.

The synthesized single-repo entry inherits **all** top-level `build`/`git`/`deploy`,
which remain the authoritative single-repo source — so resolution on a single-repo
project returns exactly today's values.

- `autoCommit` / `autoDeploy` are **product-level**, in the `git` block — they are **not**
  per-repo. Only `defaultBranch` is per-repo overridable. Pushing is not a flag: a landing
  publishes when the repo has a remote (§7).
- A repo whose resolved `deploy` is empty (neither `repos[].deploy` nor a top-level
  `deploy`) **skips deploy entirely** and NEVER inherits another repo's
  `deploy.command`/`healthCheck`.
- `repos[].role` is **load-bearing**: a `"docs"` or `"primary"` role designates the
  **doc-home repo** (below). `repos[].lang` is **informational** (a contributor hint
  for Dev) — no logic wires to it; never compute behavior from it.

### The repo target is a label: `repo:<name>` (both backends)
Each multi-repo ticket carries exactly one **`repo:<name>`** label naming its target
repo (the `name` from `repos[]`). This reuses §4/§18's single abstraction: the label
lives in the ticket's label set on either backend. The
existing label-in-`labels[]` filter and the REPLACE-style full-set discipline (§10 #1,
§18) apply unchanged: to set or keep the repo target, re-pass the **full** label set.
Single-repo projects carry **no** `repo:*` label — the sole repo is implicit.

### Missing / wrong repo target
In a **multi-repo** project the repo target is a §6 required field. If a ticket Dev
picks has **no** (or a contradictory) `repo:<name>` label, Dev does **not** guess and
does **not** default to `repos[0]` (wrong-tree hazard, §7): it **blocks** the ticket
(§9) — `Bail-shape: info-needed`, or `scope-design` if the work genuinely spans repos
and needs splitting — routed to the owner. Sweep Job 1 likewise **flags** a missing/
contradictory repo label for the owner; it never guesses a repo, exactly as it never
guesses a type.

### Doc-home repo
The product-level `strategyDoc` / doc-set (§20) lives in one **doc-home** repo: the
`repos[]` entry with `role:"docs"`, else `role:"primary"`, else `repos[0]`. PM reads
and commits the doc there (Job C step 5), init scaffolds it there, and any strategy-
doc reference (e.g. a Reflect §17 promote-to-`strategyDoc` proposal) targets that
repo. A `strategyDoc` path resolves relative to the doc-home repo; an explicit repo-
qualified path (`"<repo-name>:docs/strategy.md"`) is also allowed and overrides the
default. Single-repo: the doc-home is the sole repo (today's behavior).

### Per-repo change-gate
PM and QA gate their expensive sweeps on "did the watched code move" (preflight). With
multiple repos, `pm-state.json` / `qa-state.json` store a **per-repo SHA map**
`{ "<repo-name>": "<sha>" }` instead of a single SHA. Each fire, compute HEAD for
**every** repo in `repos[]`:
- **A new SHA = ANY watched repo moved** since its recorded SHA. Run the diff-focus
  (`git -C <repo> log <lastSha>..HEAD`, `git -C <repo> diff --stat`) **per moved
  repo**, and **reset the review lenses** (PM) / focus the sweep (QA) if **any** repo
  moved.
- Record the per-repo SHA you actually reviewed (not end-of-run HEAD), per repo.
- A repo with **no commits yet** (no HEAD) is tolerated — treat it as "no commits yet"
  (greenfield, see the init SKILL), not an error.

Reflect's Job 1 iterates `repos[]` (the union of HEADs / commit logs). §8 dedupe-
against-reality scans **all** repos, not just `repoPath`. Single-repo: the map has one
entry; behavior is identical to today's single SHA.

### Orphan reclaim is per target repo
Dev Step 0 and Sweep Job 2 grep for a shipped artifact on the **target repo's**
resolved `defaultBranch` (the repo named by the ticket's `repo:<name>` label). If the
target repo is **unresolvable** (no/contradictory label, so no tree to grep), be
conservative: Dev **leaves** the ticket (it is then picked up as a missing-target
block, above) and Sweep **flags** it for the operator — **never reclaim** against a
guessed tree.

### Cross-repo work
- **PM splits at filing.** Work that spans repos is filed by PM as **per-repo
  children** (each a single `repo:<name>` target), `relatedTo` each other, so Dev
  rarely has to split across repos.
- **When Dev must split across repos** (Step 4), the mandatory split rule extends: the
  handoff must cite the **new ticket ID** AND set its **`repo:<name>`** target.
- **Inheritance.** §15 `[coverage]` follow-ups and **all** Dev-filed tickets inherit
  the **parent's** `repo:<name>` target.
- **Dedupe.** §8 must NOT collapse the per-repo children of one feature as duplicates —
  the same title across different `repo:<name>` targets is *not* a duplicate.

### Known state limitations (be honest)
The loop coordinates only through ticket state; it has **no cross-repo deploy barrier**
("wait until all contributing repos have landed before deploying"). A multi-repo
deploy is therefore only safe when each repo is **independently deployable** (per-repo
deploy) OR the product deploy is **idempotent and re-runnable** (re-running as each
repo lands converges). Don't assume an atomic multi-repo release.

`testEnv` / `baseUrl` is currently **one per product**, not per repo: QA verifies
against a single product surface, which can't directly address an API-only or library
repo that has no URL. Treat this as a known gap (a per-repo `testEnv` may be added
later); for now QA exercises the product surface and notes any repo with no testable
surface of its own.
