// startProjectNotifiers — the daemon's per-project notifier wiring, unit-tested without a socket.
// This arm was the post-1.8 CRAP ceiling (156) purely for lack of coverage: spawned daemons die by
// SIGKILL before V8 flushes, so the listen path never registered as covered. Contracts: (1) with no
// send target every notifier is a no-op and only the WAL checkpoint arms; (2) with a §9 notify config
// the timer-backed notifiers arm and return stoppable timers; (3) the active list names what armed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { startProjectNotifiers } from "../src/daemon.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = mkdtempSync(join(tmpdir(), "dl-notifier-wiring-"));
try {
  const db = openDb(join(tmp, "hub.db"));
  const projectId = ensureSeed(db, "nw", "Notifier Wiring", "NW");
  const lines: string[] = [];
  const base = {
    writeDb: db, projectId, projectKey: "nw", baseUrl: "http://127.0.0.1:0", dbPath: join(tmp, "hub.db"),
    cadenceHours: 24, noProgressWindowHours: 0, fhWindowHours: 2, fhMinFires: 6, fhThreshold: 0.5,
    projCfg: undefined, log: (l: string) => lines.push(l),
  };

  // 1. no send target anywhere → every notifier no-ops; only the WAL checkpoint arms.
  const bare = startProjectNotifiers({ ...base, notify: undefined });
  ok(bare.active.length === 1 && bare.active[0] === "wal-checkpoint",
    `no channel + no notify ⇒ only wal-checkpoint arms (got ${bare.active.join(", ")})`);
  ok(bare.timers.length === 0, "no timers armed when everything no-ops");

  // 2. a §9 notify config arms the timer-backed notifiers (blocked + fire-health need a target;
  //    no-progress stays off at windowHours 0 — the explicit opt-out).
  const notify = { type: "slack", webhookEnv: "DLTEST_NW_WEBHOOK" };
  const ledger = join(tmp, "fires.jsonl");
  writeFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), agent: "pm", project: "nw", durationMs: 1, exitCode: 0, timedOut: false }) + "\n");
  const armed = startProjectNotifiers({ ...base, notify, noProgressWindowHours: 2, ledgerPath: ledger });
  ok(armed.active.includes("blocked"), `notify target ⇒ the Human-Blocked notifier arms (got ${armed.active.join(", ")})`);
  ok(armed.active.includes("no-progress"), "windowHours>0 + target ⇒ the no-progress detector arms");
  ok(armed.active.includes("fire-health"), "the P0-1c fire-health monitor arms");
  ok(armed.timers.length >= 3, `armed notifiers return stoppable timers (got ${armed.timers.length})`);
  ok(lines.some((l) => l.includes("decision-queue notifier active")), "the wiring logs what armed");
  for (const t of armed.timers) clearInterval(t);

  // 3. cadence 0 = the blocked notifier's explicit opt-out even with a target.
  const optOut = startProjectNotifiers({ ...base, notify, cadenceHours: 0 });
  ok(!optOut.active.includes("blocked"), "cadenceHours 0 ⇒ the blocked notifier stays off (explicit opt-out)");
  for (const t of optOut.timers) clearInterval(t);

  db.close();
  console.log(fails === 0 ? "\nNOTIFIER_WIRING_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
