# dev-loop — Strategy

> PM's north star. Seeded by `/dev-loop:init` on 2026-06-23 (operator-present setup).
> `Current state` was seeded once from a read-only code map; `Vision` / `Goals` /
> `Non-goals` / `Personas` come from the operator interview. PM owns this doc thereafter
> (append-only — record shipped progress and new direction here so it stays a living
> north star, not a stale snapshot).

## Vision

A self-evolving, autonomous multi-agent development loop that builds and maintains
software through a shared ticket blackboard, steered by operator **review (点评)** rather
than by editing agent code.

**Forward direction (operator, 2026-06-23):** evolve dev-loop toward a long-running
**daemon** that:
- serves a **local, Linear-like web app** for viewing and managing the loop (board,
  tickets, roadmap);
- owns **inter-agent communication and discussion** (the coordination plane the agents
  talk through);
- bridges to **external communication tools** (Slack, Lark, …) so the operator and other
  stakeholders can **view and edit the roadmap** — and steer direction — from the tools
  they already use.

> ⚠️ This is a deliberate pivot from today's **daemon-free** design (see `Current state`
> and `Decisions`). The agents and hub are currently no-daemon by principle; the new
> direction introduces a persistent process. PM must reconcile the two — what stays
> stateless-per-fire, what moves into the daemon, and how the §17 self-evolution firewall
> and §2/§16 safety boundaries hold once a daemon + web UI + external write-paths exist.

## Goals (north star)

**Top priority (operator, 2026-06-23):** the **daemon**, a **web interface**, and
**Lark/Slack integration** that lets users **plug into and edit the roadmap** (and feed
direction back into the loop). This leads the milestone.

Supporting goals (all in scope this milestone):
- **Harden the hub / `service` backend** — robustness, tests, `doctor` coverage, and edge
  cases for the `node:sqlite` hub and the §18 backend (the daemon will build on this SoR).
- **Agent skill robustness** — tighter protocols, fewer strand/dead-loop failure modes,
  better dedupe/blocked handling across the 8 SKILLs. (Edits to SKILL/conventions files
  hit the §17 self-edit boundary and stay human-gated — drafted as proposals.)
- **Operator-facing polish & docs** — onboarding (`init`), `RUNNING.md`, README accuracy
  (currently reads v0.15.0 while git is 0.19.2), examples, and error messages.
- **Broaden portability** — more CLIs / backends / integrations (Linear mirror, Lark/Slack
  channel, Codex) certified and documented.

## Non-goals

- **Not Linear-locked.** Linear is a default, never a requirement; the loop must keep
  working on the `local` and `service` (hub) backends.
- **No default human step-by-step gating.** Safety comes from machine gates (red build
  never ships, diff self-review, deploy smoke-check + auto-revert), not interactive
  approval prompts (`autonomy:"full"`). dev-loop is not a human-approval workflow tool.

> _(Note: "no daemon" and "no GUI/web UI" were considered as non-goals but **rejected** by
> the operator — both are now in-scope per the Vision above.)_

## Current state

_Seeded once from a read-only code map of the repo at git `596c62b` (2026-06-23).
Append-only thereafter — PM keeps it current._

- **What it is:** a Claude Code plugin (`github.com/dyzsasd/dev-loop`) implementing eight
  autonomous agents that coordinate **entirely through ticket state** (no agent calls
  another). Five inward/build agents (**PM, QA, Dev, Sweep, Reflect**) + three outward
  (**Ops, Architect, Director**). Repo version in `hub/package.json` is `0.6.2`; latest
  git tag/commit is `0.19.2` (README still says v0.15.0 — stale).
- **Main surfaces / modules:**
  - `skills/` — 9 SKILLs (the 8 agents + `init`), authored as markdown instruction sets.
  - `references/` — `conventions.md` (the authoritative shared spec: state machine, label
    taxonomy, safety boundary §2, blocked protocol §9, self-evolution boundary §17,
    backends §18, multi-repo §19, reports §22/§23, discussion board §25), plus
    `config-schema.md` and `codex-integration.md`.
  - `hub/` — a **local MCP system-of-record** over built-in `node:sqlite` (zero native
    deps, zero build step; Node ≥23.6). `src/server.ts` (the MCP server, identity via
    `DEVLOOP_ACTOR`), `src/seed.ts` (project/actors/labels bootstrap), `src/db.ts`, and a
    `test/` suite of 8 (`smoke/loop/isolation/docs/board/channel/mirror/identity`) run via
    `npm test`; `npm run doctor` health-checks the SoR.
  - `docs/` — `HUB-ARCHITECTURE.md`, `RUNNING.md`, `PORTABILITY.md`, `reviews/`.
  - `config/` — example `projects.json` + MCP templates (Claude `.mcp.json`, Codex,
    opencode).
- **Coordination backends (§18):** `linear` (default; Linear MCP), `local` (machine-local
  file board), `service` (the hub — real per-agent identity, the SoR being dogfooded here).
- **How it runs today:** **daemon-free** by design. Agents are stateless per fire; the
  launcher fires them (Agent View `/loop`, a tmux launcher, or manual). State lives in the
  backend (Linear/board/hub) + git + the `*-state.json` files. Recent phases added P4
  hub-native docs, P5 discussion board + Director, P6 two-way Lark/Slack channel, P7
  one-way Linear mirror, P8 second-CLI portability — **all daemon-free**.
- **Operator steering:** every agent writes daily/weekly/monthly reports; a sibling
  `<report>.review.md` (点评) is distilled into a `lessons.md` rule the agent then obeys.
