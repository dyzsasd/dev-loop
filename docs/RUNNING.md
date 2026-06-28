# Running dev-loop

How to onboard a project, launch the agents, pick a model per agent, and resume. The npm package is
the normal install path for the service backend, MCP configs, daemon, doctor, scheduler, and Claude
slash command payload:

```bash
npm i -g @dyzsasd/dev-loop
dev-loop install-claude-plugin   # only needed for /dev-loop:* slash commands in Claude Code
```

The remaining [Requirements](../README.md#requirements) still apply (Claude Code when using slash
commands, Linear MCP for the `linear` backend, `gh`, a repo, and a Linear team/project).

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

Pick the launch mode that matches how much control you want over cadence. All modes run the same skills:
`/dev-loop:pm-agent`, `qa-agent`, `dev-agent`, `sweep-agent`, `reflect-agent`, and the
opt-in **outward** agents (conventions §21) `ops-agent`, `architect-agent`, and
`communication-agent`.

> **Another CLI?** On the `backend:"service"` hub the loop is **CLI-portable** — the same agents
> + hub run on Codex / opencode against the same `hub.db`. See
> [`PORTABILITY.md`](PORTABILITY.md) (conventions §26) for the env contract, per-CLI MCP
> registration, the headless wrapper, and the **identity gate** you run before onboarding a CLI.

### A. dev-loop run — own cadence, Claude/Codex as executors

`dev-loop run` is the primary loop command. It is a normal long-running script: it keeps the
cadence table, loads the bundled agent skills, and whenever an agent is due it shells out once to
the selected CLI with that agent's SKILL body as the prompt. Claude/Codex execute one agent fire at
a time; they do not own recurrence.

```bash
# From inside a configured product repo, the project is inferred from cwd.
cd /path/to/product-repo
dev-loop run --cli claude

# Codex as executor; identity is injected with Codex -c overrides for every fire.
dev-loop run --cli codex --agents core,communication

# Preview the exact commands without launching the model.
dev-loop run --cli codex --agents communication --once --dry-run

# Two-tier Dev without changing cadence ownership.
dev-loop run --cli claude --agents core --dev-split
```

Default agents are `core` (`pm,qa,dev,sweep`). Add `reflect`, `outward`, or individual
agents with `--agents`, for example `--agents core,reflect,ops,communication`. Default
cadences match §4: PM/QA/Dev every ~5 minutes, Sweep ~30 minutes, Ops ~10 minutes, and
daily roles every 24 hours. Override one with `--interval communication=12h` or
`--interval pm=2m`.

Project selection is automatic when the scheduler starts inside a configured repo: it
matches the current directory against `repoPath` / `repos[].path` in `projects.json`.
Use `--project <key>` only when you launch from outside the repo, when a process manager
uses a fixed cwd, or when you want to override the cwd match. Use `--cwd <path>` to make
repo matching explicit without changing the shell's current directory.

Multiple projects on one machine are normal. Put them all under the same
`${CLAUDE_PLUGIN_DATA}/projects.json`, each with a distinct project key and repo path(s), then run
one scheduler process per product:

```bash
cd /work/products/alpha && dev-loop run --cli claude --agents core
cd /work/products/beta  && dev-loop run --cli codex  --agents core,communication
```

For a multi-repo product, configure `repos[]` instead of a single `repoPath`; any path inside one
of those repos resolves to that product. The scheduler uses `repoPath`, then the `repos[]` entry with
`role:"primary"`, then `role:"docs"`, as the subprocess cwd. `/dev-loop:init` writes the initial
project config during onboarding; after that, adding another repo or another project is just editing
`projects.json` (or re-running init for that project).

Useful options:
- `--once` runs each selected agent once and exits.
- `--dry-run` prints commands and validates skill paths without calling Claude/Codex.
- `--root`, `--data`, `--hub-db`, `--project`, and `--cwd` make the run explicit for cron/systemd.
- `--cli-arg <arg>` passes model or safety flags to the selected CLI before the prompt, e.g.
  `--cli-arg --model --cli-arg opus`.
- `--codex-safe` omits Codex's unsafe bypass flags; by default the runner uses the same
  Codex recipe as `PORTABILITY.md` so agent tools can operate.

