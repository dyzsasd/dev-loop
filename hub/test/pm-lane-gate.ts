// The pm job-lane gate — which JOB a pm-* lane runs, and when it runs nothing at all.
//
// pmLaneGate had no test naming it: hub/test grep found zero references to it or to `laneGate`, and the
// 22.2% coverage the quality ratchet measured came from unrelated suites that spawn the scheduler for a
// launch-profile assertion and happen to execute the entry lines. At CC 15 that scored CRAP 120.8 against
// a ceiling of 90 — one of the three rows holding the ship gate red. The reasons the gate returns
// ("0 In Review rows owned by pm to verify…", "0 non-blocked Backlog rows to groom") appeared nowhere in
// the test tree, so nothing would have noticed if a lane started skipping work it should do.
//
// run-agents.ts cannot be imported — main() runs unconditionally on load, deliberately (LOOP-58 deleted
// the import guard because a percent-encoded import.meta.url silently made `dev-loop run` a no-op). So
// the gate is exercised through its real entry point, with a fake claude binary standing in for the fire.
// `--dry-run` is NOT usable here: the skip line is printed only when `!opts.dryRun`, so a dry run reports
// none of the decisions this suite is about. `--no-daemon` is: the gate reads hub.db directly, and without
// it every case forks a board daemon that outlives the suite and trips run-all's leaked-daemon gate.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { tmpRoot } from "./tmp-root.ts";
import { scrubFireEnv } from "./env-scrub.ts";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = realpathSync(tmpRoot("dl-pmgate-"));
const NOW = "2026-09-01T00:00:00.000Z";

const fakeBin = join(ROOT, "fake.sh");
writeFileSync(fakeBin, "#!/bin/sh\necho ok\nexit 0\n");
spawnSync("chmod", ["+x", fakeBin]);

// One workspace per case: the gate reads the board, so the board IS the fixture.
const makeWs = (name: string, rows: Array<{ id: string; state: string; labels: string[] }>): string => {
  const ws = join(ROOT, name);
  const repo = join(ws, "repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "baseline"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  });
  writeFileSync(join(ws, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: `${name}-ws`,
    team: { key: "pmgate", backend: "service", mode: "live", autonomy: "ask" },
    repos: { repo: { path: "repo", landing: "direct" } },
    projects: { pmgate: { repos: [{ ref: "repo" }] } },
  }, null, 2));
  mkdirSync(join(ws, ".dev-loop", "locks"), { recursive: true });
  const db: DatabaseSync = openDb(join(ws, ".dev-loop", "hub.db"));
  ensureSeed(db, "pmgate", "pmgate", "PG");
  const pid = findProject(db, "pmgate")!;
  const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const r of rows) ins.run(r.id, pid, r.id, "", "Feature", r.state, 2, JSON.stringify(r.labels), "[]", "pm", NOW, NOW, null);
  db.close();
  return ws;
};

const fire = (ws: string, lane: string): string => {
  const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", lane, "--max-fires", "1", "--no-daemon"], {
    cwd: ws, encoding: "utf8", timeout: 120_000,
    env: { ...scrubFireEnv(), DEVLOOP_HOME: join(ROOT, "home"), DEVLOOP_CLAUDE_BIN: fakeBin },
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

// ── AC1: pm-maintenance with nothing to maintain ──────────────────────────────────────────────────
{
  const out = fire(makeWs("empty", []), "pm-maintenance");
  ok(/\[pm-maintenance\] skipped: nothing eligible for the pm-maintenance lane in 'pmgate'/.test(out),
    `AC1: an empty board skips the lane instead of firing a no-op (out: ${out.trim().slice(-200)})`);
  ok(/0 In Review rows owned by pm to verify, 0 decision-needed \/ scope-design \/ needs-pm rows to unblock/.test(out),
    `AC1: …and the reason states both counts it read, so the skip is auditable`);
}

// ── AC2: the verify branch ────────────────────────────────────────────────────────────────────────
// Ownership is by LABEL, not assignee — an In Review row labelled `pm` is pm's to verify.
{
  const out = fire(makeWs("verify", [{ id: "PG-1", state: "In Review", labels: ["pm"] }]), "pm-maintenance");
  ok(!/\[pm-maintenance\] skipped:/.test(out),
    `AC2: a pm-owned In Review row makes the lane fire rather than skip (out: ${out.trim().slice(-200)})`);
}

// ── AC3: the unblock branch ───────────────────────────────────────────────────────────────────────
{
  const out = fire(makeWs("unblock", [{ id: "PG-2", state: "Todo", labels: ["blocked", "decision-needed"] }]), "pm-maintenance");
  ok(!/\[pm-maintenance\] skipped:/.test(out),
    `AC3: a blocked+decision-needed row makes the lane fire (out: ${out.trim().slice(-200)})`);
}

// ── AC4: a label that is neither ──────────────────────────────────────────────────────────────────
// `blocked` ALONE is not pm's to unblock — the slice requires it to carry decision-needed or
// scope-design. Without this arm a gate that skipped the label check entirely would still pass AC1–AC3.
{
  const out = fire(makeWs("blockedonly", [{ id: "PG-3", state: "Todo", labels: ["blocked"] }]), "pm-maintenance");
  ok(/\[pm-maintenance\] skipped:/.test(out),
    `AC4: a bare 'blocked' row is not pm's to unblock, so the lane still skips (out: ${out.trim().slice(-200)})`);
}

// ── AC5: the groom lane reads a different slice ───────────────────────────────────────────────────
{
  const out = fire(makeWs("groom", []), "pm-groom");
  ok(/\[pm-groom\] skipped: nothing eligible for the pm-groom lane in 'pmgate' \(0 non-blocked Backlog rows to groom\)/.test(out),
    `AC5: an empty Backlog skips pm-groom with its own reason, not pm-maintenance's (out: ${out.trim().slice(-200)})`);
}
{
  const out = fire(makeWs("groomable", [{ id: "PG-4", state: "Backlog", labels: [] }]), "pm-groom");
  ok(!/\[pm-groom\] skipped: .*0 non-blocked Backlog rows/.test(out),
    `AC5: …and one groomable Backlog row is enough for the lane to fire (out: ${out.trim().slice(-200)})`);
}

console.log(fails === 0 ? "\nPM_LANE_GATE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
