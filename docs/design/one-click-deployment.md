# One-click deployment — local interactive `up`, movable home, attach from anywhere

Status: **accepted & implemented** (branch `one-click-1.4`). Target: **1.4.0**. Date: 2026-07-18 (rev 3).

Rev 3 — AS BUILT (operator decisions 2026-07-18: pivot confirmed; **age** is the encryption default
(Q3); **marker+refuse** is the whole source-retirement mechanism (Q4); build everything). Deltas from
the rev-2 text, recorded here rather than rewritten throughout:

- **All three legs shipped together** — attach did not wait for a later phase: the §1.5 pair
  (`DEVLOOP_DAEMON_HOST` + `DEVLOOP_UI_TOKEN`, landing together with a fail-closed boot refusal),
  `dev-loop up` (LOCAL), `bundle export`/`up --bundle` (MOVE), `dev-loop attach`/`up --attach` +
  `DEVLOOP_HUB_URL` (ATTACH), the Q1 mutators (`team add-provider`, `dev-loop secret set` with the
  hidden TTY prompt), per-fire secret scoping (Q9: fires see only their own provider key), and the
  deploy artifacts (`deploy/`: Dockerfile + compose + single-replica Helm + systemd).
- **§2.2 flag verification landed**: interactive claude accepts `--model/--effort/
  --append-system-prompt`; the opencode TUI accepts `--model` but has NO effort flag (config carries
  it); claude trust pre-seeds via `~/.claude.json` `projects.<path>.hasTrustDialogAccepted` (verified
  structure, merge-only).
- **§3 simplification**: the console skill is a SETUP-class skill (the budget lint forbids cheat
  blocks outside `*-agent` dirs), teaching live `--help` over frozen sheets; the workspace-root
  `CLAUDE.md`/`AGENTS.md` briefs are self-sufficient (`operator-brief.ts`), which made the separate
  `export-operator-console` flatten verb unnecessary — it was not built.
- **§4 format**: a single-file bundle (`DEVLOOP-BUNDLE/1` + plaintext manifest line + age-encrypted
  JSON payload) rather than a tar; headless identity via `AGE_IDENTITY_FILE`/`DEVLOOP_BUNDLE_KEY`;
  a `--no-hub-db` clean-board load seeds `_team` and lets W08 name the per-project seeds.
- **§6.0 required one matrix change**: the D1 project override now grants the **operator** free
  cross-project reach (conventions §18 updated; agents stay exactly as gated) — the attach console
  posts real-project ops through a `_team`-booted daemon.
- **§6.3**: the hosted ttyd console ships as a documented compose option, not a wired service —
  attach is the primary remote console.

---

Previous revision header (rev 2 — the design as reviewed):

Rev 2 (operator decisions, 2026-07-17) — four questions resolved and one structural pivot:

- **Q1 → clean mutators, plus a refinement:** first-class `team add-provider` + `dev-loop secret set`
  verbs (§2.5 step 4). `secret set` prompts for the VALUE on the TTY (or `--stdin`), so **an API key
  never transits the chat transcript, the model context, or shell history** — the conversational setup
  stays clean of secret material. The console skill's "never hand-edit `dev-loop.json`" HARD LIMIT now
  holds uniformly with no carved exception (§3.1(d)).
- **Q2 → local claude = its own login; containers = opencode on API keys.** Appendix A (claude
  provider-env injection) stays deferred; the split is now *permanent posture*, not a stopgap — and the
  attach pivot below makes it comfortable: the console runs locally (claude, subscription login), the
  muscle runs remotely (opencode, keys).
- **Q5 → `run` owns the daemon** (Option A). The container entrypoint chains into `dev-loop run`, whose
  existing auto-ensure (`run-agents.ts:1244-1247`) starts and owns the single daemon through the
  lifecycle path (which writes the runfile the idempotent ensure reads). No separate foreground boot.
- **Q6 → the bundle carries `hub.db`, and the operator wants remote progress to flow back.** This
  request exposed the deeper truth (the rev 2 pivot): **a workspace has exactly ONE live home.**
  The bundle is a **move/backup** artifact, not a sync mechanism — `hub.db` travels on migration
  (WAL-checkpointed, `team import --hub-db` re-key machinery); ongoing progress flows back not by
  copying state but by **attaching** to the home (§6.0: the local console + CLI drive the remote hub
  over the op-API + token) plus **git** (repos push to their remotes — code progress never needed a
  bundle). Two live copies of one board are exactly the double-drive/split-brain class the codebase
  already rejects (`workspaceId` fingerprint, one-way mirror §18) — so sync is *dissolved*, not solved.

Decision trail (operator, 2026-07-17):
1. Two products under one banner. "One-click" splits into a **LOCAL interactive** path (`dev-loop up`
   → land in a coding-agent chat that does setup conversationally) and a **REMOTE declarative** path (a
   secret-carrying bundle authored locally, loaded headless on a host/container/pod). They share a
   bootstrap kernel but are *not* the same code path — the interactive launcher is net-new; the headless
   loader reuses today's `dev-loop run` scheduler verbatim.
2. opencode is the **product default** runner (the only lane that reaches arbitrary API-key providers with
   no subscription login, per 1.3.0 provider routing); Claude Code is *this operator's* local preference.
   Both are expressible through the existing launch-profile precedence with **zero code branching** —
   `team.defaultCodingAgent` carries it declaratively (`run-agents.ts:524-531,362-365`).
3. The board UI already exists and already auto-starts (`daemon-lifecycle.ts:239-258`); one-click *binds*
   it into a session, it does not rebuild board hosting.
4. Remote write-surface exposure is gated behind a token layer the daemon's own invariant already
   demands (`daemon.ts:181-183`). For the **LOCAL** path, Phase 1 ships loopback + tunnel only, no token.
   For the **container** path this is not optional: see point 5.
5. **The daemon binds `127.0.0.1` hardcoded (`daemon.ts:629`).** A process on the container's loopback is
   *not* reachable via the pod/container IP, so K8s `httpGet` probes and a published compose port both hit
   nothing. Therefore a **bind-address knob** (`DEVLOOP_DAEMON_HOST`, default `127.0.0.1`; container sets
   `0.0.0.0`) is a **hard prerequisite for ANY container form** — it is not deferred to Phase 2. Per the
   `daemon.ts:181-183` invariant, widening the bind MUST land *together with* the `DEVLOOP_UI_TOKEN` auth
   check, so that auth work is pulled into **Phase 1 for the container path only** (§6.2, §8). If the bind
   knob cannot ship in Phase 1, then containers cannot expose *or* health-probe the board at all, and the
   Docker/compose/K8s surface (§5) moves wholesale to Phase 2 — there is no half-measure.

This document cites real code with `file:line`. It never assumes an API that a reader did not confirm.
Where an external-CLI flag or invocation is only *hypothesized* by a reader (not confirmed against the live
CLI), it is marked **UNVERIFIED** and the design leans on a confirmed fallback instead of relying on it.

---

## 1. Problem & the two-mode split

### 1.1 What exists, what does not

dev-loop today has every *primitive* for a running dev team but no *one-click* on-ramp:

- **Setup** is a guided config wizard, `dev-loop init` (`init-wizard.ts:16-18,104-177`), that composes the
  validated mutators (teamInit → provisionClaudePermissions → addProject → interactive addRepo →
  runDoctor). It does **not** touch providers/secrets, does **not** start the daemon or the loop, and
  never launches a chat.
- **The board** is a background localhost web service, `dev-loop daemon up` / `hub start`
  (`daemon-lifecycle.ts:191`, `hub.ts:51`), pinned `DEVLOOP_ACTOR=operator` (`daemon-lifecycle.ts:239-258`),
  served loopback-only at `127.0.0.1:8787` (`daemon.ts:629-692`).
- **The loop** is a *headless* scheduler, `dev-loop run` (`run-agents.ts`), that shells out
  `claude -p` / `codex exec` / `opencode run` **once per fire** with `stdio:["ignore","pipe","pipe"]`
  (`run-agents.ts:624-689,919`). There is no TTY, no chat, no interactive launch path **anywhere** in the
  codebase.
- **`dev-loop up` does not exist.** `cli.ts` ROUTES (`cli.ts:20-55`) has no `up` verb. A repo/doc grep for
  `dev-loop up`, "interactive chat", or chat auto-start returns nothing. The headline vision — "land
  directly in an interactive coding-agent chat" — is **0% built**.
- **No bundle author/loader** exists. `team import` (`team-import.ts`) is a one-shot v1→v2 migration;
  `export-desktop-skill` renders a Claude Desktop skill, not a secret bundle. There is **no Dockerfile,
  compose, or helm** in the tree (only two GitHub-workflow YAMLs).

### 1.2 The three legs — up, move, attach

The essential need behind "remote deployment" is: *the loop keeps running when the laptop sleeps, on
API-key models, and the operator can check in and steer from anywhere.* That decomposes into three legs
over ONE live workspace home — never two live copies:

**LOCAL — interactive, chat-driven (`dev-loop up`).** `up` performs a *minimal* bootstrap
(resolve/scaffold a workspace, start the board daemon), then launches an **interactive** coding-agent
session (Claude Code for this operator, on its own login — Q2; opencode as the shipped default) primed
with an **operator-console skill**. The human never types a shell command: the coding agent drives
`dev-loop` CLI verbs conversationally to do team/project/repo/provider setup and then starts the daemon +
`dev-loop run` loop.

**MOVE — declarative, headless (`dev-loop bundle` → `up --bundle`).** `bundle export` authors a portable,
secret-carrying archive locally — config + secrets + **the board itself (`hub.db`, Q6)** + git
credentials. A remote host/container/pod runs `dev-loop up --bundle <file>`: decrypt secrets into
`.dev-loop/secrets.env`, restore the board, re-materialize machine-local state (clone repos from their
remotes), run a `dev-loop doctor` preflight, then chain into the headless `dev-loop run` loop (which owns
the daemon — Q5) — **no chat, no interactive setup**. The bundle is a **migration/backup format**: it
moves the home (or snapshots it), it never synchronizes two live homes.

**ATTACH — operate the home from anywhere (`dev-loop attach`, §6.0).** After the home moves, the local
machine flips to a **client**: the same interactive console (local claude on its login) and the same CLI
verbs, but pointed at the remote hub over the token-authed op-API. "Progress syncs back" is thereby
automatic and live — board/docs/decision-queue because you are looking AT the one hub, code because repos
push/pull through their git remotes, and full repatriation because `bundle export` runs on the remote too
(reverse migration; scheduled export doubles as backup, §4.6).

