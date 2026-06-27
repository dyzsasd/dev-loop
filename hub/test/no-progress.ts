// DL-76 loop no-progress / runaway circuit-breaker — regression tests.
// Covers the AC: (a) ONE alert fires on a stall (0 issue.transition→Done in the rolling window) + the §16
// one-liner shape, (b) no double-send within a stall episode (de-dup like the Human-Blocked reminder), the
// resume→re-stall fresh-alert, the healthy + cold-start non-alert paths, (c) the true no-op when no channel
// /notify is configured (+ the startNoProgressNotifier guards), and (d) dry-run is write-free (NO marker, NO
// network — so a later live tick still fires the first ping). The live cases inject a stub fetchImpl (no
// network); the dry-run case runs in a CHILD process because DEVLOOP_CHANNEL_DRYRUN is read once at
// channel.ts import. Deterministic: synthetic events are placed at controlled created_at relative to a real
// `now` anchor (hours apart, so the ms skew between the injected nowMs and logEvent's real-now marker is
// irrelevant); the de-dup tests insert a raw `no_progress.notified` marker to fully control episode timing.
import { openDb } from "../src/db.ts";
import { noProgressNotifyTick, startNoProgressNotifier } from "../src/daemon.ts";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { FetchImpl } from "../src/channel.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

process.env.TESTTOK = "xoxb-test"; // resolveCreds reads this env NAME (channels.config_ref); truthy ⇒ slack send attempts
const okFetch: FetchImpl = (async () => ({ status: 200, json: async () => ({ ok: true }) }) as unknown as Response) as FetchImpl;
const CWD = process.cwd();
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const H = 3_600_000;             // 1h in ms
const W = 2 * H;                 // a 2h rolling window for every case

function seedDb(path: string, opts: { channel: boolean }) {
  clean(path);
  const db = openDb(path);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  if (opts.channel)
    db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
  return db;
}
const isoOf = (ms: number) => new Date(ms).toISOString();
type DB = ReturnType<typeof openDb>;
const ins = (db: DB, kind: string, data: unknown, ms: number) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',NULL,'dev',?,?,?)")
    .run(kind, JSON.stringify(data), isoOf(ms));
