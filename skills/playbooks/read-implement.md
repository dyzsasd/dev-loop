---
slug: SH-read-implement
kind: mechanical
pulls: references/conventions/two-tier-dev.md (the §21c Design pointer forms + escalation), references/conventions/multi-repo.md (doc-home repo §19)
---

# SH-read-implement — resolve the design, then ship to it (conventions §21c)

Junior-dev's implement wrapper: it resolves the linked design BEFORE any code, guards the sensitive
mis-route, then hands off to **SH-ship** (Steps 4→7) as the substrate. The design is the spec; the ACs are
this increment's contract.

## The sensitive override (senior tier, ALWAYS)
Before implementing: the `sensitive` label — or ACs plainly touching auth / money / PII / secrets / migration
— AND no senior-authored `Design:` pointer ⇒ do NOT implement. Block `decision-needed`: `sensitive work
mis-routed to junior — needs senior design first`. With a resolvable senior pointer it is implementable like
any designed child.

## Step 4a — Resolve the `Design:` pointer FIRST
Resolve the ticket's `Design:` pointer before writing code (the §21c three forms):
- `hubDoc:design/<slug>` ⇒ `doc.get` the hub design doc.
- `docs/design/<slug>.md` ⇒ the committed file in the doc-home repo (§19; pull `references/conventions/multi-repo.md`).
- `parent <id>` ⇒ the parent ticket IS the design.

Implement to the design + the ACs. A **conflict between the design and the ACs** is a real ambiguity ⇒ block
`decision-needed`. A **present-but-broken pointer** (absent hub doc, missing file, unreadable parent) ⇒ block
`info-needed`, comment which pointer is broken, never guess the design (§21c). An improvement / bug-fix routed
straight to you may legitimately carry NO pointer — its design lives in its own ACs; block only a broken
pointer or under-specified ACs.

## Step 4b→7 — Execute SH-ship
Run **SH-ship** (Steps 4–6.5 + 7) as written — implement (the smallest change, §15 coverage, the split rule,
the image-asset option §24, the dormant-behind-a-flag rule), the build/test gate, the self-review, ship per
config, post-deploy smoke + rollback, and the hand-off. Junior riders on that sequence:
- **Worktree isolation is ALWAYS on for you (§7)** — you are one of two concurrent writers: every ticket's
  work happens in its per-ticket worktree regardless of `git.landing`; in `landing:"direct"` land via the §7
  merge-back, never a commit in the shared checkout.
- **No design children:** you implement the one increment your ticket scopes; any split follow-up you file is
  a same-tier `junior-dev` ticket inheriting the parent's `repo:<name>` target.
- **Self-review against the design too** (SH-ship Step 5.5): read your diff against the ACs AND the design
  from Step 4a — the diff, never memory.
- **The hand-off names the verifier and the design** (SH-ship Step 7): route to the verification owner (`pm`
  for Feature/Improvement, `qa` for Bug — the owner label; your tier marker is orthogonal routing) and cite
  the `Design:` pointer you implemented against, alongside Step 7's required content (the split follow-up ID,
  the §15 coverage outcome).
- **Wall-clock budget — two arms (§9 when not converging):** budget the fire's wall clock (`fireTimeout` is
  1h). SH-ship's throttle covers only the *converging-but-out-of-time* arm (commit the green slice, hand off,
  note the remainder). The other arm: if the implementation is **not converging by ~40min**, stop coding —
  **commit WIP to the ticket branch**, write a progress comment **naming the exact blocker**, and **block per
  §9** (the `Bail-shape:` first line) or hand off. A fire that dies at the 1h timeout ships nothing and
  reports nothing; a bounded partial with a named blocker is strictly better.

## Escalation (you don't drive it — know it)
If your code fails verification on a REAL AC failure, the VERIFIER cancels your ticket (`review failed:` /
`re-test failed:`; superseded-by grammar) and files the senior-dev direct-code follow-up ITSELF (§3);
transient / flaky / infra errors are not fails — you simply retry. Never re-pick a `Canceled` ticket; never
file the senior follow-up yourself.

## Exit criteria
The design was resolved (or a broken pointer / conflict blocked), the increment shipped through SH-ship to
`In Review` naming the verifier + the design, or a clean block was filed. Sensitive-without-a-design never
reaches code.

## When blocked
A broken/absent pointer ⇒ `info-needed`; a design↔AC conflict or a real design decision ⇒ `decision-needed` /
`scope-design` to PM for re-route to the design tier. You implement; you never design your way out.
