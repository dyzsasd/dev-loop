// LOOP-322 + LOOP-204 + LOOP-91 — doctor says the most consequential thing it knows.
//
// LOOP-322: the NEXT ladder was a flat if-chain ordered by first-run setup sequence, so ONE unseeded
// config stub (W08) — no repos, no tickets, no fires, blocking nothing — made the decision-stall,
// landing-stall and release-skew hints unreachable. Measured live: the single directed action was
// "seed real-one" while the same run reported 46 shipped-code commits unpublished.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextStep, checkFailureTaxonomyBlind, checkLessonsLiveness, checkBoardSnapshotW32 } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-doc-prec-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  // A workspace that is fully set up EXCEPT for one unseeded config stub — the live shape.
  const wsRoot = join(tmp, "ws");
  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  mkdirSync(join(wsRoot, "repo"), { recursive: true });
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "prec", backend: "service", mode: "live" },
    repos: { repo: { path: "repo" } },
    projects: { real: { repos: [{ ref: "repo" }] }, stub: { repos: [] } },
  }));
  const ws = loadWorkspace(wsRoot);

  const STALL = { oldest: { id: "LOOP-1", enteredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), state: "Human-Blocked" }, count: 2 };
  const SKEW = { codeBehind: 46, version: "1.14.0" };
  const UNSEEDED = ["stub"];

  // ── the three pairs that were unreachable ──
  ok(/cut a release/.test(nextStep(ws, [], UNSEEDED, undefined, null, SKEW, [])),
    "LOOP-322: W08 + release skew → the RELEASE hint (was: seed the stub)");
  ok(/rule on the oldest decision/.test(nextStep(ws, [], UNSEEDED, undefined, STALL, null, [])),
    "LOOP-322: W08 + decision stall → the DECISION hint");
  ok(/landing stall/.test(nextStep(ws, [], UNSEEDED, "owner/repo", null, null, [])),
    "LOOP-322: W08 + landing stall → the LANDING-STALL hint");

  // ── relative order among the three day-2 conditions is UNCHANGED ──
  ok(/rule on the oldest decision/.test(nextStep(ws, [], [], "owner/repo", STALL, SKEW, [])),
    "LOOP-322: decision stall still outranks landing stall and release skew");
  ok(/landing stall/.test(nextStep(ws, [], [], "owner/repo", null, SKEW, [])),
    "LOOP-322: landing stall still outranks release skew");

  // ── cannot-run conditions still outrank every warning ──
  ok(/fix the ❌ first/.test(nextStep(ws, [], UNSEEDED, "owner/repo", STALL, SKEW, ["db INVALID"])),
    "LOOP-322: a ❌ hard fail still beats a decision-queue stall (LOOP-202's rung stays on top)");
  ok(/fix dev-loop\.json/.test(nextStep(ws, [{ code: "E04", path: "p", message: "bad" }], UNSEEDED, undefined, STALL, SKEW, [])),
    "LOOP-322: a config validation error outranks everything");

  // ── day-1 guidance does not regress ──
  ok(/dev-loop seed stub/.test(nextStep(ws, [], UNSEEDED, undefined, null, null, [])),
    "LOOP-322: W08 ALONE still gets its setup hint — first-run guidance is intact");
  ok(nextStep(ws, [], [], undefined, null, null, []) === "dev-loop run",
    "LOOP-322: all green ⇒ run the loop");

  // ── LOOP-204/LOOP-547: W24 fires only when the failure taxonomy is genuinely blind ──
  // LOOP-547: tests use DERIVED expected counts (AC5) — the fixture computes expected values from
  // the row set it builds, not by restating the function's own arithmetic as test literals.
  {
    const seen: string[] = [];
    const warn = (m: string) => seen.push(m);
    // AC4: a fixture where a MAJORITY of failed fires carry no errorClass → W24 fires.
    // Input: 65 failures, 18 classified (4 timeout + 14 rate-limit) → 47 unclassified, 47/65 ≈ 72%
    const inFailures = 65;
    const inClassified: Record<string, number> = { timeout: 4, "rate-limit": 14 };
    const inClassifiedSum = Object.values(inClassified).reduce((a, b) => a + b, 0);
    const expectedUnclassified = inFailures - inClassifiedSum;
    const expectedShare = Math.round(expectedUnclassified / inFailures * 100);
    checkFailureTaxonomyBlind({ failures: inFailures, timeouts: 4, suspectErrors: 13, byErrorClass: inClassified }, warn);
    ok(seen.length === 1 && /\[W24\]/.test(seen[0]) && new RegExp(`${expectedUnclassified} of ${inFailures}`).test(seen[0]) && new RegExp(`${expectedShare}%`).test(seen[0]),
      `LOOP-547 AC4: W24 fires and names both counts and the percentage (got ${JSON.stringify(seen[0] ?? "")})`);

    // AC1/AC2: exit-0 suspectErrors and double-counted timeouts do NOT inflate the denominator.
    // Same fixture, but suspectErrors are large — they should be excluded from the count.
    const suspectOnly: string[] = [];
    checkFailureTaxonomyBlind({ failures: 10, timeouts: 0, suspectErrors: 999, byErrorClass: { "rate-limit": 9 } }, (m) => suspectOnly.push(m));
    ok(suspectOnly.length === 0, `LOOP-547 AC1/AC2: exit-0 suspectErrors (999) do NOT inflate the denominator — W24 stays silent (got ${JSON.stringify(suspectOnly[0] ?? "none")})`);

    const quiet: string[] = [];
    // 10 failures, 9 classified → 1/10 = 10% unclassified — below threshold, silent.
    checkFailureTaxonomyBlind({ failures: 10, timeouts: 0, suspectErrors: 0, byErrorClass: { "rate-limit": 9 } }, (m) => quiet.push(m));
    ok(quiet.length === 0, "LOOP-204: a mostly-classified window emits NOTHING — not a warning, not an info line");

    const zero: string[] = [];
    checkFailureTaxonomyBlind({ failures: 0, timeouts: 0, suspectErrors: 0, byErrorClass: {} }, (m) => zero.push(m));
    ok(zero.length === 0, "LOOP-204: zero failures ⇒ silent, never 0%/NaN/Infinity");

    const tiny: string[] = [];
    checkFailureTaxonomyBlind({ failures: 2, timeouts: 0, suspectErrors: 0, byErrorClass: {} }, (m) => tiny.push(m));
    ok(tiny.length === 0, "LOOP-204: below the minimum sample one odd tail cannot swing the share into a warning");
  }

  // ── LOOP-91: an absent lessons library is distinguishable from a curated one ──
  {
    const absent: string[] = [];
    checkLessonsLiveness(ws, (m) => absent.push(m));
    ok(absent.length === 1 && /\[W30\]/.test(absent[0]) && /never been written/.test(absent[0]),
      `LOOP-91: W30 names the ABSENCE — a missing INDEX used to be byte-identical to a healthy library (got ${JSON.stringify(absent[0] ?? "")})`);

    mkdirSync(join(wsRoot, ".dev-loop", "lessons"), { recursive: true });
    writeFileSync(join(wsRoot, ".dev-loop", "lessons", "INDEX.md"), "- a lesson\n");
    const present: string[] = [];
    checkLessonsLiveness(ws, (m) => present.push(m));
    ok(present.length === 0, "LOOP-91: a written library is silent — W30 is about absence, W03 owns over-budget");
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── LOOP-340: W32 names the ABSENCE of a snapshot, and a cadence that stopped ──────────────────
// On 2026-08-04 the board was destroyed and doctor printed DOCTOR_OK before, during and after —
// there were ZERO W-codes mentioning backup or snapshot, so the health check could not say that the
// board had never once been copied. Two arms, because they fail differently: never-taken is the
// state that lost the data; stale-by-2x is a STOPPED timer, which is otherwise indistinguishable
// from a healthy one and is what makes the Child C cadence trustworthy rather than assumed.
{
  const swsRoot = join(tmp, "snapws");
  mkdirSync(join(swsRoot, ".dev-loop"), { recursive: true });
  const writeCfg = (backup?: Record<string, unknown>) =>
    writeFileSync(join(swsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "snap", backend: "service", mode: "live", ...(backup ? { backup } : {}) },
      repos: {}, projects: {},
    }));

  // Arm 1 — nothing has ever been taken.
  writeCfg();
  const never: string[] = [];
  checkBoardSnapshotW32(loadWorkspace(swsRoot), (m) => never.push(m));
  ok(never.length === 1 && /\[W32\]/.test(never[0]) && /NEVER been snapshotted/.test(never[0]),
    `LOOP-340 AC1: W32 names the never-taken case (got ${JSON.stringify((never[0] ?? "").slice(0, 70))})`);
  ok(/dev-loop board snapshot/.test(never[0] ?? ""), "LOOP-340 AC1: …with the exact remedy command");

  // A fresh generation ⇒ silent.
  const snapDir = join(swsRoot, ".dev-loop", "snapshots");
  mkdirSync(snapDir, { recursive: true });
  const NOW = Date.parse("2026-08-05T12:00:00Z");
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  writeFileSync(join(snapDir, `board-${stamp(new Date(NOW - 60 * 60_000))}-cadence.db`), "x");
  const fresh: string[] = [];
  checkBoardSnapshotW32(loadWorkspace(swsRoot), (m) => fresh.push(m), NOW);
  ok(fresh.length === 0, `LOOP-340: a snapshot inside the cadence is SILENT (got ${JSON.stringify(fresh)})`);

  // Arm 2 — older than 2x the cadence ⇒ the timer stopped, not merely slipped.
  rmSync(snapDir, { recursive: true, force: true });
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, `board-${stamp(new Date(NOW - 20 * 3_600_000))}-cadence.db`), "x"); // 20h vs 6h cadence
  const stale: string[] = [];
  checkBoardSnapshotW32(loadWorkspace(swsRoot), (m) => stale.push(m), NOW);
  ok(stale.length === 1 && /timer has stopped/.test(stale[0]),
    `LOOP-340 AC1: a cadence that STOPPED is named as such (got ${JSON.stringify((stale[0] ?? "").slice(0, 70))})`);

  // One missed cycle is a blip, not a fault — the discriminator that keeps the warning meaningful.
  rmSync(snapDir, { recursive: true, force: true });
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, `board-${stamp(new Date(NOW - 8 * 3_600_000))}-cadence.db`), "x"); // 8h vs 6h
  const blip: string[] = [];
  checkBoardSnapshotW32(loadWorkspace(swsRoot), (m) => blip.push(m), NOW);
  ok(blip.length === 0, "LOOP-340: ONE missed cycle is a blip and stays silent — only two is a stopped cadence");

  // Cadence deliberately OFF ⇒ staleness is not a fault (but never-taken still warns).
  writeCfg({ everyHours: 0 });
  const off: string[] = [];
  checkBoardSnapshotW32(loadWorkspace(swsRoot), (m) => off.push(m), NOW + 90 * 86_400_000);
  ok(off.length === 0, "LOOP-340: with the cadence off, an old snapshot is not a fault");

  // A linear team has no hub.db to snapshot at all.
  const linRoot = join(tmp, "linws");
  mkdirSync(linRoot, { recursive: true });
  writeFileSync(join(linRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2, team: { key: "lin", backend: "linear", linearTeam: "T" }, repos: {}, projects: {},
  }));
  const lin: string[] = [];
  checkBoardSnapshotW32(loadWorkspace(linRoot), (m) => lin.push(m));
  ok(lin.length === 0, "LOOP-340: a linear team has no hub.db — W32 does not apply and says nothing");
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDOCTOR_PRECEDENCE_OK");
process.exit(fails ? 1 : 0);
