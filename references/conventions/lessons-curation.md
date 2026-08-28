# Lessons file — bounding and curation — conventions §14 pointer file

> Moved out of `references/conventions.md` §14 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §14's contract: read it at the trigger moment the §14 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

**Local vs durable.** `lessons.md` is **local per-operator** machine state — never
committed, never shared. Patterns that should hold for *every* operator of this
plugin go in this conventions file; product-direction that should hold for every PM
run goes in the `strategyDoc`. `lessons.md` is the fast, private override layer.

**Keep it bounded — `lessons.md` is a working set, not an archive.** It's read by
every agent on **every** fire, so its size is a running tax on the whole loop; an
ever-growing rule list also means agents start silently ignoring rules. Hold it to a
budget with two **outflow** valves, so inflow never wins:

- **Budget (a forcing function, not a suggestion).** Target **≤ ~6 rules per agent
  section** and **≤ ~150 lines total** (a sane default; tune per product). When a
  section is at budget you may **not** add a rule without first removing one —
  expire, merge, supersede, or promote.
- **Date every rule** — `added: <date>` and `last-seen: <date>` (the most recent date
  its pattern recurred), so staleness is *measured*, not guessed.
- **Two ways a rule leaves:**
  - **Promote** — a rule that has proven durable and should hold for *every* operator
    graduates **out**: draft a §17 proposal to fold it into this `conventions.md` (or
    the `strategyDoc` for product direction); once the human applies it, **delete it
    from `lessons.md`** — the core then carries it.
  - **Expire** — a rule exists to fix a *recurring* pattern; if that pattern hasn't
    recurred for **~2 weeks** (`last-seen` gone stale), the fix held or the code moved
    past it → **prune it**.
- **Consolidate.** Merge near-duplicate rules on one theme into a single general rule;
  never restate a rule that already lives in conventions (redundant → prune).

The healthy steady state is a **small, churning** set of recent, evidence-backed
corrections — durable wisdom keeps graduating to conventions, stale patches keep
expiring, and the file stays roughly flat in size however long the loop runs.

**1.0: the team lessons LIBRARY is the home** — `<workspace>/.dev-loop/lessons/` with a
curated `INDEX.md` (loaded every fire, hard budget), per-project shards (`<project>.md`,
loaded by that project's delivery fires), and a cold `archive.md` (§5.1 of the design;
reflect is the sole writer; doctor warns W03 over budget). This section's rules about WHO
writes and HOW rules apply are unchanged. Each skill reads the team lessons library at the very top of every fire
(right after conventions + config) and applies any rule under its section that fire.

**Reflect is the curator of this file.** Every other agent only *reads* its own
section; the Reflect agent (§17) also *writes* it — adding/superseding/pruning
evidence-cited rules from recurring patterns it observes across runs. Reflect may edit
`lessons.md` autonomously because it is reversible, per-operator, and never committed;
it must NOT auto-edit this conventions file or the SKILLs (it drafts those as
proposals — §17).

One narrow, operator-initiated exception (§22): **any** agent MAY add a rule **under its
own section** when it is distilling an explicit operator **review (点评)** of its own report.
The written review is the human authorization §17 requires. It is still bounded by the
budget below, still its own section only (`## Shared` stays Reflect-only), and a structural
ask is still a §17 proposal — not a self-edit. Because multiple agents may now write this
file, every `lessons.md` edit is a **locked read-modify-write** (§22). Reflect remains the
autonomous curator and the only agent that may touch other agents' sections or `## Shared`.

Each entry is a short rule with a one-line **Why** and **How to apply**. A rule may
pre-empt an action: *if a rule would have skipped or changed work you were about to
do, honor it.* Keep it lean (supersede stale rules, don't accumulate) — a wrong
rule is worse than none.

(Backend-agnostic: `lessons.md` is unaffected by the §18 backend dial — it is
per-operator runtime state regardless of the configured backend.)
