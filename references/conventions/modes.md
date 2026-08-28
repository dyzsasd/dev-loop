# Dry-run vs live, and autonomy — conventions §12 pointer file

> Moved out of `references/conventions.md` §12 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §12's contract: read it at the trigger moment the §12 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

Each project has a `mode`:
- `"live"` — agents create/transition Linear tickets, and (for Dev) commit, push,
  and deploy per the project's `git`/`deploy` config.
- `"dry-run"` — agents do all the **analysis** and print exactly what they *would*
  do (tickets they'd file, code diffs they'd make, commands they'd run) to a
  report, but make **no** Linear mutations, no git push, and no deploy.

Always confirm the active `mode` in the run's opening summary. Use `dry-run` for
first contact with a new project and for all skill-eval runs, so testing never
mutates real Linear or ships real code.

**Mid-run overrides.** If the user explicitly asks for live behavior while config
says `dry-run` (e.g. "actually move the ticket", "merge and deploy"), treat it as
an explicit, session-scoped override — honor it, and offer to persist `mode:
"live"` to `dev-loop.json` so a recurring/looped run stays consistent. Because
crossing from `dry-run` to `live` unlocks irreversible, outward-facing actions
(commits to `defaultBranch`, pushes, and especially a **production deploy** that
may then run on every loop tick), confirm the blast radius **once** before the
first such action — then proceed hands-off per the autonomy the user granted.
Don't re-confirm every ticket once authorized.

Orthogonal to `mode`, each project has an optional `autonomy`:
- **`"ask"` (default when absent)** — the conservative posture this doc otherwise
  describes: escalate genuinely human-only calls to the user (§9) and surface
  open product-direction decisions in the run report.
- **`"full"`** — the user has granted standing authority to **decide and act, not
  ask**. Resolve product-direction, scoping, and prioritization calls yourself,
  grounded in the `strategyDoc`; file/build the work rather than parking it. Do
  **not** end runs with "standing items for you to approve" or "want me to…?"
  prompts.

`autonomy:"full"` changes *who decides*, never *how carefully*. Caution is the
**method**, not a reason to defer:
- Verify against the running product; prefer **safe, reversible, additive,
  idempotent** changes; never ship on a red build/test gate.
- For an irreversible prod op (the migration/backfill class), do it **attended,
  with pre- and post-verification and the records-only/safe command form** (§9) —
  yourself, not by escalating.
- The only things that still stop you are **missing external inputs, not missing
  courage**: real third-party credentials/contracts, spending money, legal
  sign-off, or a capability you lack this run (e.g. driving a real browser over
  third-party sites). Report those as *blocked on an external prerequisite* — a
  fact, not a request for permission — and proceed with everything else.

This setting tunes §9's escalation rule and the PM/QA "surface it to the user"
guidance; under `"full"`, escalate only the genuine external-prerequisite cases
above.
