# The `local` backend — implementation detail

Extracted from conventions §18. Read when the resolved `backend` is `local`, before the
first board operation of a fire. The abstract contract (work plane vs surface plane,
`park-for-operator`, switching) stays in §18.

### Local board layout
The legacy local board is **machine-local per-operator runtime state** — it lives in the
configured local data dir (§11), **never** in the product repo (a board of
ticket-state would otherwise churn the repo with coordination commits). Default:

```
${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/board/
  counter.json          # ID hint: { "prefix": "DL", "next": 42 }  (a hint, not the source of truth — see ID allocation)
  tickets/
    DL-1.md             # one markdown file per ticket
    DL-2.md
```

`<project-key>` is the config key, so multiple local projects stay isolated. The path
is overridable via `localBoard` (§11). It is created lazily on
first write and **must be a dedicated dev-loop board dir on a single local
filesystem** — never a shared/pre-existing dir, and never a network mount (the
atomic-rename below needs one filesystem). Never committed, never shared.
`strategyDoc` in local mode is a **repo file** (read/edit/commit) — never a Linear
document; init rejects a `{linearDocument}` strategyDoc under `backend:"local"`.

### Ticket file format
One file per ticket, `tickets/<ID>.md`: YAML frontmatter (machine fields) + the §6
template body + an **append-only, dated** comments section. **State lives in the
`state:` frontmatter field** (a field rewrite — not folders-per-state, which would
invite move races). State names are exactly §3's (`Backlog`/`Todo`/`In Progress`/
`In Review`/`Done`/`Canceled`/`Duplicate`).

```markdown
---
id: DL-12
title: Add CSV export to the link manager
type: Feature                 # Feature | Bug | Improvement
state: In Review              # §3 names, verbatim
owner: pm                     # pm | qa (§4)
labels: [dev-loop, Feature, pm, repo:web]   # FULL label set (§4); dev-loop always present; repo:<name> is the repo target (multi-repo only, §19)
priority: 2                   # 1=Urgent 2=High 3=Medium 4=Low 0=None (§5)
assignee: null                # a per-fire claim token when claimed (§7), else null
relatedTo: [DL-9]             # append-only (merge on write)
duplicateOf: null
created: 2026-06-18T09:14:00Z
updated: 2026-06-18T11:02:00Z
---
## Context
…(the §6 Feature/Bug template verbatim)…

---
## Comments

### 2026-06-18T10:40:00Z — dev (run a1b2)
Claiming (§7). Implementing against ACs.

### 2026-06-18T11:02:00Z — dev (run a1b2)
state: Todo → In Review. Shipped in abc1234; coverage test added.
```

`labels` always carries the **full** set (§4). **Every state move MUST append a dated
comment recording the transition** (`state: X → Y`) — the dated comment log is the
board's activity history (frontmatter `updated:` is only point-in-time), and it is
what Reflect (§17, and its run logs) reconstructs the window's activity from in local
mode, in place of Linear's activity feed. Comments are append-only.

### Operation mapping (Linear MCP → local)
Same semantics — same filters, same REPLACE-style label discipline (§10), same
verify-after-write (§7/§10):

