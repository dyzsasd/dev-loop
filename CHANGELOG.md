# Changelog

All notable changes to the dev-loop plugin. Most of these landed from **live-loop
experience** — a real failure observed while the agents ran, then hardened into a rule.

## 0.7.0 — onboarding overhaul + multi-repo
- **`init` becomes DETECT → MAP → ASSEMBLE → LOAD** (skills/init/SKILL.md): it detects
  the project **shape** — greenfield (no code/baseUrl/build yet), brownfield (existing
  code), adopting (pre-existing human tickets) — and single- vs multi-repo; **MAP**s a
  brownfield codebase **read-only** (a Task/Explore subagent, per repo; non-fatal on
  failure) to seed the doc-base `Current state`; **ASSEMBLE**s config/labels/doc-base/
  runtime files; and **LOAD**s (operator-confirmed, per-ticket, never bulk) any named
  pre-existing human ticket into the loop. Greenfield runs a strategy interview and skips
  product smoke-tests.
- **PM doc-base** (conventions §20): the `strategyDoc` gains a fixed field set — Vision /
  Goals (north star) / Non-goals / Current state / Personas / Glossary / Decisions
  (running log) / Candidate ideas. init scaffolds the headings (seeding `Current state`
  from brownfield mapping once); PM owns them thereafter (append-only). A flat
  single-file `strategyDoc` still works exactly as today.
- **Multi-repo** (conventions §19; config `repos[]`): a product can span repos. Tickets
  target a repo via a **`repo:<name>` label** (both backends — Linear label / local
  `labels[]`). Per-repo resolution of `build`/`defaultBranch`/`deploy`/`contributorSkill`
  (repo value else top-level); `autoCommit`/`autoPush`/`autoDeploy` stay product-level.
  Per-repo change-gate (`pm-state.json`/`qa-state.json` hold a per-repo SHA map), per-
  target-repo orphan reclaim, doc-home repo (`role:"docs"/"primary"`), and cross-repo
  splitting into per-repo children. **Single-repo is 100% unchanged**: absent `repos[]`
  (or one entry) emits zero routing artifacts; normalization is read-side only.
- **Honest limits**: no cross-repo deploy barrier (per-repo or idempotent deploys only);
  one `testEnv`/`baseUrl` per product (per-repo testEnv is a known gap).
- **Version** bumped to 0.7.0; README/RUNNING/config-schema/plugin.json updated.

## 0.6.0 — per-agent models, run guide, resume
- **Per-agent models** (`models` config): the model is chosen at *launch* (a SKILL
  can't set its own), so a per-project map — e.g. `dev`/`pm` → `opus`, `qa`/`reflect`
  → `sonnet`, `sweep` → `haiku` — is applied by the launcher (`run-loop.sh` reads it and
  passes `--model` per pane). Tune to budget; omit ⇒ default model. Documented in
  config-schema + conventions §11.
- **`docs/RUNNING.md`** — the full run guide: onboarding a project (`/dev-loop:init`),
  the two launch methods (Agent View `claude agents` + `/loop` dispatch, and a local
  tmux launcher), per-agent models, cadence, **resume**, and stop.
- **Resume is a non-event** — documented: the agents are stateless per fire (§0), so
  after a stop/crash/reboot you just relaunch; state lives in Linear/the local board +
  git + state files. Agent View sessions persist across sleep; a mid-ticket crash
  self-heals via Dev Step 0 + Sweep.
- README "Run the loop" rewritten around Agent View + the model dial + resume.

## 0.5.0 — pluggable backend (Linear | local)
- **`backend` config dial** (conventions §18, config-schema.md): per-project choice of
  coordination substrate. **`"linear"` (default when absent)** is the Linear MCP, exactly
  as before — existing projects are 100% unchanged. **`"local"`** coordinates through a
  machine-local file board in the data dir (`${CLAUDE_PLUGIN_DATA}/<key>/board/`): one
  markdown file per ticket (YAML frontmatter + §6 body + appended dated comments), state
  in the frontmatter, monotonic prefixed IDs (`ticketPrefix`, default `DL`).
- **Race-safe by construction**: the atomic claim is the ticket file's **exclusive
  (`O_EXCL`) creation** (counter.json is only a start hint); updates take a per-ticket
  lock + atomic temp-file+rename and re-read to verify; the claim uses a **per-fire run
  token** so two concurrent Dev fires can't both win a ticket.
- **Single abstraction point.** §18 maps every Linear MCP op to its local equivalent
  (list→glob+parse+filter, free-text query→substring scan, get→read file, create→O_EXCL
  write, update→locked frontmatter rewrite with the FULL label set + merged append-only
  lists, comments→appended dated section, `create_issue_label`→no-op, get/save_document
  →repo file). Each SKILL gains **one** §0 line — "all ticket ops go through the
  configured backend (§18)" — instead of rewriting any job body.
- **Firewall in local mode**: the board directory *is* the boundary (no human backlog to
  leak into), but the cross-project axis still holds — every glob stays inside this
  project's board dir, and `init` guarantees a dedicated dir. Every state move appends a
  dated comment, so Reflect reconstructs the window's activity from the comment log + git.
- **`init`** confirms `repoPath` before any write, asks the backend, and for `local`
  scaffolds `board/` + requires a repo-file `strategyDoc`, skipping the Linear
  label/project steps.

## 0.4.0 — reflect-agent + init
- **`reflect-agent`** (5th agent, slowest/daily cadence): a **meta** retrospective that
  studies the loop's *own* behavior over a window (Linear tickets by type/owner/
  bail-shape, git + deploy/rollback, throughput, QA outcomes, optional run logs) and
  **self-evolves the loop by curating `lessons.md`** from recurring, evidence-cited
  patterns. **Hard safety boundary** (conventions §17): it may autonomously edit *only*
  `lessons.md` (reversible, per-operator, never-committed); structural changes to the
  SKILLs/conventions are **drafted as proposals, never auto-applied**. The proposal
  ticket is filed `blocked`+`needs-pm`+`Bail-shape: external-prereq` so the firewall is
  *mechanical* — Dev's pick query excludes `blocked`, and PM parks `external-prereq` for
  the human, so a self-modification can never re-enter unattended implementation.
