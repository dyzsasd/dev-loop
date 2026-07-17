// P1-2 push-guard — regression tests for the ride-along class (MP-275: a Canceled ticket's commit rode a
// batched push into a prod deploy). Real git repos (bare origin + clone), real hub rows.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { pushGuard } from "../src/push-guard.ts";

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
  const clean = pushGuard(work, "main", db);
  ok(clean.ahead === 0 && clean.findings.length === 0, "clean branch → 0 ahead, no findings");

  // the MP-275 shape: a canceled ticket's commit is aboard, plus legal work and a ghost ref
  git(work, ["commit", "--allow-empty", "-qm", "CERT-1: canceled work rides along"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-2: legal in-flight work"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-3: superseded duplicate"]);
  git(work, ["commit", "--allow-empty", "-qm", "CERT-9: ghost ref"]);
  git(work, ["commit", "--allow-empty", "-qm", "docs: no ticket ref"]);
  const r = pushGuard(work, "main", db);
  ok(r.ahead === 5, `5 commits ahead (got ${r.ahead})`);
  ok(r.findings.some((f) => f.ticket === "CERT-1" && f.state === "Canceled"), "Canceled ref flagged (the MP-275 shape)");
  ok(r.findings.some((f) => f.ticket === "CERT-3" && f.state === "Duplicate"), "Duplicate ref flagged too");
  ok(!r.findings.some((f) => f.ticket === "CERT-2"), "a legal in-flight ref is NOT a finding");
  ok(r.unknownRefs.includes("CERT-9"), "a ref with no hub row is reported unverifiable, never a finding");

  // no upstream → advisory note, never a crash
  git(work, ["checkout", "-qb", "feature/x"]);
  const nb = pushGuard(work, "feature/x", db);
  ok(nb.ahead === 0 && /no upstream/.test(nb.note ?? ""), "a branch with no upstream → note (first push)");
  git(work, ["checkout", "-qm", "main"]);

  // CLI: advisory exit 0; --strict exit 1 with findings; clean --strict exit 0
  const cli = (args: string[]) => spawnSync(process.execPath, [join(hubRoot, "src", "push-guard.ts"), ...args],
    { encoding: "utf8", env: { ...process.env, DEVLOOP_HUB_DB: db } });
  const adv = cli(["--repo", work, "--branch", "main"]);
  ok(adv.status === 0 && /ride-along: .*CERT-1 \(Canceled\)/.test(adv.stdout), "CLI advisory: prints the finding, exits 0");
  const strict = cli(["--repo", work, "--branch", "main", "--strict"]);
  ok(strict.status === 1, "CLI --strict: findings ⇒ exit 1 (the §12 pre-push gate shape)");
  git(work, ["push", "-q", "origin", "main"]); // flush everything
  const strictClean = cli(["--repo", work, "--branch", "main", "--strict"]);
  ok(strictClean.status === 0 && /clean/.test(strictClean.stdout), "CLI --strict on a clean branch ⇒ exit 0");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "push-guard: all checks passed");
process.exit(fails ? 1 : 0);
