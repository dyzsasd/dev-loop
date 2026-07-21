# `reports.sink:"linear"` — the full spec

Extracted from conventions §23. The resident contract (default files, sink/backend
decoupling, the trigger moments) stays in §23; read this file when `reports.sink`
actually resolves to `"linear"`.


§22 reports default to **machine-local files**. An operator running the loop in a **cloud /
remote runtime** (no access to the agents' data dir) can instead route the report **body**
and the **点评** channel to **Linear**, reading reports and writing reviews from a browser /
phone. This is **opt-in and default-off**; it trades away a load-bearing §16
defense-in-depth layer, so **prefer files whenever the operator's machine is reachable**.

**Config.** `reports.sink: "files" | "linear"` — **absent ⇒ `"files"`** (§22 byte-for-byte;
single-repo / unconfigured / either §18 backend unchanged). The sink is **decoupled from the
§18 `backend`** — a `linear` backend does NOT auto-route reports to Linear, and a `local`
backend MAY still use Linear reports for remote review. Related keys (linear sink only):
`reports.linearProject` / `reports.linearInitiative` (the **dedicated** reports container —
never the §20 doc-base project), `reports.localOnlyAgents` (agents that stay on files
unconditionally — **defaults to `ops-agent` + `dev-agent`**, the
highest-PII × highest-cadence authors; the operator may opt any of them in, see safety), and
`reports.reviewToken` (the operator's high-entropy 点评
sentinel, below). init provisions the container + resolves these only on explicit opt-in
(§13).

**Primitive — one rolling Document per agent.** Reports live as **10 rolling Linear
Documents** (`pm-agent` … `communication-agent`, incl. `senior-dev-agent`/`junior-dev-agent`
— the split tiers report like every other agent), one per agent, in the dedicated reports project /
initiative, titled `dl-report · <project-key> · <agent>`. Each body has three fixed sections
`## Daily` / `## Weekly` / `## Monthly`; entries are dated `###` headings (`### 2026-06-19`,
`### 2026-W25`, `### 2026-06`). Documents never appear in `list_issues`, so the §2 / §5 / §8
/ §10 board firewall is **structural** — a report can never enter Dev's pick order or the
dedupe scan. (No per-period docs: the MCP has **no doc delete/archive**, so per-period would
grow unbounded and unprunable; the rolling body is pruned in place to ≈ 90 days of dailies.)
Report-doc queries scope by `projectId` / `initiativeId`, **not** the `dev-loop` label
(documents carry no labels — the §2 label firewall is for issues).

**Provenance — channel split, not author identity.** Author identity is useless (agents and
the operator are one Linear user — the shared-identity fact). Provenance is **by
write-primitive**: the report **body** is agent-written (`save_document`); the **点评** is a
**comment** on that doc, operator-written. The load-bearing invariant: **an agent's only
write to a report doc is `save_document`; it NEVER calls `save_comment` on a report doc, ever**
(acted-status is a machine-local ledger, never a Linear reply). So **every comment on a
report doc is non-agent by construction** — the exact analog of the file design's "agents
never author a `*.review.md`" (scoped precisely to **report** docs — PM still comments on the
§20 doc-base, a different channel). Two independent guards harden it: a comment is a valid
点评 only if **(a)** `author.id == the configured operator id` (drops the Linear integration
bot + any future third-party automation) **and (b)** its body **begins with
`reports.reviewToken`** — a per-project, operator-set, **opaque** token (**never** a
dictionary word like 点评 / "review" — those collide with ordinary review prose that appears
in report bodies). Distillation reads **only the operator comment's own body text** — never
`quotedText`, never the report body, never rolled-up content (closes the inline-comment
re-entry injection seam). A spoof needs two of the three (report-doc comment + operator id +
token) to fail at once. Treat `reports.reviewToken` as **§16-class** — never echo it into a
Linear-bound report body, a ticket, or a comment; it is workspace-readable inside the 点评
comment, so its value is collision-avoidance + a second factor, **not** a secret wall (the
channel invariant — agents never comment on a report doc — is the real wall). **Honest
limit:** this reaches **parity**, not superiority, with the file design (shared identity
removes the file design's identity backstop; hosting adds writer classes) — which is why it
stays opt-in.

**§16 safety — why it is not the default.** Machine-local reports bound the leak on four
axes; Linear inverts all four at once (audience 1 → all workspace members + every wired
integration + any API token; discoverability local-grep → workspace search + notification
fan-out; erasure `rm` → unrecallable via index / audit / backups / integration copies;
network none → hosted multi-tenant). The MCP exposes **no ACL field**, so an agent must
assume a report doc is workspace-readable. Mandatory guardrails for the linear sink — all
required:
- **Structural prohibition (primary).** A Linear-bound body is assembled **only** from
  summary prose + counts + ticket-IDs / SHAs — **never** from captured tool / log / deploy /
  error / metric output.
- **Fail-closed scrub backstop** before every `save_document`: a denylist pass (JWT / `AKIA`
  / connection-strings / private-key headers / emails / phones / IPv4-IPv6 / card-shaped
  runs / fenced code blocks / shell-prompt + log-level lines). On **any** match, do **not**
  write that entry to Linear — keep it **local-only** and write a **content-free** marker
  into the Linear body (`[1 entry withheld to local on <date>]`) so a disk-less operator
  isn't silently blind to the gap. Never silently redact-and-send.
- **High-PII agents stay local.** `ops-agent` + `dev-agent` are
  local-only by **default** (highest-PII × highest-cadence — Ops=log/metric output,
  Dev=deploy/build output); the operator may opt any of them
  into the linear sink, but the
  conservative default keeps the riskiest authors off Linear.
- **init-time operator attestation** that the reports container has no outbound integration
  sync and no non-operator subscribers (the MCP can't enumerate integrations, so this isn't
  runtime-enforceable), plus an explicit audience-widening warning.

**Per-fire mechanics (deterministic, stateless).** A machine-local `reports-state.json` under
the workspace `.dev-loop/` tree holds the **doc-id cache** (project+agent → documentId), the **acted
ledger** (`commentId → {actedAt, commentUpdatedAt, lessonShort}`), and `lastReviewPollAt`.
**`lessons.md`, the ledger, the doc-id cache, and the per-agent report-lock all stay
machine-local in both sinks** — only the body + 点评 thread move to Linear.
- **Resolve the doc:** cached id → `get_document(id)`; else `list_documents(projectId)` +
  client-side **exact** title-regex → cache; else `save_document(...)` then re-query (no
  atomic create — on a race keep the lexicographically-first id, **never delete** the dupe).
- **Markers:** `date +%F` / `+%G-W%V` / `+%Y-%m` (never reason about dates); parse
  newest-per-section by **strict anchored heading regex** (`^### \d{4}-\d{2}-\d{2}$` etc.);
  agents must not emit heading-shaped lines in prose. 点评 lives in comments, so it can never
  match a report heading (the §22 "no bare glob" exclusion is automatic).
- **Append at close** (material fire only — a no-op writes nothing): with the body in hand,
  finalize the prior daily, roll a just-completed week / month up **from the dailies**, append
  today's dated line, prune the `## Daily` tail, and `save_document(id, body)` **once** as the
  last close step, under a machine-local per-agent **O_EXCL report-lock** (the MCP has no etag
  / optimistic lock). **Before every `save_document`, re-read by id and assert** the title
  carries the exact namespace prefix **and** the doc is in the configured reports container —
  otherwise refuse and treat a non-namespaced target as a §16 stop-and-surface (prevents
  overwriting a real human doc, e.g. the north star).
- **点评 poll** (decoupled from fire cadence to cap cost): gated on `lastReviewPollAt` (≤ 1
  `list_comments` / hour / agent). For each comment passing the guards and **not** in the
  ledger (or whose `updatedAt` > the stored value — re-review affordance): distill **one** rule
  into the agent's own `lessons.md` section (locked RMW, §22), record the ledger entry, and
  **surface the acknowledgment as a line in the next report body** (`acted operator 点评
  <id-short> → lesson: …`) — **never** a Linear reply. Terminal "acted, no change" still
  records the ledger + surfaces it.
- **`mode` (§12):** under `dry-run`, no `save_document`, no lessons write, no ledger write —
  print intended actions.

**Degrade safely on non-durable storage.** The acted-ledger + `lessons.md` MUST sit on
durable per-operator storage; if they don't (a truly disk-less runtime), **disable
review-distillation entirely** — the linear sink degrades to a **read-only report mirror** (the
operator still reads reports; no behavior change, no infinite re-distill from a single
authorization). Flipping `files` → `linear` is **forward-only**: prior local reports stay on
disk and are not backfilled (no dual-source reconciliation).
