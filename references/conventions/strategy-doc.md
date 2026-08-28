# PM knowledge base — the doc-base field set and write policy — conventions §20 pointer file

> Moved out of `references/conventions.md` §20 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §20's contract: read it at the trigger moment the §20 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

### The field set (defined once — identical names in init and PM)
The doc-base has these EXACT sections (verbatim headings):
- **Vision** — the one-paragraph north star: what the product is and for whom.
- **Goals (north star)** — the durable outcomes to pursue.
- **Non-goals** — explicitly out of scope, so the loop doesn't drift into them.
- **Current state** — what's actually built/shipped right now (the living "as-is";
  seeded once by init from brownfield mapping, then owned by PM).
- **Personas** — the user types the product serves (also QA's persona list).
- **Glossary** — domain terms with definitions, so all agents share vocabulary.
- **Decisions (running log)** — a dated, append-only log of product-direction /
  scoping calls and their rationale.
- **Candidate ideas** — the overflow parking lot (PM guardrails): strong ideas not yet
  filed, persisted so they aren't lost and get filed as the backlog drains.

init Step 4 scaffolds these exact headings; the greenfield interview fills them;
brownfield mapping seeds **Current state**. PM maintains them thereafter. The names are
identical across §20 / init / PM so no agent invents a variant.

**Ledger rollup (R2 — keep the PM-ingested doc bounded).** PM re-reads this whole doc-base
every fire, so an unbounded `Decisions (running log)` is a per-fire token tax. When the doc
grows past ~20KB, or a milestone reaches verified-Done, PM **archives the completed/superseded
decisions** for that period into `docs/strategy-archive/YYYY-MM.md` (repo-file backends) or a
sibling archive doc (hub backend), leaving in the live log a **one-line index entry** per
archived period that points at the archive. Vision / Goals / Non-goals / Personas stay in the
live doc; only the historical decision *detail* rolls out. The archive is provenance, never
re-ingested per fire. (This doc's own 2026-06 milestone was rolled to `docs/strategy-archive/2026-06.md`.)

In the **doc-home repo** (§19). A single flat file containing the §20 field-set headings IS the
doc-base; a larger product may split it into a doc set under the same path.

`strategyDoc` may be a **Linear document**, a **hub document**, *or* a **repo file**.
Detect the form ONCE per fire (precedence in this order) and use it consistently for
both reading and updating:
- **Linear document** — `strategyDoc` is an object `{ "linearDocument": "<id|slug|url>" }`,
  or a string containing `linear.app/.../document/`. Read with `get_document`; update with
  `save_document`. No git/file access. (Requires a Linear-connected backend, §18.)
- **Hub document** (`backend:"service"` only, §18) — `strategyDoc` is `{ "hubDoc": "<kind>" }`
  (e.g. `{ "hubDoc": "strategy" }`), or `hub.docs:true`. Read with `doc.get({ kind })` — an
  `unpublished:true` result means **no version has ever been published**, so `doc.get`
  returned the latest DRAFT (the only content there is): treat it as the working
  north-star but say so; once a published version exists, `doc.get` returns it by default
  (§18). Agents write **DRAFTs only** via `doc.save` (mandatory
  `baseVersion`; the operator alone publishes via `doc.publish`); on a CONFLICT recover per
  the §18 CAS rule (`doc.get {version:"latest"}` → re-apply → re-save with
  `baseVersion:latestVersion` — the CAS keys on the latest draft, not the published version).
- **Repo file** — a `{ "path": "<repo-relative>" }` object (the usual config form,
  `config-schema.md`) or any other plain string: a path relative to the doc-home repo
  (§19). Read/edit and (in `live`) commit, honoring the D4 section-level
  write policy (§20). **Remains the default under `service`** unless `hub.docs`/`{hubDoc}` is set.

### init ↔ PM handoff (no double-write)
- **init seeds `Current state` exactly once, if absent** (from brownfield mapping,
  operator-confirmed) and scaffolds the empty headings. It never rewrites existing
  content.
- **PM owns the doc-base thereafter.** Augmenting `Current state` is **append-only of
  the missing section**, never a rewrite of existing content. PM records shipped
  progress in `Current state`, appends product-direction/scoping calls to the
  `Decisions (running log)`, and keeps `Personas`/`Glossary` accurate as features ship
  (PM Job C step 5). So init never overwrites PM, and PM never re-seeds what init
  already wrote.

### Section-level write policy on repo-file backends (D4)

Where the strategy doc is a **repo file** there is no publish gate — PM's commit IS the
landing — so PM's write policy splits **by section**:

- **Progress sections — autonomous.** `Current state` (shipped markers/✅), `Decisions
  (running log)` appends, `Candidate ideas`, and `Personas`/`Glossary` upkeep: PM commits
  these directly (pm-agent Job C step 5). Recording reality is not a direction change.
  **Under `landing:"pr"` the commit is not the landing** — every dev worktree branches off
  `origin/<defaultBranch>`, so an unpushed doc commit is invisible to the whole team. PM lands
  it with **`dev-loop doc-land`** (fetch → rebase-if-diverged → `push-guard` → ff-only push;
  a block exits non-zero and is reported, never forced). The verb asserts the pushed range
  touches **only** the strategy doc + its archive — this is a docs path, never a licence to
  push code, and DIRECTION sections still route via §9a regardless. Senior's repo-file design
  docs (`docs/design/<slug>.md` on `linear`) land the same way; on `service` they are
  hub `design` docs and never touch git.
- **Direction sections — propose first.** `Vision`, `Goals (north star)`, `Non-goals` —
  plus any `Appetite` / `No-gos` headings a doc carries: changing WHAT the product pursues
  requires the §9a **investigation protocol** (findings + the unified diff on a
  `needs-pm`+`investigation` ticket → operator approval → only then the commit).
  **Hub-doc backends share the SAME split, enforced in
  `docPublish` itself:** after a progress-only save, PM publishes the draft in the same fire
  (`dev-loop doc publish --slug <strategy-slug>` — version defaults to the latest draft), so
  consumers never read a stale published north star while drafts pile up. A FIRST publish,
  any direction-section change, an UNKNOWN heading, or a preamble change is refused with the
  section names — those keep the §9a operator route; the refusal itself is the signal to file
  the investigation ticket.

**Sweep is the backstop (report-only):** each fire it audits recent doc-only commits
touching the strategy doc; a diff that changes a direction section with no linked approval
ticket is flagged in the board-health digest for the operator (never reverted — Sweep
doesn't mutate content).
