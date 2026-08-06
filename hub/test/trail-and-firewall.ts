// Three invariants the codebase ASSERTED and never enforced — LOOP-28, LOOP-35, LOOP-132.
//
//   §22  "every agent leaves a durable, human-readable trail"  → 7 of 21 fires left none  (W35)
//   §17  "no agent auto-edits a SKILL / conventions file"      → nothing checked at all    (push-guard)
//   §7   worktrees live OUTSIDE the repo                       → 5 lived inside it         (W34)
//
// Each was written down as a hard invariant, in STRATEGY.md or conventions, and each was enforced by
// nothing but whether a human happened to look.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInRepoWorktrees } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { reportTrailGaps } from "../src/metrics.ts";
import { pushGuard, touchesOutsideCheatsheet, cheatsheetRanges } from "../src/push-guard.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-trail-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const git = (dir: string, ...a: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const capture = async (fn: () => unknown): Promise<string> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
};

/** A ledger row in the shape readFireRows parses. */
const fireRow = (agent: string, iso: string) => JSON.stringify({ ts: iso, agent, project: "p", fireId: `${agent}-${iso}`, exitCode: 0 });

try {
  // ── LOOP-28 / W35: fired, left no trail ───────────────────────────────────────────────────────
  {
    const ledger = join(tmp, "fires.jsonl");
    const reports = join(tmp, "reports");
    // Timestamps relative to NOW, never at a fixed clock time. My first version pinned them at
    // T09:00 "today", which is in the FUTURE whenever the suite runs before 09:00 UTC — and a future
    // row falls inside every window, so the empty-window assertion failed on a date roll-over. A
    // fixture that depends on the time of day is flaky by construction.
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    const HOUR = 3_600_000;
    const today = new Date().toISOString().slice(0, 10);
    const yday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    writeFileSync(ledger, [
      fireRow("junior-dev", ago(1 * HOUR)),
      fireRow("junior-dev", ago(2 * HOUR)),
      fireRow("junior-dev", ago(25 * HOUR)),
      fireRow("junior-dev", ago(27 * HOUR)),
      fireRow("qa", ago(1 * HOUR)),
      fireRow("sweep", ago(1 * HOUR)),
    ].join("\n") + "\n");

    // qa reported today; sweep reported today; junior-dev never did. The `<handle>-agent` mapping is
    // the thing most likely to be wrong, and getting it wrong makes EVERY agent look untraced.
    mkdirSync(join(reports, "qa-agent", "daily"), { recursive: true });
    writeFileSync(join(reports, "qa-agent", "daily", `${ago(1 * HOUR).slice(0, 10)}.md`), "# qa\n");
    mkdirSync(join(reports, "sweep-agent", "daily"), { recursive: true });
    writeFileSync(join(reports, "sweep-agent", "daily", `${ago(1 * HOUR).slice(0, 10)}.md`), "# sweep\n");

    const gaps = reportTrailGaps(ledger, reports);
    ok(gaps.length === 1 && gaps[0].agent === "junior-dev" && gaps[0].fires === 4,
      `LOOP-28: exactly one finding — junior-dev, 4 fires, no report (got ${JSON.stringify(gaps.map((g) => `${g.agent}:${g.fires}`))})`);
    ok(gaps[0].expectedDir.endsWith(join("junior-dev-agent", "daily")),
      `LOOP-28: …naming the expected <handle>-agent path (${gaps[0].expectedDir})`);
    ok(!gaps.some((g) => g.agent === "qa"), "LOOP-28: an agent that fired AND reported produces no finding");
    ok(!gaps.some((g) => g.agent === "sweep"), "LOOP-28: a workspace-scoped agent reporting correctly does not false-positive");
    ok(!gaps.some((g) => g.agent === "pm"), "LOOP-28: an agent with ZERO fires produces no finding — that is W16's job, not this one");

    // A report from OUTSIDE the window does not excuse fires inside it. This is the case a
    // "directory is non-empty" check passes and must not: the trail has to cover the days worked.
    const stale = join(tmp, "reports-stale");
    mkdirSync(join(stale, "junior-dev-agent", "daily"), { recursive: true });
    writeFileSync(join(stale, "junior-dev-agent", "daily", "2020-01-01.md"), "# ancient\n");
    ok(reportTrailGaps(ledger, stale).some((g) => g.agent === "junior-dev"),
      "LOOP-28: a report from outside the window does NOT excuse fires inside it");

    // Best-effort, all three ways it can be missing.
    ok(reportTrailGaps(join(tmp, "no-such.jsonl"), reports).length === 0, "LOOP-28: a missing LEDGER yields no finding and no throw");
    ok(reportTrailGaps(ledger, join(tmp, "no-such-dir")).some((g) => g.agent === "junior-dev"),
      "LOOP-28: a missing REPORTS tree is itself the finding — nothing was reported");
    ok(reportTrailGaps(ledger, reports, { windowMs: 1 }).length === 0, "LOOP-28: an empty window yields nothing");
  }

  // ── LOOP-132 / W34: a worktree inside the repo ────────────────────────────────────────────────
  {
    const wsRoot = join(tmp, "wt-ws");
    const repoDir = join(wsRoot, "repo");
    mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
    git(repoDir, "commit", "--allow-empty", "-qm", "init");
    writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, team: { key: "wt-test", backend: "service" },
      repos: { repo: { path: "repo" } }, projects: {},
    }));
    const ws = () => loadWorkspace(wsRoot);
    const w34 = async (): Promise<string> => capture(() => { checkInRepoWorktrees(ws(), (m) => console.log(m)); });

    ok(!(await w34()).includes("[W34]"), "LOOP-132: a repo with no worktrees at all is silent");

    // The correct shape FIRST: outside the repo, where `dev-loop worktree add` puts them.
    const outside = join(wsRoot, ".dev-loop", "wt", "OUT-1", "repo");
    git(repoDir, "worktree", "add", "-q", "-b", "dev-loop/OUT-1", outside);
    ok(!(await w34()).includes("[W34]"),
      "LOOP-132: an OUT-of-repo worktree is silent — that is the shape wsWorktree produces and it must never warn");

    // Now the measured shape: inside the repo's own working tree.
    const inside = join(repoDir, ".dev-loop", "wt", "IN-1", "repo");
    git(repoDir, "worktree", "add", "-q", "-b", "dev-loop/IN-1", inside);
    const warned = await w34();
    ok(warned.includes("[W34]"), "LOOP-132: an IN-repo worktree raises W34");
    ok(warned.includes(realpathSync(inside)) || warned.includes(inside), `LOOP-132: …naming the offending path (${warned.slice(0, 120)})`);
    ok(/worktree add/.test(warned), "LOOP-132: …and the remedy that produces the correct shape");
    ok(!/rm -rf|git worktree remove|delete (it|them)/.test(warned) && /Not removed here/.test(warned),
      "LOOP-132: …and it INSTRUCTS no deletion, and says so — a live worktree may back an open PR, and reaping is team repair's destructive path");

    // Both ways on one fixture: remove it and the code goes silent again.
    git(repoDir, "worktree", "remove", "--force", inside);
    ok(!(await w34()).includes("[W34]"), "LOOP-132: removing it makes the check silent again");
  }

  // ── LOOP-35 / §17: governing-file edits in the unpushed range ─────────────────────────────────
  {
    // The marker predicate on its own, where the three cases are unambiguous.
    // The file both sides of a regeneration: line 2 opens the range, line 4 closes it, line 6 is prose.
    const before = "# pm\n<!-- cli-cheatsheet:begin agent=pm -->\nold generated line\n<!-- cli-cheatsheet:end agent=pm -->\n\nprose\n";
    const after = "# pm\n<!-- cli-cheatsheet:begin agent=pm -->\nnew generated line\n<!-- cli-cheatsheet:end agent=pm -->\n\nprose\n";
    ok(cheatsheetRanges(after).length === 1 && cheatsheetRanges(after)[0][0] === 2 && cheatsheetRanges(after)[0][1] === 4,
      `LOOP-35: the marker range is read from the FILE, by line number (${JSON.stringify(cheatsheetRanges(after))})`);
    const inMarkerOnly = ["@@ -3 +3 @@", "-old generated line", "+new generated line"].join("\n");
    ok(!touchesOutsideCheatsheet(inMarkerOnly, after, before),
      "LOOP-35: an IN-MARKER-only change is not a §17 breach — `npm run cli-cheatsheet` must stay frictionless");
    const proseAfter = "# pm\n<!-- cli-cheatsheet:begin agent=pm -->\nold generated line\n<!-- cli-cheatsheet:end agent=pm -->\n\nREWRITTEN prose\n";
    ok(touchesOutsideCheatsheet(["@@ -6 +6 @@", "-prose", "+REWRITTEN prose"].join("\n"), proseAfter, before),
      "LOOP-35: a prose change outside the markers IS a breach");
    ok(touchesOutsideCheatsheet([inMarkerOnly, "@@ -6 +6 @@", "-prose", "+REWRITTEN prose"].join("\n"), proseAfter, before),
      "LOOP-35: a commit doing BOTH is a breach — the exempt half does not launder the other one");
    ok(touchesOutsideCheatsheet(["@@ -2 +2 @@", "-<!-- cli-cheatsheet:begin agent=pm -->", "+<!-- cli-cheatsheet:begin agent=qa -->"].join("\n"), after, before),
      "LOOP-35: moving or rewriting a MARKER is itself structural, not generated content");
    ok(touchesOutsideCheatsheet(["@@ -3 +3 @@", "-old generated line", "+new generated line"].join("\n"), "", ""),
      "LOOP-35: with no readable file content the change cannot be placed, so it is REPORTED — conservative on the way out");

    // …then end-to-end through pushGuard on a real repo with a real origin.
    const origin = join(tmp, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const work = join(tmp, "gov-repo");
    execFileSync("git", ["clone", "-q", origin, work]);
    mkdirSync(join(work, "references"), { recursive: true });
    mkdirSync(join(work, "skills", "pm-agent"), { recursive: true });
    writeFileSync(join(work, "references", "conventions.md"), "# conventions\n\nrule one\n");
    writeFileSync(join(work, "skills", "pm-agent", "SKILL.md"),
      "# pm\n\n<!-- cli-cheatsheet:begin agent=pm -->\ngenerated v1\n<!-- cli-cheatsheet:end agent=pm -->\n\nhand-written prose\n");
    writeFileSync(join(work, "app.ts"), "export const x = 1;\n");
    git(work, "add", "-A"); git(work, "commit", "-qm", "base");
    git(work, "push", "-q", "origin", "main");

    const guard = () => pushGuard(work, "main", join(tmp, "nonexistent-hub.db"), "main");
    ok(guard().governance.length === 0, "LOOP-35: nothing unpushed ⇒ no §17 findings");

    // (a) an ordinary source commit is untouched by this.
    writeFileSync(join(work, "app.ts"), "export const x = 2;\n");
    git(work, "add", "-A"); git(work, "commit", "-qm", "feat: ordinary change");
    ok(guard().governance.length === 0, "LOOP-35: an ordinary source commit produces no §17 finding");

    // (b) the generated path — in-marker only — stays clean.
    writeFileSync(join(work, "skills", "pm-agent", "SKILL.md"),
      "# pm\n\n<!-- cli-cheatsheet:begin agent=pm -->\ngenerated v2\n<!-- cli-cheatsheet:end agent=pm -->\n\nhand-written prose\n");
    git(work, "add", "-A"); git(work, "commit", "-qm", "chore: regenerate cheatsheet");
    ok(guard().governance.length === 0,
      "LOOP-35: a cheatsheet regeneration inside the markers is NOT reported — the generated path stays frictionless");

    // (c) prose outside the markers in the same SKILL file IS a breach.
    writeFileSync(join(work, "skills", "pm-agent", "SKILL.md"),
      "# pm\n\n<!-- cli-cheatsheet:begin agent=pm -->\ngenerated v2\n<!-- cli-cheatsheet:end agent=pm -->\n\nhand-written prose, REWRITTEN by an agent\n");
    git(work, "add", "-A"); git(work, "commit", "-qm", "docs: reword the pm skill");
    const gSkill = guard().governance;
    ok(gSkill.length === 1 && gSkill[0].reason === "skill" && gSkill[0].file.endsWith("SKILL.md"),
      `LOOP-35: prose OUTSIDE the markers is reported (got ${JSON.stringify(gSkill.map((g) => `${g.file}:${g.reason}`))})`);

    // (d) conventions.md, the other governed file.
    writeFileSync(join(work, "references", "conventions.md"), "# conventions\n\nrule one\nrule two, added by an agent\n");
    git(work, "add", "-A"); git(work, "commit", "-qm", "docs: add a convention");
    const gAll = guard().governance;
    ok(gAll.some((g) => g.reason === "conventions"), "LOOP-35: a conventions.md edit is reported");
    ok(gAll.length === 2, `LOOP-35: …and exactly the two breaches, not the ordinary or generated commits (got ${gAll.length})`);
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nTRAIL_AND_FIREWALL_OK");
process.exit(fails ? 1 : 0);
