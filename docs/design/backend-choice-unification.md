# Backend-choice unification — Linear vs local `service` daemon (2026-06-24)

> The design for the operator ask: pick the ticket backend (Linear / local file board / `service` hub)
> at `init`, with a UNIFIED workflow. Produced via a Workflow (1 design + 2 adversarial critics —
> both **needs-changes**, all mustFix/parityLeaks folded). Decisions (operator, 2026-06-24): **(1)**
> choose-at-init only — cross-store ticket migration DEFERRED; **(2)** the notification gap closed in
> the DL-52 workstream (widen, not a parallel epic). U-numbering below is provisional — PM assigns the
> real DL-ids on grooming. Verified facts cite file:line.

---

This settles all the disputed claims decisively. Critical findings confirmed:

1. **conventions.md:205-207** — `Human-Blocked` IS a legal value in the unified `save_issue`'s `state` field list, but **line 221** marks it explicitly **`(service only)`**, and **line 243** says on `linear`/`local` "the label-based park (§9) remains." So `Human-Blocked` is NOT in the local frontmatter-usable set — confirming critique #1's risk: on local, `blockedStateName` cannot resolve to `Human-Blocked`; the abstraction collapses to label-only there.

2. **§9 notify webhook** (conventions.md:491-547) is owned by **PM** (`The owner is PM`), reads URL "only from the resolved project's `notify` config." The daemon notifier (`blockedNotifyTick`/`getEnabledChannel`) reads the **`channels` table** (bot registrations), a *completely separate config block* from `notify`. They never meet today. Confirmed.

3. **DL-52's groomed scope** (STRATEGY.md:392) = "webhook transport for channels/sendVia + the DL-26 blockedNotifyTick notifier." It does NOT mention (a) teaching the daemon to read the §9 `notify` webhook block, nor (b) reconciling pm-agent:249's "you don't emit notify yourself on service" branch. So both critiques' core mustFix stand.

I have everything I need. Producing the final design.

---

# dev-loop: Unified Backend Choice at `init` — FINAL Design + Ticket Plan

All claims re-verified against `/Users/shuai/workspace/dev-loop` at the cited `file:line`. This folds in both adversarial critiques. Every **mustFix** and **parityLeak** is resolved inline and flagged where it changed the design.

---

## 0. What changed from the draft (critique resolutions, up front)