- **Obvious gaps vs. the Vision:** _(updated 2026-06-23 PM)_ **the headline Vision arc is SHIPPED
  (all verified Done):** **daemon** (DL-1) → read-only **board/ticket web UI** (DL-2) → **roadmap
  view/edit** write surface via the operator-publish gate (DL-3) → **steer the roadmap from
  Lark/Slack** (DL-4 — a chat `roadmap`/`roadmap edit` bridge that lands DRAFTs, §16-scrubbed,
  never auto-published). So the operator can now view+manage the loop from a browser AND propose
  roadmap edits from chat, with the operator-publish gate intact throughout. **Remaining (smaller)
  gaps:** ~~reports view in the web UI (DL-10)~~ **SHIPPED** (verified Done — the daemon now serves
  a read-only `/reports` view over the §22 reports tree; the operator can read pm/qa/dev dailies
  from the browser), **cwd-based project auto-selection** — the **hub resolver + auto-pin is SHIPPED**
  (DL-13 verified Done; from a repo checkout with no `DEVLOOP_PROJECT` the hub now auto-selects that
  project — the dogfood case `cwd=dev-loop repo → "dev-loop"` is fixed); the **config templates + docs**
  (DL-15) are **SHIPPED** too — so cwd auto-pin works end-to-end for a CLI that spawns the hub with the
  repo cwd. Remaining for fully hands-off: the **§11/SKILL agent-side wording** (DL-12, operator's git
  commit) and an **optional machine-local `run-loop.sh` enable step** (export the resolved
  `DEVLOOP_PROJECT` + the correct per-pane `DEVLOOP_ACTOR` — the latter also fixes a pre-existing drift
  where panes attribute to `operator`; deferred to the operator since `run-loop.sh` is an untracked
  machine-local launcher, not a repo deliverable). Then: web-UI polish: DL-8 relatedTo — **SHIPPED** (verified Done — ticket detail now shows clickable Related/Duplicate-of links), DL-14 conflict-draft-preservation — **SHIPPED** (verified Done); **README drift (DL-5) — SHIPPED** (Status headline now
  v0.19.2 with the P5–P8 history; verified Done); and the deferred candidates (inter-agent discussion daemon; multi-stakeholder roadmap
  auth; **accepting a 点评 *from* the web UI** — the remaining half of the reports-in-UI idea, a
  write path). With DL-10, the operator's **observe** loop is browser-complete (board · tickets ·
  reports · roadmap view/edit · steer-from-chat). The next theme, once this milestone's tail
  drains, is the **supporting goals** (hub/`service` hardening + broader portability) — see Goals.

## Personas

- **Operator (primary).** Runs the loop on a product, reviews reports, drops 点评, sets
  direction. Today: terminal + the data dir; wants a web app + Slack/Lark to do this from
  anywhere. _(For this repo, the operator and the developer of dev-loop are the same
  person — dogfooding.)_
- **Plugin adopter / developer.** Installs dev-loop to run the loop on *their own*
  product; cares about onboarding (`init`), backend choice, and safety boundaries.
- **Roadmap stakeholder (future).** A non-operator (PM-ish/business) who views and edits
  the roadmap via the planned web UI or Lark/Slack, without touching a terminal.

## Glossary

- **Fire** — one run of an agent; agents are stateless per fire (re-read ground truth).
- **Backend** — the coordination substrate: `linear` / `local` / `service` (hub).
- **Hub** — the `node:sqlite` MCP system-of-record (`backend:"service"`); gives real
  per-agent identity (`DEVLOOP_ACTOR`).
- **点评 (operator review)** — a `<report>.review.md` critique an agent distills into a
  `lessons.md` rule.
- **§17 boundary** — agents may edit `lessons.md` autonomously but must NOT auto-rewrite
  SKILL files / `conventions.md`; those are drafted as proposals for the operator.
- **Owner label** — `pm` (Features) / `qa` (Bugs); the owner files and verifies.

## Decisions (running log)

