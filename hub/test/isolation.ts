// P3 isolation certification: two projects share ONE WAL db (the real ~/.dev-loop/hub.db
// topology). Proves a process pinned to project A returns ONLY A's rows and cannot read /
// mutate / comment B's tickets by id — the §2 firewall, now structural + regression-locked.
// Plus negative guards: a phantom actor and an unknown (uncreated) project are REFUSED at connect.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawn } from "node:child_process";
import { rmSync, statSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const DB = "/tmp/hub-iso/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

async function as(actor: string, project: string, opts: { create?: boolean; prefix?: string } = {}): Promise<Client> {
  const env: Record<string, string> = { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB };
  if (opts.create) { env.DEVLOOP_CREATE_PROJECT = "1"; if (opts.prefix) env.DEVLOOP_TICKET_PREFIX = opts.prefix; }
  const c = new Client({ name: `iso-${actor}-${project}`, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") };
}
let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// ── Setup: two projects, DISTINCT prefixes (ids are a global PK — they must not collide).
const alpha = await as("pm", "alpha", { create: true, prefix: "AL" });
const beta = await as("pm", "beta", { create: true, prefix: "BE" });
const a1 = (await call(alpha, "save_issue", { title: "ALPHA-only feature", type: "Feature", labels: ["dev-loop", "Feature", "pm"] })).data;
const b1 = (await call(beta, "save_issue", { title: "BETA-only feature", type: "Feature", labels: ["dev-loop", "Feature", "pm"] })).data;
const b2 = (await call(beta, "save_issue", { title: "BETA second", type: "Feature", labels: ["dev-loop", "Feature", "pm"] })).data;
ok(a1.id === "AL-1" && b1.id === "BE-1" && b2.id === "BE-2", `distinct prefixes → globally-unique ids (${a1.id}, ${b1.id}, ${b2.id})`);

// ── Cross-project isolation (alpha cannot see/reach beta) ──────────────────────
const aList = (await call(alpha, "list_issues")).data;
ok(aList.length === 1 && aList[0].title === "ALPHA-only feature", "alpha.list_issues sees ONLY alpha's rows");
ok((await call(beta, "list_issues")).data.length === 2, "beta.list_issues sees ONLY beta's 2 rows");
ok((await call(alpha, "get_issue", { id: "BE-1" })).isError, "alpha CANNOT get_issue a beta id");
ok((await call(alpha, "save_issue", { id: "BE-2", state: "Done" })).isError, "alpha CANNOT mutate a beta ticket by id");
ok((await call(alpha, "save_comment", { issueId: "BE-1", body: "x" })).isError, "alpha CANNOT comment on a beta ticket");
const aEvents = (await call(alpha, "list_events")).data;
ok(aEvents.length >= 1 && aEvents.every((e: any) => e.ticket_id === null || e.ticket_id.startsWith("AL-")), "alpha.list_events is project-scoped (no beta events)");
ok((await call(alpha, "whoami")).data.project === "alpha" && (await call(beta, "whoami")).data.project === "beta", "whoami reports the correct pinned project per pane");
for (const c of [alpha, beta]) await c.close();

// ── Negative guards (G1/G2) — refuse to connect ───────────────────────────────
let phantomActorRejected = false;
try { const c = await as("pmm", "alpha"); await c.close(); } catch { phantomActorRejected = true; }
ok(phantomActorRejected, "phantom actor 'pmm' is REFUSED at connect (G1)");

let phantomProjectRejected = false;
try { const c = await as("pm", "scartch"); await c.close(); } catch { phantomProjectRejected = true; } // no create flag
ok(phantomProjectRejected, "unknown project 'scartch' (no create flag) is REFUSED at connect (G2)");

// ── doctor on the seeded db → OK (and exit 0) ─────────────────────────────────
let doctorOk = false;
try { doctorOk = execFileSync("node", ["src/server.ts", "doctor"], { env: { ...process.env, DEVLOOP_HUB_DB: DB } }).toString().includes("DOCTOR_OK"); } catch { doctorOk = false; }
ok(doctorOk, "dev-loop-hub doctor → DOCTOR_OK (WAL, quick_check, unique prefixes, secrecy)");

// ── DL-54: doctor is READ-ONLY — it must NEVER create/initialize a db, and must REJECT an
//    existing empty/truncated/non-hub file (not falsely green it). Run doctor and capture exit+stdout.
function doctorRun(db: string): { out: string; code: number } {
  try { return { out: execFileSync("node", ["src/server.ts", "doctor"], { env: { ...process.env, DEVLOOP_HUB_DB: db }, encoding: "utf8" }), code: 0 }; }
  catch (e: any) { return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 }; }
}
const EMPTY = "/tmp/hub-iso/empty.db";
writeFileSync(EMPTY, "");                                   // 0-byte file: a truncated/zeroed/placeholder SoR
const er = doctorRun(EMPTY);
ok(er.code !== 0 && !er.out.includes("DOCTOR_OK"), "doctor on a 0-byte file → NOT DOCTOR_OK, exit ≠ 0 (DL-54)");
ok(statSync(EMPTY).size === 0, "doctor did NOT write to the 0-byte file — size still 0, not 0→~200KB (READ-ONLY; DL-54)");
const MISS = `/tmp/hub-iso/missing-${process.pid}.db`;       // no-regression: a truly missing path
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(MISS + ext); } catch {} }
const mr = doctorRun(MISS);
ok(mr.code !== 0 && mr.out.includes("MISSING") && !existsSync(MISS), "doctor on a missing path → MISSING, exit ≠ 0, creates nothing (no regression)");

