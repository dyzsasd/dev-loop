// inspect.ts — `dev-loop inspect` answers the delegated-inspection question without a model.
//
// Nine operator inspections of a live workspace in one day cost ~100k tokens each, and nearly all of
// it was raw material: a sub-agent ran a dozen commands, read run.log and every runner-log tail,
// diffed git, and only then judged. This verb is the few dozen structured lines that judgement
// actually needs, so the delegated agent reads facts instead of transcripts.
//
// What the suite pins, arm by arm: a stable top-level schema; honest nulls (no ledger is `null`, not
// a zeroed report); the deterministic `warnings` — a stalled claim names its ticket, a lane that
// never fired is a dead lane, a repo ahead of origin is unpushed work; doctor arriving as CODES
// rather than prose; and exit 0 always, because this reports and `doctor` gates.
import { execFileSync, spawnSync } from "node:child_process";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSPECT_KEYS, inspectReport, type InspectReport } from "../src/inspect.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
const tmp = realpathSync(tmpRoot("dl-inspect-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ws = join(tmp, "ws");
const repo = join(ws, "repo");
const env = { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") } as NodeJS.ProcessEnv;
const cli = (args: string[], cwd = ws) => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
};
const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const kinds = (r: InspectReport) => r.warnings.map((w) => w.kind);

try {
  mkdirSync(repo, { recursive: true });
  ok(cli(["team", "init", "--dir", ws, "--key", "insp", "--backend", "service", "--yes"], tmp).code === 0, "fixture: team init");
  ok(cli(["team", "add-project", "ip", "--prefix", "IP"]).code === 0, "fixture: add-project");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, ["commit", "--allow-empty", "-qm", "chore: baseline"]);
  ok(cli(["team", "add-repo", "r", "--project", "ip", "--path", "repo", "--role", "primary"]).code === 0, "fixture: add-repo");

  // ── Schema + honest nulls, on a workspace that has never fired ──────────────────────────────────
  {
    const r = await inspectReport(loadWorkspace(ws));
    ok(JSON.stringify(Object.keys(r)) === JSON.stringify([...INSPECT_KEYS]),
      `the top-level schema is exactly INSPECT_KEYS, in order (${Object.keys(r).join(",")})`);
    ok(r.fires === null, "no fire ledger yet ⇒ fires is null, not a report of zero fires");
    ok(!kinds(r).includes("dead-lane"),
      "…and no lane is called dead on an empty ledger — every lane is silent, which is not a finding");
    ok(r.repos.length === 1 && r.repos[0].ref === "r", `the registered repo is reported (${JSON.stringify(r.repos.map((x) => x.ref))})`);
    ok(r.repos[0].ahead === null && r.repos[0].behind === null,
      `a repo with no remote reports ahead/behind as null, never 0 (${r.repos[0].ahead}/${r.repos[0].behind})`);
    ok(Array.isArray(r.doctor) && r.doctor.every((d) => /^[WE]\d{2}$/.test(d.code)),
      `doctor arrives as CODES with severities (${JSON.stringify((r.doctor ?? []).slice(0, 4).map((d) => `${d.severity}:${d.code}`))})`);
    ok(r.doctor !== null && !JSON.stringify(r.doctor).includes("dev-loop workspace —"),
      "…and not doctor's prose header — the codes are the point");
    // `fires === 0` used to be asserted for EVERY row here. That half encoded a false claim: the ledger
    // files a fire under the lane's ACTOR (run-agents writes laneActor(agent)), so a job lane's activity
    // is not derivable from it at all — 0 asserted a measurement where there is no measurement. On the
    // live board that produced five dead-lane warnings against five lanes that were firing normally.
    // The intent of the arm survives (every lane listed, last-fire honest); the count now reads null for
    // the lanes the ledger cannot answer and 0 for the actors it can.
    ok(r.lanes.length > 10 && r.lanes.every((l) => l.lastFireAt === null),
      `every lane is listed with an honest null last-fire (${r.lanes.length} lanes)`);
    const jobLanes = r.lanes.filter((l) => l.lane.includes("-") && /^(pm|qa)-/.test(l.lane));
    ok(jobLanes.length >= 5 && jobLanes.every((l) => l.fires === null),
      `a job lane's fires read null — unknown, not zero (${JSON.stringify(jobLanes.map((l) => [l.lane, l.fires]))})`);
    ok(r.lanes.some((l) => l.lane === "pm" && l.fires === 0),
      "…while an ACTOR the ledger does index still reads 0 on an empty ledger");
  }

  // ── A dead lane and a repeated errorClass, off a real ledger ────────────────────────────────────
  {
    const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
    mkdirSync(dirname(ledger), { recursive: true });
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const row = (agent: string, msAgo: number, errorClass?: string) =>
      JSON.stringify({ ts: iso(msAgo), agent, project: "ip", exitCode: errorClass ? 1 : 0, ...(errorClass ? { errorClass } : {}), usage: { costUsd: 0.5 } });
    writeFileSync(ledger, [
      row("pm", 60_000), row("pm", 120_000),
      row("sweep", 90_000, "stalled"), row("sweep", 100_000, "stalled"), row("sweep", 110_000, "stalled"),
    ].join("\n") + "\n");

    const r = await inspectReport(loadWorkspace(ws));
    ok(r.fires !== null && r.fires.total === 5, `the window's fires are counted (${r.fires?.total})`);
    ok(r.fires !== null && r.fires.spanMs > 0 && r.fires.usdPerDay !== null,
      `the $/day rate is computed over the ledger's REAL span, not a fixed divisor (span ${r.fires?.spanMs}ms, ${r.fires?.usdPerDay})`);
    ok(r.fires?.errorClasses.stalled === 3, `errorClass counts are reported (${JSON.stringify(r.fires?.errorClasses)})`);
    ok(r.fires?.mostExpensive?.costUsd === 0.5, `the most expensive fire is named (${JSON.stringify(r.fires?.mostExpensive)})`);
    ok((r.fires?.byAgent ?? []).some((a) => a.agent === "sweep" && a.fires === 3), `fires group by agent (${JSON.stringify(r.fires?.byAgent)})`);

    const w = r.warnings;
    ok(w.some((x) => x.kind === "repeated-error-class" && x.evidence.agent === "sweep" && x.evidence.count === 3),
      `a repeated errorClass is a warning carrying its evidence (${JSON.stringify(w.filter((x) => x.kind === "repeated-error-class"))})`);
    const dead = w.filter((x) => x.kind === "dead-lane");
    ok(dead.some((x) => x.evidence.lane === "qa"),
      `a lane that never fired inside the window is a dead lane (${dead.length} found)`);
    ok(!dead.some((x) => x.evidence.lane === "pm"), "…and a lane that DID fire is not");
  }

  // ── A stalled claim names its ticket ────────────────────────────────────────────────────────────
  {
    // The claim is written straight to the board, aged past the 30m threshold. Going through the op
    // API would test the op API; what is under test is inspect's threshold, and an alternative that
    // waited half an hour for a real claim to age would be a slower way to assert the same line.
    {
      const db = openDb(join(ws, ".dev-loop", "hub.db"));
      const old = new Date(Date.now() - 90 * 60_000).toISOString();
      try {
        const projectId = findProject(db, "ip");
        ok(!!projectId, `fixture: the project has a board row (${projectId})`);
        db.prepare(
          "INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at)"
          + " VALUES(?,?,?,?,?,0,'[]','[]','junior-dev',?,?)",
        ).run("IP-77", projectId!, "stalled work", "In Progress", "junior-dev", old, old);
        db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,?,?,?,?)")
          .run(projectId!, "IP-77", "junior-dev", "issue.transition", "{}", old);
      } finally { db.close(); }
    }

    const r = await inspectReport(loadWorkspace(ws));
    const stalled = r.warnings.filter((x) => x.kind === "stalled-claim");
    ok(stalled.length > 0, `an In Progress ticket past the threshold is a stalled claim (${JSON.stringify(stalled)})`);
    ok(stalled.every((s) => typeof s.evidence.id === "string" && (s.evidence.ageMinutes as number) >= 30),
      "…naming the ticket id and how long it has been held");
    ok(Object.values(r.board ?? {}).some((b) => b.staleClaims.length > 0),
      "…and the same claim is on the board section it was derived from");
  }

  // ── Unpushed work against a real remote ─────────────────────────────────────────────────────────
  {
    const origin = join(tmp, "origin.git");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-qu", "origin", "main"]);
    git(repo, ["commit", "--allow-empty", "-qm", "feat: unpushed work"]);
    const r = await inspectReport(loadWorkspace(ws));
    ok(r.repos[0].ahead === 1, `a repo ahead of origin reports the count (${r.repos[0].ahead})`);
    ok(r.warnings.some((x) => x.kind === "unpushed-commits" && x.evidence.ahead === 1),
      `…and it is a warning with evidence (${JSON.stringify(r.warnings.filter((x) => x.kind === "unpushed-commits"))})`);
  }

  // ── The CLI surface: --json parses, the human render is the default, exit is always 0 ───────────
  {
    const j = cli(["inspect", "--json"]);
    ok(j.code === 0, `inspect --json exits 0 (${j.code}) ${j.out.slice(0, 200)}`);
    let parsed: InspectReport | null = null;
    try { parsed = JSON.parse(j.stdout) as InspectReport; } catch { /* asserted next */ }
    ok(!!parsed && JSON.stringify(Object.keys(parsed)) === JSON.stringify([...INSPECT_KEYS]),
      "…and stdout is the report and nothing else — no doctor prose leaking into the JSON");

    const human = cli(["inspect"]);
    ok(human.code === 0 && /## scheduler/.test(human.stdout) && /## warnings/.test(human.stdout),
      `the default render is the human one (${human.stdout.slice(0, 80).replace(/\n/g, " ")})`);

    const win = cli(["inspect", "--window", "5m", "--json"]);
    ok(win.code === 0 && JSON.parse(win.stdout).windowMs === 5 * 60_000, "--window narrows the ledger read");
    ok(cli(["inspect", "--window", "nonsense"]).code === 2, "a malformed --window is a usage error, not a guess");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nINSPECT_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
