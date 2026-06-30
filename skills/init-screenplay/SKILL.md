---
name: init-screenplay
description: >-
  Interactive, operator-present bootstrap for a NEW short-drama (竖屏短剧) dev-loop
  project — the screenwriting counterpart of /dev-loop:init. Use this whenever the user
  invokes /init-screenplay (i.e. /dev-loop:init-screenplay), or asks to "init a screenplay
  / 短剧 project", "start a new short-drama", "set up a screenplay loop", or "立一部剧".
  It runs a guided STRATEGY INTERVIEW to draw the operator's creative requirements out of
  a conversation (题材/平台/受众/集数/付费卡点/主角人设/爽点偏好/基调/禁区), writes those
  answers into the show bible (the loop's north star), scaffolds the engineered series
  artifact set + the projects.json entry + the lessons seed (via tools/init-screenplay.mjs),
  provisions the board, and prints a readiness checklist — then STOPS. It never designs arcs
  or the grid (that's story-architect), never writes episodes (that's the screenwriter),
  never files tickets, and NEVER starts the loop: the operator launches it. Idempotent and
  non-destructive — it never overwrites a bible the operator has already filled.
---

# init-screenplay — short-drama project bootstrap (interactive)

You bootstrap a **new short-drama** so the operator can later launch the loop. This is
**setup**, operator-present and conversational — the screenwriting analog of `/dev-loop:init`.
Your job is to **draw the creative direction out of the operator** (never invent it), write it
into the **bible** (the loop's north star), wire the project, and hand off. You end by telling
the operator how to launch — you do **not** start the loop.

> **What you do NOT do.** You never design arcs or fill `grid.csv` (that's **story-architect**),
> never write episodes (that's the **screenwriter**), never file tickets, never run a fire of any
> loop agent, and never flip `mode:"live"` or kick off `dev-loop run`. You establish the **bible +
> the project**, exactly like the coding init establishes PROJECT.md — and stop.

## 0. Read the rules first

Read the shared conventions (config, the strategy/north-star doc, the §17 boundary):

- `${CLAUDE_PLUGIN_ROOT}/references/conventions.md`

You reuse: §11 (config / projects.json), §12 (`mode` — in `dry-run`, write nothing; print every
WOULD-CREATE), §17 (you draft the bible WITH the operator; the operator owns/publishes it), §18
(backend), §20 (the bible IS the strategy doc / north star), §21a (the tiers you're setting up for:
senior-dev=story-architect, junior-dev=screenwriter, qa=screenplay-editor).

Two helpers you orchestrate (don't re-implement them):
- **`${CLAUDE_PLUGIN_ROOT}/tools/init-screenplay.mjs`** — the mechanical scaffold (series skeleton
  + `projects.json` entry + `lessons.md` seed). Idempotent + non-destructive.
- **`${CLAUDE_PLUGIN_ROOT}/templates/screenwriting/bible.md`** — the bible structure you fill from
  the interview; **`${CLAUDE_PLUGIN_ROOT}/examples/series-hidden-heir/`** — a worked, lint-clean
  reference you cite to make smart suggestions during the interview.

**Open** with a one-line statement of what this will do (interview → fill bible → scaffold → wire →
readiness; you won't start the loop). State `mode` if you can read it.

## 1. The bootstrap flow — INTERVIEW → SCAFFOLD → FILL → PROVISION → READINESS

### Step 1 — The strategy interview (the heart — draw it out, never invent)
Conduct a **short, adaptive** interview — ask in small batches, propose smart defaults grounded in
the two sample-script DNA (`examples/`), and confirm. This is the **only** product direction the
loop ever gets from you; the operator owns it. Cover the **11 required** fields (a missing one is a
✗ in the readiness report, not a hard stop — you can scaffold with a `<TODO>` and let the operator
fill it later):

1. **题材 / genre** — propose from common 短剧 lanes (战神/赘婿, 总裁逆袭, 重生复仇, 甜宠, 狼人/fated-mate,
   隐藏大佬/身世反转…); name a comparable (e.g. "像 *The Hidden Heir Takes Over* 的身世反转复仇").
2. **平台** (ReelShort / DramaBox / 红果 / 抖音) — drives 单集时长、付费卡点惯例、合规红线.
3. **受众** (女频 / 男频 + 地区).
4. **语言** (中 / 英 / 双语).
5. **集数 × 单集时长** (默认 60–80 集 × 60–120s; 短切片可更少).
6. **付费卡点位** — 免费集区间 + 卡点集号（落在「好奇心负债最高点」，典型 ep8–12）。
7. **核心卖点 + logline + 招牌开篇钩** — 一句话前提 + 第1集的开场钩。
8. **主角人设** — 女主 + 男主 archetype + 各自 **声纹**（一句标志性台词/收尾句式）+ 携带的**契诃夫枪**。
9. **爽点类型偏好 + 权重** — 打脸 / 逆袭 / 身份反转 / 甜，及**双供给配比**（如 复仇:甜 = 6:4）。
10. **基调** (爽 / 虐 / 甜 的比例).
11. **禁区 / 合规** (涉政 / 血腥 / 未成年 / 价值观红线).

**Optional** (offer, don't require): 对标剧（作为 DNA 种子）、指定信物/recurring devices、角色名库、多季意图、
制作成本上限（→ 偏台词级反转载体）。

Reflect each answer back briefly so the operator can correct it. **Do not move on with an invented
answer** — a `<TODO>` placeholder is honest; a fabricated premise is not.

### Step 2 — Project shape (confirm with the operator)
Confirm: **project key** (e.g. `myshow`), **display name**, **ticket prefix** (e.g. `SD`), the
**series directory** absolute path (where `bible.md`/`characters.csv`/`grid.csv`/`episodes/` live),
and the **backend**: **`service`** (recommended — a hub Web board makes the human design/taste gates
practical) or **`local`** (zero-cloud file board; gating by editing ticket files). Default `service`.

### Step 3 — SCAFFOLD (run the mechanical helper)
Run (in `dry-run`, print the command instead):
```
node ${CLAUDE_PLUGIN_ROOT}/tools/init-screenplay.mjs <key> "<name>" <PREFIX> <seriesDir> --backend <local|service>
```
It creates the series skeleton (empty bible/characters/grid + `episodes/`), writes a non-destructive
`projects.json` entry (`agentFamily:"screenwriting"`, absolute `repoPath`, `strategyDoc:"bible.md"`,
the dramalint test command, `mode:"dry-run"`, **no `models`** so Codex uses gpt-5.5 / Claude its
defaults), and seeds the per-project `lessons.md` (the reflect redirect rule). It does **not** fill
content — that's the next step.

### Step 4 — FILL the bible + characters from the interview (non-destructive)
Write the operator's interview answers into the scaffolded files — this is the loop's **north star**,
the equivalent of init filling Vision/Goals:
- **`<seriesDir>/bible.md`** — fill the `## 立项书`, `## Vision`(logline + 双供给配比), `## 爽点配方`
  (类型轮转 + 密度目标 + 双供给配比), `## 钩子模板`, `## 禁区红线` sections, and set the **`gate-config`
  围栏块** thresholds from the answers: `length_min/max` (单集时长), `paywall_boundary_ep` (卡点集),
  `opening_protected_eps` (前几集), `free_eps`, density/double-supply targets. Leave the
  契诃夫枪台账 / Decisions log as starter lines for story-architect to grow.
- **`<seriesDir>/characters.csv`** — seed the protagonist rows from answer #8 (id, name, aliases,
  archetype, faction, **voice_signature**, first_ep, function, **secret_setup**, status).
- **Non-destructive**: only fill template placeholders (`<…>`). If a section is already
  operator-edited, **confirm before changing it**; never clobber real content (idempotent re-run).
- **Never** fill `grid.csv` or write into `episodes/` — those belong to the loop agents.
- In `dry-run`, print the filled bible/characters you *would* write.

### Step 5 — PROVISION the board
- **`service`**: run `dev-loop init-service <key> "<name>" <PREFIX>` (creates the hub project +
  labels + actors incl. senior-dev/junior-dev/qa), then `dev-loop daemon up` and report the board
  Web URL (the operator's gate workstation). Labels like `note:*`/`opening:protected` need no seeding
  (free strings, created on first use).
- **`local`**: nothing to provision (the board auto-creates under `~/.dev-loop/<key>/board/`); say so.
- In `dry-run`, print the commands.

### Step 6 — READINESS report (the deliverable) + how to launch
Print a per-item **✓ (done) / ✗ (missing — names who/what it blocks) / — (N/A)** checklist:
- **Bible** — each of the 11 fields filled, or ✗ with the `<TODO>` left; `gate-config` thresholds set.
- **Characters** — at least the leads seeded with voice_signatures.
- **Series + config** — series dir scaffolded; `projects.json` entry written (`agentFamily`,
  `repoPath`, `mode:dry-run`); `lessons.md` seeded.
- **Board** — service: project + daemon up (URL); local: auto.
- **Engine** — Codex (`codex login` done) and/or the source plugin for Claude, per how they'll run.

End with a **plain-English verdict + the exact launch command** — but do **not** run it:
> *"Ready. Fill any remaining bible `<TODO>`s, flip this project's `mode` to `"live"` in
> `~/.dev-loop/projects.json`, then **launch the loop yourself**: `dev-loop run --cli codex --once
> --agents senior-dev --dev-split --project <key> --root <DL>` (story-architect designs the first
> arc) → review at the board (design gate) → `--agents junior-dev` (write) → review (taste gate).
> Or in Claude Code interactively: `/dev-loop:story-architect-agent`."*
…or the precise blockers (e.g. "✗ codex not logged in → the Codex loop can't fire").

## 2. Guardrails
- **Setup only — never the loop's work.** Never file tickets, never design arcs/grid, never write
  episodes, never run a loop-agent fire, never flip `mode:"live"`, never start `dev-loop run`. You
  build the bible + the project and **hand off**.
- **Draw it out, never invent.** The bible content is the operator's. A `<TODO>` placeholder for an
  unanswered field is honest; a fabricated premise/卖点/人设 is a defect (§17 — the operator owns the
  north star).
- **Asking is allowed here — and only here.** init-screenplay is operator-present, so you interview
  and confirm. This does **not** loosen the loop agents: story-architect/screenwriter/editor run
  hands-off per `autonomy` (§12a). Make that boundary explicit so the operator doesn't expect prompts
  at runtime.
- **Idempotent + non-destructive.** Verify-then-create-if-absent. A second run on a wired project is a
  near-no-op that re-prints the readiness report; never overwrite a filled bible / projects.json entry
  / lessons.md / board.
- **Respect `mode` (§12).** In `dry-run`, do all the interview + reads, but make **no** writes — print
  every WOULD-CREATE/WOULD-FILL action.

## 3. Close with the readiness report
End with the Step-6 checklist (✓/✗/— per item) + the plain-English verdict and the exact launch
command for the operator to run **when they choose to**. State plainly: the loop is **not** running;
you set it up; the operator starts it.

---

**§17 boundary.** This SKILL, `conventions.md`, `tools/*`, and the dev-loop code are operator-applied
governing files — you never self-edit them. The **bible** you draft is the operator's north star
(they own and, on `service` with a hub strategy doc, publish it); you scaffold and fill it WITH them,
never invent direction. The **grid**, the per-arc **beat-sheet**, and the **episodes** are the loop
agents' artifacts — not yours to create. You interview, write the bible, wire the project, and hand
off — nothing of the loop's actual creative work.
