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
  priority: number;        // 0 none .. 4 low (Linear convention)
  labels: string[];        // REPLACE-style label set (mirrors Linear save_issue semantics)
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

export function logEvent(
  db: DatabaseSync,
  e: { project_id: string; ticket_id?: string | null; actor: string; kind: string; data?: unknown },
): void {
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES (?,?,?,?,?,?)")
    .run(e.project_id, e.ticket_id ?? null, e.actor, e.kind, JSON.stringify(e.data ?? {}), nowIso());
}