### 1.3 The shared bootstrap kernel

Both modes converge on the same *workspace contract* — the seam where they share code:

1. **Workspace resolve/scaffold** — `dev-loop.json` (schema v2) + `.dev-loop/` (`workspace.ts:6-8`).
   Discovery lever = `DEVLOOP_WORKSPACE` (`workspace.ts:22-29`); resolution auto-hydrates
   `.dev-loop/secrets.env` into `process.env`, env-wins (`secrets.ts:60-70`, `workspace.ts:57`).
2. **Provider/secret layer** — `team.providers` (env-NAME auth, §16, `team-config.ts:46-53`) rendered to
   workspace `opencode.json` by `team sync-opencode` (`opencode-sync.ts:15-26`); key VALUES in
   `.dev-loop/secrets.env` (chmod 600, `secrets.ts:1-16`). This is the "API keys, no subscription login"
   surface.
3. **Board daemon** — `daemon up` / `hub ensure`, idempotent, health-gated (`daemon-lifecycle.ts:191`,
   `/api/health` real liveness probe `daemon.ts:545-552`).
4. **The loop** — `dev-loop run`, which auto-ensures the hub daemon on service backends
   (`run-agents.ts:1244-1247`).

The kernel is identical; the legs diverge only at the top: **LOCAL adds an interactive launcher +
console skill; MOVE adds a bundle author/loader; ATTACH adds an HTTP transport under the existing CLI
verbs** (the op-API + `op-client.ts` seam already exists — §6.0). Everything below builds outward from
this kernel and never forks the hot headless path in `commandFor()`/`runAgent()`.

---

## 2. `dev-loop up` (LOCAL): minimal bootstrap → interactive operator session

`dev-loop up` is a **new** top-level verb routed in `cli.ts:20-55`. It does **not** reimplement any
mutator — it composes `dev-loop init` (which already composes team-init/add-project/add-repo/doctor) for
scaffold, then adds the four missing pieces: **provider/key capture, unconditional repo clone, daemon
start, and the interactive chat launch**. Critically, `up` does *not* do the setup itself — it hands that
work to the coding agent it launches. `up`'s own job is only: resolve a workspace, ensure the board is up,
resolve the operator launch profile, and exec the interactive session with the right env + priming.

### 2.1 Phase A — minimal bootstrap (what `up` does before the chat)

```
dev-loop up [--dir <d>] [--cli claude|opencode] [--model M] [--effort E] [--bundle <file>]
```

Local (no `--bundle`) flow:

1. **Resolve or scaffold the workspace.** If `dev-loop.json` exists → resolve it (inherits
   `init-wizard.ts:111-114` resume idempotency). If absent → run the *scaffold-only* subset of
   `team init` (`team-init.ts:92`): write `dev-loop.json` + `.dev-loop/{team,lessons,wt,locks}`, provision
   the `Bash(dev-loop *)` allow rule in `.claude/settings.json` (`team-init.ts:179-204`), and — **new,
   §3.2** — scaffold the workspace-root `CLAUDE.md` + `AGENTS.md` priming files. On a **service** backend
   this also seeds `hub.db` + the `_team` intake project (`team-init.ts:152-155`). We do **not** create the
   first product project here — that is the agent's first conversational job, so the operator can name it.
2. **Start the board daemon.** Call the existing `hub ensure` / `daemon up` path (idempotent, health-gated,
   default 8787) so the ticket board is live at `http://127.0.0.1:8787` before the chat opens — reuse
   `hook-session-start.ts`'s ensure path (`hook-session-start.ts:16`); do not rebuild board hosting.
3. **Resolve the operator launch profile** (§2.4) — distinct from the per-agent
   `DEFAULT_LAUNCH_PROFILES` (`run-agents.ts:99-150`). Model/effort are launch-time flags and cannot change
   mid-session (`RUNNING.md:219-222`), so `up` resolves them once, here.
4. **Launch the interactive session** (§2.2).

### 2.2 Phase B — the interactive launch (net-new child-process contract)

The headless renderers in `commandFor()` **cannot be reused** — `claude -p`, `opencode run <prompt>`, and
`codex exec <prompt>` are all one-shot print modes with `stdin:"ignore"` (`run-agents.ts:635-688,919`).
`up` adds a **sibling** `interactiveCommandFor()` next to `commandFor()` rather than branching the
scheduler hot path:

| CLI | Headless (today) | Interactive (`up`) |
|---|---|---|
| claude | `claude … -p <prompt>` (`:635-651`) | bare `claude` — **drop `-p`**. `--model`/`--append-system-prompt` are **UNVERIFIED** on the interactive TUI (grounded only in the headless renderer) |
| opencode | `opencode run [--model M] [--variant E] <prompt>` (`:675-688`) | bare `opencode` — **drop `run` + positional**. `--model`/`--variant`/`--agent operator` are **UNVERIFIED** on the interactive TUI |
| codex | `codex exec … <prompt>` (`:653-673`) | (not an operator target in Phase 1 — codex has no provider-key lane and no console persona) |

**Flag verification is a Phase-1 task, not an assumption.** The `--model`/`--effort`/`--variant`/
`--append-system-prompt`/`--agent` flags above are confirmed only for the **headless** `claude -p` /
`opencode run` renderers (`run-agents.ts:635-688`); a reader only *floated* `--append-system-prompt` and
`--agent` as possibilities for the interactive TUIs ("and/or"). Each MUST be verified against the actual
`claude`/`opencode` interactive CLI before `interactiveCommandFor()` relies on it. A flag the bare TUI
rejects would make the launch or the priming **silently fail**. Where a flag is unconfirmed, `up` **drops
it** and leans entirely on the **confirmed priming channel** — the workspace-root `CLAUDE.md`/`AGENTS.md`
files (§3.2), which the design already scaffolds as the robust, flag-free fallback for both persona and
model guidance. Model/effort that cannot be passed as a launch flag are instead pinned declaratively via
`team.defaultCodingAgent` + `codingAgentDefaults.<cli>.model` in `dev-loop.json` (§2.4), which the TUI
inherits through the workspace `opencode.json`.

The **spawn shape changes**: headless is `stdio:["ignore","pipe","pipe"]` (`run-agents.ts:919`); the
operator chat must be `stdio:"inherit"` — a real TTY so the human types. This is a fundamentally different
child-process contract from every existing fire, which is exactly why it is a separate function, not a flag
on `runAgent()`.

### 2.2a First-run onboarding / trust prompts — the "land in a chat" guarantee

A freshly-installed `claude` or `opencode` TUI does **not** open straight into a chat. On first launch each
can present trust-folder, theme, telemetry-consent, and onboarding prompts — and can still demand a
`/login` — none of which the headless `-p` / `run` path ever hits, and which `classifyFireError`
(`run-agents.ts:236`) only catches *after* a failed fire, never before an interactive launch. Left
unhandled this breaks the two-mode UX guarantee in **both** directions: locally the operator's first bare
`claude` lands on an onboarding wizard instead of a chat; in a container TTY (§6.3) these prompts **block on
a TTY with no one to answer**.

`up` therefore treats onboarding as a **preflight + pre-seed** step, not a runtime surprise:

- **Pre-seed the trust/onboarding state before exec.** `up` writes the CLI's known trust/onboarding config
  (e.g. marking the workspace dir trusted, accepting terms, selecting a default theme) into the CLI's own
  config location before spawning, so the first launch resolves directly to a chat. The **exact
  non-interactive-onboarding invocation for each TUI is UNVERIFIED** and MUST be confirmed against the live
  `claude`/`opencode` CLIs during Phase 1 (accept-terms/trust flags vs a pre-written config file) — see
  Open Question Q8.
- **Preflight the auth/onboarding requirement.** Before exec, `up` probes whether the CLI still requires an
  interactive `/login` or onboarding step it could not pre-seed, and if so **surfaces a clear message and
  exits** rather than handing the operator (or a headless container TTY) a hung prompt. This preflight is
  distinct from — and runs *ahead of* — the post-fire `classifyFireError` auth class.

### 2.3 The operator env block (identity, and the fire-marker trap)

`up` exports the same env block `runAgent()` builds (`run-agents.ts:841-853`) **minus the agent-handle
actor**, plus one hard rule:

```
DEVLOOP_ACTOR=operator                # the human-behind-writes identity (seed.ts:56, resolve-project.ts:97)
DEVLOOP_WORKSPACE=<abs>               # single discovery lever (workspace.ts:22-29)
DEVLOOP_PROJECTS_JSON / DEVLOOP_HUB_DB / DEVLOOP_DATA_DIR
DEVLOOP_PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT
# secrets.env is auto-hydrated on workspace resolution (secrets.ts:60-70) — no manual export
```

**CRITICAL — do NOT set `DEVLOOP_TEAM_SCOPE` or `DEVLOOP_DEV_SPLIT`.** An agent WRITE op refuses (exit 4)
when `hub.actor === "operator"` AND a fire marker is set, unless `--i-am-the-operator`
(`cli-agentops.ts:178`). The operator console needs *unguarded* operator writes (publish docs, exit
terminal states, add `env:prod` — `docstore.ts:171`, `ticketwrite.ts:98`, `agentops.ts:123`), so it must
run **without** the fire markers. Two consequences the console skill must honor:

- **Operator writes** run as `DEVLOOP_ACTOR=operator` with no fire marker (they pass), or pass
  `--i-am-the-operator` for genuine operator intent.
- **When the console *drives an agent*** (e.g. seeds work for `pm`/`qa`), it re-sets `DEVLOOP_ACTOR` to that
  agent's handle for the duration of that write, so attribution is correct and guards behave.

### 2.4 Operator launch-profile resolution & the default-CLI question

The operator's runner obeys the **same** two-level precedence as any fire
(`resolveCodingAgent`, `run-agents.ts:524-531`): per-agent pin → explicit `--cli` → project
`defaultCodingAgent` → `DEVLOOP_RUNNER_CLI` env → **hardcoded `"claude"`** (`run-agents.ts:362-365`). So:

- **This operator (local):** leave `team.defaultCodingAgent` unset → claude is the rank-4 fallback → `up`
  launches interactive claude with zero config. Or set `"claude"` explicitly.
- **Product default (shipped bundle):** `team.defaultCodingAgent: "opencode"` (rank 3) travels in the
  bundle → `up` launches interactive opencode. **An opencode-default deployment MUST also set
  `codingAgentDefaults.opencode.model` to a real `provider/model-id`** — every opencode built-in in
  `DEFAULT_LAUNCH_PROFILES` is `{}` (`run-agents.ts:103+`), so without a pinned model opencode fires on its
  own (possibly unset) default.

