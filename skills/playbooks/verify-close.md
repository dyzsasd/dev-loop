---
slug: SH-verify-close
kind: mechanical
pulls: references/conventions/verification.md (auth-constrained / degraded verify), references/conventions/two-tier-dev.md (split-dev escalation), references/ticket-templates.md (the follow-up body)
---

# SH-verify-close — verify an In Review ticket → Done, or close + follow-up (conventions §3, §21a)

Shared by the owners (PM Job A / QA). The constitution states the universal rule; this is the procedure.
One verified increment per ticket — never leave a failed increment In Review, never silently reopen.

## Preconditions
- The ticket is `dev-loop` + your owner label + `In Review`, and you own its type (§4).
- You have exercised it against the running product / the diff — never the hand-off claim (constitution:
  State machine). An `investigation` ticket In Review awaits the OPERATOR, not you — check for their verdict,
  never verify-fail it.

## Steps
1. **Claim** with a comment (§7) so a second verifier sees it in progress (fold into the verdict comment for
   an instantaneous re-test).
2. **Exercise the ACs** against the test env (web ⇒ `testEnv.baseUrl`; non-web ⇒ `testEnv.testCommand` /
   `.notes`), checking every AC box that passes. An `AC-exec:` probe is authoritative: exit 0 passes,
   nonzero fails.
3. **Spec triage BEFORE any quality judgement.** Fetch the shipped diff and classify every delta MISSING /
   EXTRA (scope creep) / MISUNDERSTANDING — ANY hit ⇒ verify-fail even if the exercised ACs pass.
4. **Verdict.**
   - **Pass** (ACs + triage clean) ⇒ `Done`, summarizing what you confirmed (full label set + verify
     `.state`, constitution: Write hazards).
   - **Fail** ⇒ close + follow-up: `Canceled` with `review failed: <what failed / observed>; superseded by
     <new-id>`, THEN file the follow-up via SH-file-ticket (`state:"Todo"`, `relatedTo` the original;
     `Feature`/`Improvement` for PM, `Bug`+`qa` for QA). A follow-up needing a human decision is parked via
     SH-block-park.
5. **Auth-constrained surface** (`testEnv.authConstraint`, a login a headless fire can't drive): do NOT
   false-fail and do NOT close off the diff alone — verify by the strongest evidence (diff vs ACs, green CI,
   open endpoints, the env's build marker moved) and close `Done` stating exactly what was and wasn't
   exercised; if not even that, leave In Review (inconclusive ≠ pass) noting the attended path. Record the
   constraint as a §14 lesson. Pull `references/conventions/verification.md`.

## Split-dev escalation (§21a)
A **junior-dev**-built ticket's FIRST real AC failure (NOT a transient/flaky/infra error — junior just
retries those) is `Canceled` by you and the follow-up routes UP to **senior-dev direct-code**
(`Mode: direct-code`, tier encoded per backend §18, `relatedTo`). A senior direct-code that also fails ⇒
`fix-exhausted` ⇒ the human park (SH-block-park). Pull `references/conventions/two-tier-dev.md`.

## Design gate (split-dev, §21a)
Verifying a design PARENT In Review: confirm the design is coherent, cites its strategy/roadmap item, and
the staged children faithfully decompose it. Pass ⇒ promote every staged child `Backlog → Todo` FIRST, THEN
move the parent `Done` (the crash-safe order); a big-module design first parks `Human-Blocked` for the
operator's sign-off (SH-block-park). Fail ⇒ close + follow-up, and `Cancel` the staged children with the
parent — never strand them in Backlog.

## Exit criteria
The ticket is `Done` (verified) or `Canceled` with a filed, linked follow-up. Nothing left In Review.

## When blocked
Cannot exercise the product at all (env down, missing capability) ⇒ leave In Review, comment the wait-state
once (a wait is not a fail), and record it — do not guess a verdict.
