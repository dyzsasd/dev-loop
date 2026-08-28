# Verification — auth-constrained surfaces & the Human-Blocked state — conventions §3 pointer file

> Moved out of `references/conventions.md` §3 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §3's contract: read it at the trigger moment the §3 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

**Auth-constrained surfaces — the degraded-verify path (`testEnv.authConstraint`, all
verification owners).** When the increment lives behind a login a headless fire cannot
perform (e.g. a WorkOS-gated page — no real logged-in browser), do NOT false-fail it and
do NOT mark it Done off the diff alone. Verify by the strongest evidence you *can* get:
(a) read the shipped diff against the ACs (spec-compliance review); (b) confirm build/CI
is green for that change; (c) exercise any **open** endpoint the feature exposes
(health/status/public API); (d) confirm the change is actually **deployed** (the env's
version/build marker moved to include it, not just merged — §12b). If all of that holds,
close `Done` with a comment saying **exactly** what you could and couldn't exercise
("verified via diff + green CI + `/api/status` at v0.X.Y; the authed UI itself was not
browser-exercised — authConstraint"). If it can't be confirmed even that far, leave it
`In Review` (inconclusive ≠ pass) and note that the authed check needs the operator's
attended path (a real browser session). Record the constraint as a lessons.md rule (§14)
so it isn't re-litigated every fire.

**Split-dev escalation rides this same rule, routed to senior-dev (§21a).** In a two-tier
project (§21a), when a **junior-dev**-built ticket fails verification on a **real** acceptance-
criteria failure (NOT a transient/flaky/infra error — junior simply retries those), the follow-up
is routed **up** to senior-dev: the **verifier** `Canceled`s the junior ticket as above and files the
follow-up as a **senior-dev direct-code** ticket (assigned to `senior-dev`, `relatedTo` the failed
one) — PM for the Features/Improvements it verifies, QA for the Bugs it verifies (§21a). If the senior **direct-code** follow-up *also* fails verify, the loop has exhausted its
automated tiers ⇒ `Bail-shape: fix-exhausted` ⇒ **`Human-Blocked`** (operator). The design-gate
form of this rule (verifying a design *parent*, promoting its staged children) is in §21a.

**`Human-Blocked` (service backend)** is the real-state form of the §9 human-park.
When PM cannot resolve a block (it needs a genuine human decision / credential / legal
sign-off), on `service` it moves the ticket to **`Human-Blocked`** instead of the
`blocked` + `needs-pm` + `external-prereq` label park. The persistent daemon detects the
state structurally and periodically pings the configured Slack/Lark channel until it's
resolved (cadence = `settings_json.humanBlockedReminderHours` — **default 24h once a
comms channel is configured** (`team.comms` present — it is what makes the reminder
deliverable); an explicit `0` is the opt-out; with no comms channel the default remains
off. Migration note: the daemon reads the cadence and the comms presence at **boot**, so a
running daemon adopts the new default on restart only — `dev-loop hub stop && dev-loop hub
ensure`; see `references/config-schema.md` "Hub daemon notifier settings" and
`docs/DAEMON.md` "Background notifiers"). The
operator (or PM, once unblocked out-of-band) moves it back to **`Todo`**. Dev never
picks it up (it isn't `Todo`). On `linear` (no daemon; adding a state is costly)
the label-based park (§9) remains; `blockedStateName` config names the real state where
a backend has one.

**Verify-fail ⇒ close + follow-up** (the universal rule, conventions §3). When an owner
verifies an `In Review` ticket and it does **not** meet acceptance criteria: **close the
original** as `Canceled` with a comment `review failed: <what failed / observed behaviour>;
superseded by <new-id>`, and **create a follow-up** ticket carrying the remaining work
(`Feature`/`Improvement` for PM, `Bug` + `qa` for QA; `state:"Todo"`, `relatedTo` the
original). Each ticket is thus exactly **one verified increment**, and a failed one is
**superseded, never silently reopened** — so the history shows what shipped-but-failed vs
what's now queued. If the follow-up needs a human decision, park it (`Human-Blocked` on
`service`, §9). Never leave the original in `In Review`.

**The shared verification standard (all owners, all layers).** Every verification —
Dev's own Step 5.5 pass AND the owner's In Review check — classifies deltas against the
ticket's spec with the same three classes: **MISSING** (the spec asked for it; the
diff/behavior lacks it), **EXTRA** (the diff contains it; no AC asked for it — scope
creep), **MISUNDERSTANDING** (the wrong thing was built). **Any hit = verify-fail, even
when the code is clean.** And: the ticket/PR/handoff description is the implementer's
SELF-CLAIM — use it to *locate* the change (commit, PR, routes, design pointer), never as
*evidence*; every verdict input is the actual diff or the behavior you observed. Dev's
Step 5.5 is the implementer's own gate; the owner's Stage-1 triage at In Review is the
INDEPENDENT re-check of the same three classes — both run, always; the second exists
precisely because the first is a self-claim.