Note `dev-loop run` itself defaults `--cli` to **claude** (`run-agents.ts:365`), but the *product* default
is opencode. `up`, when it hands the loop-start playbook to the operator agent, must have the agent pass
`--cli opencode` (or the bundle's `team.defaultCodingAgent` already resolves it), or the keys-only opencode
path won't launch.

### 2.5 The conversational setup playbook (what the agent runs, in order)

`up` hands the agent an **ordered playbook** (embedded in the priming brief, §3) — it does not improvise
it. This is the same order `init-service` and the setup skills already encode
(`init-service.ts:72-180`), ported onto the v2 workspace:

```
1. team init            → already done by up's Phase A (agent confirms / resumes)
2. team add-project     → team-edit.ts:170; on service auto-seeds the hub row (:205,211-225)
3. team add-repo        → team-edit.ts:237; CLONE requires --detect + --remote + absent path (:273-278)
4. provider + key config→ RESOLVED (Q1, rev 2): two NEW first-class mutators.
                          `dev-loop team add-provider <id> --base-url U --auth-env NAME --models a,b`
                          (compound validated write, the add-repo precedent — E16-validates, then runs
                          sync-opencode itself) and `dev-loop secret set <NAME>` (prompts for the VALUE
                          on the TTY, or --stdin; writes .dev-loop/secrets.env chmod 600, never echoes).
                          The TTY prompt is load-bearing for the chat flow: the agent runs the verb, the
                          HUMAN types the key directly — the secret never enters the chat transcript,
                          the model context, or shell history. Verify with doctor W13.
5. seed                 → idempotent-on-key
6. daemon up / hub start→ already ensured in Phase A; agent confirms board is live
7. dev-loop run --cli … → run-agents.ts; auto-ensures the daemon on service (:1244-1247)
8. dev-loop doctor      → verdict + W-codes (W09-W16) as a fail-fast check before/after run
```

Each step routes through the **existing schema-validated mutators** (every write re-validates the whole
file), so conversational setup never hand-edits config into an invalid state. With Q1 resolved to the two
new mutators, this now holds **uniformly** — the console skill's "validated mutators only" HARD LIMIT has
no exception, and the one step that used to require a hand-edit (providers) is a first-class verb whose
secret half never passes through the model (§3.1(d)).

### 2.6 Provider auth reachability — the claude caveat

- **opencode (frictionless default):** interactive opencode already inherits the workspace `opencode.json`
  provider blocks + `secrets.env`. `up --cli opencode` needs only (a) providers synced
  (`team sync-opencode`) and (b) the `AGENTS.md`/`--agent operator` prime. **No new auth plumbing** — this
  reaches API-based LLMs with no subscription login, exactly the vision.
- **claude on API-only auth is BLOCKED today.** `providerOf()` hardwires claude → `"anthropic"`
  (`run-agents.ts:243-248`); grep confirms **zero** `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/
  `ANTHROPIC_API_KEY` writes in `hub/src`. The env-injection route is Appendix A, explicitly deferred
  (`model-provider-routing.md:196-209`). So interactive **claude** falls back to claude's own subscription
  login *or* a hand-set ambient `ANTHROPIC_API_KEY` (from `secrets.env` or the shell). `up` must **not**
  assume dev-loop's provider registry reaches claude. **RESOLVED (Q2, rev 2): this split is the shipped
  posture** — local claude runs on its own login; containers run opencode on API keys; Appendix A stays
  deferred. The attach model (§6.0) makes the split durable rather than awkward: the operator's console is
  local claude (login auth), the remote muscle is opencode (key auth) — each side uses the auth that fits
  its habitat.

---

## 3. The operator-console skill

The console skill is the single artifact that makes a fresh claude/opencode, launched bare in a workspace,
*already know* how to be the dev-loop operator. It is essentially a **meta setup skill that chains** the
four existing operator setup skills (`add-project`, `add-repo`, `sync-*`).

### 3.1 What it teaches (the four axes)

- **(a) Setup flow** — its JOBS chain is the §2.5 playbook: init → providers/secrets → add-project →
  add-repo → `daemon up` → `run`, reusing the conversational pattern of the `add-project`/`add-repo` skills
  (operator-present, driving validated `dev-loop team …` mutators, gated on "no workspace ⇒ tell the user
  to `dev-loop team init` first and stop", `skills/add-project/SKILL.md:24,46-72`).
- **(b) Verbs + exit codes** — a machine-rendered CLI cheat block (§3.3): the setup+ops verb superset, each
  with its §18 op name, the identity-first fail-closed preamble (`dev-loop project --json` whoami; exit
  `4`=identity/guard, `5`=hub unavailable ⇒ STOP), and the `0/1/2/3/4/5` exit table.
- **(c) Ticket / decision-queue ops** — cite the **already-shipped** operator decision-queue definition
  (`daemon-notifiers.ts:67-73`: `state='Human-Blocked' OR (state='In Review' AND assignee='operator')`)
  plus §9 human-park and §22a digest, driving `tickets`/`ticket`/`op` reads and the board UI. **Do not
  invent a new queue concept.**
- **(d) Permission boundaries** — operate inside the `Bash(dev-loop *)` allow rule (`team-init.ts:179`);
  HARD LIMITS forbid hand-editing `dev-loop.json` (validated mutators only — **no exception**, Q1
  resolved: `team add-provider` closes the last gap), keep secrets in `.dev-loop/secrets.env` (values)
  with `dev-loop.json` holding env NAMES only (§16), and never touch the global `~/.config/opencode`
  (sync only writes the workspace `opencode.json`, `opencode-sync.ts`). One NEW hard rule the resolution
  adds: **the agent never asks the human to paste a secret into the chat** — key entry always goes
  through `dev-loop secret set <NAME>`'s TTY prompt (§2.5 step 4), so secret VALUES never appear in the
  conversation, the model context, or the transcript. If the human pastes a key unprompted, the skill
  instructs: discard it from the conversation, run `secret set` properly, and suggest rotating the key.

### 3.2 How it is packaged & discovered — closing the discovery GAP

There are three discovery mechanisms today, and a gap:

1. **Plugin install** (`install-claude-plugin.ts`) surfaces skills as `/dev-loop:operator-console` — but
   requires the plugin already installed (chicken-and-egg; not what a *fresh* session knows).
2. **Skills dir + `${CLAUDE_PLUGIN_ROOT}`** resolved at fire time (`run-agents.ts:571-580`) — but the
   operator console is not a fire.
3. **Workspace-root instruction file — MISSING.** `grep` finds no `CLAUDE.md`/`AGENTS.md` anywhere in the
   repo. Nothing teaches a bare `claude`/`opencode` launched in the workspace what to do.

**The fix — extend `team-init.ts` to scaffold two workspace-root files** alongside the existing
`.claude/settings.json` write. These are the *only* files a bare CLI auto-reads:

- **`CLAUDE.md`** (Claude Code) and **`AGENTS.md`** (opencode's analogue).
- Content: a short operator persona + the §2.5 playbook + a pointer. When the plugin is present (local),
  they point to `skills/operator-console/SKILL.md`. For the remote/headless bundle they **inline** the
  flattened console (§3.5). opencode has *no* skill/instruction scaffolding today (only MCP-merge + provider
  sync), so `AGENTS.md` is the required bridge for the shipped opencode default — without it a fresh
  opencode session knows nothing about dev-loop.

The skill itself is authored once at **`skills/operator-console/SKILL.md`**, uniform layout
(`skill-template.md:85-129`), **no `--project` arg**, registered in `.claude-plugin/plugin.json` so it also
surfaces as `/dev-loop:operator-console` — but first-touch discovery relies on the root files, not the
plugin.

### 3.3 Verb sheet from the machine, not by hand

Add **one entry** to `gen-cheatsheets.ts`'s `CHEATSHEETS` table (`gen-cheatsheets.ts:31-82`) mapping
`operator-console → { verbs, scope }` with the setup+ops superset:

```
team init / team add-project / team add-repo / team set / team sync-opencode,
seed, daemon up, hub start, run, doctor, tickets, ticket, op, doc,
install-claude-plugin, notify
```

All are already routed in `cli.ts:20-55`. The generator renders the block **from the CLIs' own `help`
output** (`gen-cheatsheets.ts:101-105,257-263`) so a flag is never re-typed; `OP_OF` maps each verb to its
§18 op name (`:85-94`); the block carries the identity-first preamble + exit-code table (`:195-204,106`) and
is byte-checked by `hub/test/cli-cheatsheet.ts`. The console is drift-free for free.

### 3.4 Conventions cited, never restated

Per the skill house style (`skill-template.md:42-47`), the console CITES shared mechanics with a one-clause
+ `§`-anchor and ends BOOT in a machine-checked `Sections:` line. Its anchor set is the **setup/ops**
selection — a *different* set from the delivery-agent WANT list hard-coded in
`export-desktop-skill.ts:81`:

```
Sections: §0 §0a §2 §18 §27 §5a §9 §12 §12a §22a §20 §21a
```

For the provider JOB specifically, the skill teaches the two Q1 verbs: `team add-provider <id>
--base-url U --auth-env NAME --models a,b` (E16-validated write of the
`{kind:"openai-compatible", baseUrl, authTokenEnv, models[]}` entry, `team-config.ts:46-53`, which then
runs `sync-opencode` itself), followed by `dev-loop secret set <NAME>` (TTY-prompted VALUE →
`secrets.env`, never inline in `dev-loop.json` — E16 rejects it, `team-config.ts:306`; never through the
chat); verify with `doctor` W13 (resolvable from env or secrets.env, source-reported).

### 3.5 Reuse the flatten machine for the headless bundle

`export-desktop-skill.ts` is the precedent for a self-contained single-file skill: it parses a canonical
`SKILL.md`, strips YAML frontmatter (`:39,73-77`), **rewrites the one external ref**
`${CLAUDE_PLUGIN_ROOT}/references/conventions.md` → an inlined appendix (`:76-77`), splices a curated
conventions WANT-set split on `## ` headings (`:81-85`), and **skips secrets** (`:87-101`). Author a **new**
verb — `dev-loop export-operator-console` — modeled on it, but parameterized with the console's WANT-set
(§3.4) instead of the delivery-agent set. Its output inlines into `CLAUDE.md`/`AGENTS.md` for a plugin-less
host. This is the bridge that makes the console work inside the remote bundle (§4) where no plugin exists.

---

## 4. `dev-loop bundle` (LOCAL authoring) → `dev-loop up --bundle` (REMOTE headless load)

### 4.1 What a portable workspace actually is

A workspace = `dev-loop.json` + `.dev-loop/`, under the invariant "copy the folder = migrate the machine"
(`workspace.ts:6-8`). But the folder splits three ways (`workspace.ts:70-88`, `config-schema.md:416-431`):

| Class | Contents | Bundle action |
|---|---|---|
| **Portable data** | `dev-loop.json` (full: `schemaVersion:2`, `workspaceId`, `team`+`providers`, `repos`+`remote`, `projects`); `opencode.json` | **serialize** (opencode.json optional — regenerable via `sync-opencode`) |
| **Secrets** | `.dev-loop/secrets.env` VALUES for every env NAME the config references (`comms.webhookEnv` E07, `notify.*Env` E15, `providers.*.authTokenEnv` E16) **plus git-remote credentials** (§4.1a) | **serialize, ENCRYPTED** (this is the whole point of the bundle) |
| **Machine-local state** | `hub.db`, `team/scheduler.json` cursor, `<project>/scheduler-gate.json`, `daemon.json` runfile, `locks/`, `wt/`, `team/fires.jsonl`, `~/.dev-loop/workspaces.json` | **do NOT travel** — re-materialize remotely |

### 4.1a Git-remote credentials are a first-class secret concern

`dev-loop.json` serializes `repos[].remote`, and the manifest example uses **SSH** URLs
(`git@github.com:acme/app.git`). But today's secret class carries only LLM/comms/notify keys — it has **no
git deploy key or token**. On a fresh headless host, `git clone git@github.com:…` for a private repo (a)
fails auth outright, and (b) triggers an **interactive SSH host-key prompt** that hangs the headless loader
(§4.5) — exactly the "headless load that hits an interactive prompt" hazard. Git credentials are therefore
promoted to a named part of the secret payload:

- **HTTPS-token remotes (preferred for headless).** Support `https://` remotes whose token is fed from
  `secrets.env` via `GIT_ASKPASS` (or a `.git-credentials`-style helper written at load, chmod 600). The
  token NAME travels in the manifest (`gitCredentialEnvNames`); the VALUE travels encrypted in
  `secrets.env`. This keeps git auth on the same env-NAME/VALUE firewall as every other secret (§16).
- **SSH deploy key (if SSH remotes are kept).** The bundle carries a per-workspace deploy key inside the
  encrypted payload; the loader writes it chmod 600 and sets
  `GIT_SSH_COMMAND="ssh -i <key> -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=<known_hosts>"`
  (or pre-seeds `known_hosts`) so host-key verification **never prompts**.
- **Fail-fast, never hang.** `dev-loop doctor` and the loader probe each `repos[].remote` for
  reachability/auth up front (`git ls-remote`) and **exit with a clear message** if any remote is
  unreachable, rather than blocking on an interactive credential or host-key prompt.

### 4.2 The §16 tension — the bundle IS the secret artifact

§16 is *code-enforced*: E07/E15/E16 reject inline secrets and E15 rejects literal webhook URLs
(`team-config.ts:250-266,306-307`). You **cannot** smuggle passwords into `dev-loop.json` without breaking a
validated invariant. Therefore the bundle itself must be the secret-bearing artifact — it packages
`dev-loop.json` (NAMES) **plus** the `secrets.env` VALUES, and the whole bundle is what the operator
protects. This is exactly the split `secrets.env` already assumes; the bundle just *relocates that one file,
encrypted*.

**Protection at rest:** the bundle is an **encrypted archive** — `age` (recipient key) or `sops` (recipient
key / cloud KMS). Authoring encrypts; loading decrypts the secret payload into `.dev-loop/secrets.env`
(chmod 600) — exactly the file `loadWorkspaceSecrets` hydrates env-wins at `workspace.ts:57`. The
image/registry/repo never contains cleartext secrets.

**Where the decrypt key lives is the load-bearing question, not the cipher.** Encryption defends *nothing*
in the threat model where the host is the attack surface if the ciphertext and its key sit on the same box.
So the design constrains key placement, not just algorithm:

- **The decrypt key MUST come from a source the bundle-holder does not also possess on the same host.** Two
  supported shapes: (a) **KMS/sops with cloud IAM** — the pod/host authenticates to a KMS via its cloud
  identity and the private key never lands on disk; (b) an **operator-supplied key at load time** (mounted
  from an orchestrator secret store or piped in) that the loader uses and does **not** persist next to the
  bundle. Co-mounting the encrypted bundle *and* a plaintext `age` identity file into the same container
  (as a naïve compose would) is explicitly called out as an **anti-pattern** (§5.2) — it reduces the
  encryption to obfuscation.
- **Passphrase encryption is INCOMPATIBLE with the zero-interaction remote contract.** An `age`/tar
  passphrase requires an interactive prompt at load, and a headless container/pod has no one to type it —
  `up --bundle` would hang. Headless load therefore **mandates recipient-key (age identity) or KMS (sops)**
  and **excludes interactive-passphrase bundles from the container/K8s path**. A passphrase is permitted
  only for the LOCAL author-and-load-on-the-same-desktop case, or when supplied via a mounted file/env at
  load time (never an interactive prompt). See Open Question Q3.
- **One authoritative secret channel per deployment form.** A given deployment uses *either* the
  bundle-encrypted `secrets.env` *or* an orchestrator-native Secret (K8s `Secret`, compose secret) — never
  both in the same example, which would create two competing sources of truth for the same key (§5.2, §5.3).

### 4.3 The bundle format

A bundle is a single encrypted archive with a plaintext manifest header (so a loader can preflight version
compatibility before decrypting) and an encrypted payload:

```
dev-loop-bundle.tar.age
├── manifest.json            (plaintext — version, workspaceId disposition, repo remotes, provider NAMES)
└── payload.enc              (age/sops-encrypted tar of:)
    ├── dev-loop.json        (verbatim — includes team.providers, repos[].remote, projects)
    ├── opencode.json        (optional; regenerable via `team sync-opencode`)
    └── secrets.env          (the VALUES — the reason the archive is encrypted)
```

**Concrete example `manifest.json`:**

```json
{
  "bundleSchema": 1,
  "devLoopVersion": ">=1.4.0",
  "authoredAt": "2026-07-17T10:00:00Z",
  "workspaceId": {
    "value": "wsp_7f3a91c2",
    "disposition": "migrate"
  },
  "hubDb": { "included": true, "checkpointedAt": "2026-07-17T09:59:41Z" },
  "backend": "service",
  "defaultCodingAgent": "opencode",
  "opencodeModelPinned": "openrouter/moonshotai/kimi-k2.5",
  "repos": [
    { "ref": "app", "path": "repos/app", "remote": "https://github.com/acme/app.git" },
    { "ref": "infra", "path": "repos/infra", "remote": "https://github.com/acme/infra.git" }
  ],
  "providerEnvNames": ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"],
  "commsEnvNames": ["ACME_SLACK_WEBHOOK"],
  "gitCredentialEnvNames": ["ACME_GIT_TOKEN"],
  "gitAuth": "https-token",
  "secretsEncryption": "age",
  "secretsRecipients": ["age1qz...operator-pubkey"]
}
```

`workspaceId.disposition` resolves the double-drive hazard: `workspaceId` is a stable fingerprint stamped
into Linear projects to detect a second workspace driving the same board (`team-config.ts:118-124`).
**Under rev 2's move semantics the default flips to `migrate`** — a bundle MOVES the home, so the id (the
logical workspace identity) travels with it, and the SOURCE must stop being a home: `bundle export
--move` stamps a `movedTo` marker into the source workspace and `dev-loop run`/`doctor` on a moved-away
source refuse/warn loudly (the source's remaining legitimate uses are `attach` and reading local files).
**`fork`** (mint a new id on load) remains for the template case — stamping N independent deployments
out of one authored config, where the source keeps running. See Open Question Q4 for the enforcement
depth of the source-side retirement.

### 4.4 Authoring: `dev-loop bundle export`

```
dev-loop bundle export --out dev-loop-bundle.tar.age [--recipients <age-pubkey>…]
                       [--workspace-id migrate|fork] [--move] [--no-hub-db] [--backup]
```

Steps (modeled on `team import`'s config-fold + selective-copy precedent, `team-import.ts`):

1. Resolve the workspace; run `dev-loop doctor` and refuse to export on a hard-fail verdict.
2. Collect `dev-loop.json`, (optionally) `opencode.json`.
2a. **Collect `hub.db` (Q6 — default ON when the board is non-empty; `--no-hub-db` opts out for a
   clean-board deploy).** Consistency first: refuse while a live run-lock / daemon runfile shows active
   processes (the operator stops the loop before a move — a moving home should not be firing), then
   checkpoint the WAL into the main file (the `hub stop` path already does exactly this, `cli.ts:75`;
   the periodic `wal_checkpoint(TRUNCATE)` machinery exists in `daemon-notifiers.ts:540-546`) and copy
   the single db file into the payload, recording `hubDb.checkpointedAt` in the manifest. `--backup`
   (§4.6) is the same collection run against a live board: it takes the checkpoint on the maintenance
   connection without stopping the loop — crash-consistent, good enough for a backup, not for a move.
3. Collect `secrets.env` VALUES for **every** env NAME the config references (providers/comms/notify) —
   warn on any NAME with no resolvable value (it would fail W12/W13 remotely). **Also collect the git-remote
   credential** (§4.1a): the HTTPS-token VALUE (into `secrets.env` under the `gitCredentialEnvNames` NAME)
   or the SSH deploy key, and record `gitAuth` + credential NAMES in the manifest. Warn if any private
   `repos[].remote` has no accompanying credential — it would fail the loader's fail-fast reachability probe.
4. Emit the plaintext `manifest.json`.
5. Encrypt the payload (`age` recipient key / `sops` KMS) to the given recipients. A raw passphrase is
   offered **only** for a same-desktop LOCAL bundle, never for the headless/container path (§4.2, Q3).
6. **Blocklist** (never travels): scheduler cursors, `scheduler-gate.json`, `daemon.json`, `locks/`,
   `wt/`, `fires.jsonl`, working trees, repo clones. Ship an **allowlist**, not the whole `.dev-loop/` —
   the payload is exactly: `dev-loop.json`, `opencode.json` (optional), `secrets.env` values,
   git credentials (§4.1a), and `hub.db` (step 2a; Q6 default ON). Repos NEVER travel — **git remotes are
   the code transport** (§4.5 step 3 re-clones); the bundle stays small and the board's memory
   (roadmap, strategy/north-star docs, ticket history) moves with the db it lives in.

### 4.5 Loading: `dev-loop up --bundle <file>` (headless)

`dev-loop up --bundle` is the REMOTE arm of the same verb — **no chat, no console skill**. It reuses today's
`dev-loop run` scheduler verbatim; the interactive launcher (§2.2) is skipped entirely.

```
dev-loop up --bundle dev-loop-bundle.tar.age [--dir <workspace-dir>]
```

Steps:

1. **Preflight** the plaintext manifest: `devLoopVersion` compatible? (W10 already gates the write layer at
   `>=1.2.0`.) If not, `npm i -g @dyzsasd/dev-loop@<compatible>` — the npm install also **re-materializes**
   skills/references/plugin payload, which are NOT bundled (`.gitignore` shows `hub/skills`,
   `hub/references`, `hub/.claude-plugin` are npm-prepack artifacts).
2. **Decrypt** the payload and lay down config **idempotently, not blindly** — a naïve loader would
   overwrite live config on every restart. Set `DEVLOOP_WORKSPACE=<abs>` (the single boot lever,
   `workspace.ts:22-29`), then:
   - **First materialization (empty workspace):** write `dev-loop.json`, `secrets.env` (chmod 600),
     `opencode.json` into the target dir. The decrypt key is resolved per §4.2 (KMS / load-time-supplied,
     never co-persisted).
   - **Restart over a populated workspace (the common container case):** the bundle is
     **authoritative-once**. Do NOT clobber. If the workspace already resolved successfully, **skip the
     overwrite** (the PVC copy is live state that has diverged — see §5.2); if the incoming
     `dev-loop.json`/`secrets.env` differs, **diff and warn** rather than overwrite a runtime config change.
     Only `--force-reseed` re-lays config over an existing workspace. This keeps restart truly idempotent
     instead of resetting config while `hub.db` on the PVC keeps diverging.
3. **Re-materialize machine-local state (transactional / resumable):**
   - **Git clone with real auth, resumable.** Establish git credentials FIRST (§4.1a: `GIT_ASKPASS` token
     from `secrets.env`, or the deploy key + `GIT_SSH_COMMAND` `StrictHostKeyChecking=accept-new`). Then for
     each `repos.<ref>.remote` → workspace-relative `path` (E03 keeps it inside the root,
     `team-config.ts:157-166`): today `add-repo` clone requires an **absent** path (`team-edit.ts:273-278`),
     so a load that died after cloning some repos leaves non-empty dirs that a retry would skip or error on
     — a **half-materialized** workspace. The loader instead **reconciles**: for an existing repo dir,
     verify its `remote` + resolve `HEAD` (`git ls-remote` / `git -C <path> remote get-url`) and **resume**
     (fetch/checkout) rather than skip; only an absent path triggers a fresh clone. A remote that fails the
     reachability probe **fails fast with a message** (§4.1a) — never an interactive hang.
   - **`hub.db`: restore-onto-empty, NEVER overwrite live (Q6 resolved — the bundle carries it).** The
     board's entire memory (roadmap, strategy/north-star docs, published docs, ticket history) lives in
     `hub.db`, not `dev-loop.json` — so the bundled, WAL-checkpointed db (§4.4 step 2a) IS the board.
     Restore rules: target has NO `hub.db` (first materialization) → lay the bundled db down verbatim
     (same-workspace move: ids/events arrive intact; the `team import --hub-db` re-key machinery,
     `team-import.ts:1-6,237`, is reserved for folding INTO an existing db, not for a clean move). Target
     HAS a `hub.db` (container restart / re-deploy) → **never overwrite** — the PVC copy is the live
     board that has advanced past the bundle snapshot; log "board exists, bundle copy ignored". A bundle
     exported `--no-hub-db` re-seeds from config (`team init` seeds `_team`; `add-project`/`seed` per
     project, `config-schema.md:440`, W08) — the explicit clean-board choice, its content loss documented
     rather than discovered.
   - Regenerate `.claude/settings.json` allow-rule + `opencode.json` idempotently
     (`provisionClaudePermissions`; `team sync-opencode`) — safer than trusting a hand-edited/stale bundle
     copy.
   - Seed the **op-API gate** if the remote board needs write/op: `settings_json.hub.transport==='daemon'`
     is read fresh per request from the project's DB row (`daemon.ts:298-303`) — a headless bundle must
     seed this into `hub.db`, and configure a writable `DEVLOOP_ACTOR` (`daemon.ts:652-657`), or the whole
     write surface stays dormant.
4. **Reclaim stale locks/worktrees after an unclean shutdown.** A SIGKILL / OOM / node-eviction mid-run
   leaves stale entries in `.dev-loop/locks/`, a stale run lock, and per-fire worktrees in `wt/` **on the
   persistent volume** (all ephemeral, normally rebuilt by `team repair`). The daemon side self-heals —
   `run`'s ensure goes through the lifecycle's O_EXCL cold-start lock with dead-pid takeover
   (`daemon-lifecycle.ts:68-127`), and the run lock itself has liveness-checked stale takeover
   (`run-agents.ts` acquireRunLock) — but repo locks and worktrees do not. The loader therefore runs
   **`team repair`** as part of the boot sequence **before** starting the loop.
5. **`dev-loop doctor` fail-fast preflight** (W09-W16, §5.4): confirm `dev-loop` on PATH with write verbs
   (W09/W10/W11), every provider `authTokenEnv` resolvable (W13), every `repos[].remote` reachable with the
   configured git credential (§4.1a), `opencode.json` carries the registry (W14), opencode binary certified
   (W15). A missing provider env fails **pre-spawn** with zero tokens (`run-agents.ts:863-889`) — so doctor
   must be green *before* the loop, or the run silently no-ops notifications and blind-retries providers.
6. **Chain into `dev-loop run` headless — which owns the daemon (Q5 resolved: Option A).** The loader
   execs `dev-loop run`; its existing auto-ensure (`run-agents.ts:1244-1247`) starts the single daemon
   through the lifecycle path — which **writes the runfile + health identity** the idempotent ensure
   reads (`daemon-lifecycle.ts:163-173`), so a restart recognizes the running daemon instead of spawning
   a second writer. There is NO separate foreground daemon boot in the container. opencode fires
   additionally get the wildcard-deny `OPENCODE_PERMISSION` baseline injected per fire
   (`run-agents.ts:211-216,869`).

### 4.6 The bundle is also the backup format — and the road home

Because `bundle export` runs anywhere the CLI runs (the image ships it), three flows come for free:

- **Scheduled backup:** a cron/timer on the remote runs `bundle export --backup --out
  backups/dev-loop-<date>.tar.age` (live-board checkpoint on the maintenance connection, §4.4 step 2a) —
  the operator pulls these at leisure. PVC/host loss now costs at most one backup interval of board
  history; repos lose nothing (their state is on the git remotes).
- **Reverse migration (bring the home back):** stop the loop on the remote, `bundle export --move`,
  load it locally with `up --bundle` — the same restore-onto-empty rules apply. The local machine
  becomes the home again; the remote flips to retired/attach.
- **"Sync back the latest progress" (the operator's Q6 rider), answered without sync:** live progress =
  **attach** (§6.0 — you are looking at the one live board); code = **git remotes** (agents push per
  repo `landing`/`autoPush` config; local pulls); durable possession = **scheduled backup** above. At no
  point do two live `hub.db` copies exist to reconcile.

---

## 5. Container image + docker-compose + Kubernetes

Entry point for every remote form is **`dev-loop up --bundle`**. The image never contains secrets — keys
arrive via env → `secrets.env` (or the encrypted bundle payload).

### 5.1 Container image

- **Base:** node (with `node:sqlite` support — the hub is a `node:sqlite` process) + `git` (for repo
  re-clone) + `age`/`sops` (bundle decrypt).
- **Install dev-loop globally:** `npm i -g @dyzsasd/dev-loop` on PATH — this is mandatory; every
  `interface:"cli"` fire (the default for all three CLIs, `team-config.ts:31`) calls the PATH-installed
  `dev-loop` write verbs, and doctor W09/W10/W11 gate exactly this.
- **Install opencode** (the container default runner) at the certified version (W15 requires
  `>=1.2.24`, `doctor.ts` W15).
- **The board MUST bind a routable address, not loopback.** The daemon binds `127.0.0.1` **hardcoded**
  (`daemon.ts:629`); a container listener on loopback is unreachable from the pod/container IP, so probes
  and published ports hit nothing (§1 point 5). The container therefore sets the **new bind knob**
  `DEVLOOP_DAEMON_HOST=0.0.0.0` — a **hard prerequisite** for any container form. Because widening the bind
  without widening the guard "silently weakens" it (`daemon.ts:181-183`), `DEVLOOP_DAEMON_HOST=0.0.0.0` MUST
  be accompanied by `DEVLOOP_UI_TOKEN` (§6.2) — the two land together in Phase 1 for the container path, or
  the whole §5 surface moves to Phase 2.
- **Exactly ONE process owns the daemon — `dev-loop run` (Q5 RESOLVED: Option A).** The container's
  process tree is `up --bundle` → exec `dev-loop run`; `run`'s existing auto-ensure
  (`run-agents.ts:1244-1247`) starts and owns the single daemon through the lifecycle path, which writes
  the runfile + health identity the idempotent ensure reads (`lcHealthInfo`,
  `daemon-lifecycle.ts:163-173`) — so restarts recognize the running daemon instead of spawning a second
  writer on the same `hub.db`. The raw foreground boot (`daemon.ts:626-730`) is NOT used in containers
  (it writes no runfile — the second-writer hazard the pre-rev-2 draft worried about). Consequences: the
  board's lifecycle is coupled to the loop (`run` is PID 1; if it dies the container restarts and the
  daemon child dies with it — precisely what the K8s/compose supervisor expects); the container health
  probe targets the daemon's `/api/health`, which is live iff `run` successfully ensured it — a probe
  failure means the loop's board is down, the right restart trigger. The macOS-LaunchAgent autostart
  (`daemon-lifecycle.ts:331-333`) is irrelevant in-container.
- **Secrets never baked in, and NOT broadcast to every fire.** The Dockerfile copies
  no `secrets.env`. At runtime secrets arrive via the encrypted bundle (decrypted to `secrets.env`) **or**
  the orchestrator secret channel — one authoritative source per deployment (§4.2). Critically, provider
  keys, the comms webhook, and the **decrypt key path** must **not** all be exported into the top-level
  daemon/`run` process env, because **every fire inherits `process.env`** and agents then run repo
  build/test commands (and `add-repo --detect` reads `package.json` scripts) as **child processes that would
  see every secret** — a buggy or hostile build script could exfiltrate all of them. The container secret
  posture (§7 boundary 5) requires: provider keys scoped so only the LLM subprocess that needs `{env:VAR}`
  sees them (inject per-fire, strip from the parent); `AGE_IDENTITY_FILE` / the decrypt key **never** placed
  in the fire-inherited env; and repo build/test subprocesses run **without** the provider/comms/decrypt
  secrets in their environment.
- **Reclaim stale locks on boot.** After an unclean shutdown, `team repair` (§4.5 step 4) runs before the
  loop starts so stale `locks/` / `wt/` entries on the PVC do not block the next fire.

### 5.2 docker-compose (single service + workspace volume)

**Single authoritative secret channel: bundle-encrypted.** This example uses the encrypted bundle as the
*only* secret source (provider/comms/git keys travel inside it, decrypted to `secrets.env` on load). It does
**not** also inject `OPENROUTER_API_KEY` from the host env — that would create two competing sources of
truth (§4.2). The bundle's decrypt key is **not** co-mounted as a plaintext file next to the ciphertext
(the co-mounted-key anti-pattern, §4.2); it is supplied at load time from a compose `secret` sourced externally
(e.g. a secret manager), used by the loader, and never persisted into the workspace volume.

```yaml
services:
  dev-loop:
    image: acme/dev-loop:1.4.0
    entrypoint: ["dev-loop", "up", "--bundle", "/bundle/dev-loop-bundle.tar.age", "--dir", "/workspace"]
    environment:
      DEVLOOP_WORKSPACE: /workspace
      DEVLOOP_PROJECT: _team
      DEVLOOP_ACTOR: operator
      DEVLOOP_DAEMON_HOST: 0.0.0.0            # PREREQUISITE: bind routable, not loopback (§1.5, §5.1)
      DEVLOOP_UI_TOKEN_FILE: /run/secrets/ui_token   # MUST accompany the widened bind (daemon.ts:181-183)
    secrets:
      - age_key        # decrypt key, load-time only, NOT persisted next to the bundle (§4.2)
      - ui_token
    ports:
      - "127.0.0.1:8787:8787"     # host side stays loopback-only; container side listens 0.0.0.0.
                                  # docker-proxy can now reach the container listener; front with an
                                  # authenticating reverse proxy (§6.2 v1) before exposing beyond the host.
    volumes:
      - devloop-workspace:/workspace      # the PVC-equivalent: repo clones, hub.db, state
      - ./bundle:/bundle:ro
    healthcheck:
      # probes the routable bind (not a loopback listener that would mask external breakage, §1.5)
      test: ["CMD", "curl", "-fsS", "http://0.0.0.0:8787/api/health"]
      interval: 30s
      timeout: 5s                 # ≥1s — lifecycle probes at 800ms-1s (daemon-lifecycle.ts:163-173)
      retries: 3
secrets:
  age_key:
    external: true      # sourced from the host/orchestrator secret store, never committed
  ui_token:
    external: true
volumes:
  devloop-workspace:
```

The `devloop-workspace` volume is the PVC-equivalent: it holds the re-cloned repos, the re-seeded `hub.db`,
and all machine-local state so a container restart **resumes rather than re-bootstraps**. Restart
idempotency is real only because the loader is authoritative-once (§4.5 step 2: skip/diff-warn on a
populated workspace, resumable clone, `team repair` on boot) — a naïve loader would re-lay bundle config
over live PVC state on every restart. Note the provider keys decrypted into `secrets.env` are scoped
per-fire and are **not** broadcast into every build/test subprocess (§5.1, §7 boundary 5).

### 5.3 Kubernetes — SINGLE-replica StatefulSet + PVC + a real boot lock (Phase 2, gated on §1.5)

**This whole manifest is gated on the bind+token prerequisite (§1.5)** and lands in **Phase 2** with Helm.
Without `DEVLOOP_DAEMON_HOST=0.0.0.0`, the kubelet's `httpGet` probes run against the **pod IP** and hit
the loopback-only listener → **nothing responds → CrashLoop**; the board is unreachable and unprobed. The
manifest below assumes the knob has shipped.

**Replicas MUST be 1 — and it must be ENFORCED, not merely asserted.** The hub is a **single-writer SQLite**
system-of-record (`daemon.ts` writeDb) with a per-project O_EXCL cold-start lock (`daemon-lifecycle.ts:68-127`)
and a run lock; the scheduler's change-gate is bound to *this host's* git heads
(`run-agents.ts:783-789,816`). Two replicas would (a) contend on the same SQLite writer, (b) double-drive
the board, and (c) desync the change-gate. Note that **`ReadWriteOnce` does NOT save you**: two pods
co-scheduled on the **same node** can both mount an RWO PVC and both drive the single SQLite writer →
corruption. So enforce it at three layers, not one:

- **`StatefulSet`, `replicas: 1`.** A StatefulSet supports only `updateStrategy` **`RollingUpdate`** or
  **`OnDelete`** — there is **no `Recreate` strategy** for a StatefulSet (`Recreate` is a Deployment-only
  concept). Use **`OnDelete`** (or `RollingUpdate` with a single replica, where the rolling behavior
  degenerates to one-at-a-time) so a rollout never briefly runs two pods holding the volume.
- **A real single-writer boot lock on the PVC.** Do not rely on RWO or on `replicas: 1` staying 1. On boot,
  the entrypoint takes an **`O_EXCL` lock file on the PVC** (generalizing the existing per-project cold-start
  lock, `daemon-lifecycle.ts:68-127`); a second process that finds the lock **refuses to start** rather than
  opening a second writer. `team repair` reclaims a **stale** lock left by an unclean shutdown (§4.5 step 4)
  so the lock is self-healing, not a permanent wedge.
- **Structural anti-scale + anti-co-schedule.** Add **pod anti-affinity** (`requiredDuringScheduling…`,
  one pod per node) so two pods can never co-mount the PVC on one node, and a **validating admission policy**
  (or a Helm value guard) that blocks `kubectl scale --replicas>1`. `replicas: 1` alone is not a control.
- **One `PersistentVolumeClaim`** (`ReadWriteOnce`) mounted at `/workspace` — same role as the compose
  volume; treated as a backstop, never the sole guard.
- **Probes** off `/api/health` (`daemon.ts:545-552`): it returns **503 (not a static 200)** when the SoR is
  wedged/read-only/corrupt and includes version+project for identity — a ready-made liveness AND readiness
  probe. `timeoutSeconds ≥ 1`. These only work because the daemon binds `0.0.0.0` (§1.5).
- **No init integration exists for Linux** (autostart is macOS-LaunchAgent-only,
  `daemon-lifecycle.ts:331-333`), so the pod relies on the K8s controller + `restartPolicy` to supervise
  PID 1 — which is `dev-loop run`, the one daemon owner (§5.1, Q5 resolved: run's ensure starts the
  daemon as its child through the lifecycle path).
- **Single authoritative secret channel.** This example carries secrets **only** in the encrypted bundle
  (decrypted to `secrets.env` on load, scoped per-fire, §7 boundary 5). It does **NOT** *also* ship provider
  keys as an `envFrom: secretRef` — that parallel channel would (a) create two authoritative sources for the
  same key, contradicting §4.2, and (b) broadcast every key into the fire-inherited `process.env`
  (§7 boundary 5). If a deployment prefers a native K8s `Secret` as the authoritative channel, it uses that
  **instead of** the bundle's `secrets.env` and mounts it as a **file** that the loader folds in and scopes
  per-fire — never `envFrom` into the top-level process env. The decrypt key is a K8s `Secret` mounted for
  load-time use only and is kept **off** the fire-inherited env.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: dev-loop }
spec:
  serviceName: dev-loop
  replicas: 1                       # HARD CONSTRAINT: single-writer SQLite + run lock (also enforced by boot lock + anti-affinity)
  updateStrategy: { type: OnDelete }   # StatefulSet supports RollingUpdate | OnDelete only — NOT Recreate
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector: { matchLabels: { app: dev-loop } }
              topologyKey: kubernetes.io/hostname   # never two dev-loop pods on one node → no PVC co-mount
      containers:
        - name: dev-loop
          image: acme/dev-loop:1.4.0
          command: ["dev-loop","up","--bundle","/bundle/dev-loop-bundle.tar.age","--dir","/workspace"]
          env:
            - { name: DEVLOOP_WORKSPACE, value: /workspace }
            - { name: DEVLOOP_PROJECT, value: _team }
            - { name: DEVLOOP_ACTOR, value: operator }
            - { name: DEVLOOP_DAEMON_HOST, value: "0.0.0.0" }   # PREREQUISITE (§1.5) — else probes CrashLoop
            - name: DEVLOOP_UI_TOKEN                              # MUST accompany the widened bind (daemon.ts:181-183)
              valueFrom: { secretKeyRef: { name: dev-loop-ui-token, key: token } }
          # NO envFrom: secretRef for provider keys — secrets travel in the bundle and are scoped per-fire (§7.5)
          ports: [{ containerPort: 8787 }]
          livenessProbe:
            httpGet: { path: /api/health, port: 8787 }   # reaches the pod IP only because bind is 0.0.0.0
            timeoutSeconds: 2
          readinessProbe:
            httpGet: { path: /api/health, port: 8787 }
            timeoutSeconds: 2
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
            - { name: bundle, mountPath: /bundle, readOnly: true }
            - { name: age-key, mountPath: /run/secrets, readOnly: true }   # decrypt key, load-time only
      volumes:
        - name: bundle
          secret: { secretName: dev-loop-bundle }
        - name: age-key
          secret: { secretName: dev-loop-age-key }
  volumeClaimTemplates:
    - metadata: { name: workspace }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 20Gi } } }
