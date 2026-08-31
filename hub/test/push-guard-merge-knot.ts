// push-guard-merge-knot.ts — a `landing:"direct"` landing may not carry a merge commit.
//
// §7's merge-back sequence says it twice: rebase onto the base when it advanced, and land with
// `git merge --ff-only` — "never create a merge knot on defaultBranch". Measured on JBU-44: the fire
// merged origin/main INTO its branch (f8398b0 "Merge remote-tracking branch 'origin/main' into
// dev-loop/JBU-44") and then fast-forwarded main onto it, so the merge commit landed on main and the
// history knotted. The instruction was in the conventions and the agent did not follow it; push-guard
// is the only hard gate in front of a direct landing, so it is where the rule becomes enforceable.
//
// `landing:"pr"` is unaffected: a PR is landed by the forge, which squashes or merges by its own
// setting, and the branch's own shape is not the base's business.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pushGuard } from "../src/push-guard.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
const ROOT = realpathSync(tmpRoot("dl-pg-knot-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const guardCli = (repo: string, branch: string) => {
  const r = spawnSync(process.execPath,
    [join(hubRoot, "src", "push-guard.ts"), "--repo", repo, "--branch", branch, "--default-branch", "main", "--strict"],
    { encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HOME: join(ROOT, "home") } as NodeJS.ProcessEnv });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/**
 * A workspace holding one repo with the given landing mode, and a branch that merged main into
 * itself instead of rebasing — the measured shape.
 */
function fixture(name: string, landing: string): { repo: string; mergeSha: string } {
  const ws = join(ROOT, name);
  const repo = join(ws, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(ws, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: `knot-${name}`, backend: "service" },
    repos: { repo: { path: "repo", landing } },
    projects: { p: { prefix: "KNOT" } },
  }, null, 2) + "\n");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, ["commit", "--allow-empty", "-qm", "chore: baseline"]);
  git(repo, ["checkout", "-qb", "dev-loop/KNOT-1"]);
  git(repo, ["commit", "--allow-empty", "-qm", "feat(x): the ticket's work (KNOT-1)"]);
  // main advances underneath, and the branch MERGES it instead of rebasing onto it.
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["commit", "--allow-empty", "-qm", "chore: the other tier landed first"]);
  git(repo, ["checkout", "-q", "dev-loop/KNOT-1"]);
  git(repo, ["merge", "--no-ff", "-q", "-m", "Merge branch 'main' into dev-loop/KNOT-1", "main"]);
  return { repo, mergeSha: git(repo, ["rev-parse", "HEAD"]).slice(0, 7) };
}

try {
  // ── direct: the merge commit is a refusal that names it and the remedy ───────────────────────────
  {
    const { repo, mergeSha } = fixture("direct", "direct");
    const r = pushGuard(repo, "dev-loop/KNOT-1", undefined, "main");
    ok((r.mergeCommits ?? []).some((m) => m.sha === mergeSha),
      `direct: the merge commit is reported, by sha (${JSON.stringify(r.mergeCommits ?? [])})`);
    const cli = guardCli(repo, "dev-loop/KNOT-1");
    ok(cli.code === 1, `direct: --strict exits 1 (got ${cli.code})`);
    ok(cli.out.includes(mergeSha) && /[Rr]ebase onto the base instead/.test(cli.out),
      `direct: the refusal names the sha and the remedy (${cli.out.split("\n").find((l) => l.includes("merge")) ?? cli.out.slice(0, 160)})`);

    // …and the SAME branch, rebased, is clean. This is what separates "the rule is enforced" from
    // "this fixture cannot pass": the remedy the message prints actually clears the gate.
    git(repo, ["rebase", "-q", "main"]);
    const after = pushGuard(repo, "dev-loop/KNOT-1", undefined, "main");
    ok((after.mergeCommits ?? []).length === 0, `direct: after rebasing, no merge commit is reported (${JSON.stringify(after.mergeCommits ?? [])})`);
    ok(guardCli(repo, "dev-loop/KNOT-1").code === 0, "direct: …and --strict exits 0");
  }

  // ── pr: the forge lands the branch, so its shape is not this gate's business ─────────────────────
  {
    const { repo, mergeSha } = fixture("pr", "pr");
    const r = pushGuard(repo, "dev-loop/KNOT-1", undefined, "main");
    ok((r.mergeCommits ?? []).length === 0,
      `pr: a merge commit on the branch is NOT reported (${JSON.stringify(r.mergeCommits ?? [])})`);
    const cli = guardCli(repo, "dev-loop/KNOT-1");
    ok(cli.code === 0 && !cli.out.includes(mergeSha), `pr: --strict exits 0 and never names it (got ${cli.code})`);
  }

  // ── a clean direct branch keeps the pre-change result shape ──────────────────────────────────────
  // The field is absent, not an empty array: a consumer parsing the old --json shape sees no new key.
  {
    const ws = join(ROOT, "clean");
    const repo = join(ws, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ws, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, team: { key: "knot-clean", backend: "service" },
      repos: { repo: { path: "repo", landing: "direct" } }, projects: { p: { prefix: "KNOT" } },
    }, null, 2) + "\n");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, ["commit", "--allow-empty", "-qm", "chore: baseline"]);
    git(repo, ["checkout", "-qb", "dev-loop/KNOT-2"]);
    git(repo, ["commit", "--allow-empty", "-qm", "feat(y): linear history (KNOT-2)"]);
    const r = pushGuard(repo, "dev-loop/KNOT-2", undefined, "main");
    ok(!("mergeCommits" in r), `a clean direct branch carries no mergeCommits key at all (${JSON.stringify(Object.keys(r))})`);
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPUSH_GUARD_MERGE_KNOT_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
