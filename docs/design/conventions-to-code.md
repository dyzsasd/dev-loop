# Conventions-to-code — rules enforced by tools, not recited by agents

Status: rev 1, 2026-07-19. Phase 0 (boot-prefix) + the first verb (`queue`) land with this
doc. Successor to `conventions-progressive-disclosure.md` (which cut WHAT agents read);
this migration cuts WHY they read it: **a rule the tool layer enforces can be deleted from
agent context entirely — prose is the weaker mechanism** (an agent can ignore a paragraph;
it cannot ignore a 403).

## 1. The three buckets

Every conventions rule falls in exactly one:

**A. Enforceable → becomes code, prose deleted.** Mechanics whose violation the CLI / hub /
runner can refuse or whose composition it can own: query scoping + pick ranking (→ the
`queue` op), label-set composition (`create --type` owns the full set — the §10 REPLACE
hazard stops existing), state-transition legality (hub CHECKed enum + the DL-77 verify
gate, service), `sensitive ⇒ senior` routing (a `save_issue` write guard), dry-run
(hub write-refusal + the runner withholding push/deploy secrets — Q9 machinery reused),
claim atomicity + worktree (runner pre-creates, fire lands in it), notify (daemon-emitted
on service today), template scaffolding (`create --template`), bail-shape mechanics
(`ticket block --shape` composing labels + comment format).

**B. Judgment → stays in context, small.** What tools cannot decide: the verify standard
(MISSING / EXTRA / MISUNDERSTANDING), block-vs-guess, duplicate judgment, verify-fail ⇒
close + follow-up semantics, §16 security doctrine, §12a autonomy, lessons. Target
residue: ~10–15 KB.

**C. Linear-backend residue → per-backend injection.** The Linear MCP is a raw surface
with no server-side guards — its discipline prose is the linear backend's inherent cost,
carried by `references/backend-linear-discipline.md` (future), not by every backend.
Unattended loops should run `service` (ARCHITECTURE.md rails table) — where bucket A
enforcement exists.

End state (service backend): header ~0.3 KB + task-shaped SKILL 6–8 KB + bucket-B residue
10–12 KB + lessons ≈ **20–25 KB ≈ 5–6 k tokens** per fire.

## 2. Landed in this revision

### Phase 0 — the runner-assembled boot prefix (`--assemble-boot`)

`hub/src/boot-prefix.ts` + `run-agents.ts`: the scheduler appends a **byte-deterministic**
corpus block to each claude fire's prompt — conventions union (the same span math as
`context-bill.ts`, one authority), the §14 lessons slice, the §18 backend contract —
wrapped in `<!-- devloop-boot:begin agent=<a> hash=<h> -->` markers. §0a step 1 defines
the contract: a marker block IS boot steps 1/3(read)/4 — the fire does not re-read those
files. Why it matters beyond tokens: today's selective reading is honor-system and
interleaved with model output (unstable prefix ⇒ ~zero prompt-cache hits across fires);
the assembled block is deterministic (cacheable when fire interval ≤ the cache TTL) and
removes the did-the-agent-actually-read-it reliability hole. The prompt rides **stdin**
(`claude -p` piped form): Linux `MAX_ARG_STRLEN` caps one execve arg at 128 KiB — an
assembled prompt exceeds it as an argv. Opt-in: `--assemble-boot` / `DEVLOOP_ASSEMBLE_BOOT=1`,
claude lane only; assembly failure fails OPEN to classic pull mode. `bootBytes` rides the
fire ledger + `fire.completed` event. Tests: `hub/test/boot-prefix.ts` (determinism, bill
consistency to the byte, lessons slicing, backend selection, fail-open).

### First verb — `queue` (the §5/§21b pick semantics in code)

New op (26th tool; all three transports — MCP tool, `/api/op/queue`, `dev-loop op queue`
— via the one `agentOp` dispatch): per-actor work lists, pre-filtered + pre-ranked
server-side. dev/senior-dev/junior-dev → `{ inProgress, todo }` — the caller's slice ONLY
(§21b assignee encoding), `blocked` excluded, ranked urgent-bug → urgent-feature →
edge-case-bug → bug → feature → improvement, FIFO within rank (§5 exactly, incl. rank
3.5). pm → `{ verify, unblock, backlog, todoDepth }` (todoDepth per-tier — the §5a cap
input). qa → `{ verify, blocked }`. Summaries only. Read-op (not in `AGENT_WRITE_OPS`).
Tests: `hub/test/queue.ts` (ranking exactness, slice isolation, blocked exclusion,
terminal exclusion, refusals).

## 3. Migration path (each ticket = one verb/guard + the prose it deletes)