```

---

## 6. Ticket-interface + operator-console exposure — local vs remote

### 6.0 Attach mode — the home is remote, the console stays local (rev 2)

`dev-loop attach <url> [--token-env NAME]` / `dev-loop up --attach <url>` is the third leg (§1.2): after
the home moves, the operator's laptop becomes a **client** of the remote hub, and "watching progress"
stops being a sync problem.

- **The seam already exists.** Every CLI write already routes through ONE HTTP client — `op-client.ts`
  (`POST /api/op/<op>` with `X-Devloop-Actor`, shared by the shim and the CLI write layer,
  `op-client.ts:1-5`) — and the daemon's op-API mirrors the stdio ops 1:1 behind the
  `settings_json.hub.transport==="daemon"` gate (`shim.ts:2-6`, agent-api parity suite). Attach = teach
  that ONE client a remote base URL + bearer token (`DEVLOOP_HUB_URL` + the §6.2 `DEVLOOP_UI_TOKEN`)
  instead of `127.0.0.1:<runfile-port>` (`op-client.ts:62` hardcodes loopback today — the same
  configurable-base-URL work §6.2 v2 already requires). The bundle loader seeds the op-API gate ON for
  container deployments (§4.5 step 3).
- **The console is the SAME interactive session** (§2.2) with the same skill — launched by `up --attach`
  with `DEVLOOP_HUB_URL` set. Local claude on its own login (Q2) drives ticket/doc/decision-queue ops
  against the remote board; the muscle (fires) runs remotely on opencode keys. Board browsing rides the
  authed proxy or an SSH tunnel (§6.2).
- **Home-only verbs refuse over attach.** `run`, `daemon`, `seed`, `team init/import/repair`, and the
  file-writing config mutators operate on the home's filesystem — over attach they exit with "this runs
  at the workspace home" (config changes in Phase 1/2 happen at the home: re-deploy a new bundle, or
  ssh). The attach surface is the OP surface: tickets, comments, docs, labels, project, events — plus
  `bundle`-fetch for backups if exposed.
- **Attribution is honest:** ops ride `X-Devloop-Actor: operator` — the same cooperative identity the
  daemon already records (`daemon.ts:328`); the token (bearer, §6.2) is what makes cooperative identity
  safe off-host.

This leg lands in **Phase 2** (it needs the bind+token from Phase 1 plus the base-URL flip in
`op-client.ts` and read-verb parity over HTTP — Q10); until then, remote check-ins use the authed board
proxy (reads) + ssh (verbs).

### 6.1 Local (loopback + the auto-launched chat)

Solved infrastructure. `dev-loop up` starts the board daemon (loopback `127.0.0.1:8787`,
`DEVLOOP_ACTOR=operator` pinned, `daemon-lifecycle.ts:239-258`) and launches the interactive console
session in the same terminal. The human reads/edits tickets in the browser and drives the system through
the chat. Nothing to expose.

### 6.2 Remote — the board is loopback-only by construction

The daemon binds `127.0.0.1` **hardcoded** (`daemon.ts:629`) with **zero authentication**; its entire
security model is (a) the v4-loopback bind + (b) the `writeOriginOk` Host/Origin guard
(`daemon.ts:181-200`). Reads have no Host check; every WRITE runs `writeOriginOk` first
(roadmap/ticket/op-API, `daemon.ts:433,449,335`). So remote exposure is a *security* problem, not a
plumbing one.

**The container path cannot use the LOCAL trick.** The LOCAL story (loopback bind + SSH/Tailscale tunnel to
`127.0.0.1`) works because the daemon and the operator share one host. A **container** cannot both keep the
loopback bind *and* be health-probed/exposed (§1.5) — the kubelet/`docker-proxy` reach the pod/container IP,
not the container's loopback. So the container path MUST widen the bind (`DEVLOOP_DAEMON_HOST=0.0.0.0`), and
per the `daemon.ts:181-183` invariant the widened bind MUST be paired with the token check **in Phase 1**.
There is no "read-only, auth-free, tunnel-the-writes" middle ground for containers.

**v1 — reverse proxy, READ-only, but NEVER unauthenticated.** GET/HEAD reads have no Host check, so they
proxy without the write-guard friction — but "proxyable" is not "safe to expose". Reverse-proxying reads
with no auth would publish the **entire board — every ticket, every published doc, and the strategy
north-star — to anyone who can reach the proxy.** v1 therefore **requires proxy-level authentication**
(HTTP basic-auth / `oauth2-proxy` / an SSO gateway) in front of the read-only board; **reads are never
exposed unauthenticated by default.** This is folded into the **same Phase-1 container auth decision** as
the bind+token, not shipped as an auth-free read window. Writes still **cannot be cleanly reverse-proxied
as-is**: the browser's real `Host: board.example.com` fails the `/^(127\.0\.0\.1|localhost)/` allowlist
(403); rewriting `Host→127.0.0.1` at the proxy discards DNS-rebinding protection and still fails on
`Origin: https://board.example.com` ≠ `allowed = http://127.0.0.1:8787` (`daemon.ts:196`); the CSP
`connect-src 'self'` (`daemon.ts:93`) survives only if the proxy preserves origin, which conflicts with the
Host rewrite. **Net: the Host-allowlist guard is architecturally incompatible with reverse-proxying the
write surface** — writes ride the native token (below) or an SSH/Tailscale tunnel to the loopback bind on a
LOCAL host. SSE (`/api/stream`, `MAX_STREAMS=16`, `daemon.ts:523-541`) must pass `text/event-stream`
unbuffered (daemon already sets `x-accel-buffering:no`) and preserve origin, or live refresh degrades to
static.

