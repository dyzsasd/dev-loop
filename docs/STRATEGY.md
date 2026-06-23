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
- **Obvious gaps vs. the Vision:** there is **no daemon, no web UI, and no roadmap
  view/edit surface** today — the inter-agent "discussion board" and the Lark/Slack
  channel exist as **poll-based, no-daemon** mechanisms, not a persistent service with a
  UI. This is the headline gap the Vision/Goals target.

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
