// P0-1c loop fire-health self-monitor — regression tests (harness: test/no-progress.ts).
// Covers: (a) ONE alert on a degraded window (§16 one-liner with the errorClass tallies) + the marker,
// (b) same-episode de-dup, (c) the healthy-window recovery line + recovered marker, (d) a fresh alert
// when it degrades AGAIN after recovery, (e) an insufficient sample (breaker probing) is neither
// degraded nor healthy — the open episode stays silent, (f) healthy-with-no-episode is a no-op,
// (g) the no-target true no-op and the start guards (windowHours 0 / no ledger ⇒ null).
import { openDb } from "../src/db.ts";
import { fireHealthNotifyTick, startFireHealthNotifier } from "../src/daemon.ts";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FetchImpl } from "../src/channel.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

process.env.TESTTOK = "xoxb-test";
const ROOT = "/tmp/dl-fire-health";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };

function seedDb(path: string, opts: { channel: boolean }) {
  clean(path);
  const db = openDb(path);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  if (opts.channel)
    db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
  return db;
}
const capturing = () => {
  const cap: { body: string }[] = [];
  const fetchImpl: FetchImpl = (async (_url, init) => { cap.push({ body: String((init as { body?: string })?.body ?? "") }); return { status: 200, json: async () => ({ ok: true }) } as unknown as Response; }) as FetchImpl;
  return { cap, fetchImpl };
};
const H = 3_600_000;
const T = Date.now();

// Synthetic fires.jsonl: n rows ending at `endMs`, spaced 1min apart, `okCount` of them exit 0,
// failures stamped errorClass spend-limit (the field shape).
let ledgerN = 0;
function writeLedger(rows: Array<{ exitCode: number; atMs: number; errorClass?: string }>): string {
  const p = join(ROOT, `fires-${++ledgerN}.jsonl`);
  writeFileSync(p, rows.map((r) => JSON.stringify({
    ts: new Date(r.atMs).toISOString(), agent: "pm", project: "k", durationMs: 2000,
    exitCode: r.exitCode, timedOut: false, ...(r.errorClass ? { errorClass: r.errorClass } : {}),
  })).join("\n") + "\n");
  return p;
}
const burst = (endMs: number, fails_: number, oks: number) => writeLedger([
  ...Array.from({ length: fails_ }, (_, i) => ({ exitCode: 1, atMs: endMs - (fails_ + oks - i) * 60_000, errorClass: "spend-limit" })),
  ...Array.from({ length: oks }, (_, i) => ({ exitCode: 0, atMs: endMs - (oks - i) * 60_000 })),
]);
const markers = (db: ReturnType<typeof openDb>, kind: string) =>
  (db.prepare("SELECT count(*) c FROM events WHERE kind=?").get(kind) as { c: number }).c;
const base = (db: ReturnType<typeof openDb>, ledgerPath: string) =>
  ({ writeDb: db, projectId: "p", projectKey: "k", baseUrl: "http://127.0.0.1:8787", ledgerPath, windowMs: 2 * H, minFires: 6, threshold: 0.5 });

// (a)+(b) degraded window → ONE alert with the taxonomy; a second tick stays silent (same episode)
{
  const db = seedDb(join(ROOT, "a.db"), { channel: true });
  const { cap, fetchImpl } = capturing();
  const led = burst(T, 9, 1); // 10 fires, 10% success
  const n1 = await fireHealthNotifyTick({ ...base(db, led), nowMs: T, fetchImpl });
  ok(n1 === 1 && markers(db, "fire_health.notified") === 1, "degraded window → one alert + one marker");
  ok(cap.length === 1 && /loop health: fire success 10% over the last 2h \(10 fires — spend-limit×9\)/.test(cap[0].body),
    `the §16 line carries rate + sample + errorClass tallies (got ${cap[0]?.body.slice(0, 160)})`);
  const n2 = await fireHealthNotifyTick({ ...base(db, led), nowMs: T + 10 * 60_000, fetchImpl });
  ok(n2 === 0 && markers(db, "fire_health.notified") === 1, "same episode → de-duped (no second send)");

  // (e) insufficient sample while the episode is open (breaker probing) → silent, NOT a recovery
  const probe = burst(T + 4 * H, 0, 2); // only 2 fires in the window — below minFires
  const n3 = await fireHealthNotifyTick({ ...base(db, probe), nowMs: T + 4 * H, fetchImpl });
  ok(n3 === 0 && markers(db, "fire_health.recovered") === 0, "insufficient sample → neither alert nor premature recovery");

  // (c) a real healthy window after the alert → ONE recovery line + recovered marker
  const healed = burst(T + 8 * H, 1, 9); // 90% success
  const n4 = await fireHealthNotifyTick({ ...base(db, healed), nowMs: T + 8 * H, fetchImpl });
  ok(n4 === 1 && markers(db, "fire_health.recovered") === 1 && /loop health recovered: fire success 90%/.test(cap.at(-1)!.body),
    "healthy window after the alert → one recovery line + marker");
  const n5 = await fireHealthNotifyTick({ ...base(db, healed), nowMs: T + 9 * H, fetchImpl });
  ok(n5 === 0, "healthy with the episode closed → silent");

  // (d) degrades AGAIN → a fresh alert (new episode)
  const again = burst(T + 12 * H, 8, 2);
  const n6 = await fireHealthNotifyTick({ ...base(db, again), nowMs: T + 12 * H, fetchImpl });
  ok(n6 === 1 && markers(db, "fire_health.notified") === 2, "recovered-then-degraded → a fresh alert (episode 2)");
  db.close();
}

// (f) healthy with no prior episode → no-op; (g) no target → true no-op
{
  const db = seedDb(join(ROOT, "f.db"), { channel: true });
  const { cap, fetchImpl } = capturing();
  ok((await fireHealthNotifyTick({ ...base(db, burst(T, 0, 10)), nowMs: T, fetchImpl })) === 0 && cap.length === 0,
    "healthy, no episode → nothing sent");
  db.close();
  const noCh = seedDb(join(ROOT, "g.db"), { channel: false });
  ok((await fireHealthNotifyTick({ ...base(noCh, burst(T, 9, 1)), nowMs: T, fetchImpl })) === 0,
    "no channel/notify → true no-op even when degraded");
  // start guards
  ok(startFireHealthNotifier({ ...base(noCh, burst(T, 9, 1)), windowHours: 2, minFires: 6, threshold: 0.5 } as never) === null,
    "start: no send target → null (never a dead timer)");
  const chDb = seedDb(join(ROOT, "h.db"), { channel: true });
  ok(startFireHealthNotifier({ writeDb: chDb, projectId: "p", projectKey: "k", baseUrl: "x", ledgerPath: "", windowHours: 2, minFires: 6, threshold: 0.5 }) === null,
    "start: no fires ledger (legacy daemon) → null");
  ok(startFireHealthNotifier({ writeDb: chDb, projectId: "p", projectKey: "k", baseUrl: "x", ledgerPath: "/tmp/x.jsonl", windowHours: 0, minFires: 6, threshold: 0.5 }) === null,
    "start: windowHours 0 → opted out (null)");
  noCh.close(); chDb.close();
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "fire-health: all checks passed");
process.exit(fails ? 1 : 0);