**v2 → pulled forward to Phase 1 for containers — native `DEVLOOP_UI_TOKEN`.** The honest path the code
already anticipates (DAEMON.md:44-45,225,240 defer a "Phase B auth model"). Add a bearer-token check
**ahead of** `writeOriginOk`, and widen `HOST`/`LOCAL_HOST` **together with** `DEVLOOP_DAEMON_HOST` — per the
invariant "if that bind ever widens … this guard must widen with it, or it silently weakens"
(`daemon.ts:181-183`). Because the container bind MUST widen (§1.5), this token work is **no longer Phase 2
for the container path** — it is the gating prerequisite for §5 (§8). It replaces "locality == identity"
with real identity and is the only thing that makes the cooperative `X-Devloop-Actor` gate (`daemon.ts:328`,
"cooperative attribution, NOT anti-spoof") safe off-host. Note `op-client.ts` hardcodes `127.0.0.1` (`:62`)
and reads the port from a machine-local runfile, so an off-host op client also needs a configurable base URL
+ the token (lands with the same Phase-1 container auth work). For the **LOCAL desktop** path, the token
stays optional and loopback+tunnel remains the Phase-1 story.

### 6.3 Remote operator chat — attach is primary; hosted TTY and comms bot are complements

With §6.0, the PRIMARY remote console is **not hosted remotely at all**: it is the operator's local
interactive session attached to the remote hub — native terminal, local claude login, zero server-side
chat infrastructure. Two complements remain for the cases attach does not cover:

