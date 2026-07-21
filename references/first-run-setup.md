# First-run setup — the idempotent first-live-run checklist

Extracted from conventions §13. Read on a FIRST live run against a workspace.


**The canonical bootstrap is the 1.0 team flow** — `dev-loop team init` (pure CLI
workspace creation) → `/dev-loop:add-project` (backend sync: find-or-create the Linear/hub
project, ensure labels, record ids) → `/dev-loop:add-repo` (clone + detect + deploy
interview + ops probes, one pass).
The loop agents still re-apply the label/project checks below defensively on a first live
run, so this checklist remains the contract:

Idempotent; safe to re-run. Before the first live run against a workspace:
1. Ensure the workflow labels exist (create only the missing ones via
   `create_issue_label` on the configured team): `dev-loop`, `pm`, `qa`,
   `edge-case`, `blocked`, `needs-pm`, `needs-qa`, `coverage`, `incident`, `tech-debt`,
   `signal`, `investigation` (§9a investigation intake), `notified`, `senior-dev`,
   `junior-dev`, `sensitive` (§21b routing), and the
   §9c external-prerequisite set: `external-prereq`, `external-code`, `external-access`. (`notified` marks a §9 human-park whose
   operator notification has been sent — the daemon's reminder timer keys on it. `senior-dev`/`junior-dev` are the §21b dev-tier
   routing labels — required for the two-tier Dev on `linear`/`local`; harmless extras on
   `service`. `Bug`/`Feature`/`Improvement` already exist — reuse, don't duplicate.)
2. Ensure the `linearProject` exists; if not, ask the user before creating it.
3. Confirm `strategyDoc` is readable and `testEnv`/`build`/`deploy` commands are
   correct with the user (these gate real deploys).
4. Create the runtime files lazily if absent under `<workspace>/.dev-loop/<project-key>/`
   and the team lessons index under `<workspace>/.dev-loop/lessons/`.
5. **`local` backend fallback only** (§18): skip steps 1–2 (no Linear labels/project to
   provision — labels are just strings, and the board dir is the project container)
   and instead scaffold the board — `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/board/` with
   `tickets/` and a `counter.json` (`{ "prefix": "<ticketPrefix|DL>", "next": 1 }`) —
   and ensure `strategyDoc` is a **repo file** (a Linear document can't back a local
   board). New 1.0 workspaces use `linear` or `service`.