The runner writes one log per agent under
`${CLAUDE_PLUGIN_DATA}/<project-key>/runner-logs/`. Stop it with `Ctrl-C`; it forwards
SIGINT to active agent subprocesses. This mode is the most portable: run it from tmux,
cron, launchd, systemd, or any host process manager.

### B. Agent View — native Claude UI (`claude agents`)

Use Agent View when you want Claude's background-session UI instead of the `dev-loop run`
process. If `/plugin list` does not show `dev-loop`, run `dev-loop install-claude-plugin` and
restart Claude Code, or run `/reload-plugins` in an existing session. This installs the plugin
under `~/.claude/skills/dev-loop`; no source checkout is required unless you are developing the
plugin.

[Agent View](https://code.claude.com/docs/agent-view) (Claude Code >= 2.1.139) is one
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
/loop 24h /dev-loop:communication-agent # OUTWARD (§21), opt-in — drafts a daily public product article (no external publish)
```

Manage from the shell: `claude attach <id>` (open), `claude logs <id>` (recent output),
`claude stop <id>` (stop). `Space` peeks a row, `Enter` attaches.

> **Model note:** a dispatched Agent View session uses the **view's** model (set the view
> with `claude agents --model <m>`). For *different* models per agent, use the scheduler's
> `--cli-arg` flags, the tmux launcher below, or separate views. Agent View applies one model per view.

> **Two-tier Dev (opt-in, off by default):** replace the `/dev-loop:dev-agent` line with
> two rows to split Dev into a design-lead + implementer pair:
> ```
> /loop 5m  /dev-loop:senior-dev-agent   # opus/max — designs modules, delegates to junior-dev, escalation direct-code
> /loop 5m  /dev-loop:junior-dev-agent   # sonnet/high — implements pre-designed tickets against the linked design
> ```
> Models come from `models.senior-dev` / `models.junior-dev` in `projects.json`; defaults are
> opus / sonnet. See [conventions §21a](../references/conventions.md#21a-the-two-tier-dev--senior-dev--junior-dev-optional-per-project)
> and [config-schema.md `models{}`](../references/config-schema.md) for routing rules, the design
> gate, and the per-backend tier encoding. The legacy `dev` pane is unchanged when this is off.

#### Optional: Codex CLI slash prompts

Codex CLI supports user-defined slash prompts from `~/.codex/prompts/*.md`; they appear as
`/prompts:<name>`. This is useful for an attended one-shot run, not for cadence. Codex marks custom
prompts as deprecated in favor of skills, so treat this as a compatibility layer while
`dev-loop run --cli codex` remains the durable launch path.

Install them from the npm package:

```bash
dev-loop install-codex-prompts
# writes ~/.codex/prompts/dev-loop-pm-agent.md, dev-loop-qa-agent.md, ...
```

Restart Codex after installing. Because Codex does not inherit `DEVLOOP_ACTOR` into MCP subprocesses,
start one Codex session per agent identity when you use these prompts:

```bash
codex -c 'mcp_servers.dev-loop-hub.env.DEVLOOP_ACTOR="communication"' \
  -c 'mcp_servers.dev-loop-hub.env.DEVLOOP_PROJECT="monpick"'

# Inside the Codex TUI:
/prompts:dev-loop-communication-agent
```

Available prompt names include `/prompts:dev-loop-pm-agent`, `/prompts:dev-loop-qa-agent`,
`/prompts:dev-loop-dev-agent`, `/prompts:dev-loop-sweep-agent`,
`/prompts:dev-loop-reflect-agent`, the outward agents, the two-tier Dev prompts, and
`/prompts:dev-loop-init`. The generated prompt asks Codex to call `dev-loop-hub whoami` before hub
writes and stop if the actor does not match.

### C. Local tmux launcher — mixed models, one command

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
COMMUNICATION=1 ~/.claude/plugins/data/dev-loop/run-loop.sh # also run Communication (daily article drafts; off by default)
DEV_SPLIT=1 ~/.claude/plugins/data/dev-loop/run-loop.sh   # two-tier Dev (opt-in): senior-dev (opus/max) + junior-dev (sonnet/high) replace the single dev pane; see conventions §21a
```

It prints a blast-radius banner (project, mode, autonomy, ship flags, models) before
starting. Detach `Ctrl-b d` · reattach `tmux attach -t dev-loop` · stop all
`tmux kill-session -t dev-loop`. Logs tee to `~/.claude/plugins/data/dev-loop/logs/`.

---

## 3. Per-agent models

The model is chosen **at launch** (a SKILL can't set its own model), via a per-project
`models` map in `projects.json`:

```jsonc
"models": { "pm": "opus", "qa": "opus", "dev": "opus", "sweep": "opus", "reflect": "opus", "ops": "opus", "architect": "opus", "communication": "opus" }
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
| **communication** | `opus` | `sonnet` | public article drafting from verified facts; daily |
| **sweep** | `opus` | `haiku` | mechanical hygiene |

The tmux launcher applies this map automatically and **defaults each pane to `--model
opus`** when the map omits an agent. In Agent View, set the view's model (e.g.
`claude agents --model opus`); it's one model per view. In the built-in scheduler, pass
CLI model flags with `--cli-arg` or set the model in the CLI's own config.

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
| Communication *(opt-in)* | daily | drafts one public-facing product article; dedupes by date |

---

## 4a. Backend: the local hub (`backend:"service"`)

By default the loop coordinates through **Linear**. Set `backend:"service"` (conventions
§18) to coordinate through the **local hub** instead — a machine-local MCP system-of-record
(`hub.db`, node:sqlite; see [`HUB-ARCHITECTURE.md`](HUB-ARCHITECTURE.md)). The win over
Linear: **real per-agent identity** — every ticket move / comment is attributable to the
agent that did it, not the single shared Linear user.

**One-time setup:**
1. Install the runtime once: `npm i -g @dyzsasd/dev-loop` (Node ≥ 23.6 for built-in
   `node:sqlite`; no native build).
2. Register the hub as an MCP server. Copy [`config/mcp.example.json`](../config/mcp.example.json)
   to your **product repo root** as `.mcp.json`. It uses `command:"dev-loop", args:["serve"]`.
   Its `env` block expands `${DEVLOOP_ACTOR}` etc. from each pane's launching shell at parse time,
   so one registered server attributes each pane to the right agent. (Approve the server once on
   first use; no Claude restart needed.) Plugin developers can still point a source checkout at
   `node <dev-loop>/hub/src/server.ts`.
3. Set `backend:"service"` in `projects.json`; keep `strategyDoc` a **repo file**.
4. **Create the project in the hub once** (the hub refuses to auto-create a board from a typo'd
   `DEVLOOP_PROJECT`, and each project needs a **unique ticket prefix** since ticket ids are a
   global key):
   ```bash
   dev-loop seed <project-key> "<Project Name>" <UNIQUE-PREFIX>
   # e.g.  dev-loop seed monpick "MonPick" MP
   ```
   (Or set `DEVLOOP_CREATE_PROJECT=1` on the first launch.) Then health-check it:
   `DEVLOOP_HUB_DB=~/.dev-loop/hub.db dev-loop doctor` → `DOCTOR_OK`. Keep
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
DEVLOOP_ACTOR=communication DEVLOOP_PROJECT=monpick /loop 24h /dev-loop:communication-agent
# …sweep/reflect/ops/architect likewise, each with its own DEVLOOP_ACTOR
```

The built-in scheduler (§2B) and tmux launcher (§2C) set these per pane for you. Verify a pane is wired with
`DEVLOOP_ACTOR=pm claude mcp list` → `dev-loop-hub … ✓ Connected`, and `whoami` inside a
session returns `pm`. The hub DB is machine-local runtime state — never committed.

### Observe the loop — the localhost web UI

The hub ships a localhost HTTP surface over the same `hub.db` — a server-rendered board
(filters + assignee swimlanes) plus ticket / roadmap / reports / activity viewers and a JSON
API — so you can *watch* the loop without touching the system of record.

**It now auto-starts — you usually run nothing.** The plugin's `SessionStart` hook (DL-42,
`hooks/hooks.json`) runs DL-41's idempotent `daemon up` on every session start, so opening a
`service`-backend project in Claude Code brings its web UI up automatically — no manual step. The
daemon binds a **deterministic per-project port** (the 20000–39999 range, cwd-resolved via DL-13 —
e.g. `25617` for dev-loop), one daemon per project, never double-started. Find the live URL any time:

```bash
# the lifecycle prints + records the URL (the DL-41 runfile ~/.dev-loop/daemon-<key>.json):
dev-loop daemon status   # → 'service' RUNNING → http://127.0.0.1:<port>
```

To start it by hand (e.g. a non-Claude launcher, or before the first session), use the **idempotent
lifecycle** — `daemon up` (a clean no-op if already running), **not** the old fixed-`8787`
foreground server:

```bash
DEVLOOP_PROJECT=<project-key> dev-loop daemon up
# → started '<key>' → http://127.0.0.1:<deterministic-port>   (idempotent; one per project)
```

> Legacy: `npm run daemon` still runs a foreground daemon on the fixed `8787`; prefer `daemon up`
> (per-project port, idempotent, what the hook uses) so you don't start a *second* daemon beside the
> auto-started one.

It is **localhost-only** (binds `127.0.0.1` only, never `0.0.0.0`) and **read by default** —
every `GET` is served by a `PRAGMA query_only=ON` connection. Opt-in, operator-configured
**write surfaces** exist (the roadmap editor, and human ticket web-write), each guarded by the
localhost Host+Origin boundary; see [`DAEMON.md`](DAEMON.md) to enable them. Either way the agents
keep coordinating through the **MCP server**, not the daemon — it stays an *observe-first* human
surface, not the loop's control plane. For the full endpoint + env reference (port override, the
`/api/*` JSON routes, the opt-in write routes) see [`DAEMON.md`](DAEMON.md). (Hub backend only —
the daemon reads `hub.db`.)

**Loop circuit-breaker — the no-progress detector (DL-76).** A long-running unattended loop can get
*stuck* — keep firing (and billing tokens) while producing **no accepted change** (the Ralph-Wiggum /
runaway failure mode). The daemon can page you once when that happens. Set the project's
`settings_json.noProgressWindowHours` to a number of hours (e.g. `6`); each periodic tick counts
*accepted change* = tickets reaching **Done** (`issue.transition → Done`, the same throughput signal
`/activity` shows) in the trailing window. **Zero Done in the window ⇒ one operator alert** over the
same channel as the Human-Blocked notifier (a registered `channels` row, else the §9 `notify`
webhook). It is **de-duped like the Human-Blocked reminder** — at most **one** alert per stall
*episode*; a fresh alert only after accepted change resumes (a later Done) and then stalls again — and
**off by default**: `noProgressWindowHours` absent/`≤0`, **or** no channel/notify configured, ⇒ a true
no-op (no timer). A cold start (a loop younger than the window) never trips it. The alert is a §16
closed-allow-list one-liner (project · window · the `/activity` link — never a secret/URL). Override the
re-check cadence for tests with `DEVLOOP_NOPROGRESS_TICK_MS` (default hourly). *(This is the
no-progress half of the loop-cost guard; a literal token/$ budget ceiling awaits a per-fire cost signal
the hub doesn't have yet — see `STRATEGY.md`.)*

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
- **Built-in scheduler:** restart the same `dev-loop run ...` command. It recomputes due
  work from the board and local state; there is no scheduler database to restore.
- **tmux launcher:** if the `dev-loop` session is gone, re-run `run-loop.sh`. If it
  still exists, `tmux attach -t dev-loop`.
- A single in-flight fire that died mid-ticket is **self-healing**: Dev's Step 0
  reclaims a ticket it left stranded `In Progress` on the next fire (orphan-recovery),
  and Sweep catches the rest.

---

## 6. Stop

- **Agent View:** `claude stop <id>` per session (or stop them all from the view).
- **Built-in scheduler:** `Ctrl-C` the `dev-loop run` process, or stop it via your process
  manager; it forwards SIGINT to active agent subprocesses.
- **tmux:** `tmux kill-session -t dev-loop`.

---

## Safety

`mode:"live"` + `autonomy:"full"` + `autoPush`/`autoDeploy` = **unattended commits,
pushes, and prod deploys with no human gate** — the intended power of the loop. Try
`mode:"dry-run"`, `dev-loop run --once --dry-run`, or a single `MODE=once` pass first. The `dev-loop` label (or, in local
mode, the board directory) is the firewall that keeps the loop off your human backlog
(conventions §2).
