// groom-capacity.ts — pm-groom does not re-scan a Backlog it can neither promote nor shape.
//
// Measured: four consecutive pm-groom fires reported `promoted 0`, the last of them reviewing all 34
// Backlog rows and finishing `groomed 0, 0 board writes`, while junior-dev sat at 16/10 over its Todo
// cap and senior-dev held no promotable candidate. The pm lane spent $11.47 in an hour — about 27% of
// all spend — on scans that were structurally incapable of producing anything.
//
// The existing queue-empty gate could not cover it: devTierQueueSkip short-circuits on
// `if (!isDevTierActor(agent)) return null` — pm/qa/architect/stewards are never gated there.
//
// The criterion is NOT "no promotion capacity". Job B2 has two outputs and only promotion needs
// capacity; the SKILL says "at/over the cap, groom only — still a valid fire", so gating on capacity
// alone would suppress work the job is defined to do. It is "no capacity AND nothing has changed since
// this lane last looked" — which is exactly the measured state, and which releases the moment a
// Backlog row is added or edited.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findProject } from "../src/seed.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { backlogFingerprint, servableBacklogDepth, servableTodoDepth } from "../src/servable.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-groom-")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const db = openDb(join(tmp, "hub.db"));
const PID = "p1";
db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)").run(PID, "gp", "n", "t");
let seq = 0;
const add = (state: string, tier: string, opts: { updated?: string } = {}): string => {
  const id = `GP-${++seq}`;
  db.prepare(
    "INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at)"
    + " VALUES(?,?,?,'','Feature',?,?,2,?,'[]','pm',?,?)",
  ).run(id, PID, `t-${id}`, state, tier, JSON.stringify(["dev-loop", tier]), `2026-08-29T10:00:${String(seq).padStart(2, "0")}Z`, opts.updated ?? `2026-08-29T10:00:${String(seq).padStart(2, "0")}Z`);
  return id;
};