- **ttyd / tmux-hosted session (optional, Phase 2)** — for driving the system from a machine with no
  dev-loop/claude installed (a borrowed browser, an iPad): run an operator opencode session inside
  `tmux` fronted by `ttyd`, behind the same auth as the board. The container gets a second port. **The
  first-run onboarding hazard (§2.2a) is acute here:** a fresh TUI in a container can hit trust/consent/
  `/login` prompts that block on a terminal no one watches — the image MUST pre-seed onboarding state,
  and the boot preflight MUST surface an unmet interactive-login as a message, not a hung pane. Note the
  hosted console is opencode (keys), per Q2 — hosting a claude login in a container is exactly the
  anti-pattern the split avoids.
- **Bidirectional comms bot (Phase 3)** — drive the operator surface through the existing comms channel
  (Slack/webhook, `team.comms`): the operator posts intents; the bot runs console verbs **as another
  attach client** (§6.0 — same op-API + token, `X-Devloop-Actor: operator`) and posts back the
  decision-queue digest (§22a). Needs the comms *inbound* half that does not exist today (comms is
  outbound-only notify) — the largest new surface, hence last.

---

## 7. Security boundaries

1. **The write-surface auth boundary.** The daemon has a writable connection and **no auth of its own**;
   today safety = 127.0.0.1 bind + `writeOriginOk` (`daemon.ts:181-200`). Reads are structurally read-only
   (`PRAGMA query_only=ON`, `daemon.ts:637`) but carry **no Host check**, so an exposed read surface leaks
   the *entire* board (tickets, docs, north-star) — reads are therefore **never exposed unauthenticated**
   (§6.2 v1: proxy-level auth mandatory). For the **LOCAL** path Phase 1 does not widen the bind: remote
   writes go over a tunnel to loopback. For the **container** path the bind MUST widen
   (`DEVLOOP_DAEMON_HOST=0.0.0.0`, §1.5), so per the daemon's own invariant — widening without widening the
   guard "silently weakens" it (`daemon.ts:181-183`) — the `DEVLOOP_UI_TOKEN` bearer check is a **Phase-1
   prerequisite**, not a deferral. There is no unauthenticated container exposure of either reads or writes.
