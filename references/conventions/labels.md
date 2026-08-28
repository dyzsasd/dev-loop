# Label taxonomy — sub-type and dev-tier detail — conventions §4 pointer file

> Moved out of `references/conventions.md` §4 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §4's contract: read it at the trigger moment the §4 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

- `signal` — a ticket originating from external real-user signal. On a `Bug` (`qa`) for
  a user-reported defect, or a `Feature` (`pm`) for a request. Applied by whichever agent
  files the ticket from an operator-relayed user report (typically PM for requests — its
  strategy-doc/channel intake — and QA for defects); no agent watches external channels
  for these directly. References the source and never pastes PII (§16).

- `investigation` — a §9a direction intake that must ride the **propose → operator
  approves** loop (the investigation protocol, §9a): PM investigates, posts findings +
  a doc-change proposal on the ticket, and the OPERATOR approves before the doc
  changes. Applied ALONGSIDE `needs-pm` on the intake, by the filer — the director
  (web form / CLI / Linear), the §18 mirror-comment poller, or PM itself when a §20
  direction-section edit needs sign-off (D4).
- `sensitive` — the work touches {authn/authz/permissions, payment or money movement,
  PII storage/handling, secrets/credentials, data migration/backfill/deletion}. Set by the
  FILER at creation (same actor that sets the dev tier, §21b) and never removed by hygiene.
  Routing consequence (§21b): `sensitive` ⇒ senior-dev, always — design before code.
- `external-code` / `external-access` — the two **kinds** of external prerequisite
  (§9c), applied ALONGSIDE the `external-prereq` workflow label on the parked ticket
  and its tracker: `external-code` = another repo/team must change code (actionable
  inside the team → file the ask as a real ticket and block on it); `external-access`
  = credentials / billing / legal / permission only a human can grant (→ human-park
  the tracker + notify). The kind decides routing; without it every external park
  degrades to "wait for a human to read comments".

**Dev-tier routing (optional; a *split-dev* project only — §21a):**
- `senior-dev` — the **senior-dev** agent (opus/max) implements it: a design / new-module /
  new-feature ticket (design-and-delegate mode), or an escalation follow-up (direct-code mode).
- `junior-dev` — the **junior-dev** agent (sonnet/high) implements it: an improvement / bug-fix,
  or a child ticket promoted from a verified design.

These are **dev-routing** labels, **NOT** verification-owner labels: the verifier is still PM
(`pm`) or QA (`qa`); the dev-tier label only names *which dev writes the code* (§21a). They are
**orthogonal** to the `pm`/`qa` owner label — a split-dev ticket carries **both** (the verifier
label AND the dev-tier label). They exist **only** in a project that runs the two-tier dev model
(§21a / launcher panes); a **legacy single-dev project carries neither** — the sole `dev` agent
picks the whole §5 queue, exactly as today. On the `service` backend the dev tier may instead ride
the ticket's `assignee` field (the actor `senior-dev`/`junior-dev`); the label is the carrier on
`linear`, where the shared identity / a per-fire claim token can't distinguish the tier
(§18, per-backend encoding). The labels are provisioned on **all** backends so one code path serves
both (harmless extra labels on `service`).

- `incident` — a RUNNING-prod degradation Ops confirmed (anti-flap) and filed. On a
  `Bug`; owned by `qa`; Urgent when prod is down / a core flow is broken. Filed/refreshed
  by Ops (§21).
- `tech-debt` — a whole-codebase technical-health finding (refactor / hardening /
  dep-bump / CVE). On an `Improvement`; owned by **`qa`** (refactor safety = tests-green
  / behavior-unchanged is QA-verifiable, §21). Filed by Architect (§21).

- `coverage` — a follow-up to add a regression test/flow for a shipped
  `Bug`/`Feature` that couldn't be covered in the fix itself (§15). Filed by Dev,
  owned by `qa` (QA verifies the test exists and passes); implemented like any
  other `Todo` ticket.

**Ownership / routing (every ticket carries exactly one owner label):**
- `pm` — PM owns it (PM verifies). On every `Feature`, and on `Improvement`s by
  default.
- `qa` — QA owns it (QA verifies). On every `Bug`, and on QA-filed `Improvement`s.

Every ticket **must** have an owner label, or it strands at `In Review` with
nobody to verify it. PM verifies In Review tickets tagged `pm` (Features +
Improvements); QA verifies those tagged `qa` (Bugs + Improvements).

**Workflow signalling:**
- `blocked` — Dev couldn't proceed; needs owner attention (§9).
- `external-prereq` — the park marker for a ticket waiting on something OUTSIDE the
  loop; always paired with a kind sub-label (`external-code`/`external-access`) and,
  from §9c, a TRACKER ticket the parked work is blocked by.
- `needs-pm` / `needs-qa` — routes a blocked ticket to the right owner.
- `notified` — set by PM after it has announced a human-parked ticket to the operator's
  out-of-band channel (§9 notify), so it is announced exactly once. Dropped when the ticket
  is unparked. Only meaningful when an outward channel is configured — on 1.0 that is **`team.comms`** (canonical; the runtime bridges it to the per-project `notify` view the daemon reads); harmless otherwise.

`Bug`, `Feature`, `Improvement` already exist in the workspace. The rest are
created once at setup (§13; including `incident`/`tech-debt`/`signal`, §21, and
`senior-dev`/`junior-dev` for a split-dev project, §21a).
Priority/urgency is **not** a label — it is Linear's native `priority` field (§5).
