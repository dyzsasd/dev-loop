// DL-26 Human-Blocked notifier — regression tests.
// Covers the core lifecycle (first-ping / throttle / reminder / no-channel) plus the two bugs QA
// filed against the first cut: DL-33 (per-TICK cap, never permanently silent) and DL-34 (dry-run is
// write-free; a later live tick on the same DB still fires the first ping — the DL-11 invariant).
// The live cases inject a stub fetchImpl (no network); the dry-run case runs in a CHILD process
// because DEVLOOP_CHANNEL_DRYRUN is read once at channel.ts import time.
import { openDb } from "../src/db.ts";
import { blockedNotifyTick } from "../src/daemon.ts";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { FetchImpl } from "../src/channel.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

process.env.TESTTOK = "xoxb-test"; // resolveCreds reads this env NAME (channels.config_ref); truthy ⇒ slack send attempts
const okFetch: FetchImpl = (async () => ({ status: 200, json: async () => ({ ok: true }) }) as unknown as Response) as FetchImpl;
const CWD = process.cwd();
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const evc = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT count(*) c FROM events WHERE kind='human_blocked.notified'").get() as { c: number }).c;
function seed(path: string, nTickets: number) {
  clean(path);
  const db = openDb(path);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
  for (let i = 0; i < nTickets; i++)
    db.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')")
      .run("HB" + i, "p", "t" + i, "Human-Blocked");
  return db;
}
const base = (db: ReturnType<typeof openDb>) =>
  ({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", cadenceMs: 3_600_000, fetchImpl: okFetch });

// ── core lifecycle (live) ────────────────────────────────────────────────────
{
  const db = seed("/tmp/dl-blk-core.db", 1);
  const now = Date.now();
  const s1 = await blockedNotifyTick({ ...base(db), nowMs: now });
  ok(s1 === 1 && evc(db) === 1, "first ping fires on detection + writes the marker (live)");
  const s2 = await blockedNotifyTick({ ...base(db), nowMs: now + 1000 });
  ok(s2 === 0, "throttled within cadence (no re-send)");
  const m = (db.prepare("SELECT created_at c FROM events WHERE kind='human_blocked.notified' LIMIT 1").get() as { c: string }).c;
  const s3 = await blockedNotifyTick({ ...base(db), nowMs: Date.parse(m) + 3_600_000 + 5000 });
  ok(s3 === 1 && evc(db) === 2, "reminder fires after the cadence elapses");
  db.close();
}

// ── DL-33: PER-TICK cap — a long-running daemon never goes permanently silent ──
{
  const db = seed("/tmp/dl-blk-cap.db", 61); // > CHANNEL_SEND_CAP (60)
  const now = Date.now();
  const t1 = await blockedNotifyTick({ ...base(db), nowMs: now });      // capped at 60 this tick
  const t2 = await blockedNotifyTick({ ...base(db), nowMs: now + 10 }); // the 61st (still unmarked) is due
  ok(t1 === 60, "DL-33: a single tick is bounded to CHANNEL_SEND_CAP (60)");
  ok(t2 >= 1, "DL-33: a second tick STILL notifies (a per-process counter would give 0 — permanently silent)");
  db.close();
}

// ── no enabled channel ⇒ true no-op ──────────────────────────────────────────
{
  const db = seed("/tmp/dl-blk-noch.db", 1);
  db.prepare("UPDATE channels SET enabled=0").run();
  const s = await blockedNotifyTick({ ...base(db), nowMs: Date.now() });
  ok(s === 0, "no enabled channel ⇒ no-op");
  db.close();
}

// ── DL-34: dry-run is write-free; a later live tick still fires the first ping ─
{
  const DDB = "/tmp/dl-blk-dryrun.db";
  clean(DDB);
  const childSeedAndDryTick = `
    import { openDb } from "${CWD}/src/db.ts";
    import { blockedNotifyTick } from "${CWD}/src/daemon.ts";
    const db = openDb(process.env.DDB);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
    db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
    db.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('HB','p','t','Human-Blocked',0,'[]','[]','pm','t','t')").run();
    const n = await blockedNotifyTick({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "x", cadenceMs: 3600000, nowMs: Date.now() });
    console.log("DRY n=" + n);
    db.close();
  `;
  execFileSync("node", ["--input-type=module", "-e", childSeedAndDryTick],
    { env: { ...process.env, DDB, DEVLOOP_CHANNEL_DRYRUN: "1" }, encoding: "utf8" });
  const db = openDb(DDB); // parent is LIVE (DEVLOOP_CHANNEL_DRYRUN unset)
  ok(evc(db) === 0, "DL-34: dry-run wrote NO human_blocked.notified marker (write-free)");
  const live = await blockedNotifyTick({ ...base(db), nowMs: Date.now() });
  ok(live === 1 && evc(db) === 1, "DL-34: a later LIVE tick on the same DB still fires the first ping");
  db.close();
}

// ── DL-52: the notifier sends over a WEBHOOK-transport channel (one-way, no bot app) ──
{
  process.env.HOOKURL = "https://hooks.test/abc123";
  const db = seed("/tmp/dl-blk-webhook.db", 1);                       // seed() makes a bot channel…
  db.prepare("UPDATE channels SET transport='webhook', config_ref='HOOKURL'").run(); // …switch it to webhook + the URL env NAME
  const cap: { url: string; body: string }[] = [];
  const capFetch: FetchImpl = (async (url, init) => { cap.push({ url: String(url), body: String((init as { body?: string })?.body ?? "") }); return { status: 200, json: async () => ({}) } as unknown as Response; }) as FetchImpl;
  const n = await blockedNotifyTick({ ...base(db), nowMs: Date.now(), fetchImpl: capFetch });
  ok(n === 1 && cap.length === 1 && cap[0].url === "https://hooks.test/abc123", "DL-52: a webhook-transport channel → the notifier POSTs to the incoming-webhook URL (no bot API, no token)");
  ok(JSON.parse(cap[0].body).text.includes("HB0") && evc(db) === 1, "DL-52: the webhook carries the §9 one-line (ticket id) + the marker is written on success");
  db.close();
  delete process.env.HOOKURL;
}

// ── DL-52: a webhook whose URL env-var is UNSET → fails closed (no POST, no marker; retried next tick) ──
{
  const db = seed("/tmp/dl-blk-webhook-unset.db", 1);
  db.prepare("UPDATE channels SET transport='webhook', config_ref='DEFINITELY_UNSET_ENV'").run();
  let called = false;
  const noFetch: FetchImpl = (async () => { called = true; return { status: 200, json: async () => ({}) } as unknown as Response; }) as FetchImpl;
  const n = await blockedNotifyTick({ ...base(db), nowMs: Date.now(), fetchImpl: noFetch });
  ok(n === 0 && !called && evc(db) === 0, "DL-52: a webhook with an unset URL env → fails closed (no POST, no marker — retried next tick)");
  db.close();
}

// ── DL-52: a webhook channel under DRYRUN previews (type + msg) but does NO network + NO marker (DL-34 class) ──
// child process: DEVLOOP_CHANNEL_DRYRUN is read once at channel.ts import; capture the preview via console.error.
{
  const WDB = "/tmp/dl-blk-webhook-dry.db";
  clean(WDB);
  const childWebhookDry = `
    import { openDb } from "${CWD}/src/db.ts";
    import { blockedNotifyTick } from "${CWD}/src/daemon.ts";
    const db = openDb(process.env.DDB);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
    db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,transport,enabled,created_at,updated_at) VALUES('c','p','slack','HOOKURL',NULL,'C1','webhook',1,'t','t')").run();
    db.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('HB','p','t','Human-Blocked',0,'[]','[]','pm','t','t')").run();
    let preview = "", fetched = false;
    const origErr = console.error; console.error = (m) => { preview += String(m) + "\\n"; };
    const f = async () => { fetched = true; return { status: 200, json: async () => ({}) }; };
    const n = await blockedNotifyTick({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", cadenceMs: 3600000, nowMs: Date.now(), fetchImpl: f });
    console.error = origErr;
    const markers = db.prepare("SELECT count(*) c FROM events WHERE kind='human_blocked.notified'").get().c;
    console.log(JSON.stringify({ n, fetched, markers, previewHasWebhook: preview.includes("webhook"), previewHasId: preview.includes("HB") }));
    db.close();
  `;
  const out = execFileSync("node", ["--input-type=module", "-e", childWebhookDry],
    { env: { ...process.env, DDB: WDB, DEVLOOP_CHANNEL_DRYRUN: "1", HOOKURL: "https://hooks.test/xyz" }, encoding: "utf8" });
  const res = JSON.parse(out.trim().split("\n").pop() as string);
  ok(res.markers === 0 && res.fetched === false, "DL-52/DL-34: a webhook channel under dry-run → NO network call, NO marker (write-free)");
  ok(res.previewHasWebhook && res.previewHasId, "DL-52: the dry-run preview names the transport (webhook) + the ticket id (the intended POST)");
  clean(WDB);
}

console.log(fails === 0 ? "\nBLOCKED_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