2. **The secret-carrying bundle is a protected artifact — and its key must live elsewhere.** Because §16 is
   code-enforced, the bundle is the *only* place a password legitimately travels. It is encrypted at rest
   (age recipient key / sops KMS, §4.2 — **not** an interactive passphrase for the headless path); on load
   it decrypts into `.dev-loop/secrets.env` (chmod 600, gitignored, never committed, loose-perms warned —
   `secrets.ts:1-16,75-83`). The image, registry, and repo never hold cleartext. **The decrypt key must not
   sit on the same host as the ciphertext** — co-mounting the encrypted bundle and a plaintext age identity
   into one container reduces the encryption to obfuscation. The key comes from cloud KMS/IAM or
   is supplied at load time and never persisted next to the bundle (§4.2). A deployment uses **one**
   authoritative secret channel (bundle-encrypted *or* orchestrator Secret), never both in parallel.
3. **Container permission posture — `OPENCODE_PERMISSION` wildcard-deny.** Unattended opencode fires get the
   wildcard-deny baseline injected **after** the env spread (`run-agents.ts:211-216,869`) so the fire policy
   beats any operator/container export. This is load-bearing for unattended safety: keep container-level
   opencode config from re-opening it; override only via `team.opencodePermission` when deliberate. A fresh
   host cannot be assumed to have a benign global opencode config, so this baseline must always inject.
