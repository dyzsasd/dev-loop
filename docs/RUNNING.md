# Running dev-loop

How to onboard a project, launch the agents, pick a model per agent, and resume. The npm package is
the normal install path for the service backend, MCP configs, daemon, doctor, and scheduler:

```bash
npm i -g @dyzsasd/dev-loop
```

On macOS, a global npm install also attempts to install a LaunchAgent that runs
`dev-loop daemon up-all` at login. Set `DEVLOOP_SKIP_AUTOSTART=1` before install to opt out; if npm
scripts were skipped, run `dev-loop daemon install-autostart` later.

Install the Claude plugin only if you want `/dev-loop:*` plugin skills or Agent View onboarding:

```bash
dev-loop install-claude-plugin
# Then run the printed /plugin marketplace add + /plugin install commands inside Claude Code.
```

The remaining [Requirements](../README.md#requirements) still apply (Claude Code when using slash
commands, Linear MCP for the `linear` backend, `gh`, a repo, and a Linear team/project).

---

## 1. Onboard a project (new project)

There are two onboarding paths. The scheduler path does **not** require the Claude plugin; the
plugin-skill path does.

### A. Scheduler/no-plugin onboarding

Create the project config yourself, then validate it with a dry run:

```bash
dev-loop init-config
$EDITOR ~/.dev-loop/projects.json

cd /path/to/product-repo
dev-loop run --cli codex --agents core --once --dry-run
```

At minimum, fill in the project key, `repoPath` or `repos[]`, `strategyDoc`, `testEnv`, backend, and
keep `mode:"dry-run"` until the dry run is boring. For a `service` backend, you can preview and then
perform the hub bootstrap once the project entry exists:

```bash
dev-loop init-service <key> "<name>" <PREFIX> --dry-run
dev-loop init-service <key> "<name>" <PREFIX>
```

After the dry run is clean, set `"mode": "live"` in `projects.json` and launch the loop.

### B. Claude plugin onboarding

If you installed the Claude plugin and ran `/plugin install dev-loop@dev-loop-npm`, run the setup
command **once** — it is idempotent and operator-present:

```
/dev-loop:init
```

It will, with you in the loop:
1. **Detect the project shape & confirm repos.** init detects greenfield (no code yet) /
   brownfield (existing code) / adopting (pre-existing human tickets), and single- vs
   multi-repo. It echoes back each `repoPath` / `repos[].path` (the loop *commits from
   them*, so this is a gate). Greenfield runs a short strategy interview; brownfield is
   read-only-mapped into the doc-base `Current state`.
