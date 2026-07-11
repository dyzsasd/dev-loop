// Docs P3 (operator-edit propagation) + P6b (drafts-pending) — regression tests.
// Covers: (1) docstore.latestForeignVersion — the doc-watch primitive (foreign = any author but self;
// PM's own drafts never re-trigger its own watch); (2) docForeignEditNotifyTick — under passive intake a
// HUMAN (non-agent) doc version left unconsumed past the settle window emits ONE comms line, deduped per
// version, never on an agent draft, design excluded; (3) startDocForeignEditNotifier's intake-mode gate;
// (4) docDraftsPendingNotifyTick — a gated doc trailing its published current for >pendingMs emits one
// DAILY line (remindMs), deduped per version, a NEW draft version re-announces; (5) DL-34 dry-run is
// write-free for BOTH ticks (child process — DEVLOOP_CHANNEL_DRYRUN is read once at channel.ts import).
// Live cases inject a stub fetchImpl (no network), the DL-26/DL-76 test style.
import { openDb } from "../src/db.ts";
import { latestForeignVersion } from "../src/docstore.ts";
import {
  docForeignEditNotifyTick, startDocForeignEditNotifier,
  docDraftsPendingNotifyTick, startDocDraftsPendingNotifier,
} from "../src/daemon-notifiers.ts";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { FetchImpl } from "../src/channel.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

process.env.TESTTOK = "xoxb-test"; // resolveCreds reads this env NAME (channels.config_ref)
const CWD = process.cwd();
const H = 3_600_000, M = 60_000;
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const isoAgo = (now: number, ms: number) => new Date(now - ms).toISOString();
type DB = ReturnType<typeof openDb>;

// Raw seed: project 'p'/'k' + a slack bot channel + a REAL actors table (the foreign predicate is
// actor-KIND based — pm/qa are agents, operator is human; an author missing from the table is foreign).
function seedDb(path: string, opts: { channel?: boolean } = { channel: true }): DB {
  clean(path);
  const db = openDb(path);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  if (opts.channel !== false)
    db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
  const insA = db.prepare("INSERT INTO actors(id,handle,kind,display_name,active,created_at) VALUES(?,?,?,?,1,'t')");
  insA.run("a-pm", "pm", "agent", "PM"); insA.run("a-qa", "qa", "agent", "QA"); insA.run("a-op", "operator", "human", "Operator");
  return db;
}
let docSeq = 0;
function addDoc(db: DB, slug: string, kind: string, currentVersion = 0): string {
  const id = `doc-${docSeq++}`;
  db.prepare("INSERT INTO documents(id,project_id,kind,slug,title,status,current_version,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?, 't','t')")
    .run(id, "p", kind, slug, slug, currentVersion, "pm");
  return id;
}
const addVer = (db: DB, docId: string, version: number, author: string, createdAt: string, status = "draft") =>
  db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES(?,?,?,?,?,'',?,?,?)")
    .run(`${docId}-v${version}`, docId, version, `body v${version}`, status, version - 1, author, createdAt);
const evc = (db: DB, kind: string) =>
  (db.prepare("SELECT count(*) c FROM events WHERE kind=?").get(kind) as { c: number }).c;
