---
slug: OP-poll
kind: judgment-scaffold
pulls: skills/playbooks/file-ticket.md (the §6 incident Bug), references/conventions/blocked-protocol.md (an un-routable outage park, §9), references/notify.md (the §21 alert/recovery push)
---

# OP-poll — poll prod health & run the incident (Ops's one job)

Ops's single job, the executable expansion of the `job:poll` span. You watch RUNNING production over
time and, only on a CONFIRMED repeated degradation, file (or refresh) ONE incident Bug so Dev's
Urgent-bug-first pick order grabs it. "Is this a real incident?" is the JUDGMENT — this playbook fixes
the ENVELOPE (the probe set, the anti-flap rule, dedupe, the alert, recovery) and FRAMES that call; it
does not turn a one-second blip into a script that files. §21 observe-and-file: never implement, ship,
verify, or auto-rollback (Dev owns the fix + Step-6.5 rollback), though you may NOTE a suspected bad
deploy. Coordinate purely through ticket state.

## Preconditions
- Read-only on prod: health URLs + the read-only `logsCommand` only, never a mutating command. Access
  broader than read discovered by a probe is a §16 stop-and-surface fact.
- `ops-state.json` in the project state dir is your ONLY cross-fire carrier (§21): open incidents
  (ticket id + failing checks + first-seen + `notifiedAt`) and the last-check probe record. Create it
  lazily as `{ "openIncidents": [], "lastCheck": null }` if absent (first fire).

## Steps

1. **Poll prod health (read-only).** Probe running production — all outward:
   - *Health checks* — the resolved deploy healthCheck(s) per repo in `repos[]` (§19; a repo whose
     resolved deploy is empty has none — skip). `deploy.style:"command"`/absent ⇒ the single
     `deploy.healthCheck`; `"release-pr"` (§12c) ⇒ each `deploy.environments[].healthCheck` for the
     envs you watch (the `auto:true` env(s) + prod), skipping envs without one. A URL must return 2xx;
     a command must exit 0.
   - *App surface* — the `testEnv.baseUrl` root: expect non-5xx.
   - *Critical routes* (optional) — each `ops.criticalRoutes` entry (a path/URL expecting 2xx, or `{
     url, expectStatus }`): the core user flows the operator declared can't be down.
   - *Custom checks* (optional) — each `ops.checks` entry (a URL, or a command that must exit 0).
   - *Logs/metrics* (optional) — `ops.logsCommand`, read-only, for an error-rate / 5xx-spike signal;
     absent ⇒ skip silently.
   Always record this fire's probe outcomes + timestamp to `ops-state.json` for the next fire's
   cross-fire test.

2. **The anti-flap rule (§21) — the judgment gate.** A degradation is real ONLY when CONFIRMED: it
   fails **≥2 spaced re-probes this fire** (not a single retry; a cold start clears on the 2nd) AND
   either it was already failing at the previous fire's recorded check (cross-fire — the strongest
   signal) OR the surface is clearly down on every re-probe (a hard 5xx / connection-refused, not a
   slow-but-200). A probe that passes ANY re-probe is a transient blip — log it in the report, never
   file. *Under-reacting to a one-second blip is correct; a spurious Urgent yanks Dev off real work.*

3. **File or refresh the incident** (only on a Step-2 confirmed degradation; dedupe hard):
   - **Dedupe first** (§21/§8): check `ops-state.json` AND a scoped open-`incident` query (§10). One
     exists ⇒ **REFRESH** it — a dated still-degraded comment (which probes fail, current
     error-signal), bump to Urgent if it escalated to down/core-flow-broken; never a second ticket. A
     label re-pass in a split-dev project keeps/adds the `senior-dev` tier marker (§10/§21b).
   - Otherwise **file ONE incident Bug** via SH-file-ticket: `dev-loop` + `Bug` + `qa` + `incident`, in
     **`Todo`** — the §5a carve-out (a CONFIRMED prod degradation is the one discovery that skips
     Backlog). Priority **Urgent** when prod is down / a core flow is broken (Dev's rank-1 pick); High
     for degraded-but-up. Title `Fix prod incident: <surface> returning <symptom>`; body: the failing
     probe(s), observed vs expected status/exit, the failing window, any `logsCommand` signal
     **summarized around** secrets/PII (§16 — reference the log source, never paste raw user data). The
     acceptance criterion is the **health assertion** QA re-checks (e.g. "`GET <route>` returns 2xx",
     "5xx rate back under <baseline>") — never "repro no longer reproduces"; an incident has no repro.
     **Tier at filing (§21b):** split-dev ⇒ senior-dev direct-code (a `Mode: direct-code` body line +
     the tier encoded per §18); legacy ⇒ no tier marker.
   - **Repo target** (§19): exactly one repo's healthCheck failing ⇒ set its `repo:<name>`; a shared
     surface (`baseUrl`/shared route) ⇒ leave it off and say so in the body — never guess a repo.
     Single-repo: no `repo:*`.

4. **Alert — once per incident.** After filing (or on the FIRST refresh of) a confirmed incident, push
   `dev-loop notify --level error --title "INCIDENT <project>" "<id>: <surface> <symptom> since
   <first-seen>; priority <P>"`; record `notifiedAt` in `ops-state.json` so refreshes don't re-ping;
   re-notify only on an escalation to Urgent (prod fully down). Unconfigured comms ⇒ state that as a
   fact (the daily digest is then the only channel) — never invent a webhook. A failed notify never
   fails the fire.

5. **You may NOTE a suspected bad deploy** — if the degradation began right after a recent
   deploy/commit (compare the failing-since time to the latest `git log` on the resolved
   `defaultBranch`), comment `Suspected trigger: deploy <sha> at <time>.` A note for Dev, never an
   action — you do not roll back (Dev's Step 6.5).

6. **Close the loop on recovery (report, don't verify).** For each `ops-state.json` incident whose
   failing probes now pass (and pass the re-check): add a dated comment `Prod recovered as of <time>;
   probes green again.`; if `notifiedAt` is set, close the bracket with `dev-loop notify --level info
   --title "RECOVERED <project>" "<id>: probes green again as of <time> (down <duration>)"` (an
   un-alerted blip stays silent); drop it from the open list. **Never mark the ticket Done or move its
   state** — verifying the fix is QA's (§3; the §21 recipe: QA confirms the health assertion holds).
   Already Done/Canceled ⇒ just drop it from state.

## Team scope (§27)
Under `DEVLOOP_TEAM_SCOPE=1` (cwd = workspace root) iterate the repo REGISTRY, not projects:
health-check each repo referenced by ≥1 **enabled** project ONCE (the registry dedups shared repos;
skip a repo whose only referrers are disabled), running each repo's `ops.checks` + environment health.
Route an alert to the repo's **owner** project (the `owner` field, or its sole referrer) — never
duplicated across referrers: on `linear` file directly in the owner project; on `service` file/refresh
via the D1 steward `project` override (§18), same file-or-refresh discipline. Reports go under
`${DEVLOOP_WORKSPACE}/.dev-loop/team/`.

## Exit criteria
Probes polled and recorded; a confirmed degradation filed/refreshed (or the transient blip logged, not
filed); recoveries closed; the `ops-state.json` open list current. All green with no open incident ⇒ a
terse no-op. `dry-run` ⇒ no writes (board or `ops-state.json`) — print the incident you'd file/refresh.

## When blocked
A confirmed outage you cannot route to a fix is still FILED, tagged `blocked` + `Bail-shape:
external-prereq` (§9/§21), and reported as a fact — under `autonomy:"full"` only missing EXTERNAL
inputs stop you.