- **2026-06-23 — Onboarded the dev-loop repo into dev-loop (dogfooding).** Backend
  `service` (the repo's own hub), `mode:"live"`, `autonomy:"full"`, prefix `DL`. `autoPush`
  left **false** (commits to this public plugin repo's `main` stay local for operator
  review); `autoDeploy` false (nothing is deployed).
- **2026-06-23 — RESOLVED (PM, was OPEN): daemon = additive human-facing surface over the
  hub SoR, NOT a new agent coordinator.** Reconciliation of the daemon pivot vs. the
  daemon-free design:
  - **The loop core stays daemon-free.** All 8 agents stay **stateless-per-fire** and keep
    coordinating through the hub SoR exactly as today. The daemon does **not** run, schedule,
    or replace agents, and the loop must keep functioning without it. (Agent launching/
    scheduling stays the launcher's job — out of scope for this milestone.)
  - **The daemon is a persistent localhost process that adds human-facing surfaces** over the
    existing `node:sqlite` hub DB: (a) a read API + Linear-like web UI (board / tickets /
    roadmap), and (b) a roadmap view/edit surface that writes roadmap **DRAFT** versions
    through the EXISTING operator-publish gate.
  - **Firewalls preserved by construction, not by promise:** §2 — the daemon is project-scoped
    via the hub (structural); §16 — **127.0.0.1-bind by default**, any external (Lark/Slack)
    bridge reuses the channel's env-var-name secret discipline, no PII; §17 — the daemon's
    **only** doc write path is the DB-doc operator-publish gate, so it can never write a
    SKILL/conventions/code file (same structural firewall as the hub doc tools). A roadmap
    edit lands as a DRAFT; only the **operator** actor publishes.
  - **Sequencing (filed this fire):** read API foundation (**DL-1**) → web read UI
    (**DL-2**) → roadmap view/edit via operator-publish (**DL-3**) → Lark/Slack roadmap
    bridge (**DL-4**). README/version-drift polish filed as **DL-5**.
- **2026-06-23 — SHIPPED: DL-1 daemon foundation verified Done (PM).** The read-only
  localhost HTTP daemon over the hub SoR (`hub/src/daemon.ts`, `npm run daemon`) is built
  and verified against the running product: 127.0.0.1-only bind, read-only (POST/DELETE →
  405, `PRAGMA query_only=ON`), endpoints for board/ticket+comments/doc, `hub/test/daemon.ts`
  in `npm test` green, documented in `docs/DAEMON.md` (commit `9859384`, local-only). The
  first slice of the daemon/web-UI direction now exists; **DL-2** (web read UI) and **DL-3**
  (roadmap write surface) are unblocked. Next bottleneck is a **Dev run** to pick up DL-2.
- **2026-06-23 — SHIPPED: DL-2 web read UI verified Done (PM).** The daemon now serves a
  server-rendered, read-only **web UI** over the hub SoR (commit `bc6552d`, local-only):
  `GET /` renders the board (tickets grouped into state columns; cards show id/title/type/
  owner/priority), `GET /ticket/:id` renders the detail view (description + comments). Plain
  inline HTML/CSS — no client JS, no bundler, no native deps (hub doctrine); read-only
  preserved (POST/PUT → 405, ghost → 404) and the JSON API moved `/` → `/api`. Verified
  against the running daemon on the real dev-loop board (all 6 tickets render by state) +
  the full hub suite (8/8 green). The **board/ticket** half of the "Linear-like web app"
  Vision now exists; the **roadmap view/edit** half is **DL-3** (the first write surface,
  via the operator-publish gate), which is now unblocked for Dev. Next bottleneck is a
  **Dev run** to pick up DL-3 (then DL-5 polish; DL-4 waits on DL-3).
- **2026-06-23 — ux-flows lens swept over the new web UI (PM); filed DL-8.** First proactive
  (non-strategy-gaps) review at HEAD `894c164`, now that DL-1/DL-2 shipped a real web surface.
  Exercised the **running** daemon UI (board + ticket detail + error pages), not the diff. The
  board is solid: core state columns always render, Backlog/Canceled/Duplicate appear only when
  populated (terminals last), empty columns show `—`, HTML is escaped, the detail has a working
  `← board` back-link, and ghost tickets get a friendly HTML 404. **One genuine gap:** the ticket
  detail drops `relatedTo`/`duplicateOf`, so the dependency chain that sequences this very
  milestone (DL-2→DL-1, DL-3→[DL-1,DL-2], DL-4→DL-3) is invisible and unclickable in the UI →
  filed **DL-8** (Improvement, pm, **Low** — deliberately kept behind the milestone-critical DL-3
  in Dev's pick order). Loop remains **Dev-bottlenecked** (DL-3 is the next piece).
- **2026-06-23 — SHIPPED (Dev): DL-7 daemon 400-fix (`ccefa3e`, In Review → QA-owned).** Dev
  shipped the malformed-percent-escape fix (the three id/kind daemon routes now return 400, not
  500, on a bad percent-escape). QA-owned Bug — QA verifies. New code SHA → PM review lenses reset.
- **2026-06-23 — NEW OPERATOR DIRECTION (chat): surface the daily report in the hub web UI →
  filed DL-10.** The operator asked to **see the daily report on the hub web interface**. This is
  the read half of the previously-parked "Reports + 点评 in the web UI" idea, now unblocked (DL-1
  daemon + DL-2 web read UI shipped). Filed **DL-10** (Feature, pm, **High/P2**) — a read-only
  Reports view in the daemon UI that reads the §22 reports tree from the **filesystem** (a new read
  source, separate from the hub DB), localhost-only + read-only + path-traversal-safe (cf. DL-7),
  excluding the operator's `*.review.md` 点评 siblings from the listing. Accepting a 点评 *from* the
  UI (a write path) stays a follow-up. This makes the operator's **observe-and-steer** flow
  browser-reachable — a direct step toward the Vision's "view and manage the loop from a browser."
- **2026-06-23 — NEW OPERATOR DIRECTION (chat): launch an agent from a project's folder → it
  auto-selects the project matching the cwd, no `DEVLOOP_PROJECT` env var.** Motivating dogfood
  bug: in this repo `cwd=/Users/shuai/workspace/dev-loop` but `defaultProject=monpick`, so today's
  selection ladder (named → sole → defaultProject → ask) picks the **wrong** project. Designed +
  adversarially reviewed via a workflow; split on the **§17 boundary** into two filed tickets:
  - **DL-12 `[pm-proposal]` (§17-GATED, parked for operator):** the contract/wording change —
    insert a **cwd rung** into the conventions §11 selection ladder (precedence **explicit >
    cwd-match > configured-default > prompt/error**; realpath + segment-boundary containment +
    nearest-ancestor; ambiguous tie ⇒ fall through), plus §18/§26 (`DEVLOOP_PROJECT` becomes
    *optional*, hub falls back to cwd) and the pm-agent SKILL §0 chain. Also restores a
    **pre-existing bug**: §11 step 2 is missing the `defaultProject` rung the SKILL/launcher already
    use. Edits conventions.md + a SKILL file ⇒ **only the operator may apply it** (git commit);
    filed `blocked`+`needs-pm`+`Bail-shape: external-prereq` (§17). This is the entire agent-side
    deliverable and the only fix for `backend:"linear"` projects.
  - **DL-13 Feature (BUILDABLE, Dev):** the hub/launcher/config/docs half — a shared cwd→project
    resolver + a `server.ts` cwd fallback when `DEVLOOP_PROJECT` is empty/unset, per-file `.mcp.json`
    template fixes (codex/opencode are **not** shell contexts → literal `""`/omit, not
    `${DEVLOOP_PROJECT:-}`), launcher reconciliation (also fixes today's drift: `run-loop.sh`
    exports neither `DEVLOOP_PROJECT` nor `DEVLOOP_ACTOR`, so panes silently attribute to
    `operator`), and docs. Touches **no** canonical doc → **independently shippable** for
    `backend:"service"` (backward-compatible: explicit env still wins; no-match ⇒ today's behavior).
  - **Decision:** keep the agent-side spec change human-gated (§17) while letting Dev ship the
    backend:"service" mechanism now; sequence the docs note alongside, not as a hard block.
- **2026-06-23 — SHIPPED: DL-3 roadmap view/edit write surface verified Done (PM).** Dev shipped
  the daemon's **first write surface** (commit `b316424`): `GET /roadmap` renders the
  `kind:"roadmap"` doc (markdown) + version/status, an edit form saves **DRAFT** versions via the
  existing `doc.save` CAS, and an **operator-only** publish control promotes a draft → current —
  all through the hub's operator-publish gate. Verified against the running daemon (not the diff):
  `daemon-test` DAEMON_OK (18 assertions — draft-save 303, draft-never-auto-publishes, stale
  baseVersion→409 CONFLICT, non-operator publish→403 / control hidden, operator publish→v2, and
  the **§17 firewall**: a save with injected slug/kind/path fields is accepted but the extras are
  ignored — every write hard-targets `kind:"roadmap"`, so the daemon can never write a
  SKILL/conventions/code file) + `docs` HUB_DOCS_OK. Architecture: the CAS + operator-publish
  logic was extracted to a shared `hub/src/docstore.ts` used by BOTH the MCP server and the
  daemon, so the gate can't drift. The **roadmap view/edit half of the Vision now exists**; **DL-4**
  (Lark/Slack roadmap bridge, depends on DL-3) is now **unblocked**. _(Note: full `npm test` shows
  5 `mirror`-suite failures = the independent, In-Progress DL-11, unrelated to DL-3.)_
- **2026-06-23 — SHIPPED: DL-4 Lark/Slack roadmap bridge verified Done (PM) → the headline Vision
  arc is COMPLETE.** Dev shipped the roadmap-over-chat bridge (commit `a770bdd`, in `channel.poll`
  so the agents are unchanged): a chat `roadmap` → a §16-safe summary reply; a `roadmap edit <text>`
  → a roadmap **DRAFT** via `doc.save` (CAS), **never published** (there is deliberately no publish
  command — publishing stays the operator-actor `doc.publish` gate, DL-3). Channel content is
  scrubbed before it lands in a doc (Slack/AWS tokens, email, phone → `***`); credentials are
  env-var NAMES only and the token never crosses the tool boundary; inbound text is treated as DATA
  from an UNVERIFIED author. Verified green: `cd hub && npm test` end-to-end (9/9 suites; the DL-4
  channel suite asserts every AC + the false-positive hardening that a casual `roadmap:` musing is
  NOT captured as an edit). **DL-1→DL-2→DL-3→DL-4 are all Done** — the operator can view+manage the
  loop from a browser and steer the roadmap from chat, operator-publish gate intact. DL-11 (mirror)
  also verified by QA, so the full suite is green again. Bottleneck remains Dev: DL-10 (reports
  view) In Progress; DL-13/DL-14/DL-8/DL-5 queued; DL-12 awaits the operator's commit.
- **2026-06-23 — SHIPPED: DL-10 agent reports view verified Done (PM).** Dev shipped a read-only
  `/reports` view in the daemon web UI (commit `db93750`): the board header links to it, the index
  lists agents (pm/qa/dev) + their dated daily/weekly/monthly reports, and each renders read-only
  with back-links. The reports root is resolved from `DEVLOOP_REPORTS_DIR` else the first-existing
  data-dir candidate (it found the real `~/.claude/plugins/data/dev-loop/dev-loop/reports`). Verified
  against the **running daemon on the real reports tree** — it renders the actual PM/QA/Dev dailies;
  path-traversal → 400/404 (strict segment validation + resolved-path-within-root), POST → 405
  (read-only), absent tree → friendly empty state, and the dated-report grammar inherently excludes
  `*.review.md`/`*.review.acted`. **This closes the operator's "see the daily report in the web UI"
  ask** and makes the **observe** loop browser-complete (board · tickets · reports · roadmap). The
  remaining half — accepting a **点评 FROM the web UI** (a write path) — stays a Candidate idea.
- **2026-06-23 — SHIPPED: DL-13 cwd→project hub auto-resolution verified Done (PM); Dev split the
  wiring into DL-15.** Dev shipped the resolver (`hub/src/resolve-project.ts`: realpath +
  segment-boundary containment + longest-prefix + ambiguity→none + `repos[]`) and the hub fallback
  (`server.ts`: explicit `DEVLOOP_PROJECT?.trim()` wins; empty/unset → cwd-resolve; no-match → `demo`
  backward-compatibly; DB-missing cwd-match → loud exit-1 via the P3/G2 guard), plus a
  `dev-loop-hub resolve-project [--cwd]` subcommand. Verified **live against the real `projects.json`**:
  the operator's motivating bug is fixed — `cwd=/Users/shuai/workspace/dev-loop` + unset env → `dev-loop`
  (not `monpick`); `monpick` sibling → `monpick` (no cross-match); nested `hub/` → `dev-loop`; outside
  every repo → no guess (exit 1). Full `npm test` green incl. the new RESOLVE_PROJECT suite (explicit
  wins; empty+under-repo auto-pins). **Dev legitimately split** the config-template / launcher / docs
  ACs into **DL-15** (Feature/pm, relatedTo DL-13) — the part that makes a folder-launched agent fully
  hands-off end-to-end. So the operator's "launch from the folder" ask now has: hub auto-pin ✅ (DL-13);
  launcher+config+docs ⏳ (DL-15, Dev); agent-side §11/SKILL wording ⏳ (DL-12, operator commit).

- **2026-06-23 — SHIPPED: DL-15 cwd→project wiring (templates + docs) verified Done (PM).** Dev shipped the repo-tracked slice (commit `8329bdf`): the 3 MCP config templates default `DEVLOOP_PROJECT` to **empty** per-file correctly — `mcp.example.json` shell-expanded `${DEVLOOP_PROJECT:-}`, but `codex.toml`/`opencode.json` **literal `""`** (NOT shell contexts — the exact hole the DL-13 ticket flagged), plus precedence docs in RUNNING.md/PORTABILITY.md/config-schema.md. Gate green. **The launcher (`run-loop.sh`) AC is correctly deferred as an OPERATOR enable step** — it's an untracked machine-local file outside the repo, so Dev won't silently mutate the operator's live launcher with no git review; cwd auto-pin already works without it for a repo-cwd-spawned hub (DL-13). The operator enable step (also fixes the pre-existing `DEVLOOP_ACTOR`→`operator` attribution drift): in `run-loop.sh`, export per-pane `DEVLOOP_ACTOR=<agent>` + `DEVLOOP_PROJECT="$(… resolve-project --cwd "$REPO")"`. **Net: the buildable cwd→project feature is complete (DL-13+DL-15); only DL-12 (operator §11/SKILL commit) + the optional launcher step remain.**

- **2026-06-23 — SHIPPED: DL-5 README reconciled to v0.19.2 verified Done (PM).** Dev's commit `147dd86` fixed the stale README Status headline (v0.15.0 → **v0.19.2**) and added the post-0.15 version history (P5 board+Director, P6 channel, P7 Linear mirror, P8 portability). Docs-only (§15-exempt). Satisfies the operator-facing-docs goal's README-accuracy item. _(Future: the "All daemon-free" line is accurate for released v0.x; when the daemon work (DL-1…DL-15, currently local-only, autoPush=false) is cut as a release, the README needs a daemon update — file at release time.)_

- **2026-06-23 — SHIPPED: DL-8 relatedTo/duplicateOf in the web UI verified Done (PM).** Dev's commit `1fbeaf2` adds click-through Related / Duplicate-of links to the ticket detail (shown only when present — no dangling rows). Verified live: `/ticket/DL-3` → a Related row linking DL-1/DL-2; `/ticket/DL-1` → no row; read-only preserved; daemon-test asserts both. The board's dependency chain is now navigable in the browser. Backlog now down to **DL-14** (roadmap-editor conflict draft-preservation, In Progress) + **DL-12** (cwd §11/SKILL wording, parked for operator).

- **2026-06-23 — SHIPPED: DL-14 roadmap-editor conflict-draft-preservation verified Done (PM) → MILESTONE COMPLETE (14/15).** Dev's commit `ebd2868` makes a rejected roadmap save (CAS conflict / validation error) preserve the user's typed text + refresh the hidden baseVersion (no data-loss; verified via the daemon conflict integration test). **The entire operator-set milestone is now shipped + verified**: daemon (DL-1) → web board/tickets (DL-2) → roadmap view/edit (DL-3) → Lark/Slack steer (DL-4) → reports-in-UI (DL-10) → cwd auto-pin (DL-13/15) → README accuracy (DL-5) → web-UI polish (DL-8 relations, DL-14 conflict-preserve) → plus QA bug-fixes DL-6/7/9/11. **Dev queue is empty.** The only open item is **DL-12** (cwd §11/SKILL agent-side wording, §17-gated — awaiting the operator's git commit) + the optional machine-local `run-loop.sh` enable step. **Next theme (backlog drained → ready to re-open):** the supporting goals (hub/`service` hardening + broader portability — note hardening/tests lean Architect/QA lane) and the deferred candidates (点评-from-the-web-UI, which needs the §22 carve-out proposal noted in Candidate ideas; inter-agent discussion daemon; multi-stakeholder roadmap auth). Awaiting operator prioritization of the next theme.

- **2026-06-23 — FILED: DL-16 web-UI detail polish (PM, post-milestone).** With the operator-set milestone complete and the Dev queue empty, re-opened the review rotation and filed the parked buildable polish (Improvement, pm, Low): render the ticket **description + comments** via the existing `renderMarkdown` (today they're raw `<pre>` while roadmap/reports already render markdown — DL-3/DL-10) + show created/updated timestamps. **Chosen deliberately over filing another operator-gated proposal**: it's buildable now (no §17 gate, reuses existing code), keeping the loop productive while DL-12 (cwd §11/SKILL) + the 点评-from-UI §22-carve-out (Candidate ideas) await the operator. Next operator-gated initiative when you engage: 点评-from-the-web-UI (needs the §22 carve-out).

- **2026-06-23 — SHIPPED: DL-16 web-UI markdown rendering + timestamps verified Done (PM).** Dev's commit `a09d453` renders the ticket description + comments via the existing `renderMarkdown` (no longer raw `<pre>`) and shows created/updated timestamps; XSS-inert (esc-first, asserted for an injected `<script>` in both description + comment); gate green. The ticket detail now matches the roadmap/reports views (Linear-like). **All 15 buildable tickets this session are Done (DL-1…DL-11, DL-13/14/15/16); the only open item is DL-12** (cwd §11/SKILL agent-side wording, §17-gated — awaiting the operator's git commit). Dev queue empty; next operator-gated theme = 点评-from-the-web-UI (§22 carve-out, Candidate ideas) or the supporting goals.

- **2026-06-23 — REVIEWED + FILED: 6-lens proactive sweep at `8ad763b` (PM) → DL-17…DL-20.** Backlog had drained (15/15 buildable Done) so the rotation re-opened; swept the 6 remaining rubric lenses (conversion-retention, data-analytics, trust-safety, consistency, competitive-parity, polish-performance — strategy-gaps + ux-flows were already swept at this SHA), each grounded in source and adversarially vetted (9 candidates → 6 survived → top 5 ranked, 1 dropped). **All survivors are BUILDABLE** (hub/src + docs only; no §17/§22 carve-out) — chosen deliberately over operator-gated proposals to keep Dev productive while DL-12 + the 点评-from-UI carve-out await the operator. Filed: **DL-17** (P2 Feature, data-analytics — a read-only `/activity` view over the existing-but-unsurfaced `events` ledger: throughput / cycle-time / per-agent activity, the metrics the observe+steer Vision needs; verified daemon.ts has zero SELECTs on `events` though db.ts:86 + `list_events` exist); **DL-18** (P3 Improvement, conversion-retention — RUNNING.md never mentions the daemon/web-UI, so the canonical onboarding dead-ends before the shipped observe surface; docs-only cross-link to DAEMON.md, verified `grep` returns no matches today); **DL-19** (P3 Improvement, trust-safety — the only write surface, `POST /roadmap/{save,publish}`, has no Origin/Host/Referer guard, so a same-origin-exempt urlencoded CSRF or DNS-rebind reaches it past the 127.0.0.1 bind; add an Origin + Host allowlist, defense-in-depth on the operator-gated DL-3 path); **DL-20** (P3 Improvement, competitive-parity — `boardPage()` renders ALL tickets with no filter while `/api/tickets` already filters by state/type/label; add server-side filter/search to the HTML board, no client JS). **Parked (overflow, not flooding Todo):** the P4 board summary-band + a nav active-highlight (see Candidate ideas). All 8 rubric lenses now swept at `8ad763b`; next fires go quiet until HEAD moves, the doc changes, the backlog drains again, or the operator redirects.

- **2026-06-23 — SHIPPED: DL-17 `/activity` events-ledger view verified Done (PM).** Dev's commit `5e55bcf` adds a read-only GET `/activity` route over the append-only `events` ledger — recent-events feed (issue.create / issue.transition{from→to} / comment.add), throughput (transitions into Done, 7d + 30d), per-actor activity (30d), and per-ticket cycle time with a graceful fallback — all pure SELECTs through the `query_only` connection, nav-linked. **Verified against the running product, not the diff:** `npm test` green (all 9 suite markers incl. the DL-17 daemon assertions + `MIRROR_OK`); plus a live smoke against the REAL hub.db (ephemeral port 51801, bind confirmed via the daemon's own log to dodge the leaked test daemons on 8795–8797) — `/activity` returns 200 with all four sections rendering real attribution (dev 53 / pm 33 / qa 14 over DL-1…DL-20) and POST → 405. AC5/AC6 code-confirmed (defensive `eventData()` JSON parse, null-`ticket_id` guard, `esc()` throughout, `query_only=ON` preserved). **This closes the data-analytics gap** — the observe+steer metrics the Vision needs are now surfaced in the browser. Backlog remains healthy: **DL-18/19/20** Todo (Dev working them down) + **DL-12** operator-parked. Code SHA → `5e55bcf`; the swept-lens conclusions carry forward (DL-17 only *added* `/activity`; the board/ticket/roadmap/reports surfaces the other lenses covered are unchanged). **No new sweep this fire** — padding a healthy 3-ticket queue is a smell; the bottleneck is Dev clearing DL-18→20.

- **2026-06-23 — SHIPPED: DL-18 RUNNING.md → daemon/web-UI cross-link verified Done (PM).** Dev's commit `7aff956` (docs/RUNNING.md only, +17 lines) adds an `### Observe the loop — the read-only web UI` subsection: the `npm run daemon` start command + the `http://127.0.0.1:8787/` board URL, a cross-link to `DAEMON.md`, and an explicit "read-only + localhost-only (`query_only=ON`, binds 127.0.0.1) — observe, not a control plane" note. Verified: AC4 `grep -ciE 'daemon|8787|DAEMON.md' docs/RUNNING.md` → **3** (baseline 0); DAEMON.md link target present; all 4 ACs met. **Accepted Dev's placement call** — under §4a (the hub backend) rather than the generic §2 Launch, since the daemon reads `hub.db` and §2 would mislead Linear-backend operators (the AC's "e.g. under Launch" was non-binding). **Closes the conversion-retention gap** — the install→observe funnel no longer dead-ends before the shipped daemon. Code SHA → `7aff956` (docs-only; product surfaces unchanged, swept lenses carry forward). Backlog: **DL-19/20** Todo + **DL-12** parked — bottleneck still Dev. (Note for a future docs touch, not this ticket: DL-18 deliberately omitted the `/activity` view since DL-17 was unverified at filing; now that DL-17 is Done, RUNNING.md *could* name it — minor, parked.)

- **2026-06-23 — SHIPPED: DL-19 Origin/Host write-guard verified Done (PM).** Dev's commit `ed6a4a8` (daemon.ts +27, test/daemon.ts +29) adds `writeOriginOk(req)` to the only write surface (`POST /roadmap/{save,publish}`): rejects a non-`127.0.0.1`/`localhost` Host (DNS-rebind) and a cross-origin Origin/Referer (CSRF), wired **before** `handleRoadmapWrite` so a refused write returns 403 and mutates nothing; absent-Origin+Referer allowed (non-browser clients). Verified: code-reviewed the guard + placement (daemon.ts:311/494); all 5 DL-19 test assertions pass deterministically (foreign Origin→403, foreign Host→403, no-version-change, same-origin→303+draft) against the throwaway test db (NOT the real board — write-path discipline); existing roadmap/publish/§17-injection suites stay green. **Closes the trust-safety gap** (defense-in-depth on the operator-gated DL-3 path). Code SHA → `ed6a4a8`; swept lenses carry forward (the change is confined to the roadmap write path the trust-safety lens already covered). Backlog: **DL-20** Todo + **DL-12** parked.
- **2026-06-23 — WATCH (QA lane): flaky loop-suite test surfaced during DL-19 verify.** The check *"dedupe query scans DESCRIPTION not just title"* (`hub/test/loop.ts:39`) failed **1 of 5** full `npm test` runs but is **0/4** standalone (`node test/loop.ts` always green) → it flakes **only** under the full suite, suggesting a cross-suite shared-state/isolation interaction in the `node:sqlite` SoR (not DL-19 — that touches only daemon.ts + test/daemon.ts, and the daemon suite runs last while loop runs 2nd). **A flaky green-gate is harmful** (can block a real ship or mask a regression). Flagged for **QA** (a defect = QA's lane). **Not filed as a Bug yet** — the loop is healthy/not-stalled; per the lane rule PM self-files a Bug only if a confirmed defect stays unfiled across multiple fires while the loop is stalled. PM is watching: if it recurs and QA hasn't picked it up while the queue drains, PM will file it as a `Bug`+`qa` with this repro. **UPDATE — now filed as DL-21 (see below).**

- **2026-06-23 — SHIPPED: DL-20 server-side board filter/search verified Done (PM) → PM-sweep milestone COMPLETE.** Dev's commit `24dc173` (daemon.ts +52/-6, test/daemon.ts +20) adds query-string filter/search to `boardPage()` — `?state/type/label/assignee` (mirrors `/api/tickets`) + free-text `?q=` over id/title, a clearable deep-linkable control row, filter-aware empty state; no client JS, `query_only` preserved, no write route. Verified against the running product (real hub.db, ephemeral port: 20 cards → `?type=Improvement` 8, `?state=Todo`→DL-12, `?q=activity`→DL-17, chip + clear-all render, `?q=<script>`→escaped, POST/→405) + 10 deterministic daemon-suite assertions. **Closes the competitive-parity gap.** **This completes the PM 2026-06-23 6-lens sweep — DL-17 (data-analytics) · DL-18 (conversion-retention) · DL-19 (trust-safety) · DL-20 (competitive-parity) all shipped + verified Done.** Buildable backlog **drained again**: only **DL-12** (operator §17 commit) + **DL-21** (QA's flaky-test Bug) remain. Code SHA → `24dc173`; all 8 lenses swept (carry forward — confined to boardPage).
- **2026-06-23 — FILED: DL-21 (Bug, qa) — flaky loop-suite events/dedupe assertions under full `npm test`.** Per the §2 lane exception, PM filed the QA-lane flaky test (flagged across the DL-19 + DL-20 fires, unaddressed by QA, loop now stalled with the buildable queue drained) as a `Bug`+`qa` (QA owns verification) rather than emit another no-op. Repro: the loop suite's `dedupe-by-description` / `events-attribute-distinct-actors` / `events-carry-kinds` checks flake ~1-in-3–5 under sequential `npm test` but are 0-fail standalone → cross-suite SoR/events isolation defect (not caused by DL-17–20; the daemon suite runs last, loop 2nd). Not a product-code regression — a test-harness isolation fix (acceptance: green across 10 consecutive full runs). **Loop status: idle-complete again** — Dev queue empty; awaiting the operator (DL-12, + optional `run-loop.sh` enable) or QA (DL-21) or a new theme (点评-from-UI §22 carve-out / hub hardening / portability).

- **2026-06-23 — APPLIED (operator): DL-12 §17 cwd-rung wording → cwd auto-select FULLY COMPLETE; loop 22/22 Done.** The operator applied DL-12 by git commit `ea2ab98` (`references/conventions.md` +18/-7, `skills/pm-agent/SKILL.md` 1 line — the §17 self-evolution scope, no product code). Verified all 4 ACs present: §11 ladder now has the **cwd rung** (canonical `realpath` + segment-boundary containment + nearest-ancestor on overlap; equal-depth tie ⇒ fall through) **and** the restored **`defaultProject` rung**, with precedence *explicit choice > cwd-match > configured default > prompt* (strictly additive — a cwd outside every repo ⇒ prior behavior); the SKILL §0 chain names "the cwd-matched project (§11)"; §18/§26 mark `DEVLOOP_PROJECT` **optional** with the cwd fallback, firewall language preserved. **This completes the cwd→project auto-selection feature end-to-end** (resolver+hub DL-13 ✅ · launcher/config/docs DL-15 ✅ · §11/SKILL agent-side wording DL-12 ✅) — a fresh PM/QA/Dev fire from a repo checkout with no `DEVLOOP_PROJECT` now selects that repo's project per the new ladder. **DL-12 was PM's own §17 proposal**; an agent must never self-apply it (§17), so the operator's commit is exactly the intended path. **The board is now 22/22 Done with nothing open or parked** — the entire operator-set milestone + the PM 6-lens sweep (DL-17–20) + the QA bug-fixes (DL-6/7/9/11/21) + DL-22 are all shipped & verified. Code SHA → `ea2ab98` (the §17 change touches the loop's *operating instructions*, not the reviewed product surfaces — the 8 rubric lenses carry forward unchanged). **Next direction is entirely the operator's** (the deferred candidate themes below: 点评-from-UI §22 carve-out, hub/`service` hardening, broader portability, inter-agent discussion daemon, multi-stakeholder roadmap auth) — until then PM stays in steady-state no-op.

## Candidate ideas

_(The daemon/web-UI/roadmap-bridge and README-drift ideas below were filed as DL-1…DL-5 on
2026-06-23 per the resolved decision above; this list is the remaining overflow parking lot.)_

- **Inter-agent discussion daemon (deferred).** The Vision also names the daemon "owning
  inter-agent communication and discussion." Today that plane is the **poll-based, no-daemon**
  §25 board + P6 channel. Moving it into a persistent process is a larger architectural step
  that touches the stateless-per-fire contract and the §17 firewall — defer until the
  read/edit daemon (DL-1…DL-4) is proven, then scope as its own initiative.
- **Hub/`service` hardening pass** (supporting goal): widen `doctor` coverage and edge-case
  tests for the `node:sqlite` SoR that the daemon will build on (file as the daemon backlog
  drains and concrete gaps surface).
- **Multi-stakeholder roadmap auth** (future persona): once the web UI exists, distinguish
  operator vs. non-operator roadmap stakeholders beyond the single operator-publish gate.
- **Reports + 点评 review in the web UI** (ux-flows lens, PM 2026-06-23): the operator's
  *observe-and-steer* flow is today purely file-based (read `reports/<agent>/**`, drop a
  `<report>.review.md` 点评 sibling). **UPDATE 2026-06-23:** the operator asked for this directly,
  and the **read half** is now filed as **DL-10** (surface the daily/weekly/monthly reports in the
  web UI). **Remaining follow-up (DL-10 has now landed):** accepting a **点评 *from* the web UI** (a
  write path that drops a `<report>.review.md` sibling) — closes the operator-feedback loop without a
  terminal; reuses DL-10's reports view + a guarded write path like DL-3's roadmap edit. **⚠️ §17/§22
  firewall constraint (load-bearing — do NOT file as a naive Dev ticket):** conventions §22 states
  *"agents never write a `*.review.md` file — ever,"* because that's exactly what makes any on-disk
  review operator-authored-by-construction (the spoof-proof trust boundary). A daemon write path
  therefore needs a **conventions §22 carve-out** — "the localhost daemon MAY write a `*.review.md`
  ONLY for an operator-submitted 点评 via the web UI (the operator IS the author; localhost-trust),
  attributed/audited as such" — which is a **§17-gated `[pm-proposal]`** (operator applies), paired
  with a buildable daemon `POST /reports/<agent>/<level>/<date>/review` slice (path-validated, §16-safe,
  CSRF/same-origin-guarded since it's a write). Scope it like the cwd feature (DL-12 proposal +
  DL-13/15 buildable) — i.e. a small design pass, not a one-shot ticket. Awaiting operator
  prioritization vs. the supporting goals (hub hardening + portability) now that the milestone is done.
- **Web-UI fidelity polish (ux-flows lens, PM 2026-06-23).** **UPDATE 2026-06-23: filed as DL-16** (items a+b: render markdown ticket/comment bodies via the existing renderMarkdown + show created/updated timestamps), now that the milestone backlog drained. Item (c) below (non-API path → JSON not HTML-404) remains a minor optional note. Lower-value read-view
  refinements found alongside DL-8, parked to keep the Dev-bottlenecked Todo signal-rich: (a)
  ticket/comment bodies render as **raw markdown** inside a `<pre>` block — a tiny inline
  markdown→HTML renderer (no native deps, hub doctrine) would match the "Linear-like" Vision; (b)
  the detail view omits **created/updated timestamps**; (c) an unknown **non-API** path returns
  JSON (`{"error":"not found"}`) instead of the friendly HTML 404 the ghost-ticket route already
  serves. File as the daemon backlog drains.
- **Board summary band (data-analytics lens, PM 2026-06-23 — P4 polish, parked from the 6-lens sweep).**
  `boardPage()` renders one section per state with only a per-column count; no at-a-glance composition
  by **type / owner / priority** above the columns. Pure read-only aggregate over the existing
  `query_only` db (no new table, no write route). **Deliberately parked rather than filed** — it overlaps
  the same `boardPage()` surface as the filed DL-20 (filter/search) and is convenience polish at the
  current ~16-ticket scale; file it (or fold it into DL-20's implementation) when the board grows or
  DL-20 lands. Buildable when filed — no §17/§22 gate.
- **Web-UI header nav: active-surface highlight (consistency lens, PM 2026-06-23 — marginal, parked).**
  Highlight the current surface in the header nav (board / roadmap / reports / the DL-17 `/activity`).
  Cosmetic parity polish with no observe/steer payoff — fold into a future nav pass alongside the
  `/activity` nav link DL-17 adds, rather than its own ticket. (The "labeled board item" half was
  redundant with the existing wordmark-as-home at `daemon.ts:127`.)