| order | build | then delete from agent context |
|---|---|---|
| ✅ 0 | boot-prefix | (nothing — the delivery mechanism) |
| ✅ 1 | `queue` op — **ADOPTED**: `dev-loop queue` sugar verb + cheat-sheet wiring (5 agents, regenerated) + SKILL pick/scan steps are queue-first on `service` with the self-composed query as the `linear`/`local` fallback | §5 is now config-pruned from assembled service fires (`CONDITIONAL_SECTIONS["5"]` — the op pre-ranks; linear keeps the prose); §10 stays pending its query/write-hazard anchor split |
| 2 | dry-run enforcement: hub refuses `AGENT_WRITE_OPS` when the resolved mode is dry-run; runner withholds push/deploy secrets on dry-run fires | §12's mechanical half |
| 3 | `ticket block --shape <bail-shape>` (labels + `Bail-shape:` comment composed internally) | §9's mechanics; the shape taxonomy judgment stays |
| 4 | `ticket create --template bug\|feature --tier auto` (full label set + template + §21b routing incl. the sensitive⇒senior guard server-side) | §4 composition rules, §6 residue, §21b's mechanical half |
| 5 | runner pre-created worktrees (fire cwd = the ticket worktree) | §7's mechanics |
| 6 | SKILL rewrites to task-shape (job = verb + judgment criteria) | the SKILL prose that narrates design |

Rules for every step: the verb ships with tests + cheat-sheet regeneration BEFORE its
prose is deleted; deletions follow the progressive-disclosure guardrails (anchors stable,
stubs where a § must survive for linear); `metrics --context` before/after is the
acceptance metric; one-project soak between steps.

## 3b. Captured-context review (2026-07-20) — the six findings and their disposition

A byte-level review of a captured junior-dev fire (156 KB) landed six recommendations:

1. **Finer anchors** → **SHIPPED (first cut)**: `## 21c` (the split gate + junior-dev
   execution, promoted sibling — the ###-child grammar derives parents from the bare
   number, so 21c cannot nest under 21a): dev + junior cite §21c instead of §21a
   (−7.4 KB/fire each); senior cites both. §9/§18/§22 finer cuts remain queued.
2. **Configuration-aware selection** → **SHIPPED** (`CONDITIONAL_SECTIONS` in
   boot-prefix.ts): the `Sections:` line stays the static pull-mode SUPERSET; the
   assembler subsets per project config — §12c (no auto-merge/release-pr), §12d (no
   deploy), §19 (single-repo), §24 (codex off) never ship when off. Gap markers
   distinguish "uncited" from "declared but OFF in this project's config". Measured on a
   featureless service project: dev tiers −21 KB/fire, pm −13 KB/fire.
3. **Rare paths behind tripwires** → roll-up mechanics SHIPPED
   (`references/report-rollups.md`; the due-check stays resident in §22). Orphan
   recovery lives in the SKILLs (delta pass), §8 is already minimal (1.4 KB), §9c/W5
   deferred (heavily cross-referenced; smallest prize).
4. **Assembler-included ship sequence** → **SHIPPED**: `<!-- ship-sequence:begin/end -->`
   markers around dev's Steps 4–6.5 + 7 + HARD LIMITS; the assembler appends the slice to
   split-tier corpora (the ~21 KB mid-fire pull the review caught as an undercount is
   gone; pull mode keeps the read instruction). Full SKILL-delta prose trim remains
   queued.
5. **Cheat sheet ∪ backend contract consolidation** → deferred: the cheat block is
   already generated + role-scoped; the `queue`-verb adoption will reshape it anyway —
   revisit after step 1 of the ladder.
6. **Effective-span accounting** → **SHIPPED**: the corpus header counts distinct
   shipped spans, not lint-forced parent+child declarations (pm: "23 spans of your 30
   declared").

Also applied 2026-07-20 (operator direction): the **snapshot doctrine** — agent context
describes the CURRENT system, never its history. Decision-provenance citations (DL-n,
P-n-n, dated reviews) stripped; change-relative framings ("100% unchanged", "was
removed", back-compat narratives) rewritten present-tense; §25 is now a pure
present-tense direction-intake note. Live policy IDs that name current rules (D1 override
matrix, D4 write policy, D6 retention) stay — they are identifiers, not history.

Review's standing correction, adopted as doctrine: prompt caching fixes cost and
latency, NOT context-window use or attention dilution — selection and surgery do.
Target restated for junior-dev: 10–15 KB role kernel + 25–45 KB always-needed
conventions + 5–15 KB config-selected material ⇒ **10–18 k tokens** normal startup.

## 4. What this deliberately does not do

- No board-schema changes; `queue` is a pure read composition.
- No agent-roster changes (the PM/QA split stays rejected — 2026-07 analysis).
- Bucket B is never squeezed to zero: the QA-escape/lessons record shows the loop's real
  failures are judgment failures; deleting judgment prose to save bytes re-buys them.
