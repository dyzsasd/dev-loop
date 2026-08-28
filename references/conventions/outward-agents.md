# Outward-facing agents — Ops anti-flap, Communication drafts, sub-type recipes — conventions §21 pointer file

> Moved out of `references/conventions.md` §21 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §21's contract: read it at the trigger moment the §21 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

### Ops anti-flap + incident-dedup rule
Prod has transient blips, so Ops acts **only on a CONFIRMED, REPEATED degradation**:
on a failing probe it **re-checks** (≥2 spaced re-probes, not a single retry — a cold
start clears on the 2nd) and treats the degradation as real only when it fails every
re-probe AND (it was already failing last fire, or the surface is clearly down — a hard
5xx/connection-refused) — a probe that recovers on any re-probe is logged, **not filed**. On a real degradation it
files (or **refreshes** an existing open) a `Bug` + `qa` + **`incident`**, priority
**Urgent** when prod is down / a core flow is broken (so Dev's Urgent-bug-first pick,
§5, grabs it). It **dedupes against the one open incident** (`ops-state.json` + a
scoped `incident` query) — refresh it, **never** spam a new ticket per fire. Ops does
**not** auto-rollback (Dev owns Step-6.5) — it may NOTE a suspected bad deploy.
Multi-repo (§19): tie the incident to the likely repo (`repo:<name>`) when one
healthCheck identifies it, else leave it for triage — never guess a repo.

### Communication — public article drafts
The Communication agent is the team's PR/media drafting role. It reads the strategy doc,
the published roadmap when available, recent verified Done work, changelog/git facts, and
the public product surface, then writes at most one article **draft** per cadence
(`communication.cadence`, daily by default). Its output is either machine-local under
`${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/communications/YYYY-MM-DD.md` or, when
`communication.output:"repo"` is explicitly set, a Markdown draft under the doc-home repo's
`communication.repoOutputDir` (default `docs/communications/`). It never publishes to a CMS,
social channel, email list, or webhook; never commits/pushes/deploys; and never transitions or
verifies tickets.

Absent a `communication` config, scheduled Communication fires no-op unless the operator
explicitly invoked it to draft an article. `mode:"dry-run"` previews the angle, outline,
sources, and target path without writing. `includeUnreleased:false` is the default: articles
use only public-safe, shipped/verified facts. If the operator opts into upcoming roadmap
language, it must be clearly labelled as upcoming and sourced to a roadmap item.

### The new sub-type labels
These additive sub-type labels (§4) tag the outward agents' tickets so the right owner
verifies and so the board is filterable. Each carries its **verification recipe** — who
closes it and on what evidence (QA Job A cites these, it never re-derives them):
- **`incident`** — on Ops `Bug`s (owner `qa`). **Verification recipe:** an incident has
  NO repro to re-run — QA closes it by re-verifying the ticket's **health assertion**
  against running prod (the probe/route/error-rate the ticket names, observed green on a
  fresh check); inconclusive ≠ pass. Ops only *reports* recovery on the ticket — it
  never closes or transitions it (observe-and-file).
- **`tech-debt`** — on Architect `Improvement`s (owner **`qa`** — a refactor's safety is
  "build/tests green + the named debt gone + no behavior change", QA-verifiable, not a
  product-exercise; same qa-Improvement precedent as `coverage`, §15). **Verification
  recipe:** that triple — tests green + the NAMED debt observably gone + no behavior
  change — is exactly what QA closes it on.

They are provisioned once at setup alongside the other workflow labels (§13).
