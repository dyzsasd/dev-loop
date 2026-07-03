// run-agents team mode + locks: WRR plan, --project filter, enabled/weight exclusion, fires.jsonl ledger,
// the team run lock, and with-repo-lock serialization.
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "../src/locks.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-sched-")));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, DEVLOOP_HOME: HOME, ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const runAgents = (args: string[], cwd: string, extra: Record<string, string> = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), ...args], { cwd, env: env(extra), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
// Only the numbered plan rows ("  1  pm → alpha"), never the header line (which also contains →).
const planLines = (out: string) => out.split("\n").filter((l) => /^\s*\d+\s+\S+\s*→/.test(l)).map((l) => l.split("→")[1].trim());

(async () => {
try {
  // ── fixture: workspace with alpha(w2) + beta(w1), both with a repo ──
  const ws = join(tmp, "ws");
  team(["init", "--dir", ws, "--key", "sched-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
  mkdirSync(join(ws, "ra"), { recursive: true }); mkdirSync(join(ws, "rb"), { recursive: true });
  team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "2"], ws);
  team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);
  team(["add-project", "beta", "--linear-project", "Beta", "--weight", "1"], ws);
  team(["add-repo", "rb", "--project", "beta", "--path", "rb", "--role", "primary"], ws);

  // ── --plan prints the exact 2:1 WRR sequence ──
  const plan = runAgents(["--agents", "pm", "--plan", "6"], ws);
  ok(plan.code === 0 && planLines(plan.out).join(" ") === "alpha beta alpha alpha beta alpha", "--plan 6 prints the exact 2:1 WRR sequence");
  ok(!existsSync(join(ws, ".dev-loop", "team", "scheduler.json")), "--plan does NOT persist the cursor (preview only)");

  // ── --project filter restricts rotation to one project ──
  const filtered = runAgents(["--agents", "pm", "--project", "alpha", "--plan", "3"], ws);
  ok(planLines(filtered.out).join(" ") === "alpha alpha alpha", "--project filters rotation to a single project");

  // ── enabled:false / weight:0 exclusion ──
  const cfgPath = join(ws, "dev-loop.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.projects.beta.enabled = false;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(planLines(runAgents(["--agents", "pm", "--plan", "3"], ws).out).join(" ") === "alpha alpha alpha", "enabled:false excludes a project from rotation");
  cfg.projects.beta.enabled = true; cfg.projects.beta.weight = 0;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(planLines(runAgents(["--agents", "pm", "--plan", "2"], ws).out).join(" ") === "alpha alpha", "weight:0 excludes a project from rotation");
  // all disabled → hard error
  cfg.projects.alpha.enabled = false; cfg.projects.beta.enabled = false;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(runAgents(["--agents", "pm", "--plan", "2"], ws).code !== 0, "all-disabled team → run refuses (exit ≠ 0)");
  // restore
  cfg.projects.alpha.enabled = true; cfg.projects.beta.enabled = true; cfg.projects.beta.weight = 1;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // ── fires.jsonl ledger: a real --once fire (fake CLI bin) appends a row on BOTH backends ──
  const fakeBin = join(tmp, "fake-claude.sh");
  writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n"); chmodSync(fakeBin, 0o755);
  const once = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: fakeBin });
  const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
  ok(once.code === 0 && existsSync(ledger), "--once with a fake CLI fires and writes the fires.jsonl ledger");
  const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(rows.length >= 1 && rows[0].agent === "pm" && ["alpha", "beta"].includes(rows[0].project) && rows[0].exitCode === 0, "ledger row carries agent/project/exitCode (backend-agnostic soak metric)");

  // ── regression: a shell-exported CLAUDE_CODE_EFFORT_LEVEL must NOT leak into agent fires (it would
  //    override the per-agent --effort; precedence is env > --effort > model default). The scheduler strips it.
  const effProbe = join(tmp, "eff-probe.sh");
  const effOut = join(tmp, "eff-seen.txt");
  writeFileSync(effProbe, `#!/bin/sh\necho "\${CLAUDE_CODE_EFFORT_LEVEL:-UNSET}" > ${effOut}\nexit 0\n`); chmodSync(effProbe, 0o755);
  runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: effProbe, CLAUDE_CODE_EFFORT_LEVEL: "low" });
  ok(readFileSync(effOut, "utf8").trim() === "UNSET", "an exported CLAUDE_CODE_EFFORT_LEVEL is stripped from agent fires (per-agent --effort stays authoritative)");

  // ── steward vs delivery fire scope (M4): sweep fires at the workspace ROOT; pm fires in a repo ──
  const stewardDry = runAgents(["--agents", "sweep", "--once", "--dry-run"], ws);
  ok(stewardDry.out.includes(`sweep: cwd=${ws} `), "a steward (sweep) fires with cwd = the workspace ROOT (team scope)");
  const deliveryDry = runAgents(["--agents", "pm", "--once", "--dry-run"], ws);
  ok(/pm: cwd=\S+\/(ra|rb) /.test(deliveryDry.out), "a delivery agent (pm) fires with cwd = a project repo (rotation)");

  // ── team run lock: a live holder blocks a second scheduler ──
  const lockPath = join(ws, ".dev-loop", "locks", "run.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, team: "sched-team", startedAt: new Date().toISOString() })); // THIS process = a live holder
  const blocked = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--max-fires", "1"], { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: fakeBin }), encoding: "utf8", timeout: 8000 });
  ok((blocked.status ?? 1) !== 0 && /already running/.test(`${blocked.stdout}${blocked.stderr}`), "a second scheduler refuses while a live run lock is held");
  rmSync(lockPath, { force: true });

  // ── locks.ts: second acquire throws within the deadline, succeeds after release ──
  const lp = join(tmp, "unit.lock");
  const rel = await acquireLock(lp, { totalMs: 1000 });
  let threw = false;
  try { await acquireLock(lp, { totalMs: 300 }); } catch { threw = true; }
  ok(threw, "acquireLock: a second acquire throws while a live holder holds it");
  rel();
  const rel2 = await acquireLock(lp, { totalMs: 300 });
  ok(true, "acquireLock: succeeds after the holder releases");
  rel2();

  // ── with-repo-lock serializes concurrent base-clone mutations on a shared repo (must not interleave) ──
  const wrl = join(hubRoot, "src", "with-repo-lock.ts");
  const marker = join(tmp, "wrl.log");
  writeFileSync(marker, "");
  const pA = spawn("node", [wrl, "ra", "--", "sh", "-c", `echo A-in >> ${marker}; sleep 0.6; echo A-out >> ${marker}`], { cwd: ws, env: env(), stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 120));
  const pB = spawn("node", [wrl, "ra", "--wait", "10s", "--", "sh", "-c", `echo B-in >> ${marker}; echo B-out >> ${marker}`], { cwd: ws, env: env(), stdio: "ignore" });
  await Promise.all([new Promise((r) => pA.on("exit", r)), new Promise((r) => pB.on("exit", r))]);
  const seq = readFileSync(marker, "utf8").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  ok(seq.join(",") === "A-in,A-out,B-in,B-out", `with-repo-lock serializes concurrent holders (got: ${seq.join(",")})`);

  console.log(fails === 0 ? "\nTEAM_SCHEDULER_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
})();
