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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { openDb } from "../src/db.ts";
import { acquireLock } from "../src/locks.ts";
import { requestApproval, grantApproval } from "../src/approvals.ts";
import { pushApprovalKey, pushGuard, type PushGuardResult } from "../src/push-guard.ts";
import { prMergeLockPath } from "../src/pr-merge.ts";
import { repoLandingLockPath } from "../src/repo-lock-path.ts";
import {
  push, pushExit, pushArgvFor, setUpstreamArgvFor, documentedExitCodes, PUSH_EXIT, PUSH_HELP,
  forcePublishEligible, pushFailureReason, type PushResult, type GitExec,
} from "../src/push.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = tmpRoot("dl-push-verb-");
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
      if (j === pushArgvFor("origin", branch, "f".repeat(40)).join(" ")) return { ok: opts.pushOk !== false, stdout: "", stderr: opts.pushOk === false ? "remote: rejected" : "" };
      // LOOP-528 — the tracking step the pinned refspec forced out of the push argv. Answered here so
      // the double stays STRICT: it is an argv this flow really issues, not a wildcard.
      if (j === setUpstreamArgvFor("origin", branch).join(" ")) return { ok: true, stdout: "", stderr: "" };
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
    // AC6's contract half (PR #287 review, P2): --dry-run DOES fetch, because a verdict measured
    // against a base the real run will not use is not the real run's verdict. The help says which
    // way it cuts instead of claiming a blanket "mutates nothing" the code does not honour.
    ok(/writes nothing\s+OUTWARD/.test(PUSH_HELP) && /git fetch/.test(PUSH_HELP),
      "AC6 --help scopes the dry run's promise to OUTWARD writes and names the fetch it still runs");
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
    // LOOP-528 — the source is the SHA the gate cleared, not the branch name; `--set-upstream` moved
    // to its own step because git silently ignores it with a sha source.
    ok(JSON.stringify(r.pushArgv) === JSON.stringify(["push", "origin", `${"f".repeat(40)}:refs/heads/${BR}`]),
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
      // scrubFireEnv, not a raw spread (LOOP-193): this suite runs INSIDE a fire, so the ambient
      // DEVLOOP_* markers would out-rank the fixture and point the CLI at the live workspace. The two
      // explicit overrides still win, which is the helper's documented contract.
      env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: ws.root, DEVLOOP_HUB_DB: ws.db },
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

  // ── The worktree invocation — the one §7 mandates, and the one the verb was built for ───────────
  //
  // PR #287 review, P1. `dev-loop push` replaces the feature-branch push in the dev-agent ship
  // sequence, and §7 runs that sequence in a linked worktree — which equals no registered `path`, so
  // the exact-path registry match answered "not a registered repo" and the verb exited 2 in its own
  // call site. The second arm is the consequence Codex did not name and the one that matters more:
  // `pushGuard` resolves `approvals.enforce` from the same path, so once the exit 2 were fixed by
  // hand at the call site (`--default-branch`), the gate would have resolved itself OFF there —
  // a silent fail-open in the gate this ticket exists to install.
  //
  // Both worktree locations are exercised: inside the workspace tree, and OUTSIDE it at §7's
  // canonical `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project>/wt/<ticket>`, where the upward walk for
  // `dev-loop.json` finds nothing at all.
  for (const [where, wtBase] of [["inside the workspace tree", null], ["OUTSIDE it (§7's ~/.dev-loop/…/wt path)", join(ROOT, "external-wt")]] as const) {
    // Digit ids, not "AP-WX": `branchTicketId` matches the canonical <PREFIX>-<n> shape only, and a
    // branch it cannot parse has no own-ticket to compare against — the arm would pass or fail for a
    // reason that has nothing to do with the worktree.
    const TICKET = wtBase ? "AP-72" : "AP-71";
    const ws = mkWs(wtBase ? "wtx" : "wti", ["push"], TICKET);
    mkDb(ws.db, TICKET);
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    const conn = openDb(ws.db);
    requestApproval(conn, { projectId: "p", actionKey: pushApprovalKey(ws.branch, ws.sha), requestedBy: "senior-dev", ticketId: TICKET });
    conn.close();

    // A real linked worktree ON the ticket branch — what the ship sequence pushes from. The shared
    // checkout goes back to `main` first, which is not fixture bookkeeping: §7 keeps the base clone
    // parked on `defaultBranch` precisely so the ticket's branch lives only in its worktree.
    const wt = join(wtBase ?? join(ws.root, ".dev-loop"), "wt", TICKET);
    mkdirSync(dirname(wt), { recursive: true });
    git(ws.repo, ["checkout", "-q", "main"]);
    git(ws.repo, ["worktree", "add", "-q", wt, ws.branch]);

    const r = await push(wt, { dbPath: ws.db });
    ok(r.unresolved === null,
      `worktree ${where}: the repo resolves — no "not a registered repo" exit 2 (${r.unresolved ?? "resolved"})`);
    // THE fail-open assertion. `dbPath` is passed, so this arm is not about which db was read: it is
    // about whether `approvals.enforce` was found at all from a worktree path.
    ok(pushExit(r) === PUSH_EXIT.held && r.holds.some((h) => h.class === "approvals"),
      `worktree ${where}: the approvals gate is still ON — the ungranted push HOLDS (exit ${pushExit(r)})`);
    ok(r.pushArgv === null && !remoteHas(ws.origin, ws.branch),
      `worktree ${where}: nothing was pushed — asserted on origin, not on the return value`);
    // The lock is the SAME one the base clone takes: a worktree that locked under its own name would
    // serialize against nobody (AC5's invariant, now asserted from outside the workspace tree too).
    ok(repoLandingLockPath(wt, "owner/repo521") === repoLandingLockPath(ws.repo, "owner/repo521"),
      `worktree ${where}: takes the base clone's landing lock, not one of its own`);

    // The grant clears it from the worktree exactly as from the base clone — so the hold above was
    // the gate doing its job, not the worktree path failing in a second way.
    const conn2 = openDb(ws.db);
    grantApproval(conn2, { projectId: "p", actionKey: pushApprovalKey(ws.branch, ws.sha), grantor: "operator", ticketId: TICKET, expires: "24h" });
    conn2.close();
    const granted = await push(wt, { dbPath: ws.db });
    ok(granted.pushed && remoteHas(ws.origin, ws.branch),
      `worktree ${where}: with the end state granted, the same call pushes from the worktree`);
  }

  // ── --remote gates the remote it pushes to (PR #287 review, P2) ──────────────────────────────────
  //
  // The flag existed and the guard was origin-only, so a non-origin push was gated against origin's
  // refs: the wrong commit range, or "unevaluated" for a remote that resolves fine. The fixture gives
  // the two remotes DIFFERENT tips, so a guard still reading origin sees a different range and the
  // assertion below separates them.
  {
    const TICKET = "AP-RM";
    const ws = mkWs("remote", [], TICKET);
    mkDb(ws.db, TICKET);
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    const alt = join(ws.root, "alt.git");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", alt]);
    git(ws.repo, ["remote", "add", "alt", alt]);
    git(ws.repo, ["push", "-q", "alt", "main"]);
    // ORIGIN carries the branch; ALT carries only main. So the two remotes give opposite readiness
    // answers for the same repo and branch, and an origin-only reading of `--remote alt` is visible.
    git(ws.repo, ["push", "-q", "origin", `${ws.branch}:${ws.branch}`]);

    const viaOrigin = await push(ws.repo, { dbPath: ws.db });
    ok(viaOrigin.nothingToPush && pushExit(viaOrigin) === PUSH_EXIT.pushed,
      "P2 --remote: against origin there is nothing to push (origin already carries the branch)");
    // The REAL guard's ranges follow the remote, not just readiness — measured through the library
    // BEFORE the push below, while origin/<branch> exists and alt/<branch> does not: an origin-only
    // guard reports a tracked branch, an alt-aware one reports the first-push note.
    const gAlt = pushGuard(ws.repo, ws.branch, ws.db, "main", { remote: "alt" });
    const gOrigin = pushGuard(ws.repo, ws.branch, ws.db, "main", {});
    ok(gOrigin.note === undefined && (gAlt.note ?? "").includes("alt/"),
      `P2 --remote: pushGuard's own ranges use the given remote (alt note=${JSON.stringify(gAlt.note)}, origin note=${JSON.stringify(gOrigin.note)})`);

    // The same call against alt must NOT read origin's answer: it has a real push to make, so the
    // gate runs — and it is told which remote it is gating, because its ranges are that remote's.
    const seen: string[] = [];
    const viaAlt = await push(ws.repo, {
      dbPath: ws.db, remote: "alt",
      guard: (ctx) => { seen.push(ctx.remote); return cleanGuard(ctx.branch); },
    });
    ok(!viaAlt.nothingToPush && viaAlt.pushed,
      "P2 --remote: readiness is measured against the SELECTED remote, not origin");
    ok(seen.length === 1 && seen[0] === "alt", `P2 --remote: the gate is told which remote it is gating (${JSON.stringify(seen)})`);
    ok(remoteHas(alt, ws.branch), "P2 --remote: the branch reached the selected remote");
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

  // ══ LOOP-528 ═════════════════════════════════════════════════════════════════════════════════════
  // The four findings PR #287 merged with. Every branch `mkWs` builds is a FIRST push (created, never
  // pushed), which is why these arms sit on the same fixture the AC4 block uses: the case that was
  // broken is the case the whole suite was already running in.

  // ── AC1/AC3 — a first push evaluates `governance` and `findings`, not `[]` ────────────────────────
  {
    const TICKET = "AP-5281";
    const ws = mkWs("ac528-gov", [], TICKET);
    mkDb(ws.db, TICKET);
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    // A §17 governing file, in a commit on a branch with no upstream. Before LOOP-528 the guard
    // hard-coded `governance: []` on exactly this shape, so the most dangerous push the loop can make
    // — a first push carrying a conventions edit — read clean.
    mkdirSync(join(ws.repo, "references"), { recursive: true });
    writeFileSync(join(ws.repo, "references", "conventions.md"), "# conventions\nrule\n");
    git(ws.repo, ["add", "references/conventions.md"]);
    git(ws.repo, ["commit", "-qm", `docs: edit the governing file (${TICKET})`]);

    const g = pushGuard(ws.repo, undefined, ws.db, "main");
    ok(g.governance.length === 1 && g.governance[0]!.file === "references/conventions.md",
      `AC1 a FIRST push evaluates the governance class (got ${g.governance.length} entr(y/ies))`);
    ok(g.ahead === 2, `AC1 the first-push range is origin/main..<branch>, so both commits are scanned (ahead=${g.ahead})`);
    ok(/first push of this branch; gated over origin\/main\.\./.test(g.note ?? ""),
      `AC1 the note NAMES the range the classes used rather than claiming nothing to compare (note=${g.note})`);
    const held = await push(ws.repo, { dbPath: ws.db });
    ok(pushExit(held) === PUSH_EXIT.held && held.holds.some((h) => h.class === "governance"),
      "AC1 the verb HARD-STOPS on it (§16.3 D3 — all five classes refuse)");
    ok(held.pushArgv === null && !remoteHas(ws.origin, ws.branch), "AC1 nothing was pushed");
  }

  // The second class the early return emptied. A separate fixture, so neither arm can pass on the
  // other's finding — reverting the AC1 change must fail BOTH, and nothing else.
  {
    const TICKET = "AP-5282";
    const DEAD = "AP-5289";
    const ws = mkWs("ac528-find", [], TICKET);
    mkDb(ws.db, TICKET);
    const conn = openDb(ws.db);
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'Canceled',0,'[]','[]','pm','t','t')")
      .run(DEAD, "p", "canceled");
    conn.close();
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    writeFileSync(join(ws.repo, "b.txt"), "b\n");
    git(ws.repo, ["add", "b.txt"]);
    git(ws.repo, ["commit", "-qm", `feat: work for a canceled ticket (${DEAD})`]);

    const g = pushGuard(ws.repo, undefined, ws.db, "main");
    ok(g.findings.some((f) => f.ticket === DEAD && f.state === "Canceled"),
      `AC1 a FIRST push evaluates the findings class (got ${JSON.stringify(g.findings.map((f) => f.ticket))})`);
    const held = await push(ws.repo, { dbPath: ws.db });
    ok(pushExit(held) === PUSH_EXIT.held && held.holds.some((h) => h.class === "findings"),
      "AC1 a ride-along canceled ticket hard-stops a first push");
  }

  // ── AC2 — unevaluable is exit 3, never an empty-classes exit 0 ───────────────────────────────────
  {
    const TICKET = "AP-5283";
    const ws = mkWs("ac528-unev", [], TICKET);
    mkDb(ws.db, TICKET);
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    // No origin/<branch> and no origin/<defaultBranch>: the range cannot be resolved from either
    // remote ref. `main` exists on the remote in this fixture, so name a default branch that does not.
    const g = pushGuard(ws.repo, undefined, ws.db, "nonexistent-base");
    ok(g.unresolvedDefaultBranch === "nonexistent-base",
      "AC2 an unresolvable base is REPORTED, not reported as three clean classes");
    const r = await push(ws.repo, { dbPath: ws.db, defaultBranch: "nonexistent-base" });
    ok(pushExit(r) === PUSH_EXIT.unevaluated, `AC2 the verb exits 3 (unevaluated), not 0 — got ${pushExit(r)}`);
    ok(r.pushArgv === null && !remoteHas(ws.origin, ws.branch), "AC2 and it pushes nothing");
  }

  // ── AC4 — the push is pinned to the sha the gate cleared ─────────────────────────────────────────
  {
    const TICKET = "AP-5284";
    const ws = mkWs("ac528-pin", [], TICKET);
    mkDb(ws.db, TICKET);
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    const guarded = ws.sha;
    // The race, made deterministic: the injected guard is the gate, so committing from inside it
    // lands a commit at exactly the moment the real TOCTOU window opens — after the gate has read the
    // branch, before the push resolves it.
    let raced = "";
    const r = await push(ws.repo, {
      dbPath: ws.db,
      guard: (ctx) => {
        writeFileSync(join(ws.repo, "raced.txt"), "committed while the gate ran\n");
        git(ws.repo, ["add", "raced.txt"]);
        git(ws.repo, ["commit", "-qm", `feat: NOT gated (${TICKET})`]);
        raced = git(ws.repo, ["rev-parse", "HEAD"]);
        return pushGuard(ctx.repoDir, ctx.branch, ctx.dbPath, ctx.defaultBranch);
      },
    });
    ok(r.pushed, `AC4 the gate cleared and the push happened (exit ${pushExit(r)})`);
    ok(raced !== guarded, "AC4 the fixture really did move the branch under the gate");
    // Assert the OUTCOME, not just the argv: an argv-shape-only assertion would pass against a verb
    // that built the right refspec and pushed something else.
    const published = execFileSync("git", ["-C", ws.origin, "rev-parse", `refs/heads/${ws.branch}`], { encoding: "utf8" }).trim();
    ok(published === guarded, `AC4 the REMOTE carries the guarded sha, not the racing commit (published=${published.slice(0, 8)} guarded=${guarded.slice(0, 8)} raced=${raced.slice(0, 8)})`);
    ok(r.pushArgv?.join(" ") === `push origin ${guarded}:refs/heads/${ws.branch}`,
      `AC4 the refspec names the sha, not the branch (${r.pushArgv?.join(" ")})`);
    ok(r.advancedTo === raced, "AC4 the caller is TOLD their newer commit was not published");
    // The tracking `-u` used to set: git accepts --set-upstream with a sha source and silently skips
    // it, so the verb restores it as its own step. Without this the §17 substitution would regress
    // `git status`'s ahead/behind for every dev-tier branch.
    const upstream = execFileSync("git", ["-C", ws.repo, "rev-parse", "--abbrev-ref", `${ws.branch}@{upstream}`], { encoding: "utf8" }).trim();
    ok(upstream === `origin/${ws.branch}`, `AC4 upstream tracking is still set after the pinned push (${upstream})`);
  }

  // ── AC5 — the findings db resolves from an external worktree (the third reader) ───────────────────
  {
    const TICKET = "AP-5285";
    const DEAD = "AP-5288";
    const ws = mkWs("ac528-wt", [], TICKET);
    mkDb(ws.db, TICKET);
    const conn = openDb(ws.db);
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'Canceled',0,'[]','[]','pm','t','t')")
      .run(DEAD, "p", "canceled");
    conn.close();
    process.env.DEVLOOP_WORKSPACE = ws.root;
    process.env.DEVLOOP_HUB_DB = ws.db;
    writeFileSync(join(ws.repo, "c.txt"), "c\n");
    git(ws.repo, ["add", "c.txt"]);
    git(ws.repo, ["commit", "-qm", `feat: ride-along (${DEAD})`]);

    const fromRoot = pushGuard(ws.repo, undefined, undefined, "main");   // dbPath undefined ⇒ RESOLVED
    // A real linked worktree OUTSIDE the workspace tree — §7's canonical dev-tier ship location.
    const wt = join(ROOT, "ac528-wt-external", TICKET);
    mkdirSync(dirname(wt), { recursive: true });
    git(ws.repo, ["worktree", "add", "-q", "--detach", wt, ws.branch]);
    const fromWt = pushGuard(wt, ws.branch, undefined, "main");
    ok(fromRoot.findings.some((f) => f.ticket === DEAD),
      "AC5 from the workspace root the findings db resolves and the canceled ref is found");
    ok(fromWt.findings.some((f) => f.ticket === DEAD),
      `AC5 from an EXTERNAL worktree it resolves the SAME db (findings=${fromWt.findings.length}, unknownRefs=${JSON.stringify(fromWt.unknownRefs)})`);
    ok(fromWt.unknownRefs.length === 0,
      "AC5 and it does not degrade to 'no local hub', which is how the wrong root failed silently");
  }

  // ── AC6 — a trailing value-flag is a usage error, not its own default ────────────────────────────
  {
    for (const flag of ["--branch", "--remote", "--default-branch", "--lock-wait"]) {
      const cli = spawnSync(process.execPath, [join(hubRoot, "src", "push.ts"), flag], {
        encoding: "utf8", env: { ...scrubFireEnv() },
      });
      ok(cli.status === PUSH_EXIT.usage && cli.stderr.includes(`${flag} needs a value`),
        `AC6 a trailing ${flag} exits 2 and names the flag (exit ${cli.status})`);
    }
    // The flag-shaped value is the same typo one token later, and it must not be swallowed either.
    const swallowed = spawnSync(process.execPath, [join(hubRoot, "src", "push.ts"), "--branch", "--dry-run"], {
      encoding: "utf8", env: { ...scrubFireEnv() },
    });
    ok(swallowed.status === PUSH_EXIT.usage, `AC6 '--branch --dry-run' is a usage error, not a dry run of HEAD (exit ${swallowed.status})`);
  }

  // ══ LOOP-536 — publishing a REBASED branch ═══════════════════════════════════════════════════════
  //
  // §12c prescribes a rebase as the remedy for a stale ciFreshness hold or a DIRTY mergeStateStatus.
  // A rebased branch is by construction not a fast-forward of its remote counterpart, so the plain
  // refspec `<sha>:refs/heads/<branch>` is REJECTED and the remedy was unexecutable. Measured on this
  // workspace 2026-08-10 (LOOP-396 @ 82ba4fa): gate CLEARS, exit 4, `pushError: "To github.com:…"`.
  //
  // These arms use a real git repo pair (AC6), never the injected double: the defect is git's own
  // refusal, and a double that answers a push argv cannot reproduce a non-fast-forward.

  // Push the branch to origin, advance main, then rebase the branch onto it — the exact state §12c's
  // remedy leaves behind, and the only one in which a lease is spent.
  const divergeFixture = (ws: { repo: string; origin: string; branch: string }): { publishedSha: string; rebasedSha: string } => {
    git(ws.repo, ["push", "-q", "origin", ws.branch]);
    const publishedSha = git(ws.repo, ["rev-parse", ws.branch]);
    git(ws.repo, ["checkout", "-q", "main"]);
    writeFileSync(join(ws.repo, "base.txt"), "the base moves\n");
    git(ws.repo, ["add", "base.txt"]);
    git(ws.repo, ["commit", "-qm", "chore: the base moves"]);
    git(ws.repo, ["push", "-q", "origin", "main"]);
    git(ws.repo, ["checkout", "-q", ws.branch]);
    git(ws.repo, ["rebase", "-q", "origin/main"]);
    git(ws.repo, ["fetch", "-q", "origin"]);
    return { publishedSha, rebasedSha: git(ws.repo, ["rev-parse", ws.branch]) };
  };
  const originTip = (originDir: string, branch: string): string =>
    execFileSync("git", ["-C", originDir, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim();

  // ── AC1 — a rebased branch IS published, under a lease ───────────────────────────────────────────
  {
    const ws = mkWs("l536-ac1", [], "AP-536");
    const { publishedSha, rebasedSha } = divergeFixture(ws);
    ok(publishedSha !== rebasedSha, "AC1 fixture: the rebase really moved the tip (a same-sha fixture would prove nothing)");

    const r = await push(ws.repo, { defaultBranch: "main", lockPath: join(ROOT, "lk-536-ac1") });
    ok(pushExit(r) === PUSH_EXIT.pushed && r.pushed, `AC1 a rebased dev-loop/<id> branch is published (exit ${pushExit(r)}, pushError=${JSON.stringify(r.pushError)})`);
    ok(originTip(ws.origin, ws.branch) === rebasedSha, "AC1 the REMOTE now carries the rebased tip — asserted on origin, not on the verb's own claim");
    // The lease is the mechanism, and it is pinned to the sha the fetch saw — asserted on the recorded
    // argv so "it force-pushed safely" is a checkable fact rather than an inference from success.
    ok(r.pushArgv?.includes(`--force-with-lease=refs/heads/${ws.branch}:${publishedSha}`) === true,
      `AC1 the argv carries the lease pinned to the fetched origin sha (${JSON.stringify(r.pushArgv)})`);
    ok(r.forcePublish?.diverged === true && r.forcePublish.eligible === true, "AC1 the result reports the divergence and the eligibility that spent the lease");
    // AC5's receipt half: the sha this push REPLACED is carried out of the verb, so the caller (and
    // LOOP-500's observing consumer) can record what was destroyed, not just what was published.
    ok(r.forcePublish?.overwrittenSha === publishedSha, `AC5 the result names the sha the force-publish overwrote (${r.forcePublish?.overwrittenSha?.slice(0, 12)})`);
  }

  // ── AC1/AC3 — there is no BARE force, ever ───────────────────────────────────────────────────────
  {
    // The argv builder is the only place force semantics can enter, so this is where "no bare --force"
    // is pinned. Both shapes: with a lease and without.
    const plain = pushArgvFor("origin", "dev-loop/AP-9", "a".repeat(40));
    const leased = pushArgvFor("origin", "dev-loop/AP-9", "a".repeat(40), "b".repeat(40));
    ok(!plain.includes("--force") && !plain.some((a) => a.startsWith("--force")), "AC1 no lease ⇒ a plain refspec, no force of any kind");
    ok(leased.includes(`--force-with-lease=refs/heads/dev-loop/AP-9:${"b".repeat(40)}`), "AC1 a lease ⇒ --force-with-lease pinned to the expected sha");
    ok(!leased.includes("--force") && !leased.includes("-f") && !leased.some((a) => a === "--force-with-lease"),
      "AC1 the leased argv contains NO bare --force and no bare --force-with-lease (which would read remote-tracking refs this verb just refreshed)");
  }

  // ── AC2 — the lease is HONOURED: a remote that moved after the fetch refuses the push ────────────
  {
    const ws = mkWs("l536-ac2", [], "AP-537");
    const { rebasedSha } = divergeFixture(ws);
    // A CONCURRENT writer publishes to the same branch after our fetch — the exact race the lease
    // exists for. `--force` would silently destroy this commit; the lease must refuse.
    const other = join(ROOT, "l536-ac2-other");
    execFileSync("git", ["clone", "-q", ws.origin, other]);
    git(other, ["checkout", "-q", ws.branch]);
    writeFileSync(join(other, "theirs.txt"), "another writer\n");
    git(other, ["add", "theirs.txt"]);
    git(other, ["commit", "-qm", "feat: the other writer's commit"]);
    git(other, ["push", "-q", "origin", ws.branch]);
    const theirs = git(other, ["rev-parse", "HEAD"]);

    // NOTE: no `git fetch` in the fixture repo — its remote-tracking ref still holds the pre-race sha,
    // which is precisely what the lease pins. (The verb fetches internally, but the lease sha is read
    // before the push, and the race is what happens in between.)
    const r = await push(ws.repo, { defaultBranch: "main", lockPath: join(ROOT, "lk-536-ac2") });
    ok(!r.pushed, "AC2 the push did NOT succeed against a remote that moved after the lease was taken");
    ok(originTip(ws.origin, ws.branch) === theirs, "AC2 the other writer's commit is STILL the remote tip — it was not overwritten");
    ok(r.pushError !== null && /stale info|rejected|non-fast-forward/i.test(r.pushError),
      `AC2 the failure says the remote moved, in git's own words (${JSON.stringify(r.pushError)})`);
    ok(rebasedSha !== theirs, "AC2 fixture: the two writers really produced different tips");
  }

  // ── AC3 — the default branch and foreign branches are refused a force-publish outright ───────────
  {
    // The predicate, exhaustively, because it IS the safety boundary — and asserted independently of
    // any divergence, per the AC's "whatever the divergence".
    const cases: Array<[string, string, boolean]> = [
      ["dev-loop/LOOP-536", "main", true],
      ["dev-loop/AP-1", "main", true],
      ["main", "main", false],                    // the default branch
      ["dev-loop/main", "main", false],           // inside the namespace, but not a ticket id
      ["dev-loop/LOOP-536-prefix", "main", false],// a real shape in this workspace's worktree list
      ["dev-loop/LOOP-536/sub", "main", false],
      ["feature/x", "main", false],               // a foreign branch
      ["dev-loop/LOOP-536", "dev-loop/LOOP-536", false], // default branch wins over the pattern
    ];
    for (const [branch, db, want] of cases) {
      const got = forcePublishEligible(branch, db).eligible;
      ok(got === want, `AC3 forcePublishEligible('${branch}', default='${db}') === ${want}`);
    }

    // End to end: a DIVERGED branch that is not a ticket branch gets the plain refspec and git's
    // rejection — the verb neither escalates nor pretends it succeeded.
    const ws = mkWs("l536-ac3", [], "AP-538");
    git(ws.repo, ["checkout", "-qb", "feature/foreign"]);
    writeFileSync(join(ws.repo, "f.txt"), "foreign\n");
    git(ws.repo, ["add", "f.txt"]);
    git(ws.repo, ["commit", "-qm", "feat: foreign work"]);
    git(ws.repo, ["push", "-q", "origin", "feature/foreign"]);
    const foreignPublished = originTip(ws.origin, "feature/foreign");
    git(ws.repo, ["commit", "-q", "--amend", "-m", "feat: foreign work, amended"]);   // diverge
    git(ws.repo, ["fetch", "-q", "origin"]);

    const r = await push(ws.repo, { branch: "feature/foreign", defaultBranch: "main", lockPath: join(ROOT, "lk-536-ac3") });
    ok(r.forcePublish?.diverged === true && r.forcePublish.eligible === false,
      "AC3 a diverged FOREIGN branch is reported diverged-but-ineligible, so the refusal is legible");
    ok(r.pushArgv !== null && !r.pushArgv.some((a) => a.startsWith("--force")),
      `AC3 no force argv was issued for the foreign branch (${JSON.stringify(r.pushArgv)})`);
    ok(!r.pushed && pushExit(r) === PUSH_EXIT.pushFailed, `AC3 it fails as a remote error (exit ${pushExit(r)}), not as a silent success`);
    ok(originTip(ws.origin, "feature/foreign") === foreignPublished, "AC3 the foreign branch on origin is UNCHANGED — nothing was rewritten");
  }

  // ── AC4 — a failed push reports git's REASON, not its banner line ────────────────────────────────
  {
    // The unit half: the parser, against git's real measured stderr shape. Pinned separately from the
    // end-to-end arm so a future refactor of either one cannot quietly drop the other.
    const realStderr = [
      "To /tmp/x/origin.git",
      " ! [rejected]        08b2af25899014d76d503aec5f7471261e857bf9 -> dev-loop/AP-1 (non-fast-forward)",
      "error: failed to push some refs to '/tmp/x/origin.git'",
      "hint: Updates were rejected because the tip of your current branch is behind",
      "hint: its remote counterpart. If you want to integrate the remote changes,",
    ].join("\n");
    const reason = pushFailureReason(realStderr);
    ok(/\(non-fast-forward\)/.test(reason), `AC4 the reason survives the parse (${JSON.stringify(reason)})`);
    ok(!/^To\s/.test(reason), "AC4 the destination banner is not the whole reason any more");
    // The fallback: an unrecognised shape must not be reported as an empty reason — that is the same
    // defect one level down.
    ok(pushFailureReason("To only.git") === "To only.git", "AC4 a stderr that is ONLY a banner falls back to it rather than reporting nothing");
    ok(pushFailureReason("") === "git push failed", "AC4 an empty stderr still names a failure");
    ok(pushFailureReason("fatal: Authentication failed") === "fatal: Authentication failed", "AC4 an unrelated failure shape passes through intact");

    // The end-to-end half: a REAL rejected push, through the verb.
    const ws = mkWs("l536-ac4", [], "AP-539");
    git(ws.repo, ["push", "-q", "origin", ws.branch]);
    const other = join(ROOT, "l536-ac4-other");
    execFileSync("git", ["clone", "-q", ws.origin, other]);
    git(other, ["checkout", "-q", ws.branch]);
    writeFileSync(join(other, "theirs.txt"), "x\n");
    git(other, ["add", "theirs.txt"]);
    git(other, ["commit", "-qm", "feat: theirs"]);
    git(other, ["push", "-q", "origin", ws.branch]);
    // Ours diverges by amend; the branch IS a ticket branch, so a lease is spent — and the lease is
    // stale, so git refuses with `(stale info)`.
    git(ws.repo, ["commit", "-q", "--amend", "-m", "feat: the gated change (AP-539), amended"]);

    const r = await push(ws.repo, { defaultBranch: "main", lockPath: join(ROOT, "lk-536-ac4") });
    ok(r.pushError !== null && !/^To\s/.test(r.pushError),
      `AC4 end to end: pushError is not the 'To <url>' banner (${JSON.stringify(r.pushError)})`);
    ok(r.pushError !== null && /rejected|stale info|non-fast-forward/i.test(r.pushError),
      "AC4 end to end: pushError names the rejection git printed");
  }

  // ── AC6 — the negative control: a NON-diverged branch still publishes as a plain fast-forward ────
  //
  // Without this, "force-push everything" passes every arm above. This is the arm that makes the fix
  // narrow rather than merely effective.
  {
    const ws = mkWs("l536-ctl", [], "AP-540");
    git(ws.repo, ["push", "-q", "origin", ws.branch]);
    writeFileSync(join(ws.repo, "more.txt"), "a plain new commit\n");
    git(ws.repo, ["add", "more.txt"]);
    git(ws.repo, ["commit", "-qm", "feat: a fast-forwardable commit (AP-540)"]);
    git(ws.repo, ["fetch", "-q", "origin"]);
    const tip = git(ws.repo, ["rev-parse", ws.branch]);

    const r = await push(ws.repo, { defaultBranch: "main", lockPath: join(ROOT, "lk-536-ctl") });
    ok(r.pushed && originTip(ws.origin, ws.branch) === tip, "AC6 control: an ordinary ahead-only branch still publishes");
    ok(r.forcePublish?.diverged === false, "AC6 control: it is reported as NOT diverged");
    ok(r.pushArgv !== null && !r.pushArgv.some((a) => a.startsWith("--force")),
      `AC6 control: NO lease is spent on a fast-forward (${JSON.stringify(r.pushArgv)})`);
    ok(r.forcePublish?.overwrittenSha === null, "AC6 control: nothing was overwritten, and the result says so");
  }
} finally {
  if (savedEnv.ws === undefined) delete process.env.DEVLOOP_WORKSPACE; else process.env.DEVLOOP_WORKSPACE = savedEnv.ws;
  if (savedEnv.db === undefined) delete process.env.DEVLOOP_HUB_DB; else process.env.DEVLOOP_HUB_DB = savedEnv.db;
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\n✅ push-verb: all assertions passed" : `\n❌ push-verb: ${fails} assertion(s) failed`);
process.exit(fails === 0 ? 0 : 1);
