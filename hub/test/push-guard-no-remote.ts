// push-guard-no-remote.ts — a repository with no remote is measured against its LOCAL default branch.
//
// Measured on a live `landing:"direct"` workspace whose repo has no remote at all (`git remote -v`
// is empty): every landing failed the gate. `origin/main` cannot resolve there, so
//   • passenger detection did not run at all, and the guard said so — under --strict that alone is
//     exit 1, so no ticket could ever land; and
//   • the range degraded to the branch's ENTIRE history, which on a direct-landing repo is main's
//     history too. The three commit classes then re-flagged commits that landed weeks ago: two
//     ride-alongs naming a ticket that was Canceled long after its work merged.
// Two tickets were pushed back to Todo and marked blocked by a gate reporting on already-landed work.
//
// Same root cause as the worktree-reap fix (6c61f0e): a whole shape — no remote, landing "direct" —
// that these functions never considered, each of them comparing against an origin that does not
// exist. The base ref is now derived once and read everywhere, exactly as reapBaseRef is.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { pushGuard } from "../src/push-guard.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
const ROOT = realpathSync(tmpRoot("dl-pg-noremote-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The CLI, so the --strict exit code (what refused the two landings) is asserted end to end. */
const guardCli = (repo: string, branch: string, db: string) => {
  const r = spawnSync(process.execPath,
    [join(hubRoot, "src", "push-guard.ts"), "--repo", repo, "--branch", branch, "--default-branch", "main", "--strict"],
    { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: db } as NodeJS.ProcessEnv });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

try {
  // ── The hub board both fixtures read: one Canceled ticket, one live one ──────────────────────────
  const db = join(ROOT, "hub.db");
  const conn = openDb(db);
  conn.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','jbu','n','t')").run();
  const tk = (id: string, state: string) =>
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')").run(id, "p", "t-" + id, state);
  tk("JBU-28", "Canceled");  // the old work whose ticket was canceled AFTER it landed on main
  tk("JBU-7", "In Progress");
  conn.close();

  // ── Fixture: a repo with NO remote, the live shape ───────────────────────────────────────────────
  const repo = join(ROOT, "local-only");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, ["commit", "--allow-empty", "-qm", "chore: baseline"]);
  // Already landed on main, and its ticket was canceled later. A gate that re-scans main's history
  // reports this as a ride-along on every future landing.
  git(repo, ["commit", "--allow-empty", "-qm", "fix(old): work that landed weeks ago (JBU-28)"]);
  git(repo, ["checkout", "-qb", "dev-loop/JBU-7"]);
  git(repo, ["commit", "--allow-empty", "-qm", "feat(x): the ticket's own single commit (JBU-7)"]);
  ok(git(repo, ["remote"]) === "", "fixture: the repo really has no remote");

  {
    const r = pushGuard(repo, "dev-loop/JBU-7", db, "main");
    ok(r.findings.length === 0,
      `no remote: main's already-landed history is not re-scanned — no ride-along findings (got ${JSON.stringify(r.findings.map((f) => `${f.sha}:${f.ticket}`))})`);
    ok(r.passengers.length === 0,
      `no remote: …and no passengers (got ${JSON.stringify(r.passengers.map((p) => `${p.sha}:${p.ticketId}`))})`);
    ok(r.unresolvedDefaultBranch === undefined,
      `no remote: passenger detection RAN — the base was the local main, so nothing was left unevaluated (got ${r.unresolvedDefaultBranch})`);
    ok(r.ahead === 1, `no remote: the range is main..dev-loop/JBU-7 — the branch's own commit only (ahead ${r.ahead})`);
    ok(!!r.note && r.note.includes("main..dev-loop/JBU-7"),
      `no remote: the note names the local base it compared against (${r.note})`);

    const cli = guardCli(repo, "dev-loop/JBU-7", db);
    ok(cli.code === 0, `no remote: --strict exits 0 on a clean landing (got ${cli.code}) ${cli.out.slice(0, 300)}`);
    ok(!/does not exist/.test(cli.out), `no remote: …and prints no "origin/main does not exist" refusal (${cli.out.slice(0, 200)})`);
  }

  // ── The gate is not merely disabled: a REAL ride-along on this branch still trips it ─────────────
  {
    git(repo, ["commit", "--allow-empty", "-qm", "fix(other): canceled work aboard this branch (JBU-28)"]);
    const r = pushGuard(repo, "dev-loop/JBU-7", db, "main");
    ok(r.findings.some((f) => f.ticket === "JBU-28" && f.state === "Canceled"),
      `no remote: a canceled-ticket commit ON THE BRANCH is still a finding (got ${JSON.stringify(r.findings.map((f) => f.ticket))})`);
    ok(r.ahead === 2, `no remote: …and the range grew to the branch's two commits (ahead ${r.ahead})`);
    const cli = guardCli(repo, "dev-loop/JBU-7", db);
    ok(cli.code === 1, `no remote: --strict exits 1 on a real finding (got ${cli.code})`);
  }

  // ── Control: WITH a remote, every arm behaves exactly as before ──────────────────────────────────
  {
    const originDir = join(ROOT, "origin.git");
    const clone = join(ROOT, "with-remote");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", originDir]);
    execFileSync("git", ["clone", "-q", originDir, clone]);
    git(clone, ["commit", "--allow-empty", "-qm", "chore: baseline"]);
    git(clone, ["commit", "--allow-empty", "-qm", "fix(old): landed work (JBU-28)"]);
    git(clone, ["push", "-qu", "origin", "main"]);
    git(clone, ["checkout", "-qb", "dev-loop/JBU-7"]);
    git(clone, ["commit", "--allow-empty", "-qm", "feat(x): the ticket's own commit (JBU-7)"]);

    const r = pushGuard(clone, "dev-loop/JBU-7", db, "main");
    ok(r.findings.length === 0 && r.passengers.length === 0 && r.unresolvedDefaultBranch === undefined,
      `with a remote: a clean first push is clean, as before (findings ${r.findings.length}, passengers ${r.passengers.length})`);
    ok(r.ahead === 1, `with a remote: the range is origin/main..branch (ahead ${r.ahead})`);
    ok(guardCli(clone, "dev-loop/JBU-7", db).code === 0, "with a remote: --strict exits 0");

    // …and an origin that exists but carries no default branch is STILL the loud refusal it was:
    // that is a remote whose ref is missing, not a repo that has no remote at all.
    const emptyOrigin = join(ROOT, "empty-origin.git");
    const fresh = join(ROOT, "fresh-clone");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", emptyOrigin]);
    mkdirSync(fresh, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", fresh]);
    git(fresh, ["remote", "add", "origin", emptyOrigin]);
    git(fresh, ["commit", "--allow-empty", "-qm", "chore: baseline"]);
    git(fresh, ["checkout", "-qb", "dev-loop/JBU-7"]);
    git(fresh, ["commit", "--allow-empty", "-qm", "feat(x): first ever push (JBU-7)"]);
    const e = pushGuard(fresh, "dev-loop/JBU-7", db, "main");
    ok(e.unresolvedDefaultBranch === "main",
      `an origin with no default branch yet is still reported unevaluated — the remote exists, its ref does not (got ${e.unresolvedDefaultBranch})`);
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPUSH_GUARD_NO_REMOTE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
