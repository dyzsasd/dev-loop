// LOOP-322 + LOOP-204 + LOOP-91 — doctor says the most consequential thing it knows.
//
// LOOP-322: the NEXT ladder was a flat if-chain ordered by first-run setup sequence, so ONE unseeded
// config stub (W08) — no repos, no tickets, no fires, blocking nothing — made the decision-stall,
// landing-stall and release-skew hints unreachable. Measured live: the single directed action was
// "seed real-one" while the same run reported 46 shipped-code commits unpublished.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextStep, checkFailureTaxonomyBlind, checkLessonsLiveness } from "../src/doctor.ts";
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

  // ── LOOP-204: W24 fires only when the taxonomy is genuinely blind ──
  {
    const seen: string[] = [];
    const warn = (m: string) => seen.push(m);
    // 82 failure-ish rows, 18 classified → 78% blind (the ticket's measured shape).
    checkFailureTaxonomyBlind({ failures: 65, timeouts: 4, suspectErrors: 13, byErrorClass: { timeout: 4, "rate-limit": 14 } }, warn);
    ok(seen.length === 1 && /\[W24\]/.test(seen[0]) && /64 of 82/.test(seen[0]) && /78%/.test(seen[0]),
      `LOOP-204: W24 fires and names both counts and the percentage (got ${JSON.stringify(seen[0] ?? "")})`);

    const quiet: string[] = [];
    checkFailureTaxonomyBlind({ failures: 10, timeouts: 0, suspectErrors: 0, byErrorClass: { "rate-limit": 9 } }, (m) => quiet.push(m));
    ok(quiet.length === 0, "LOOP-204: a mostly-classified window emits NOTHING — not a warning, not an info line");

    const zero: string[] = [];
    checkFailureTaxonomyBlind({ failures: 0, timeouts: 0, suspectErrors: 0, byErrorClass: {} }, (m) => zero.push(m));
    ok(zero.length === 0, "LOOP-204: zero failure-ish rows ⇒ silent, never 0%/NaN/Infinity");

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

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDOCTOR_PRECEDENCE_OK");
process.exit(fails ? 1 : 0);
