// doctor-golden.ts — Child A of LOOP-348 (design §8): the byte-identical golden harness.
// No production change: every diff under hub/src/ in this ticket is a defect.
//
// Two fixtures, two committed golden files:
//   clean    — valid workspace, one git repo, no board db
//   findings — seeded hub.db with a null-assignee ticket, a sensitive ticket assigned to
//              the junior tier, and a dirty shared tree
//
// On mismatch prints a unified diff. --update-golden (env or argv) rewrites the goldens.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-doc-golden-")));
const HERE = new URL(".", import.meta.url).pathname;
const GOLDEN_DIR = join(HERE, "golden");
const UPDATE = process.env.DEVLOOP_UPDATE_GOLDEN !== undefined || process.argv.includes("--update-golden");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const capture = async (fn: () => Promise<unknown>): Promise<string> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
};

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// ── Normalize host-dependent lines ──────────────────────────────────────
// Design §8 table. Order matters: apply broader patterns first so they
// don't interfere with narrower ones.
function normalize(raw: string, wsRoot: string): string {
  let s = raw;

  // Normalize ws.root → <WS>
  s = s.split(wsRoot).join("<WS>");

  // Normalize date stamps (ISO strings and .slice(0,10) dates)
  s = s.replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");

  // Normalize ISO timestamps with time
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TIMESTAMP>");

  // Normalize W25 daemon port band (e.g., "port 8787" / "port 8788")
  s = s.replace(/port \d+/g, "port <PORT>");

  // Normalize W36 scheduler build commit hash (40 hex chars or the full line)
  s = s.replace(/build [0-9a-f]{7,40}/g, "build <BUILD>");
  s = s.replace(/loaded build [0-9a-f]{7,40}/g, "loaded build <BUILD>");

  // Normalize git abbrev refs and commit SHAs (7+ hex chars)
  s = s.replace(/\b[0-9a-f]{7,40}\b(?!\.json|\.ts|\.js)/g, "<SHA>");

  // Normalize /private/var tmp paths
  s = s.replace(/\/private\/var[^\s,)]+/g, "<TMP>");
  s = s.replace(/\/var[^\s,)]+/g, "<TMP>");

  // Normalize PID numbers
  s = s.replace(/pid \d+/g, "pid <PID>");

  return s;
}

function readGolden(name: string): string {
  const p = join(GOLDEN_DIR, `golden-${name}.txt`);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

function writeGolden(name: string, content: string): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(join(GOLDEN_DIR, `golden-${name}.txt`), content);
}

// ── Unified diff helper (inline, no dependency) ─────────────────────────
function unifiedDiff(expected: string, actual: string): string {
  const eLines = expected.split("\n");
  const aLines = actual.split("\n");
  const lines: string[] = [];
  const maxLen = Math.max(eLines.length, aLines.length);
  let context = 0;
  let inHunk = false;

  for (let i = 0; i < maxLen; i++) {
    const e = eLines[i] ?? "";
    const a = aLines[i] ?? "";
    if (e === a) {
      if (inHunk && context < 3) { lines.push(` ${e}`); context++; }
      else if (inHunk) { inHunk = false; context = 0; }
    } else {
      if (!inHunk) {
        lines.push(`@@ -${i + 1} +${i + 1} @@`);
        inHunk = true;
        context = 0;
      }
      if (e !== undefined) lines.push(`-${e}`);
      if (a !== undefined) lines.push(`+${a}`);
    }
  }
  return lines.join("\n");
}

// ── Fixture builders ────────────────────────────────────────────────────

interface FixtureResult {
  wsRoot: string;
  output: string;
}

async function buildClean(): Promise<FixtureResult> {
  const wsRoot = join(tmp, "clean");
  const repoDir = join(wsRoot, "repo");

  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "golden-clean", backend: "service" },
    repos: { repo: { path: "repo" } },
    projects: {},
  }));

  git(repoDir, "init", "-q", "-b", "main");
  git(repoDir, "commit", "--allow-empty", "-qm", "init");

  // No board db at all — board-scope checks (W16/W21/W27/W31) are skipped
  // No fires.jsonl — W24 (fires taxonomy) is skipped
  // No opencode provider — W13/W14/W15 are skipped

  const ws = loadWorkspace(wsRoot);
  const out = await capture(() => doctorWorkspace(ws, {}));
  return { wsRoot, output: out };
}