try {
  // ── The fingerprint: it is about the rows Job B2 reads, and it moves when they do ────────────────
  {
    add("Backlog", "junior-dev");
    const fp1 = backlogFingerprint(db, PID);
    ok(/^1\|/.test(fp1), `the fingerprint carries the count of non-blocked Backlog rows (${fp1})`);
    const id = add("Backlog", "junior-dev");
    ok(backlogFingerprint(db, PID) !== fp1, "a NEW Backlog row moves it — there is something new to groom");
    const fp2 = backlogFingerprint(db, PID);
    db.prepare("UPDATE tickets SET updated_at=? WHERE id=?").run("2026-08-29T12:00:00Z", id);
    ok(backlogFingerprint(db, PID) !== fp2, "an EDITED Backlog row moves it — the lane's own grooming counts");
    const fp3 = backlogFingerprint(db, PID);
    ok(backlogFingerprint(db, PID) === fp3, "an untouched Backlog does not move it — this is the skip condition");
    // A blocked row is not groomable and must not hold the gate open forever.
    db.prepare("UPDATE tickets SET labels=? WHERE id=?").run(JSON.stringify(["dev-loop", "junior-dev", "blocked"]), id);
    ok(backlogFingerprint(db, PID) !== fp3 && /^1\|/.test(backlogFingerprint(db, PID)),
      `a blocked row leaves the counted set, exactly as servableBacklogDepth excludes it (${backlogFingerprint(db, PID)})`);
  }

  // ── Capacity: the inputs the gate reads agree with the board ─────────────────────────────────────
  {
    db.prepare("DELETE FROM tickets WHERE project_id=?").run(PID);
    seq = 0;
    for (let i = 0; i < 3; i++) add("Backlog", "junior-dev");
    for (let i = 0; i < 2; i++) add("Todo", "junior-dev");
    const backlog = servableBacklogDepth(db, PID);
    const depth = servableTodoDepth(db, PID);
    ok(backlog["junior-dev"] === 3, `the Backlog candidates are counted per tier (${backlog["junior-dev"]})`);
    ok(depth["junior-dev"] === 2, `the Todo depth is the cap input (${depth["junior-dev"]})`);
    ok(backlog["senior-dev"] === 0,
      "a tier with no candidate has none — promoting into it is impossible whatever its depth, which is why the gate checks candidates too");
  }
  db.close();

  // ── The decision itself, on a REAL scheduler ────────────────────────────────────────────────────
  // The arms above measure the gate's inputs; this measures what the gate DOES, which is the part the
  // incident was about. A fake coding agent makes each fire free.
  {
    const ws = join(tmp, "ws");
    mkdirSync(join(ws, "repo"), { recursive: true });
    const env = { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") } as NodeJS.ProcessEnv;
    const cli = (args: string[], cwd = ws) => spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env });
    ok(cli(["team", "init", "--dir", ws, "--key", "gc", "--backend", "service", "--yes"], tmp).status === 0, "e2e fixture: team init");
    ok(cli(["team", "add-project", "gcp", "--prefix", "GC"]).status === 0, "e2e fixture: add-project");
    spawnSync("git", ["init", "-q", "-b", "main", join(ws, "repo")]);
    spawnSync("git", ["-C", join(ws, "repo"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"]);
    ok(cli(["team", "add-repo", "r", "--project", "gcp", "--path", "repo", "--role", "primary"]).status === 0, "e2e fixture: add-repo");
    // A cap of 1 with two Todo rows: over the cap, cheaply.
    const cfgPath = join(ws, "dev-loop.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    cfg.projects.gcp.intake = { todoDepthCap: 1 };
    // A lane key is not accepted by `--interval` (AGENT_SET holds actors), so the cadence is set
    // in config, which applyConfigCadence reads for lanes too.
    cfg.team.agents = { "pm-groom": { cadence: "1s" } } as Record<string, unknown>;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    const wdb = openDb(join(ws, ".dev-loop", "hub.db"));
    const pid = findProject(wdb, "gcp")!;
    const put = (id: string, state: string) => wdb.prepare(
      "INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at)"
      + " VALUES(?,?,?,'','Feature',?, 'junior-dev',2,?,'[]','pm',?,?)",
    ).run(id, pid, `t-${id}`, state, JSON.stringify(["dev-loop", "junior-dev"]), "2026-08-29T10:00:00Z", "2026-08-29T10:00:00Z");
    put("GC-1", "Backlog"); put("GC-2", "Todo"); put("GC-3", "Todo");
    wdb.close();

    const fakeBin = join(tmp, "fake.sh");
    writeFileSync(fakeBin, "#!/bin/sh\necho fake\nexit 0\n");
    chmodSync(fakeBin, 0o755);
    const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
    const fires = (): number => { try { return readFileSync(ledger, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

    let out = "";
    const child = spawn(process.execPath,
      [join(hubRoot, "src", "run-agents.ts"), "--no-daemon", "--agents", "pm-groom", "--stagger", "0"],
      { cwd: ws, env: { ...env, DEVLOOP_CLAUDE_BIN: fakeBin }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d: Buffer) => { out += String(d); });
    child.stderr!.on("data", (d: Buffer) => { out += String(d); });
    try {
      await sleep(9_000);
      // One look after boot is deliberate — the lane has not seen this Backlog yet. Then it stops.
      ok(fires() <= 1, `over the cap, the lane looks at most ONCE and then stops re-scanning (${fires()} fires)`);
      ok(/\[pm-groom\] skipped: .*at\/over the Todo cap of 1/.test(out),
        `…and says why, naming the cap and the depth (${out.split("\n").find((l) => /pm-groom\] skipped/.test(l))?.slice(0, 150) ?? "no skip line"})`);
      ok(/unchanged since this lane last groomed it/.test(out),
        "…and that the Backlog has not moved since it last looked — capacity alone is not the reason");

      // New Backlog work releases it: the fingerprint moves, so there is something to groom again.
      const before = fires();
      const wdb2 = openDb(join(ws, ".dev-loop", "hub.db"));
      wdb2.prepare(
        "INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at)"
        + " VALUES('GC-9',?,'new work','','Feature','Backlog','junior-dev',2,?,'[]','pm',?,?)",
      ).run(pid, JSON.stringify(["dev-loop", "junior-dev"]), new Date().toISOString(), new Date().toISOString());
      wdb2.close();
      const until = Date.now() + 20_000;
      while (Date.now() < until && fires() === before) await sleep(200);
      ok(fires() > before,
        `a NEW Backlog row releases the gate even while over the cap — grooming is still valid work (${before} → ${fires()})`);
    } finally { if (child.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } } }
  }
} finally {
  try { db.close(); } catch { /* already closed */ }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nGROOM_CAPACITY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
