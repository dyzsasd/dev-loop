// human-blocked-off.ts — `team.humanBlocked:"off"` removes the parking place, not the state.
//
// `autonomy` decides how boldly an agent decides; `humanBlocked` decides whether there is still
// anybody to wait for. They are orthogonal, and `ask` + `off` is a legal pair: PM decides cautiously,
// by itself. What `off` changes is who may put a ticket into `Human-Blocked` and who may take it out.
//
// The state itself never goes away — `db.ts`'s State union is untouched and tickets already parked are
// left exactly where they are, because automatically rewriting a parking decision somebody already
// made is worse than leaving a visible to-do. Doctor says so in a line instead.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { effectiveProject, loadWorkspace, validateTeamFile } from "../src/team-config.ts";
import { findProject } from "../src/seed.ts";
import { rulingCommentPolicy, updateTicketRow } from "../src/ticketwrite.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
const tmp = realpathSync(tmpRoot("dl-hbo-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ws = join(tmp, "ws");
const cfgPath = join(ws, "dev-loop.json");
const env = { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), DEVLOOP_WORKSPACE: ws } as NodeJS.ProcessEnv;
// The IN-PROCESS arms below call the write layer directly, and its config resolvers use the same
// ambient workspace discovery landingContextFor and acGateEnabled use. Point this process at the
// fixture so those arms resolve the fixture's config rather than whatever is above cwd.
process.env.DEVLOOP_WORKSPACE = ws;
const cli = (args: string[], cwd = ws) => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const setMode = (mode: "on" | "off") => {
  const c = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, Record<string, unknown>>;
  c.team.humanBlocked = mode;
  writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n");
};
/** A ticket in a known state, written straight to the board: this is about the GATE, not the op API. */
const seedTicket = (id: string, state: string) => {
  const db = openDb(join(ws, ".dev-loop", "hub.db"));
  try {
    const pid = findProject(db, "hp")!;
    db.prepare("DELETE FROM tickets WHERE id=?").run(id);
    db.prepare(
      "INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at)"
      + " VALUES(?,?,?,?,?,0,'[]','[]','pm',?,?)",
    ).run(id, pid, `work ${id}`, state, "junior-dev", new Date().toISOString(), new Date().toISOString());
  } finally { db.close(); }
};
/** The stored row, as updateTicketRow wants it, with only `state` changed. */
const moveTo = (db: ReturnType<typeof openDb>, pid: string, id: string, actor: string, state: string) => {
  const row = db.prepare("SELECT title,description,type,state,assignee,priority,labels,duplicate_of,related_to,waiting_on FROM tickets WHERE id=? AND project_id=?")
    .get(id, pid) as { title: string; description: string; type: string; state: string; assignee: string | null; priority: number; labels: string; duplicate_of: string | null; related_to: string; waiting_on: string | null };
  return updateTicketRow(db, pid, actor, id, row.state, { ...row, state });
};

const withDb = <T>(fn: (db: ReturnType<typeof openDb>, pid: string) => T): T => {
  const db = openDb(join(ws, ".dev-loop", "hub.db"));
  try { return fn(db, findProject(db, "hp")!); } finally { db.close(); }
};

try {
  mkdirSync(ws, { recursive: true });
  ok(cli(["team", "init", "--dir", ws, "--key", "hbo", "--backend", "service", "--yes"], tmp).code === 0, "fixture: team init");
  ok(cli(["team", "add-project", "hp", "--prefix", "HP"]).code === 0, "fixture: add-project");

  // ── Config surface: default, settable, validated ────────────────────────────────────────────────
  {
    ok(effectiveProject(loadWorkspace(ws), "hp").humanBlocked === "on",
      "absent config resolves to \"on\" — today's behaviour, byte for byte");
    const set = cli(["team", "set", "team.humanBlocked", "off"]);
    ok(set.code === 0, `team set team.humanBlocked off is accepted (${set.code}) ${set.out.slice(-140)}`);
    ok(effectiveProject(loadWorkspace(ws), "hp").humanBlocked === "off", "…and the project resolves it through the team default");
    const bad = cli(["team", "set", "team.humanBlocked", "maybe"]);
    ok(bad.code !== 0, `a value outside on|off is refused by the settable surface (${bad.code})`);
    const { errors } = validateTeamFile({ schemaVersion: 2, team: { key: "x", backend: "service", humanBlocked: "maybe" }, repos: {}, projects: {} });
    ok(errors.some((e) => e.code === "E19" && /humanBlocked/.test(e.path)),
      `…and by the schema, as the same E19 governance-token class as mode/autonomy (${JSON.stringify(errors.map((e) => `${e.code}:${e.path}`))})`);
    // A project override, so one project can keep its parking place while a sibling drops it.
    const c = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    c.projects.hp.humanBlocked = "on";
    writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n");
    ok(effectiveProject(loadWorkspace(ws), "hp").humanBlocked === "on", "a project override beats the team default");
    delete c.projects.hp.humanBlocked;
    writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n");
  }

  // ── "off": an agent may not park, the operator still may ────────────────────────────────────────
  {
    setMode("off");
    seedTicket("HP-1", "In Progress");
    const refused = withDb((db, pid) => moveTo(db, pid, "HP-1", "junior-dev", "Human-Blocked"));
    ok(refused.ok === false && /humanBlocked:"off"/.test(refused.error ?? ""),
      `an agent moving a ticket INTO Human-Blocked is refused (${JSON.stringify(refused).slice(0, 160)})`);
    ok(/Backlog \+ blocked/.test(refused.ok === false ? refused.error : ""),
      "…and the refusal names the one shape that still waits: an external prerequisite at Backlog + blocked + its labels");
    ok(withDb((db) => (db.prepare("SELECT state FROM tickets WHERE id='HP-1'").get() as { state: string }).state) === "In Progress",
      "…and nothing was written — the ticket is where it was");

    const byOperator = withDb((db, pid) => moveTo(db, pid, "HP-1", "operator", "Human-Blocked"));
    ok(byOperator.ok === true, `the operator parking a ticket for themselves is never gated (${JSON.stringify(byOperator).slice(0, 120)})`);
  }

  // ── "off": pm may record the ruling that replaces the park; other agents may not ────────────────
  {
    const body = 'Ruling: approve — the strategy doc already answers this; no human input is needed.';
    const pm = withDb((db, pid) => rulingCommentPolicy(db, "pm", body, { projectId: pid }));
    ok(pm.status === 200 && pm.ruling !== null, `pm may post a Ruling while the project is "off" (${pm.status}: ${pm.error ?? "ok"})`);
    const qa = withDb((db, pid) => rulingCommentPolicy(db, "qa", body, { projectId: pid }));
    ok(qa.status === 403, `…and only pm — every other agent identity is still refused (qa: ${qa.status})`);
  }

  // ── "on": the pre-change behaviour, byte for byte ────────────────────────────────────────────────
  {
    setMode("on");
    seedTicket("HP-2", "In Progress");
    const parked = withDb((db, pid) => moveTo(db, pid, "HP-2", "junior-dev", "Human-Blocked"));
    ok(parked.ok === true, `with "on" an agent parks exactly as before (${JSON.stringify(parked).slice(0, 120)})`);
    const pm = withDb((db, pid) => rulingCommentPolicy(db, "pm", 'Ruling: approve — because.', { projectId: pid }));
    ok(pm.status === 403, `…and pm may NOT rule: the operator is the one who decides here (${pm.status})`);
  }

  // ── Existing parked tickets are left alone, and doctor says so ───────────────────────────────────
  {
    setMode("off");
    const before = withDb((db) => (db.prepare("SELECT state FROM tickets WHERE id='HP-2'").get() as { state: string }).state);
    ok(before === "Human-Blocked", "a ticket parked before the switch is still parked — nothing is migrated");
    const d = cli(["doctor"]);
    ok(/humanBlocked:"off"/.test(d.out) && /HP-2/.test(d.out),
      `doctor lists it as informational, naming the ticket (${d.out.split("\n").find((l) => /humanBlocked/.test(l))?.slice(0, 160) ?? "no line"})`);
    ok(!/\[W20\]/.test(d.out), `…and does NOT raise W20 for a project whose queue nobody is coming for (${/\[W20\][^\n]*/.exec(d.out)?.[0] ?? ""})`);
  }

  // ── Every fire is told the posture ───────────────────────────────────────────────────────────────
  {
    mkdirSync(join(ws, "repo"), { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", join(ws, "repo")]);
    spawnSync("git", ["-C", join(ws, "repo"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"]);
    cli(["team", "add-repo", "r", "--project", "hp", "--path", "repo", "--role", "primary"]);
    const r = spawnSync(process.execPath, [join(hubRoot, "src", "run-agents.ts"), "--no-daemon", "--once", "--dry-run", "--agents", "pm", "--dump-prompt", tmp], { cwd: ws, encoding: "utf8", env });
    ok(r.status === 0, `fixture: a dry-run fire renders (${r.status})`);
    let prompt = "";
    try { prompt = readFileSync(join(tmp, "pm.prompt.txt"), "utf8"); } catch { /* asserted next */ }
    ok(/humanBlocked: off/.test(prompt),
      `the fire's resolved-config knobs carry the posture beside mode/autonomy (${/^- mode: [^\n]*/m.exec(prompt)?.[0]?.slice(0, 140) ?? "no knobs line"})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nHUMAN_BLOCKED_OFF_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