const done = (db: DB, ms: number) => ins(db, "issue.transition", { from: "In Review", to: "Done" }, ms);
const churn = (db: DB, ms: number) => ins(db, "issue.transition", { from: "Todo", to: "In Progress" }, ms); // loop firing, not completing
const rawMarker = (db: DB, ms: number) => // a controlled prior alert (deterministic de-dup episode timing)
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',NULL,'daemon','no_progress.notified','{}',?)").run(isoOf(ms));
const npc = (db: DB) => (db.prepare("SELECT count(*) c FROM events WHERE kind='no_progress.notified'").get() as { c: number }).c;
const base = (db: DB) => ({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", fetchImpl: okFetch });
const capturing = () => {
  const cap: { url: string; body: string }[] = [];
  const fetchImpl: FetchImpl = (async (url, init) => { cap.push({ url: String(url), body: String((init as { body?: string })?.body ?? "") }); return { status: 200, json: async () => ({ ok: true }) } as unknown as Response; }) as FetchImpl;
  return { cap, fetchImpl };
};

// ── stall → ONE alert + the §16 one-liner; then a continued stall is de-duped (no double-send) ──
{
  const db = seedDb("/tmp/dl-np-stall.db", { channel: true });
  const T = Date.now();
  churn(db, T - 5 * H); done(db, T - 5 * H);  // history + last Done 5h ago (OUTSIDE the 2h window)
  churn(db, T - 30 * 60_000);                  // recent activity: the loop IS firing, just not completing
  const { cap, fetchImpl } = capturing();
  const n = await noProgressNotifyTick({ ...base(db), windowMs: W, nowMs: T, fetchImpl });
  ok(n === 1 && npc(db) === 1 && cap.length === 1, "stall (0 Done in window, loop still firing) → ONE alert + marker written");
  const text = cap.length ? (JSON.parse(cap[0].body) as { text: string }).text : "";
  ok(text.includes("[k]") && text.includes("no-progress") && text.includes("/activity") && !text.includes("xoxb"),
    "§16: the alert one-liner carries project + the window + the /activity link, never a secret");
  const n2 = await noProgressNotifyTick({ ...base(db), windowMs: W, nowMs: T + 60_000, fetchImpl });
  ok(n2 === 0 && npc(db) === 1 && cap.length === 1, "continued stall (no Done since the alert) → de-duped, NO second send");
  db.close();
}

// ── de-dup, deterministic: already alerted, no Done since ⇒ stay silent (the AC's no-double-send) ──
{
  const db = seedDb("/tmp/dl-np-dedupe.db", { channel: true });
  const T = Date.now();
  churn(db, T - 12 * H); done(db, T - 12 * H);  // an old Done (12h ago)
  rawMarker(db, T - 8 * H);                       // we alerted 8h ago; NO Done since
  const n = await noProgressNotifyTick({ ...base(db), windowMs: W, nowMs: T });
  ok(n === 0 && npc(db) === 1, "same stall episode (alerted, no Done since) → stays silent (no re-alert)");
  db.close();
}

// ── resume → re-stall → a FRESH alert fires for the new episode ──
{
  const db = seedDb("/tmp/dl-np-resume.db", { channel: true });
  const T = Date.now();
  churn(db, T - 12 * H); done(db, T - 12 * H);  // old Done (12h ago)
  rawMarker(db, T - 8 * H);                       // alerted 8h ago…
  done(db, T - 5 * H);                            // …then accepted change RESUMED 5h ago, then stalled again
  const before = npc(db);                         // 1 (the raw marker)
  const n = await noProgressNotifyTick({ ...base(db), windowMs: W, nowMs: T });
  ok(n === 1 && npc(db) === before + 1, "resume-then-stall-again → a FRESH alert fires for the new episode");
  db.close();
}

// ── healthy: a Done INSIDE the window ⇒ no alert ──
{
  const db = seedDb("/tmp/dl-np-healthy.db", { channel: true });
  const T = Date.now();
  churn(db, T - 5 * H);          // history before the window
  done(db, T - 30 * 60_000);     // a Done 30m ago — inside the 2h window → accepted change present
  const n = await noProgressNotifyTick({ ...base(db), windowMs: W, nowMs: T });
  ok(n === 0 && npc(db) === 0, "healthy (a Done inside the window) → no alert, no marker");
  db.close();
}

// ── cold start: a loop younger than the window ⇒ never cries wolf ──
{
  const db = seedDb("/tmp/dl-np-cold.db", { channel: true });
  const T = Date.now();
  churn(db, T - 20 * 60_000);    // only recent activity; NOTHING older than the 2h window, and no Done ever
  const n = await noProgressNotifyTick({ ...base(db), windowMs: W, nowMs: T });
  ok(n === 0 && npc(db) === 0, "cold start (no history before the window) → no premature alert");
  db.close();
}

// ── no channel AND no §9 notify ⇒ true no-op (mirrors DL-59) ──
{
  const db = seedDb("/tmp/dl-np-noch.db", { channel: false });
  const T = Date.now();
  churn(db, T - 5 * H); done(db, T - 5 * H); churn(db, T - 30 * 60_000); // a real stall exists…
  const n = await noProgressNotifyTick({ ...base(db), windowMs: W, nowMs: T }); // …but no send target
  ok(n === 0 && npc(db) === 0, "no DB channel AND no §9 notify → true no-op (no marker, no send)");
  db.close();
}

// ── DL-59 fallback: a §9 notify webhook (no DB channel) is the send target ──
{
  const db = seedDb("/tmp/dl-np-notify.db", { channel: false });
  const T = Date.now();
  churn(db, T - 5 * H); done(db, T - 5 * H); churn(db, T - 30 * 60_000);
  const { cap, fetchImpl } = capturing();
  const n = await noProgressNotifyTick({ ...base(db), windowMs: W, nowMs: T, fetchImpl, notify: { type: "slack", webhook: "https://hooks.test/np-9" } });
  ok(n === 1 && cap.length === 1 && cap[0].url === "https://hooks.test/np-9" && npc(db) === 1,
    "DL-59: notify-only (no DB channel) → the §9 notify webhook fires + the marker is written on success");
  db.close();
}

// ── startNoProgressNotifier guards (config-gate + send-target) ──
{
  const db = seedDb("/tmp/dl-np-start.db", { channel: true }); // a channel, but NO events ⇒ the immediate run no-ops at the cold-start guard (no network)
  const t0 = startNoProgressNotifier({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", windowHours: 0, notify: { type: "slack", webhook: "https://hooks.test/x" } });
  ok(t0 === null, "startNoProgressNotifier: windowHours≤0 ⇒ no timer (disabled)");
  const t1 = startNoProgressNotifier({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", windowHours: 2, notify: { type: "slack", webhook: "https://hooks.test/x" } });
  ok(t1 !== null, "startNoProgressNotifier: window>0 + a configured channel ⇒ timer started");
  if (t1) clearInterval(t1);
  db.close();
  const db2 = seedDb("/tmp/dl-np-start2.db", { channel: false });
  const t2 = startNoProgressNotifier({ writeDb: db2, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", windowHours: 2, notify: undefined });
  ok(t2 === null, "startNoProgressNotifier: window>0 but no channel AND no §9 notify ⇒ true no-op (no timer)");
  if (t2) clearInterval(t2);
  db2.close();
}

// ── DL-34: dry-run is WRITE-FREE — NO marker, NO network (a later live tick still fires the first ping) ──
// child process: DEVLOOP_CHANNEL_DRYRUN is read once at channel.ts import; capture the preview via console.error.
{
  const DDB = "/tmp/dl-np-dryrun.db";
  clean(DDB);
  const child = `
    import { openDb } from "${CWD}/src/db.ts";
    import { noProgressNotifyTick } from "${CWD}/src/daemon.ts";
    const db = openDb(process.env.DDB);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
    db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
    const T = Date.now(), W = 7200000, iso = (ms) => new Date(ms).toISOString();
    const ins = (kind, data, ms) => db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',NULL,'dev',?,?,?)").run(kind, JSON.stringify(data), iso(ms));
    ins("issue.transition", { to: "In Progress" }, T - 5*3600000);
    ins("issue.transition", { to: "Done" }, T - 5*3600000);   // last Done 5h ago (outside window) → stalled + hasHistory
    let preview = "", fetched = false;
    const origErr = console.error; console.error = (m) => { preview += String(m) + "\\n"; };
    const f = async () => { fetched = true; return { status: 200, json: async () => ({ ok: true }) }; };
    const n = await noProgressNotifyTick({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", windowMs: W, nowMs: T, fetchImpl: f });
    console.error = origErr;
    const markers = db.prepare("SELECT count(*) c FROM events WHERE kind='no_progress.notified'").get().c;
    console.log(JSON.stringify({ n, fetched, markers, previewHasNoProgress: preview.includes("no-progress"), previewHasTarget: preview.includes("slack") }));
    db.close();
  `;
  const out = execFileSync("node", ["--input-type=module", "-e", child],
    { env: { ...process.env, DDB, DEVLOOP_CHANNEL_DRYRUN: "1" }, encoding: "utf8" });
  const res = JSON.parse(out.trim().split("\n").pop() as string);
  ok(res.markers === 0 && res.fetched === false, "DL-34: dry-run is write-free — NO marker, NO network (a later live tick still fires the first ping)");
  ok(res.previewHasNoProgress && res.previewHasTarget, "DL-34: the dry-run preview names the no-progress alert + the channel target");
  clean(DDB);
}

console.log(fails === 0 ? "\nNOPROGRESS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
