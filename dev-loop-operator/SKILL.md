---
name: dev-loop-operator
description: >-
  Operate dev-loop (an autonomous SDLC agent team) from ANY agent harness: install the
  engine, initialize a workspace, start/stop the daemon and scheduler, read progress,
  change config safely, upgrade, troubleshoot, file system proposals. Load this skill,
  then drive everything through the `dev-loop` CLI with the recipes below.
  安装引擎、初始化 workspace、启停 daemon、判读进展、安全改配置、升级、排障——全部通过
  shell 命令完成，不依赖任何特定 harness 机制。
---

# dev-loop operator handbook (harness-neutral)

This directory is dev-loop's **first-class distributable**: pure markdown + pure shell. Any
harness that can run a shell — Claude Code, Codex, opencode, or a plain terminal — loads this
skill and gets the whole operator surface. The engine is the npm package `@dyzsasd/dev-loop`;
**this skill installs it**, not the other way round. The Claude plugin
(`dev-loop install-claude-plugin`) is an optional convenience for `/dev-loop:*` slash commands.

**Architecture in one minute.** Nine stateless agents are fired one at a time by the in-package
scheduler `dev-loop run`; each fire is a one-shot `claude -p` / `codex` / `opencode` process whose
prompt inlines the agent's SKILL + conventions slice from the package — **a machine needs only the
npm package and a logged-in coding CLI**. Truth lives in the workspace: `dev-loop.json` (config,
env-var NAMES only), `.dev-loop/hub.db` (board), `.dev-loop/team/fires.jsonl` (cost + health).

---

## §1 Environment check & install (first on every new machine)

```bash
bash "$(dirname "$0")/scripts/ensure-install.sh"      # from this skill's directory
DEVLOOP_VERSION=1.15.1 bash scripts/ensure-install.sh   # pin
DEVLOOP_INSTALL_SOURCE=/path/to/dev-loop-x.y.z.tgz bash scripts/ensure-install.sh   # tarball / URL
DEVLOOP_INSTALL_SOURCE=/path/to/dev-loop-checkout  bash scripts/ensure-install.sh   # git checkout
```

Idempotent: ① node ≥ 23.6 (`DEVLOOP_NODE=/abs/node` honored); ② a coding CLI on PATH (`claude` |
`codex` | `opencode`) + login hints; ③ engine via a 3-tier source — `DEVLOOP_INSTALL_SOURCE` →
`npm i -g @dyzsasd/dev-loop@<pin> --ignore-scripts` → `git clone` + `npm ci --ignore-scripts` +
`npm run build` + `npm i -g ./hub`; ④ `python3 security/source_integrity.py --whole-tree` when a
source tree is at hand (labelled skip otherwise); ⑤ prints the `export PATH=…` line if npm's global
bin is off PATH; ⑥ `dev-loop doctor`, then `环境就绪 ✔ / ready`. **The one step that cannot be
scripted:** CLI login is interactive — run `claude` / `codex login` / `opencode auth login` once.

## §2 Workspace init & project registration

```bash
mkdir -p ~/work/my-team && cd ~/work/my-team
dev-loop init --yes                       # guided: team init + first project + doctor NEXT (idempotent)
# or piece by piece:
dev-loop team init --dir . --key my-team --backend service --yes
dev-loop team add-project web --prefix WEB          # service backend: auto-seeds the hub row
dev-loop team add-repo web-app --project web --path repos/web-app --remote git@… --detect
dev-loop doctor                           # read-only; last line NEXT: names the most-blocking step
dev-loop team set team.mode live          # first contact defaults to dry-run
```

Secrets: `dev-loop secret set <NAME>` (TTY prompt → `.dev-loop/secrets.env`, mode 600). Never put
a value in `dev-loop.json`.

## §3 Daemon & scheduler start/stop

Two long-running things: the **hub daemon** (localhost board + op-API; `dev-loop run` ensures it
itself) and the **scheduler** (`dev-loop run`, the process that fires agents). Detection order:
**systemd --user (Linux) → launchd (macOS) → nohup fallback.**

```bash
dev-loop hub ensure && dev-loop hub status        # daemon: idempotent start / URL + pid + version
dev-loop hub stop                                 # daemon: stop + WAL checkpoint
dev-loop daemon install-autostart [--workspace <root>] [--dry-run]   # login item: systemd --user
                                                  # unit on Linux, LaunchAgent on macOS; --dry-run renders anywhere
dev-loop daemon uninstall-autostart               # symmetric removal
dev-loop run --agents core --background --change-gate   # scheduler, detached; log → .dev-loop/run.log
dev-loop stop                                     # scheduler only — drains in-flight fires, daemon stays up
```

Hand-managed units live in `templates/systemd/` (`dev-loop-daemon@.service`,
`dev-loop-scheduler@.service`) and `templates/launchd/`: copy to `~/.config/systemd/user/` (or
`~/Library/LaunchAgents/`), edit the marked paths, `systemctl --user daemon-reload && systemctl
--user enable --now dev-loop-scheduler@<team-key>`, `loginctl enable-linger "$USER"`. No init
system: `cd <ws> && nohup dev-loop run --agents core >> .dev-loop/run.log 2>&1 &`.

