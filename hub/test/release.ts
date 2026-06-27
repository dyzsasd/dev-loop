// DL-32 Slice A — release/env gating: env:dev/env:prod workflow labels, the prod-promotion gate
// (cooperative human attribution, default off, demotion always allowed), and the issue.promote {from,to}
// lifecycle event replayed in /activity. Drives the REAL MCP write path as distinct actors over a shared
// WAL hub.db (like smoke.ts), flips settings_json.workflow.release via a direct conn (like daemon.ts's
// setHumanWrite), then starts a read-only daemon in-process to assert the /activity render. The
// requireDeployBeforeReview staging-deploy gate is a deferred follow-up (see the parent's handoff).
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

wdb.close();

for (const c of [dev, op, pm]) await c.close();
adb.close();
console.log(fails === 0 ? "\nRELEASE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