| Critique item | Resolution in this final |
|---|---|
| **C1-mustFix-1**: notification root-cause misframed — it's a *3-layer* leak (SKILL branch + daemon ignores `notify` + missing `transport` column), not a pure data-layer fix | **Adopted.** §1 matrix row and §4.2 rewritten: the leak is named at all three layers. DL-52's groomed scope is shown to be **insufficient**; a new ticket **U0** (extend/augment DL-52) is added to close the SKILL-branch + daemon-reads-`notify` halves. Verified against `pm-agent/SKILL.md:245-251`, `daemon.ts:885/928/933`, `channel.ts:18-19`. |
| **C1-mustFix-2**: U3 `daemon up` overlaps the shipped DL-42 SessionStart hook | **Adopted.** §3 + U4 now state init's `daemon up` is a **one-time same-session bootstrap convenience**, explicitly NOT a parallel lifecycle owner; the hook remains the steady-state owner. |
| **C1-parityLeak (matrix + §2)**: "notification-behavior" wrongly listed in the "guaranteed-identical contract" | **Adopted.** §2 removes notification-behavior from the identical contract; it is now an explicitly **in-flight / not-yet-identical** row until U0+DL-52+DL-53 land. |
| **C1-risk (local park collapses to label-only)**: hard-state it | **Adopted.** §4.1 now **hard-states** `Human-Blocked` is service-only (conventions.md:221) and on `local` the park is **label-only, full stop** (no `blockedStateName`→`Human-Blocked` path; `Human-Blocked` is not a local-usable frontmatter state). |
| **C2-mustFix-1**: U1/U2 collide with DL-53 (both edit `conventions.md` + `skills/init/SKILL.md`) | **Adopted.** U1/U2 are **no longer separate proposals**. They are **folded into DL-53** (extend its open proposal) — see §6. The §7 "re-read DL-53 first" flag is promoted to a **hard precondition**. |
| **C2-mustFix-2**: dogfood schema-migration on the live shared `hub.db` (+ co-resident SC project) unaddressed | **Adopted.** §6 gains a **dogfood-migration-safety** clause binding on any DB-schema ticket (incl. DL-52's `transport` column and U0). |
| **C2-mustFix-3**: migration scope understates *id-fidelity* loss (global PK from `ticket_seq`, prefix-clash hard-throw) | **Adopted.** §5 now states plainly: cross-store import **cannot preserve source ids as the PK** — they reassign to `<PREFIX>-N`; source ids must ride as a separate `externalId`. Verified `seed.ts:46-47`, `db.ts:64,286-292`. |
| **C2-parityLeak (seed.ts idempotency already guaranteed)** | **Adopted.** §7 unknown removed; U-tickets now *assert* (don't re-discover) `ensureProject` idempotency-on-key + prefix-clash throw. |

---

## 1. Corrected parity matrix

Legend: ✅ identical · ⚠️ per-backend realization (same abstract behavior) · ➕ honest superset (parity impossible/undesirable) · 🔧 **in-flight fix** (not identical *today*; closes when the named tickets land).

| Dimension | linear | local | service | Verdict (corrected) |
|---|---|---|---|---|
| **Core ticket states** | ✅ | ✅ frontmatter `state:` (`conventions.md:211-213`) | ✅ CHECKed enum (`db.ts:69`) | **Identical legal set.** `Human-Blocked` is in the unified `save_issue` `state` list (`conventions.md:205-207`) but is **`service`-only** (`conventions.md:221`); service CHECK *upgrades* safety (typo → error). |
| **Transition rules / verify-fail close+follow-up** | ✅ | ✅ | ✅ | **Identical** — `conventions.md:215-234`, backend-agnostic. |
| **Agent loop / pick (§5) / claim (§7) / dedupe (§8)** | ✅ | ✅ (`O_EXCL` file lock) | ✅ (SQLite txn id alloc, `db.ts:286-292`) | **Identical** abstract behavior; concurrency primitive differs (impl, not workflow). |
| **§9a human intake** | ✅ | ✅ | ✅ | **Identical** — append-only `relatedTo`; no `parentId` by design. |
| **Parking a ticket for the operator** | ⚠️ label park (`blocked`+`needs-pm`+`external-prereq`) | ⚠️ label park **only** | ⚠️ real **`Human-Blocked`** state (`db.ts:69`; `conventions.md:236-245`) | **⚠️ intentional (D3a/D3b locked).** Abstract behavior identical ("parked for human; resumes to Todo"). **HARD-STATED (corrected):** `Human-Blocked` is `service`-only (`conventions.md:221`, `:243`); on **local** the park is **label-only — `blockedStateName` cannot resolve to `Human-Blocked`** (not a local-usable frontmatter state). On **linear**, `blockedStateName` *may* promote it to a real Blocked column if the operator made one (`conventions.md:551`). Unify behind one abstract op (§4.1). |
| **Operator notification on a human-park** | ⚠️ §9 `notify` webhook, **PM emits**, **label-trigger** (`conventions.md:491-547`) | ⚠️ same §9 webhook, PM emits | ⚠️ DL-26 **daemon emits**, **state-trigger**, reads **`channels` (bot) only** — **NOT** the §9 `notify` block | **🔧 IN-FLIGHT, 3-LAYER LEAK (corrected — was understated as a 1-column data fix).** Verified leak layers: **(L1)** `pm-agent/SKILL.md:249` hardcodes "on `service` … you don't emit the one-shot `notify` yourself" → PM defers to the daemon; **(L2)** the daemon notifier `blockedNotifyTick`/`startBlockedNotifier` reads `getEnabledChannel` = `channels WHERE provider IN (slack,lark)` (`channel.ts:18-19`, `daemon.ts:890,933`) and **never reads the §9 `notify` webhook**; **(L3)** `channels` has **no `transport` column** (`db.ts:160-174`) and `sendVia` is bot-only (`channel.ts:80-102`). **Net defect:** a `service` project configured with **only** a §9 `notify` webhook (no registered bot `channel`) gets **no human-park alert** — `startBlockedNotifier` returns a **true no-op** (`daemon.ts:933`). **DL-52 (groomed, STRATEGY.md:392) fixes only L3** (+ wires the notifier to a `transport`-tagged *channel* row). It does **not** touch L1 or teach the daemon to read `notify` (L2). → **U0 closes L1+L2; DL-52 closes L3; DL-53 reframes the contract.** Identical *only after* U0+DL-52+DL-53. |
| **Identity / attribution** | ➕ inverse: one **shared** Linear user (`conventions.md` §9 note, "agents+operator share one Linear identity") | ⚠️ run-token-in-comments | ➕ real per-agent actor via `DEVLOOP_ACTOR` (`db.ts:83,93`) | **➕ genuine superset on service; genuine limit on linear** (shared identity is *why* a Linear @mention can't be the notify channel). Parity on who-did-what is **impossible on linear**. |
| **Strategy doc** | ⚠️ Linear doc or repo file | ⚠️ repo file only | ⚠️ repo file default; opt-in hub doc (`hub.docs:true`) | **⚠️ same role, different storage.** Hub docs add versioning/CAS — superset on an identical baseline. |
| **Discussion board + Director** | — | — | ➕ service-only (`conventions.md:1838-1840`; `db.ts:130-155`) | **➕ true superset.** Absent it, **PM owns strategy** (documented default, not a degraded mode). |
| **Two-way IM channel** | — | — | ➕ service-only `director.channel` (`conventions.md:1906`) | **➕ true superset.** Needs history-read creds + `channels`/`channel_messages` (`db.ts:176-191`). One-way `notify` is the cross-backend floor. |
| **One-way mirror (hub→Linear)** | n/a (Linear *is* SoR) | ❌ none | ➕ service-only `mirror` (P7, `db.ts:192-208`) | **➕ superset, projection-not-migration** (§5). Strictly one-way; never imports Linear state. |
| **Reports / operator review (§22/§23)** | ✅ files or `reports.sink:"linear"` | ✅ files | ✅ files or sink | **Identical** — `reports.sink` decoupled from §18 backend. |
| **Web UI / observability** | — (use the Linear app) | ❌ none | ➕ service-only board at `/` (+ `/roadmap` `/activity` `/reports`, `daemon.ts`) | **➕ superset on service; linear delegates to the Linear app; local is the genuine loser** (no cloud *and* no board). Strongest reason to steer a "no-cloud + want-a-UI" operator to **service over local**. |

### Brutal-honesty summary (corrected)
- **Identical (✅):** the entire core workflow — states, transitions, the agent loop, §9a intake, reports. The bulk of "the loop" is genuinely backend-agnostic.
- **One in-flight 3-layer leak (🔧):** operator-notification on a human-park. **Not** abstracted-away today and **not** fully owned by DL-52 alone — DL-52 closes only the transport column (L3). **U0 must close the SKILL-branch (L1) + daemon-reads-`notify` (L2).**
- **One reconcilable ⚠️ (park-for-operator):** unify behind one abstract op (§4.1), with the **hard-stated** truth that local is label-only.
- **Genuine supersets (➕):** per-agent identity, board+Director, two-way channel, hub docs, mirror, web board. These are *why* someone picks service.

---

## 2. The precise "unified" guarantee — where the line falls

**Guaranteed identical across all three backends (the contract):**

1. **The state set + legal transitions** — `Backlog → Todo → In Progress → In Review → Done`, plus `Canceled`/`Duplicate`, with the verify-fail close+follow-up rule (`conventions.md:202-234`). (`Human-Blocked` is in the *legal value list* but is a `service`-only realization of the park; the park *behavior* is the invariant, not the state name.)
2. **Who does what** — Dev claims/ships; PM/QA verify owner-labelled In-Review tickets; §5 pick order; §7 claim; §8 dedupe.
3. **The agent loop itself** — every SKILL's §0 "all ticket ops go through the configured backend (§18)"; the op-mapping table (`conventions.md:1025-1043`) makes `list_issues`/`get_issue`/`save_issue`/`save_comment` mean the same everywhere.
4. **§9a intake** + the §4 label taxonomy (even local carries `dev-loop` for parity).
5. **The abstract park-for-operator *behavior*** — "a human-only block parks the ticket out of Dev's pick set and resumes to Todo on resolution." (Mechanism differs; behavior is invariant.)

**⚠️ CORRECTED — NOT in the identical contract (was wrongly listed in the draft):**

- **Operator-notification behavior is NOT yet identical** and is explicitly **in-flight** (🔧). Today a `service`-webhook-only project gets no alert (the 3-layer leak). It becomes identical-in-behavior only after **U0 + DL-52 + DL-53** land. Until then it is a per-backend *divergence*, not a guarantee.

**Honest per-backend supersets (NOT promised identical, by design):**
- **Attribution fidelity** — real per-agent (service) · run-token (local) · *impossible* (linear, shared identity).
- **Direction plane** — discussion board + Director + roadmap-hub-doc + two-way channel are **service-only**; absent them **PM owns strategy** (the documented default).
- **Observability** — web board service-only · linear delegates to the Linear app · local has none.
- **Human visibility** — native (linear) · via one-way `mirror` (service) · intentionally host-local-invisible (local).

**State it plainly to the operator:** *100% identical is impossible — and not desirable.* The **ticket work plane** (states, transitions, agent loop, intake, park-*behavior*) **is** identical. The **collaboration/observability surface** (identity, board, channel, web UI, human-visibility) **and operator-notification** are deliberate per-backend supersets / an in-flight unification. **Unified on the work plane; intentionally divergent on the surface plane; notification is converging (U0+DL-52+DL-53).**

---

## 3. First-class `init` backend-SELECTION UX (final, with auto-wiring)

Today `backend` is one bullet in Step-1's field list (`skills/init/SKILL.md:162-178`); the service auto-wiring is **prose the operator runs by hand** (`SKILL.md:169-175`). Promote it.

### Step 0.5 (new) — CHOOSE YOUR TICKET SYSTEM (before field-gathering)

```
Where should this project's tickets live? (changeable later for a NEW project; migrating
EXISTING tickets across backends is a separate, manual, not-yet-supported step — see §5.)

  [1] Linear (cloud)        — Tickets in your Linear workspace.
        + Human-visible to your whole team in the Linear app (native UI).
        + Zero local infra; works from any machine.
        − One SHARED Linear identity for all agents (no per-agent attribution).
        − No local web board / discussion-board / Director / two-way IM channel.
        Needs: a Linear team + project (init provisions labels + the project).

  [2] Local daemon "service" — Tickets in a machine-local SQLite hub.
        + Per-AGENT identity + attribution (who did what is real).
        + Local web board (auto-started) + discussion board + Director + IM channel.
        + Zero-cloud (opt into the one-way Linear `mirror` for human visibility).
        − Local-only: invisible to anyone off this host unless you enable `mirror`.
        Needs: the hub (init installs + seeds it) + per-pane DEVLOOP_ACTOR (init wires .mcp.json).

  [3] Local file-board "local" — Tickets as markdown files on disk. Minimal no-cloud option.
        + Zero-cloud, zero-daemon, human-readable .md files.
        − No web UI, no board/Director/channel; run-token (not per-agent) attribution.
        − Human-park is LABEL-ONLY here (no Human-Blocked state, no daemon reminder).

Default: [1] Linear.  Recommendation: [2] service if you want no-cloud AND a UI/identity;
[3] local only if you specifically want plain files and not the daemon.
```

The existing `backend`-dependent control flow (`SKILL.md:190-197`, skip Steps 2–3 for non-linear) already routes correctly — the change is **surfacing + auto-wiring**, not new control flow.

### Auto-wiring the chosen backend (the turnkey half — the real gap)

| Chosen | init must AUTO-DO (today → proposed) |
|---|---|
| **linear** | Today already turnkey: auto-provisions labels (`SKILL.md:199-219`) + ask-then-create project (`SKILL.md:221-227`). **Keep.** |
| **service** | Today only *prints* the steps (`SKILL.md:169-175`). **Proposed: init runs them** — (a) `npm install` in the hub if `node_modules` absent; (b) `node hub/src/seed.ts <key> "<name>" <PREFIX>` to create the project row — **asserted idempotent on key + hard-throws on prefix clash** (`seed.ts:42-47`), so a re-run is a safe no-op and a clashing PREFIX fails loud (init must surface that as a "pick a unique prefix" error, not swallow it); (c) **merge** (never clobber) the `dev-loop-hub` server into the product repo's `.mcp.json` from `config/mcp.example.json`, env-NAME-only (§16) — see U2 AC; (d) `npm run doctor` → assert `DOCTOR_OK`; (e) **`node hub/src/server.ts daemon up`** as a **one-time same-session bootstrap** (reuses shipped DL-41 lifecycle) → confirm `/api/health` `{ok:true}` → report the board URL in Step 8. **CORRECTED (C1-mustFix-2):** init's `daemon up` is a *bootstrap convenience for the current session only* (before the next SessionStart fires); the **DL-42 `hooks/hooks.json` SessionStart hook is the steady-state lifecycle owner.** init must **verify the hook is present** and, if absent, tell the operator to re-sync/reinstall the plugin — it does **not** install a competing lifecycle path. |
| **local** | Today already turnkey: Step 7 scaffolds the board dir + `counter.json` (`SKILL.md:298-302`), refuses a non-empty board dir. **Keep.** |

**Net first-class change:** (1) a named "choose your ticket system" step with tradeoffs; (2) for **service**, init *performs* install/seed/`.mcp.json`-merge/`doctor`/one-shot-`daemon up`+health; (3) Step 8's readiness report gains a **Backend** line that learns **service** (board URL + actor wiring + `mirror` status) — today it only covers `linear`/`local` (`SKILL.md:380-381`).

---

## 4. Reconciliations — cheapest path to TRUE parity per ⚠️ / 🔧

### 4.1 Park-for-operator → one abstract op, three realizations (cheap, conventions-only)
Name a single **`park-for-operator(ticket, bail-shape)`** primitive in §18's op-mapping:
- **service** → move to the real **`Human-Blocked`** state (`db.ts:69`; `conventions.md:236-245`).
- **linear** → if `blockedStateName` is set (operator made a real Blocked column), move to *that* state; **else** the `blocked`+`needs-pm`+`external-prereq` label park.
- **local** → **label park ONLY. HARD-STATED (C1-risk corrected):** `Human-Blocked` is `service`-only (`conventions.md:221`, `:243`); the local frontmatter `state:` set does not admit it, so `blockedStateName` **cannot** resolve to `Human-Blocked` on local. The abstraction collapses to label-only here — by design, not omission.

Rule: **real-state-if-present-else-label**, with the explicit carve-out that "real-state" is *never available on local*. Cost: a few lines of conventions prose. No code. Keep the underlying divergence (locked D3a/D3b); only the *abstraction label* is unified.

### 4.2 Notification → the **3-layer** fix: U0 (L1+L2) + DL-52 (L3) + DL-53 (contract) — CORRECTED
**The draft's "DL-52 owns this, don't duplicate" was wrong.** DL-52 as groomed (STRATEGY.md:392) closes only **L3** (the `transport` column + wiring the *notifier* to a transport-tagged channel). It does **not** close:
- **L1** — `pm-agent/SKILL.md:249`'s "on `service` you don't emit `notify` yourself" branch. If PM stops emitting *and* the daemon can't reach the §9 `notify` webhook, a webhook-only service project is silent.
- **L2** — `blockedNotifyTick`/`startBlockedNotifier` read **`channels` (bot rows) only** (`channel.ts:18-19`, `daemon.ts:890,933`); they **never read the §9 `notify` block**.

**Canonical resolution (this design):**
- **U0 (new, Dev-buildable)** — teach the **daemon notifier to also resolve a §9 `notify` webhook** (read the project's `notify` config, build the same §16 allow-listed one-liner, POST via the webhook transport), AND reconcile the **L1 SKILL branch** so the contract is coherent: on `service`, the daemon is the single emitter for **both** transports (bot channel *or* `notify` webhook), so a webhook-only service project is covered. (The SKILL-branch reconciliation is the §17 prose half — folded into DL-53; U0 is the *code* half: daemon reads `notify`.)
- **DL-52** — the `transport` column on `channels` + webhook path in `sendVia` (default `'bot'` ⇒ existing channels byte-for-byte unchanged). **U0 depends on DL-52's `sendVia` webhook path** (reuse it; don't fork a second POST impl).
- **DL-53** — reframe §9/§25 as one operator-alert channel `{transport: webhook|bot}` (webhook = one-way default, any backend; state-trigger canonical on service, label-trigger on linear/local) **and** rewrite `pm-agent/SKILL.md:245-251` so L1 is coherent with U0 (the daemon owns emission on service for both transports). **Also lands the `init` channel-linking step** (closes the "init never wires notifications" half of DL-50).

After **U0 + DL-52 + DL-53**, "both paths fire the same `park-for-operator` notification" is **true on service-with-webhook-only** — which it is **not** today.

### 4.3 Strategy doc → already abstractly identical
Repo-file is the cross-backend floor (`conventions.md:977-978`); hub docs are an opt-in superset on service (`hub.docs:true`). No reconciliation; just ensure init makes the hub-doc offer for **greenfield service only** (never auto-migrate an existing repo-file `strategyDoc`).

### 4.4 Honest supersets — leave as supersets
Per-agent identity, board/Director, two-way channel, web UI, mirror: **do not attempt parity** (impossible on linear / undesirable to re-implement on Linear comments). Document as ➕ so the operator chooses with eyes open.

---

## 5. Switch-an-existing-project scope (init-choice now vs migration-later; the seam)

Two very different operations — keep them separate.

### A. Choose-at-init (easy — a config flag)
Setting `backend` on a **fresh** project is `init` writing one field (`config-schema.md:39`) + the §3 auto-wiring. Trivial and safe. **Ship now.**

### B. Migrate an EXISTING project's tickets across backends (a real data migration — defer)
Not a flag flip — it moves live rows/files between fundamentally different stores, with split-brain risk. **CORRECTED with the id-fidelity wall (C2-mustFix-3):**

- **Hub ticket ids are a GLOBAL `TEXT PRIMARY KEY`** (`db.ts:64`) minted from per-project `ticket_seq` + `ticket_prefix` (`db.ts:286-292`). `ensureProject` **hard-throws on a duplicate prefix** (`seed.ts:46-47`: *"ticket prefix already used … ticket ids are a global key"*). **Therefore a Linear→service import CANNOT preserve source ids (e.g. `CIT-345`) as the PK** — they are reassigned to `<PREFIX>-N`, breaking every external reference (PR links, comments, cross-ticket `relatedTo`). Source ids must ride as a separate **`externalId`** field, not the PK. **This is a data-FIDELITY loss, not merely orphaning** — and a further reason to defer.
- **The only existing cross-store seam is one-way: hub → Linear** (the P7 `mirror`, `db.ts:192-208`). It **never imports Linear state** (a human edit on a mirrored issue is overwritten next push). It is a **projection, not a migration path** — you cannot use it to move linear→service or promote a mirror into a real Linear backend.
- **No local↔Linear bridge and no Linear→hub importer exist** (`linear.ts` only *writes* Linear for the mirror).
- **Split-brain:** flipping `backend` while tickets exist re-points every scoped query at the new (empty) store; old tickets orphan, ids restart (`counter.json` vs `ticket_seq`).

**Recommendation — scope honestly:**
- **Ship now:** choose-at-init (§3) — satisfies "自由选择" for new projects (the common case).
- **Defer:** migrating an existing project's tickets. **Name the seam in `init` + §18:** *"`backend` is chosen at init; changing it on a project with existing tickets is a data migration, not a config edit, and is not yet supported. The only cross-store seam today is the one-way hub→Linear `mirror` (a projection). A future importer cannot preserve source ticket ids as the PK — they reassign to `<PREFIX>-N` and source ids must ride as a separate `externalId`."*
- **If the operator wants Linear visibility *without* migrating:** the answer is **service + `mirror`** (keep the hub as SoR, project to Linear), not a backend switch.
- **If migration is later prioritized:** its own epic — exporter/importer per direction, an `externalId` carry + id-remap table, a "freeze → bulk-import → verify counts → cut over" runbook. The `mirror_map` content-hash + `[hub:id]` marker (`db.ts:192-208`) is the nearest prior art for idempotent cross-store id mapping, but a true two-way importer must *break* the deliberate one-way invariant — a §16/§17-weighty change, not a quick win.

---

## 6. TICKET PLAN (ordered by dependency)

**Dependency spine:** DL-52 (transport column, in queue) → **U0** (daemon reads `notify` + reuses `sendVia` webhook) → **DL-53** (contract reframe + SKILL L1 rewrite + init channel-linking step) → **U1** (init service auto-wiring CODE) → **U2** (init `.mcp.json` merge CODE) → **U3** (Step-0.5 + Step-8 SKILL, folded into DL-53) → **U4** (optional doctor reconcile).

**⚠️ Two cross-cutting clauses bind every ticket below:**

- **(DOGFOOD-MIGRATION-SAFETY — C2-mustFix-2):** Any DB-schema change (DL-52's `transport` column, anything U0 adds) runs against the **live shared `~/.dev-loop/hub.db`** that the running dev-loop (`backend:"service"`, prefix `DL`) **and** a co-resident `SC` project both write. So each schema ticket MUST: (a) prefer **additive, no-CHECK-rebuild** changes (a new nullable column with a DEFAULT needs no table rebuild — unlike the DL-25 `Human-Blocked` `DROP+RENAME`, `db.ts:212-255`); (b) go through the **`user_version` migration ladder** in `openDb` (`db.ts:211-275`), never an ad-hoc `ALTER`; (c) be applied with the loop **quiesced** if any rebuild is unavoidable; (d) account for the **co-resident `SC` project** sharing `hub.db`. Add this as an AC on DL-52 and U0.
- **(§17 OPERATOR-APPLIED + DEDUP — C2-mustFix-1):** Edits to `conventions.md` / any `SKILL.md` are **operator git-commit** (no agent self-edits — `conventions.md:904-916` bars *every* agent). **U1/U2-prose and U3 are folded into DL-53** to avoid two operator-applied commits colliding on `skills/init/SKILL.md` + §9.

---

### 1. **U0 — Daemon human-park notifier also fires the §9 `notify` webhook (close L1+L2 of the notification leak)**
- **Type:** Feature
- **Applied by:** Dev-buildable (CODE)
- **Backend scope:** `service` (the daemon notifier path)
- **dependsOn:** **DL-52** (reuse its `transport`-aware `sendVia` webhook path — do not fork a second POST impl); coordinates with **DL-53** for the L1 SKILL-prose half
- **Acceptance criteria:**
  - `blockedNotifyTick`/`startBlockedNotifier` (`daemon.ts:885,928,933`) resolve **a §9 `notify` webhook from the project config** in addition to `getEnabledChannel` (bot `channels`); a `service` project with **only** a `notify` webhook (no registered bot channel) now receives the Human-Blocked reminder (today `startBlockedNotifier` returns a true no-op when no bot channel exists — `daemon.ts:933`). The §16 one-line message is built from the **same closed allow-list** as §9 (project, id, bail-shape, ≤80-char title, URL); env-name-only creds; dry-run prints `[dry-run] would notify …` and makes no POST.
  - The emitter is reused from **DL-52's `sendVia` webhook transport** (one POST implementation, not two); `notified`-equivalent idempotency so a daemon reminder does not double-fire within a cadence window.
  - Honors **DOGFOOD-MIGRATION-SAFETY**: any new column is additive/nullable via the `user_version` ladder; `npm test` green including a new test asserting "webhook-only service project → human-park fires the webhook" and "bot-only → unchanged."
  - **Note in the ticket body:** the matching §17 prose half — rewriting `pm-agent/SKILL.md:245-251` so the daemon is the single emitter on `service` for **both** transports — is owned by **DL-53** (operator-applied); U0 must not edit the SKILL itself.

### 2. **DL-53 (EXTEND the already-open proposal — do NOT file a new proposal)** — operator-alert contract reframe + SKILL L1 rewrite + init Step-0.5/Step-8 + §18 unified-backend prose
- **Type:** Improvement (`[pm-proposal]`, §17-parked: `blocked`+`needs-pm`+`external-prereq`)
- **Applied by:** §17 operator git-commit (DL-12 `ea2ab98` / DL-42 `bb587b6` pattern)
- **Backend scope:** all (conventions are backend-agnostic; init step is per-backend)
- **dependsOn:** **U0** + **DL-52** land first (so the prose describes shipped behavior, not aspiration); supersedes the draft's separate U1/U2 proposals (folded here to avoid the file collision flagged in C2-mustFix-1)
- **Acceptance criteria:**
  - **(notification contract)** Reframe §9/§25 as one operator-alert channel `{transport: webhook|bot}`: webhook = one-way default (any backend); bot = two-way superset (service). Trigger: state-trigger (`Human-Blocked`) canonical on service, label-trigger on linear/local — **both fire the same `park-for-operator` notification**. **Rewrite `pm-agent/SKILL.md:245-251`** so on `service` the **daemon is the single emitter for both transports** (coherent with U0) — closing L1.
  - **(init channel-linking + Step 0.5 + Step 8)** Add the §3 **Step 0.5 "choose your ticket system"** to `skills/init/SKILL.md` (the tradeoff block, incl. "local human-park is label-only") + the **init channel-linking step** (wire notifications at init) + upgrade the **Step-8 "Backend" readiness line to cover `service`** (board URL, actor wiring, `mirror` status) — today it covers only `linear`/`local` (`SKILL.md:380-381`).
  - **(§18 unified-backend prose)** Name the **`park-for-operator`** abstract op with the **real-state-if-present-else-label** rule **and the hard carve-out that `Human-Blocked` is `service`-only — local is label-only** (§4.1); state the §2 "where the line falls" (work plane identical / surface plane + notification divergent-but-converging); add the §5 **"switching backends"** note (deferred migration + the hub→Linear `mirror`-is-a-projection seam + the `externalId` id-fidelity caveat). All edits to `conventions.md` + `skills/init/SKILL.md` in **one** operator commit (no colliding second proposal).

### 3. **U1 — init performs `service` setup (the turnkey core: install → seed → doctor → one-shot `daemon up` + health)**
- **Type:** Feature
- **Applied by:** Dev-buildable (CODE — the logic the Step-0.5 SKILL step invokes)
- **Backend scope:** `service`
- **dependsOn:** **DL-53** (the SKILL step that calls this); builds on shipped **DL-41** (lifecycle) + **DL-42** (hook)
- **Acceptance criteria:**
  - On `backend:"service"`, init **performs** (not prints): `npm install` if `node_modules` absent → `node hub/src/seed.ts <key> "<name>" <PREFIX>` (asserting `ensureProject` idempotency-on-key and surfacing the **prefix-clash throw**, `seed.ts:42-47`, as a clear "pick a unique prefix" error) → `npm run doctor` assert `DOCTOR_OK` → **`daemon up` as a one-time same-session bootstrap** → confirm `/api/health` `{ok:true}` → report the board URL.
  - **CORRECTED (C1-mustFix-2):** init's `daemon up` is documented in-code as a **one-time bootstrap convenience for the current session**, explicitly **not** a parallel lifecycle owner; init **verifies the DL-42 `hooks/hooks.json` SessionStart hook is present** and, if absent, instructs the operator to re-sync/reinstall the plugin (the hook is the steady-state owner). Re-running init no-ops cleanly (idempotent); `mode:"dry-run"` prints all steps and performs none.
  - For non-`service` backends → **exit-0 no-op** (matches the DL-41/DL-42 safety contract); `npm test` green incl. a dry-run-preview test.

### 4. **U2 — init merges (never clobbers) the product repo `.mcp.json`, env-name-only**
- **Type:** Feature
- **Applied by:** Dev-buildable (CODE)
- **Backend scope:** `service`
- **dependsOn:** **U1**
- **Acceptance criteria:**
  - init writes the `dev-loop-hub` MCP server entry into the product repo's `.mcp.json` by **merging** into an existing file (preserving any other registered MCP servers) — **never overwriting**; if the `dev-loop-hub` entry already exists, it is a no-op/update, not a duplicate. Source template is `config/mcp.example.json`.
  - Credentials are **env-NAME-only (§16)** — the merged entry references env var *names*, never literal secrets (matches `config/mcp.example.json`'s env-name-only shape).
  - The merge fills the absolute hub path + `DEVLOOP_ACTOR` wiring from values init already knows (`repoPath`, hub path); a malformed/partial existing `.mcp.json` is reported as an error, not silently destroyed. Test covers "existing file with another MCP server → both present after merge."

### 5. **U4 — (optional polish) init "backend doctor" reconcile on re-run**
- **Type:** Improvement
- **Applied by:** Dev-buildable (CODE)
- **Backend scope:** `service`
- **dependsOn:** **U1**, **U2**
- **Acceptance criteria:**
  - On a re-run of init for a `service` project, extend `hub/src/doctor.ts` to verify: the daemon is up (or startable via the one-shot bootstrap), the `.mcp.json` actor wiring is intact, the board is reachable (`/api/health`), and the DL-42 hook is present — reporting each as ✅/❌ in the Step-8 readiness checklist.
  - Read-only/idempotent; no auto-repair of operator-owned files beyond re-running the U1/U2 idempotent steps; low priority.

**Explicitly NOT filed (owned elsewhere / deferred):**
- **L3 of the notification leak** (the `channels.transport` column + `sendVia` webhook path) → **DL-52** (in queue). U0 *consumes* it.
- **Backend *migration*** (linear↔service ticket move) → **deferred epic** (§5); not a ticket until the operator prioritizes it. Naming the seam is DL-53's job.

---

## 7. Decisions for the operator (choose before building)

1. **Confirm the DL-52 → U0 split.** DL-52 as groomed (STRATEGY.md:392) closes only the transport column (L3). **U0 is required** to make the daemon read the §9 `notify` webhook (L2) and to keep the SKILL-branch coherent (L1, via DL-53). **Decision:** file U0 as a separate Dev ticket dependsOn DL-52 (recommended), **or** widen DL-52's ACs to absorb L1+L2 (single ticket, larger scope). Either way, *do not* ship the U-tickets believing DL-52 alone closes the notification gap.
2. **Fold U1/U2-prose + U3 into DL-53, or hard-block on it?** Recommended: **fold** (one operator commit; avoids the `skills/init/SKILL.md` + §9 collision in C2-mustFix-1). Alternative: keep them separate but **hard-block** on DL-53 landing first and rebase. Pick one before any SKILL/conventions edit.
3. **Defer cross-store ticket migration?** Recommended: **yes, defer** (§5) — ship choose-at-init now; name the seam + the `externalId` id-fidelity caveat in DL-53. Confirm the operator does not need linear→service migration *now* (if they want Linear visibility without migrating, the answer is **service + `mirror`**).
4. **Linear custom "Blocked" state — required or optional?** **Optional, unchanged.** `blockedStateName` stays an opt-in promotion on **linear** only; on **local** the park is **label-only, full stop** (`Human-Blocked` is service-only). Confirm the operator accepts label-only parking on `local` (no daemon reminder there).
5. **Dogfood-migration timing for any schema ticket (DL-52/U0).** Confirm: additive nullable column via the `user_version` ladder (no rebuild) is acceptable, applied while the live `DL`+`SC` loop on the shared `hub.db` is **quiesced** if any rebuild is ever unavoidable.

**Relevant files (absolute):** `/Users/shuai/workspace/dev-loop/skills/pm-agent/SKILL.md` (`:245-251` L1 service-branch), `/Users/shuai/workspace/dev-loop/hub/src/daemon.ts` (`:885,928,933` notifier reads bot channel only), `/Users/shuai/workspace/dev-loop/hub/src/channel.ts` (`:18-19` `getEnabledChannel` provider-filter, `:80-102` `sendVia` bot-only), `/Users/shuai/workspace/dev-loop/hub/src/db.ts` (`:69` state CHECK, `:160-174` channels-no-transport, `:211-275` user_version ladder, `:286-292` global-PK id alloc), `/Users/shuai/workspace/dev-loop/hub/src/seed.ts` (`:42-47` idempotent + prefix-clash throw), `/Users/shuai/workspace/dev-loop/skills/init/SKILL.md` (`:162` backend ask, `:169-175` service prose, `:190-197` flow branch, `:380-381` Step-8 linear/local-only), `/Users/shuai/workspace/dev-loop/references/conventions.md` (`:205-207` state list, `:221`/`:243` Human-Blocked service-only, `:491-547` §9 notify webhook, `:551` blockedStateName, `:904-916` no-agent-self-edit), `/Users/shuai/workspace/dev-loop/docs/STRATEGY.md` (`:390-395` DL-50/52/53 groom).