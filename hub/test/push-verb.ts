// LOOP-521 (approvals C7) — `dev-loop push`: the gate is the PRECONDITION of the push, in one call.
//
// The gap this pins: `approvals.enforce: ["push"]` had exactly one enforcing consumer (`push-guard`)
// and on `landing:"pr"` NOTHING called it — the feature-branch push in the dev-agent ship sequence
// runs a bare `git push`. So the switch reached no reader and a fire could publish a branch carrying
// an ungranted `push:` request. AC4 below is that scenario end to end, on a fixture workspace.
//
// Every refusal arm asserts on the RECORDED ARGV (`pushArgv === null`), never on an inferred
// absence: "no push happened" must be a checkable fact. The injected git double is STRICT — it
// answers exactly the argv this flow issues and refuses anything else — because a double that
// answered any argv could not tell a push from a non-push, which is the one thing these arms rest on
// (LOOP-352's lesson, applied to the mock rather than the test).
//
// MUTATION CHECK (AC4): replacing the `runGuard(...)` call in hub/src/push.ts with an empty result —
// the gate never runs — makes AC4 fail on the assertion that matters most: `AC4 the branch never
// reached the remote` flips, i.e. the mutant PUBLISHES the branch carrying the ungranted request.
// Measured 2026-08-10 on this file; the four suites that neighbour this code (push-guard, pr-merge,
// doc-land, approvals-enforce) all still PASS under that mutation, so the refusal is asserted here
// and nowhere else. (The AC2 arms fail under it too — they inject a guard result, which the mutation
// discards; the AC4 arms are the ones that prove the REAL gate is wired in.)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { acquireLock } from "../src/locks.ts";
import { requestApproval, grantApproval } from "../src/approvals.ts";
import { pushApprovalKey, type PushGuardResult } from "../src/push-guard.ts";
import { prMergeLockPath } from "../src/pr-merge.ts";
import { repoLandingLockPath } from "../src/repo-lock-path.ts";
import {
  push, pushExit, pushArgvFor, documentedExitCodes, PUSH_EXIT, PUSH_HELP, type PushResult, type GitExec,
} from "../src/push.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-push-verb-"));
const savedEnv = { ws: process.env.DEVLOOP_WORKSPACE, db: process.env.DEVLOOP_HUB_DB };
try {
  const git = (dir: string, args: string[]): string =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  // A whole fixture WORKSPACE: dev-loop.json + a bare origin + a clone + a branch with one commit
  // referencing `ticket`. LOOP-418 — the workspace root is set explicitly AND `DEVLOOP_HUB_DB` is
  // pointed at the fixture, because an explicit root is OUTRANKED by the env var: without both, a
  // per-file run of this suite resolves the LIVE workspace and its real board.
  const mkWs = (name: string, enforce: string[], ticket: string): { root: string; repo: string; origin: string; branch: string; sha: string; db: string } => {
    const root = join(ROOT, name);
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, ".dev-loop"), { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, repo]);
    git(repo, ["commit", "--allow-empty", "-qm", "baseline"]);
    git(repo, ["push", "-qu", "origin", "main"]);
    const branch = `dev-loop/${ticket}`;
    git(repo, ["checkout", "-qb", branch]);
    writeFileSync(join(repo, "a.txt"), `${name}\n`);
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", `feat: the gated change (${ticket})`]);
    writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      workspaceId: name,
      team: { key: name, backend: "service", ...(enforce.length ? { approvals: { enforce } } : {}) },
      repos: { repo: { path: "repo", remote: "git@github.com:owner/repo521.git" } },
      projects: { p: {} },
    }));
    return { root, repo, origin, branch, sha: git(repo, ["rev-parse", "HEAD"]), db: join(root, ".dev-loop", "hub.db") };
  };

  const mkDb = (dbFile: string, ticket: string): void => {
    const conn = openDb(dbFile);
    conn.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','p','n','t')").run();
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'In Progress',0,'[]','[]','pm','t','t')")
      .run(ticket, "p", "t-" + ticket);
    conn.close();
  };
  const attemptRows = (dbFile: string): number => {
    const conn = openDb(dbFile);
    try { return (conn.prepare("SELECT COUNT(*) c FROM events WHERE kind='approval.attempt'").get() as { c: number }).c; }
    finally { conn.close(); }
  };
  const remoteHas = (originDir: string, branch: string): boolean =>
    execFileSync("git", ["-C", originDir, "for-each-ref", "--format=%(refname:short)", `refs/heads/${branch}`], { encoding: "utf8" }).trim().length > 0;

  const cleanGuard = (branch: string): PushGuardResult =>
    ({ branch, ahead: 1, unknownRefs: [], findings: [], passengers: [], governance: [], approvals: [] });

  // The STRICT git double: exactly the argv `pushUnlocked` issues, and nothing else. `hasUpstream`
  // false ⇒ the nothing-to-push shortcut is skipped, so the flow reaches the gate — which is the
  // path every refusal arm is about.
  const mkExec = (branch: string, opts: { pushOk?: boolean; upstream?: boolean } = {}): { exec: GitExec; calls: string[][]; refused: string[][] } => {
    const calls: string[][] = [];
    const refused: string[][] = [];
    const exec: GitExec = (args) => {
      calls.push(args);
      const j = args.join(" ");
      if (j === "remote get-url origin") return { ok: true, stdout: "git@github.com:owner/repo521.git", stderr: "" };
      if (j === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: branch, stderr: "" };
      if (j === `rev-parse --verify --quiet refs/heads/${branch}`) return { ok: true, stdout: "ref", stderr: "" };
      if (j === `rev-parse ${branch}`) return { ok: true, stdout: "f".repeat(40), stderr: "" };
      if (j === "fetch origin") return { ok: true, stdout: "", stderr: "" };
      if (j === `rev-parse --verify --quiet refs/remotes/origin/${branch}`) return { ok: !!opts.upstream, stdout: opts.upstream ? "ref" : "", stderr: "" };
      if (j === `rev-list --count origin/${branch}..${branch}`) return { ok: true, stdout: "0", stderr: "" };
      if (j === pushArgvFor("origin", branch).join(" ")) return { ok: opts.pushOk !== false, stdout: "", stderr: opts.pushOk === false ? "remote: rejected" : "" };
      refused.push(args);
      return { ok: false, stdout: "", stderr: `test double refused: git ${j}` };
    };
    return { exec, calls, refused };
  };

  // ── AC3 — the exit contract, documented AGAINST the implementation ───────────────────────────────
  {
    const documented = documentedExitCodes(PUSH_HELP);
    ok(JSON.stringify(documented) === JSON.stringify(PUSH_EXIT as unknown as Record<string, number>),
      `AC3 --help's exit table equals PUSH_EXIT (documented=${JSON.stringify(documented)})`);
    // The letter of the AC: the NAMES, not just the numbers — a help that renumbered a code while
    // keeping the set of integers would still be drift.
    ok(Object.keys(documented).sort().join(",") === Object.keys(PUSH_EXIT).sort().join(","),
      "AC3 every PUSH_EXIT key is named in --help, and --help names no other");
    ok(documented.unevaluated === 3 && documented.held === 1,
      "AC3 unresolvedDefaultBranch's code is 3, NOT 1 (design §16.3 D4: a different remedy in kind)");
    // AC8's help half — the discovery path. `--help` must state the gate it runs AND that nothing
    // waives it; a verb that wraps a gate silently is the shape D3 refuses.
    ok(/push-guard --strict/.test(PUSH_HELP), "AC8 --help names the gate it runs (push-guard --strict)");
    ok(/NO FLAG THAT WAIVES THE GATE/i.test(PUSH_HELP), "AC8 --help states that no flag waives the gate");
    ok(/approvals\.enforce/.test(PUSH_HELP) && /push:<branch>:<sha>/.test(PUSH_HELP),
      "AC8 --help names the approvals class + key shape it enforces");
  }

  // ── AC2 — every guard class hard-stops. One assertion per class ──────────────────────────────────
  {
    const BR = "dev-loop/AP-2";
    const classes: Array<{ name: string; token: string; exitCode: number; guard: PushGuardResult }> = [
      { name: "findings", token: "ride-along", exitCode: PUSH_EXIT.held, guard: { ...cleanGuard(BR), findings: [{ sha: "abc1234", subject: "s", ticket: "AP-9", state: "Canceled" }] } },
      { name: "passengers", token: "passenger", exitCode: PUSH_EXIT.held, guard: { ...cleanGuard(BR), passengers: [{ sha: "abc1234", subject: "s", ticketId: "AP-8", boardState: "Canceled", severity: "hard" }] } },
      { name: "governance", token: "governance", exitCode: PUSH_EXIT.held, guard: { ...cleanGuard(BR), governance: [{ sha: "abc1234", subject: "s", file: "references/conventions.md", reason: "conventions" }] } },
      { name: "approvals", token: "ungranted-approval", exitCode: PUSH_EXIT.held, guard: { ...cleanGuard(BR), approvals: [{ sha: "abc1234", subject: "s", key: "push:x:y", ticketId: "AP-2", state: "requested", reason: "not authorised" }] } },
      // Not a `hold` — a refusal with its own exit code (D4). Asserted here because AC2's list names
      // it alongside the four: it must REFUSE, whatever number it exits with.
      { name: "unresolvedDefaultBranch", token: "", exitCode: PUSH_EXIT.unevaluated, guard: { ...cleanGuard(BR), unresolvedDefaultBranch: "main" } },
    ];
    for (const c of classes) {
      const { exec, calls, refused } = mkExec(BR);
      const r = await push("/nowhere", { branch: BR, defaultBranch: "main", exec, guard: () => c.guard, lockPath: join(ROOT, `lk-${c.name}`) });
      ok(r.pushArgv === null, `AC2 ${c.name}: NOTHING was pushed (pushArgv === null, not inferred)`);
      ok(pushExit(r) === c.exitCode, `AC2 ${c.name}: exit ${c.exitCode}`);
      if (c.token) ok(r.holds.some((h) => h.class === c.name && h.token === c.token), `AC2 ${c.name}: named as its own class with token '${c.token}'`);
      else ok(r.gateUnevaluated !== null && r.holds.length === 0, "AC2 unresolvedDefaultBranch: reported as gate-unevaluated, not as a hold");
      ok(!calls.some((a) => a[0] === "push"), `AC2 ${c.name}: no push argv was ever issued to git`);
      ok(refused.length === 0, `AC2 ${c.name}: the double answered every argv the flow issued (no accommodating mock)`);
    }
    // D3's inheritance, stated as its own assertion: `doc-land` downgrades reference findings to WARN
    // because its range is asserted docs-only. This verb makes no such assertion, so a finding that
    // doc-land would merely annotate REFUSES here.
    const { exec } = mkExec(BR);
    const warnOnly = await push("/nowhere", {
      branch: BR, defaultBranch: "main", exec, lockPath: join(ROOT, "lk-warn"),
      guard: () => ({ ...cleanGuard(BR), findings: [{ sha: "d0cd0c1", subject: "docs: note", ticket: "AP-7", state: "Duplicate" }] }),
    });
    ok(pushExit(warnOnly) === PUSH_EXIT.held && warnOnly.pushArgv === null,
      "AC2 a reference finding doc-land would WARN on hard-stops here (no unearned downgrade)");
  }

  // ── AC1 — one call, and no argv that skips the gate ──────────────────────────────────────────────
  {
    const BR = "dev-loop/AP-1";
    const { exec, calls } = mkExec(BR);
    const r = await push("/nowhere", { branch: BR, defaultBranch: "main", exec, guard: () => cleanGuard(BR), lockPath: join(ROOT, "lk-ac1") });
    ok(r.pushed && pushExit(r) === PUSH_EXIT.pushed, "AC1 gate clear ⇒ the push is issued from inside the call");
    ok(JSON.stringify(r.pushArgv) === JSON.stringify(["push", "--set-upstream", "origin", `${BR}:${BR}`]),
      `AC1 the recorded push argv is exactly the expected one (${JSON.stringify(r.pushArgv)})`);
    // D1 — it does NOT open the PR. `gh` is never reached: the double records every argv, and a
    // `pr create` would appear here.
    ok(!calls.some((a) => a.includes("pr") || a.includes("gh")), "AC1 no PR is opened — the verb owns the push only (§16.3 D1)");
    ok(r.sha !== null, "AC1 the result carries the pushed sha (the LOOP-500 discharge seam, §16.6)");
    ok(r.branch === BR, "AC1 the result carries the pushed branch");

    // A push that FAILS at the remote is exit 4 — a forge error, never read as an objection.
    const failing = mkExec(BR, { pushOk: false });
    const rf = await push("/nowhere", { branch: BR, defaultBranch: "main", exec: failing.exec, guard: () => cleanGuard(BR), lockPath: join(ROOT, "lk-ac1f") });
    ok(pushExit(rf) === PUSH_EXIT.pushFailed && rf.pushArgv !== null && rf.holds.length === 0,
      "AC1 gate clear + git push fails ⇒ exit 4 with the argv recorded, and no hold invented");
  }

  // ── AC7 — nothing-to-push is a SUCCESS in its own words ──────────────────────────────────────────
  {
    const BR = "dev-loop/AP-1";
    const { exec, calls } = mkExec(BR, { upstream: true });   // upstream exists, 0 commits ahead
    const r = await push("/nowhere", { branch: BR, defaultBranch: "main", exec, guard: () => cleanGuard(BR), lockPath: join(ROOT, "lk-ac7") });
    ok(r.nothingToPush && !r.pushed && pushExit(r) === PUSH_EXIT.pushed,
      "AC7 an empty origin/<branch>..<branch> exits 0 as nothingToPush, not as a refusal");
    ok(r.holds.length === 0 && r.pushArgv === null, "AC7 nothing-to-push is distinguishable from a hold (no holds, no argv)");
    ok(!calls.some((a) => a[0] === "push"), "AC7 no push subprocess is issued when there is nothing to push");
  }

  // ── AC4 — the regression the ruling asks for: the pr-mode ship path, on a FIXTURE workspace ──────
  //
  // Real git, real workspace config with `approvals.enforce:["push"]`, a real ungranted `push:` row
  // on the commit's ticket. This is the scenario that had NO enforcing caller before this verb.
  {
    const TICKET = "AP-4";
    const ws = mkWs("ac4", ["push"], TICKET);
    mkDb(ws.db, TICKET);
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;      // LOOP-418: an explicit root is outranked by this var
    const conn = openDb(ws.db);
    requestApproval(conn, { projectId: "p", actionKey: pushApprovalKey(ws.branch, ws.sha), requestedBy: "senior-dev", ticketId: TICKET });
    conn.close();

    const before = attemptRows(ws.db);
    const r = await push(ws.repo, { dbPath: ws.db });
    ok(pushExit(r) === PUSH_EXIT.held, "AC4 an ungranted push: approval HOLDS the pr-mode push (exit 1)");
    ok(r.pushArgv === null, "AC4 NOTHING was pushed (pushArgv === null)");
    ok(!remoteHas(ws.origin, ws.branch), "AC4 the branch never reached the remote — asserted on origin, not on the return value");
    ok(r.holds.some((h) => h.class === "approvals" && h.token === "ungranted-approval"),
      "AC4 the refusal names the approvals class");
    ok(r.holds.some((h) => h.detail.includes(pushApprovalKey(ws.branch, ws.sha))),
      "AC4 the refusal names the exact key the operator must grant (push:<branch>:<sha>)");
    ok(attemptRows(ws.db) === before + 1, "AC4 a real run ledgers the approval.attempt (the audit line, approvals §14 d4)");

    // The other half of the same fixture: GRANT the end state and the same call pushes. Without this
    // arm the block would also pass against a verb that refuses everything.
    const conn2 = openDb(ws.db);
    grantApproval(conn2, { projectId: "p", actionKey: pushApprovalKey(ws.branch, ws.sha), grantor: "operator", ticketId: TICKET, expires: "24h" });
    conn2.close();
    const granted = await push(ws.repo, { dbPath: ws.db });
    ok(granted.pushed && pushExit(granted) === PUSH_EXIT.pushed, "AC4 with the end state GRANTED, the same call pushes");
    ok(remoteHas(ws.origin, ws.branch), "AC4 the branch is on the remote after the grant");

    // AC7, on the real fixture: the very next call has nothing to push and says so.
    const again = await push(ws.repo, { dbPath: ws.db });
    ok(again.nothingToPush && pushExit(again) === PUSH_EXIT.pushed && again.pushArgv === null,
      "AC7 re-running after a successful push is an idempotent success, not a refusal");

    // The CLI surface, once, end to end: the wiring, the exit code, and the words a caller reads.
    const cli = spawnSync(process.execPath, [join(hubRoot, "src", "push.ts"), "--repo", ws.repo], {
      encoding: "utf8",
      env: { ...process.env, DEVLOOP_WORKSPACE: ws.root, DEVLOOP_HUB_DB: ws.db },
    });
    ok(cli.status === 0 && /nothing to push/.test(cli.stdout),
      `AC7 the CLI says "nothing to push" in its own words (exit ${cli.status})`);
  }

  // ── AC6 — --dry-run writes nothing, INCLUDING the audit trail ────────────────────────────────────
  {
    const TICKET = "AP-6";
    const ws = mkWs("ac6", ["push"], TICKET);
    mkDb(ws.db, TICKET);
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    const conn = openDb(ws.db);
    requestApproval(conn, { projectId: "p", actionKey: pushApprovalKey(ws.branch, ws.sha), requestedBy: "senior-dev", ticketId: TICKET });
    conn.close();

    const before = attemptRows(ws.db);
    const dry = await push(ws.repo, { dbPath: ws.db, dryRun: true });
    ok(attemptRows(ws.db) === before, "AC6 --dry-run appends NO approval.attempt row (record:false — the R10 defect doc-land shipped)");
    ok(!remoteHas(ws.origin, ws.branch), "AC6 --dry-run pushed nothing");
    const real = await push(ws.repo, { dbPath: ws.db });
    const verdict = (r: PushResult): string => JSON.stringify({ exit: pushExit(r), holds: r.holds.map((h) => [h.class, h.token, h.detail]) });
    ok(verdict(dry) === verdict(real), "AC6 the dry run reports the IDENTICAL verdict the real run does (every check still ran)");
    ok(attemptRows(ws.db) === before + 1, "AC6 the real run DOES ledger it — the suppression is the dry run's alone");

    // A dry run whose gate CLEARS still pushes nothing and records no argv.
    const conn3 = openDb(ws.db);
    grantApproval(conn3, { projectId: "p", actionKey: pushApprovalKey(ws.branch, ws.sha), grantor: "operator", ticketId: TICKET, expires: "24h" });
    conn3.close();
    const dryClear = await push(ws.repo, { dbPath: ws.db, dryRun: true });
    ok(pushExit(dryClear) === PUSH_EXIT.pushed && dryClear.pushArgv === null && !dryClear.pushed && !remoteHas(ws.origin, ws.branch),
      "AC6 a CLEARING dry run reports success but issues no push and leaves no argv");
  }

  // ── AC5 — the shared lock, under its real name ───────────────────────────────────────────────────
  {
    const TICKET = "AP-5";
    const ws = mkWs("ac5", [], TICKET);
    mkDb(ws.db, TICKET);
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    const GH = "owner/repo521";

    // A REAL linked worktree — the normal dev-tier invocation (§7 makes it mandatory for both split
    // tiers, in every landing mode). Its `.git` is a file, so the resolution has to walk to the base
    // clone to recognise the registered repo.
    const wt = join(ws.root, "wt", TICKET);
    git(ws.repo, ["worktree", "add", "-q", "--detach", wt, "HEAD"]);

    const fromRepo = repoLandingLockPath(ws.repo, GH);
    const fromWorktree = repoLandingLockPath(wt, GH);
    const fromWsRoot = repoLandingLockPath(ws.root, GH);
    ok(fromRepo.endsWith("repo-repo.lock"), `AC5 a registered repo resolves to the registry ref's lock name (${fromRepo})`);
    ok(fromWorktree === fromRepo, "AC5 a linked WORKTREE resolves to the same lock as its base clone");
    ok(fromWsRoot === fromRepo, "AC5 the workspace-root invocation resolves to the same lock (matched on the remote)");
    // The identity `pr merge` depends on: same module, same answer. Two names is not serialization.
    ok(prMergeLockPath(ws.repo, GH) === fromRepo && prMergeLockPath(wt, GH) === fromWorktree,
      "AC5 `pr merge` and `push` resolve the IDENTICAL path for the same repo, from a worktree and from the workspace root");
    ok(prMergeLockPath === repoLandingLockPath, "AC5 they are the same function, not two copies that agree today");

    // And the verb TAKES it: with the lock held, nothing ran — no gate, no push — and it is a retry
    // (exit 5), not an objection anyone must answer.
    const release = await acquireLock(fromRepo, { totalMs: 5_000 });
    try {
      const held = await push(ws.repo, { dbPath: ws.db, lockWaitMs: 200 });
      ok(pushExit(held) === PUSH_EXIT.lockUnavailable, "AC5 the lock is taken unconditionally — a held lock exits 5");
      ok(held.pushArgv === null && held.holds.length === 0 && held.guard === null,
        "AC5 a lock failure means the gate NEVER RAN: no argv, no holds, no guard result");
      ok(!remoteHas(ws.origin, ws.branch), "AC5 nothing was pushed while the lock was held");
    } finally { release(); }

    // Released: the same call now runs the gate and pushes (proves the arm above was the lock, not a
    // second cause).
    const after = await push(ws.repo, { dbPath: ws.db });
    ok(after.pushed && remoteHas(ws.origin, ws.branch), "AC5 with the lock released the same call gates and pushes");
  }

  // ── Readiness (§16.3 D2) — named honestly, and it refuses rather than guessing ───────────────────
  {
    const noRemote = await push("/nowhere", {
      branch: "dev-loop/AP-0", defaultBranch: "main", lockPath: join(ROOT, "lk-nr"),
      exec: () => ({ ok: false, stdout: "", stderr: "no such remote" }),
    });
    ok(pushExit(noRemote) === PUSH_EXIT.held && noRemote.holds[0]?.token === "no-remote",
      "D2 readiness: an unconfigured remote is a hold, named as readiness");
    const detached: GitExec = (args) => {
      const j = args.join(" ");
      if (j === "remote get-url origin") return { ok: true, stdout: "git@github.com:owner/repo521.git", stderr: "" };
      if (j === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: "HEAD", stderr: "" };
      return { ok: false, stdout: "", stderr: "unexpected" };
    };
    const r2 = await push("/nowhere", { defaultBranch: "main", exec: detached, lockPath: join(ROOT, "lk-det") });
    ok(pushExit(r2) === PUSH_EXIT.held && r2.holds[0]?.token === "no-branch" && r2.pushArgv === null,
      "D2 readiness: a detached HEAD refuses rather than guessing a branch to publish");
    // An unresolvable default branch is a USAGE failure (exit 2), not a silent "main": the gate's
    // passenger range is measured against it, so guessing would measure a range nobody configured.
    const r3 = await push(join(ROOT, "not-a-workspace"), {});
    ok(pushExit(r3) === PUSH_EXIT.usage && r3.unresolved !== null,
      "D2 an unresolvable default branch is exit 2 with a named cause, never a guessed 'main'");
  }
} finally {
  if (savedEnv.ws === undefined) delete process.env.DEVLOOP_WORKSPACE; else process.env.DEVLOOP_WORKSPACE = savedEnv.ws;
  if (savedEnv.db === undefined) delete process.env.DEVLOOP_HUB_DB; else process.env.DEVLOOP_HUB_DB = savedEnv.db;
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\n✅ push-verb: all assertions passed" : `\n❌ push-verb: ${fails} assertion(s) failed`);
process.exit(fails === 0 ? 0 : 1);
