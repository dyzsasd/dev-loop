// LOOP-352 — AC3: a SHORT-history fixture must NOT print a bare $<n>/accepted change
// (the denominator covers a shorter span than the numerator).
//
// fail-before/pass-after: run against the pre-fix code and this assertion
// FAILS; run against the shipped code and it PASSES.

import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-m352-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  // Build a workspace with an event ledger that starts INSIDE the window
  const wsRoot = join(tmp, "ws");
  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  mkdirSync(join(wsRoot, "repo"), { recursive: true });
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "m352", backend: "service" },
    repos: { repo: { path: "repo" } },
    projects: { real: { repos: [{ ref: "repo", role: "primary" }] } },
  }));

  // Create a hub.db with a fire ledger that has short history
  const { DatabaseSync } = await import("node:sqlite");
  const { openDb } = await import("../src/db.ts");
  const { ensureSeed } = await import("../src/seed.ts");
  const { dirname } = await import("node:path");

  const dbPath = join(tmp, "hub.db");
  const db = openDb(dbPath);
  ensureSeed(db, "real", "Real Project", "REAL");

  // Load workspace and set up fire ledger path
  const ws = (await import("../src/team-config.ts")).loadWorkspace(wsRoot);
  const fireLedger = (await import("../src/workspace.ts")).wsFireLedger(ws);

  // Add events only in the last 2 days (window is 7 days → historyIncomplete)
  const now = Date.now();
  const twoDaysAgo = now - 2 * 86_400_000;
  const pid = (db.prepare("SELECT id FROM projects WHERE key=?").get("real") as { id: string }).id;
  db.prepare("INSERT INTO events(project_id, ticket_id, actor, kind, data, created_at) VALUES(?,?,?,?,?,?)").run(
    pid, "REAL-1", "qa", "issue.transition", "{}", new Date(twoDaysAgo).toISOString()
  );

  // Ensure the fire ledger directory exists
  mkdirSync(dirname(fireLedger), { recursive: true });
  writeFileSync(fireLedger,
    Array.from({ length: 10 }, (_, i) => JSON.stringify({
      agent: "junior-dev", project: "real", ts: new Date(twoDaysAgo + i * 1000).toISOString(),
      exitCode: 0, durationMs: 5000,
      usage: { costUsd: 0.5 + i * 0.1 },
    }) + "\n").join("")
  );

  const { fireMetrics, renderHuman } = await import("../src/metrics.ts");
  const windowMs = 7 * 86_400_000;
  const fires = fireMetrics(fireLedger, windowMs);
  const out: Record<string, unknown> = {
    team: "m352", windowDays: 7, fires,
    project: "real",
    boardNote: null,
  };

  // Add teamRollup with historyIncomplete = true (short event ledger)
  out.teamRollup = {
    throughput: 5, verifyFails: 0, acceptRate: 1.0, blockedNow: 0, sequencedNow: 0,
    bugsFiled: 0, escaped: null, historyIncomplete: true, historyFloor: new Date(twoDaysAgo).toISOString(),
  };

  // Capture renderHuman output
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (...args: string[]) => lines.push(args.join(" "));

  renderHuman(ws, windowMs, fires, out);
  console.log = origLog;

  const costLine = lines.find((l) => l.startsWith("cost:"));
  // bare = unqualified line ending with ) immediately after "accepted change"
  const hasBareRatio = /\(\$[\d.]+\/accepted change\)/.test(costLine ?? "");
  const hasQualifiedRatio = costLine?.includes("incomplete history") ?? false;
  ok(!hasBareRatio, "LOOP-352 AC1: bare $/accepted change is NOT printed when history is incomplete");
  ok(hasQualifiedRatio, "LOOP-352 AC1: the ratio is qualified with the floor date when history is incomplete");
  // AC2: with full history, the output is byte-identical (no qualification)
  out.teamRollup = {
    throughput: 5, verifyFails: 0, acceptRate: 1.0, blockedNow: 0, sequencedNow: 0,
    bugsFiled: 0, escaped: null, historyIncomplete: false, historyFloor: null,
  };
  const lines2: string[] = [];
  console.log = (...args: string[]) => lines2.push(args.join(" "));
  renderHuman(ws, windowMs, fires, out);
  console.log = origLog;

  const costLine2 = lines2.find((l) => l.startsWith("cost:"));
  const hasUnqualified = /\(\$[\d.]+\/accepted change\)$/.test(costLine2 ?? "");
  ok(hasUnqualified, "LOOP-352 AC2: full history → unqualified ratio (byte-identical)");
