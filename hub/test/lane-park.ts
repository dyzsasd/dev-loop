// lane-park.ts — a lane parked in config does not fire, and says so.
//
// Measured 2026-08-29: an operator set `projects.browser-use.agents.senior-dev.manual: true` at ~15:30Z
// to stop a lane that was burning $1.42 every 5 minutes doing nothing. It fired again at 15:41:03Z for
// $3.91, and run.log carried no skip line — nothing explained the switch had no effect.
//
// It had none because there was none: `manual` did not occur ANYWHERE in run-agents.ts. Its only
// readers were doctor's W16 and the metrics sibling, where it downgrades an owner-liveness warning.
// The other routes were closed too — E17 refuses a project-scope `cadence` outright ("not honoured in
// team mode") and refuses `cadence: 0` as "a hot loop, not a disable" — so dev-loop had no per-lane
// off switch at all, while doctor's own W16 remedy told operators to use `manual` as one.
//
// Two keys now, because the operator has two intents and merging them is what cost the liveness
// warning: `enabled:false` parks the lane and LEAVES W16 warning (a parked lane still strands
// tickets); `manual:true` says a human runs the role, so the scheduler skips it AND W16 downgrades.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { laneScheduleBlock, loadWorkspace, validateTeamFile } from "../src/team-config.ts";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
const tmp = realpathSync(tmpRoot("dl-lanepark-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ws = join(tmp, "ws");
const cfgPath = join(ws, "dev-loop.json");
const env = { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") } as NodeJS.ProcessEnv;
const cli = (args: string[], cwd = ws) => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const editCfg = (mutate: (c: Record<string, Record<string, unknown>>) => void) => {
  const c = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, Record<string, unknown>>;
  mutate(c);
  writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ledger = () => join(ws, ".dev-loop", "team", "fires.jsonl");
/** Fires per agent, off the LEDGER — the record, not a log line about it. */
const firesOf = (agent: string): number => {
  try {
    return readFileSync(ledger(), "utf8").split("\n").filter(Boolean)
      .filter((l) => { try { return (JSON.parse(l) as { agent?: string }).agent === agent; } catch { return false; } }).length;
  } catch { return 0; }
};

let out = "";
async function waitFor(pred: () => boolean, label: string, ms = 45_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(200); }
  console.log(`   (timed out waiting for ${label}; tail: ${out.slice(-400).replace(/\n/g, " | ")})`);
  return false;
}

let child: ReturnType<typeof spawn> | null = null;
try {
  mkdirSync(join(ws, "repo"), { recursive: true });
  ok(cli(["team", "init", "--dir", ws, "--key", "lp", "--backend", "service", "--yes"], tmp).code === 0, "fixture: team init");
  ok(cli(["team", "add-project", "lpp", "--prefix", "LP"]).code === 0, "fixture: add-project");
  spawnSync("git", ["init", "-q", "-b", "main", join(ws, "repo")]);
  spawnSync("git", ["-C", join(ws, "repo"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"]);
  ok(cli(["team", "add-repo", "r", "--project", "lpp", "--path", "repo", "--role", "primary"]).code === 0, "fixture: add-repo");

  // ── The resolver, on its own — both keys, both scopes, and the actor fallback ────────────────────
  {
    editCfg((c) => {
      c.team.agents = { sweep: { enabled: false }, ops: { manual: true } };
      (c.projects.lpp as Record<string, unknown>).agents = { "senior-dev": { enabled: false } };
    });
    const w = loadWorkspace(ws);
    ok(laneScheduleBlock(w, "sweep")?.reason.includes("enabled is false") === true, "team scope: enabled:false parks the lane");
    ok(laneScheduleBlock(w, "ops")?.reason.includes("manual is true") === true, "team scope: manual:true parks it too, as a human-run role");
    ok(laneScheduleBlock(w, "pm") === null, "a lane with no switch is not parked");
    ok(laneScheduleBlock(w, "senior-dev") === null, "a PROJECT-scope park is not a team-scope park");
    ok(laneScheduleBlock(w, "senior-dev", "lpp")?.reason.includes("enabled is false") === true, "…and resolves when the project is named");
    // The actor fallback: parking `pm` parks its lanes, and a lane key parks only itself.
    editCfg((c) => { c.team.agents = { pm: { enabled: false }, "qa-hunt": { enabled: false } }; });
    const w2 = loadWorkspace(ws);
    ok(laneScheduleBlock(w2, "pm-groom")?.key === "pm", "parking the ACTOR parks its lanes (pm ⇒ pm-groom)");
    ok(laneScheduleBlock(w2, "qa-hunt")?.key === "qa-hunt", "parking a LANE key parks that lane");
    ok(laneScheduleBlock(w2, "qa-maintenance") === null, "…and only that lane — its sibling still runs");
    const { errors } = validateTeamFile({ schemaVersion: 2, team: { key: "x", backend: "service", agents: { sweep: { enabled: "no" } } }, repos: {}, projects: {} });
    ok(errors.some((e) => e.code === "E17" && /enabled/.test(e.path)),
      `a non-boolean switch is refused by E17, never silently accepted (${JSON.stringify(errors.map((e) => e.path))})`);
    // A steward fires at team scope, so a project-scope park could only be accepted and ignored — the
    // exact class this whole defect belongs to. Refused, like project-scope `cadence` already is.
    const stew = validateTeamFile({ schemaVersion: 2, team: { key: "x", backend: "service" }, repos: {}, projects: { p: { prefix: "P", agents: { sweep: { manual: true } } } } });
    ok(stew.errors.some((e) => e.code === "E17" && /sweep\.manual/.test(e.path) && /not honoured/.test(e.message)),
      `a project-scope park on a STEWARD is refused, not ignored (${JSON.stringify(stew.errors.map((e) => e.path))})`);
  }

  // ── End to end: the operator's exact shape — a PROJECT-scope park on a dev tier ─────────────────
  // senior-dev, not a steward: stewards fire at team scope and their project-scope park is an E17
  // refusal (above). It gets a real servable Todo first, so "zero fires" cannot pass because the lane
  // had nothing to do — that trap is how a sibling suite passed for the wrong reason earlier today.
  {
    const db = openDb(join(ws, ".dev-loop", "hub.db"));
    try {
      const pid = findProject(db, "lpp")!;
      db.prepare(
        "INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at)"
        + " VALUES('LP-1',?,'work','## Context\nplain work','Feature','Todo','senior-dev',2,?,'[]','pm',?,?)",
      ).run(pid, JSON.stringify(["dev-loop", "senior-dev"]), new Date().toISOString(), new Date().toISOString());
    } finally { db.close(); }

    const fakeBin = join(tmp, "fake-claude.sh");
    writeFileSync(fakeBin, "#!/bin/sh\necho 'fake fire: nothing to do'\nexit 0\n");
    chmodSync(fakeBin, 0o755);
    editCfg((c) => { c.team.agents = {}; (c.projects.lpp as Record<string, unknown>).agents = {}; });

    child = spawn(process.execPath,
      [join(hubRoot, "src", "run-agents.ts"), "--no-daemon", "--agents", "senior-dev", "--interval", "senior-dev=1s", "--stagger", "0"],
      { cwd: ws, env: { ...env, DEVLOOP_CLAUDE_BIN: fakeBin }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d: Buffer) => { out += String(d); });
    child.stderr!.on("data", (d: Buffer) => { out += String(d); });

    ok(await waitFor(() => firesOf("senior-dev") >= 2, "the lane's fires before any park"),
      "the lane fires normally UNPARKED — the control, and proof it has work to do");

    // Park it mid-run, the way the operator did.
    const atPark = firesOf("senior-dev");
    const marked = out.length;
    editCfg((c) => { (c.projects.lpp as Record<string, unknown>).agents = { "senior-dev": { manual: true } }; });
    await sleep(6_000); // many ticks at a 1s cadence
    ok(firesOf("senior-dev") === atPark,
      `the parked lane fired ZERO times after the switch (${atPark} before, ${firesOf("senior-dev")} after)`);
    ok(/\[senior-dev\] skipped: projects\.lpp\.agents\.senior-dev\.manual is true/.test(out.slice(marked)),
      `…and each attempt says why, naming the key and its scope (${out.slice(marked).split("\n").find((l) => /skipped/.test(l))?.slice(0, 130) ?? "no skip line"})`);

    // Un-parking takes effect on the next tick — the hot reload carries the config edit.
    const before = firesOf("senior-dev");
    editCfg((c) => { (c.projects.lpp as Record<string, unknown>).agents = {}; });
    ok(await waitFor(() => firesOf("senior-dev") > before, "a fire after un-parking"),
      `removing the switch resumes the lane without a restart (${before} → ${firesOf("senior-dev")})`);
  }

} finally {
  if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ } }
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
}

ok(!existsSync(tmp), "fixture: the temp workspace is removed");
console.log(fails === 0 ? "\nLANE_PARK_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
