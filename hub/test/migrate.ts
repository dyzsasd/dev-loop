// DL-27 [coverage]: D3a schema-migration regression test (v0 → v1), the sibling of test/blocked.ts (D3b).
// DL-25 widened tickets.state's CHECK to admit 'Human-Blocked' by rebuilding the table (SQLite can't ALTER
// a CHECK). It was verified with a scratch script but lacked a permanent suite test. This builds a HERMETIC
// v0 DB by hand — the pre-DL-25 schema: tickets.state CHECK WITHOUT 'Human-Blocked', user_version=0, with a
// project, tickets across legacy states, and comment children — then runs the REAL openDb()/migrate() path
// and asserts: v1 set, lossless rows, FK children intact, 'Human-Blocked' now insertable, a bogus state
// still rejected, and an idempotent re-open. No network, no shared state — a temp DB under /tmp (cf. blocked.ts).
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const uv = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const count = (db: DatabaseSync, t: string): number => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
// run an INSERT that may violate the state CHECK; return true iff it was REJECTED (threw).
const rejects = (db: DatabaseSync, id: string, state: string): boolean => {
  try { db.prepare("INSERT INTO tickets(id,project_id,title,state,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,'[]','[]','pm','t','t')").run(id, "p", "x", state); return false; }
  catch { return true; }
};

const PATH = "/tmp/dl-migrate-v0.db";
clean(PATH);

// ── build the hermetic v0 DB ─────────────────────────────────────────────────
// The pre-DL-25 state set (no 'Human-Blocked'). Frozen history, so it's hardcoded here, not derived from
// the live STATES (which already includes Human-Blocked) — the whole point is to start BELOW the migration.
const V0_STATES = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled", "Duplicate"];
const V0_CHECK = V0_STATES.map((s) => `'${s}'`).join(", ");
const TICKETS_BEFORE = 4, COMMENTS_BEFORE = 2;
{
  const v0 = new DatabaseSync(PATH);
  v0.exec("PRAGMA foreign_keys=OFF");
  // minimal parent (projects.id is the only column the tickets FK + the migration need); openDb's SCHEMA
  // re-exec is CREATE TABLE IF NOT EXISTS, so this minimal shape survives untouched (the migration only
  // rebuilds `tickets`). tickets mirrors the v0 column set EXACTLY (the migration copies these 14 by name).
  v0.exec("CREATE TABLE projects (id TEXT PRIMARY KEY);");
  v0.exec(`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'Feature',
      state TEXT NOT NULL DEFAULT 'Todo' CHECK(state IN (${V0_CHECK})),
      assignee TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT '[]',
      duplicate_of TEXT,
      related_to TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
  // a child whose ticket_id references tickets(id) — its survival proves the rebuild kept FK children.
  v0.exec("CREATE TABLE comments (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);");
  v0.prepare("INSERT INTO projects(id) VALUES('p')").run();
  const ins = v0.prepare("INSERT INTO tickets(id,project_id,title,state,created_by,created_at,updated_at) VALUES(?,?,?,?,'pm','t','t')");
  ["Todo", "In Progress", "In Review", "Done"].forEach((st, i) => ins.run("T" + i, "p", "ticket " + i, st));
  v0.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES('c0','T0','pm','first','t')").run();
  v0.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES('c1','T1','qa','second','t')").run();
  v0.exec("PRAGMA user_version=0");
  // sanity — this really IS a v0 DB: version 0 AND the old CHECK rejects 'Human-Blocked'.
  ok(uv(v0) === 0 && rejects(v0, "X", "Human-Blocked"), "DL-27: fixture is a genuine v0 DB (user_version=0; old CHECK rejects 'Human-Blocked')");
  v0.close();
}

// ── run the REAL migration via openDb() ──────────────────────────────────────
const db = openDb(PATH);
ok(uv(db) === 1, "DL-27: openDb migrated the v0 DB → user_version=1");
ok(count(db, "tickets") === TICKETS_BEFORE && count(db, "comments") === COMMENTS_BEFORE, "DL-27: migration is lossless (ticket + comment row counts preserved)");
// FK children kept: the DROP+RENAME (with foreign_keys OFF) left no dangling comment→ticket references.
ok((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length === 0, "DL-27: FK children kept — foreign_key_check finds no violations after the rebuild");
ok((db.prepare("SELECT t.id FROM comments c JOIN tickets t ON t.id=c.ticket_id WHERE c.id='c0'").get() as { id: string } | undefined)?.id === "T0", "DL-27: a child comment still joins to its parent ticket (T0)");
// the widened CHECK now ACCEPTS Human-Blocked, but STILL rejects a bogus state (widened, not dropped).
const hbInsertable = !rejects(db, "HB", "Human-Blocked");
ok(hbInsertable && (db.prepare("SELECT state FROM tickets WHERE id='HB'").get() as { state: string }).state === "Human-Blocked", "DL-27: post-migration CHECK accepts 'Human-Blocked'");
ok(rejects(db, "BAD", "Nonsense"), "DL-27: the widened CHECK still rejects a bogus state ('Nonsense')");
db.close();

// ── idempotent re-open: a second openDb on the now-v1 DB is the fast-path no-op (no re-migrate, data intact) ──
const db2 = openDb(PATH);
ok(uv(db2) === 1 && count(db2, "tickets") === TICKETS_BEFORE + 1, "DL-27: re-opening a v1 DB is idempotent (still v1; the prior HB row persists, no double-migrate)");
db2.close();

clean(PATH);
console.log(fails === 0 ? "\nMIGRATE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