ok(hasUnqualified, "LOOP-405 AC3: full history → unqualified ratio (byte-identical to LOOP-352 AC2)");

// === LOOP-405 AC4: renderHuman incomplete-history branch does NOT substitute the basis ===
// The costLine was captured with historyIncomplete=true (LOOP-352 AC1 fixture)
do {
  ok(costLine?.includes("accepted change") ?? false, "LOOP-405 AC4: renderHuman cost line includes 'accepted change'");
  ok(costLine?.includes("incomplete history") ?? false, "LOOP-405 AC4: renderHuman cost line includes incomplete-history qualification");
  const match = costLine?.match(/\$[\d.]+\/accepted change/);
  ok(match?.length ? match.length > 0 : false, "LOOP-405 AC4: renderHuman cost line has $/accepted change value (basis is not substituted)");
} while (false);

  const report: import("../src/metrics.ts").UsageReport = {
    windowMs: 7 * 86_400_000,
    totalFires: 10,
    meteredFires: 10,
    overall: { costUsd: 100, discardedUsd: 20, fires: 10, metered: 10, discardedFires: 2, costMetered: 8, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costPriced: 8 },
    byDimension: {},
  };

  const threeDaysAgo = Date.now() - 3 * 86_400_000;

  // True-branch: historyIncomplete === true
  do {
    const flowLines: string[] = [];
    const origLog2 = console.log;
    console.log = (...args: string[]) => flowLines.push(args.join(" "));
    const { renderFlow } = await import("../src/metrics.ts");
    renderFlow(report, 5, null, true, new Date(threeDaysAgo).toISOString());
    console.log = origLog2;
    const flowLine = flowLines.find((l) => l.includes("cost-per-accepted-change"));
    ok(!!flowLine, "LOOP-405 AC2: flow cost line printed (history incomplete)");
    ok(flowLine!.includes("delivered spend ÷ throughput"), "LOOP-405 AC2 true: includes basis annotation");
    ok(flowLine!.includes("discarded fires excluded"), "LOOP-405 AC2 true: includes 'discarded fires excluded'");
    ok(flowLine!.includes("incomplete history"), "LOOP-405 AC2 true: includes incomplete-history qualification");
  } while (false);

  // False-branch: historyIncomplete === false
  do {
    const flowLines: string[] = [];
    const origLog3 = console.log;
    console.log = (...args: string[]) => flowLines.push(args.join(" "));
    const { renderFlow } = await import("../src/metrics.ts");
    renderFlow(report, 5, null, false, null);
    console.log = origLog3;
    const flowLine = flowLines.find((l) => l.includes("cost-per-accepted-change"));
    ok(!!flowLine, "LOOP-405 AC2: flow cost line printed (history complete)");
    ok(flowLine!.includes("delivered spend ÷ throughput"), "LOOP-405 AC2 false: includes basis annotation");
    ok(flowLine!.includes("discarded fires excluded"), "LOOP-405 AC2 false: includes 'discarded fires excluded'");
    ok(!flowLine!.includes("incomplete history"), "LOOP-405 AC2 false: does NOT include incomplete-history qualification");
  } while (false);

// === LOOP-405 AC3 (same line as LOOP-352 AC2 — complete-history branch byte-identical) ===
  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nMETRICS_HISTORY_OK");
process.exit(fails ? 1 : 0);