| Linear MCP op | Local op |
|---|---|
| `list_issues` (scoped `project`+`label`+`state`) | glob `tickets/*.md` **within this board dir only** (ignore temp/lock files — they are not `*.md`), parse frontmatter, filter in-process by the same predicates (label ∈ `labels[]` — including the `repo:<name>` target where present, §19 — `state`, `priority`, type) |
| `list_issues` with a free-text `query` (§8 dedupe / ideation) | the same glob+filter, then a substring/keyword scan over each candidate's `title` + body. **Multi-repo (§19):** scan across all repos, but dedupe within a `repo:<name>` target — per-repo children of one feature are not dupes |
| `get_issue` | read `tickets/<ID>.md` |
| `save_issue` (create) | allocate an ID (below), exclusively create `tickets/<ID>.md` |
| `save_issue` (update) | read-modify-rewrite frontmatter under the per-ticket lock (below); **labels REPLACE-style** — re-pass the FULL set (§10 #1); **append-only lists (`relatedTo`) merge** — re-read, union, write; append a state-move comment; bump `updated` |
| `list_comments` / `save_comment` | read / append-only-write the `## Comments` section (chronological) |
| `create_issue_label` | **no-op** — labels are plain strings; no registry to provision (init skips the label step in local mode) |
| `get_document` / `save_document` | only the **repo-file** form applies — `strategyDoc` is a repo file (§11, form detection §20) |

The §10 query discipline still applies: fetch the narrow slice you need (filter by the
most specific predicate; `get_issue` one file when that's all you need), never read
every file blindly.

**Service backend:** every op above maps to the **identically-named hub op**
(`list_issues`/`get_issue`/`save_issue`/`save_comment`/`list_comments`/`list_issue_labels`/
`create_issue_label`/`get_project`) with the same args + semantics; whether a fire invokes
that op as a hub MCP tool or as a `dev-loop` CLI command is the interface question — see
`references/backend-service.md`.

### ID allocation (race-safe via exclusive create)
`counter.json` (`{ "prefix": "...", "next": N }`, `prefix` from `ticketPrefix` (§11)
or `"DL"`) is a **start hint, not the source of truth**. The **atomic claim is the
ticket file's exclusive creation**:
1. Read `counter.json` for a starting `N` (1 if absent).
2. **Exclusively create** `tickets/<prefix>-N.md` (open with `O_CREAT|O_EXCL` — the OS
   guarantees exactly one creator wins). If it already exists, increment `N` and retry.
3. On success you own the ID; write the frontmatter+body, then best-effort bump
   `counter.json` to `next > N` (a hint for the next allocator — losing this race is
   harmless, step 2 still arbitrates). IDs are monotonic and never reused (a
   `Canceled`/`Duplicate` keeps its file + ID), mirroring Linear's server IDs.

### Concurrency — locks, claim token, verify
The §7 claim and §10 verify-after-write apply to files, with real atomicity (not just
re-read-after-write, which alone can't arbitrate two writers):
- **Per-ticket lock for read-modify-write.** Before updating a ticket, acquire a lock
  by exclusively creating `tickets/<ID>.lock` (`O_EXCL`); if it exists, another writer
  holds it — back off and retry. Read → modify → write via **temp file in the same
  dir + atomic rename** → release the lock (remove it). The temp/lock files are not
  `*.md`, so the list glob ignores them. **Stale-lock rule (mandatory):** a fire can
  crash between create and release; a lock whose mtime is older than **~60 min** is
  stale — remove it, log one line, and proceed. Without this a single crashed fire
  deadlocks that ticket forever (every later fire "backs off and retries" eternally).
- **Claim uses a per-fire token (§7).** A bare `assignee:"dev"` can't tell two Dev
  fires apart. Each fire mints a unique run token (e.g. `dev (run <short-id>)`); the
  claim writes that token under the lock, re-reads, and proceeds only if the token is
  **yours**. Dev Step 0 orphan-reclaim is the **opposite** check — it must NOT require
  the token to be yours (a crashed prior fire's token is by definition not the current
  fire's, so requiring equality would reclaim nothing): it keys on `assignee` set +
  `In Progress` + **no shipped artifact** (Dev Step 0's existing test), then clears the
  stale token and re-queues.
- **Shared-checkout caveat (§7) still holds** — the claim dedups *tickets*, not the
  git working tree; stage only your ticket's files.

### Firewall in local mode (§2)
Local mode removes the **human-backlog** axis of the firewall (the board dir holds no
human-owned tickets — nothing to leak into) but **not the cross-project axis**: every
glob MUST be confined to *this* project's `board/` dir, never a parent or a shared
path, so one project's loop can't touch another's board. init guarantees the board dir
is **dedicated** (empty or dev-loop-scaffolded) before use. Tickets still carry the
`dev-loop` label for parity (same code path, templates, reports across backends). The
§2 rules — never widen the blast radius, no bulk-mutate, one ticket at a time — apply
verbatim; "scope by `project`" means "operate only within this board dir".
