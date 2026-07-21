# Conventions progressive disclosure — kernel, tripwires, and pay-per-use references

Status: rev 1, designed 2026-07-19. Implements the first structural pass of the token-cost
program (see `docs/STRATEGY.md` §Cost). Companion to the measurement precursor (per-fire
token metering), which lands separately.

## 1. Problem

`references/conventions.md` is 208,678 B / 2,983 L / 39 anchors — over its own
`CONVENTIONS_WARN_BYTES` (200 KiB) threshold. Under the §0a selective-boot rule the
per-fire cost of conventions is the **union of an agent's cited §-spans**, and that union
is 79–83 % of every fire's context bill:

| agent | cited § | conventions union | fire total | ~tokens |
|---|---|---|---|---|
| pm-agent | 28 | 173,048 B | 218,596 B | 54.6 k |
| junior-dev | 24 | 166,470 B | 205,921 B | 51.5 k |
| dev | 24 | 163,059 B | 208,657 B | 52.2 k |
| qa | 24 | 160,096 B | 199,130 B | 49.8 k |
| ops | 21 | 151,570 B | 190,978 B | 47.7 k |
| communication | 15 | 96,448 B | 134,020 B | 33.5 k |

A 2026-07 full inventory (39 anchors, per-section composition) found the file ~85 %
genuinely normative; the removable ~17 % is concentrated in provenance notes, duplicated
restatements, inlined opt-in specs, verbatim templates, and over-broad citations.

## 2. Principles (what this design does and does not change)

1. **The protocol stays single-copy.** conventions.md is the coordination contract
   between agents that never talk to each other; a rule duplicated per-SKILL is a
   protocol fork waiting to strand tickets. No rule is copied into SKILL files.
2. **File-level splitting is a non-goal.** Per-fire cost is the cited-span union — the
   same bytes in ten files cost exactly the same and break `parseConventions`, the
   `Sections:` grammar, and every cross-reference. The file stays one file.
3. **Preload carries invariants; references carry known-unknowns.** A prohibition you
   never loaded cannot tell you to go read it, so prohibitions/state-machine/label
   semantics stay in cited spans. Templates, wire formats, per-backend implementation
   detail, and rare-path procedures move to `references/*.md`, each behind a
   **tripwire**: a 1–3 line stub under the *unchanged* heading stating what moved,
   where, and **when it must be read**. The interception stays resident; the payload
   becomes pay-per-use.
4. **Expected saving = span bytes × P(path not hit).** Extraction is only worth it for
   content that most fires never execute (notify payloads, investigation procedure,
   opt-in sinks) or that is config-partitioned (backend implementations — every fire
   runs exactly one backend, known at boot step 2).
5. **This is the same discipline SKILL bodies already obey** (`BUDGETS` in
   `hub/src/context-bill.ts`, enforced by `hub/test/context-budget.ts`). conventions.md
   is the one corpus that escaped it; this design brings it under.

## 3. The four operations

### A. Citation pruning (SKILL `Sections:` edits only)

| skill | change | per-fire delta |
|---|---|---|
| add-project | drop §21a (used only to name the `sensitive` label — reword prose) | −15,906 B (−28.7 %) |
| ops-agent | drop §5, keep child §5a (Urgent=rank-1 restated without a § cite) | −1,6 kB |
| dev, junior-dev, senior-dev, pm | **add §16 Security doctrine** (+ a prose sentence citing it) | +1,443 B each — a correctness fix, not a saving: no code-committing agent loads the no-secrets/no-PII/least-scope doctrine today, though §16 addresses Dev by name; qa already cites it |

### B. Granularity anchors (new lettered anchors, zero renumbering)