const capturing = () => {
  const cap: { url: string; body: string }[] = [];
  const fetchImpl: FetchImpl = (async (url, init) => { cap.push({ url: String(url), body: String((init as { body?: string })?.body ?? "") }); return { status: 200, json: async () => ({ ok: true }) } as unknown as Response; }) as FetchImpl;
  return { cap, fetchImpl, text: (i: number) => (JSON.parse(cap[i].body) as { text?: string }).text ?? "" };
};
const fBase = (db: DB) => ({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", settleMs: 15 * M });
const dBase = (db: DB) => ({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", pendingMs: 24 * H, remindMs: 24 * H });

// ── docstore.latestForeignVersion — the doc-watch primitive ──────────────────────────────────────
{
  const db = seedDb("/tmp/dl-docn-foreign.db");
  const now = Date.now();
  ok(latestForeignVersion(db, "p", "strategy", "pm") === null, "latestForeignVersion: no such doc → null");
  const id = addDoc(db, "strategy", "strategy");
  addVer(db, id, 1, "pm", isoAgo(now, 5 * H));
  addVer(db, id, 2, "pm", isoAgo(now, 4 * H));
  ok(latestForeignVersion(db, "p", "strategy", "pm") === null, "latestForeignVersion: only SELF versions → null (PM's own drafts never trigger its watch)");
  addVer(db, id, 3, "operator", isoAgo(now, 3 * H));
  let f = latestForeignVersion(db, "p", "strategy", "pm");
  ok(f?.version === 3 && f?.author === "operator", "latestForeignVersion: an operator version IS foreign to pm → {v3, operator}");
  addVer(db, id, 4, "pm", isoAgo(now, 2 * H));
  f = latestForeignVersion(db, "p", "strategy", "pm");
  ok(f?.version === 3 && f?.author === "operator", "latestForeignVersion: a SELF draft on top does not mask the foreign v3 (watch = latest FOREIGN version, not latest version)");
  const g = latestForeignVersion(db, "p", "strategy", "operator");
  ok(g?.version === 4 && g?.author === "pm", "latestForeignVersion: symmetric — pm's v4 is foreign to the operator");
  db.close();
}

// ── docs P3: foreign-edit tick — an unconsumed operator edit → ONE line, deduped per version ──────
{
  const db = seedDb("/tmp/dl-docn-tick.db");
  const now = Date.now();
  const id = addDoc(db, "strategy", "strategy", 1);
  addVer(db, id, 1, "pm", isoAgo(now, 48 * H), "current");
  addVer(db, id, 2, "operator", isoAgo(now, 30 * M)); // a settled (30m > 15m) operator edit
  const { cap, fetchImpl, text } = capturing();
  const n = await docForeignEditNotifyTick({ ...fBase(db), nowMs: now, fetchImpl });
  ok(n === 1 && cap.length === 1 && evc(db, "doc_foreign_edit.notified") === 1, "P3: a settled operator doc version → ONE comms line + the {slug,version} marker");
  ok(text(0).includes("[k]") && text(0).includes("'strategy' v2") && text(0).includes("operator") && text(0).includes("/p/k/doc/strategy") && !text(0).includes("body v2"),
    "P3 §16 line: slug + version + author + the /p/<key>/doc url — never the doc body");
  const n2 = await docForeignEditNotifyTick({ ...fBase(db), nowMs: now + 5 * M, fetchImpl });
  ok(n2 === 0 && cap.length === 1, "P3: the SAME version never re-sends (deduped per version)");
  addVer(db, id, 3, "operator", isoAgo(now, 20 * M)); // a NEWER settled operator edit
  const n3 = await docForeignEditNotifyTick({ ...fBase(db), nowMs: now, fetchImpl });
  ok(n3 === 1 && text(1).includes("'strategy' v3"), "P3: a NEW foreign version past the settle fires again (dedupe is per version, not per doc)");
  db.close();
}

// ── docs P3: self-trigger exclusion + settle window + design exclusion + no-target no-op ──────────
{
  const db = seedDb("/tmp/dl-docn-self.db");
  const now = Date.now();
  const id = addDoc(db, "strategy", "strategy");
  addVer(db, id, 1, "pm", isoAgo(now, 30 * H));
  addVer(db, id, 2, "qa", isoAgo(now, 20 * H));       // agent-authored — loop-internal, never "foreign"
  const design = addDoc(db, "auth", "design");
  addVer(db, design, 1, "operator", isoAgo(now, 20 * H)); // design is excluded (latest-is-live, not PM intake)
  const { cap, fetchImpl } = capturing();
  const n = await docForeignEditNotifyTick({ ...fBase(db), nowMs: now, fetchImpl });
  ok(n === 0 && cap.length === 0 && evc(db, "doc_foreign_edit.notified") === 0, "P3: agent drafts (pm/qa) + a design-doc operator edit → NO line (self-trigger exclusion; design excluded)");
  addVer(db, id, 3, "operator", isoAgo(now, 5 * M));  // operator edit, but only 5m old (settle = 15m)
  const n2 = await docForeignEditNotifyTick({ ...fBase(db), nowMs: now, fetchImpl });
  ok(n2 === 0 && cap.length === 0, "P3: a foreign version YOUNGER than the settle window waits (mid-edit burst collapses to one line)");
  const n3 = await docForeignEditNotifyTick({ ...fBase(db), nowMs: now + 20 * M, fetchImpl });
  ok(n3 === 1 && cap.length === 1, "P3: the same version fires once settled");
  db.close();
  const db2 = seedDb("/tmp/dl-docn-noch.db", { channel: false });
  const id2 = addDoc(db2, "strategy", "strategy");
  addVer(db2, id2, 1, "operator", isoAgo(Date.now(), 30 * H));
  ok((await docForeignEditNotifyTick({ ...fBase(db2), nowMs: Date.now() })) === 0 && evc(db2, "doc_foreign_edit.notified") === 0,
    "P3: no DB channel AND no §9 notify → true no-op (no marker)");
  db2.close();
}

// ── docs P3: startDocForeignEditNotifier gates — passive-only + send-target ───────────────────────
{
  const db = seedDb("/tmp/dl-docn-start.db"); // channel present, NO documents ⇒ the immediate tick sends nothing
  const mk = (intakeMode?: string) => startDocForeignEditNotifier({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", intakeMode });
  const t1 = mk("autonomous");
  ok(t1 === null, "start gate: intake.mode autonomous → NO timer (PM's own doc-watch owns propagation)");
  const t2 = mk(undefined);
  ok(t2 === null, "start gate: intake.mode absent (defaults autonomous) → NO timer");
  const t3 = mk("passive");
  ok(t3 !== null, "start gate: intake.mode passive + a send target → timer started");
  if (t3) clearInterval(t3);
  db.close();
  const db2 = seedDb("/tmp/dl-docn-start2.db", { channel: false });
  const t4 = startDocForeignEditNotifier({ writeDb: db2, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", intakeMode: "passive" });
  ok(t4 === null, "start gate: passive but NO send target → true no-op (no timer)");
  db2.close();
}

// ── docs P6b: drafts-pending — trailing >24h → one DAILY line, deduped per version ────────────────
{
  const db = seedDb("/tmp/dl-docn-drafts.db");
  const now = Date.now();
  const id = addDoc(db, "strategy", "strategy", 12);
  addVer(db, id, 12, "pm", isoAgo(now, 100 * H), "current"); // published v12
  addVer(db, id, 13, "pm", isoAgo(now, 40 * H));             // drafts trailing since 40h ago…
  addVer(db, id, 14, "pm", isoAgo(now, 30 * H));             // …latest draft v14
  const fresh = addDoc(db, "roadmap", "roadmap", 1);
  addVer(db, fresh, 1, "pm", isoAgo(now, 100 * H), "current");
  addVer(db, fresh, 2, "pm", isoAgo(now, 2 * H));            // trailing for only 2h — NOT due
  const { cap, fetchImpl, text } = capturing();
  const n = await docDraftsPendingNotifyTick({ ...dBase(db), nowMs: now, fetchImpl });
  ok(n === 1 && cap.length === 1 && evc(db, "doc_drafts.notified") === 1, "P6b: ONE line for the doc trailing >24h; the fresh (2h) one waits");
  ok(text(0).includes("[k] strategy: draft v14 pending over published v12") && text(0).includes("/p/k/doc/strategy") && !text(0).includes("body v14"),
    "P6b §16 line: 'draft v14 pending over published v12' + the /p/<key>/doc url — never the doc body");
  const n2 = await docDraftsPendingNotifyTick({ ...dBase(db), nowMs: now + H, fetchImpl });
  ok(n2 === 0 && cap.length === 1, "P6b: the SAME version within the remind period → deduped (no second line)");
  const n3 = await docDraftsPendingNotifyTick({ ...dBase(db), nowMs: now + 25 * H, fetchImpl });
  ok(n3 >= 1 && text(cap.length - 1).includes("strategy"), "P6b: the same version past the remind period → the DAILY line re-fires");
  db.close();
}

// ── docs P6b: a NEW draft version re-announces; never-published, design + up-to-date docs are silent ──
{
  const db = seedDb("/tmp/dl-docn-drafts2.db");
  const now = Date.now();
  const id = addDoc(db, "strategy", "strategy", 1);
  addVer(db, id, 1, "pm", isoAgo(now, 90 * H), "current");
  addVer(db, id, 2, "pm", isoAgo(now, 50 * H));
  // a FRESH marker already covers v2…
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',NULL,'daemon','doc_drafts.notified',?,?)")
    .run(JSON.stringify({ slug: "strategy", version: 2 }), isoAgo(now, 2 * H));
  const { fetchImpl, text } = capturing();
  ok((await docDraftsPendingNotifyTick({ ...dBase(db), nowMs: now, fetchImpl })) === 0, "P6b: fresh marker for the latest version → silent");
  addVer(db, id, 3, "pm", isoAgo(now, 1 * H)); // a NEW draft lands (trailing-since is still v2's 50h)
  const n = await docDraftsPendingNotifyTick({ ...dBase(db), nowMs: now, fetchImpl });
  ok(n === 1 && text(0).includes("draft v3 pending over published v1"), "P6b: a NEW draft version re-announces immediately (dedupe is per version; the trailing clock does NOT reset)");
  db.close();
  const db2 = seedDb("/tmp/dl-docn-drafts3.db");
  const now2 = Date.now();
  const un = addDoc(db2, "notes", "notes", 0);           // never published
  addVer(db2, un, 1, "pm", isoAgo(now2, 30 * H));
  const de = addDoc(db2, "auth", "design", 0);           // design: latest IS live — never "pending"
  addVer(db2, de, 1, "pm", isoAgo(now2, 90 * H));
  const cur = addDoc(db2, "roadmap", "roadmap", 2);      // published == latest — nothing pending
  addVer(db2, cur, 1, "pm", isoAgo(now2, 90 * H));
  addVer(db2, cur, 2, "pm", isoAgo(now2, 80 * H), "current");
  const { cap: cap2, fetchImpl: f2, text: t2 } = capturing();
  const n2 = await docDraftsPendingNotifyTick({ ...dBase(db2), nowMs: now2, fetchImpl: f2 });
  ok(n2 === 1 && cap2.length === 1 && t2(0).includes("notes: draft v1 pending (never published)"),
    "P6b: never-published doc says so; design + up-to-date docs stay silent");
  db2.close();
}

// ── docs P6b: start guard — a send target is required ─────────────────────────────────────────────
{
  const db = seedDb("/tmp/dl-docn-dstart.db"); // channel, no docs ⇒ immediate tick sends nothing
  const t1 = startDocDraftsPendingNotifier({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787" });
  ok(t1 !== null, "drafts-pending start: a send target ⇒ timer started (no intake-mode gate — it applies in BOTH modes)");
  if (t1) clearInterval(t1);
  db.close();
  const db2 = seedDb("/tmp/dl-docn-dstart2.db", { channel: false });
  const t2 = startDocDraftsPendingNotifier({ writeDb: db2, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787" });
  ok(t2 === null, "drafts-pending start: no channel AND no §9 notify ⇒ true no-op (no timer)");
  db2.close();
}

// ── DL-34: dry-run is WRITE-FREE for BOTH ticks — no network, no marker (child process) ───────────
{
  const DDB = "/tmp/dl-docn-dry.db";
  clean(DDB);
  const child = `
    import { openDb } from "${CWD}/src/db.ts";
    import { docForeignEditNotifyTick, docDraftsPendingNotifyTick } from "${CWD}/src/daemon-notifiers.ts";
    const db = openDb(process.env.DDB);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
    db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
    db.prepare("INSERT INTO actors(id,handle,kind,display_name,active,created_at) VALUES('a-pm','pm','agent','PM',1,'t')").run();
    const now = Date.now(), iso = (ms) => new Date(now - ms).toISOString();
    db.prepare("INSERT INTO documents(id,project_id,kind,slug,title,status,current_version,created_by,created_at,updated_at) VALUES('d1','p','strategy','strategy','strategy','draft',1,'pm','t','t')").run();
    db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES('d1-v1','d1',1,'b','current','',0,'pm',?)").run(iso(90*3600000));
    db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES('d1-v2','d1',2,'b','draft','',1,'operator',?)").run(iso(30*3600000));
    let preview = "", fetched = false;
    const origErr = console.error; console.error = (m) => { preview += String(m) + "\\n"; };
    const f = async () => { fetched = true; return { status: 200, json: async () => ({ ok: true }) }; };
    const base = { writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", nowMs: now, fetchImpl: f };
    const nF = await docForeignEditNotifyTick({ ...base, settleMs: 900000 });
    const nD = await docDraftsPendingNotifyTick({ ...base, pendingMs: 86400000, remindMs: 86400000 });
    console.error = origErr;
    const markers = db.prepare("SELECT count(*) c FROM events WHERE kind IN ('doc_foreign_edit.notified','doc_drafts.notified')").get().c;
    console.log(JSON.stringify({ nF, nD, fetched, markers, previewHasEdit: preview.includes("doc edit"), previewHasDrafts: preview.includes("drafts-pending") }));
    db.close();
  `;
  const out = execFileSync("node", ["--input-type=module", "-e", child],
    { env: { ...process.env, DDB, DEVLOOP_CHANNEL_DRYRUN: "1" }, encoding: "utf8" });
  const res = JSON.parse(out.trim().split("\n").pop() as string);
  ok(res.markers === 0 && res.fetched === false, "DL-34: dry-run is write-free for both doc ticks — NO marker, NO network");
  ok(res.previewHasEdit && res.previewHasDrafts, "DL-34: the dry-run previews name the doc-edit + drafts-pending lines");
  clean(DDB);
}

console.log(fails === 0 ? "\nDOC_NOTIFY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
