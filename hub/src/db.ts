// dev-loop hub — the SQLite system of record (built-in node:sqlite, WAL).
// Zero native deps. One process opens one hub.db; see ../docs/HUB-ARCHITECTURE.md §6/§7.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────
export type State =
  | "Backlog" | "Todo" | "In Progress" | "In Review" | "Done" | "Canceled" | "Duplicate";

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
  ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled", "Duplicate"];

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
  state TEXT NOT NULL DEFAULT 'Todo' CHECK(state IN ('Backlog','Todo','In Progress','In Review','Done','Canceled','Duplicate')),
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
-- ── P4 documents: versioned, attributable, operator-published product docs ────
-- §17 firewall is STRUCTURAL: docs live ONLY in these tables; NO doc tool touches the
-- filesystem (no fs import, no path arg) — a doc can never represent a SKILL/conventions/code file.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK(kind IN ('strategy','roadmap','decisions','notes')), -- PRODUCT docs only; no code-ish kind exists
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','current')),
  current_version INTEGER NOT NULL DEFAULT 0,   -- 0 = never published; else the live PUBLISHED version
  created_by TEXT NOT NULL,                     -- actor HANDLE (like tickets.created_by), not a FK to actors(id)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, slug),
  UNIQUE(project_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, kind);
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
-- ── P5 discussion board: the Director chairs; invited agents post per round ────
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  question TEXT NOT NULL,
  invited TEXT NOT NULL DEFAULT '[]',          -- JSON array of actor handles
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  round INTEGER NOT NULL DEFAULT 1,
  round_opened_at TEXT NOT NULL,               -- wall-clock for the state-free termination budget
  opened_by TEXT NOT NULL,                     -- the chair (authority = opened_by)
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  decision TEXT                                -- inline terminal decision (set on close); DATA, never auto-applied (§17)
);
CREATE INDEX IF NOT EXISTS idx_topics_project_status ON topics(project_id, status);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  round INTEGER NOT NULL,
  author TEXT NOT NULL,                         -- actor HANDLE (attribution)
  kind TEXT NOT NULL DEFAULT 'perspective' CHECK(kind IN ('perspective','synthesis')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(topic_id, round, author, kind)         -- one perspective per (round, author); chair's synthesis coexists
);
CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts(topic_id, round, created_at);
`;

// ─── Open ──────────────────────────────────────────────────────────────────
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000"); // wait out a concurrent writer instead of erroring
  db.exec(SCHEMA);
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