2. **Ask the backend** — `linear` (coordinate through Linear), `local` (a machine-local
   file board in the data dir), or `service` (the local hub; no Linear needed unless you opt into mirror/report sinks).
   See [conventions §18](../references/conventions.md#18-backend--linear-vs-local).
3. Gather/validate the per-project config and write it to
   `~/.dev-loop/projects.json` (or `DEVLOOP_PROJECTS_JSON`, creating only what's missing).
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
`/dev-loop:pm-agent`, `qa-agent`, `senior-dev-agent`, `junior-dev-agent`, `sweep-agent`, `reflect-agent`, and the
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

# Legacy single-dev loop, if you explicitly want the old one-pane Dev.
dev-loop run --cli claude --agents legacy
```

Default agents are `core` (`pm,qa,senior-dev,junior-dev,sweep`). Add `reflect`, `outward`, or individual
agents with `--agents`, for example `--agents core,reflect,ops,communication`. Default
cadences match §4: PM/QA/Senior-Dev/Junior-Dev every ~5 minutes, Sweep ~30 minutes, Ops ~10 minutes, and
daily roles every 24 hours. Override one with `--interval communication=12h` or
`--interval pm=2m`.

Project selection is automatic when the scheduler starts inside a configured repo: it
matches the current directory against `repoPath` / `repos[].path` in `projects.json`.
Use `--project <key>` only when you launch from outside the repo, when a process manager
uses a fixed cwd, or when you want to override the cwd match. Use `--cwd <path>` to make
repo matching explicit without changing the shell's current directory. If neither
`--project` / `DEVLOOP_PROJECT` nor the cwd resolves to a configured repo, the scheduler
stops with a setup hint instead of guessing another project.

Multiple projects on one machine are normal. Put them all under the same
`~/.dev-loop/projects.json`, each with a distinct project key and repo path(s), then run
one scheduler process per product:

```bash
cd /work/products/alpha && dev-loop run --cli claude --agents core
cd /work/products/beta  && dev-loop run --cli codex  --agents core,communication
```

For a multi-repo product, configure `repos[]` instead of a single `repoPath`; any path inside one
of those repos resolves to that product. The scheduler uses `repoPath`, then the `repos[]` entry with
`role:"primary"`, then `role:"docs"`, as the subprocess cwd. The initial config can come from manual
`projects.json` editing or from `/dev-loop:init`; after that, adding another repo or another project
is just editing `projects.json` (or re-running init for that project if you use the plugin path).

Useful options:
- `--once` runs each selected agent once and exits.
- `--dry-run` prints commands and validates skill paths without calling Claude/Codex.
- `--root`, `--data`, `--hub-db`, `--project`, and `--cwd` make the run explicit for cron/systemd.
- `--cli-arg <arg>` passes extra executor flags after the scheduler's default model/effort
  flags. Use `projects.json` `models` / `efforts` for durable per-agent profiles; use
  `--cli-arg` for a one-off override.
- `--codex-safe` omits Codex's `--dangerously-bypass-approvals-and-sandbox` flag. **Do not use it
  for unattended Codex loops.** Without that flag Codex asks for approval on every MCP tool call, and
  in non-interactive `codex exec` the call is auto-cancelled (`dev-loop-hub/whoami (failed)` →
  `user cancelled MCP tool call`) — the agent never reaches the hub and the loop spins doing nothing.
  The **default** mode adds the flag (the same recipe as `PORTABILITY.md`) so the hub tools operate
  unattended; pass `--codex-safe` only for an *attended* run where you approve each tool call yourself.
  (Claude Code has no equivalent gate — its inline `--mcp-config` tools run without approval.)

The runner writes one log per agent under
`${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/runner-logs/`. Stop it with `Ctrl-C`; it forwards
SIGINT to active agent subprocesses. This mode is the most portable: run it from tmux,
cron, launchd, systemd, or any host process manager.

### B. Agent View — native Claude UI (`claude agents`)

Use Agent View when you want Claude's background-session UI instead of the `dev-loop run`
process. If `/plugin list` does not show `dev-loop`, run `dev-loop install-claude-plugin` — it
registers a local **npm-source** marketplace and prints the `/plugin marketplace add …` +
`/plugin install dev-loop@dev-loop-npm` commands to run (the plugin is pulled from the
`@dyzsasd/dev-loop` npm package — no GitHub, no source checkout). Restart Claude Code or run
`/reload-plugins` afterward.

[Agent View](https://code.claude.com/docs/agent-view) (Claude Code >= 2.1.139) is one
screen for all your background sessions — *Needs input / Running / Done* — that keep
running with no terminal attached.

```
claude agents            # open the view (scoped: claude agents --cwd ~/path)
```

Then dispatch each agent as its own self-looping row (a plugin skill invocation typed in the view
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

> **Model note:** a dispatched Agent View session uses the **view's** model/effort. Agent View
> applies one profile per view, so different per-agent profiles require separate views or the
> `dev-loop run` scheduler.

> **Two-tier Dev (default):** use these two rows for Dev, a design-lead + implementer pair:
> ```
> /loop 5m  /dev-loop:senior-dev-agent   # opus/max — designs modules, delegates to junior-dev, escalation direct-code
> /loop 5m  /dev-loop:junior-dev-agent   # sonnet/high — implements pre-designed tickets against the linked design
> ```
> In Agent View you set those model/effort choices on the views themselves. In `dev-loop run`,
> the scheduler applies them automatically from its built-in defaults or from `projects.json`
> `models` / `efforts`. See [conventions §21a](../references/conventions.md#21a-the-two-tier-dev--senior-dev--junior-dev-default-per-project)
> and [config-schema.md](../references/config-schema.md) for routing rules, the design gate, and
> the per-backend tier encoding. Use `/dev-loop:dev-agent` only for an explicit legacy single-dev project.

> For an attended one-shot Codex run, `dev-loop run --cli codex --once` is the path —
> it injects the hub MCP via `-c` exactly as the cadence runner does. (The old
> `install-codex-prompts` / `~/.codex/prompts/*.md` compatibility layer was removed in 0.23.0;
> Codex deprecated custom prompts in favor of skills, and `dev-loop run --cli codex` is the
> durable launch path.)

### C. External process managers

For unattended operation under tmux, launchd, systemd, cron, or a container supervisor, run the same
`dev-loop run` command under that manager. The scheduler owns agent cadence, resolves the project from
cwd or `--project`, injects the hub MCP for Claude/Codex, and writes logs under the dev-loop data dir.

```bash
cd /path/to/product-repo
dev-loop run --cli codex --agents core,communication

# More explicit for a process manager with a fixed cwd:
dev-loop run --cli codex --project <key> --cwd /path/to/product-repo --agents core,communication
```

`dev-loop run` applies per-agent model/effort defaults itself and lets `projects.json`
override them. `--cli-arg` is still available for one-off executor flags. The old data-dir
`run-loop.sh` launcher is legacy; new installs should not create runtime scripts under a
Claude plugin data directory.

---

## 3. Per-agent models and effort

The model is chosen **at launch**. A SKILL cannot switch its own model after the
executor starts, so `dev-loop run` pins model and effort/reasoning strength before each
agent fire. Dry-runs print the resolved profile:

```text
dev-loop run: launch=pm:opus/max, qa:sonnet/high, senior-dev:claude-opus-4-8/max, junior-dev:claude-sonnet-4-6/high, sweep:sonnet/high
```

Defaults are role-based, not one-size-fits-all:

| Agent | Claude default | Codex default | Effort | Why |
|---|---|---|---|---|
| **pm** | `opus` | `gpt-5.5` | Claude `max`, Codex `xhigh` | product/scoping judgment + review |
| **senior-dev** | `claude-opus-4-8` | `gpt-5.5` | Claude `max`, Codex `xhigh` | design, decomposition, escalations |
| **junior-dev** | `claude-sonnet-4-6` | `gpt-5.5` | `high` | implements pre-designed tickets |
| **dev** *(legacy)* | `opus` | `gpt-5.5` | Claude `max`, Codex `xhigh` | single-pane implementation loop |
| **qa** | `sonnet` | `gpt-5.5` | `high` | frequent verification work |
| **sweep** | `sonnet` | `gpt-5.5` | `high` | board hygiene and reclaim |
| **reflect** | `opus` | `gpt-5.5` | `xhigh` | daily retrospective judgment |
| **ops** | `sonnet` | `gpt-5.5` | `high` | polling + incident filing |
| **architect** | `opus` | `gpt-5.5` | `xhigh` | whole-codebase architecture review |
| **communication** | `sonnet` | `gpt-5.5` | `high` | factual public-facing drafts |

Override only what your account or budget needs in `projects.json`:

```jsonc
"models": {
  "senior-dev": { "claude": "claude-opus-4-8", "codex": "gpt-5.5" },
  "junior-dev": { "claude": "claude-sonnet-4-6", "codex": "gpt-5.5" },
  "communication": "sonnet"
},
"efforts": {
  "pm": { "claude": "max", "codex": "xhigh" },
  "junior-dev": "high",
  "reflect": "xhigh"
}
```

`extrahigh` / `extra-high` are accepted as aliases for `xhigh`. Claude supports `max`;
Codex uses `xhigh` as the strongest scheduler-applied tier. `--cli-arg` is still appended
after the defaults for a temporary override.

---

## 4. Cadence

Agents self-throttle (idle fires are cheap no-ops), so tighter intervals are safe:

| Agent(s) | Cadence | Why |
|---|---|---|
| PM / QA / Senior-Dev / Junior-Dev | ~5 min | the producing loop |
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
   `node:sqlite`; no native build). If your default `node` is older but a newer one exists, set
   `DEVLOOP_NODE=/absolute/path/to/node`; the packaged CLI, daemon autostart, and compatibility hook will use it.
2. Set `backend:"service"` in `projects.json`; keep `strategyDoc` a **repo file**.
3. Let the packaged CLI wire the service runtime:
   ```bash
   dev-loop init-service <project-key> "<Project Name>" <UNIQUE-PREFIX> --dry-run
   dev-loop init-service <project-key> "<Project Name>" <UNIQUE-PREFIX>
   ```
   This seeds the project, merges `dev-loop-hub` into the product repo `.mcp.json`, runs `doctor`,
   starts the daemon once, checks `/api/health`, and reports how to install login autostart.

Manual fallback: **create the project in the hub once** (the hub refuses to auto-create a board from
a typo'd `DEVLOOP_PROJECT`, and each project needs a **unique ticket prefix** since ticket ids are a
global key):
   ```bash
   dev-loop seed <project-key> "<Project Name>" <UNIQUE-PREFIX>
   # e.g.  dev-loop seed monpick "MonPick" MP
   ```
Then health-check it: `DEVLOOP_HUB_DB=~/.dev-loop/hub.db dev-loop doctor` → `DOCTOR_OK`. Keep
`hub.db` **outside** any product repo (the template defaults to `~/.dev-loop/hub.db`); if it
must live in a repo, gitignore `hub.db*` (doctor will tell you if it's exposed).

**Launch — set the identity per pane.** Each pane exports its agent + project before the
`/loop` (the hub reads them); the `.mcp.json` `${…}` expansion carries them into the hub
process.

**Project precedence (DL-13):** explicit `DEVLOOP_PROJECT` (non-empty) **>** the process **cwd**
(the repo it was launched in — matched against the configured `repoPath`/`repos[]`) **>** unresolved.
So `DEVLOOP_PROJECT` is **optional** when you launch from inside a project's repo: unset/empty falls
back to the cwd match (`dev-loop-hub resolve-project [--cwd <path>]` is the shared matcher). A cwd
that matches a configured-but-unseeded project **errors loudly** (it does not silently fall through to
`demo`); a cwd outside every configured repo does not guess either. Set `DEVLOOP_PROJECT` explicitly
to override the cwd, or to be unambiguous in a launcher that spawns the MCP server from a fixed dir.

```bash
DEVLOOP_ACTOR=pm         DEVLOOP_PROJECT=<project-key> /loop 5m  /dev-loop:pm-agent
DEVLOOP_ACTOR=qa         DEVLOOP_PROJECT=<project-key> /loop 5m  /dev-loop:qa-agent
DEVLOOP_ACTOR=senior-dev DEVLOOP_PROJECT=<project-key> /loop 5m  /dev-loop:senior-dev-agent
DEVLOOP_ACTOR=junior-dev DEVLOOP_PROJECT=<project-key> /loop 5m  /dev-loop:junior-dev-agent
DEVLOOP_ACTOR=communication DEVLOOP_PROJECT=<project-key> /loop 24h /dev-loop:communication-agent
# …sweep/reflect/ops/architect likewise, each with its own DEVLOOP_ACTOR
```

The built-in scheduler (§2A) sets these per fire for you. External launchers should set them per
pane. Verify a pane is wired with
`DEVLOOP_ACTOR=pm claude mcp list` → `dev-loop-hub … ✓ Connected`, and `whoami` inside a
session returns `pm`. The hub DB is machine-local runtime state — never committed.

### Observe the loop — the localhost web UI

The hub ships a localhost HTTP surface over the same `hub.db` — a server-rendered board
(filters + assignee swimlanes) plus ticket / roadmap / reports / activity viewers and a JSON
API — so you can *watch* the loop without touching the system of record.

**Auto-start is owned by dev-loop, not by Claude.** For a one-time foreground bootstrap,
`dev-loop init-service` runs `dev-loop daemon up` after seeding. On macOS, global npm install attempts
to install the LaunchAgent automatically; if scripts were skipped, autostart was disabled, or you need
to repair it, run:

```bash
dev-loop daemon install-autostart
# remove it later with:
dev-loop daemon uninstall-autostart
```

The LaunchAgent runs `dev-loop daemon up-all`, which starts every configured
`backend:"service"` project. The daemon uses a fixed default port, **8787**, and if that port is
occupied it probes upward and records the actual URL in the runfile. One daemon is kept per project
and never double-started. Find the live URL any time:

```bash
# the lifecycle prints + records the URL (the DL-41 runfile ~/.dev-loop/daemon-<key>.json):
dev-loop daemon status   # → '<project-key>' RUNNING → http://127.0.0.1:<port>
```

To start it by hand, use the **idempotent lifecycle** — `daemon up` is a clean no-op if already running:

```bash
DEVLOOP_PROJECT=<project-key> dev-loop daemon up
# → started '<key>' → http://127.0.0.1:8787   # or the next free port, recorded in the runfile
```

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
- **External process manager:** restart the same `dev-loop run ...` command, or reattach to the
  manager/session that owns it.
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