async function buildFindings(): Promise<FixtureResult> {
  const wsRoot = join(tmp, "findings");
  const repoDir = join(wsRoot, "repo");

  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "golden-findings", backend: "service", devSplit: true },
    repos: { repo: { path: "repo" } },
    projects: { loop: { prefix: "LOOP", devSplit: true } },
  }));

  git(repoDir, "init", "-q", "-b", "main");
  git(repoDir, "commit", "--allow-empty", "-qm", "init");

  // Dirty shared tree: uncommitted tracked modification → W33
  writeFileSync(join(repoDir, "dirty-file.ts"), "// uncommitted work\n");
  git(repoDir, "add", "dirty-file.ts");
  // Stage it but don't commit — tracked file with uncommitted modification
  writeFileSync(join(repoDir, "dirty-file.ts"), "// modified but uncommitted\n");

  // Seed hub.db with:
  // - null-assignee ticket → W27
  // - sensitive ticket assigned to junior tier → W21
  const dbPath = join(wsRoot, ".dev-loop", "hub.db");
  const db = openDb(dbPath);
  db.prepare(
    "INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')"
  ).run();
  const ins = db.prepare(
    "INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  const NOW = "2026-08-01T00:00:00.000Z";
  // null-assignee ticket → W27
  ins.run("LOOP-1", "p1", "Null assignee ticket", "", "Bug", "Todo", 2,
    JSON.stringify(["dev-loop", "Bug", "qa", "junior-dev"]), "[]", "qa", NOW, NOW, null);
  // sensitive ticket assigned to junior tier → W21
  ins.run("LOOP-2", "p1", "Sensitive ticket", "", "Improvement", "Todo", 2,
    JSON.stringify(["dev-loop", "Improvement", "sensitive", "junior-dev"]), "[]", "pm", NOW, NOW, "junior-dev");
  // Terminal ticket (Done) — should NOT be flagged
  ins.run("LOOP-3", "p1", "Done ticket", "", "Bug", "Done", 2,
    JSON.stringify(["dev-loop", "Bug", "qa", "junior-dev"]), "[]", "qa", NOW, NOW, "junior-dev");
  db.close();

  const ws = loadWorkspace(wsRoot);
  const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
  return { wsRoot, output: out };
}

// ── Main ────────────────────────────────────────────────────────────────

try {
  // ── Clean fixture ──
  const clean = await buildClean();
  const cleanNorm = normalize(clean.output, clean.wsRoot);

  if (UPDATE) {
    writeGolden("clean", cleanNorm);
    console.log("✅ golden-clean.txt written");
  } else {
    const expected = readGolden("clean");
    if (!expected) {
      console.log("❌ golden-clean.txt not found — run with --update-golden first");
      fails++;
    } else if (cleanNorm !== expected) {
      console.log("❌ clean fixture output differs from golden:");
      console.log(unifiedDiff(expected, cleanNorm));
      fails++;
    } else {
      ok(true, "clean: output matches golden");
    }
  }

  // ── Findings fixture ──
  const findings = await buildFindings();
  const findingsNorm = normalize(findings.output, findings.wsRoot);

  if (UPDATE) {
    writeGolden("findings", findingsNorm);
    console.log("✅ golden-findings.txt written");
  } else {
    const expected = readGolden("findings");
    if (!expected) {
      console.log("❌ golden-findings.txt not found — run with --update-golden first");
      fails++;
    } else if (findingsNorm !== expected) {
      console.log("❌ findings fixture output differs from golden:");
      console.log(unifiedDiff(expected, findingsNorm));
      // AC3: golden must actually contain board-scope output
      if (findingsNorm.includes("[W27]")) {
        console.log("  (note: findings golden DOES contain [W27] — board scope is covered)");
      }
      if (findingsNorm.includes("[W33]")) {
        console.log("  (note: findings golden DOES contain [W33] — non-clean path is covered)");
      }
      fails++;
    } else {
      ok(true, "findings: output matches golden");
    }
  }

  // ── AC3 verification (always runs even on UPDATE) ──
  const findingsToCheck = UPDATE ? findingsNorm : readGolden("findings");
  if (findingsToCheck) {
    ok(findingsToCheck.includes("[W27]"), "findings golden contains [W27] (board scope)");
    ok(findingsToCheck.includes("[W33]"), "findings golden contains [W33] (non-clean path)");
  }

} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

if (fails > 0) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
else if (!UPDATE) console.log("\nDOCTOR_GOLDEN_OK");
else console.log("\nDOCTOR_GOLDEN_UPDATED — re-run without --update-golden to verify");