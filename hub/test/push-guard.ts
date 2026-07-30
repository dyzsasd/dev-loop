// P1-2 push-guard — regression tests for the ride-along class (MP-275: a Canceled ticket's commit rode a
// batched push into a prod deploy). Real git repos (bare origin + clone), real hub rows.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { pushGuard } from "../src/push-guard.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-push-guard-"));
try {
  const origin = join(ROOT, "origin.git");
  const work = join(ROOT, "work");
  mkdirSync(origin, { recursive: true });
  const git = (dir: string, args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  git(work, ["commit", "--allow-empty", "-qm", "baseline"]);
  git(work, ["push", "-qu", "origin", "main"]);

  const db = join(ROOT, "hub.db");
  const conn = openDb(db);
  conn.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  const tk = (id: string, state: string) =>
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')").run(id, "p", "t-" + id, state);
  tk("CERT-1", "Canceled"); tk("CERT-2", "Todo"); tk("CERT-3", "Duplicate");
  conn.close();

  // clean: nothing ahead
  const clean = pushGuard(work, "main", db);
  ok(clean.ahead === 0 && clean.findings.length === 0, "clean branch → 0 ahead, no findings");

  // the MP-275 shape: a canceled ticket's commit is aboard, plus legal work and a ghost ref
  git(work, ["commit", "--allow-empty", "-qm", "CERT-1: canceled work rides along"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-2: legal in-flight work"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-3: superseded duplicate"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-9: ghost ref"]);
  git(work, ["commit", "--allow-empty", "-qm", "docs: no ticket ref"]);
  const r = pushGuard(work, "main", db);
  ok(r.ahead === 5, `5 commits ahead (got ${r.ahead})`);
  ok(r.findings.some((f) => f.ticket === "CERT-1" && f.state === "Canceled"), "Canceled ref flagged (the MP-275 shape)");
  ok(r.findings.some((f) => f.ticket === "CERT-3" && f.state === "Duplicate"), "Duplicate ref flagged too");
  ok(!r.findings.some((f) => f.ticket === "CERT-2"), "a legal in-flight ref is NOT a finding");
  ok(r.unknownRefs.includes("CERT-9"), "a ref with no hub row is reported unverifiable, never a finding");

  // no upstream → advisory note, never a crash
  git(work, ["checkout", "-qb", "feature/x"]);
  const nb = pushGuard(work, "feature/x", db);
  ok(nb.ahead === 0 && /no upstream/.test(nb.note ?? ""), "a branch with no upstream → note (first push)");
  git(work, ["checkout", "-qm", "main"]);

  // CLI: advisory exit 0; --strict exit 1 with findings; clean --strict exit 0
  const cli = (args: string[]) => spawnSync(process.execPath, [join(hubRoot, "src", "push-guard.ts"), ...args],
    { encoding: "utf8", env: { ...process.env, DEVLOOP_HUB_DB: db } });
  const adv = cli(["--repo", work, "--branch", "main"]);
  ok(adv.status === 0 && /ride-along: .*CERT-1 \(Canceled\)/.test(adv.stdout), "CLI advisory: prints the finding, exits 0");
  const strict = cli(["--repo", work, "--branch", "main", "--strict"]);
  ok(strict.status === 1, "CLI --strict: findings ⇒ exit 1 (the §12 pre-push gate shape)");
  git(work, ["push", "-q", "origin", "main"]); // flush everything
  const strictClean = cli(["--repo", work, "--branch", "main", "--strict"]);
  ok(strictClean.status === 0 && /clean/.test(strictClean.stdout), "CLI --strict on a clean branch ⇒ exit 0");

  // ── LOOP-25 regression: body/trailer ticket refs must be found, not just subject-line refs ──────────
  // Add a Canceled ticket (CERT-5) and commit with its ref only in the body/trailer (MP-275 failure class).
  {
    const conn2 = openDb(db);
    conn2.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')").run("CERT-5", "p", "t-CERT-5", "Canceled");
    conn2.close();
  }
  // Commit with CERT-5 ref only in the body/trailer (the exact dev-agent co-author trailer shape).
  git(work, ["commit", "--allow-empty", "-qm", "fix(y): patch other behavior\n\nTicket-Id: CERT-5\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"]);
  const bodyRef = pushGuard(work, "main", db);
  ok(bodyRef.ahead === 1, `body-ref commit: 1 ahead (got ${bodyRef.ahead})`);
  ok(bodyRef.findings.some((f) => f.ticket === "CERT-5" && f.state === "Canceled"),
    "LOOP-25: a Canceled ref in the commit BODY (trailer) is flagged — not silently invisible");
  ok(bodyRef.findings[0]?.subject === "fix(y): patch other behavior",
    "the finding's subject field is still the subject line (display is correct)");
  // --strict must exit 1 for body-only refs
  const bodyStrict = cli(["--repo", work, "--branch", "main", "--strict"]);
  ok(bodyStrict.status === 1, "LOOP-25 CLI --strict: body-only ref to Canceled ticket ⇒ exit 1");

  // ── LOOP-55: passenger detection ─────────────────────────────────────────────────
  // A dev-loop/<id> branch cut off local main that is AHEAD of origin carries passengers.
  // Set up: push local main's existing commits to origin (sync), then add one more LOCAL-ONLY commit.
  git(work, ["push", "-q", "origin", "main"]); // flush the CERT-* and LOOP-25 commits
  git(work, ["commit", "--allow-empty", "-qm", "docs(strategy): local-only PM commit"]);
  const localOnlySha = git(work, ["rev-parse", "HEAD"]);

  // Cut a dev branch off local main (the LOOP-48 bug shape)
  git(work, ["checkout", "-qb", "dev-loop/CERT-10"]);
  // Add this ticket's own commit
  git(work, ["commit", "--allow-empty", "-qm", "fix(x): CERT-10 the real fix"]);

  // AC: true positive — the local-only commit is a passenger (not referenced by CERT-10)
  const pg = pushGuard(work, "dev-loop/CERT-10", db, "main");
  ok(pg.passengers.length === 1, `LOOP-55: one passenger found (got ${pg.passengers.length})`);
  ok(pg.passengers[0]?.sha.length === 7, "passenger sha is a 7-char short sha");
  ok(/local-only PM commit/.test(pg.passengers[0]?.subject ?? ""), "passenger subject matches the leaked commit");

  // AC: the own-ticket commit is NOT a passenger
  ok(!pg.passengers.some((p) => /CERT-10/.test(p.subject)), "CERT-10 commit is NOT flagged as passenger");

  // AC: existing findings are not affected (no Canceled/Duplicate tickets in CERT-10 commits)
  ok(pg.findings.length === 0, "passenger branch: no ride-along findings (separate concern)");

  // AC: --strict exits 1 on a passenger
  const pgStrict = cli(["--repo", work, "--branch", "dev-loop/CERT-10", "--strict", "--default-branch", "main"]);
  ok(pgStrict.status === 1, "LOOP-55 --strict: passenger ⇒ exit 1");
  ok(/passenger/.test(pgStrict.stdout), "CLI output mentions 'passenger'");
  ok(/re-cut via `dev-loop worktree add`/.test(pgStrict.stdout), "CLI output mentions worktree add remedy");

  // AC: no false positive on a clean branch off origin/main (rebase)
  git(work, ["rebase", "--onto", "origin/main", "main", "dev-loop/CERT-10"]);
  const pgClean = pushGuard(work, "dev-loop/CERT-10", db, "main");
  ok(pgClean.passengers.length === 0, "LOOP-55: after rebase onto origin/main, no passengers (rebased commits are NOT ancestors of local main)");

  // AC: no false positive on non-dev-loop branch (non-LOOP-55 detection branch shape)
  const pgOther = pushGuard(work, "main", db, "main");
  ok(pgOther.passengers.length === 0, "LOOP-55: non-dev-loop branch shape → no passenger detection");

  // AC: no false positive on a stacked branch: parent commits reference a DIFFERENT ticket id
  git(work, ["checkout", "-qb", "dev-loop/CERT-11"]);
  git(work, ["commit", "--allow-empty", "-qm", "fix(y): CERT-11 stacked on CERT-10"]);
  // The CERT-10 commit is in origin/main..dev-loop/CERT-11, references CERT-10, is NOT an ancestor of local main
  const pgStacked = pushGuard(work, "dev-loop/CERT-11", db, "main");
  ok(pgStacked.passengers.length === 0, "LOOP-55: stacked branch — CERT-10's commit is not an ancestor of local main → no false positive");

  git(work, ["checkout", "-q", "main"]);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "push-guard: all checks passed");
process.exit(fails ? 1 : 0);
