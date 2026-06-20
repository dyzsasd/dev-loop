# Changelog

All notable changes to the dev-loop plugin. Most of these landed from **live-loop
experience** — a real failure observed while the agents ran, then hardened into a rule.

## 0.12.0 — operator notification on a human-park (Slack / Lark)
- **Opt-in `notify` config** (conventions §9; **absent ⇒ no-op**, full back-compat). When a
  ticket is left **human-parked** — `blocked` + `needs-pm` with `Bail-shape: external-prereq`
  (incl. a `[reflect-proposal]`, §17) — **PM pings the operator out-of-band** via a **Slack
  or Lark** incoming webhook. Fixes the failure where a parked ticket (e.g. CIT-562) sat
  unseen for days.
  - **Out-of-band by design**: the agents + operator share one Linear identity, so a Linear
    @mention is a self-mention Linear suppresses — a webhook is the channel.
  - **Trigger = `external-prereq` only** (not `decision-needed`/`scope-design`, which PM
    resolves itself under autonomy:full — paging for those is noise); **fail-closed** on an
    unparseable bail-shape. PM is the sole owner (not Sweep — no state file, lane, latency).
  - **Announced exactly once** via the new `notified` label (§4; survives state resets,
    operator-visible — chosen over a pm-state set whose reset would re-spam every parked
    ticket). Dropped on unpark so a genuine re-park re-announces.
  - **Safety**: message built from a closed allow-list `{project, id, ≤80-char title,
    bail-shape, url}` (never shell-interpolated); POST with `--max-time`, success = HTTP 2xx
    (Lark: + body `code==0`), mark `notified` only on success; on failure log one **id-only**
    line + surface in the report (no channel spam — a failing webhook delivers nothing). The
    webhook URL + Lark `secret` are **§16-class** — never committed / echoed into a
    ticket/comment/report/log; prefer `webhookEnv`/`secretEnv`. Dry-run posts/marks nothing.
- conventions §9 notify subsection + §4 `notified` label; PM Job B one-line wiring; init
  provisions `notified`; config-schema + projects.example.json `notify` block;
  README/plugin.json/CHANGELOG. Version 0.11.0→0.12.0 (plugin.json **and** the local
  marketplace.json — the CIT-562 cache-refresh gate).

## 0.11.0 — optional Codex companion (review · image-gen · rescue)
- **Opt-in `codex` config block** (conventions §24; **absent OR `enabled:false` OR no
  `codex` CLI on `PATH` ⇒ 100% unchanged**, same philosophy as `backend`/`repos[]`/
  `reports.sink`). Wires **OpenAI Codex** (the `codex` CLI + the
  [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) companion plugin) as an
  **advisory accelerant** — it never touches Linear/the board (§2), never bypasses the
  gates (Dev §5/§5.5/§6.5), `mode` (§12), `autonomy` (§12a), coverage (§15), or §16; the
  dev-loop agent owns every decision and ship. A missing/unauth'd Codex is a **graceful
  fallback**, never an error.
