// P3 isolation certification: two projects share ONE WAL db (the real ~/.dev-loop/hub.db
// topology). Proves a process pinned to project A returns ONLY A's rows and cannot read /
// mutate / comment B's tickets by id — the §2 firewall, now structural + regression-locked.
// Plus negative guards: a phantom actor and an unknown (uncreated) project are REFUSED at connect.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { rmSync, statSync, writeFileSync, existsSync } from "node:fs";

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

console.log(fails === 0 ? "\nHUB_ISOLATION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
