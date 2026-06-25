# dev-loop — Strategy

> PM's north star. Seeded by `/dev-loop:init` on 2026-06-23 (operator-present setup).
> `Current state` was seeded once from a read-only code map; `Vision` / `Goals` /
> `Non-goals` / `Personas` come from the operator interview. PM owns this doc thereafter
> (append-only — record shipped progress and new direction here so it stays a living
> north star, not a stale snapshot).

## Vision

dev-loop is a **standalone, long-lived coordination daemon** with **interchangeable AI-CLI
clients**. The daemon is the system of record (the `node:sqlite` hub), the coordination
service, the local web UI, and the agent-facing API — one persistent localhost process per
project. Any coding-agent CLI — Claude Code, Codex, opencode, … — connects TO this daemon as
an interchangeable client (via a thin stdio MCP shim, the `dev-loop` CLI, or a per-CLI plugin)
to operate tickets, post discussion, read the board, and steer the roadmap. The agents stay
**stateless per fire**; the daemon owns the shared state they coordinate through.

The loop still builds and maintains software through a shared ticket blackboard, steered by
operator **review (点评)** rather than by editing agent code. What changes is the substrate:
coordination moves from "N per-pane stdio processes + an optional read-only web view, all
poking one SQLite file" to "one daemon that owns the writer and serves both humans (web UI,
roadmap edit, chat bridge) and agents (the coordination API) from a single running service."

**Scope now — SINGLE-HOST, MULTI-CLI.** One machine, one trusted operator, multiple CLIs all
talking to ONE local daemon over loopback (127.0.0.1). Identity stays **cooperative
attribution** (`DEVLOOP_ACTOR` per pane, forwarded to the daemon) — honest, not anti-spoof:
on one host any local process can name any actor, so attribution is an accountability and
accident-prevention aid, not a wall. **Remote / multi-user / network deployment and a real
token-auth model are an explicitly DEFERRED later phase** — named as the boundary, not built.

**This is a deliberate reversal of the prior "no daemon" doctrine** (HUB-ARCHITECTURE §6/§14):
the hub was daemon-free by principle, with a daemon foreseen only if a push-webhook chat was
ever wanted. The operator has decided the daemon IS the destination — it is what makes the web
UI turnkey and lets the daemon own coordination. The reversal is bounded and honest: the
daemon is **localhost-only**, agents stay **stateless per fire**, and **the existing
daemon-free paths keep working byte-for-byte** — the stdio MCP server, the read-only web
daemon, and the `linear` / `local` / `service` backends are all preserved. The new
daemon-primary path is **strictly additive and opt-in**: a project that doesn't enable it is
unaffected.

The transport is chosen to dodge a known trap: each CLI talks to the daemon through a **thin
stdio MCP shim** that carries identity via an **environment variable**, never an HTTP
`Authorization` header — because headless `claude -p` drops that header on tool calls, which
would silently strip attribution from every fire. The per-CLI **identity gate** (call
`whoami` through the CLI, expect the launcher-set actor) stays the onboarding test for every
new client.

The invariants are non-negotiable and transport-independent: the **§17 self-evolution
firewall** (no agent ever auto-edits a SKILL / conventions / plugin / code file — structural
changes are operator git commits, surfaced as proposals), **§2 project isolation** (one daemon
= one pinned project, no cross-project endpoint), and **§16 secrets/localhost-only** (binds
127.0.0.1 only; secrets live in env, referenced by name, read server-side; the SoR holds no
plaintext credential). The phased build is in `docs/design/daemon-multicli-repositioning.md`.

## Goals (north star)

**SHIPPED (operator, 2026-06-23):** the daemon + web UI + roadmap view/edit + Lark/Slack
bridge (DL-1 / DL-2 / DL-3 / DL-4) — all Done.

**Top priority (operator, 2026-06-24): the STANDALONE-DAEMON + MULTI-CLI repositioning** (Vision
above). Build it as an additive, phased arc — each phase independently shippable, the loop runnable
throughout, every current path (stdio MCP, read-only daemon, `linear`/`local`/`service` backends,
the Claude plugin) unbroken byte-for-byte. **Full design + critique-folded decisions:
`docs/design/daemon-multicli-repositioning.md`.** PM drives the backlog from these phases:

- **P1 — Turnkey on-ramp.** ✅ **COMPLETE** (DL-41 lifecycle + DL-42 SessionStart hook + DL-43 op-API — all verified Done). `dev-loop daemon ensure` (pidfile + `hub.port` + a real `/api/health`
  liveness check, no double-start, one-per-project on a cwd-resolved port, DL-13) + auto-start the
  web UI on install/session (a Claude `SessionStart` hook — the hook half is a §17 `[pm-proposal]`
  for operator git-commit; the lifecycle/CLI half is Dev-buildable). Mount the agent op API
  (`POST /api/op/*`) DORMANT, gated on an explicit `hub.transport:"daemon"` setting (**default-off**
  → a current read-only-daemon project gets ZERO new surface). E2E: install → web UI up → an MCP
  ticket change shows in the UI, zero manual `npm run daemon`.
- **P2 — The thin stdio MCP shim.** ✅ **SHIPPED** (DL-55 + the **(3/n)** doc/event widening **DL-62, both verified Done 2026-06-25**). The shim now proxies **13 of `server.ts`'s 29 tools** (5 ticket + `whoami` + `list_events` + 6 `doc.*`). The remaining 16 → the 100% drop-in are filed family-by-family (the DL-55/DL-62 one-family discipline, not the 16-op mega-ticket): **(4/n)** discussion-board (`topic.*`+`post.add`) = **DL-64** (filed); **(5/n)** `channel.*`; **(6/n)** `mirror.*`+labels+`get_project`. The drop-in is the P3 (single-writer + dispatch-convergence) precondition. `shim.ts` proxies tool calls to the loopback daemon op API;
  identity rides env→`X-Devloop-Actor` (dodges the `claude -p` header-drop). Relies on the existing
  WAL + `busy_timeout` serialization (single-writer is a P3 optimization, not a P2 prerequisite).
- **P3 — Daemon as canonical single writer** (+ periodic `wal_checkpoint(TRUNCATE)`); the direct-db
  stdio `server.ts` stays a back-compat fallback.
- **P4 — Standalone packaging.** `npm i -g dev-loop` (core + daemon + shim + CLI + CLI-agnostic
  shared prompts), Claude-independent; reshape the Claude plugin to thin; a single-version release
  script stamps `package.json` + `plugin.json` + `marketplace.json`; the shim path via a `dev-loop`
  PATH bin.
- **P5 — Multi-CLI hardening.** Certify a 2nd CLI (Codex) end-to-end on the daemon-primary path; add
  MCP-over-HTTP only if it passes the header identity gate.
- **Phase B — DEFERRED (named, not built):** remote / multi-host / multi-user + the `agent_tokens`
  auth model. The daemon's per-request actor-resolution function is the seam it slots into.