// ── DL-81: doctor's service runtime-wiring reconcile (additive, READ-ONLY, NON-FATAL) ──────────────────
// The `doctor` COMMAND (server.ts → runDoctor(reconcile:true)) ALSO reports, for a service-backend project
// that lives in THIS db, whether its runtime wiring (.mcp.json registration / daemon health / DL-42 hook) is
// in place — each line PASS/WARN, never a fail. Run it against the seeded alpha/beta db with controlled env.
// Async (spawn, not execFileSync) so the test event loop stays FREE while doctor runs — the fully-wired case
// below stands up an in-process /api/health stub the doctor SUBPROCESS must reach, which a blocking
// execFileSync would deadlock (the stub can't answer while the loop is parked in the sync child).
function doctorEnv(extra: Record<string, string>): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn("node", ["src/server.ts", "doctor"], { env: { ...process.env, DEVLOOP_HUB_DB: DB, ...extra } });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ out, code: code ?? 1 }));
  });
}
const recRoot = mkdtempSync(join(tmpdir(), "dl81-doctor-"));

// (AC4a) NO service context — the resolved key is not a project in THIS db → the reconcile prints NOTHING;
// the DB-only verdict is byte-for-byte today's (DOCTOR_OK, no "service runtime wiring" section).
const noCtx = await doctorEnv({ DEVLOOP_PROJECT: "nonesuch" });
ok(noCtx.code === 0 && noCtx.out.includes("DOCTOR_OK") && !noCtx.out.includes("service runtime wiring"),
   "doctor: no service context (key ∉ db) → DOCTOR_OK, NO reconcile section (DB-only verdict unchanged, DL-81 AC3)");

// (AC4b/c) service context present but NOTHING wired — every reconcile check WARNs, yet the verdict stays
// DOCTOR_OK (exit 0): the reconcile is best-effort, NEVER a hard-fail (only the DB-integrity checks gate).
const bareRepo = mkdtempSync(join(tmpdir(), "dl81-repo-"));    // no .mcp.json
const emptyRun = mkdtempSync(join(tmpdir(), "dl81-run-"));     // no daemon-alpha.json runfile
const emptyRoot = mkdtempSync(join(tmpdir(), "dl81-root-"));   // no hooks/hooks.json
const cfgWarn = join(recRoot, "warn.projects.json");
writeFileSync(cfgWarn, JSON.stringify({ projects: { alpha: { backend: "service", repoPath: bareRepo } } }));
const warnRun = await doctorEnv({ DEVLOOP_PROJECT: "alpha", DEVLOOP_PROJECTS_JSON: cfgWarn, DEVLOOP_RUN_DIR: emptyRun, DEVLOOP_PLUGIN_ROOT: emptyRoot });
ok(warnRun.code === 0 && warnRun.out.includes("DOCTOR_OK") && !warnRun.out.includes("DOCTOR_FAILED"),
   "doctor: service context, nothing wired → still DOCTOR_OK exit 0 (reconcile is non-fatal, DL-81 AC2)");
ok(warnRun.out.includes("service runtime wiring — 'alpha'"),
   "doctor: service context → the reconcile section appears (DL-81 AC4b)");
ok(warnRun.out.includes("is not registered") && warnRun.out.includes("daemon — not running") && warnRun.out.includes("daemon autostart"),
   "doctor: a missing .mcp.json / daemon / autostart each yields a WARN, not a FAIL (DL-81 AC4c)");

// (AC4b) service context FULLY wired — every reconcile check PASSes (✅), DOCTOR_OK. A stub /api/health
// server stands in for the live daemon so the health probe has a real 2xx {ok,project} to confirm.
const okRepo = mkdtempSync(join(tmpdir(), "dl81-okrepo-"));
const fakeServer = join(okRepo, "server.ts"); writeFileSync(fakeServer, "// stub entry (doctor only checks the path exists)\n");
writeFileSync(join(okRepo, ".mcp.json"), JSON.stringify({ mcpServers: { "dev-loop-hub": { command: "node", args: [fakeServer], env: { DEVLOOP_ACTOR: "${DEVLOOP_ACTOR:-operator}" } } } }));
const okRoot = mkdtempSync(join(tmpdir(), "dl81-okroot-")); mkdirSync(join(okRoot, "hooks"), { recursive: true });
writeFileSync(join(okRoot, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node x daemon up || true" }] }] } }));
const okRun = mkdtempSync(join(tmpdir(), "dl81-okrun-"));
const stub = createServer((req, res) => {
  if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, project: "alpha" })); }
  else { res.writeHead(404); res.end(); }
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
const stubPort = (stub.address() as { port: number }).port;
writeFileSync(join(okRun, "daemon-alpha.json"), JSON.stringify({ project: "alpha", pid: process.pid, port: stubPort, host: "127.0.0.1", url: `http://127.0.0.1:${stubPort}`, startedAt: "2026-01-01T00:00:00.000Z" }));
const cfgOk = join(recRoot, "ok.projects.json");
writeFileSync(cfgOk, JSON.stringify({ projects: { alpha: { backend: "service", repoPath: okRepo } } }));
const okR = await doctorEnv({ DEVLOOP_PROJECT: "alpha", DEVLOOP_PROJECTS_JSON: cfgOk, DEVLOOP_RUN_DIR: okRun, DEVLOOP_PLUGIN_ROOT: okRoot });
stub.close();
ok(okR.code === 0 && okR.out.includes("DOCTOR_OK")
   && okR.out.includes("registers dev-loop-hub") && okR.out.includes("daemon /api/health reachable") && okR.out.includes("Claude SessionStart hook compatibility present"),
   "doctor: service context wired → .mcp.json + daemon health + optional Claude hook PASS, DOCTOR_OK (autostart may still be operator-installed)");
try { for (const d of [recRoot, bareRepo, emptyRun, emptyRoot, okRepo, okRoot, okRun]) rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }

console.log(fails === 0 ? "\nHUB_ISOLATION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
