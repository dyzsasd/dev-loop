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
  // DL-52: a pre-v2 channels table (NO transport column) + a row — proves the v2 ALTER adds transport AND
  // backfills the existing row to 'bot' (existing channels byte-for-byte unchanged). Pre-DL-52 column shape.
  v0.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), provider TEXT NOT NULL CHECK(provider IN ('slack','lark')), config_ref TEXT NOT NULL, secret_ref TEXT, channel_ref TEXT NOT NULL, inbound_cursor TEXT, last_poll_at TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, provider, channel_ref));");
  v0.prepare("INSERT INTO channels(id,project_id,provider,config_ref,channel_ref,created_at,updated_at) VALUES('ch','p','slack','TOK','C1','t','t')").run();
  // DL split: a pre-v3 documents table (kind CHECK WITHOUT 'design', table-level UNIQUE(project_id,kind)) +
  // a doc + version child — proves the v3 rebuild widens kind to admit 'design', relaxes per-kind uniqueness
  // to a partial index, and is lossless (the existing doc + its FK version child survive the DROP+RENAME).
  v0.exec("CREATE TABLE documents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL CHECK(kind IN ('strategy','roadmap','decisions','notes')), slug TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','current')), current_version INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, slug), UNIQUE(project_id, kind));");
  v0.exec("CREATE TABLE document_versions (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','current')), summary TEXT NOT NULL DEFAULT '', base_version INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(doc_id, version));");
  v0.prepare("INSERT INTO documents(id,project_id,kind,slug,title,created_by,created_at,updated_at) VALUES('d0','p','strategy','strat','Strat','pm','t','t')").run();
  v0.prepare("INSERT INTO document_versions(id,doc_id,version,body,author,created_at) VALUES('dv0','d0',1,'goal one','pm','t')").run();
  // D5: a pre-v4 mirror_map (the P7 ticket-only hub_kind CHECK) + a pushed row AND a create-pending
  // (NULL linear_id) row — proves the v4 rebuild widens hub_kind to admit 'doc' and is lossless (both
  // ticket mapping rows survive the DROP+RENAME byte-for-byte, crash-safety state included).
  v0.exec("CREATE TABLE mirror_map (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), hub_kind TEXT NOT NULL DEFAULT 'ticket' CHECK(hub_kind IN ('ticket')), hub_id TEXT NOT NULL, linear_id TEXT, last_pushed_hash TEXT, last_pushed_at TEXT, created_at TEXT NOT NULL, UNIQUE(project_id, hub_kind, hub_id));");
  v0.exec("CREATE INDEX idx_mirror_project ON mirror_map(project_id, hub_kind);");
  v0.prepare("INSERT INTO mirror_map(id,project_id,hub_kind,hub_id,linear_id,last_pushed_hash,last_pushed_at,created_at) VALUES('m0','p','ticket','T0','lin_1','hash_1','t','t')").run();
  v0.prepare("INSERT INTO mirror_map(id,project_id,hub_kind,hub_id,created_at) VALUES('m1','p','ticket','T1','t')").run();
  v0.exec("PRAGMA user_version=0");
  // sanity — this really IS a v0 DB: version 0 AND the old CHECK rejects 'Human-Blocked'.
  ok(uv(v0) === 0 && rejects(v0, "X", "Human-Blocked"), "DL-27: fixture is a genuine v0 DB (user_version=0; old CHECK rejects 'Human-Blocked')");
  let v0DocRejected = false;
  try { v0.prepare("INSERT INTO mirror_map(id,project_id,hub_kind,hub_id,created_at) VALUES('mx','p','doc','strat','t')").run(); } catch { v0DocRejected = true; }
  ok(v0DocRejected, "D5: fixture mirror_map is genuinely pre-v4 (the ticket-only CHECK rejects hub_kind='doc')");
  v0.close();
}

