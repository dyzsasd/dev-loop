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
   (`pm-state.json` / `qa-state.json` / `lessons.md`), and print a **readiness checklist**.

When the checklist is green, set `"mode": "live"` in `projects.json` (init leaves new
projects in `dry-run` for first contact) and launch the agents (next section).

> Re-running `/dev-loop:init` on an existing project is safe — it re-checks and
> re-prints the readiness report, overwriting nothing.

---

## 2. Launch the agents

The plugin **ships no harness** — pick whichever fits. Both run the same eight skills:
`/dev-loop:pm-agent`, `qa-agent`, `dev-agent`, `sweep-agent`, `reflect-agent`, and the
three opt-in **outward** agents (conventions §21) `ops-agent`, `architect-agent`,
`signal-agent`.

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
/loop 1h  /dev-loop:signal-agent     # OUTWARD (§21), opt-in — real-user signal intake (no-op if no sources)
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

## 5. Resume / restart

**There is no special resume step — the agents are stateless per fire** (conventions §0).
All state lives in Linear (or the local board), git, and the `*-state.json` files, never
in conversation memory. So to resume after stopping (or a crash, a reboot, a laptop
sleep): **just launch the agents again** — each re-reads ground truth and continues
exactly where the board left off.

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
