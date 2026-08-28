---
slug: SH-file-ticket
kind: mechanical
pulls: references/ticket-templates.md (the §6 template body), references/conventions/labels.md (sub-type/tier labels), references/conventions/two-tier-dev.md (§21b tier routing), references/conventions/multi-repo.md (repo target)
---

# SH-file-ticket — file one well-scoped ticket (conventions §6, §5a, §4, §21b, §19)

Shared by every filer (PM Job B2/C, QA, the follow-up in SH-verify-close). A ticket must carry enough for
Dev to act without guessing — otherwise Dev will (correctly) block it.

## Preconditions — dedupe FIRST (§8)
1. Search `project` + `label:"dev-loop"` with the key nouns/verbs. A substantively equivalent ticket in any
   non-terminal state ⇒ do NOT create — comment the new observation, or bump priority.
2. **Dedupe against reality, not just tickets.** Confirm the gap/bug still exists in the CURRENT
   product/codebase, not merely in a stale doc. Already-shipped work is a report line, never a ticket.
   Multi-repo: scan ALL of `repos[]`; but per-repo children of one cross-repo feature are NOT duplicates.

## Steps
3. **Body** — copy the matching verbatim template from `references/ticket-templates.md` (Feature / Bug) and
   fill it: crisp imperative title (`Add …`, `Fix …`), real observable + testable ACs.
4. **Labels (§4, exactly-one where noted):** `dev-loop` (marker) + the type (`Feature`→pm / `Bug`→qa /
   `Improvement`→pm-or-qa) + the owner label. Add `sensitive` HERE for auth/money/PII/secrets/migration work
   (it forces the senior tier). Sub-type as apt (`edge-case`, `incident`, `tech-debt`, `coverage`,
   `signal`, `investigation`). Pull `references/conventions/labels.md`.
5. **State (§5a):** `state:"Backlog"` — the universal intake funnel; PM's grooming pass promotes at pace.
   (§3 carve-outs — verify-fail follow-up, un-block, confirmed incident — file straight to `Todo`.)
6. **Priority:** Linear's native `priority` (1 Urgent … 4 Low, 0 None).
7. **Dev tier (split-dev, §21b) — explicit signals only, never inference:** `sensitive` ⇒ senior ALWAYS;
   new module / new feature ⇒ senior (design-and-delegate); improvement / bug-fix ⇒ junior; BORDERLINE ⇒
   junior. Name the tier (assignee on service, the label on linear). A legacy project adds no tier marker.
   Pull `references/conventions/two-tier-dev.md`.
8. **Repo target (§19, multi-repo only):** exactly one `repo:<name>` label (required — a missing one strands
   / gets blocked). Split cross-repo work into per-repo children at filing (`relatedTo`).
9. **`project` set;** §16 obeyed (no secrets, summarize around PII, reference log/data sources).

## Exit criteria
The ticket exists in `Backlog` (or a §3 `Todo` carve-out), §6-conformant, with the full correct label set
and — where multi-repo — a repo target. Filing zero is a valid run: report the bottleneck, don't pad.

## When blocked
Cannot resolve an ambiguity into concrete testable ACs ⇒ do NOT file vague work; note it and carry it, or
(for intake) route via the §9a investigation flow. A no-code gap (business/partnership/infra) goes to the
user, not Dev.
