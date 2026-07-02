// dev-loop hub — the SQLite system of record (built-in node:sqlite, WAL).
// Zero native deps. One process opens one hub.db; see ../docs/HUB-ARCHITECTURE.md §6/§7.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────
export type State =
  | "Backlog" | "Todo" | "In Progress" | "In Review" | "Human-Blocked" | "Done" | "Canceled" | "Duplicate";

export interface Ticket {
  id: string;
  project_id: string;
  title: string;
  description: string;
  type: string;            // Feature | Bug | Improvement
  state: State;
  assignee: string | null; // actor handle
  priority: number;        // §5: 1=Urgent 2=High 3=Medium 4=Low 0=None (Linear convention)
  labels: string[];        // REPLACE-style label set (mirrors Linear save_issue semantics, §10#1)
  duplicateOf: string | null; // §8 dedupe canonical pointer (scalar set)
  relatedTo: string[];     // §4 splits / §15 coverage sibling links (append-only merge, §18)
  created_by: string;
  created_at: string;
  updated_at: string;
}

// The dev-loop state machine (§3). CHECKed so a fuzzy/typo state can never be stored (kills §10#2).
export const STATES: State[] =
  ["Backlog", "Todo", "In Progress", "In Review", "Human-Blocked", "Done", "Canceled", "Duplicate"];
// CHECK clause built FROM `STATES` so the fresh-DB schema (below) and the v1 migration (openDb)
// can never drift — one source of truth for the legal state set. (DL-25: Human-Blocked added.)
const STATE_CHECK = STATES.map((s) => `'${s}'`).join(", ");
// DL-52: same no-drift discipline for channels.transport — the CHECK in BOTH the fresh SCHEMA and the v2
// ALTER is built from this one source, so adding a transport later can't desync the create vs the migrate.
const TRANSPORTS = ["bot", "webhook"] as const;
const TRANSPORT_CHECK = TRANSPORTS.map((t) => `'${t}'`).join(", ");
// DL split (v3): same no-drift discipline for documents.kind — the CHECK in BOTH the fresh SCHEMA and the
// v3 rebuild is built from this one source, so adding a doc-kind can't desync create vs migrate. Must match
// DOC_KINDS in docstore.ts (kept in lock-step by hand; docstore.ts is the LEAF that the zod enum imports).
const DOC_KINDS = ["strategy", "roadmap", "decisions", "notes", "design"] as const;
const DOC_KIND_CHECK = DOC_KINDS.map((k) => `'${k}'`).join(", ");

// ─── Schema ────────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('agent','human')),
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  ticket_prefix TEXT NOT NULL DEFAULT 'DL',
  ticket_seq INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live','dry-run')),
  autonomy TEXT NOT NULL DEFAULT 'ask' CHECK(autonomy IN ('ask','full')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('marker','type','owner','subtype','workflow','repo')),
  UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Feature',
  state TEXT NOT NULL DEFAULT 'Todo' CHECK(state IN (${STATE_CHECK})),
  assignee TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]',   -- JSON array; REPLACE-style on save_issue (mirrors Linear)
  duplicate_of TEXT,                   -- §8 dedupe canonical pointer (scalar; pairs with state Duplicate)
  related_to TEXT NOT NULL DEFAULT '[]', -- §4 splits / §15 coverage siblings (JSON array; append-only merge, §18 line 965)
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_project_state ON tickets(project_id, state);
-- list_issues / /api/tickets / the board sort by (project_id, updated_at DESC); without this the query
-- planner falls back to USE TEMP B-TREE FOR ORDER BY on every read (D4). CREATE INDEX IF NOT EXISTS runs
-- on every openDb (below), so it retro-adds to existing DBs with no user_version migration.
CREATE INDEX IF NOT EXISTS idx_tickets_project_updated ON tickets(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  author TEXT NOT NULL,                -- attributable per-agent identity (the headline win)
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id, created_at);
-- append-only attribution / audit log; every write stamps who did it
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  ticket_id TEXT,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- e.g. issue.create, issue.transition, comment.add
  data TEXT NOT NULL DEFAULT '{}',     -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id);