- **`init`** (setup skill, not a loop agent): one-time, idempotent, operator-present
  bootstrap — gather/validate config, ensure labels + the Linear project, verify/scaffold
  the strategy doc, smoke the test env + build, create runtime files, print a readiness
  checklist. Creates only what's missing; overwrites nothing.

## 0.3.0 — sweep-agent + prod-safety gate
- **`sweep-agent`** (4th agent, lifecycle janitor): owns the cracks between the three
  owner-scoped agents. Every PM/QA/Dev query filters by owner label, so a ticket with a
  missing/wrong owner label is invisible to all of them and strands forever; Sweep
  finds and re-routes those, resets orphaned `In Progress` from crashed runs, and
  reports board health. Hygiene only — never verifies/implements/ships.
- **Dev Step 6.5** — post-deploy smoke check + autonomous rollback: after an unattended
  prod deploy, Dev verifies prod is alive (`deploy.healthCheck` or `baseUrl`) and, on a
  repeated failure, reverts + redeploys + reopens the ticket rather than leaving prod
  broken.
- Deliberately *not* added as separate agents: `investigate`/`reviewer`/`validator`
  (folded into Dev's self-review + smoke gate) and `unblock` (conflicts with
  autonomy:full).

## 0.2.0 — jinko-brain hardening pass
Adapted the mature jinko-brain harness to our autonomy-first posture (machine gates,
never human prompts): a **prime directive** (§0) making each fire stateless-safe under
auto-compaction; **Linear MCP write-hazard** rules (§10 — labels are REPLACE-style,
verify-after-write on fuzzy state-matching); an autonomous **self-review ship gate**
(Dev Step 5.5 — spec-compliance + a code-review pass; Critical/High blocks the ship or
blocks the ticket `fix-exhausted`); a **test-coverage definition-of-done** (§15); a
per-operator **`lessons.md`** every agent reads at run-start (§14); QA **result
vocabulary** (pass/fail/drift/inconclusive — `inconclusive ≠ pass`); Dev
**orphan-recovery** (Step 0); a **bail-shape** taxonomy on blocked tickets (§9); a
**security doctrine** (§16); and a **Topology-at-a-glance** map.

## 0.1.9 — Dev split-follow-up enforcement
Dev's split rule said to *file* a follow-up for a deferred slice, but across a long run
Dev repeatedly shipped a slice, wrote "split to a follow-up — see handoff", and never
filed the ticket — stranding the deferred ACs. Hardened into a mandatory gate: the
follow-up must be filed *before* the parent moves to `In Review`, and the hand-off MUST
cite the new ticket ID filed that run; a split with no filed ID is a defect.

## 0.1.8 — PM steady-state guard
Once the structured backlog is exhausted, PM could keep re-hunting a *feature-complete*
product on every idle fire. After a real hunt comes back near-empty, PM records it and
reverts to the terse HEAD-unchanged no-op; re-hunts only on material HEAD movement or
user redirect.

## 0.1.7 — project-scope every blocked/needs-* query
The PM/QA Job-B templates omitted the `project` scope, so a verbatim transcription
issued an unscoped label query that returned another project's blocked tickets. All five
templates now carry `project` with an inline "always include project" note.

## 0.1.6 — anti-stall escape hatch
When a confirmed, reproducible defect PM flagged stays unfiled while the loop is stalled
(Dev idle, nothing In Review — QA isn't picking it up), PM may file it itself as a
properly-typed `Bug`+`qa` (QA still verifies), with repro + dedupe note. Lane-legal, to
keep the loop moving.

## 0.1.5 — `autonomy` setting
Optional per-project `autonomy` (§12a), orthogonal to `mode`. `"ask"` (default) keeps the
conservative escalate-to-user posture; `"full"` grants standing authority to decide and
act from the strategy doc — caution becomes the *method*, escalation narrows to genuine
external prerequisites only.

## 0.1.4 — close the escalation loop
A standing escalation usually resolves out-of-band (the human authorizes in a comment and
`blocked` gets stripped while a stale `needs-*` lingers). Job B now re-reads parked
tickets' comments and treats `needs-*` without `blocked` as "finish the job"; a now-
unblocked sensitive/irreversible action is executed *attended* by the owner.

## 0.1.3 — PM Job B actually unblocks
When Dev blocks on a question/decision PM can answer, PM answers it **and** removes
`blocked`/`needs-pm` (encoding any safety as acceptance criteria). Supplying the info
*is* the resolution; "answered but left blocked" is not.

## 0.1.2 — PM change-gate preflight
When In Review + blocked are empty and repo HEAD is unchanged, PM skips the expensive
product sweep and reports a one-line no-op. Records the explored SHA (not end-of-run
HEAD) so a mid-run commit isn't skipped.

## 0.1.1 — stale-doc hardening
Dedupe against the *current product*, not just tickets (§8); Dev grooming detects
already-built tickets and routes them to `In Review` instead of rebuilding; PM/QA may
file zero in a run and stay in their lane rather than padding the backlog.

## 0.1.0 — initial release
The PM/QA/Dev three-agent loop coordinated through Linear: state machine, label
taxonomy, ticket templates, priority pick order, claim/dedupe/blocked protocols, the
`dev-loop` safety label, and per-project config (`mode`, `git`, `deploy`).
