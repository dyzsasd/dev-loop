# Running dev-loop

How to onboard a project, launch the eight agents, pick a model per agent, and
resume. Assumes the plugin is installed (`/plugin list` shows `dev-loop`) and the
[Requirements](../README.md#requirements) are met (Claude Code, Linear MCP — for the
`linear` backend — `gh`, a repo, a Linear team/project).

---

## 1. Onboard a project (new project)

Run the setup command **once** — it is idempotent and operator-present:

```
/dev-loop:init
```

It will, with you in the loop:
1. **Detect the project shape & confirm repos.** init detects greenfield (no code yet) /
   brownfield (existing code) / adopting (pre-existing human tickets), and single- vs
   multi-repo. It echoes back each `repoPath` / `repos[].path` (the loop *commits from
   them*, so this is a gate). Greenfield runs a short strategy interview; brownfield is
   read-only-mapped into the doc-base `Current state`.
2. **Ask the backend** — `linear` (coordinate through Linear) or `local` (a machine-local
   file board in the data dir; no Linear needed). See [conventions §18](../references/conventions.md#18-backend--linear-vs-local).
3. Gather/validate the per-project config and write it to
   `~/.claude/plugins/data/dev-loop/projects.json` (creating only what's missing).
4. **linear**: ensure the workflow labels + the Linear project exist (asking before
   creating the project), plus one `repo:<name>` label per `repos[]` entry when
   multi-repo. **local**: scaffold `board/` (`tickets/`, `counter.json`) and require a
   repo-file `strategyDoc`. Either way, scaffold the PM doc-base headings (Vision / Goals
   / Non-goals / Current state / Personas / Glossary / Decisions / Candidate ideas) in
   the doc-home repo, seeding `Current state` from brownfield mapping if available.
5. Smoke-check the test env + build, create the runtime files
   (`pm-state.json` / `qa-state.json` / `lessons.md`), note the per-agent **reports tree**
   (`<key>/reports/<agent>/{daily,weekly,monthly}/`, conventions §22 — scaffolded or created
   lazily), and print a **readiness checklist**.

When the checklist is green, set `"mode": "live"` in `projects.json` (init leaves new
projects in `dry-run` for first contact) and launch the agents (next section).

> Re-running `/dev-loop:init` on an existing project is safe — it re-checks and
> re-prints the readiness report, overwriting nothing.

---

## 2. Launch the agents

The plugin **ships no harness** — pick whichever fits. Both run the same eight skills:
`/dev-loop:pm-agent`, `qa-agent`, `dev-agent`, `sweep-agent`, `reflect-agent`, and the
three opt-in **outward** agents (conventions §21) `ops-agent`, `architect-agent`,
`director-agent`.

> **Another CLI?** On the `backend:"service"` hub the loop is **CLI-portable** — the same agents
> + hub run on Codex / opencode against the same `hub.db`. See
> [`PORTABILITY.md`](PORTABILITY.md) (conventions §26) for the env contract, per-CLI MCP
> registration, the headless wrapper, and the **identity gate** you run before onboarding a CLI.

### A. Agent View — native, recommended (`claude agents`)

[Agent View](https://code.claude.com/docs/agent-view) (Claude Code ≥ 2.1.139) is one
screen for all your background sessions — *Needs input / Running / Done* — that keep
running with no terminal attached.

```
claude agents            # open the view (scoped: claude agents --cwd ~/path)
```

Then dispatch each agent as its own self-looping row (a slash command typed in the view
becomes a new background session; `/loop` makes it recurring):

```
/loop 5m  /dev-loop:pm-agent
/loop 5m  /dev-loop:qa-agent
/loop 5m  /dev-loop:dev-agent
/loop 30m /dev-loop:sweep-agent
/loop 24h /dev-loop:reflect-agent
/loop 10m /dev-loop:ops-agent        # OUTWARD (§21), opt-in — watches running prod (anti-flap)
/loop 24h /dev-loop:architect-agent  # OUTWARD (§21), opt-in — whole-codebase tech-debt audit
/loop 24h /dev-loop:director-agent   # OUTWARD (§21/§25), opt-in — chairs the discussion board + drafts the roadmap (service backend; no-op without a director config)
```

Manage from the shell: `claude attach <id>` (open), `claude logs <id>` (recent output),
`claude stop <id>` (stop). `Space` peeks a row, `Enter` attaches.

> **Model note:** a dispatched Agent View session uses the **view's** model (set the view
> with `claude agents --model <m>`). For *different* models per agent, use the launcher
> below (or open separate views). Agent View applies one model per view.

### B. Local tmux launcher — mixed models, one command

A small launcher (kept in your data dir, **not** part of the plugin) opens a `dev-loop`
tmux session with one pane per agent, each a headless `claude` loop, and reads your
per-agent `models` from config so every pane gets its own `--model`:

```
~/.claude/plugins/data/dev-loop/run-loop.sh            # PM/QA/Dev + Sweep; Reflect off
MODE=once   ~/.claude/plugins/data/dev-loop/run-loop.sh   # one pass each, then stop (good first test)
REFLECT=1   ~/.claude/plugins/data/dev-loop/run-loop.sh   # also run the daily Reflect pane
SWEEP=0     ~/.claude/plugins/data/dev-loop/run-loop.sh   # omit the janitor pane
PROJECT=foo ~/.claude/plugins/data/dev-loop/run-loop.sh   # pick a project key
OPS=1       ~/.claude/plugins/data/dev-loop/run-loop.sh   # also run the Ops (prod-watch) pane (~10m; off by default)
ARCHITECT=1 ~/.claude/plugins/data/dev-loop/run-loop.sh   # also run the Architect (tech-debt) pane (daily; off by default)
SIGNAL=1    ~/.claude/plugins/data/dev-loop/run-loop.sh   # also run the Signal (user-intake) pane (hourly; off; no-op if no sources)
```

It prints a blast-radius banner (project, mode, autonomy, ship flags, models) before
starting. Detach `Ctrl-b d` · reattach `tmux attach -t dev-loop` · stop all
`tmux kill-session -t dev-loop`. Logs tee to `~/.claude/plugins/data/dev-loop/logs/`.

---

## 3. Per-agent models

The model is chosen **at launch** (a SKILL can't set its own model), via a per-project
`models` map in `projects.json`:

```jsonc
"models": { "pm": "opus", "qa": "opus", "dev": "opus", "sweep": "opus", "reflect": "opus", "ops": "opus", "architect": "opus", "signal": "opus" }
```

**Every agent defaults to `opus`** — maximize correctness across the whole loop. Tune an
agent **down** only to economize; the table shows where `opus` matters most vs. where a
cheaper model is tolerable:

| Agent | Default | Could economize to | Why |
|---|---|---|---|
| **dev** | `opus` | — | hardest — implements, self-reviews the diff, fixes |
| **pm** | `opus` | — | product/scoping judgment + review |
| **architect** | `opus` | — | whole-codebase reasoning about debt/abstractions |
| **reflect** | `opus` | `sonnet` | careful curation, but runs only daily |
| **qa** | `opus` | `sonnet` | capable; runs often |
| **ops** | `opus` | `sonnet` | mechanical polling + anti-flap judgement; runs often |
| **signal** | `opus` | `sonnet` | triage + PII-safe summarization; periodic |
| **sweep** | `opus` | `haiku` | mechanical hygiene |

The tmux launcher applies this map automatically and **defaults each pane to `--model
opus`** when the map omits an agent. In Agent View, set the view's model (e.g.
`claude agents --model opus`); it's one model per view, so run mixed models through the
launcher if you economize some agents.

---

## 4. Cadence

Agents self-throttle (idle fires are cheap no-ops), so tighter intervals are safe:

| Agent(s) | Cadence | Why |
|---|---|---|
| PM / QA / Dev | ~5 min | the producing loop |
| Sweep | ~30 min | janitorial; re-walking an unchanged board is waste |
| Reflect | daily | reflects *after* a day of churn |
| Ops *(opt-in)* | ~10–15 min | watches running prod; tight polls are the point, but self-throttles |
| Architect *(opt-in)* | daily | whole-codebase audit; SHA-gate makes most fires no-ops |
| Signal *(opt-in)* | hourly / daily | real-user intake; no-op when no sources or no new signal |

---

## 4a. Backend: the local hub (`backend:"service"`)

By default the loop coordinates through **Linear**. Set `backend:"service"` (conventions
§18) to coordinate through the **local hub** instead — a machine-local MCP system-of-record
(`hub.db`, node:sqlite; see [`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md)). The win over
Linear: **real per-agent identity** — every ticket move / comment is attributable to the
agent that did it, not the single shared Linear user.

**One-time setup:**
1. Install the hub deps once: `cd <dev-loop>/hub && npm install` (pure JS — no native build;
   needs Node ≥ 23.6 for built-in `node:sqlite` + `.ts` type-stripping).
2. Register the hub as an MCP server. Copy [`config/mcp.example.json`](../config/mcp.example.json)
   to your **product repo root** as `.mcp.json`, and set the absolute `args` path to
   `<dev-loop>/hub/src/server.ts`. Its `env` block expands `${DEVLOOP_ACTOR}` etc. from each
   pane's launching shell at parse time — so one registered server attributes each pane to
   the right agent. (Approve the server once on first use; no Claude restart needed.)
3. Set `backend:"service"` in `projects.json`; keep `strategyDoc` a **repo file**.
4. **Create the project in the hub once** (the hub refuses to auto-create a board from a typo'd
   `DEVLOOP_PROJECT`, and each project needs a **unique ticket prefix** since ticket ids are a
   global key):
   ```bash
   node <dev-loop>/hub/src/seed.ts <project-key> "<Project Name>" <UNIQUE-PREFIX>
   # e.g.  node ~/dev-loop/hub/src/seed.ts monpick "MonPick" MP
   ```
   (Or set `DEVLOOP_CREATE_PROJECT=1` on the first launch.) Then health-check it:
   `cd <dev-loop>/hub && DEVLOOP_HUB_DB=~/.dev-loop/hub.db npm run doctor` → `DOCTOR_OK`. Keep
   `hub.db` **outside** any product repo (the template defaults to `~/.dev-loop/hub.db`); if it
   must live in a repo, gitignore `hub.db*` (doctor will tell you if it's exposed).

**Launch — set the identity per pane.** Each pane exports its agent + project before the
`/loop` (the hub reads them); the `.mcp.json` `${…}` expansion carries them into the hub
process.

**Project precedence (DL-13):** explicit `DEVLOOP_PROJECT` (non-empty) **>** the process **cwd**
(the repo it was launched in — matched against the configured `repoPath`/`repos[]`) **>** the
`demo` default. So `DEVLOOP_PROJECT` is **optional** when you launch from inside a project's repo:
unset/empty falls back to the cwd match (`dev-loop-hub resolve-project [--cwd <path>]` is the shared
matcher). A cwd that matches a configured-but-unseeded project **errors loudly** (it does not
silently fall through to `demo`); a cwd outside every repo → `demo`. Set `DEVLOOP_PROJECT` explicitly
to override the cwd, or to be unambiguous in a launcher that spawns the MCP server from a fixed dir.

```bash
DEVLOOP_ACTOR=pm   DEVLOOP_PROJECT=monpick /loop 5m  /dev-loop:pm-agent
DEVLOOP_ACTOR=qa   DEVLOOP_PROJECT=monpick /loop 5m  /dev-loop:qa-agent
DEVLOOP_ACTOR=dev  DEVLOOP_PROJECT=monpick /loop 5m  /dev-loop:dev-agent
# …sweep/reflect/ops/architect likewise, each with its own DEVLOOP_ACTOR
```

The tmux launcher (§2B) sets these per pane for you. Verify a pane is wired with
`DEVLOOP_ACTOR=pm claude mcp list` → `dev-loop-hub … ✓ Connected`, and `whoami` inside a
session returns `pm`. The hub DB is machine-local runtime state — never committed.

### Observe the loop — the localhost web UI

The hub ships a localhost HTTP surface over the same `hub.db` — a server-rendered board
(filters + assignee swimlanes) plus ticket / roadmap / reports / activity viewers and a JSON
API — so you can *watch* the loop without touching the system of record. Start it alongside the
agents:

```bash
cd <dev-loop>/hub && DEVLOOP_PROJECT=<project-key> npm run daemon
# → http://127.0.0.1:8787/   (the board; read by default, localhost-only)
```

It is **localhost-only** (binds `127.0.0.1` only, never `0.0.0.0`) and **read by default** —
every `GET` is served by a `PRAGMA query_only=ON` connection. Opt-in, operator-configured
**write surfaces** exist (the roadmap editor, and human ticket web-write), each guarded by the
localhost Host+Origin boundary; see [`DAEMON.md`](DAEMON.md) to enable them. Either way the agents
keep coordinating through the **MCP server**, not the daemon — it stays an *observe-first* human
surface, not the loop's control plane. For the full endpoint + env reference (port override, the
`/api/*` JSON routes, the opt-in write routes) see [`DAEMON.md`](DAEMON.md). (Hub backend only —
the daemon reads `hub.db`.)

---

## 5. Resume / restart

**There is no special resume step — the agents are stateless per fire** (conventions §0).
All state lives in Linear (or the local board), git, the `*-state.json` files, and the
per-agent **reports tree** (`<key>/reports/<agent>/…`, conventions §22), never in
conversation memory. So to resume after stopping (or a crash, a reboot, a laptop
sleep): **just launch the agents again** — each re-reads ground truth and continues
exactly where the board left off. To steer an agent, drop a `<report>.review.md` (点评)
next to one of its reports — it reads the un-acted review at its next run-start and turns it
into a `lessons.md` rule. *(Running in the cloud with no disk access? Set
`reports.sink:"linear"` (conventions §23) to read reports + write the 点评 in Linear
instead — opt-in, default-off, with §16 guardrails.)*

- **Agent View:** background sessions persist across sleep and reappear in `claude
  agents`; they stop only if the machine powers off. After a reboot, re-dispatch the
  `/loop …` lines from §2A. To rejoin a specific session: `claude attach <id>`.
- **tmux launcher:** if the `dev-loop` session is gone, re-run `run-loop.sh`. If it
  still exists, `tmux attach -t dev-loop`.
- A single in-flight fire that died mid-ticket is **self-healing**: Dev's Step 0
  reclaims a ticket it left stranded `In Progress` on the next fire (orphan-recovery),
  and Sweep catches the rest.

---

## 6. Stop

- **Agent View:** `claude stop <id>` per session (or stop them all from the view).
- **tmux:** `tmux kill-session -t dev-loop`.

---

## Safety

`mode:"live"` + `autonomy:"full"` + `autoPush`/`autoDeploy` = **unattended commits,
pushes, and prod deploys with no human gate** — the intended power of the loop. Try
`mode:"dry-run"` or a single `MODE=once` pass first. The `dev-loop` label (or, in local
mode, the board directory) is the firewall that keeps the loop off your human backlog
(conventions §2).