-- The append-only events ledger is never pruned; its hot queries are otherwise full-table scans (D3):
--   • per-ticket MAX(created_at) WHERE ticket_id=? AND kind=? — the 60s blocked-notifier tick, once per
--     Human-Blocked ticket, and /activity's per-ticket HIST_SQL → idx_events_ticket.
--   • project-wide WHERE project_id=? AND kind=? (no-progress detector, per-actor GROUP BY on /activity)
--     used only the project_id prefix of idx_events_project → idx_events_project_kind_created.
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_events_project_kind_created ON events(project_id, kind, created_at);
-- ── P4 documents: versioned, attributable, operator-published product docs ────
-- §17 firewall is STRUCTURAL: docs live ONLY in these tables; NO doc tool touches the
-- filesystem (no fs import, no path arg) — a doc can never represent a SKILL/conventions/code file.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK(kind IN (${DOC_KIND_CHECK})), -- PRODUCT docs only; no code-ish kind exists (v3: + 'design')
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','current')),
  current_version INTEGER NOT NULL DEFAULT 0,   -- 0 = never published; else the live PUBLISHED version
  created_by TEXT NOT NULL,                     -- actor HANDLE (like tickets.created_by), not a FK to actors(id)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, slug)
  -- per-kind singleton uniqueness is a PARTIAL index (below), NOT a table constraint: 'design' is
  -- multi-instance (one doc per module slug) so UNIQUE(project_id,kind) must exclude it. The other
  -- four kinds stay single-instance. UNIQUE(project_id,slug) above keeps every slug globally unique.
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, kind);
-- v3: enforce one doc per kind for the SINGLETON kinds only (excludes 'design', which is per-slug).
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_singleton_kind ON documents(project_id, kind) WHERE kind != 'design';
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  version INTEGER NOT NULL,                      -- 1-based, monotonic per doc, append-only
  body TEXT NOT NULL DEFAULT '',                 -- §16: author-side discipline (same trust as ticket bodies), never a fs path
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','current')),
  summary TEXT NOT NULL DEFAULT '',
  base_version INTEGER NOT NULL DEFAULT 0,       -- the version edited FROM; the optimistic-CAS key
  author TEXT NOT NULL,                          -- actor HANDLE
  created_at TEXT NOT NULL,
  UNIQUE(doc_id, version)
);
CREATE INDEX IF NOT EXISTS idx_docversions_doc ON document_versions(doc_id, version);
-- ── P6 IM channel: per-project provider-agnostic two-way plane (§9/§16/§25) ───
-- §16 STRUCTURAL: this table holds the ENV-VAR NAME (config_ref/secret_ref) + the room id
-- (channel_ref), NEVER a token/secret/URL. The secret is read from process.env[config_ref]
-- server-side only and never persisted/returned/logged. (DL-52: for transport='webhook', config_ref
-- is the env-var NAME of the incoming-webhook URL and secret_ref the optional sign-secret name — still
-- NAMES, never the literal URL/secret.)
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL CHECK(provider IN ('slack','lark')), -- CHECKed: an unknown provider can never be stored
  config_ref TEXT NOT NULL,        -- ENV-VAR NAME of the bot token (slack) / app_id (lark) — OR the incoming-webhook URL when transport='webhook'; NEVER the secret/URL literal
  secret_ref TEXT,                 -- optional ENV-VAR NAME of the app_secret (lark) / signing secret; NEVER the secret
  channel_ref TEXT NOT NULL,       -- the room/chat id (slack 'C…' / lark chat_id 'oc_…') — an addressing handle (unused by transport='webhook', which posts to the URL directly)
  inbound_cursor TEXT,             -- THE no-daemon cursor: slack ts / lark create_time of the last-seen msg. NULL = never polled
  last_poll_at TEXT,               -- wall-clock of the last successful poll (advisory/observability)
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'bot' CHECK(transport IN (${TRANSPORT_CHECK})), -- DL-52: 'bot' = provider bot API (default; existing channels unchanged) | 'webhook' = one-way incoming-webhook (no bot app)
  UNIQUE(project_id, provider, channel_ref)
);
CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project_id, enabled);
-- inbound audit + DEDUP + the durable inbox between stateless Director fires.
CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  project_id TEXT NOT NULL,          -- denormalized for the §2 project-scope filter
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  provider_msg_id TEXT,              -- slack ts / lark message_id — the dedup key
  author_ref TEXT,                   -- inbound: the OPAQUE provider sender id (NEVER a resolved name/email, NEVER operator authority)
  body TEXT NOT NULL DEFAULT '',     -- inbound: operator raw text (DATA, §16-scrubbed before any ticket/doc); outbound: the built allow-listed summary
  kind TEXT,                         -- outbound: 'digest'|'notify'|'reply'; inbound: NULL
  acted INTEGER NOT NULL DEFAULT 0,  -- inbound: 0=in the Director inbox, 1=consumed
  acted_into TEXT,                   -- the hub artifact id (topic/ticket) the Director turned it into — provenance; the hub stays the state
  created_at TEXT NOT NULL,
  provider_ts TEXT,                  -- inbound: provider-reported send time (ordering / cursor)
  UNIQUE(channel_id, direction, provider_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_chanmsg_inbox ON channel_messages(project_id, direction, acted, created_at);
-- ── P7 one-way Linear mirror: hub → Linear projection map (the hub is the SoR) ─
-- §16: holds Linear ids + a content hash, NEVER a token/secret. linear_id NULL = a create is
-- pending (the row is written BEFORE the remote create, so a crash never orphans/double-creates --
-- a NULL-id retry reconciles by the [hub:id] title marker). The hash is computed from HUB
-- fields only, so a human edit on the Linear side never changes it (one-way; hub state always wins).
CREATE TABLE IF NOT EXISTS mirror_map (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  hub_kind TEXT NOT NULL DEFAULT 'ticket' CHECK(hub_kind IN ('ticket')), -- tickets only for P7; docs/topics deferred
  hub_id TEXT NOT NULL,
  linear_id TEXT,                  -- the mirrored Linear issue id; NULL = create pending (crash-safe)
  last_pushed_hash TEXT,           -- sha256 of the HUB-derived mirror content; an unchanged ticket is SKIPPED (incremental)
  last_pushed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, hub_kind, hub_id)
);
CREATE INDEX IF NOT EXISTS idx_mirror_project ON mirror_map(project_id, hub_kind);
`;

// ─── Schema migrations (PRAGMA user_version) ─────────────────────────────────
// SQLite cannot ALTER a CHECK constraint, so widening tickets.state means rebuilding the table
// (the documented table-redefinition procedure). Keyed by user_version so every opener applies
// pending migrations exactly once, idempotently; the version is re-checked UNDER the write lock so
// concurrent openers (server + daemon, two connections) can't double-migrate. foreign_keys must be
// toggled OUTSIDE the txn (the PRAGMA is a no-op inside one). Runs BEFORE any caller sets
// query_only (daemon sets it after openDb returns), so the read connection still migrates cleanly.
const tableExists = (db: DatabaseSync, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const columnExists = (db: DatabaseSync, table: string, col: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
// pre-v3 marker: the stored documents CREATE SQL carries a table-level `UNIQUE(project_id, kind)`
// (the v3 rebuild replaces it with the partial index uq_documents_singleton_kind). The regex tolerates
// arbitrary inner whitespace. Used as the v3 rebuild guard (a SCHEMA-re-exec'd partial index would
// otherwise mask whether the table itself was migrated).
const documentsHasTableLevelKindUnique = (db: DatabaseSync): boolean => {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").get() as { sql: string } | undefined;
  return !!r && /UNIQUE\s*\(\s*project_id\s*,\s*kind\s*\)/i.test(r.sql);
};
const userVersion = (db: DatabaseSync): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

const SCHEMA_VERSION = 3; // bump when adding a migration below (DL-25 → v1; DL-52 channels.transport → v2; DL split documents.kind+='design' → v3)
function migrate(db: DatabaseSync): void {
  if (userVersion(db) >= SCHEMA_VERSION) return; // fast path: already current, no txn
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (userVersion(db) < 1) {
      // v1 (DL-25): widen tickets.state CHECK to include 'Human-Blocked'. Lossless rebuild:
      // explicit column copy (never SELECT *), FK off so comments(ticket_id)/mirror_map children
      // survive the DROP+RENAME, PK + index recreated. CHECK comes from STATE_CHECK (no drift).
      db.exec(`
        CREATE TABLE tickets_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL DEFAULT 'Feature',
          state TEXT NOT NULL DEFAULT 'Todo' CHECK(state IN (${STATE_CHECK})),
          assignee TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          labels TEXT NOT NULL DEFAULT '[]',
          duplicate_of TEXT,
          related_to TEXT NOT NULL DEFAULT '[]',
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO tickets_new (id,project_id,title,description,type,state,assignee,priority,labels,duplicate_of,related_to,created_by,created_at,updated_at)
          SELECT id,project_id,title,description,type,state,assignee,priority,labels,duplicate_of,related_to,created_by,created_at,updated_at FROM tickets;
        DROP TABLE tickets;
        ALTER TABLE tickets_new RENAME TO tickets;
        CREATE INDEX IF NOT EXISTS idx_tickets_project_state ON tickets(project_id, state);
      `);
      db.exec("PRAGMA user_version=1");
    }
    if (userVersion(db) < 2) {
      // v2 (DL-52): add channels.transport ('bot'|'webhook', default 'bot'). Additive ALTER — a new column
      // with a default backfills existing rows to 'bot', so every existing channel is byte-for-byte
      // unchanged (unlike v1's CHECK-widen, an ADD COLUMN needs no table rebuild). Guarded on column
      // presence: a brand-new / channel-less DB had its channels table created WITH transport by the SCHEMA
      // re-exec above ⇒ skip the ALTER (no "duplicate column" error); a real pre-v2 DB has channels WITHOUT
      // it ⇒ the ALTER adds + backfills the column.
      if (tableExists(db, "channels") && !columnExists(db, "channels", "transport"))
        db.exec(`ALTER TABLE channels ADD COLUMN transport TEXT NOT NULL DEFAULT 'bot' CHECK(transport IN (${TRANSPORT_CHECK}))`);
      db.exec("PRAGMA user_version=2");
    }
    if (userVersion(db) < 3) {
      // v3 (DL split): widen documents.kind CHECK to admit 'design' AND relax per-kind uniqueness so
      // 'design' is multi-instance (one doc per module slug). SQLite cannot ALTER a CHECK nor drop a
      // table-level UNIQUE, so this is the DL-25 lossless rebuild shape: explicit column copy (never
      // SELECT *), FK off so document_versions(doc_id) children survive the DROP+RENAME, index recreated.
      // CHECK comes from DOC_KIND_CHECK (no drift). The new table keeps UNIQUE(project_id,slug) but DROPS
      // the table-level UNIQUE(project_id,kind), replacing it with a PARTIAL unique index that excludes
      // 'design' — so strategy/roadmap/decisions/notes stay singletons while design rows coexist by slug.
      // Guard on the OLD TABLE SHAPE, NOT the partial index: openDb's SCHEMA re-exec runs BEFORE migrate()
      // and its standalone `CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_singleton_kind` already added that
      // index onto the pre-v3 documents table — so an index-presence guard would wrongly skip the rebuild.
      // The reliable pre-v3 marker is the table-level `UNIQUE(project_id, kind)` in the stored CREATE SQL
      // (replaced by the partial index post-rebuild). Absent it (fresh DB or already-rebuilt) ⇒ skip.
      if (tableExists(db, "documents") && documentsHasTableLevelKindUnique(db)) {
        db.exec(`
          CREATE TABLE documents_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            kind TEXT NOT NULL CHECK(kind IN (${DOC_KIND_CHECK})),
            slug TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','current')),
            current_version INTEGER NOT NULL DEFAULT 0,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(project_id, slug)
          );
          INSERT INTO documents_new (id,project_id,kind,slug,title,status,current_version,created_by,created_at,updated_at)
            SELECT id,project_id,kind,slug,title,status,current_version,created_by,created_at,updated_at FROM documents;
          DROP TABLE documents;
          ALTER TABLE documents_new RENAME TO documents;
          CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, kind);
          CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_singleton_kind ON documents(project_id, kind) WHERE kind != 'design';
        `);
      }
      db.exec("PRAGMA user_version=3");
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* */ }
    db.exec("PRAGMA foreign_keys=ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys=ON");
}

// ─── Open ──────────────────────────────────────────────────────────────────
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000"); // wait out a concurrent writer instead of erroring
  const fresh = !tableExists(db, "tickets");
  db.exec(SCHEMA);
  if (fresh) db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`); // brand-new DB already has the current schema — no migration
  else migrate(db);                                           // existing DB — apply pending migrations (idempotent)
  return db;
}