4. **No-login, API-key-only auth — but the interactive TUI still onboards.** The only secret channel is
   `secrets.env` (or `docker -e`); config holds env NAMES only. opencode reads keys via `{env:VAR}`
   indirection; claude reads ambient `ANTHROPIC_API_KEY`. For the **headless** fire path dev-loop never
   calls `/login`; a missing key surfaces deterministically — `classifyFireError` classes "please run
   /login" / "not logged in" / "oauth token" as `errorClass:"auth"` (`run-agents.ts:236`), and a missing
   provider `authTokenEnv` fails pre-spawn exit 4, `provider-env-missing`, zero tokens
   (`run-agents.ts:863-889`). **But `classifyFireError` only catches auth AFTER a failed fire** — it does
   nothing for the **interactive** launch (§2.2a), where a fresh TUI can hit trust/onboarding/`/login`
   prompts before any fire runs. So `up` pre-seeds onboarding state and runs a login/onboarding preflight
   *ahead of* exec (§2.2a) rather than relying on the post-fire class. claude cannot be pointed at a
   non-Anthropic endpoint today (Appendix A deferred) — a claude container is locked to the real Anthropic
   API via ambient key, which is why opencode is the container default.
5. **Secrets must not leak into repo build/test subprocesses.** Every fire inherits the daemon/`run`
   process env, and agents run repo build/test commands — plus `add-repo --detect` reads `package.json`
   scripts — as **child processes that inherit that env**. If provider keys, the comms webhook, and the
   decrypt-key path are exported at the top level (the naïve `envFrom`/`environment:` approach), a buggy or
   hostile build script sees and can exfiltrate **every** secret, including the age decrypt-key path. This
   would undermine the "image never contains secrets / bundle is the only carrier" thesis at runtime.
   Therefore, in a container: provider keys are **scoped to the LLM subprocess** that resolves `{env:VAR}`
   (injected per-fire, stripped from the parent), the `AGE_IDENTITY_FILE` / decrypt key is **never** placed
   in the fire-inherited env, and repo build/test subprocesses run **without** the provider/comms/decrypt
   secrets in their environment. This requires per-fire env scoping in the runner rather than the current
   whole-process `secrets.env` → `process.env` hydration (`secrets.ts:60-70`); see Open Question Q9 on the
   exact injection mechanism.

---

## 8. Phasing

**Phase 1 — local `dev-loop up` + console skill + Q1 verbs + bundle (move/backup) + Docker/compose.**
- New `up` verb (`cli.ts`) — Phase A bootstrap + `interactiveCommandFor()` sibling + operator env block
  (§2). No branching of the headless hot path. **Verify every interactive CLI flag** (§2.2) and the
  **non-interactive onboarding invocation** (§2.2a) against the live `claude`/`opencode` before relying on
  them; drop what does not confirm and lean on the `CLAUDE.md`/`AGENTS.md` priming channel.
- **The Q1 mutators:** `team add-provider` (E16-validated, runs sync-opencode) + `dev-loop secret set`
  (TTY-prompted value → `secrets.env` chmod 600; secrets never transit the chat) (§2.5 step 4).
- `skills/operator-console/SKILL.md` + `CHEATSHEETS` entry + `team-init` scaffolding of workspace-root
  `CLAUDE.md`/`AGENTS.md` (§3) — authorable NOW (Q1 resolved; the HARD LIMIT holds with no exception).
  `export-operator-console` flatten verb.
- `dev-loop bundle export` + `dev-loop up --bundle` (§4): recipient-key/KMS encryption (no headless
  passphrase), **`hub.db` in the payload by default** (WAL-checkpointed move; restore-onto-empty,
  never-overwrite-live — Q6), `--backup` live-checkpoint flavor (§4.6), **git-credential
  materialization** (§4.1a), an **idempotent/resumable loader** (§4.5: authoritative-once config,
  resumable clone, `team repair` boot reclaim), `--move` source retirement stamp (§4.3).
- **Container prerequisites (BLOCKING for §5, not deferred):** the `DEVLOOP_DAEMON_HOST` bind knob **and**
  the `DEVLOOP_UI_TOKEN` bearer check land **together** (§1.5, §6.2) — the daemon's invariant forbids
  widening the bind without the guard. **Per-fire secret scoping** (§7 boundary 5) so keys/decrypt-key do
  not leak to build/test subprocesses. The daemon owner is already resolved (Q5: `run` owns it, §5.1).
- Dockerfile (entrypoint = `up --bundle` → exec `dev-loop run`, which owns the daemon; `0.0.0.0` bind +
  token; per-fire secret scoping; onboarding pre-seed) + docker-compose single-service + workspace volume
  (§5.1-5.2).
- Remote board exposure = **authenticated** read-only reverse proxy (basic-auth/oauth2-proxy) + native token
  for writes (§6.2). **No unauthenticated read or write window ships.**
- **Blocked-by note:** interactive claude on API-only auth depends on Appendix A (`ANTHROPIC_*` injection);
  per Q2 this stays deferred — claude is the LOCAL console on its own login; containers are opencode.
- **Fallback:** if the bind knob + token cannot land in Phase 1, the entire Docker/compose surface (§5) and
  any board exposure move to Phase 2 — a loopback-only container can be neither health-probed nor exposed
  (§1.5). There is no partial container ship.

**Phase 2 — attach mode + Helm/Kubernetes + bare-Linux supervision.**
- **Attach (§6.0):** `DEVLOOP_HUB_URL` base-URL + bearer-token support in `op-client.ts` (loopback
  hardcode at `:62` becomes the default, not the only, target), read-verb parity over the op-API (Q10),
  `dev-loop attach` / `up --attach` launching the local console against the remote hub, home-only verbs
  refusing with a clear message. This is the "operate from anywhere" milestone — and the answer to
  "progress flows back" (§4.6).
- Kubernetes StatefulSet (single-replica enforced by an **O_EXCL boot lock on the PVC** + **pod
  anti-affinity** + a scale-blocking policy, `updateStrategy: OnDelete` — **not** Recreate; PVC) as a Helm
  chart (§5.3), building on the Phase-1 bind+token.
- systemd unit for bare-Linux hosts (fills the autostart gap the macOS-only lifecycle leaves).
- ttyd/tmux-hosted remote opencode console behind the token, with onboarding pre-seed (§6.3, §2.2a) —
  optional; attach is the primary remote console.

**Phase 3 — bidirectional comms bot.**
- Inbound comms path (the console driven from Slack/webhook, not a TTY) implemented **as an attach
  client** (§6.0/§6.3), digest-back of the operator decision-queue (§22a). Needs the comms subsystem to
  grow an inbound half — the largest new surface, hence last.

---

## 9. Open questions

**Resolved 2026-07-17 (rev 2, operator):** Q1 → first-class `team add-provider` + `dev-loop secret set`
(TTY-prompted; secrets never transit the chat) — §2.5 step 4, §3.1(d). Q2 → local claude on its own
login; containers opencode on keys; Appendix A stays deferred — §2.6. Q5 → `dev-loop run` owns the
daemon (Option A) — §5.1. Q6 → the bundle carries `hub.db` (move semantics, restore-onto-empty /
never-overwrite-live); ongoing progress flows back via attach + git + scheduled backup, never db sync —
§4.5-4.6, §6.0.

Still open:

- **Q3 — Bundle encryption default: `age` recipient key vs `sops`+KMS? (Passphrase is OUT for headless.)
  Proposed default: `age` recipient-key (single static binary, auditable, fits the compose story), with
  `sops`+KMS supported for cloud/K8s deployments whose IAM should hold the key — confirm.**
  A passphrase-tar / age passphrase requires an interactive prompt at load, which **hangs a headless
  container/pod** (no one to type it) — so it is excluded from the container/K8s path (§4.2) and permitted
  only for the same-desktop LOCAL case or when supplied via a mounted file/env at load. The live choice is
  between `age` recipient-key (simplest, auditable, but the private key must still be sourced off-box, §4.2)
  and `sops`+cloud-KMS (heavier tooling, but the decrypt key never lands on disk and rides cloud IAM). Which
  is the default for the shipped container story, and do we support both?

- **Q4 — How hard is the source-side retirement enforced on a `migrate` move?** Move semantics keep the
  `workspaceId` (§4.3), so the double-drive hazard shifts to the SOURCE: after `bundle export --move`,
  the origin workspace must stop firing. The design stamps a `movedTo` marker and has `run`/`doctor`
  refuse/warn on a moved-away source — is a marker + refusal enough (operator can delete the marker), or
  should the export actively disable the source (`enabled:false` every project / stop the daemon) as part
  of `--move`? For the template case, `fork` (mint a new id) remains available at export/load time.

- **Q7 — Remote read-only board default-on (now that reads require auth)?** Reads have no Host check
  (`daemon.ts`), so proxying them is easy — but exposing them **unauthenticated** would leak the entire
  board, so v1 mandates proxy-level auth regardless (§6.2 v1). The remaining question is the *default
  posture*: does the container expose the board read-only **behind that mandatory auth** out of the box, or
  stay strictly loopback+tunnel until the operator opts in? The op-API/write surface stays dormant either
  way unless `settings_json.hub.transport==='daemon'` is seeded and a writable actor is set.

- **Q8 — What is the exact non-interactive-onboarding invocation for each TUI?** A fresh interactive
  `claude`/`opencode` can present trust-folder / theme / consent / `/login` prompts that hang a container
  TTY and break the LOCAL "land in a chat" promise (§2.2a). The mechanism per CLI — accept-terms/trust
  **flags** vs a **pre-written config file** the image seeds — is **UNVERIFIED** and must be pinned during
  Phase 1. Which invocation reliably lands each TUI directly in a chat, and how does `up` pre-seed it?

- **Q9 — How are provider keys scoped per-fire so build/test subprocesses cannot read them?** The current
  model hydrates all of `secrets.env` into the whole-process `process.env` (`secrets.ts:60-70`), which every
  fire — and every agent-run build/test child — inherits (§7 boundary 5). The fix requires injecting
  provider keys only into the LLM subprocess (and stripping them, plus the decrypt-key path, from the
  parent), but the exact mechanism (per-fire env allowlist vs a scoped secret handoff vs a wrapper that
  clears secrets before agent-run shell commands) is a runner change to be designed. Which approach, and
  does it also cover the LOCAL desktop where the same inheritance exists?

- **Q10 — Attach-surface parity: which verbs must the op-API cover in Phase 2?** The write ops mirror
  stdio 1:1 through `op-client.ts` already (§6.0), but the read verbs (`tickets`, `ticket`, `doc get/
  list/history`, `events`) run direct-db today (`cli-tickets.ts:150`) — attach needs them over HTTP.
  Scope question: is Phase-2 attach the OP surface only (tickets/comments/docs/labels/project/events,
  with config mutations staying home-side), or does it also grow remote-safe config reads
  (`team show`-style)? And should `metrics --json` (the decision queue, §22a) ride attach so the local
  console can quote it without ssh?
