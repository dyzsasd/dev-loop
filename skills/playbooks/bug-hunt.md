---
slug: SH-bug-hunt
kind: judgment-scaffold
pulls: references/conventions/verification.md (evidence / result vocab), references/ticket-templates.md (the Bug body), references/conventions/labels.md (edge-case/sensitive/sub-type), references/conventions/multi-repo.md (repo target), references/conventions/two-tier-dev.md (§21b tier)
---

# SH-bug-hunt — the QA bug-discovery scaffold (conventions §8, §5a, §4, §19)

Shared by QA's `bughunt` job. Finding a real, user-visible defect is JUDGMENT — this playbook fixes the
ENVELOPE (what to probe, how to dedupe, how to file, the result vocabulary, the cap) and FRAMES the
decision. It is deliberately NOT a rigid checklist that replaces thinking: the classes below are a prompt
for where defects hide, not a script to tick end to end.

## Preconditions — pick targets from evidence, not vibes
Recent `Done` / `In Review` tickets + recent commits across every repo in `repos[]` (§19) say what changed
and therefore what is at risk. A HEAD that moved focuses the sweep on the diff; an idle fire audits a
not-yet-swept surface (the SKILL span's change-gate decides which). Greenfield (no commits / no
`testEnv.baseUrl`) ⇒ no testable surface — no-op, don't invent tests.

## The envelope (fixed)
**Happy paths** — walk the core flows end to end per persona (`testEnv.notes` lists them; a persona-less
product ⇒ every public entry point) — the things that MUST work.

**Edge-case classes** (a prompt, not a rota — tag survivors `edge-case`):
- Input: empty / huge / malformed / unicode; boundary values; double-submit (idempotency).
- Authz / IDOR: cross-role access per endpoint (a query filtered by an `undefined` owner id often means NO
  filter); another owner's id ⇒ denied; a non-existent id ⇒ NOT_FOUND, not 500.
- Leaks: protected-but-unguarded listings (diff authed vs public output — a missing `isTest` / visibility
  filter is a real leak); test / private data on a public surface.
- XSS sinks: `dangerouslySetInnerHTML`, `JSON.stringify` into `<script>`, unescaped user fields — stored
  XSS. Demonstrate SAFELY; never a live payload on shared prod.
- Pagination / limits, concurrent actions, network errors, mobile viewport.

**Dedupe set (§8) — FIRST, before filing.** Against open tickets AND against reality (the current
product / code, not a stale doc). A substantively equivalent ticket in any non-terminal state ⇒ comment /
bump, don't re-file. Already-shipped work is a report line, never a ticket.

**Filing shape (survivors only).** File each via SH-file-ticket with a real, minimal, COLD repro; labels
`dev-loop`+`Bug`+`qa` (+`edge-case`; +`sensitive` for auth / money / PII / secrets / migration defects,
§4 — it forces the senior tier, §21b); priority by severity (1 = Urgent for broken core flows / data
leaks); `state:"Backlog"` (§5a — PM grooms + promotes; a verify-fail follow-up is the `Todo` carve-out,
not this); one `repo:<name>` mapping the broken surface (a bug spanning repos ⇒ per-repo children,
`relatedTo`; undeterminable ⇒ file anyway + note it). §16: no real user data / secrets — summarize around
PII.

**Result vocabulary — file every non-pass.** `fail` (a real defect that reproduces) ⇒ `Bug`; `drift`
(passes but a human should see it — deprecation, visual / schema drift, missing empty / error / loading
states, slow-but-passing) ⇒ `Improvement`+`qa` (NOT a Bug), Low / Medium; `inconclusive` (couldn't
observe) ⇒ treat as drift + note the reason, never a clean pass. Severity is label + priority, not whether
a ticket exists.

**Cap:** ≤ 8 new tickets / run, severity first. A clean run is a valid outcome — never pad.

## The judgment step (framed, not scripted)
You decide WHAT to probe and whether a finding is real. *Good* = a genuine user-visible defect with a
minimal cold repro Dev can reproduce without you. *Avoid* re-filing known / dupe bugs, inventing marginal
tickets to hit a number, and live payloads / destructive checks on shared prod (prefer throwaway accounts;
clean up any state you create). A missing capability is PM's `Feature`, not your `Bug`.

## Exit criteria
Survivors filed to `Backlog` (≤ cap), each with a cold repro + the full label set + a repo target; every
non-pass captured (`Bug` / `Improvement` / a noted inconclusive). Filing zero is valid — report the
surface you swept.

## When blocked
No reproducible repro ⇒ no `Bug` (note it, carry it). Env down / un-probeable ⇒ inconclusive, no-op,
retry next fire. A guard's refusal (recoverability / destructive / merge guard) is the FINDING, never an
obstacle — never add `--force` or a bypass token, ESPECIALLY when the refusal is the behaviour under test.
