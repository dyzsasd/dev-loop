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
- **Obvious gaps vs. the Vision:** _(updated 2026-06-23 PM)_ the **daemon** (DL-1) and a
  read-only **board/ticket web UI** (DL-2) now exist (verified Done). Remaining gaps: **no
  roadmap view/edit surface** (DL-3, Todo), **no Lark/Slack roadmap bridge** (DL-4, Todo),
  and the inter-agent "discussion board" + Lark/Slack channel still exist as **poll-based,
  no-daemon** mechanisms (moving them into the persistent process is the deferred
  candidate). The remaining headline gap the Vision/Goals target is the roadmap
  view/edit/steer surface.

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
  web UI). **Remaining follow-up:** accepting a **点评 *from* the web UI** (a write path that drops
  a `<report>.review.md` sibling) — closes the operator-feedback loop without a terminal; file once
  DL-10 lands (it reuses DL-10's reports view + needs a guarded write path, like DL-3's roadmap edit).
- **Web-UI fidelity polish (ux-flows lens, PM 2026-06-23, overflow).** Lower-value read-view
  refinements found alongside DL-8, parked to keep the Dev-bottlenecked Todo signal-rich: (a)
  ticket/comment bodies render as **raw markdown** inside a `<pre>` block — a tiny inline
  markdown→HTML renderer (no native deps, hub doctrine) would match the "Linear-like" Vision; (b)
  the detail view omits **created/updated timestamps**; (c) an unknown **non-API** path returns
  JSON (`{"error":"not found"}`) instead of the friendly HTML 404 the ghost-ticket route already
  serves. File as the daemon backlog drains.
