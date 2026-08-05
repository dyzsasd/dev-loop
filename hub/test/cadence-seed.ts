// LOOP-273 — a runner RESTART must not be a cadence reset.
//
// `dev-loop run` seeded every slot's first fire from PROCESS START, so each restart fired every
// selected slot regardless of when it last ran. For a slow slot that is a full cadence per restart:
// reflect, on a 1d cadence, fired 5× in 13h (~$18) because the runner restarted five times.
//
// `scheduler-gate.json` records `firedAt` only for the four gated slots, so sweep/reflect had
// nothing to schedule from. The per-fire LEDGER records every fire of every agent, and that is the
// right anchor — matched by AGENT across all projects, because slots are per-agent and the target
// project is chosen when the slot fires.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastFirePerAgent, seedSlotNextAt } from "../src/run-agents-seed.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-cadence-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const HOUR = 3_600_000, DAY = 24 * HOUR;

try {
  const now = Date.parse("2026-08-06T12:00:00.000Z");
  const ledger = join(tmp, "fires.jsonl");
  const row = (agent: string, iso: string, project = "p") => JSON.stringify({ ts: iso, agent, project, fireId: `${agent}-${iso}`, exitCode: 0 });
  writeFileSync(ledger, [
    row("reflect", "2026-08-06T02:00:00.000Z"),                 // 10h ago, 1d cadence ⇒ NOT due
    row("reflect", "2026-08-01T23:01:00.000Z"),                 // older — must not win
    row("sweep", "2026-08-06T11:30:00.000Z"),                   // 30m ago
    row("pm", "2026-08-04T09:00:00.000Z", "other-project"),     // 2d ago, a DIFFERENT project
  ].join("\n") + "\n");

  // ── the anchor ────────────────────────────────────────────────────────────────────────────────
  const last = lastFirePerAgent(ledger);
  ok(last.get("reflect") === Date.parse("2026-08-06T02:00:00.000Z"),
    "LOOP-273: the NEWEST fire per agent wins, not the first or last line");
  ok(last.get("pm") === Date.parse("2026-08-04T09:00:00.000Z"),
    "LOOP-273: matched by AGENT across ALL projects — slots are per-agent, the project is chosen at fire time");
  ok(last.get("junior-dev") === undefined, "LOOP-273: an agent that has never fired has no anchor");

  // Fail-open, every way it can fail. A scheduler that refuses to start because it cannot read a
  // history file is worse than one that fires early.
  ok(lastFirePerAgent(join(tmp, "absent.jsonl")).size === 0, "LOOP-273: a MISSING ledger yields no anchors, no throw");
  ok(lastFirePerAgent(null).size === 0, "LOOP-273: no ledger path at all (the legacy workspace-less run) likewise");
  const torn = join(tmp, "torn.jsonl");
  writeFileSync(torn, `${row("pm", "2026-08-05T10:00:00.000Z")}\n{"ts":"2026-08-05T11:00`); // crash mid-append
  ok(lastFirePerAgent(torn).get("pm") === Date.parse("2026-08-05T10:00:00.000Z"),
    "LOOP-273: a TORN final line is skipped and the intact rows still anchor");
  const junk = join(tmp, "junk.jsonl");
  writeFileSync(junk, `{"agent":"pm","ts":"not-a-date"}\n{"ts":"2026-08-05T10:00:00.000Z"}\n`);
  ok(lastFirePerAgent(junk).size === 0, "LOOP-273: an unparseable ts and a missing agent are both skipped");

  // ── AC (A): the seed decision ─────────────────────────────────────────────────────────────────
  // NOT due: reflect fired 10h ago on a 1d cadence ⇒ nextAt is last + cadence, and it does NOT fire
  // on boot. This is the whole ticket.
  {
    const d = seedSlotNextAt("reflect", 0, last, DAY, now, 5000);
    ok(!d.fireOnBoot && d.nextAt === Date.parse("2026-08-06T02:00:00.000Z") + DAY,
      `LOOP-273 AC-A: a NOT-DUE slot is deferred to last+cadence and does not fire on boot (${new Date(d.nextAt).toISOString()})`);
    ok(/deferred/.test(d.log) && /next due in 14h/.test(d.log),
      `LOOP-273 AC-B: …and says so, naming the wait and the last fire (${d.log})`);
  }

  // DUE: sweep fired 30m ago on a 30m cadence ⇒ due now ⇒ fire on boot, staggered (today's behaviour).
  {
    const d = seedSlotNextAt("sweep", 2, last, 30 * 60_000, now, 5000);
    ok(d.fireOnBoot && d.nextAt === now + 2 * 5000,
      `LOOP-273 AC-A: a DUE slot fires on boot, staggered by its index — unchanged (${d.nextAt - now}ms)`);
  }

  // OVERDUE: pm fired 2d ago on a 1h cadence.
  {
    const d = seedSlotNextAt("pm", 1, last, HOUR, now, 5000);
    ok(d.fireOnBoot && /overdue/.test(d.log), `LOOP-273 AC-A: an OVERDUE slot fires on boot (${d.log})`);
  }

  // NEVER FIRED: no anchor ⇒ fire on boot, which is today's behaviour for a fresh workspace.
  {
    const d = seedSlotNextAt("junior-dev", 3, last, HOUR, now, 5000);
    ok(d.fireOnBoot && /no recorded fire/.test(d.log),
      `LOOP-273 AC-A: an agent with NO recorded fire fires on boot — a fresh workspace is unchanged (${d.log})`);
  }

  // A zero/absent cadence must not defer forever. `opts.intervals[agent]` is always resolved before
  // the run loop, but a 0 would otherwise compute due===last and defer a slot into the past.
  {
    const d = seedSlotNextAt("reflect", 0, last, 0, now, 5000);
    ok(d.fireOnBoot, "LOOP-273: a zero cadence fires on boot rather than deferring on a meaningless anchor");
  }

  // The boundary: exactly due is DUE, not deferred. An off-by-one here would defer a slot by a full
  // extra cadence on every restart — the same class of bug this ticket fixes.
  {
    const exact = new Map([["pm", now - HOUR]]);
    ok(seedSlotNextAt("pm", 0, exact, HOUR, now, 5000).fireOnBoot,
      "LOOP-273: a slot that comes due EXACTLY at boot fires, it is not deferred a further cadence");
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nCADENCE_SEED_OK");
process.exit(fails ? 1 : 0);
