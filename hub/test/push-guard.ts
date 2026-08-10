// P1-2 push-guard — regression tests for the ride-along class (MP-275: a Canceled ticket's commit rode a
// batched push into a prod deploy). Real git repos (bare origin + clone), real hub rows.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { pushGuard } from "../src/push-guard.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

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
  const clean = pushGuard(work, "main", db, "main");
  ok(clean.ahead === 0 && clean.findings.length === 0, "clean branch → 0 ahead, no findings");

  // the MP-275 shape: a canceled ticket's commit is aboard, plus legal work and a ghost ref
  git(work, ["commit", "--allow-empty", "-qm", "CERT-1: canceled work rides along"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-2: legal in-flight work"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-3: superseded duplicate"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-9: ghost ref"]);
  git(work, ["commit", "--allow-empty", "-qm", "docs: no ticket ref"]);
  const r = pushGuard(work, "main", db, "main");
  ok(r.ahead === 5, `5 commits ahead (got ${r.ahead})`);
  ok(r.findings.some((f) => f.ticket === "CERT-1" && f.state === "Canceled"), "Canceled ref flagged (the MP-275 shape)");
  ok(r.findings.some((f) => f.ticket === "CERT-3" && f.state === "Duplicate"), "Duplicate ref flagged too");
  ok(!r.findings.some((f) => f.ticket === "CERT-2"), "a legal in-flight ref is NOT a finding");
  ok(r.unknownRefs.includes("CERT-9"), "a ref with no hub row is reported unverifiable, never a finding");

  // no upstream → the first-push range, plus an advisory note; never a crash.
  //
  // LOOP-528 changed what this asserts, deliberately. It used to require `ahead === 0`, which pinned
  // the defect: the guard hard-coded findings/governance empty for a branch with no upstream, so a
  // first push — the dev tier's normal case — was scanned as if it published nothing. `feature/x`
  // here forks from a `main` that is 5 commits ahead of `origin/main`, and those 5 commits are
  // exactly what a first push of it WOULD publish, so 5 is the honest count. The old expectation was
  // not a contract this suite was protecting; it was a transcription of the bug.
  git(work, ["checkout", "-qb", "feature/x"]);
  const nb = pushGuard(work, "feature/x", db, "main");
  ok(nb.ahead === 5, `a first push is measured over origin/<defaultBranch>..<branch> (got ${nb.ahead}, want 5)`);
  ok(/no upstream/.test(nb.note ?? "") && /gated over origin\/main\.\./.test(nb.note ?? ""),
    `the note names the range those commits were scanned over (note=${nb.note})`);
  ok(nb.findings.some((f) => f.ticket === "CERT-1"), "and the findings class really ran on it — the class the early return emptied");
  git(work, ["checkout", "-qm", "main"]);

  // CLI: advisory exit 0; --strict exit 1 with findings; clean --strict exit 0
  // Pass --default-branch main explicitly — the temp work dir is not a registered workspace.
  const cli = (args: string[]) => spawnSync(process.execPath, [join(hubRoot, "src", "push-guard.ts"), ...args],
    { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: db } });
  const adv = cli(["--repo", work, "--branch", "main", "--default-branch", "main"]);
  ok(adv.status === 0 && /ride-along: .*CERT-1 \(Canceled\)/.test(adv.stdout), "CLI advisory: prints the finding, exits 0");
  const strict = cli(["--repo", work, "--branch", "main", "--strict", "--default-branch", "main"]);
  ok(strict.status === 1, "CLI --strict: findings ⇒ exit 1 (the §12 pre-push gate shape)");
  git(work, ["push", "-q", "origin", "main"]); // flush everything
  const strictClean = cli(["--repo", work, "--branch", "main", "--strict", "--default-branch", "main"]);
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
  const bodyRef = pushGuard(work, "main", db, "main");
  ok(bodyRef.ahead === 1, `body-ref commit: 1 ahead (got ${bodyRef.ahead})`);
  ok(bodyRef.findings.some((f) => f.ticket === "CERT-5" && f.state === "Canceled"),
    "LOOP-25: a Canceled ref in the commit BODY (trailer) is flagged — not silently invisible");
  ok(bodyRef.findings[0]?.subject === "fix(y): patch other behavior",
    "the finding's subject field is still the subject line (display is correct)");
  // --strict must exit 1 for body-only refs
  const bodyStrict = cli(["--repo", work, "--branch", "main", "--strict", "--default-branch", "main"]);
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
  ok(/unattributable/.test(pgStrict.stdout), "CLI output reports unattributable for no-ticket-id commit");

  // AC: no false positive on a clean branch off origin/main (rebase)
  git(work, ["rebase", "--onto", "origin/main", "main", "dev-loop/CERT-10"]);
  const pgClean = pushGuard(work, "dev-loop/CERT-10", db, "main");
  ok(pgClean.passengers.length === 0, "LOOP-55: after rebase onto origin/main, no passengers (rebased commits are NOT ancestors of local main)");

  // AC: no false positive on non-dev-loop branch (non-LOOP-55 detection branch shape)
  const pgOther = pushGuard(work, "main", db, "main");
  ok(pgOther.passengers.length === 0, "LOOP-55: non-dev-loop branch shape → no passenger detection");

  // LOOP-87: stacked branch — CERT-10's commit is attributed to CERT-10, not CERT-11, so it IS a passenger.
  // The old algorithm skipped it via SHA ancestry (Clause 2); the new algorithm catches it via ticket id.
  git(work, ["checkout", "-qb", "dev-loop/CERT-11"]);
  git(work, ["commit", "--allow-empty", "-qm", "fix(y): CERT-11 stacked on CERT-10"]);
  const pgStacked = pushGuard(work, "dev-loop/CERT-11", db, "main");
  ok(pgStacked.passengers.length === 1, `LOOP-87: stacked branch — CERT-10 commit is flagged as passenger (got ${pgStacked.passengers.length})`);
  ok(pgStacked.passengers[0]?.ticketId === "CERT-10", "LOOP-87: stacked passenger names CERT-10");
  ok(pgStacked.passengers[0]?.severity === "warning", "LOOP-87: stacked passenger is warning (CERT-10 not Canceled in hub)");

  // LOOP-87 PM AC: rebased stacked branch — passenger with new SHA still detected via ticket attribution.
  // Simulate: amend CERT-10 (new SHA), rebase CERT-11 on top of it.
  // Old algorithm (Clause 2: SHA ancestry) misses this; new algorithm catches it via ticket id.
  git(work, ["checkout", "-q", "dev-loop/CERT-10"]);
  git(work, ["commit", "--amend", "--no-edit", "--allow-empty"]);
  git(work, ["rebase", "dev-loop/CERT-10", "dev-loop/CERT-11"]);
  const pgPostRebase = pushGuard(work, "dev-loop/CERT-11", db, "main");
  ok(pgPostRebase.passengers.some((p) => p.ticketId === "CERT-10"), "LOOP-87 PM AC: CERT-10 passenger detected after rebase gave it a new SHA");

  git(work, ["checkout", "-q", "main"]);

  // ── LOOP-87 AC2: Canceled passenger produces a hard flag ──────────────────────────────────────
  {
    git(work, ["checkout", "-qb", "dev-loop/CERT-60", "origin/main"]);
    // First commit: references Canceled ticket CERT-1 (not ownId)
    git(work, ["commit", "--allow-empty", "-qm", "fix(legacy): carry over CERT-1 work"]);
    // Second commit: own work (ownId = CERT-60)
    git(work, ["commit", "--allow-empty", "-qm", "fix(main): CERT-60 own commit"]);

    const pgCanceled = pushGuard(work, "dev-loop/CERT-60", db, "main");
    const hardPass = pgCanceled.passengers.filter((p) => p.severity === "hard");
    ok(hardPass.length === 1, `LOOP-87 AC2: one hard passenger for Canceled ticket (got ${hardPass.length})`);
    ok(hardPass[0]?.ticketId === "CERT-1", "LOOP-87 AC2: hard passenger names CERT-1");
    ok(hardPass[0]?.boardState === "Canceled", "LOOP-87 AC2: hard passenger boardState is Canceled");
    ok(!pgCanceled.passengers.some((p) => /CERT-60/.test(p.subject)), "LOOP-87 AC2: own-ticket commit not flagged");

    // CLI: hard passenger still causes --strict exit 1; output distinguishes hard from warning
    const pgCancelStrict = spawnSync(process.execPath, [join(hubRoot, "src", "push-guard.ts"), "--repo", work, "--branch", "dev-loop/CERT-60", "--strict", "--default-branch", "main"],
      { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: db } });
    ok(pgCancelStrict.status === 1, "LOOP-87 AC2 CLI --strict: hard (Canceled) passenger ⇒ exit 1");
    ok(/⛔/.test(pgCancelStrict.stdout), "LOOP-87 AC2 CLI: hard passenger uses ⛔ icon");
    ok(/CERT-1 is Canceled/.test(pgCancelStrict.stdout), "LOOP-87 AC2 CLI: names the Canceled ticket and its state");

    git(work, ["checkout", "-q", "main"]);
  }

  // ── LOOP-87 AC4: commit with no ticket id is reported as unattributable, not silently dropped ──
  {
    git(work, ["checkout", "-qb", "dev-loop/CERT-70", "origin/main"]);
    // First commit: no ticket reference (unattributable)
    git(work, ["commit", "--allow-empty", "-qm", "docs: no ticket reference here"]);
    // Second commit: own work
    git(work, ["commit", "--allow-empty", "-qm", "fix(y): CERT-70 own commit"]);

    const pgUnattrib = pushGuard(work, "dev-loop/CERT-70", db, "main");
    ok(pgUnattrib.passengers.length === 1, `LOOP-87 AC4: unattributable commit is reported, not silently dropped (got ${pgUnattrib.passengers.length})`);
    ok(pgUnattrib.passengers[0]?.ticketId === undefined, "LOOP-87 AC4: unattributable passenger has no ticketId");
    ok(pgUnattrib.passengers[0]?.severity === "warning", "LOOP-87 AC4: unattributable passenger is severity warning");

    // CLI: output reports unattributable
    const cli2 = (args: string[]) => spawnSync(process.execPath, [join(hubRoot, "src", "push-guard.ts"), ...args],
      { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: db } });
    const pgUnattribCli = cli2(["--repo", work, "--branch", "dev-loop/CERT-70", "--default-branch", "main"]);
    ok(/unattributable/.test(pgUnattribCli.stdout), "LOOP-87 AC4 CLI: output reports unattributable");
    ok(/re-cut or re-target/.test(pgUnattribCli.stdout), "LOOP-87 AC4 CLI: output suggests remedy");

    git(work, ["checkout", "-q", "main"]);
  }

  // ── AC4: passenger detection on a non-main default branch + unresolvable branch ─────────────────
  // Scenario A: a repo whose default branch is "master"; a passenger is planted on local master.
  {
    const masterOrigin = join(ROOT, "master-origin.git");
    const masterWork = join(ROOT, "master-work");
    mkdirSync(masterOrigin, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "master", masterOrigin]);
    execFileSync("git", ["clone", "-q", masterOrigin, masterWork]);
    const mg = (args: string[]) => execFileSync("git", ["-C", masterWork, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    mg(["commit", "--allow-empty", "-qm", "baseline on master"]);
    mg(["push", "-qu", "origin", "master"]);

    // Insert a LOCAL-ONLY commit on master (the passenger)
    mg(["commit", "--allow-empty", "-qm", "docs(strategy): local-only passenger on master"]);

    // Cut a dev branch off local master (before syncing origin) — the bug shape
    mg(["checkout", "-qb", "dev-loop/CERT-40"]);
    mg(["commit", "--allow-empty", "-qm", "fix(x): CERT-40 the real fix"]);

    // AC4 part A: must DETECT the passenger when defaultBranch="master"
    // (fails-before: the base-tree pushGuard without this fix would check origin/main which doesn't exist,
    //  silently skip passenger detection, and return passengers=[])
    const pg4a = pushGuard(masterWork, "dev-loop/CERT-40", db, "master");
    ok(pg4a.passengers.length === 1, `AC4: master-default repo — 1 passenger found when defaultBranch="master" (got ${pg4a.passengers.length})`);
    ok(/local-only passenger on master/.test(pg4a.passengers[0]?.subject ?? ""), "AC4: passenger subject is the planted commit");
    ok(pg4a.unresolvedDefaultBranch === undefined, "AC4: unresolvedDefaultBranch is undefined when origin/master resolves normally");
  }

  // Scenario B: unresolvable default branch → unresolvedDefaultBranch is set and CLI --strict exits non-zero
  {
    // Use the main 'work' repo; "nonexistent" is not a remote branch
    git(work, ["checkout", "-qb", "dev-loop/CERT-41"]);
    git(work, ["commit", "--allow-empty", "-qm", "fix(z): CERT-41 placeholder"]);

    // API: unresolvedDefaultBranch must be set
    const pg4b = pushGuard(work, "dev-loop/CERT-41", db, "nonexistent");
    ok(pg4b.unresolvedDefaultBranch === "nonexistent", "AC4: unresolvable defaultBranch → unresolvedDefaultBranch='nonexistent' in result");
    ok(pg4b.passengers.length === 0, "AC4: no passengers array pollution when detection did NOT run");

    // CLI: --strict must exit 1 (fails-before: today exits 0 because it silently skips)
    const pg4bStrict = cli(["--repo", work, "--branch", "dev-loop/CERT-41", "--default-branch", "nonexistent", "--strict"]);
    ok(pg4bStrict.status === 1, "AC4 CLI --strict: unresolvable defaultBranch ⇒ exit 1 (a safety gate must not pass silently)");
    ok(/does not exist/.test(pg4bStrict.stdout), "AC4 CLI: output names the missing origin/<branch>");

    git(work, ["checkout", "-q", "main"]);
  }

  // ── AC2 (design `default-branch-resolution` §5 line 187 / LOOP-107): no `"main"` string-literal
  //    survives as a branch default in EITHER source file. This is the regression LOOP-99 shipped
  //    without — the very assertion that would have caught the residual `defaultBranch = "main"` default
  //    at push-guard.ts:29 (Delta 1). Self-maintaining: the single terminal fallback lives only in
  //    effectiveRepo (team-config.ts), so neither file should carry the literal. Line-comments are
  //    stripped first so prose mentioning main can never trip it, and `origin/${defaultBranch}`
  //    interpolation carries no literal — a plain literal-presence check over the two files is enough.
  {
    const carriesMainLiteral = (rel: string): boolean =>
      readFileSync(join(hubRoot, "src", rel), "utf8")
        .split("\n")
        .map((l: string) => l.replace(/\/\/.*$/, "")) // drop line-comments: a branch default is code, not prose
        .some((l) => l.includes('"main"'));
    ok(!carriesMainLiteral("push-guard.ts"), "AC2: hub/src/push-guard.ts carries no \"main\" branch-default literal (design §5)");
    ok(!carriesMainLiteral("worktree.ts"), "AC2: hub/src/worktree.ts carries no \"main\" branch-default literal (design §5)");
  }

} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "push-guard: all checks passed");
process.exit(fails ? 1 : 0);