export function nowIso(): string {
  // Date.now()/new Date() are fine in the hub process (it is NOT a workflow script).
  return new Date().toISOString();
}

// Allocate the next ticket id atomically inside a txn (race-free, unlike the §18 O_EXCL file counter).
export function nextTicketId(db: DatabaseSync, projectId: string): string {
  const row = db
    .prepare("UPDATE projects SET ticket_seq = ticket_seq + 1 WHERE id = ? RETURNING ticket_seq, ticket_prefix")
    .get(projectId) as { ticket_seq: number; ticket_prefix: string } | undefined;
  if (!row) throw new Error(`unknown project ${projectId}`);
  return `${row.ticket_prefix}-${row.ticket_seq}`;
}

// ─── Line diff (P4 doc.diff — LCS-based unified-ish diff; pure JS, zero dep) ──
export function unifiedDiff(a: string, b: string): string {
  const al = a.split("\n"), bl = b.split("\n");
  const m = al.length, n = bl.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
    dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = []; let i = 0, j = 0;
  while (i < m && j < n) {
    if (al[i] === bl[j]) { out.push("  " + al[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("- " + al[i++]); }
    else { out.push("+ " + bl[j++]); }
  }
  while (i < m) out.push("- " + al[i++]);
  while (j < n) out.push("+ " + bl[j++]);
  return out.join("\n");
}

// ─── Identity guards (P3 — kill the phantom-actor silent-corruption bug) ─────
export function actorExists(db: DatabaseSync, handle: string): boolean {
  return db.prepare("SELECT 1 FROM actors WHERE handle = ? AND active = 1").get(handle) !== undefined;
}
export function listActorHandles(db: DatabaseSync): string[] {
  return (db.prepare("SELECT handle FROM actors WHERE active = 1 ORDER BY handle").all() as { handle: string }[])
    .map((r) => r.handle);
}

export function logEvent(
  db: DatabaseSync,
  e: { project_id: string; ticket_id?: string | null; actor: string; kind: string; data?: unknown },
): void {
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES (?,?,?,?,?,?)")
    .run(e.project_id, e.ticket_id ?? null, e.actor, e.kind, JSON.stringify(e.data ?? {}), nowIso());
}