// ── run the REAL migration via openDb() ──────────────────────────────────────
const db = openDb(PATH);
ok(uv(db) === 5, "DL-27/DL-52/DL-split/D5/D6: openDb migrated the v0 DB → user_version=5 (v1 state-widen + v2 channels.transport + v3 documents.kind+='design' + v4 mirror_map.hub_kind+='doc' + v5 documents.archived)");
ok(count(db, "tickets") === TICKETS_BEFORE && count(db, "comments") === COMMENTS_BEFORE, "DL-27: migration is lossless (ticket + comment row counts preserved)");
// FK children kept: the DROP+RENAME (with foreign_keys OFF) left no dangling comment→ticket references.
ok((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length === 0, "DL-27: FK children kept — foreign_key_check finds no violations after the rebuild");
ok((db.prepare("SELECT t.id FROM comments c JOIN tickets t ON t.id=c.ticket_id WHERE c.id='c0'").get() as { id: string } | undefined)?.id === "T0", "DL-27: a child comment still joins to its parent ticket (T0)");
// the widened CHECK now ACCEPTS Human-Blocked, but STILL rejects a bogus state (widened, not dropped).
const hbInsertable = !rejects(db, "HB", "Human-Blocked");
ok(hbInsertable && (db.prepare("SELECT state FROM tickets WHERE id='HB'").get() as { state: string }).state === "Human-Blocked", "DL-27: post-migration CHECK accepts 'Human-Blocked'");
ok(rejects(db, "BAD", "Nonsense"), "DL-27: the widened CHECK still rejects a bogus state ('Nonsense')");
// DL-52 v2: the ALTER added channels.transport, backfilled the existing row to 'bot', CHECK live.
ok((db.prepare("PRAGMA table_info(channels)").all() as { name: string }[]).some((c) => c.name === "transport"), "DL-52: v2 migration added the channels.transport column (ALTER on a pre-v2 channels table)");
ok((db.prepare("SELECT transport FROM channels WHERE id='ch'").get() as { transport: string }).transport === "bot", "DL-52: the existing channel row backfilled to transport='bot' (existing channels byte-for-byte unchanged)");
let badTransport = false;
try { db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,channel_ref,transport,created_at,updated_at) VALUES('ch2','p','slack','TOK','C2','bogus','t','t')").run(); } catch { badTransport = true; }
ok(badTransport, "DL-52: the transport CHECK rejects a value outside {bot,webhook}");
// DL split v3: the documents rebuild is lossless (the pre-v3 strategy doc + its FK version child survive).
ok(count(db, "documents") === 1 && count(db, "document_versions") === 1, "DL-split: v3 documents rebuild is lossless (doc + version row counts preserved)");
ok((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length === 0, "DL-split: FK children kept — foreign_key_check finds no violations after the documents rebuild");
ok((db.prepare("SELECT d.id FROM document_versions v JOIN documents d ON d.id=v.doc_id WHERE v.id='dv0'").get() as { id: string } | undefined)?.id === "d0", "DL-split: a child version still joins to its parent doc (d0)");
// the widened kind CHECK now ACCEPTS 'design' (it didn't pre-v3) and 'design' is MULTI-INSTANCE.
const insDoc = (id: string, kind: string, slug: string): boolean => {
  try { db.prepare("INSERT INTO documents(id,project_id,kind,slug,title,created_by,created_at,updated_at) VALUES(?,?,?,?,'x','pm','t','t')").run(id, "p", kind, slug); return true; } catch { return false; }
};
ok(insDoc("dA", "design", "module-a"), "DL-split: post-migration kind CHECK accepts 'design'");
ok(insDoc("dB", "design", "module-b"), "DL-split: 'design' is MULTI-INSTANCE — a second design doc (different slug) is allowed (UNIQUE(project_id,kind) relaxed for design)");
ok(!insDoc("dC", "design", "module-a"), "DL-split: UNIQUE(project_id,slug) still holds — a duplicate slug is rejected even for design");
ok(insDoc("dD", "notes", "n1"), "DL-split: a first 'notes' doc inserts");
ok(!insDoc("dE", "notes", "n2"), "DL-split: singleton kinds stay one-per-kind — a 2nd 'notes' doc is rejected by the partial unique index uq_documents_singleton_kind");
ok(!insDoc("dBad", "bogus", "z"), "DL-split: the widened kind CHECK still rejects an unknown kind ('bogus')");
// D5 v4: the mirror_map rebuild is lossless and the widened hub_kind CHECK admits 'doc' (and only 'doc').
ok(count(db, "mirror_map") === 2, "D5: v4 mirror_map rebuild is lossless (both ticket mapping rows preserved)");
const m0 = db.prepare("SELECT hub_kind,hub_id,linear_id,last_pushed_hash,last_pushed_at FROM mirror_map WHERE id='m0'").get() as Record<string, unknown>;
ok(m0.hub_kind === "ticket" && m0.hub_id === "T0" && m0.linear_id === "lin_1" && m0.last_pushed_hash === "hash_1" && m0.last_pushed_at === "t",
  "D5: a pushed ticket mapping row survives the rebuild byte-for-byte (linear_id + hash + timestamp)");
ok((db.prepare("SELECT linear_id FROM mirror_map WHERE id='m1'").get() as { linear_id: string | null }).linear_id === null,
  "D5: a create-pending (NULL linear_id) mapping row survives the rebuild (crash-safety state kept)");
const insMap = (id: string, kind: string, hubId: string): boolean => {
  try { db.prepare("INSERT INTO mirror_map(id,project_id,hub_kind,hub_id,created_at) VALUES(?,?,?,?,'t')").run(id, "p", kind, hubId); return true; } catch { return false; }
};
// the rebuild added the doc-push provenance columns; pre-v4 ticket rows carry NULL in them (additive)
const mmCols = (db.prepare("PRAGMA table_info(mirror_map)").all() as { name: string }[]).map((c) => c.name);
ok(mmCols.includes("last_pushed_version") && mmCols.includes("last_pushed_body_hash"),
  "D5: v4 rebuild added last_pushed_version + last_pushed_body_hash (the poller's provenance/baseline columns)");
ok((db.prepare("SELECT last_pushed_version v, last_pushed_body_hash h FROM mirror_map WHERE id='m0'").get() as { v: unknown; h: unknown }).v === null,
  "D5: pre-v4 rows carry NULL in the new columns (nothing back-filled, nothing invented)");
ok(insMap("mD", "doc", "strat"), "D5: post-migration hub_kind CHECK accepts 'doc'");
ok(!insMap("mDup", "doc", "strat"), "D5: UNIQUE(project_id, hub_kind, hub_id) still holds — a duplicate doc mapping is rejected");
ok(insMap("mT2", "ticket", "strat"), "D5: uniqueness is per-kind — a 'ticket' mapping may share hub_id with a 'doc' mapping");
ok(!insMap("mBad", "topic", "z"), "D5: the widened hub_kind CHECK still rejects an unmirrored kind ('topic' stays deferred)");
// D6 v5: the ALTER added documents.archived, backfilled existing rows to 0, and new inserts default to 0.
ok((db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).some((c) => c.name === "archived"),
  "D6: v5 migration added the documents.archived column (ALTER on a pre-v5 documents table)");
ok((db.prepare("SELECT archived FROM documents WHERE id='d0'").get() as { archived: number }).archived === 0,
  "D6: the pre-v5 doc row backfilled to archived=0 (existing docs byte-for-byte visible)");
ok((db.prepare("SELECT archived FROM documents WHERE id='dA'").get() as { archived: number }).archived === 0,
  "D6: a post-migration insert without the column defaults to archived=0");
db.close();

// ── idempotent re-open: a second openDb on the now-v5 DB is the fast-path no-op (no re-migrate, data intact) ──
const db2 = openDb(PATH);
ok(uv(db2) === 5 && count(db2, "tickets") === TICKETS_BEFORE + 1, "DL-27/DL-52/DL-split/D5/D6: re-opening a v5 DB is idempotent (still v5; the prior HB row persists, no double-migrate)");
ok((db2.prepare("SELECT hub_kind FROM mirror_map WHERE id='mD'").get() as { hub_kind: string }).hub_kind === "doc", "D5: the doc mapping row persists across the idempotent re-open");
db2.close();

clean(PATH);
console.log(fails === 0 ? "\nMIGRATE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
