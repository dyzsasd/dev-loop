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

for (const c of [dev, op, pm]) await c.close();
adb.close();
console.log(fails === 0 ? "\nRELEASE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