**Hard invariants (transport-independent, every phase):** §17 firewall (no agent auto-edits a
SKILL/conventions/plugin/code file — structural changes are operator-committed proposals);
§2 isolation (one daemon = one pinned project, no cross-project endpoint); §16 (binds 127.0.0.1
only; secrets in env by name); identity is **cooperative, not anti-spoof** on one host (honest);
every mutating op-API endpoint passes the `writeOriginOk` CSRF/DNS-rebind guard first. Honest
caveat: `doc.publish` over the op API becomes a cooperative (claim-based) gate vs today's
daemon-process-identity gate — acceptable on one trusted host, revisit under Phase B.

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

- **2026-06-24 — SHIPPED: the "agile, adapted for AI agents" workflow redesign (W1/W2/W3) — second milestone.** Following the operator's design lock-down (`docs/DESIGN-agile-for-ai-workflows.md` §11 "Locked decisions (FINAL)"), the loop built and verified the workflow model end-to-end: **D1** per-transition `assignTo` directive (DL-24) · **D2** W3 PM parent-close + durable child→parent `relatedTo` back-link (DL-23) · **D3a** `Human-Blocked` promoted to a real CHECKed state via `user_version` migration (DL-25) · **D3b** daemon-side periodic Human-Blocked notifier (DL-26) — incl. the two QA-found bugs **DL-33** (per-TICK send cap; never permanently silent) + **DL-34** (write-free dry-run) and a regression test (DL-27) · **D-W3** opt-in daemon human web-write routes create/comment/move/assign (DL-29) · **D-HB-wiring** Human-Blocked into conventions §3 + agent SKILLs (DL-30) · **D-review-fail** close+follow-up as the universal verify-fail behavior (DL-28) · plus assignee **swimlanes** board (DL-31) and the **save_issue/save_comment convergence onto `ticketwrite.ts`** (DL-35, In Review qa). **Net:** every §11-locked decision is implemented; the only designed-not-built piece remaining is **Subsystem E — release/env gating (DL-32)**, which the operator deferred during the redesign. Code SHA → `a94d50b`. The redesign touched real product surface (web board swimlanes, web-write routes, the state enum) so the 8 rubric lenses reset at `a94d50b`; strategy-gaps swept this fire.
- **2026-06-24 — PROMOTED: DL-32 release/env gating (Subsystem E) Backlog → Todo (p2).** With the operator-set milestone *and* the W1/W2/W3 redesign both shipped and the Todo lane drained, re-opened the rotation and promoted the last designed-not-built feature so the idle Dev lane has its next pick. Firmed the ticket from a one-line design summary into a structured, testable spec grounded in design §7: `env:dev`/`env:prod` LABELs under the existing `workflow` kind (no schema ALTER), `requireDeployBeforeReview` as a named `staging-deploy` gate enforced in the converged `applyTicketWrite` (post-DL-35) **with the mandatory no-deploy carve-out**, `prodPromotionGate:"human"` (cooperative attribution, not anti-spoof), promotion-only gating (demotion always allowed), no label backfill, `issue.promote {from,to}` event replayed in `/activity`, and **all guards default OFF** (opt-in via `settings_json.workflow.release` — zero behavior change otherwise; a regression test must prove it). Buildable now — no §17/§22 gate. PM verifies on the In-Review handoff.
- **2026-06-24 — FILED: DL-37 DAEMON.md staleness (conversion-retention lens at `6a83e3e`).** With DL-32 picked up by Dev (In Progress) and DL-36 queued, swept conversion-retention: the onboarding funnel (README DL-5, RUNNING.md DL-18) is current, but `docs/DAEMON.md` — the canonical daemon doc — still describes the **DL-1 read-only foundation**. Two real gaps: (1) a now-**false safety claim** ("Read-only. Only GET/HEAD are served; no endpoint mutates") since the daemon serves `POST /roadmap/{save,publish}` (DL-3) + opt-in `POST /ticket`,`/ticket/:id/{comment,move,assign}` (DL-29); (2) **no adoption path** for the shipped human web-write feature (`settings_json.humanWrite.enabled`, operator-set only per design §11, `writeOriginOk` boundary DL-19). Filed **DL-37** (Improvement, p3, docs-only) to correct the posture, document the write surface + its gates, and add the missing read views (`/roadmap`,`/reports`,`/activity`, board filters, `?group=assignee`). Deduped vs DL-5/DL-18 (neither touched DAEMON.md). A product doc → Dev lane (not a PM self-edit; PM only edits the strategyDoc directly).
- **2026-06-24 — SHIPPED + VERIFIED: DL-32 slice A — release/env gating (env labels + prod-promotion gate + `issue.promote`).** Dev's commit `d618d6b` (server.ts +34, seed.ts +3, daemon.ts +1, new test/release.ts +111) lands 6 of the 8 DL-32 ACs: `env:dev`/`env:prod` as workflow-kind LABELs (no new state, no schema ALTER; ride `ensureLabels`); `prodPromotionGate:"human"` rejects a non-operator ADDING `env:prod` on update AND create, operator may (cooperative attribution, not anti-spoof); demotion always allowed; `issue.promote {from,to}` emitted in-txn + replayed in `/activity`; all default-off. **PM verified → Done**: full suite green (308 checks/13 suites, RELEASE_OK), code-reviewed `prodPromotionRejection` in server.ts. Accepted Dev's SPLIT (the ticket was clear-but-large with one genuinely ambiguous sub-part).
- **2026-06-24 — DECISION + UNBLOCKED: DL-38 — the `requireDeployBeforeReview` deploy gate (DL-32 slice B).** Dev split this out `blocked`+`needs-pm` on a real architecture question: the no-deploy carve-out keys on "the repo deploys", but `deploy.command` lives agent-side (projects.json) and the hub (where the gate enforces) can't see it. **PM decision: OPTION (a)** — the hub carries its own operator-set signal `settings_json.workflow.release.deployRepos:["<repo>"]` matched against the §19 `repo:<name>` label (single-repo → `hasDeploy:true`). Rejected (b) [enforcing agent-side makes the *machine* gate advisory + a §17 skill change — contradicts §7] and (c) [a less-structured (a)]. Also resolved the enforcement surface: enforce in the shared `applyTicketWrite` path so it covers BOTH the MCP `save_issue` transition AND the daemon board-move (DL-29) — the gate is label+repo based, no ACTOR needed. ACs rewritten with the decision baked in; cleared `blocked`+`needs-pm` → Todo (p2). Subsystem E will be **fully shipped** once DL-38 lands.
- **2026-06-24 — SHIPPED + VERIFIED: DL-36 (friendly HTML 404 for non-API paths) + DL-37 (DAEMON.md accuracy rewrite).** Both PM-verified Done. **DL-36** (`c08d622`): the daemon catch-all now serves the styled HTML 404 for unknown non-API paths (`seg[0]==="api"` → JSON unchanged) — closes the ux-flows dead-end; verified live (`/totally/bogus`→404 text/html, `/api/bogus`→404 JSON, POST/→405). **DL-37** (`cb3c480`, docs-only): `docs/DAEMON.md` rewritten from the stale "DL-1 read-only foundation" to "read by default, opt-in operator write" — the false safety claim is gone, the DL-29 web-write adoption path (`settings_json.humanWrite.enabled`, operator-set, `writeOriginOk`) is documented, and the missing read views (`/roadmap`,`/reports`,`/activity`, filters, `?group=assignee`) are listed. **Board status: the only open ticket is DL-38** (Subsystem E slice B). Everything else is Done — both operator milestones + the W1/W2/W3 redesign + the PM proactive-review sweep (ux-flows DL-36, conversion-retention DL-37).
- **2026-06-24 — 🏁 SHIPPED + VERIFIED: DL-38 staging-deploy gate → Subsystem E COMPLETE → the entire designed roadmap is shipped.** Dev's `8649c18` (ticketwrite.ts +53, server.ts -refactor, test/release.ts +48) lands the `requireDeployBeforeReview` gate exactly to the Option-(a) decision: `In Progress → In Review` is rejected when `requireDeployBeforeReview:true` AND the ticket's repo deploys (`repo:<name>` ∈ `deployRepos`, or single-repo `hasDeploy`) AND it lacks `env:dev`; non-deploying repos bypass (carve-out, no deadlock); default-off. Enforced in the shared `updateTicketRow` (post-DL-35 converged path) so the **daemon board-move (DL-29) is gated automatically** — a `moveTicket` test asserts it; `loadRelease` converged with DL-32's prod gate; `updateTicketRow` is now fallible (rejection writes nothing). **PM-verified Done**: 319 checks / 13 suites green (RELEASE_OK), all 6 ACs + the daemon-move surface. Accepted the framing note (staging-deploy semantics under `workflow.release` rather than a generic named-gates registry — composes with the config, not a parallel mechanism; a registry for one gate would be over-engineering). **DL-32 complete across both slices ⇒ Subsystem E (release/env gating, design §7) fully shipped.** This was the last designed-not-built piece: **both operator milestones + the W1/W2/W3 "agile-for-AI" redesign + all five §7 subsystems are now shipped & verified.** Remaining open work: DL-39 (docs reconcile — the milestone docs capstone, In Progress). Beyond that, the active themes are the **supporting goals** (hub/`service` hardening, agent-skill robustness [§17-gated], operator polish, broader portability) + the deferred candidates below — awaiting operator prioritization.
- **2026-06-24 — ✅ SHIPPED + VERIFIED: DL-39 docs reconcile → board 39/39 Done; + trust-safety sweep of the write surfaces (clean).** Dev's `e51f03f` (README.md + docs/RUNNING.md, docs-only) reconciled README v0.19.2→**v0.20.0** (matches `.claude-plugin/plugin.json`) with the second-milestone feature summary, and reframed RUNNING.md's daemon section to "read by default + opt-in operator write surfaces (link DAEMON.md)" while keeping the true MCP-is-the-coordination-plane point — consistent with DAEMON.md (DL-37). PM-verified Done. **The board is now fully Done (39/39); Dev idle.** With the backlog drained, ran the **trust-safety** lens over the newly-shipped write/attack surfaces: **no gap found** — `writeOriginOk` (CSRF + DNS-rebind) guards BOTH the roadmap and ticket-write routes before any mutation; a 1 MB `MAX_BODY` cap (with overflow/abort handling) bounds POST bodies; the read path stays `query_only=ON`; localhost-only bind; human web-write is opt-in + operator-gated; comments/descriptions render as DATA (`esc()`, no command-verb parser). The cooperative-attribution `prodPromotionGate` is a documented (design §11) non-anti-spoof limitation, not a defect. **Steady-state reached.** Next: rotate the remaining proactive-review lenses (consistency / competitive-parity / polish-performance) on subsequent fires, and file hub-hardening / portability work as **concrete** gaps surface (never vague) — the supporting goals await operator prioritization.