- **§20a** — number the existing `### Where it lives — the strategyDoc form-detection
  rule` child as `### 20a.`. `## 20` parents absorb ### children, so current §20 citers
  are untouched; **dev-agent** and **communication-agent** switch §20 → §20a
  (−~5.1 kB each — they only ever detect the strategyDoc's form).
- **§21b** — promote the existing `### Routing — the filer assigns the dev tier` block
  out of §21a as a sibling `## 21b. Tier routing…`. Filers that never design get the
  30-line routing rule without the 15.9 kB design-and-delegate spec:
  **ops, architect** switch §21a → §21b (−~13.9 kB each); **qa, pm and sweep cite both**
  (as built, qa KEEPS §21a — its Job A runs the §21a escalation flow)
  (pm gates designs; sweep repairs tier labels); dev tiers keep §21a (their flow), which
  retains a one-line pointer to §21b so the internal narrative still reads.

### C. Content extraction (payload → `references/`, tripwire stub stays)

| span | moves | new home | stays behind (the tripwire) |
|---|---|---|---|
| §18 local-backend implementation (`Local board layout` → `Firewall in local mode`) | ~8 kB | `references/backend-local.md` | §18 keeps: intro, work/surface-plane parity contract, `park-for-operator`, switching rules, and the boot tripwire: *"after resolving `backend` (boot step 2), read `references/backend-<backend>.md` before your first board operation"* |
| §18 `The service backend` subsection | ~12 kB | `references/backend-service.md` | same tripwire |
| §9 notify payload/HMAC/transport matrix | ~4 kB | `references/notify.md` | 3-line rule: parking for a human with `notify` configured ⇒ read the reference and send |
| §9a 7-step investigation procedure | ~2 kB | `references/investigation-protocol.md` | the W3 intake rules stay; stub: an `investigation`-labelled ticket ⇒ read the reference |
| §23 Linear report sink (whole spec) | ~8.4 kB | `references/reports-linear-sink.md` | ~0.9 kB stub: default-off, sink/backend decoupling, tripwire: `reports.sink:"linear"` configured ⇒ read the reference |
| §6 the two verbatim ticket templates | ~0.9 kB | `references/ticket-templates.md` | the repo-label-is-authoritative rule + "copy the template from the reference when filing" |
| §24 image-generation mechanics | ~1.1 kB | already in `references/codex-integration.md` — delete the duplication, keep the contract + pointer | opt-in gate, advisory-never-authoritative stay |
| §13 first-run setup checklist | ~1.9 kB | `references/first-run-setup.md` | 2-line stub (zero skills cite §13 — file-size hygiene only) |
| §21a `Hub / config / launcher` wiring | ~1.8 kB | pointer to `docs/design/senior-junior-dev-split.md` + `references/config-schema.md` (already cited there) | the behavioural rules |

### D. Duplication + always-read compression

- §17 operator-review carve-out paragraph → 2-line pointer to §22's canonical
  `### The §17 carve-out` (every §17 citer also cites §22; −~1.1 kB × 4).
- §1: keep the two unique rules (hand-off only through ticket state; filer/owner =
  verifier), drop the ASCII diagram + the third per-agent roster restatement (−~2.5 kB,
  file-size only — §1 has zero citers).
- Topology: merge the missions table and the owns/picks table into one (−~1.5 kB from
  **always-read**, so ×15 skills).
- ToC: drop the derivable `(#anchor)` link fragments (−~1.5 kB from always-read, ×15).
- §12c: drop the `How it fits together` operator diagram + the rule restatement
  (−~1.2 kB × 7 citers).
- §25: tombstone → 3 lines (−~0.7 kB).

## 4. Stub format (normative for this and future extractions)

The heading NEVER changes (anchors are load-bearing: SKILL cites, sweep D-audits,
ticket comments, lessons entries). Directly under it:

```
> Moved: <what> now lives in `references/<file>.md`. Read it <trigger — when exactly>.
<the 1–3 rules that must stay resident, if any>
```

`§0a` step 1 gains one sentence making the pattern normative: a cited section may end in
a pointer stub; the referenced file is part of the section's contract and MUST be read at
the stub's stated trigger moment (same standing as the existing mid-fire uncited-read
escape hatch, minus the report flag — stub reads are cited, not gaps).

## 5. Tooling impact

- `parseConventions` already accepts `\d+[a-z]?` anchors at `##`/`###` — §20a/§21b need
  **no parser change**. Fence-awareness already skips the templates being moved.
- `hub/test/context-budget.ts` gains regression assertions: anchors `20a`/`21b` exist;
  each stub's `references/<file>.md` exists and is non-empty; the four dev/pm Sections
  lines include §16.
- `CONVENTIONS_WARN_BYTES` unchanged — the file lands back under it.
- The set-equality lint forces every `Sections:` edit to be mirrored in SKILL prose
  (§ mentions ↔ line); this is the drift guard for operations A/B.
- Follow-up (not this pass): print a `references/*.md` pay-per-use ledger in
  `metrics --context`; per-agent union warn thresholds once the metering precursor
  lands.

## 6. Expected result

File: 208,678 B → ~168–175 kB (under the warn threshold).
Per-fire conventions unions (±, verified by `metrics --context` after implementation):

| agent | today | after | mechanism |
|---|---|---|---|
| pm | 173.0 k | ~152 k | extractions (§18svc keeps its backend file JIT-read, §9, §6, §21a-wiring) + always-read trims; +§16 |
| dev | 163.1 k | ~138 k | §20→§20a, extractions, +§16 |
| junior-dev | 166.5 k | ~142 k | same |
| qa | 160.1 k | ~132 k | §21a→§21b, extractions |
| ops | 151.6 k | ~122 k | §21a→§21b, −§5, extractions |
| architect | 127.7 k | ~103 k | §21a→§21b, extractions |
| communication | 96.4 k | ~78 k | §20→§20a, §23 stub |
| add-project | 55.3 k | ~39 k | −§21a |

JIT reads added per fire: exactly one `backend-<backend>.md` for board-op agents
(~9–12 kB on `service` — net §18 saving is real but honest: ~7.5 kB on service,
~20 kB on linear projects); everything else is rare-path (P(hit) ≪ 50 %).

Trajectory note (phase 2, separate design): compressing §3/§4/§5/§7 editorially and
enforcing a per-agent union budget in context-bill targets a 10–20 k-token boot
(~40–80 kB) for the heaviest agents. This pass gets pm from 54.6 k → ~47 k fire-total
tokens; phase 2 plus SKILL-prose diets close the rest.

## 7. Rollout & verification

1. Implement in the A → B → C → D order above (each step leaves the lint green).
2. `npm run context-budget` + full hub test suite after each step; `dev-loop metrics
   --context` before/after is the acceptance metric.
3. Grep-sweep: every `§13/§23/§21a/§20` cross-reference inside conventions.md, SKILLs,
   and hub/docs re-checked against the moved content (anchors unchanged ⇒ links keep
   resolving; prose that quoted moved detail now points at the reference).
4. Soak on one project before release; watch QA-escape ratio and blocked-rate in
   `dev-loop metrics` for a week — the failure signature of an over-aggressive
   extraction is agents guessing instead of reading a tripwired reference (§0a flags
   uncited reads; stub reads are silent, so the KPI watch is the guard).
