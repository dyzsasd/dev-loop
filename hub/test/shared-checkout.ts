// The shared-checkout family — LOOP-312 (destruction), LOOP-320 (commission), LOOP-309 (handoff).
//
// One root: `<workspace>/<repo>` is a mutable global that no fire owns. §7 isolates dev-tier writes
// into per-ticket worktrees, but QA/PM/senior fires build, test and verify directly against it. Three
// failures fall out of that, in different directions, and no one guard catches another:
//
//   LOOP-312  another fire's `git checkout` DESTROYS uncommitted work    → snapshot it first
//   LOOP-320  a ship commit SWEEPS another fire's edits into itself      → refuse the staged overlap
//   LOOP-309  a dev hands off In Review having COMMITTED NOTHING at all  → require a local commit
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dirtyTrackedFiles, snapshotDirtyTree, listTreeSnapshots,
  writePreFireRecord, readPreFireRecord, preflightTreeSnapshot,
} from "../src/tree-snapshot.ts";
import { evaluateStaged, stagedFiles } from "../src/stage-guard.ts";
import { hasLocalWorkFor, handoffGateRejection } from "../src/handoff-gate.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-sharedco-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A real git repo with one commit — every assertion below needs actual git behaviour, not a mock. */
function makeRepo(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

try {
  // ── LOOP-312 AC1/AC2: tracked-dirty ⇒ a snapshot that actually applies; untracked-only ⇒ none ──
  {
    const root = makeRepo("snap");
    const dir = join(tmp, "snap-gens");
    ok(snapshotDirtyTree(root, dir) === null, "LOOP-312 AC4: a CLEAN tree writes nothing at all");

    // Untracked-only. `git checkout` does not discard untracked files, so they are not the population
    // at risk — and snapshotting them would make every build-artifact-littered tree look dirty.
    writeFileSync(join(root, "scratch.log"), "noise\n");
    ok(snapshotDirtyTree(root, dir) === null, "LOOP-312 AC2: an UNTRACKED-only dirty tree produces no snapshot");
    ok(dirtyTrackedFiles(root).length === 0, "LOOP-312 AC2: …and reads as not-dirty, because untracked is not the at-risk population");

    writeFileSync(join(root, "a.ts"), "export const a = 2; // fire 37's unlanded work\n");
    const snap = snapshotDirtyTree(root, dir);
    ok(snap !== null && snap.files.join(",") === "a.ts", `LOOP-312 AC1: a tracked modification is snapshotted, naming the file (${snap?.files.join(",")})`);

    // AC1's real assertion: the artifact is a patch that APPLIES. A file that merely exists proves
    // nothing — the 2026-08-04 loss is only recoverable if the copy can be replayed.
    let applyErr = "";
    try { execFileSync("git", ["-C", root, "apply", "--check", snap!.path], { stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e) { applyErr = String((e as { stderr?: Buffer })?.stderr ?? e); }
    // --check against the DIRTY tree fails (already applied); against HEAD's content it must succeed.
    git(root, "stash", "-q");
    let applyClean = "";
    try { execFileSync("git", ["-C", root, "apply", "--check", snap!.path], { stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e) { applyClean = String((e as { stderr?: Buffer })?.stderr ?? e); }
    ok(applyClean === "", `LOOP-312 AC1: \`git apply --check\` of the snapshot against its own HEAD succeeds (${applyClean.slice(0, 80)})`);
    ok(applyErr !== "", "LOOP-312 AC1 control: …and it does NOT apply to the already-dirty tree — so the check above is measuring the patch, not a no-op");
    git(root, "stash", "pop", "-q");

    // AC3 — content-hash keyed. A loop starting a fire every few minutes against an unchanged dirty
    // tree must write ONE file, not one per fire.
    const again = snapshotDirtyTree(root, dir);
    ok(again !== null && again.reused && again.path === snap!.path,
      "LOOP-312 AC3: a byte-identical re-run reuses the existing snapshot — no second file");
    ok(listTreeSnapshots(dir).length === 1, `LOOP-312 AC3: …exactly one generation on disk (got ${listTreeSnapshots(dir).length})`);

    writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
    const third = snapshotDirtyTree(root, dir);
    ok(third !== null && !third.reused && third.path !== snap!.path,
      "LOOP-312 AC3: …but changing a tracked file writes a NEW generation — the directory is a history");
    ok(listTreeSnapshots(dir).length === 2, "LOOP-312 AC3: two generations now");
    ok(listTreeSnapshots(dir)[0].path === third!.path, "LOOP-312: listing is newest-first");
  }

  // ── LOOP-312: the preflight records BOTH halves ───────────────────────────────────────────────
  {
    const root = makeRepo("pref");
    const state = join(tmp, "pref-state");
    writeFileSync(join(root, "a.ts"), "export const a = 99;\n");
    const logs: string[] = [];
    const snap = preflightTreeSnapshot(root, state, (m) => logs.push(m));
    ok(snap !== null && logs.some((l) => /uncommitted tracked file/.test(l)),
      "LOOP-312: the preflight snapshots and SAYS SO — a silent copy teaches nobody it exists");
    const rec = readPreFireRecord(join(state, "tree-snapshots"));
    ok(rec !== null && rec.files.join(",") === "a.ts" && !!rec.snapshot,
      `LOOP-312/320: …and records which paths were already dirty at fire start (${rec?.files.join(",")})`);

    // A clean tree still writes the record — with an EMPTY file list. That is not a detail: an absent
    // record disarms the LOOP-320 guard entirely (it cannot tell "nothing was dirty" from "nobody
    // looked"), so the clean case has to be recorded as a fact, not as an absence.
    const root2 = makeRepo("pref-clean");
    const state2 = join(tmp, "pref-clean-state");
    const logs2: string[] = [];
    ok(preflightTreeSnapshot(root2, state2, (m) => logs2.push(m)) === null && logs2.length === 0,
      "LOOP-312 AC4: a clean tree prints nothing");
    const rec2 = readPreFireRecord(join(state2, "tree-snapshots"));
    ok(rec2 !== null && rec2.files.length === 0,
      "LOOP-312/320: …and still writes an EMPTY record, so the ship guard knows nothing was dirty rather than assuming it");
  }

  // ── LOOP-320: the guard, including the same-file case a path heuristic passes ─────────────────
  {
    const root = makeRepo("stage");
    const state = join(tmp, "stage-state", "tree-snapshots");

    // Fire start: `hub/src/agentops.ts` (here: a.ts) is ALREADY dirty — another fire's work.
    writeFileSync(join(root, "a.ts"), "export const a = 294; // LOOP-294's unlanded edit\n");
    writePreFireRecord(state, { at: "t", repoRoot: root, files: dirtyTrackedFiles(root) });

    // Clean case: this fire touches only its own file and stages only that.
    writeFileSync(join(root, "b.ts"), "export const b = 105; // this fire's own work\n");
    git(root, "add", "--", "b.ts");
    const clean = evaluateStaged(stagedFiles(root), readPreFireRecord(state)!.files);
    ok(clean.ok && clean.staged.join(",") === "b.ts",
      "LOOP-320: a fire staging only its OWN file commits normally — zero false refusals");

    // The case that actually happened: `git add -A` sweeps the other fire's edit in too.
    git(root, "add", "-A");
    const swept = evaluateStaged(stagedFiles(root), readPreFireRecord(state)!.files);
    ok(!swept.ok && swept.preexisting.join(",") === "a.ts",
      `LOOP-320: a staged set carrying another fire's file is REFUSED and NAMES it (${swept.preexisting.join(",")})`);

    // AC2's discriminating case — THE SAME FILE edited by both. A path-name heuristic cannot tell
    // LOOP-294's agentops.ts edit from LOOP-105's own agentops.ts edit, and f1a6b70 contained both in
    // that one file. Deciding from the fire-START record refuses it; a heuristic passes it.
    git(root, "reset", "-q");
    writeFileSync(join(root, "a.ts"), "export const a = 294; // LOOP-294's unlanded edit\nexport const also = 105; // AND this fire's own edit\n");
    git(root, "add", "--", "a.ts");
    const sameFile = evaluateStaged(stagedFiles(root), readPreFireRecord(state)!.files);
    ok(!sameFile.ok && sameFile.preexisting.join(",") === "a.ts",
      "LOOP-320 AC2: the SAME-FILE case is refused — the fire cannot separate its edit from the one already there");

    // AC3's override is exercised at the CLI level further down, where the exit code is observable.

    // AC4 — a fire shipping from a DEDICATED WORKTREE cannot inherit the shared checkout's dirt.
    // This is the AC that asks for proof rather than assertion, so measure it: create a worktree,
    // dirty the SHARED tree, and show the worktree's own staged set is unaffected.
    git(root, "reset", "-q");
    git(root, "checkout", "-q", "--", ".");   // fully clean, so what follows measures only what is set here
    const wt = join(tmp, "wt-iso");
    git(root, "worktree", "add", "-q", "-b", "dev-loop/ISO-1", wt);
    writeFileSync(join(root, "a.ts"), "export const a = 999; // dirt in the SHARED checkout\n");
    writeFileSync(join(root, "b.ts"), "export const b = 999; // and more of it\n");
    // The worktree's OWN pre-fire record — which is the point. A worktree fire records its own tree,
    // and that tree is clean no matter how dirty the shared checkout is.
    const wtRecord = dirtyTrackedFiles(wt);
    ok(dirtyTrackedFiles(root).join(",") === "a.ts,b.ts" && wtRecord.length === 0,
      `LOOP-320 AC4: a dedicated worktree does NOT see the shared checkout's dirty tracked files (shared: ${dirtyTrackedFiles(root).join(",")}; worktree: ${wtRecord.join(",") || "clean"})`);

    writeFileSync(join(wt, "b.ts"), "export const b = 7; // the worktree fire's own work\n");
    git(wt, "add", "-A");
    ok(stagedFiles(wt).join(",") === "b.ts",
      "LOOP-320 AC4: …so its staged set carries only its own work, even though b.ts is dirty in the shared tree too");
    ok(evaluateStaged(stagedFiles(wt), wtRecord).ok,
      "LOOP-320 AC4: …and the guard passes it — worktree isolation removes a ship path from the exposure set entirely");
    // The exposure set is therefore exactly the NON-worktree ship paths: a fire committing from the
    // shared root with the same b.ts edit present is refused, where the worktree fire was not.
    git(root, "add", "--", "b.ts");
    ok(!evaluateStaged(stagedFiles(root), dirtyTrackedFiles(root)).ok,
      "LOOP-320 AC4: …while the SAME edit staged in the shared checkout is refused — that contrast is the exposure");
  }

  // ── LOOP-320: an ABSENT record does not refuse ────────────────────────────────────────────────
  // A guard that blocks every commit whenever its input is missing gets switched off, and then it
  // protects nothing. Report it instead.
  {
    const res = evaluateStaged(["x.ts"], null);
    ok(res.ok && /not armed/.test(res.reason ?? ""),
      "LOOP-320: with NO pre-fire record the guard reports that it is unarmed rather than refusing everything");
  }

  // ── LOOP-309: the handoff gate ────────────────────────────────────────────────────────────────
  {
    const root = makeRepo("handoff");
    const base = { fromState: "In Progress", toState: "In Review", actor: "junior-dev", repoRoot: root, landing: "pr" as const };

    // The measured shape: files modified in the working tree, no commit, no branch.
    writeFileSync(join(root, "a.ts"), "export const a = 31; // LOOP-31's correct but uncommitted diff\n");
    const refused = handoffGateRejection({ ...base, id: "LOOP-31" });
    ok(refused !== null && /LOOP-31/.test(refused) && /no commit or branch/.test(refused),
      `LOOP-309: an In Progress → In Review handoff with zero commits is REFUSED, naming what is missing`);
    ok(refused !== null && /^verify gate:/.test(refused),
      "LOOP-309: …in the same shape as the existing verify-gate refusals");

    // Fail-before control: this is what today's code does, and the reason the fire shipped nothing.
    ok(hasLocalWorkFor(root, "LOOP-31") === false,
      "LOOP-309 control: local git genuinely has no witness for this ticket — the refusal is not vacuous");

    // Commit it on a branch naming the ticket; the handoff goes through.
    git(root, "checkout", "-q", "-b", "dev-loop/LOOP-31");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fix(x): something real (LOOP-31)");
    ok(handoffGateRejection({ ...base, id: "LOOP-31" }) === null,
      "LOOP-309: once a commit references the ticket, the same handoff succeeds");

    // The branch-name witness alone is enough — a commit that did not name the ticket still ships
    // from a branch that does.
    git(root, "checkout", "-q", "-b", "dev-loop/LOOP-77");
    writeFileSync(join(root, "b.ts"), "export const b = 77;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "chore: unnamed subject");
    ok(handoffGateRejection({ ...base, id: "LOOP-77" }) === null,
      "LOOP-309: a branch NAMED for the ticket is also a sufficient witness");

    // LOOP-274's failure mode must not be reintroduced. The check reads LOCAL git only, so a handoff
    // whose commit exists succeeds with `gh` entirely absent from PATH and no network.
    // A PATH carrying `git` and NOTHING else. Stripping PATH to /usr/bin:/bin was not enough — the
    // GitHub runner ships `gh` at /usr/bin/gh, so the control below caught the probe proving nothing.
    // That is exactly what the control is for; keeping it honest costs one symlink.
    const binDir = join(tmp, "only-git-bin");
    mkdirSync(binDir, { recursive: true });
    const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    symlinkSync(gitPath, join(binDir, "git"));
    const noGh = { ...scrubFireEnv(), PATH: binDir } as NodeJS.ProcessEnv;
    const probe = execFileSync(process.execPath, ["-e", `
      import("${join(import.meta.dirname, "..", "src", "handoff-gate.ts")}").then(m =>
        console.log(m.handoffGateRejection({ id: "LOOP-31", fromState: "In Progress", toState: "In Review",
          actor: "junior-dev", repoRoot: ${JSON.stringify(root)}, landing: "pr" }) === null ? "PASS" : "REFUSED"));
    `], { encoding: "utf8", env: noGh, stdio: ["ignore", "pipe", "pipe"] });
    ok(/PASS/.test(probe), `LOOP-309: with 'gh' off PATH the local-only check still passes a committed handoff (${probe.trim()})`);
    // /bin/sh absolutely: `sh` is not on the stripped PATH either, and resolving it through PATH
    // would make the control fail for a reason that has nothing to do with `gh`.
    ok(execFileSync("/bin/sh", ["-c", "command -v gh || true"], { encoding: "utf8", env: noGh }).trim() === "",
      "LOOP-309 control: …and `gh` really was unreachable in that probe's environment");

    // Scope: a `direct` repo gains no new refusal path, and the operator is never gated.
    writeFileSync(join(root, "c.ts"), "export const c = 1;\n");
    git(root, "add", "-A"); // dirty but uncommitted, for a ticket with no witness anywhere
    ok(handoffGateRejection({ ...base, id: "LOOP-999", landing: "direct" }) === null,
      "LOOP-309: a repo whose landing is 'direct' is unaffected — no new refusal path");
    ok(handoffGateRejection({ ...base, id: "LOOP-999", actor: "operator" }) === null,
      "LOOP-309: the operator is never gated");
    ok(handoffGateRejection({ ...base, id: "LOOP-999", repoRoot: undefined }) === null,
      "LOOP-309: with no resolvable repo the gate is silent — library callers pass a bare dbPath (the LOOP-284 lesson)");
    ok(handoffGateRejection({ ...base, id: "LOOP-999", fromState: "Todo" }) === null,
      "LOOP-309: only the In Progress → In Review edge is gated");
    ok(handoffGateRejection({ ...base, id: "LOOP-999" }) !== null,
      "LOOP-309 control: …and the same ticket on the gated edge with landing 'pr' IS refused");
  }

  // ── LOOP-309 through the REAL write path ─────────────────────────────────────────────────────
  // The predicate passing proves nothing about whether the gate is WIRED. This drives
  // `save_issue` — the same op a dev fire calls — against a workspace whose repo is `landing: "pr"`,
  // in a subprocess so DEVLOOP_WORKSPACE is set for the whole resolution.
  {
    const wsRoot = join(tmp, "gate-ws");
    const repoDir = join(wsRoot, "repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
    git(repoDir, "config", "user.email", "t@t"); git(repoDir, "config", "user.name", "t");
    writeFileSync(join(repoDir, "f.ts"), "export const f = 1;\n");
    git(repoDir, "add", "-A"); git(repoDir, "commit", "-qm", "init");
    writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, team: { key: "gate", backend: "service" },
      repos: { repo: { path: "repo", landing: "pr", role: "primary" } },
      projects: { gp: { repos: [{ ref: "repo", role: "primary" }] } },
    }));

    const drive = (id: string): { code: number; out: string } => {
      const script = `
        import { openDb } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "db.ts"))};
        import { ensureSeed, findProject } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "seed.ts"))};
        import { agentOp } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "agentops.ts"))};
        const db = openDb(${JSON.stringify(join(wsRoot, "hub.db"))});
        ensureSeed(db, "gp", "Gate", "LOOP");
        const pid = findProject(db, "gp");
        db.prepare("INSERT OR REPLACE INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,assignee,created_by,created_at,updated_at) VALUES(?,?,'t','','Bug','In Progress',2,'[\\"dev-loop\\"]','[]','junior-dev','pm','t','t')").run(${JSON.stringify(id)}, pid);
        const r = agentOp("save_issue", db, pid, "gp", "junior-dev", { id: ${JSON.stringify(id)}, state: "In Review" });
        console.log(JSON.stringify({ status: r.status, body: r.body }));
      `;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script],
        { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: wsRoot, DEVLOOP_HUB_DB: join(wsRoot, "hub.db") } });
      return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
    };

    // The measured shape: work sitting uncommitted in the tree, handed off as if it shipped.
    writeFileSync(join(repoDir, "f.ts"), "export const f = 31; // uncommitted\n");
    const refused = drive("LOOP-31");
    ok(/In Progress → In Review blocked/.test(refused.out) && /LOOP-31/.test(refused.out),
      `LOOP-309: the gate fires through the REAL save_issue path, not just the predicate (${refused.out.slice(0, 120)})`);
    ok(/"status":4\d\d/.test(refused.out), `LOOP-309: …with a 4xx, in the shape of the existing verify-gate refusals (${refused.out.slice(0, 60)})`);

    // Commit it, and the same op goes through — the gate refuses the omission, not the ticket.
    git(repoDir, "checkout", "-q", "-b", "dev-loop/LOOP-32");
    writeFileSync(join(repoDir, "f.ts"), "export const f = 32;\n");
    git(repoDir, "add", "-A"); git(repoDir, "commit", "-qm", "feat: real work (LOOP-32)");
    const passed = drive("LOOP-32");
    ok(/"status":2\d\d/.test(passed.out) && !/blocked/.test(passed.out),
      `LOOP-309: …and a handoff WITH a commit passes through the same path (${passed.out.slice(0, 120)})`);
  }

  // ── LOOP-312: W33 in doctor, on the same four fixtures ───────────────────────────────────────
  // A DIFFERENT population from W26. W26 asks "would `git rebase` refuse?" (unmerged, or
  // staged-but-uncommitted). W33 asks "is there tracked work here another fire's `git checkout`
  // would destroy?" — which is why it is a separate code and not a widened W26.
  {
    const wsRoot = join(tmp, "w33-ws");
    const repoDir = join(wsRoot, "repo");
    mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
    git(repoDir, "config", "user.email", "t@t"); git(repoDir, "config", "user.name", "t");
    writeFileSync(join(repoDir, "f.ts"), "export const f = 1;\n");
    git(repoDir, "add", "-A"); git(repoDir, "commit", "-qm", "init");
    writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, team: { key: "w33-test", backend: "service" },
      repos: { repo: { path: "repo" } }, projects: {},
    }));

    const capture = async (): Promise<string> => {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (m?: unknown) => { lines.push(String(m)); };
      try { await doctorWorkspace(loadWorkspace(wsRoot)); } finally { console.log = orig; }
      return lines.join("\n");
    };

    ok(!(await capture()).includes("[W33]"), "LOOP-312: a CLEAN checkout produces no W33");

    writeFileSync(join(repoDir, "untracked.log"), "noise\n");
    ok(!(await capture()).includes("[W33]"), "LOOP-312: an UNTRACKED-only tree produces no W33 — untracked files are not the at-risk population");

    writeFileSync(join(repoDir, "f.ts"), "export const f = 2; // unlanded\n");
    const dirty = await capture();
    ok(dirty.includes("[W33]") && /1 uncommitted tracked modification/.test(dirty),
      "LOOP-312: a tracked modification raises W33, naming the count");
    ok(/f\.ts/.test(dirty), "LOOP-312: …and naming the file");
    ok(/NO snapshot exists/.test(dirty),
      "LOOP-312: …and says NO snapshot exists — the half that matters, because it means nothing has copied this work");
    ok(!/DOCTOR_OK.*❌/.test(dirty) && dirty.includes("[W33]"),
      "LOOP-312: W33 is a WARNING — a dirty shared tree is the normal mid-flight state, so it must not make ❌ the resting state");

    // With a snapshot on disk the warning names WHERE it is, so "is it recoverable?" is answered.
    snapshotDirtyTree(repoDir, join(wsRoot, ".dev-loop", "tree-snapshots"));
    const withSnap = await capture();
    ok(withSnap.includes("[W33]") && /newest snapshot:/.test(withSnap) && !/NO snapshot exists/.test(withSnap),
      "LOOP-312: once a snapshot exists, W33 names it instead");
  }

  // ── LOOP-320 CLI: exit codes and the recorded override ────────────────────────────────────────
  {
    const root = makeRepo("cli");
    const state = join(tmp, "cli-ws", ".dev-loop", "tree-snapshots");
    writeFileSync(join(root, "a.ts"), "export const a = 2; // another fire's\n");
    writePreFireRecord(state, { at: "t", repoRoot: root, files: dirtyTrackedFiles(root) });
    git(root, "add", "-A");

    const run = (args: string[]): { code: number; out: string; err: string } => {
      const r = spawnSync(process.execPath,
        [join(import.meta.dirname, "..", "src", "stage-guard.ts"), "--repo", root, ...args],
        { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: join(tmp, "cli-ws") } });
      return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
    };
    // The workspace resolves to a directory with no dev-loop.json, so the CLI falls back to
    // <repo>/.dev-loop — point the record there too.
    writePreFireRecord(join(root, ".dev-loop", "tree-snapshots"), { at: "t", repoRoot: root, files: ["a.ts"] });

    const refused = run([]);
    ok(refused.code === 3 && /REFUSED/.test(refused.err) && /a\.ts/.test(refused.err),
      `LOOP-320: the CLI exits 3 and names the path (code ${refused.code})`);
    ok(/git restore --staged/.test(refused.err),
      "LOOP-320: …and the refusal says exactly how to fix it");

    const overridden = run(["--override", "landing the LOOP-308 salvage patch deliberately"]);
    ok(overridden.code === 0 && /OVERRIDDEN/.test(overridden.err) && /salvage patch/.test(overridden.err),
      `LOOP-320 AC3: an explicit override commits, and the REASON is recorded in the trail (code ${overridden.code})`);
    ok(run(["--override", "   "]).code === 2,
      "LOOP-320 AC3: an empty override reason is refused — it must be a recorded reason, not a silent bypass");
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nSHARED_CHECKOUT_OK");
process.exit(fails ? 1 : 0);
