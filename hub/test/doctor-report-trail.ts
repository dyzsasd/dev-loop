// doctor-report-trail.ts — W35 reads the WORKSPACE reports tree, under the RUNTIME handle name.
//
// Measured on a live workspace: `dev-loop doctor` reported 8 agents as "fired Nx but wrote no report
// under ~/.dev-loop/<key>/reports/<handle>-agent/daily" while every one of those reports sat in
// <ws>/.dev-loop/<key>/reports/<handle>/daily. One message, two independent defects:
//
//   root — checkReportTrail already holds `ws` and still resolved the root from the environment
//          (DEVLOOP_REPORTS_DIR > DEVLOOP_DATA_DIR > DEVLOOP_HUB_DB-derived > the home default).
//          A CLI `dev-loop doctor` sets none of those, so the root landed on the home default while
//          the ledger beside it came from wsFireLedger(ws). The two halves of the check read
//          different machines' worth of state.
//   name — the check expected `<handle>-agent/`, the segment §22 prose specified; every fire writes
//          `<handle>/`, the identity the runtime hands the agent (DEVLOOP_ACTOR=pm). 8 of 8 agents
//          wrote the runtime name, so the runtime name is the contract and the prose was corrected.
//
// Each arm below fails on ONE of those two defects, so neither fix can regress under the other.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { checkReportTrail } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { wsStateRoot } from "../src/workspace.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-w35-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const KEY = "browser-use";
const TODAY = new Date().toISOString().slice(0, 10);
const HOUR = 3_600_000;
const fireRow = (agent: string, project: string) =>
  JSON.stringify({ ts: new Date(Date.now() - HOUR).toISOString(), agent, project, fireId: `${agent}-1`, exitCode: 0 });

// A machine-global home that MUST NOT be consulted: every arm plants the decoy there.
const HOME = join(tmp, "home");
const ENV_KEYS = ["DEVLOOP_HOME", "DEVLOOP_REPORTS_DIR", "DEVLOOP_DATA_DIR", "DEVLOOP_HUB_DB"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/** A workspace with one delivery project, one team-scoped fire and one project-scoped fire. */
function fixture(name: string): ReturnType<typeof loadWorkspace> {
  const root = join(tmp, name);
  mkdirSync(join(root, ".dev-loop", "team"), { recursive: true });
  writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "w35", backend: "service" },
    repos: {},
    projects: { [KEY]: { prefix: "BU" } },
  }));
  writeFileSync(join(root, ".dev-loop", "team", "fires.jsonl"),
    [fireRow("pm", KEY), fireRow("reflect", "_team"), fireRow("ops", "_team"), fireRow("sweep", "_team")].join("\n") + "\n");
  return loadWorkspace(root);
}

const warnings = (ws: ReturnType<typeof loadWorkspace>): string[] => {
  const out: string[] = [];
  checkReportTrail(ws, (m) => out.push(m));
  return out;
};
const w35For = (lines: string[], agent: string): string[] =>
  lines.filter((l) => l.includes("[W35]") && l.includes(`agent '${agent}'`));

