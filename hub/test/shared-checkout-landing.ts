// shared-checkout-landing.ts — a landed-but-unpushed commit is named before the push that saves it.
//
// Measured on the jbu repo's `main` reflog, 2026-08-29:
//
//   3e51a06 @15:50:00  merge dev-loop/JBU-11 FF       ← lane A landed, unpushed
//   2011a1c @15:51:52  reset: moving to origin/main   ← lane B aligned the shared checkout, destructively
//   9db4539 @15:51:52  merge dev-loop/JBU-11 FF       ← rebuilt, different sha
//
// A's landing survived only because the same fire re-merged the same branch seconds later. Any other
// pairing of lanes loses the commit outright, and this happened once within an hour on one workspace.
//
// The landing sequence (§7 / worktree-landing) is `pull --ff-only && merge --ff-only && push`, all
// inside one `with-repo-lock`. Nothing in it resets. What it did NOT define is the arm where
// `pull --ff-only` REFUSES — which is exactly the diverged state a second lane's unpushed landing
// creates — and an agent facing an undefined arm improvised the one remedy that discards work.
//
// No hub/src code performs this landing; it is composed by the agent from playbook text. So the
// enforceable surface is the guard the sequence already runs immediately before the push:
// push-guard now names the commits that exist only in this checkout, which is precisely the set a
// `reset --hard origin/<defaultBranch>` would take, and carries the rule and the recovery.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pushGuard } from "../src/push-guard.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "dl-shared-landing-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// An explicit db path that does not exist: the board axis degrades to "unverifiable refs", which is
// what this suite wants — it is about git state, not ticket states, and passing it keeps the arms
// below measuring the new class rather than whatever board happens to resolve.
const NO_DB = join(ROOT, "absent-hub.db");

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const guardCli = (repo: string, branch: string) => {
  const r = spawnSync(process.execPath,
    [join(hubRoot, "src", "push-guard.ts"), "--repo", repo, "--branch", branch, "--default-branch", "main", "--strict"],
    { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HOME: join(ROOT, "home") } as NodeJS.ProcessEnv });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

try {
  const origin = join(ROOT, "origin.git");
  const shared = join(ROOT, "shared");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, shared]);
  git(shared, ["commit", "--allow-empty", "-qm", "chore: baseline"]);
  git(shared, ["push", "-qu", "origin", "main"]);

  // ── Lane A lands and does not push (the state the incident began in) ────────────────────────────
  git(shared, ["checkout", "-qb", "dev-loop/LANE-A"]);
  git(shared, ["commit", "--allow-empty", "-qm", "feat(a): lane A's work (LANE-A)"]);
  git(shared, ["checkout", "-q", "main"]);
  git(shared, ["merge", "--ff-only", "-q", "dev-loop/LANE-A"]);
  const aSha = git(shared, ["rev-parse", "--short=7", "HEAD"]);

  // ── Lane B is at the point the sequence runs push-guard: about to push `main` ───────────────────
  {
    const r = pushGuard(shared, "main", NO_DB, "main");
    ok((r.unpushedOnDefault ?? []).some((c) => c.sha === aSha),
      `lane A's landed-but-unpushed commit is named before the push (${JSON.stringify(r.unpushedOnDefault ?? [])})`);
    const cli = guardCli(shared, "main");
    ok(cli.out.includes(aSha), `the CLI names the sha (${cli.out.split("\n").find((l) => l.includes(aSha))?.slice(0, 120) ?? "absent"})`);
    ok(/NEVER `git reset --hard origin\/main`/.test(cli.out),
      "…and states the rule that was missing: never align a shared checkout destructively");
    ok(/pull --ff-only` refuses/.test(cli.out),
      "…and defines the arm the sequence left undefined — a refused pull means push first, then retry");
    ok(cli.code === 0,
      `it is informational, not a refusal — this is the normal state right before the push (exit ${cli.code})`);
  }

  // ── Once published, the class is silent: it reports a real state, not a permanent nag ───────────
  {
    git(shared, ["push", "-q", "origin", "main"]);
    const r = pushGuard(shared, "main", NO_DB, "main");
    ok(!r.unpushedOnDefault, `after the push nothing is unpublished, and the key is absent (${JSON.stringify(r.unpushedOnDefault)})`);
    ok(!/exist ONLY in this checkout/.test(guardCli(shared, "main").out), "…and the CLI says nothing about it");
  }

  // ── A ticket branch is not the shared-checkout landing, so the class stays out of its way ───────
  {
    git(shared, ["checkout", "-qb", "dev-loop/LANE-B"]);
    git(shared, ["commit", "--allow-empty", "-qm", "feat(b): lane B's work (LANE-B)"]);
    const r = pushGuard(shared, "dev-loop/LANE-B", NO_DB, "main");
    ok(!r.unpushedOnDefault, `on a ticket branch the class is absent — it is about <defaultBranch> (${JSON.stringify(r.unpushedOnDefault)})`);
  }

  // ── A repo with no remote has nothing to be unpublished against ─────────────────────────────────
  {
    const local = join(ROOT, "local-only");
    mkdirSync(local, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", local]);
    git(local, ["commit", "--allow-empty", "-qm", "chore: baseline"]);
    const r = pushGuard(local, "main", NO_DB, "main");
    ok(!r.unpushedOnDefault, "a repo with no remote reports nothing here — there is no origin to be ahead of");
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nSHARED_CHECKOUT_LANDING_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