- **2026-06-24 — NEW OPERATOR DIRECTION (strategy doc `b9ed9fe`): TURNKEY LOCAL EXPERIENCE → decomposed + filed DL-41/42/43.** The operator set a new top priority — auto-start the web UI on install/session + unify MCP↔daemon (E2E target: *install → web UI up → an MCP ticket change shows in the UI, zero manual daemon start*). PM (first fire to see `b9ed9fe`; board was 39/39 Done, Todo drained) reviewed the **live** daemon/MCP/plugin architecture and decomposed it on the §17 boundary:
  - **Key insight — thread 1 alone delivers the operator's stated E2E target.** The daemon and the stdio MCP already share `hub.db`, so once the daemon **auto-starts**, an MCP `save_issue` already shows in the web UI. The headline acceptance therefore needs only the auto-start *lifecycle*, not the (deeper) one-process unification — so thread 1 leads, thread 2 follows.
  - **Thread 1 (auto-start) — filed `DL-41` (Feature/pm/P2, BUILDABLE):** an idempotent per-project daemon lifecycle (`daemon up|down|status`) — cwd→project resolve (reuse DL-13), stable per-project port, single-instance guard (today's daemon is a single fixed `8787`, foreground, no guard — daemon.ts:833/860), detached localhost spawn, clean stop/restart, no-op + exit-0 for a non-service project. Plus `DL-42` (`[pm-proposal]`, §17-PARKED): the SessionStart hook in `.claude-plugin/plugin.json` (which has **no `hooks` field** today) that calls `daemon up` — a plugin-config self-edit ⇒ operator git-commit only (`blocked`+`needs-pm`+`external-prereq`, exactly like DL-12 `ea2ab98`). `relatedTo` DL-41.
  - **Thread 2 (unify MCP↔daemon) — filed `DL-43` (Feature/pm/P3, BUILDABLE, increment 1/n):** the daemon-side foundation — an **opt-in, default-off** loopback `POST /agent/rpc` serving the core ticket tools with **per-agent identity** via an `X-DevLoop-Actor` header (cooperative localhost attribution — the documented §18 model, not anti-spoof), reusing the shared `ticketwrite.ts` (DL-35); the stdio `server.ts` stays untouched. **Sequenced follow-ups (NOT yet filed — file as DL-43 lands; see Candidate ideas):** (2/n) the stdio thin-client mode proxying to the loopback (the dispatch-sharing refactor); (3/n) widen the surface to `doc.*`/`topic.*`/`channel.*`.
  - **Constraints baked into every AC** (operator's): strictly additive + opt-in (a non-user project byte-for-byte unaffected), no regression to today's stdio MCP / read-only daemon, localhost-only (§16), per-agent identity preserved, any plugin-config/SKILL/conventions edit through §17. Reviewed SHA → `b9ed9fe` (a docs-only operator commit — no product code moved; strategy-gaps swept this fire, lenses reset at the new SHA).

- **2026-06-24 — RECONCILED to operator north-star redirect `8857c0a` (standalone daemon + single-host multi-CLI); aligned DL-41/DL-43 ACs to the new design doc.** AFTER PM filed DL-41/42/43 at `fb019a2`, the operator committed `8857c0a` (docs-only): rewrote `## Vision` + `## Goals` into a phased **P1–P5 + deferred Phase B** arc and added the authoritative, critique-folded design `docs/design/daemon-multicli-repositioning.md` (designed via a Workflow — 1 design + 2 adversarial critics; architecture SOLID, safety fixes folded). Doc-watch **and** the SHA-gate both fired (HEAD `fb019a2`→`8857c0a`; STRATEGY.md hash changed). This is fresh operator direction → **resolved into the in-flight tickets this fire (no new tickets — the P1 backlog already exists):**
  - **P1 (turnkey on-ramp) = DL-41 + DL-42 + DL-43, already filed.** The redirect reframed/extended direction (P2–P5 are future) but added **no new P1 work**, so no new Todo this fire (the buildable queue is already DL-41/DL-43; DL-42 operator-parked). Padding Todo would be a smell.
  - **DL-41 (lifecycle, Dev-buildable):** amended the health-check AC from a bare `/` port probe → a **real `/api/health` DB-writable liveness check** (design P1: a wedged-but-bound daemon must read NOT healthy, so `up` recovers it); noted `up`≈`daemon ensure`. *Dev claimed DL-41 → `In Progress` mid-fire*; the append-only AC edit preserved the claim, and I posted an explicit heads-up comment so the in-flight build targets `/api/health`.
  - **DL-43 (dormant op-API, Dev-buildable):** amended the wire-shape to match the design so **P2's shim lines up (avoids rework)** — endpoint `POST /api/op/*` (1:1 MCP op-shapes, not `/agent/rpc`), gating `hub.transport:"daemon"` default-off (not `settings_json.daemon.agentApi.enabled`), and the per-endpoint guard order (`writeOriginOk`→`X-Devloop-Actor`→G1 actor→G2 project→attributed event→`mode`, design Decision #4); reuse `ticketwrite.ts`, `server.ts` untouched; linked `relatedTo` DL-41.
  - **DL-42 ([pm-proposal] SessionStart hook):** confirmed still aligned with the published P1 (§17-parked, operator git-commit, depends on DL-41) — no change.
  - **P2–P5 are future phases** in the design doc + Candidate ideas (P2 thin stdio shim · P3 daemon single-writer · P4 standalone `npm i -g dev-loop` packaging · P5 multi-CLI/Codex cert); file the next increment **as P1 lands** (never one mega-ticket — Dev would block it). Reviewed SHA → `8857c0a` (docs-only; no product code moved → strategy-gaps swept, the product-surface lenses carry forward from `e51f03f`). Loop status: **Dev-bottlenecked** — DL-41 In Progress, DL-43 Todo; awaiting Dev (and the operator on DL-42).

- **2026-06-24 — 🏁 SHIPPED + VERIFIED: DL-41 daemon lifecycle (`daemon up\|down\|status`/`ensure`) → P1 turnkey on-ramp delivered (Dev half).** Dev's `9aaed49` (LOCAL; `autoPush:false`) lands `node hub/src/daemon.ts <up\|down\|status>` (+ `ensure` as the design's `daemon ensure` alias), strictly additive over the byte-for-byte-unchanged foreground `npm run daemon`. **PM-verified Done against the running product** (not the diff): cold `up` → a detached, **127.0.0.1-only** daemon (`lsof`-confirmed bind, ppid=1 = survives the shell) on a deterministic FNV-1a per-project port (`25617` for dev-loop — coexists with the 8787 foreground, which stayed up untouched); a **real `/api/health` DB-writable liveness** probe (`{ok:true,project:"dev-loop"}`, not a static 200); idempotent `up`/`ensure` (same pid, never double-starts); machine-local atomic runfile `~/.dev-loop/daemon-<key>.json`; **stale dead-pid runfile self-clears** (no false "running"); `down` stops + clears; a non-service/unknown project → **exit-0 no-op** (the DL-42-hook safety contract). Gate: `npm test` green — all 14 suites (`LIFECYCLE_OK` + the wedged-SoR→`503` assertion); §15 coverage shipped in-commit (`test/lifecycle.ts` + the 503 assertion). **P1 (turnkey) is now delivered on the Dev side** — the daemon is auto-startable; only **DL-42** (the SessionStart hook, §17 `[pm-proposal]`) remains, the operator's git-commit to wire it. QA filed two DL-41 follow-ups in its own lane: **DL-46** (edge-case Bug — the concurrent-`up` micro-race Dev flagged; its `O_EXCL` cold-start lock belongs to the DL-42 hook integration, not DL-41) + **DL-47** (gitignore `daemon-*.log`); **DL-44** (the `${HOME}` env-fork Bug) is In Progress. **Next buildable increment = DL-43** (the P2 op-API foundation, already Todo); the P2 thin shim files **as DL-43 lands** (design `daemon-multicli-repositioning.md` P2–P5 / Candidate ideas — never one mega-ticket). Also filed **DL-48** (consistency lens, Improvement/pm/Low): reconcile `HUB-ARCHITECTURE.md`'s phantom 6-value doc-kind cite → the live 4-value `DOC_KINDS` (a stale-doc reconcile the operator's own design doc flagged). Reviewed SHA → `9aaed49` (real product code — the daemon lifecycle moved; lenses reset, **strategy-gaps + consistency** swept this fire). Loop status: **healthy + active** — Dev/QA working a deep queue (DL-43/44/45/46/47/48), nothing pm-owned In Review, DL-42 operator-parked.

- **2026-06-24 — 🏁 OPERATOR-APPLIED: DL-42 SessionStart hook (`bb587b6`) → Done → P1 (turnkey on-ramp) COMPLETE end-to-end.** The operator applied the §17 `[pm-proposal]` by git commit (like DL-12/`ea2ab98`) and verified+closed it. The hook landed in **`hooks/hooks.json`** (the convention-discovered location — NOT inline `.claude-plugin/plugin.json`, which the operator found this CC version doesn't read for hooks; cross-checked vs the codex + learning-output-style plugins), invoking `node "${CLAUDE_PLUGIN_ROOT}/hub/src/server.ts" daemon up >/dev/null 2>&1 || true` — output-swallowed + forced exit-0 so a SessionStart never pollutes context or aborts startup, and `server.ts` delegates `daemon <sub>` to `daemon.ts`'s lifecycle (server.ts:80). Operator-verified end-to-end: a service project → web UI up in ~0.4s on the cwd-resolved **per-project** port (`25617`); 2nd call = already-running (no double-start); a non-service dir = clean no-op (exit 0). **So P1 is delivered end-to-end: DL-41 lifecycle ✅ + DL-42 auto-start hook ✅** — the E2E target (*install → web UI up → an MCP change shows in the UI, zero manual daemon start*) is met (operator activation = re-sync/reinstall the plugin so installs pick up `hooks/hooks.json`; version bump deferred to the release flow). The last P1 piece — the **dormant op-API mount** (`POST /api/op/*`, gated `hub.transport:"daemon"` default-off) — is **DL-43** (Todo, well-scoped); the **P2 thin stdio shim files as DL-43 lands** (never a premature mega-ticket; design `daemon-multicli-repositioning.md` P2–P5). Also this fire: **DL-44** (the nested-`${HOME}` env-fork Bug fix, `f8aa974` — config/mcp.example.json + .gitignore + a new `hub/test/mcp-config.ts`) is **In Review** (QA-owned, QA verifies); **DL-46** (the concurrent-`up` race QA found) is **In Progress** (Dev) — the known multi-pane risk of the hook, being fixed before broad activation. **Filed DL-49** (conversion-retention lens): RUNNING.md's "Observe the loop" onboarding section is stale vs the shipped auto-start + per-project lifecycle (still points at a manual `npm run daemon` on the fixed `8787`; no `daemon status` URL-discovery path) — docs-only, Dev-buildable, deduped (DAEMON.md is already current after DL-37). Reviewed SHA → `bb587b6` (real product/plugin code moved → lenses reset; **strategy-gaps + conversion-retention swept** this fire). Loop status: **healthy + active** — Dev on DL-46, QA verifying DL-44; Todo deep (DL-43/45/47/48/49); **PM is not the constraint**. Next operator-gated themes (unchanged): the supporting goals (hub/`service` hardening, agent-skill robustness [§17-gated], operator polish, broader portability) + the deferred candidates below.

- **2026-06-24 — GROOMED operator intake DL-50 → DL-52 (buildable) + DL-53 (§17 proposal); SHA `502c77e`; P1 turnkey holds.** New product SHA `bb587b6`→`502c77e` (QA-lane: `502c77e` = DL-46's `O_EXCL` cold-start lock serializing concurrent `daemon up` — the DL-42-hook multi-pane race; DL-46 now **In Review** (qa). QA also found that fix **incomplete** and filed **DL-51** — a stale-break TOCTOU re-admits a 2nd cold start; both qa-owned, QA's lane — PM only notes them). Doc-watch: STRATEGY.md unchanged by the operator this fire (`086f66c8…`). **Job A/B empty for pm** (nothing pm-owned In Review or blocked).
  - **W3 intake (§9a): DL-50** (operator) — DL-42 parked a ticket `Human-Blocked` and sent **no** alert, exposing the operator-alert transport/trigger mismatch (§9 webhook triggers on the *label* park; DL-26's daemon notifier triggers on the Human-Blocked *state* but `sendVia`, `channel.ts:80`, is **bot-API-only** — the `channels` table, `db.ts:160`, has no `transport` column) + `init` never wiring notifications. Verified against the **real code** (dedupe-against-reality, §8), groomed into:
    - **DL-52** (Feature/pm/P2, **Dev-buildable**) — a one-way **webhook** transport for `channels`/`sendVia` + the DL-26 `blockedNotifyTick` notifier (default `'bot'` ⇒ existing channels byte-for-byte unchanged; §16 env-name creds; dry-run preview; tests).
    - **DL-53** (`[pm-proposal]`/§17-parked, `blocked`+`needs-pm`+`external-prereq`) — reframe §9/§25 as one operator-alert channel `{transport: webhook|bot}` (webhook = one-way default; state-trigger canonical on `service`, label-trigger = `linear`/`local` fallback) + an `init` channel-linking step. Edits `conventions.md` + `skills/init/SKILL.md` ⇒ operator git-commit (DL-12 `ea2ab98` / DL-42 `bb587b6` pattern). Folded the operator's two §17 bullets into one coherent proposal.
    - Parent DL-50 back-linked (`relatedTo:[DL-52,DL-53]` + groom comment) **then** closed Done (§9a order). No operator webhook ping — the dev-loop project has no `notify` block (§9).
  - **strategy-gaps swept at `502c77e`:** P1 turnkey on-ramp **complete** (DL-41 lifecycle ✅ + DL-42 hook ✅); the dormant op-API **DL-43** (`POST /api/op/*`, gated `hub.transport:"daemon"` default-off) remains the next buildable P1 piece (Todo); **P2 thin stdio shim files as DL-43 lands** (no premature mega-ticket). No other unfiled strategy/P1 gap. Reviewed SHA → `502c77e` (QA-lane daemon hardening moved code; lenses reset, strategy-gaps swept this fire). Loop status: **healthy, Dev/QA-bottlenecked** — Todo deep (DL-43/45/47/48/49/52 + DL-53 operator-parked); DL-46 In Review (qa) + DL-51 Todo (qa); **PM is not the constraint**.

- **2026-06-25 — 🏁 SHIPPED + VERIFIED: DL-43 daemon agent op-API → P1 turnkey on-ramp COMPLETE; filed DL-55 (P2 thin stdio shim).** Dev's `5abccc2` (LOCAL; `autoPush:false`) lands `hub/src/agentops.ts` + the daemon `handleAgentOp` pipeline — the dormant, opt-in `POST /api/op/<op>` serving the 5 core ticket ops with per-agent `X-Devloop-Actor` identity, gated `hub.transport:"daemon"` (default-off → 404, every read/roadmap surface byte-for-byte unchanged), `server.ts` 100% untouched. **PM-verified → Done** against the running product, not the diff: a line-by-line review of `agentops.ts` (mirrors `server.ts` 1:1 — REPLACE labels + APPEND-only `relatedTo` + DL-24 `assignTo` + DL-32 prod-gate + DL-38 staging gate + `issue.promote`, on the shared `ticketwrite.ts`) and the Decision-#4 guard pipeline (`writeOriginOk` **first** → `X-Devloop-Actor` → G1 `actorExists` → dry-run-mode gate (writes only) → dispatch; gate read **fresh** per request, fail-closed); `cd hub && npm test` = **exit 0, 16/16 suites incl. `AGENT_API_OK`, 465 checks, 0 fail** — run atop DL-52's in-flight WIP, so DL-43 also caused **no regression**; git-confirmed `5abccc2` did not touch `server.ts`. Accepted Dev's flagged "honor mode" reading (implemented as a **dry-run WRITE gate**; reads never gated; a **live** project is byte-identical to stdio — the dominant AC). §15 coverage in-commit (`agent-api.ts`). **P1 (turnkey on-ramp) is now COMPLETE end-to-end: DL-41 lifecycle ✅ + DL-42 SessionStart hook ✅ + DL-43 op-API foundation ✅.** Per the design's phase plan ("file the next increment as DL-43 lands"), filed **DL-55** (Feature/pm/**P2**) = **P2 — the thin stdio MCP shim** (`hub/src/shim.ts`) that proxies the 5 core ticket tools to the loopback `/api/op/*`, carrying identity env→`X-Devloop-Actor` (dodges the headless `claude -p` Authorization-header-drop), discovering the per-project port via the DL-41 runfile, **opt-in + default-off** (the direct-db `server.ts` stays the default, byte-for-byte unaffected). Scoped to the 5 core tools + `whoami`; widening to `doc.*`/`topic.*`/`channel.*`/`list_events` is the sequenced **(3/n)**; the `server.ts`↔`agentops.ts` dispatch convergence rides **P3**. Reviewed SHA → `5abccc2` (real product code moved → lenses reset, **strategy-gaps swept** this fire). Loop status: **Dev/QA-bottlenecked** — Todo = DL-55 (P2/High) + DL-45/47/48/49 (Low); DL-52 In Progress (Dev, webhook transport); DL-53 operator-parked (Human-Blocked, §17). PM is not the constraint.

- **2026-06-25 — ✅ also verified DL-52 → Done (concurrent Dev ship `d7c2613`, mid-fire).** While verifying DL-43, a concurrent Dev fire shipped **DL-52** (the one-way **webhook transport** for `channels`/`sendVia` + the DL-26 Human-Blocked notifier) → In Review; picked it up as a second Job-A item. **PM-verified → Done** against the running suite + a `channel.ts`/`db.ts` review: `transport` discriminator (`DEFAULT 'bot'`, shared `TRANSPORT_CHECK`, presence-guarded v2 ALTER — idempotent, lossless), `sendWebhook` (Slack 2xx / Lark 2xx+`code==0` / `larkSign`=base64-HMAC per §9), **§16** creds as env-NAMES never in the DB (`failed webhook throws status not URL`; `sign-secret never in the payload`), the DL-26 notifier over a webhook channel (DL-33 cap + DL-34 dry-run write-free hold), back-compat (`'bot'` default byte-identical); `cd hub && npm test` = exit 0, 16/16, 465 checks, 0 fail. Accepted Dev's two nuances (no bail-shape on the Human-Blocked *state* notifier line; webhook-channel **creation** UX is the §17 sibling). **This completes the Dev-buildable half of operator-intake DL-50** (webhook alert transport built) — the remaining DL-50 work is the §17 **DL-53** (conventions §9/§25 reframe + `init` channel-link + the `channel.register` `transport` arg), operator-applied by git commit (still Human-Blocked). Net for the fire: DL-43 + DL-52 verified Done; DL-55 (P2 shim) filed; P1 complete.

- **2026-06-25 — NEW OPERATOR DIRECTION (`6078e89`) + W3 INTAKE DL-56: backend-choice-at-init → groomed into DL-59/60/61 + extended DL-53.** Mid-fire the operator committed `133e459`→`6078e89` (docs-only: the workflow-hardened design `docs/design/backend-choice-unification.md` — 1 design + 2 adversarial critics, all mustFix/parityLeaks folded) and filed the **W3 intake DL-56** (operator→pm, Todo): *choose the ticket backend (Linear / local / `service`) at `init` with a UNIFIED workflow.* **Job A/B empty** (nothing pm-owned In Review or blocked; DL-51 verified Done by QA, DL-52 Done by PM last fire). Groomed DL-56 (§9a) per the design's dependency spine + the binding operator decisions:
  - **DL-59 (U0, Feature/pm, Todo, P2, BUILDABLE NOW):** daemon human-park notifier ALSO fires the §9 `notify` webhook — closes **L1+L2** of the 3-layer notification leak (today a `service` project with only a `notify` webhook + no bot channel gets **NO** human-park alert — `startBlockedNotifier` no-ops at `daemon.ts:933`). **Reuses DL-52's `sendVia` webhook** (one POST impl — the operator's "widen DL-52, not a parallel epic"); dependsOn DL-52 (Done). Baked in **DL-57's decision** (the Human-Blocked *state* notifier carries no bail-shape — don't re-introduce it) + dogfood-migration-safety (additive/nullable via the `user_version` ladder; co-resident `SC` project).
  - **DL-60 (U1, Feature/pm, Backlog):** init performs `service` setup as an idempotent bootstrap (install→seed→doctor→one-time `daemon up`+`/api/health`) — a bootstrap convenience, **NOT** a parallel lifecycle owner (the DL-42 hook stays steady-state owner). dependsOn DL-53.
  - **DL-61 (U2, Feature/pm, Backlog):** init **merges** (never clobbers) the product repo `.mcp.json`, env-name-only. dependsOn DL-60.
  - **DL-53 EXTENDED** (operator: *"extend, do NOT file a new proposal"* — avoids the §17 file-collision on `conventions.md`/`init` the critics flagged): folded in the init Step-0.5/Step-8 + §18 unified-backend prose (the `park-for-operator` abstract op; `Human-Blocked` service-only / local label-only; the deferred-migration + `mirror`-is-a-projection + `externalId` id-fidelity seam) + the pm-agent SKILL **L1** rewrite. Stays **Human-Blocked** (operator git-commit; apply after DL-52 + DL-59 ship). Applying it unblocks DL-60/DL-61.
  - Parent **DL-56 back-linked (`relatedTo:[DL-59,DL-60,DL-61,DL-53]`) + closed Done** (§9a order — children filed/back-linked first; each child carries child→parent `relatedTo:[DL-56]`). **Cross-store migration DEFERRED** (operator decision — seam named in DL-53's §18 prose, not a ticket). **U4** (optional init "backend-doctor" reconcile, design §6) → Candidate ideas (file when DL-60/61 land).
  - **Also filed (consistency/conversion-retention lens, the one product-doc-drift gap at HEAD): DL-58** (Improvement/pm/Low) — the DL-43 agent op-API (`hub.transport:"daemon"` + `POST /api/op/*` + `X-Devloop-Actor`) is documented only in the design doc + STRATEGY.md and is **absent from every reference doc** (`config-schema.md`/`DAEMON.md`/`HUB-ARCHITECTURE.md` — grep-verified 0 mentions each); load-bearing for the in-flight P2 shim **DL-55**. Deduped vs DL-48/DL-49/DL-57.
  - Reviewed SHA → **`6078e89`** (docs-only operator commit → product-surface lenses carry forward from `133e459`; **strategy-gaps + consistency swept** this fire). Live daemon (DL-42 auto-start) **healthy** — board (swimlanes) + `/activity` + `/api/health` all `200` on the per-project port `25617`. **Loop status: healthy, Dev/QA-bottlenecked** — Todo = DL-58/DL-59 + DL-45/47/48/49; In Progress = DL-55 (P2 shim, Dev); Backlog = DL-60/DL-61; **DL-53 Human-Blocked** (operator). **PM is not the constraint** (filed the operator-intake grooming + 1 concrete doc gap; did not pad).
- **2026-06-25 — 🏁 SHIPPED + VERIFIED: DL-55 (P2 thin stdio shim) + DL-59 (notification L1+L2) → Done; filed DL-62 (the (3/n) op-API+shim widening).** Two concurrent Dev ships this fire, **both PM-verified against the running product** (not the diff). **DL-55** (`59a564d`, LOCAL — `autoPush:false`) = **P2**: `hub/src/shim.ts` proxies the 5 core ticket tools + a local `whoami` to the loopback `POST /api/op/*`, identity env→`X-Devloop-Actor`, port via the DL-41 runfile (no `8787` hardcode), opt-in/default-off (`server.ts` byte-for-byte untouched). Verified via `node hub/test/shim.ts` = **SHIM_OK** (24 assertions): 5-tool round-trip, write attribution via `list_events`, **differential parity** vs the direct-db path, both failure modes (dormant / daemon-down clear errors), back-compat. **DL-59** (`416378a`, LOCAL) = the U0 code half: the daemon Human-Blocked notifier now also fires the §9 `notify` webhook — DB channel takes **precedence** (→ no double-send), unset-env **fail-closed**, dry-run write-free, **no schema change** — closing **L1+L2** of the 3-layer notification leak; `cd hub && npm test` green through `MCP_CONFIG_OK` incl. `BLOCKED_OK` (9 DL-59 assertions). **The DL-52 notification workstream is now code-complete** (DL-52 + DL-59 Done) → **DL-53** (the §17 prose half) is **ready for the operator to apply by one git commit** (both code deps Done; applying it flips DL-60/DL-61 Backlog→Todo); re-confirmed **unapplied** (no `references/`+`skills/` commit since filing), stays Human-Blocked. (Caveat surfaced to the operator: dev-loop's own config has **no `notify` block**, so the DL-26/DL-59 daemon reminder for DL-53 no-ops here until a channel/notify is configured.) **Filed DL-62** (Feature/pm/**P2**) = **MCP↔daemon unification (3/n)**: widen the op-API (`agentops.ts`) + the shim to the **documents+events family** (`list_events` + `doc.list/get/history/diff/save/publish`) — env→`X-Devloop-Actor` attribution, `writeOriginOk`-first on the mutating endpoints, optimistic-CAS preserved, **`doc.publish` kept cooperatively operator-gated** (design folded-critique #85: client-declared actor, accepted single-host posture, revisit under Phase B); `topic.*`/`channel.*`/`mirror.*`/label ops = the sequenced **(4/n)**. Reviewed SHA → **`416378a`** (real product code moved twice this fire → lenses reset, **strategy-gaps swept**). **Loop status: healthy, Dev-bottlenecked** — Todo = DL-62 (P2) + DL-58/57/49/48/47/45 (P4 docs/hygiene); Backlog = DL-60/61 (dep DL-53); DL-53 Human-Blocked (operator). **PM is not the constraint** (verified 2 ships + filed the 1 next-increment gap; did not pad).

- **2026-06-25 — CORRECTED + UNBLOCKED: DL-53 was operator-applied (`3ab1330`) → Done; promoted DL-60 + DL-61 Backlog→Todo.** The prior entry (the 02:04 fire) recorded DL-53 as *"ready for the operator… re-confirmed unapplied, stays Human-Blocked"* — that was a **mid-fire miss**: the operator applied DL-53 by git commit `3ab1330` (`references/conventions.md` §9/§18 + `skills/init/SKILL.md` Step-0.5/channel-link + `skills/pm-agent/SKILL.md` L1 — one commit, all ACs met per the operator's close comment) ~1 min after PM's "ready" comment, and that fire closed without re-checking, so its report + `pm-state` went stale. Ground truth this fire: **DL-53 = Done** (`3ab1330` is in git history, 2 commits behind `5ce045f`). Applying it **unblocked the init code tickets**, which the operator explicitly listed as *"promotable Backlog→Todo"* → promoted **DL-60** (init `service` idempotent bootstrap, U1) + **DL-61** (`.mcp.json` merge-not-clobber, U2) Backlog→Todo this fire (DL-61's own AC sanctions parallel; §5 FIFO picks the older DL-60 first, preserving the compose order). **Job A** empty (nothing pm-owned In Review); **Job B** otherwise empty (no `blocked`/`needs-pm`/Human-Blocked). **DL-62** (the (3/n) op-API+shim widening) is **In Progress** (Dev building). **Throttled the proactive lens sweep** — unchanged HEAD `5ce045f` (only `strategy-gaps` swept at it), Todo now 8 deep (DL-60/61 P3 + DL-58/57/49/48/47/45 P4) and Dev mid-build on DL-62, so the constraint is Dev throughput, not ticket supply; padding would be a smell. **`ux-flows` is the next unswept lens** when HEAD moves or the queue drains. Operator-facing note (now moot, kept for the next park): dev-loop's config still has **no `notify` block**, so the DL-26 daemon Human-Blocked reminder no-ops here until a channel/notify is configured. **PM is not the constraint.**

- **2026-06-25 — 🏁 VERIFIED DL-62 → Done (P2 (3/n) op-API+shim doc/event family); filed DL-64 (the (4/n) discussion-board slice).** Dev's `a794ea4` (LOCAL; `autoPush:false`) widened the op-API (`agentops.ts`) + shim (`shim.ts`) to `list_events` + `doc.list/get/history/diff/save/publish` — the shim now proxies **13 of `server.ts`'s 29 tools**. **PM-verified → Done** against the running product (not the diff): ran `cd hub && npm test` myself = **exit 0, 541 ✅** across all 18 suites incl. `AGENT_API_OK` + `SHIM_OK` (independently reproduces Dev's + QA's 541); read the `a794ea4` diff for the structural ACs — doc writes delegate 1:1 to the shared `docstore.ts` (CAS + cooperative operator-publish gate in one place), reads are `WHERE project_id=?` SELECTs, `statusForDocErr` relocated to `docstore` (no drift), the §17 firewall is **structural** (`db.ts:109` `CHECK(kind IN ('strategy','roadmap','decisions','notes'))`, `DOC_KINDS` matches, no filesystem path), `server.ts` byte-for-byte untouched (`git diff` empty). Accepted Dev's one judgment call (the AC named `daemon.ts` for the dispatch, but `handleAgentOp` was already generic over `AGENT_OPS`, so the 7 ops are served with zero dispatch edit — the functional AC is met + tested). QA had posted an independent security sign-off + filed **DL-63** (Low, qa): the op-API doc **read** handlers don't string-type-check `slug`/`kind` like `opDocSave` does → a non-string on a **direct** op-API POST bind-throws → HTTP 500 instead of a clean 400 — direct-POST-only + opt-in, unreachable through the zod-guarded shim, so it does **not** touch DL-62's functional ACs (correctly a separate qa follow-up). **Per the "file the next as the prior verifies" cadence + this doc's own sequencing, filed DL-64** (Feature/pm/**P2**) = **(4/n)** the discussion-board family (`topic.list/get/open/synthesize/close` + `post.add`), extracting a shared `topicstore.ts` (the `docstore.ts` precedent) so `server.ts` + the op-API can't drift; the §25 cooperative role gates (Director-only open/synthesize/close; invited-actor `post.add`) preserved. **Re-sequenced the operator's single "(4/n) bucket" into family-sized increments** ((4/n) board / (5/n) `channel.*` / (6/n) `mirror.*`+labels+`get_project`) — the DL-55/DL-62 one-family discipline (each family needs its own extract step; a 16-op, 4-extraction ticket is the mega-ticket Dev would block). Reviewed SHA → **`a794ea4`** (real product code moved → lenses reset, **strategy-gaps swept**). **Loop status: healthy, Dev-bottlenecked** — Dev idle (0 In Progress) with a 9-deep Todo (DL-64 P2 + DL-60/61 P3 init + DL-63/58/57/49/48/47/45 P4 docs/hygiene/bug); nothing blocked/parked. **PM is not the constraint** (verified 1 ship + filed the 1 next-increment gap; did not pad an already-deep queue).

## Candidate ideas

_(The daemon/web-UI/roadmap-bridge and README-drift ideas below were filed as DL-1…DL-5 on
2026-06-23 per the resolved decision above; this list is the remaining overflow parking lot.)_

- **Backend-choice-at-init — sequenced follow-ups to the DL-56 groom (operator 2026-06-25, design `docs/design/backend-choice-unification.md`).** Filed this milestone: DL-59 (U0 notifier), DL-60 (U1 init service bootstrap), DL-61 (U2 `.mcp.json` merge), DL-53-extended (the §17 prose). **Not yet filed — file as the prior lands:** **U4** — an optional init "backend-doctor" reconcile on re-run (extend `hub/src/doctor.ts` to verify daemon-up / `.mcp.json` actor wiring / `/api/health` / the DL-42 hook present, reported in the Step-8 readiness checklist; read-only/idempotent, Low). dependsOn DL-60 + DL-61. **DEFERRED epic (operator decision — NOT a ticket until prioritized):** cross-store ticket **migration** (linear↔service). The blocker is real: hub ids are a global PK minted from prefix+seq (`db.ts:286-292`) and `ensureProject` hard-throws on a prefix clash (`seed.ts:46-47`), so an importer cannot preserve source ids as the PK — source ids must ride a separate `externalId`. The only cross-store seam today is the one-way hub→Linear `mirror` (a projection, not a bridge); Linear visibility without migrating = `service` + `mirror`. Its own epic (exporter/importer per direction + `externalId` carry + id-remap + a freeze→import→verify→cutover runbook) when the operator prioritizes it.
- **MCP↔daemon unification — sequenced follow-ups to DL-43 (thread 2, operator 2026-06-24).** _(Now
  formalized as the design doc's **P2–P5** phase plan — `docs/design/daemon-multicli-repositioning.md`;
  reconciled `8857c0a`.)_ Once
  DL-43 (the opt-in loopback **`POST /api/op/*`** for the core ticket tools, gated `hub.transport:"daemon"`) lands + is verified Done: **(2/n = P2)**
  an opt-in stdio-`server.ts` **thin-client** mode that proxies tool calls to the loopback daemon when
  configured — extract the shared tool-dispatch so both transports reuse it; the default
  stdio-owns-its-own-db path stays 100% working. *This* is what makes "agents act through one running
  service" real (the Vision's "daemon owns coordination"). **(3/n)** widen the loopback surface beyond
  ticket tools to `doc.*` / `topic.*` / `channel.*`. Each additive + default-off + localhost-only;
  file the next increment as the prior verifies (never one unscoped mega-ticket — Dev would block it).
  **UPDATE 2026-06-25: (2/n=P2) SHIPPED as DL-55 (verified Done). (3/n) docs+events (`list_events` + `doc.*`,
  `doc.publish` cooperatively operator-gated per folded-critique #85) SHIPPED as **DL-62 — verified Done this fire**
  (the shim now proxies 13/29 `server.ts` tools). The operator's "(4/n) bucket" (`topic.*`/`post.add` + `channel.*`
  + `mirror.*` + labels) is being delivered **family-by-family** — the DL-55/DL-62 "one coherent family per
  increment, never an unscoped mega-ticket Dev would block" discipline — because, unlike docs/tickets, the
  topic/channel/mirror write logic is **inline in `server.ts`** (no `topicstore`/`channelstore` yet), so each
  family first needs its own extract-to-shared-module step (the `docstore.ts` precedent). Sequenced: **(4/n)**
  discussion-board (`topic.*`+`post.add`, extract `topicstore.ts`) = **DL-64 (filed this fire)**; **(5/n)** `channel.*`;
  **(6/n)** `mirror.push/status` + `list_issue_labels`/`create_issue_label` + `get_project`. The full drop-in
  (through (6/n)) is the precondition for P3 (single-writer + the `server.ts`↔`agentops.ts` dispatch convergence).**
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
- **Web-UI fidelity polish (ux-flows lens, PM 2026-06-23).** **UPDATE 2026-06-23: filed as DL-16** (items a+b: render markdown ticket/comment bodies via the existing renderMarkdown + show created/updated timestamps), now that the milestone backlog drained. **UPDATE 2026-06-24: item (c) confirmed live + filed as DL-36** (ux-flows sweep at `dfa5f9b`: `/totally/bogus` → JSON 404 while `/ticket/<missing>` → HTML 404; serve the friendly HTML 404 for non-API paths, keep `/api/*` JSON). All three sub-items now filed. Lower-value read-view
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
  DL-20 lands. Buildable when filed — no §17/§22 gate. **UPDATE 2026-06-24: gate opened — DL-20 verified
  Done and the board grew ~16→44, so this is no longer DL-20-overlapping polish at a small scale. Confirmed
  not built (`boardPage()` still renders per-column counts only, daemon.ts:245). Filed as DL-45** (Improvement,
  pm, Low; read-only aggregate over the existing rows, respects DL-20 filters + DL-31 swimlanes).
- **Web-UI header nav: active-surface highlight (consistency lens, PM 2026-06-23 — marginal, parked).**
  Highlight the current surface in the header nav (board / roadmap / reports / the DL-17 `/activity`).
  Cosmetic parity polish with no observe/steer payoff — fold into a future nav pass alongside the
  `/activity` nav link DL-17 adds, rather than its own ticket. (The "labeled board item" half was
  redundant with the existing wordmark-as-home at `daemon.ts:127`.)