- **Three independently-gated capabilities:**
  - **`review`** — Dev Step 5.5 stage 2 (the "`code-review` skill/command" it already
    reaches for) + Architect run an **independent second-model** review of the diff/codebase
    (`codex exec review` / `/codex:review` / `/codex:adversarial-review`). An *additional*
    pass, not a replacement for Dev's self-review; Critical/High block like Dev's own, but a
    believed false-positive is no veto (note the disagreement in the hand-off).
  - **`imageGen`** — the one thing the loop can't do itself. **Dev** generates AC-required
    production assets into `codex.assetsDir` (shipped through the normal gates; a §15
    coverage exemption); **PM** generates mockups/wireframes to sharpen Feature tickets
    (illustrative, not production). Uses Codex's native `image_generation` tool — **verified
    mechanism:** the PNG always lands in `~/.codex/generated_images/<session>/ig_*.png`
    (the named path/size is ignored and Codex's "saved to X" is a confabulation), so the
    agent copies it out; requires `--sandbox workspace-write` + `< /dev/null`.
  - **`rescue`** — Dev hands a stuck ticket to Codex for **one** pass before a
    `fix-exhausted` block (inside §9's 2-retry cap); the patch ships only if it passes Dev's
    own gates + self-review, and Dev stages only its ticket's files (§7, shared checkout).
- **Determinism for the unattended loop:** agents drive synchronous `codex exec` forms
  (`< /dev/null`, `-C <repo>`, `approval never` + explicit `--sandbox`), not the plugin's
  `--background`/`/codex:status` polling (that's for an attended operator). No secret in
  config — Codex uses local `codex login` auth (§16).
- New `references/codex-integration.md` playbook; conventions §24 + ToC; one bounded §0
  pointer per consuming SKILL (Dev/PM/Architect) with inline hooks at the natural steps;
  config-schema + `projects.example.json` (`codex` block); README "Codex integration"
  section; version 0.10.0→0.11.0. **Inward QA/Sweep/Reflect/Ops/Signal unchanged** (they
  may use a read-only Codex review for their own analysis but nothing is wired by default).

## 0.10.0 — optional Linear-hosted reports (`reports.sink`)
- **Opt-in `reports.sink: "files" | "linear"`** (conventions §23; **absent ⇒ `files`**, so
  v0.9.0 behaves byte-for-byte). `linear` routes the report **body** + the **点评** channel
  to Linear for a **cloud / remote** runtime where the operator can't reach the data dir —
  read reports and write reviews from a browser / phone. **Decoupled from the §18 backend**;
  **default-off, never the default** — it trades away a §16 defense-in-depth layer.
  - **Reports = 8 rolling Linear Documents** (one per agent) in a **dedicated** reports
    project/initiative, three fixed `## Daily`/`## Weekly`/`## Monthly` body sections with
    dated `###` entries. Documents never appear in `list_issues`, so the §2/§5/§8/§10 board
    firewall is **structural**. (No per-period docs — the MCP has no doc delete/archive;
    the rolling body is pruned in place.)
  - **Provenance by channel, not author** (the shared-Linear-identity crux): the agent's
    only write to a report doc is `save_document` (the body) — it **never** `save_comment`s
    on a report doc, so every comment there is operator-authored by construction. Hardened
    by an operator-id allowlist + an opaque `reports.reviewToken` sentinel; distillation
    reads only the operator comment's own text (never `quotedText`/body/rolled-up content).
  - **§16 guardrails (all mandatory):** Linear-bound bodies carry only summary prose +
    counts + IDs/SHAs (never captured tool/log/deploy output); a fail-closed scrub backstop
    keeps any match local-only and writes a content-free `[withheld to local]` marker;
    `signal-agent` local-only by default (`ops`/`dev` recommended) via
    `reports.localOnlyAgents`; init takes an operator attestation + warns of the widened
    audience.
  - **Mechanics stay machine-local + deterministic:** `lessons.md`, the acted-review
    ledger, the doc-id cache (`reports-state.json`), and the per-agent O_EXCL report-lock
    never leave disk; markers via `date +%F`/`+%G-W%V`/`+%Y-%m` + strict heading regex;
    review-poll coarse-gated (≤1 `list_comments`/hr/agent); assert-namespace-before-write
    guards against overwriting a real human doc; non-durable storage degrades to a read-only
    mirror (no infinite re-distill).
- conventions §22 reworded ("backend-agnostic" → located by `reports.sink`); new §23 +
  ToC; one bounded clause added to each of the 8 agent §0 lines; config-schema / init /
  README / RUNNING / plugin.json updated; version 0.9.0→0.10.0.

## 0.9.0 — reports & operator review (点评 → improve)
- **One shared reporting + self-improvement capability** (conventions §22) for all 8
  agents — defined once, referenced by a single bounded §0 line per SKILL (not 8 bespoke
  impls). Additive and **on by default**; the back-compat invariant is narrow — **no change
  to ticket / product / board behavior** (the only added effects are local report files +
  a cheap review-glob at run-start).
  - **Reports** live in the data dir, machine-local / never-committed / backend-agnostic /
    §16-bound (no secrets/PII): `${CLAUDE_PLUGIN_DATA}/<project-key>/reports/<agent>/{daily,
    weekly,monthly}/`. Created lazily (init may scaffold).
  - **Cadence from the reports tree itself** (newest file per level — **no new state-file
    field**), computed deterministically (`date +%F` / `+%G-W%V` / `+%Y-%m`, ISO-week-safe).
    The **daily is an append-only running log written at close** (one terse entry per fire;
    **a pure no-op fire appends nothing** — proportional to work, not the ~288 fires/day).
    First fire of a new day finalizes yesterday's; new ISO week / month roll up **from the
    dailies** (the one durable level — ISO weeks don't partition months). Gaps → `idle — no
    activity`, never fabricated. Retention ≈ 90 days of dailies; atomic-write (temp+rename).
  - **Operator review (点评)** via one canonical, spoof-proof channel — a sibling
    `<report>.review.md` the agent did **not** author (ticket / log / source text is **never**
    a review channel, closing the prompt-injection path into the firewall). At run-start each
    agent acts on an un-acted review → distills it into a `lessons.md` rule **under its own
    section** (§14), marks it acted with a **machine-owned `.review.acted` sidecar** (never
    edits the operator's prose), surfaces it in the close-report, and has a terminal
    `acted → no actionable change` outcome (no infinite re-distill, no silent drop).
- **§17 firewall relaxed, carefully**: an agent MAY write into ITS OWN `lessons.md` section
  when distilling an explicit operator review of its OWN report — the written review is the
  human authorization §17 requires. Five hard limits: own section only (`## Shared` stays
  Reflect-only), real cited review only, §14 budget, structural changes still proposals
  (`[<agent>-proposal]`), reported + dry-run-gated. **`lessons.md` is now multi-writer** →
  every edit is a **locked read-modify-write** (§18 lock) to prevent lost updates. Reflect
  stays the autonomous curator + the only agent that may touch others' sections or `Shared`,
  and its GC audits/prunes review-driven rules. **Reflect's daily retro doubles as its §22
  daily report** (no double-write); its weekly/monthly are the loop-level cross-agent
  roll-ups.
- **init** scaffolds (or notes lazy creation of) the reports tree, warns not to sync the
  data dir, and tells the operator the 点评 channel. **README / RUNNING / config-schema /
  plugin.json** updated; one bounded §0 line added to each of the 8 agent SKILLs.

## 0.8.0 — outward agents (Ops / Architect / Signal)
- **Three OUTWARD observe-and-file agents** (conventions §21) join the five inward ones,
  connecting the closed build factory to (a) running prod, (b) whole-codebase health, and
  (c) real users. All three are read-only on what they observe, stateless per fire with
  their own state file, scoped to `dev-loop` (§2), backend-aware (§18), multi-repo aware
  (§19), and `autonomy:full` = file-never-prompt (except the §16 stop-and-surface fact).
  None implements, ships, verifies, or rolls back — they route work to PM/QA/Dev.
  - **`ops-agent`** (Ops/SRE; tight ~10–15 min): polls running prod — per-repo
    `deploy.healthCheck` + `testEnv.baseUrl` + optional `ops.criticalRoutes`/`ops.checks`/
    `ops.logsCommand`. **Anti-flap**: re-checks a failing probe and acts only on a
    CONFIRMED, REPEATED degradation (cross-fire) — never a transient blip. Files (or
    REFRESHES, via `ops-state.json` + a scoped `incident` query) a `Bug`+`qa`+`incident`
    with a QA-checkable health AC, Urgent when prod is down (so Dev's §5 grabs it). Never
    auto-rolls-back (Dev's Step 6.5); an un-routable outage is filed `blocked`+`external-prereq` (§9).
  - **`architect-agent`** (tech-debt; slow, daily-ish): audits the codebase **as a whole**
    on a **rotating** dimension (architecture-drift / duplication / dead-code /
    dependency-staleness+CVE / cross-module consistency / missing-abstractions), gated by
    the per-repo SHA change-gate (§19) — on an active repo the real bound is dedup + a
    per-run cap. Reads the doc-base/CLAUDE.md baseline first. Files `Improvement`+`qa`+
    `tech-debt` (refactor safety = tests-green/behavior-unchanged is QA-verifiable, §15);
    read-only on code (CVE scans use the audit/list form); never implements.
  - **`signal-agent`** (real-user intake; periodic): ingests configured `signal.sources`
    (support inbox / error tracker / feedback channel / app-store reviews, each read-only).
    **No source ⇒ graceful no-op.** Per-source last-seen cursor + per-issue fingerprint in
    `signal-state.json` (never re-ingests; dedupes hard). Triages a defect → `Bug`+`qa`+
    `signal`, a request → `Feature`+`pm`+`signal` note-ticket (never a doc-base write).
    **PII-strict** (§16): a mandatory scrub pass before every write; references the source.
- **New sub-type labels** (§4): `incident` (Ops Bug → `qa`), `tech-debt` (Architect
  Improvement → `qa`), `signal` (Signal Bug → `qa` / Feature → `pm`). Provisioned at setup
  alongside the existing labels (§13).
- **New config blocks** (config-schema): optional `ops` (`checks`/`criticalRoutes`/
  `logsCommand`) and `signal` (`sources[]`; absent ⇒ no-op). The `models` map gains
  `ops`/`architect`/`signal` and now **defaults to `opus` for every agent**.
- **Launcher** (`run-loop.sh`): the three outward panes are **opt-in / off by default**
  (like Reflect) — `OPS`/`ARCHITECT`/`SIGNAL` gate vars + `*_SLEEP` (Ops ~10 min,
  Architect daily, Signal hourly) + `MODEL_*`; every pane defaults to `--model opus`.
- **Back-compat**: a project that configures none of this is unaffected — the three agents
  are opt-in to launch, and Signal no-ops with no sources. Version → 0.8.0.

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
