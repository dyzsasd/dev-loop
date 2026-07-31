// LOOP-67 regression: merge-guard board-state axis must trip when the PR's ticket is In Review,
// Canceled, or Duplicate; pass on Todo/In Progress; and skip (no false trip) when no hub DB is present.
// Design: merge-review-guard §3.3 + §8-Child4.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { mergeGuard } from "../src/merge-guard.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-merge-guard-"));
try {
  // ── Fixture: hub.db with tickets in each board state ──────────────────────────
  const dbPath = join(ROOT, "hub.db");
  const conn = openDb(dbPath);
  conn.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  const tk = (id: string, state: string): void => {
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')").run(id, "p", "t-" + id, state);
  };
  tk("MG-1", "Todo");
  tk("MG-2", "In Progress");
  tk("MG-3", "In Review");
  tk("MG-4", "Canceled");
  tk("MG-5", "Duplicate");
  conn.close();

  // A fake repo dir so resolveHubDbPath has something to look at (we pass dbPath explicitly)
  const repoDir = join(ROOT, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, ".git"), "");  // stub — not a real git repo, but we pass dbPath explicitly

  // ── AC: Todo/In Progress → no trip ───────────────────────────────────────────
  const rTodo = mergeGuard(repoDir, { ticketId: "MG-1", dbPath });
  ok(!rTodo.trip, "Todo ticket → no trip");
  ok(rTodo.boardState.ticketState === "Todo", "Todo: state reported correctly");
  ok(!rTodo.boardState.skipped, "Todo: axis was evaluated (not skipped)");

  const rInProgress = mergeGuard(repoDir, { ticketId: "MG-2", dbPath });
  ok(!rInProgress.trip, "In Progress ticket → no trip");
  ok(rInProgress.boardState.ticketState === "In Progress", "In Progress: state reported correctly");

  // ── AC: In Review → trip ─────────────────────────────────────────────────────
  const rInReview = mergeGuard(repoDir, { ticketId: "MG-3", dbPath });
  ok(rInReview.trip, "In Review ticket → trip");
  ok(rInReview.boardState.trip === rInReview.trip, "boardState.trip consistent with result.trip");
  ok(rInReview.boardState.ticketState === "In Review", "In Review: state reported correctly");

  // ── AC: Canceled → trip ───────────────────────────────────────────────────────
  const rCanceled = mergeGuard(repoDir, { ticketId: "MG-4", dbPath });
  ok(rCanceled.trip, "Canceled ticket → trip");
  ok(rCanceled.boardState.ticketState === "Canceled", "Canceled: state reported correctly");

  // ── AC: Duplicate → trip ──────────────────────────────────────────────────────
  const rDuplicate = mergeGuard(repoDir, { ticketId: "MG-5", dbPath });
  ok(rDuplicate.trip, "Duplicate ticket → trip");
  ok(rDuplicate.boardState.ticketState === "Duplicate", "Duplicate: state reported correctly");

  // ── AC: no hub DB → axis skipped (no false trip) ─────────────────────────────
  const rNoDb = mergeGuard(repoDir, { ticketId: "MG-3", dbPath: join(ROOT, "nonexistent.db") });
  ok(!rNoDb.trip, "no hub DB → no trip (axis skipped, no false positive)");
  ok(rNoDb.boardState.skipped, "no hub DB → skipped=true");

  // ── AC: unknown ticket (not in hub) → no trip ────────────────────────────────
  const rUnknown = mergeGuard(repoDir, { ticketId: "MG-999", dbPath });
  ok(!rUnknown.trip, "unknown ticket → no trip (fail-open for unknown)");
  ok(!rUnknown.boardState.skipped, "unknown ticket: axis evaluated");
  ok(rUnknown.boardState.ticketState === null, "unknown ticket: state is null");

  // ── AC: no ticketId provided → no trip ───────────────────────────────────────
  const rNoTicket = mergeGuard(repoDir, { dbPath });
  ok(!rNoTicket.trip, "no ticketId, no inferrable branch → no trip");
  ok(!rNoTicket.boardState.trip, "no ticketId: boardState.trip=false");

  // ── CLI tests ─────────────────────────────────────────────────────────────────
  const cli = (args: string[], env?: Record<string, string>): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [join(hubRoot, "src", "merge-guard.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  // CLI advisory (no --strict): exit 0 even when tripped
  const cliInReview = cli(["--repo", repoDir, "--ticket", "MG-3"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliInReview.status === 0, "CLI advisory: In Review → exit 0 (no --strict)");
  ok(/TRIP|In Review/.test(cliInReview.stderr), `CLI: trip message on stderr for In Review (got: ${cliInReview.stderr.trim().slice(0, 100)})`);

  // CLI --strict: exit 1 on trip
  const cliStrict = cli(["--repo", repoDir, "--ticket", "MG-3", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliStrict.status === 1, "CLI --strict: In Review → exit 1");

  // CLI --strict: exit 0 on Todo
  const cliStrictClean = cli(["--repo", repoDir, "--ticket", "MG-1", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliStrictClean.status === 0, "CLI --strict: Todo → exit 0 (merge-eligible)");
  ok(/merge-eligible/.test(cliStrictClean.stdout), `CLI: merge-eligible message for Todo (got: ${cliStrictClean.stdout.trim()})`);

  // CLI: no hub DB → exits 0 (skipped, no false trip)
  const cliNoDb = cli(["--repo", repoDir, "--ticket", "MG-3", "--strict"], { DEVLOOP_HUB_DB: join(ROOT, "no.db") });
  ok(cliNoDb.status === 0, "CLI: no hub DB + --strict → exit 0 (skipped, never a false trip)");
  ok(/skipped/.test(cliNoDb.stdout), "CLI: no hub DB mentions 'skipped'");

  // CLI --json: valid JSON output
  const cliJson = cli(["--repo", repoDir, "--ticket", "MG-3", "--json"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliJson.status === 0, "CLI --json: exits 0 (advisory)");
  let parsed: { trip?: boolean; boardState?: { ticketState?: string } } = {};
  try { parsed = JSON.parse(cliJson.stdout); } catch { ok(false, "CLI --json: output is valid JSON"); }
  ok(parsed.trip === true, `CLI --json: trip=true for In Review (got: ${JSON.stringify(parsed)})`);
  ok(parsed.boardState?.ticketState === "In Review", "CLI --json: boardState.ticketState='In Review'");

  // CLI Canceled --strict
  const cliCanceled = cli(["--repo", repoDir, "--ticket", "MG-4", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliCanceled.status === 1, "CLI --strict: Canceled → exit 1");

  // CLI Duplicate --strict
  const cliDuplicate = cli(["--repo", repoDir, "--ticket", "MG-5", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliDuplicate.status === 1, "CLI --strict: Duplicate → exit 1");

  // CLI In Progress --strict → exit 0 (merge-eligible)
  const cliInProgress = cli(["--repo", repoDir, "--ticket", "MG-2", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliInProgress.status === 0, "CLI --strict: In Progress → exit 0");

} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "merge-guard: all checks passed");
process.exit(fails ? 1 : 0);
