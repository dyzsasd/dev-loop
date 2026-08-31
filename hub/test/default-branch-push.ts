// LOOP-567 — the default-branch refusal. Four commits reached `origin/main` of this `landing:"pr"`
// repo with no PR containing them, via §7's `direct` merge-back sequence run from the shared
// checkout during a junior fire's Step 0 orphan reclaim.
//
// The three arms below are the AC3 fixture and they are not interchangeable — each one kills a
// different WRONG fix:
//   (1) refuse-code-in-`pr`      — the defect itself. Fails against the pre-LOOP-567 tree.
//   (2) permit-in-`direct`       — kills a blanket "never push the default branch" ban.
//   (3) permit-doc-land-in-`pr`  — kills a `landing`-only predicate. `dev-loop doc-land` is the §20
//                                  D4 sanctioned path and produces the SAME shape as the defect
//                                  (no PR, direct push to main); only the path set separates them.
// Arm (4) pins the placement claim: the verdict is reachable through `pushGuard` itself, which is
// what puts it on the path of both observed mechanisms (doc-land calls it as a library; §7 mandates
// `push-guard --strict` before the merge-back's push). A refusal that lived only in the `push` verb
// would pass arms 1–3 and still catch neither real instance.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";
import { pushGuard } from "../src/push-guard.ts";
import { defaultBranchPushVerdict, docLandAllowlist, strategyDocRelPath } from "../src/default-branch-push.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const STRATEGY_PATH = "docs/STRATEGY.md";
const ROOT = tmpRoot("dl-dbpush-");
try {
  const git = (dir: string, args: string[]): string =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  // One workspace per landing mode — the predicate reads `repos.<ref>.landing`, so the two modes
  // cannot share a config file.
  const mkWs = (name: string, landing: string): { wsRoot: string; repoDir: string } => {
    const wsRoot = join(ROOT, name);
    const origin = join(wsRoot, "origin.git");
    const repoDir = join(wsRoot, "dev-loop");
    mkdirSync(origin, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, repoDir]);
    git(repoDir, ["commit", "--allow-empty", "-qm", "baseline"]);
    git(repoDir, ["push", "-qu", "origin", "main"]);
    writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      workspaceId: `test-${name}`,
      team: { key: "test", backend: "service", mode: "live", autonomy: "ask" },
      repos: { "dev-loop": { path: "dev-loop", remote: origin, landing } },
      projects: { test: { repos: [{ ref: "dev-loop" }], strategyDoc: { path: STRATEGY_PATH } } },
    }, null, 2));
    mkdirSync(join(wsRoot, ".dev-loop", "locks"), { recursive: true });
    return { wsRoot, repoDir };
  };
  const commitFile = (repoDir: string, rel: string, body: string, msg: string): void => {
    mkdirSync(join(repoDir, dirname(rel)), { recursive: true });
    writeFileSync(join(repoDir, rel), body);
    git(repoDir, ["add", rel]);
    git(repoDir, ["commit", "-qm", msg]);
  };

  // ── (1) refuse: code on `main` in a `landing:"pr"` repo ────────────────────────────
  // The exact 06:12Z shape: the merge-back left `main` ahead of `origin/main` carrying src+test.
  const pr = mkWs("pr-code", "pr");
  commitFile(pr.repoDir, "hub/src/run-agents.ts", "// code\n", "fix(run-agents): --dry-run prints promptly (TEST-459)");
  commitFile(pr.repoDir, "hub/test/loop459-dryrun.ts", "// test\n", "test(run-agents): dry-run arm (TEST-459)");
  const rCode = pushGuard(pr.repoDir, "main", join(pr.wsRoot, ".dev-loop", "hub.db"), "main");
  ok(!!rCode.landing, "(1) code on main in a landing:\"pr\" repo TRIPS the default-branch class");
  ok(rCode.landing?.offenders.includes("hub/src/run-agents.ts") === true,
    `(1) the refusal names the offending path(s) (got ${JSON.stringify(rCode.landing?.offenders)})`);
  ok(rCode.landing?.landing === "pr", "(1) the verdict names the landing mode it enforced");

  // ── (2) permit: the same range in a `landing:"direct"` repo ───────────────────────
  // §7's merge-back IS that mode's sanctioned landing. A blanket default-branch ban fails here.
  const dir = mkWs("direct-code", "direct");
  commitFile(dir.repoDir, "hub/src/run-agents.ts", "// code\n", "fix(run-agents): same commit, direct-mode repo (TEST-459)");
  const rDirect = pushGuard(dir.repoDir, "main", join(dir.wsRoot, ".dev-loop", "hub.db"), "main");
  ok(!rDirect.landing, "(2) the SAME code range in a landing:\"direct\" repo is permitted — §7 merge-back");

  // ── (3) permit: a docs-only range in the SAME `landing:"pr"` repo — `dev-loop doc-land` ──
  const docs = mkWs("pr-docs", "pr");
  commitFile(docs.repoDir, STRATEGY_PATH, "# Strategy\n\npass 1\n", "docs(strategy): §20 pass 1 (TEST-567)");
  commitFile(docs.repoDir, "docs/strategy-archive/2026-07.md", "# July\n", "docs(strategy): roll July to the archive (TEST-567)");
  const rDocs = pushGuard(docs.repoDir, "main", join(docs.wsRoot, ".dev-loop", "hub.db"), "main");
  ok(!rDocs.landing,
    `(3) a docs-only range under landing:"pr" is permitted — that is doc-land, §20 D4 (got ${JSON.stringify(rDocs.landing?.offenders)})`);

  // The discriminator is the PATH SET, not the branch and not the mode: one non-doc file in an
  // otherwise doc-only range flips the same repo to refused. Without this, arm (3) could be passed
  // by a predicate that merely whitelists the doc-land CALLER.
  commitFile(docs.repoDir, "hub/src/doctor.ts", "// smuggled\n", "docs(strategy): §20 pass 2 (TEST-567)");
  const rMixed = pushGuard(docs.repoDir, "main", join(docs.wsRoot, ".dev-loop", "hub.db"), "main");
  ok(rMixed.landing?.offenders.length === 1 && rMixed.landing.offenders[0] === "hub/src/doctor.ts",
    `(3b) one code file in an otherwise docs-only range refuses, and names only that file (got ${JSON.stringify(rMixed.landing?.offenders)})`);

  // ── (4) the class does not fire where the whole pr flow lives: a feature branch ────
  git(pr.repoDir, ["checkout", "-qb", "dev-loop/TEST-459"]);
  commitFile(pr.repoDir, "hub/src/other.ts", "// code\n", "fix(other): on a feature branch (TEST-459)");
  const rBranch = pushGuard(pr.repoDir, "dev-loop/TEST-459", join(pr.wsRoot, ".dev-loop", "hub.db"), "main");
  ok(!rBranch.landing, "(4) a dev-loop/<id> branch push is untouched — that IS the pr flow");
  git(pr.repoDir, ["checkout", "-q", "main"]);

  // ── (5) the CLI contract: --strict exits 1 and prints the route out ───────────────
  const cli = spawnSync(process.execPath, [join(hubRoot, "src", "push-guard.ts"), "--repo", pr.repoDir, "--branch", "main", "--default-branch", "main", "--strict"],
    { encoding: "utf8", env: scrubFireEnv() });
  ok(cli.status === 1, `(5) push-guard --strict exits 1 on the refusal (got ${cli.status})`);
  ok(/landing:"pr"/.test(cli.stdout) && /open a PR/.test(cli.stdout),
    `(5) the refusal names the mode and the route out (got: ${cli.stdout.trim().slice(0, 200)})`);

  // ── (6) unit arms on the pure predicate: the fail-closed corners ──────────────────
  const allow = docLandAllowlist(STRATEGY_PATH);
  ok(defaultBranchPushVerdict({ branch: "main", defaultBranch: "main", landing: "pr", changedPaths: [], allow }) === null,
    "(6) an empty path set is not a code push — a no-op is not refused");
  ok(defaultBranchPushVerdict({ branch: "main", defaultBranch: "main", landing: undefined, changedPaths: ["hub/src/x.ts"], allow }) === null,
    "(6) absent landing ⇒ direct (§12b) ⇒ permitted");
  ok(defaultBranchPushVerdict({ branch: "main", defaultBranch: "main", landing: "pr", changedPaths: ["hub/src/x.ts"], allow: null }) !== null,
    "(6) a pr repo whose project has no repo-file strategyDoc fails CLOSED — no carve-out to apply");
  ok(strategyDocRelPath({ hubDoc: "strategy" }) === null && strategyDocRelPath({ path: STRATEGY_PATH }) === STRATEGY_PATH,
    "(6) strategyDocRelPath: hub forms have no repo path; the file form resolves");

} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "default-branch-push: all checks passed");
process.exit(fails ? 1 : 0);
