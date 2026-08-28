# Codex power tools — the three capabilities — conventions §24 pointer file

> Moved out of `references/conventions.md` §24 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §24's contract: read it at the trigger moment the §24 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

The three capabilities (each detailed in `references/codex-integration.md`):

1. **Independent review (read-only) — Dev Step 5.5, Architect.** When `codex.review` is
   on, Codex is the concrete "`code-review` skill/command" Dev Step 5.5 stage 2 already
   reaches for, and an optional second opinion for Architect (`/codex:review`,
   `/codex:adversarial-review`, or `codex exec review`). It is an **additional** pass,
   **not** a replacement for Dev's own self-review — run both. Dev treats Codex's
   **Critical/High** findings exactly like its own (blocking: fix this run, or revert +
   block `fix-exhausted`, §9); Medium/Low are non-blocking. Codex disagreeing with the
   author is **signal, not a veto** — Dev may proceed over a believed false-positive but
   must say so in the hand-off. Read-only, so it may run (and print) even under
   `dry-run`.

2. **Image generation — PM mockups, Dev production assets.** This is the one capability
   the loop genuinely **lacks** (the agents can't draw). The verified generation recipe —
   feature detection, the REAL output path (Codex's own "saved to" line is a
   confabulation), the copy-out step, the `--sandbox workspace-write` requirement — is
   **`references/codex-integration.md`**: read it at the moment you actually generate. Dev
   (Step 4): generate an AC-required asset **into the repo** under `codex.assetsDir`,
   stage **only** that file + its referencing code (§7), and ship it through the normal
   gates — a static generated asset is a §15 coverage *exemption* (note it), the code
   using it is not. PM (Job C): generate a **mockup** to a scratch dir and
   attach/reference it on the Feature ticket as *"illustrative, not the production
   asset."* §16: **never** put PII/secrets into an image prompt. Under `dry-run`: no
   shipping-tree write, no commit — describe/scratch only.

3. **Delegate / rescue — Dev, before a `fix-exhausted` block.** When `codex.rescue` is
   on, Dev may hand a stuck ticket to Codex for **one** pass (`/codex:rescue` or a
   write-capable `codex exec`) before blocking — a different engine often breaks a stall.
   Hard caps: **one** rescue attempt (it sits *inside* §9's "cap blind retries at 2",
   not on top), and Codex's patch ships **only** if it passes Dev's own Step-5 gates
   **and** Step-5.5 self-review; otherwise Dev discards it and blocks `fix-exhausted` as
   it would have. Codex shares the **same checkout** (§7): re-read `git status`, review
   the diff, stage only this ticket's files — never blind-commit what Codex left. Writes
   code, so: no rescue under `dry-run`.

**Config** (§11; full schema in `config-schema.md`): an optional `codex` block —
`{ enabled, review, rescue, imageGen, assetsDir, model?, effort? }`. Absent ⇒ off. No
secret lives here — Codex uses your local `codex login` auth/config (§16). Prerequisites
(install the CLI, `codex login`, install codex-plugin-cc) are operator-present, one-time;
the 1.x workspace bootstrap records the option when a `codex` block is present but does
**not** install the vendor CLI for you.