try {
  process.env.DEVLOOP_HOME = HOME;
  for (const k of ["DEVLOOP_REPORTS_DIR", "DEVLOOP_DATA_DIR", "DEVLOOP_HUB_DB"]) delete process.env[k];

  // ── Arm 1: the report the runtime actually writes clears the check ──────────────────────────
  // <ws>/.dev-loop/<key>/reports/<handle>/daily/<today>.md — the path a fire composes from
  // DEVLOOP_DATA_DIR=<ws>/.dev-loop and DEVLOOP_ACTOR=<handle>.
  {
    const ws = fixture("written");
    mkdirSync(join(wsStateRoot(ws), KEY, "reports", "pm", "daily"), { recursive: true });
    writeFileSync(join(wsStateRoot(ws), KEY, "reports", "pm", "daily", `${TODAY}.md`), "# pm\n");
    mkdirSync(join(wsStateRoot(ws), "_team", "reports", "reflect", "daily"), { recursive: true });
    writeFileSync(join(wsStateRoot(ws), "_team", "reports", "reflect", "daily", `${TODAY}.md`), "# reflect\n");

    const lines = warnings(ws);
    ok(w35For(lines, "pm").length === 0,
      `project scope: a report at <ws>/.dev-loop/${KEY}/reports/pm/daily clears W35 (got ${JSON.stringify(lines)})`);
    ok(w35For(lines, "reflect").length === 0,
      `team scope: a report at <ws>/.dev-loop/_team/reports/reflect/daily clears W35 (got ${JSON.stringify(lines)})`);
  }

  // ── Arm 1b: a STEWARD lane is ledgered `_team` but reports where its state lives ─────────────
  // ops keeps `ops-state.json` in the project dir and writes its daily report beside it, under the
  // PROJECT scope. Checking only `_team` reported ops as having left no trail while two daily reports
  // sat in `<project>/reports/ops/daily` — a false warning that an operator can only silence by
  // writing a report where the runtime does not put one. sweep in the same fixture writes nowhere,
  // and must still be reported: widening the search must not blind the check.
  {
    const ws = fixture("steward-project-scope");
    mkdirSync(join(wsStateRoot(ws), KEY, "reports", "ops", "daily"), { recursive: true });
    writeFileSync(join(wsStateRoot(ws), KEY, "reports", "ops", "daily", `${TODAY}.md`), "# ops\n");

    const lines = warnings(ws);
    ok(w35For(lines, "ops").length === 0,
      `steward: a team-scoped ops fire is cleared by a report under the PROJECT scope (got ${JSON.stringify(w35For(lines, "ops"))})`);
    ok(w35For(lines, "sweep").length === 1,
      `steward: sweep wrote nothing anywhere and is still reported — the widened search is not a blanket pass (got ${JSON.stringify(w35For(lines, "sweep"))})`);
    ok(w35For(lines, "sweep")[0]?.includes(join(wsStateRoot(ws), "_team", "reports", "sweep", "daily")),
      `steward: the finding still names the TEAM root as the expected place (got ${w35For(lines, "sweep")[0]})`);
  }

  // ── Arm 2: the ROOT — a report in the home-anchored tree does not clear the check ───────────
  // The decoy is planted under the exact directory name the pre-fix check looked for, so this arm
  // isolates the root: only a check that stopped reading ~/.dev-loop can raise W35 here.
  {
    const ws = fixture("decoy-root");
    mkdirSync(join(HOME, KEY, "reports", "pm-agent", "daily"), { recursive: true });
    writeFileSync(join(HOME, KEY, "reports", "pm-agent", "daily", `${TODAY}.md`), "# decoy\n");
    mkdirSync(join(HOME, KEY, "reports", "pm", "daily"), { recursive: true });
    writeFileSync(join(HOME, KEY, "reports", "pm", "daily", `${TODAY}.md`), "# decoy\n");

    const pm = w35For(warnings(ws), "pm");
    ok(pm.length === 1, `root: a report that exists ONLY under the home anchor still raises W35 (got ${JSON.stringify(pm)})`);
    ok(pm[0]?.includes(join(wsStateRoot(ws), KEY, "reports", "pm", "daily")),
      `root: the message names the WORKSPACE path it looked in (got ${pm[0]})`);
    ok(!pm[0]?.includes(join(HOME, KEY, "reports")), `root: the message names no home-anchored path (got ${pm[0]})`);
  }

  // ── Arm 3: the NAME — the `<handle>-agent` directory is not where the runtime writes ────────
  // Same workspace root as arm 1, only the directory segment differs. This arm isolates the name.
  {
    const ws = fixture("suffixed-name");
    mkdirSync(join(wsStateRoot(ws), KEY, "reports", "pm-agent", "daily"), { recursive: true });
    writeFileSync(join(wsStateRoot(ws), KEY, "reports", "pm-agent", "daily", `${TODAY}.md`), "# pm\n");

    const pm = w35For(warnings(ws), "pm");
    ok(pm.length === 1, `name: a report under <handle>-agent/ does not clear W35 (got ${JSON.stringify(pm)})`);
    ok(pm[0]?.includes(join("reports", "pm", "daily")),
      `name: the expected directory is the runtime handle, with no '-agent' suffix (got ${pm[0]})`);
  }

  // ── Arm 4: no report anywhere is still the finding, on both scopes ──────────────────────────
  {
    const lines = warnings(fixture("silent"));
    ok(w35For(lines, "pm").length === 1, "a fire with no report anywhere raises W35 on the project scope");
    ok(w35For(lines, "reflect").length === 1, "…and on the team scope");
  }
} finally {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nDOCTOR_REPORT_TRAIL_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