## §4 Reading progress (the daily read)

```bash
dev-loop status --json        # PRIMARY: one JSON — scheduler/daemon liveness, pause + breaker state,
                              # decision queue, last fires, doctor W-codes (fallbacks below if absent)
dev-loop hub status           # daemon per project: RUNNING → url (pid, version, actor) / stopped
dev-loop doctor               # read-only health ladder; NEXT: line + W-codes
dev-loop metrics --window 24h # fire success by agent, $ + tokens, budget vs dailyUsd, errorClass tally
dev-loop approvals            # the typed decision queue — what waits on a human
dev-loop queue; dev-loop tickets --state "In Review"   # board view without the UI
```

What matters: **the decision queue** (`approvals`, `needs-*`/`blocked` tickets, doctor **W20**) —
answer with `dev-loop comment add <id> --body …` or `dev-loop approve <key>`; **breaker state** —
`breaker OPEN <errorClass>` in `run.log`/`status` means consecutive identical failures (spend-limit /
rate-limit / auth / network) parked that lane on a probe cadence; it closes itself once a probe
succeeds; **W-codes that page you**: W09/W11 (CLI or binary missing), W12/W13 (secret unresolvable),
W22 (landing stall), W25 (port band exhausted), W28 (daemon on old code), W36 (scheduler build
skew), W39 (secrets.env world-readable), W44 (dead lane). A repo dirty *during* a fire is normal.

## §5 Config changes — pause → drain → edit → resume

Some fields (agent cadences, providers, notifier cadences) load only at startup; none should change
under an in-flight fire.

```bash
dev-loop pause --drain --reason "config: bump senior-dev effort"   # no new fires; waits for in-flight
# fallback without --drain: dev-loop pause --reason "…", then poll `dev-loop metrics --window 1h`
# / .dev-loop/locks until no fire is running
dev-loop team set projects.web.agents.senior-dev.effort max        # validated single-field writes
dev-loop doctor && dev-loop resume
```

Startup-only fields (providers, cadences) also need `dev-loop stop` → `run` to reload.

## §6 Upgrade & the build-overlap rule

**Never `npm i -g` over a running scheduler.** Node caches modules at import time: the loop keeps
the old build while doctor reports the new one (W36), and a source `npm run build` deletes
`skills/` mid-fire. Always:

```bash
dev-loop pause --drain --reason "upgrade"    # 1. drain
dev-loop stop                                # 2. scheduler exits (fires drained)
bash scripts/ensure-install.sh               # 3. install (DEVLOOP_VERSION=… / DEVLOOP_FORCE_INSTALL=1)
dev-loop doctor                              # 4. no W36 build skew, no W28 old-code daemon
dev-loop daemon up-all                       # 5. daemon restarts on the new code (idempotent)
dev-loop run --agents core --background && dev-loop resume   # 6. resume
```

A daemon NEWER than the CLI refuses `daemon up` (stale CLI): upgrade the CLI, not the daemon.

## §7 Fault handbook (live cases)

| Symptom | Reading | Action |
|---|---|---|
| `hub status` says stopped but :8787 answers | stale runfile (pid died) or a foreign listener | `dev-loop daemon reap --dry-run`, then `reap`; foreign → `DEVLOOP_DAEMON_PORT=<free> dev-loop hub ensure` |
| `daemon up` logs `EADDRINUSE`; doctor W25 | port band 8787.. held by orphans / other workspaces | `dev-loop daemon reap` (reaps only `dbPresent:false` dev-loop-hub listeners, never a live board) |
| board frozen at one instant, later 503 | `hub.db` inode swapped (restore / copy over the file) | `dev-loop hub stop && dev-loop hub ensure`; never restore a live board from inside a fire |
| fires exit in seconds, zero tokens; breaker OPEN | quota / rate-limit / auth (`errorClass` in `metrics`) | fix the account (billing, `claude` re-login); the breaker probes and closes itself |
| doctor W28 / W36 | version skew CLI ↔ daemon ↔ scheduler | run §6 in order; `dev-loop daemon status` names the stale side |
| `stop` finds no scheduler but `run` says lock busy | stale `.dev-loop/locks/run.lock` after OOM/reboot | confirm the pid is dead, delete the lock, `run --background` |
| W20 stall / `needs-*` tickets pile up | agents wait on a human decision | answer on the ticket (`comment add`) or `approve` — that is the job |

## §8 System proposals (the §17 firewall)

Nobody edits a SKILL or `references/conventions.md` in place. A framework-level finding (scheduler /
CLI / gate defect, a rule that should change) goes to the proposal inbox:

```bash
dev-loop system propose --title "…" --body-file finding.md    # queued for operator review
dev-loop system proposals                                     # list / triage
```

Fixes land in the dev-loop repo with a regression test that fails before the fix.
