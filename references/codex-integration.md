# dev-loop — Codex integration (optional)

A **companion-plugin** playbook: how the dev-loop agents may reach for **OpenAI Codex**
as an optional power tool — an *independent reviewer*, an *image generator*, and a
*second-engine rescue*. This file is the detailed how-to; the canonical rules live in
[`conventions.md` §24](conventions.md#24-codex--optional-power-tools), which every agent
reads. If a rule here conflicts with conventions, conventions wins.

> **Opt-in, and absent ⇒ 100% unchanged.** If the `codex` config block is absent **or**
> the `codex` CLI is not on `PATH`, every agent behaves exactly as it does today — no
> review call, no image step, no rescue, no new prompts. Codex is an **accelerant the
> loop may use, never a dependency it needs.** (Same opt-in philosophy as `backend`
> §18, `repos[]` §19, and `reports.sink` §23.)

---

## What Codex adds (and what it does NOT)

| Capability | Who uses it | Why Codex (not just the dev-loop agent itself) |
|---|---|---|
| **Independent review** | Dev (Step 5.5), Architect | A *second model* on the diff/codebase — catches what the author's own pass misses. Codex `/review` quality, on demand. |
| **Image generation** | PM (mockups), Dev (real UI assets) | The dev-loop agents **cannot generate images**; Codex has a native `image_generation` tool. This is the one capability the loop genuinely lacks. |
| **Delegate / rescue** | Dev (before a `fix-exhausted` block) | A different engine takes one pass at a stuck ticket before Dev gives up — cheap extra attempt, still gated. |

**Codex is advisory, never authoritative.** The dev-loop agent always owns the
decision, the gate, and the ship. Codex output is an input to the agent's existing
judgment — it never bypasses the firewall (§2), `mode` (§12), `autonomy` (§12a), the
ship gates (Dev §5/§5.5/§6/§6.5), or the security doctrine (§16). A Codex review does
**not** replace Dev's own self-review; it augments it.

---

## Prerequisites (operator-present, one-time)

1. **Codex CLI** installed and authenticated:
   ```bash
   npm install -g @openai/codex      # Node 18.18+
   codex login                       # ChatGPT sign-in or API key
   codex --version                   # sanity check
   ```
   Codex usage counts against your ChatGPT/Codex limits — see the Codex pricing docs.
2. **codex-plugin-cc** installed in Claude Code (gives the `/codex:*` commands the
   operator and the agents can invoke):
   ```bash
   /plugin marketplace add openai/codex-plugin-cc
   /plugin install codex@openai-codex
   /reload-plugins
   /codex:setup                      # verifies Codex is ready
   ```
3. **Verify the native tools** Codex will use (image generation is the load-bearing one):
   ```bash
   codex features list | grep -E 'image_generation'
   # image_generation   stable   true
   ```
4. Add the `codex` block to the project in `projects.json` (below). Absent ⇒ off.

`/dev-loop:init` does **not** install Codex for you (it's a separate vendor CLI), but it
notes the option in its readiness checklist when a `codex` block is present.

---

## Config block

Add an optional `codex` object to a project in `projects.json` (full schema in
[`config-schema.md`](config-schema.md)):

```jsonc
"codex": {
  "enabled":   true,            // master switch. false / absent ⇒ codex is never invoked (today's behavior)
  "review":    true,            // Dev Step 5.5 + Architect may run an independent codex review pass
  "rescue":    false,           // Dev may delegate ONE rescue pass to codex before a fix-exhausted block
  "imageGen":  true,            // PM/Dev may generate images via codex's image_generation tool
  "assetsDir": "public/generated", // repo-relative dir where Dev commits generated production assets (multi-repo: per the ticket's repo:<name> tree)
  "model":     null,            // optional: pin a codex model (e.g. "gpt-5.4-mini"); null ⇒ codex's own default / its config.toml
  "effort":    null             // optional: reasoning effort (none|minimal|low|medium|high|xhigh); null ⇒ codex default
}
```

Each sub-flag is independently gated: e.g. `review:true, imageGen:false` runs reviews
but never generates images. A missing sub-flag ⇒ that capability is **off**.

---

## Invocation forms — deterministic first

The dev-loop agents run **unattended on a loop**, so they prefer the **blocking,
parseable** Codex CLI forms over the plugin's `--background` + `/codex:status` polling
(which is operator-present ergonomics). Two ways to call Codex:

- **Programmatic (preferred in the loop):** `codex exec …` / `codex exec review …` —
  runs to completion, prints to stdout, exits. Add `--json` for JSONL events when you
  need to parse structured output, or `--output-last-message <file>` to capture just the
  final message.
- **Plugin slash-commands (operator-present, or a single attended pass):** `/codex:review`,
  `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`, `/codex:result`,
  `/codex:cancel`. Convenient when a human is driving; in a looped agent, drive
  `codex exec` directly so the call is synchronous and self-contained.

Shared flags the loop always sets:
- `< /dev/null` — close stdin. Without it `codex exec` prints *"Reading additional input
  from stdin…"* and **waits**, hanging an unattended fire.
- `-C <dir>` (or `--cd`) — run in the target repo / assets dir (multi-repo: the ticket's
  `repo:<name>` tree, §19).
- `--skip-git-repo-check` — only when the target dir is not a git repo (a scratch/mock dir).
- `-c model_reasoning_effort=<…>` / `-m <model>` — only when `codex.effort` / `codex.model`
  are set; otherwise leave Codex on its own defaults / `config.toml`.

---

## Capability 1 — Independent review (read-only)

**Where it plugs in:** Dev **Step 5.5 stage 2** ("code quality") already says *"if a
`code-review` skill/command is available, invoke it"* — Codex **is** that reviewer when
`codex.review` is on. Architect (Job 2) may likewise take a Codex second opinion on its
rotating dimension.

**Form (read-only — `codex review` / `codex exec review` never edit code):**
```bash
# Review the working-tree diff (Dev, after green gates, before shipping):
codex exec review -C "$REPO" < /dev/null

# Review the branch vs a base ref:
codex exec review --base main -C "$REPO" < /dev/null   # (or /codex:review --base main)

# Pressure-test a design decision (Architect / a risky Dev change):
#   the plugin's steerable variant takes focus text:
/codex:adversarial-review challenge the caching + retry design for race conditions
```

**How Dev treats the findings (unchanged gate semantics):**
- It is an **additional advisory pass**, not a replacement for Dev's own Step-5.5
  self-review. Run *both*.
- **Critical / High** findings are blocking exactly like Dev's own (Step 5.5 stage 2):
  fix this run, or if you can't, revert and **block** the ticket `Bail-shape:
  fix-exhausted` with the findings. Medium/Low/nits are non-blocking — apply the cheap
  ones, note the rest in the hand-off.
- **Codex disagreeing with Dev is signal, not gospel.** If Codex flags something Dev is
  confident is a false positive, Dev may proceed but must say so in the hand-off (so the
  owner can see the disagreement). Codex never gets a veto the gates don't already grant.
- **`dry-run` (§12):** a read-only review is safe to run and print even in `dry-run`
  (it mutates nothing) — but no resulting code change is shipped, same as any dry-run.

---

## Capability 2 — Image generation (the capability the loop lacks)

Codex's native `image_generation` tool produces real raster images. **Verify it's
present:** `codex features list | grep image_generation` → `image_generation stable true`.

### ⚠️ How the tool actually saves (verified — read this first)
`image_generation` does **not** save to a path you name in the prompt. It **always**
writes the PNG to:

```
~/.codex/generated_images/<session-id>/ig_<hash>.png
```

…and it ignores the filename **and the pixel dimensions** you ask for (a "512×512
gear.png" request produced a `1254×1254` `ig_*.png`). Worse, Codex's own final message
will often claim *"saved to ./gear.png"* — that line is a **confabulation**; no such file
exists. So **never trust the model's reported path** — the agent must locate the real
generated file and **copy it out** to the target. Two verified recipes:

**Recipe A — agent-orchestrated (deterministic; preferred in the loop).** The dev-loop
agent runs Codex to generate, captures the **session id**, then copies the file itself —
no dependence on Codex's self-report, and **race-safe under concurrency** (scopes to the
one session dir):
```bash
# 1) generate; capture the session id from --json (or the exec banner "session id: …")
SID=$(codex exec --json --sandbox workspace-write -C "$REPO" < /dev/null \
  "Use your built-in image_generation tool to create <precise description: subject,
   style, palette, background>. Use the tool directly; do not write code." \
  | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p' | head -1)
# 2) copy the just-generated PNG out to the repo asset path:
SRC=$(ls -t "$HOME/.codex/generated_images/$SID/"*.png | head -1)
mkdir -p "$REPO/$ASSETS_DIR" && cp "$SRC" "$REPO/$ASSETS_DIR/<name>.png"
```

**Recipe B — single-call (simpler; Codex copies it itself).** Tell Codex to generate
**and** `cp` the result, scoping the copy to **this** session's dir (don't "newest across
all of generated_images" — that races other Codex runs):
```bash
codex exec --sandbox workspace-write -C "$REPO" < /dev/null \
  "Step 1: use your built-in image_generation tool to create <precise description>.
   The tool saves the PNG under ~/.codex/generated_images/<this session id>/.
   Step 2: copy that generated PNG (a shell cp is allowed) to $ASSETS_DIR/<name>.png in
   the working directory. Step 3: print DONE and run 'ls -l $ASSETS_DIR/<name>.png'."
```

Mechanics that bite (all verified):
- **`--sandbox workspace-write` is mandatory.** `codex exec` defaults to a **read-only**
  sandbox and silently produces **no on-disk copy**. workspace-write permits the workdir
  (+ `/tmp`, `$TMPDIR`); home is readable, so the `cp` from `~/.codex/generated_images`
  into the workdir works.
- **`< /dev/null`** so the fire doesn't hang on *"Reading additional input from stdin…"*.
- Dimensions aren't honored by the prompt — if you need an exact size, resize after the
  copy (e.g. `sips`/`magick`) rather than asking Codex for it.

### 2a. Dev — production assets an acceptance criterion requires
When a ticket's ACs call for an image the code needs (an icon, an illustration, an
OpenGraph/social card, a placeholder, a favicon), Dev generates it **into the repo**
under `codex.assetsDir` during Step 4 (Recipe A/B above, `$REPO` = the ticket's
`repo:<name>` tree, §19), then it ships through the normal gates like any other file:
- The asset is a **repo artifact**: Dev stages **only** the generated file(s) + the code
  that references them (staging discipline, §7), commits with the ticket id, and ships
  per config (Step 6). It runs through Step 5 gates and Step 5.5 self-review.
- Coverage (§15): a generated static asset is treated like a docs/asset change — exempt
  from a regression test (note it in the hand-off); the *code that uses* it still
  follows §15.
- **`dry-run` (§12):** generate to a scratch path if useful for the preview, but make
  **no** commit/push/deploy and don't write into the shipping tree — print what you'd do.

### 2b. PM — mockups / wireframes to sharpen a Feature ticket
When a Feature is easier to specify with a picture, PM may generate a **mockup** and
attach/reference it on the ticket so Dev builds against a concrete visual. This is a
**spec aid, not a production asset** — keep it out of the shipping tree (copy it to a
scratch dir, then attach/reference it).
- Mark it clearly in the ticket as **"mockup — illustrative, not the production asset"**
  so Dev treats it as direction, not a drop-in file.
- §16: **never** put real user data / PII / secrets in an image prompt. A mock is
  synthetic by construction — use placeholder names/numbers.

---

## Capability 3 — Delegate / rescue (a second engine on a stuck ticket)

Before Dev blocks a ticket `Bail-shape: fix-exhausted` (§9 — Dev tried, couldn't make
the gates/self-review pass), and **only if `codex.rescue` is on**, Dev may hand the task
to Codex for **one** pass (a different model/engine often breaks a stall):

```bash
/codex:rescue fix the failing <test/flow> with the smallest safe patch
# or programmatically, write-capable:
codex exec --sandbox workspace-write -C "$REPO" < /dev/null "<the stuck task, precisely stated>"
```

Hard limits:
- **One rescue attempt per ticket per fire** — Codex is not a retry loop. If its patch
  doesn't pass Dev's own Step-5 gates **and** Step-5.5 self-review, Dev discards it and
  blocks `fix-exhausted` exactly as it would have. (This sits *inside* §9's "cap blind
  retries at 2" — a rescue is the considered alternative, not a 3rd blind retry.)
- Codex shares the **same git checkout** (§7): after a rescue, Dev re-reads `git status`,
  reviews the diff line-by-line (Step 5.5), and stages **only** this ticket's files —
  never blind-commits whatever Codex left in the tree.
- **`dry-run` (§12):** no rescue (it writes code) — print that you *would* delegate.

---

## Safety & boundaries (recap — conventions win)

- **Firewall (§2):** Codex never touches Linear. All ticket state stays with the
  dev-loop agent through the configured backend (§18). Codex only ever touches **code /
  files / a review of them**.
- **Same machine, same checkout (§7):** an image or rescue run mutates the working tree.
  Stage only your ticket's files; if commits/files you didn't author appear, surface it
  (§7) rather than building on them blindly.
- **`mode` (§12):** in `dry-run`, Codex makes **no** repo writes that ship — read-only
  review may run and print; image/rescue are described, not committed.
- **`autonomy` (§12a):** Codex must never inject an **interactive** prompt into the loop.
  Use the non-interactive `codex exec` forms with `approval never` (the exec default) and
  an explicit `--sandbox` — never a form that pauses for a human. A genuine
  external-prerequisite (e.g. Codex not logged in) is reported as a fact and the agent
  proceeds without Codex, exactly as if `codex.enabled` were false.
- **Security (§16):** never pass secrets/PII into a Codex prompt or image description;
  treat Codex's stdout like any tool output (no raw secrets into tickets/reports). Codex
  inherits your local Codex auth/config — no new credential lives in `projects.json`.
- **Determinism:** prefer `codex exec`/`codex exec review` (synchronous) in the loop; the
  `--background` + `/codex:status`/`/codex:result` flow is for an attended operator.

---

## Quick reference

| Need | Command (loop form) |
|---|---|
| Review the diff | `codex exec review -C "$REPO" < /dev/null` |
| Review vs base branch | `codex exec review --base main -C "$REPO" < /dev/null` |
| Adversarial / steerable review | `/codex:adversarial-review <focus text>` |
| Generate an image (then copy out) | `codex exec --sandbox workspace-write -C "$REPO" < /dev/null "…image_generation… then cp the PNG from ~/.codex/generated_images/<session>/ to <assetsDir>/<f>.png"` — file lands in `~/.codex/generated_images/<session-id>/ig_*.png`, **not** the named path (see Capability 2) |
| Resize a generated asset (size isn't honored) | `sips -z <h> <w> <assetsDir>/<f>.png` (or `magick`) after the copy |
| Rescue a stuck ticket | `/codex:rescue <task>` or `codex exec --sandbox workspace-write -C "$REPO" < /dev/null "<task>"` |
| Check Codex is ready | `codex --version && codex login status && codex features list \| grep image_generation` |
