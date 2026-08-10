// team-repair.ts — regression test for the terminal-state worktree reaper (LOOP-37).
// Fixture: two worktrees (Canceled + In Progress) under two different roots; reaper removes exactly
// the first. Must fail against origin/main prior to this fix (pre-LOOP-37 code has no reaper).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { worktreeReap } from "../src/worktree.ts";
import { resolveWorkspace } from "../src/workspace.ts";
import { confirmationToken, isolationVerdict, TOKEN_PREFIX } from "../src/destructive-guard.ts";
import type { Workspace } from "../src/team-config.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "dl-team-repair-")));

try {
  // ── 1. Build a minimal git repo (bare origin + clone inside the workspace) ──
  const wsRoot = join(ROOT, "workspace");
  mkdirSync(wsRoot, { recursive: true });
  const origin = join(ROOT, "origin.git");
  const repoDir = join(wsRoot, "clone");
  mkdirSync(origin);

  const git = (dir: string, args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git(ROOT, ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, repoDir], { stdio: ["ignore", "pipe", "pipe"] });
  git(repoDir, ["commit", "--allow-empty", "-qm", "baseline"]);
  git(repoDir, ["push", "-qu", "origin", "main"]);

  // ── 2. Create two worktrees under different roots ───────────────────────────
  // Root A (the "computed" root that wsWorktree() would produce)
  const wtRootA = join(ROOT, ".dev-loop", "wt");
  mkdirSync(wtRootA, { recursive: true });
  const wtCanceled = join(wtRootA, "CANCEL-1", "repo");

  // Root B (a legacy "wrong" root — simulates the pre-LOOP-37 hand-built paths)
  const wtRootB = join(ROOT, "worktrees");
  mkdirSync(wtRootB, { recursive: true });
  const wtInProgress = join(wtRootB, "INPROG-1");

  git(repoDir, ["worktree", "add", "-b", "dev-loop/CANCEL-1", wtCanceled, "main"]);
  git(repoDir, ["worktree", "add", "-b", "dev-loop/INPROG-1", wtInProgress, "main"]);

  // Confirm both worktrees are on disk before the reaper runs.
  ok(existsSync(wtCanceled), "pre-condition: Canceled worktree exists before reap");
  ok(existsSync(wtInProgress), "pre-condition: In Progress worktree exists before reap");

  // ── 3. Build a minimal workspace + hub.db with matching ticket rows ─────────
  mkdirSync(join(wsRoot, ".dev-loop", "locks"), { recursive: true });
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test-ws",
    team: { key: "test", backend: "service", mode: "live", autonomy: "full" },
    repos: { repo: { path: "clone", remote: origin } },
    projects: { test: { repos: [{ ref: "repo" }] } },
  }));

  // hub.db with ticket rows: CANCEL-1 = Canceled, INPROG-1 = In Progress
  const dbPath = join(wsRoot, ".dev-loop", "hub.db");
  const db = openDb(dbPath);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','test','test','t')").run();
  const tk = (id: string, state: string) =>
    db.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')").run(id, "p", `t-${id}`, state);
  tk("CANCEL-1", "Canceled");
  tk("INPROG-1", "In Progress");
  db.close();

  // ── 4. Run the reaper in dry-run mode first (no mutations) ──────────────────
  process.env.DEVLOOP_WORKSPACE = wsRoot;
  const ws = resolveWorkspace(wsRoot);
  const dryResult = await worktreeReap(ws, "repo", { dryRun: true });
  ok(dryResult.reaped.length === 1, `dry-run finds exactly 1 terminal worktree (got ${dryResult.reaped.length})`);
  ok(dryResult.reaped[0]?.ticketId === "CANCEL-1", `dry-run identifies CANCEL-1 as the reap target (got ${dryResult.reaped[0]?.ticketId})`);
  ok(existsSync(wtCanceled), "dry-run does NOT remove the Canceled worktree");
  ok(existsSync(wtInProgress), "dry-run does NOT remove the In Progress worktree");

  // Confirm In Progress is in the kept list
  ok(dryResult.kept.some((e) => e.ticketId === "INPROG-1"), "dry-run keeps INPROG-1 in kept list");

  // ── 5. Real reap — removes the Canceled worktree, leaves In Progress alone ──
  const realResult = await worktreeReap(ws, "repo", { dryRun: false });
  ok(realResult.reaped.length === 1, `real reap removes exactly 1 worktree (got ${realResult.reaped.length})`);
  ok(!existsSync(wtCanceled), "Canceled worktree was removed from disk");
  ok(existsSync(wtInProgress), "In Progress worktree was NOT removed");

  // Branch for Canceled must be deleted; branch for In Progress must survive.
  const branches = git(repoDir, ["branch", "--list"]);
  ok(!branches.includes("dev-loop/CANCEL-1"), "branch dev-loop/CANCEL-1 was deleted (Canceled ticket)");
  ok(branches.includes("dev-loop/INPROG-1"), "branch dev-loop/INPROG-1 was kept (non-terminal ticket)");

  // ── 6. Verify via `git worktree list` — legacy root gone, computed root gone ─
  const listAfter = git(repoDir, ["worktree", "list"]);
  ok(!listAfter.includes("CANCEL-1"), "git worktree list no longer shows CANCEL-1");
  ok(listAfter.includes("INPROG-1"), "git worktree list still shows INPROG-1");

  // ── 7. Idempotency — second reap is a no-op ─────────────────────────────────
  const idempotent = await worktreeReap(ws, "repo", { dryRun: false });
  ok(idempotent.reaped.length === 0, "second reap is a no-op (already reaped)");

  // ── 8. CLI: dev-loop worktree path prints the canonical path ────────────────
  const pathResult = spawnSync(process.execPath, [join(hubRoot, "src", "worktree.ts"), "path", "TEST-42", "--repo", "repo"],
    { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: wsRoot } });
  const expectedPath = join(wsRoot, ".dev-loop", "wt", "TEST-42", "repo");
  ok(pathResult.status === 0 && pathResult.stdout.trim() === expectedPath,
    `worktree path prints the canonical path (expected ${expectedPath}, got ${pathResult.stdout.trim()})`);

  // ── 9. CLI: dev-loop worktree reap --dry-run ────────────────────────────────
  // Re-add the canceled worktree to test the CLI dry-run path.
  mkdirSync(join(wtRootA, "CANCEL-2"), { recursive: true });
  const wtCanceled2 = join(wtRootA, "CANCEL-2", "repo");
  git(repoDir, ["worktree", "add", "-b", "dev-loop/CANCEL-2", wtCanceled2, "main"]);
  const db2 = openDb(dbPath);
  db2.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')").run("CANCEL-2", "p", "t-CANCEL-2", "Canceled");
  db2.close();

  const cliDry = spawnSync(process.execPath, [join(hubRoot, "src", "worktree.ts"), "reap", "--repo", "repo", "--dry-run"],
    { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: wsRoot } });
  ok(cliDry.status === 0 && cliDry.stdout.includes("CANCEL-2"), "worktree reap --dry-run identifies CANCEL-2");
  ok(existsSync(wtCanceled2), "worktree reap --dry-run does not remove CANCEL-2");

  // ── 10. LOOP-106 — recoverability gate (AC2) + dirty-worktree safety (AC3) ───
  //     Each case is one the pre-LOOP-106 reaper got wrong (force-remove / `-D` on ticket state
  //     alone), so each assertion here fails against 49644f8.
  const db3 = openDb(dbPath);
  const mkCanceled = (id: string) => db3.prepare(
    "INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'Canceled',0,'[]','[]','pm','t','t')",
  ).run(id, "p", `t-${id}`);

  // (a) UNRECOVERABLE Canceled branch — a local commit, never pushed, not merged → branch must be KEPT.
  const wtUnrec = join(wtRootA, "UNREC-1", "repo");
  mkdirSync(dirname(wtUnrec), { recursive: true });
  git(repoDir, ["worktree", "add", "-b", "dev-loop/UNREC-1", wtUnrec, "main"]);
  writeFileSync(join(wtUnrec, "work.txt"), "unpushed, unmerged work");
  git(wtUnrec, ["add", "."]);
  git(wtUnrec, ["commit", "-qm", "unpushed unmerged work"]);
  mkCanceled("UNREC-1");

  // (b) RECOVERABLE Canceled branch — pushed to origin → the branch may be deleted.
  const wtPushed = join(wtRootA, "PUSHED-1", "repo");
  mkdirSync(dirname(wtPushed), { recursive: true });
  git(repoDir, ["worktree", "add", "-b", "dev-loop/PUSHED-1", wtPushed, "main"]);
  writeFileSync(join(wtPushed, "work.txt"), "pushed work");
  git(wtPushed, ["add", "."]);
  git(wtPushed, ["commit", "-qm", "pushed work"]);
  git(repoDir, ["push", "-q", "origin", "dev-loop/PUSHED-1"]);
  mkCanceled("PUSHED-1");

  // (c) DIRTY Canceled worktree — an uncommitted change → the worktree (and its branch) must be KEPT.
  const wtDirty = join(wtRootA, "DIRTY-1", "repo");
  mkdirSync(dirname(wtDirty), { recursive: true });
  git(repoDir, ["worktree", "add", "-b", "dev-loop/DIRTY-1", wtDirty, "main"]);
  writeFileSync(join(wtDirty, "uncommitted.txt"), "work in progress, never committed");
  mkCanceled("DIRTY-1");
  db3.close();

  const capture: string[] = [];
  const reapRes = await worktreeReap(ws, "repo", { dryRun: false, print: (m) => capture.push(m) });
  const branchesAfter = git(repoDir, ["branch", "--list"]);

  ok(branchesAfter.includes("dev-loop/UNREC-1"), "AC2: an unrecoverable Canceled branch (no upstream, unmerged) is KEPT");
  ok(!existsSync(wtUnrec), "AC2: the UNREC-1 worktree (clean) was still removed");
  ok(capture.some((m) => m.includes("UNREC-1") && /UNRECOVERABLE/.test(m)), "AC2: prints an UNRECOVERABLE reason for the kept branch");
  ok(!branchesAfter.includes("dev-loop/PUSHED-1"), "AC2: a recoverable (pushed) Canceled branch IS deleted");
  ok(!existsSync(wtPushed), "AC2: the PUSHED-1 worktree was removed");
  ok(existsSync(wtDirty), "AC3: a dirty terminal worktree is KEPT, never force-removed");
  ok(branchesAfter.includes("dev-loop/DIRTY-1"), "AC3: the dirty worktree's branch is KEPT too");
  ok(capture.some((m) => m.includes("DIRTY-1") && /KEPT worktree/.test(m)), "AC3: prints a loud KEPT-worktree line");
  ok(!reapRes.reaped.some((e) => e.ticketId === "DIRTY-1"), "AC3: the kept dirty worktree is not counted as reaped");

  // ── 11. LOOP-106 — the automatic path (team repair, no --reap) deletes NOTHING (AC1) ──
  //     `dev-loop up --bundle` runs `team repair` unattended, before doctor. The default must not delete;
  //     `--reap` is the explicit opt-in. Fails against 49644f8, where `team repair` reaped by default.
  const wtOptin = join(wtRootA, "OPTIN-1", "repo");
  mkdirSync(dirname(wtOptin), { recursive: true });
  git(repoDir, ["worktree", "add", "-b", "dev-loop/OPTIN-1", wtOptin, "main"]);
  git(repoDir, ["push", "-q", "origin", "dev-loop/OPTIN-1"]); // recoverable, so --reap WOULD remove it
  const db4 = openDb(dbPath);
  db4.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('OPTIN-1','p','t-OPTIN-1','Canceled',0,'[]','[]','pm','t','t')").run();
  db4.close();

  // Hermetic subprocess env: read the fixture db explicitly, contain the index write to a temp
  // DEVLOOP_HOME, and drop inherited project/actor identity so a live fire can't leak in.
  const trEnv: NodeJS.ProcessEnv = { ...scrubFireEnv(), DEVLOOP_WORKSPACE: wsRoot, DEVLOOP_HUB_DB: dbPath, DEVLOOP_HOME: join(ROOT, ".home") };
  delete trEnv.DEVLOOP_DATA_DIR; delete trEnv.DEVLOOP_PROJECT; delete trEnv.DEVLOOP_ACTOR;
  const trPath = join(hubRoot, "src", "team-repair.ts");

  const repairDefault = spawnSync(process.execPath, [trPath], { encoding: "utf8", env: trEnv });
  ok(repairDefault.status === 0, "team repair (no --reap) exits 0");
  ok(existsSync(wtOptin), "AC1: team repair (no --reap) does NOT remove the terminal worktree");
  ok(git(repoDir, ["branch", "--list"]).includes("dev-loop/OPTIN-1"), "AC1: team repair (no --reap) does NOT delete the branch");
  ok(/would be reaped|would remove/.test(repairDefault.stdout), "AC1: the default pass REPORTS what --reap would remove");

  const repairReap = spawnSync(process.execPath, [trPath, "--reap"], { encoding: "utf8", env: trEnv });
  ok(repairReap.status === 0, "team repair --reap exits 0");
  ok(!existsSync(wtOptin), "AC1: team repair --reap removes the (recoverable) terminal worktree");
  ok(!git(repoDir, ["branch", "--list"]).includes("dev-loop/OPTIN-1"), "AC1: team repair --reap deletes the recoverable branch");

  // ── 12. LOOP-181 — the CLI-rename permission top-up: `team repair` adds the missing Bash(kaizen *) rule
  //     to a workspace's .claude/settings.json (idempotent, non-destructive, --dry-run aware). A workspace
  //     provisioned before the `kaizen` bin carries only Bash(dev-loop *); the top-up makes it Phase-B-ready. ──
  const stFile = join(wsRoot, ".claude", "settings.json");
  const writeSettings = (obj: unknown) => { mkdirSync(dirname(stFile), { recursive: true }); writeFileSync(stFile, JSON.stringify(obj, null, 2) + "\n"); };
  const repair = (extra: string[] = []) => spawnSync(process.execPath, [trPath, ...extra], { encoding: "utf8", env: trEnv });
  const allowOf = () => (JSON.parse(readFileSync(stFile, "utf8")) as { permissions: { allow: string[] } }).permissions.allow;

  // Pre-rename fixture: only the old rule, plus an UNRELATED entry that must survive untouched.
  writeSettings({ permissions: { allow: ["Bash(other *)", "Bash(dev-loop *)"] } });

  // (a) --dry-run REPORTS the top-up but writes nothing.
  const drySt = repair(["--dry-run"]);
  ok(drySt.status === 0 && /would gain/.test(drySt.stdout) && /Bash\(kaizen \*\)/.test(drySt.stdout),
    "AC: team repair --dry-run reports the Bash(kaizen *) top-up");
  ok(JSON.stringify(allowOf()) === JSON.stringify(["Bash(other *)", "Bash(dev-loop *)"]),
    "AC: team repair --dry-run does NOT write (settings.json unchanged)");

  // (b) the real run APPENDS Bash(kaizen *), preserving the unrelated entry + order.
  const applied = repair();
  ok(applied.status === 0 && /permissions\.allow \+= "Bash\(kaizen \*\)"/.test(applied.stdout),
    "AC: team repair appends the missing Bash(kaizen *) rule");
  ok(JSON.stringify(allowOf()) === JSON.stringify(["Bash(other *)", "Bash(dev-loop *)", "Bash(kaizen *)"]),
    "AC: the top-up preserves Bash(other *) + Bash(dev-loop *) and appends kaizen last (non-destructive)");

  // (c) idempotent re-run: no change, and it says so (byte-stable file).
  const beforeIdem = readFileSync(stFile, "utf8");
  const againSt = repair();
  ok(againSt.status === 0 && /already allows/.test(againSt.stdout), "AC: team repair re-run reports 'already allows' (both rules present)");
  ok(readFileSync(stFile, "utf8") === beforeIdem, "AC: team repair re-run leaves settings.json byte-stable (idempotent)");

  // (d) a malformed settings.json is NEVER clobbered — left untouched with a note.
  writeFileSync(stFile, "{ not valid json");
  const badSt = repair();
  ok(badSt.status === 0 && /left untouched/.test(badSt.stdout), "AC: team repair prints a 'left untouched' note for a malformed settings.json");
  ok(readFileSync(stFile, "utf8") === "{ not valid json", "AC: team repair does NOT rewrite a malformed settings.json");

  // ── LOOP-305 (LOOP-302 ①): the project-reap arm consults the shared isolation gate ──────────────
  // Honest framing, because it decides what this block can prove: the reap's candidate filter is already
  // `scratch === true`, so wiring the gate in changes NO behaviour today and a purely behavioural test here
  // CANNOT fail against the pre-fix tree. What the gate buys is that "a reap never destroys a real project"
  // stops resting on a single `.filter()` that a later edit could widen. So this block pins the CONTRACT the
  // reap now depends on — and it does fail pre-fix, because destructive-guard.ts does not exist there.
  const gateWs = (projects: Record<string, { scratch?: boolean }>) => ({ file: { projects } } as unknown as Workspace);
  // The reap offers no token (there is none to offer on `team repair --reap`), so this is the exact call it makes.
  // LOOP-368: pinned to a no-fire env, because the verdict now answers the fire question too and these
  // three are the TOKEN half's contract. The fire half is asserted in destructive-fire-gate.ts.
  const noFire = scrubFireEnv();
  ok(isolationVerdict(gateWs({ "to-reap": { scratch: true } }), "to-reap", [], noFire).refusal === null,
    "LOOP-305: the reap's own call shape (no token) ALLOWS a scratch candidate — the gate does not break the reaper");
  ok(isolationVerdict(gateWs({ "real-proj": {} }), "real-proj", [], noFire).refusal !== null,
    "LOOP-305 AC6: the same call REFUSES a non-scratch project — so a widened candidate filter alone can no longer reap one");
  ok(isolationVerdict(gateWs({ other: { scratch: true } }), "vanished", [], noFire).refusal !== null,
    "LOOP-305 AC6: a candidate key absent from config refuses too (fail closed — config is the only authority)");
  ok(confirmationToken("real-proj") === `${TOKEN_PREFIX}real-proj` && TOKEN_PREFIX === "--i-understand-this-deletes-",
    "LOOP-305: the token spelling has ONE definition, shared by every destructive verb that recognises it");

  console.log(fails === 0 ? "\nTEAM_REPAIR_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  delete process.env.DEVLOOP_WORKSPACE;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
};
