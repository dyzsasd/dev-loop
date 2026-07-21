// queue op tests — the task-shaped per-agent read (conventions-to-code: §5/§21b in code).
// Contracts: (1) dev tiers get THEIR slice only, §5-ranked (urgent bug → urgent feature →
// edge-case bug → bug → feature → improvement, FIFO within rank), `blocked` excluded, plus
// their own In Progress; (2) pm gets verify/unblock/backlog + the §5a todoDepth cap input;
// (3) qa gets verify + the project's blocked set; (4) other actors are refused 400;
// (5) summaries only — no description bodies ride the lists.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { insertTicket } from "../src/ticketwrite.ts";
import { agentOp, type OpResult } from "../src/agentops.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const dir = mkdtempSync(join(tmpdir(), "devloop-queue-"));
const db = openDb(join(dir, "hub.db"));
const projectId = ensureSeed(db, "qproj", "Queue Project", "QQ");

interface T { title: string; type?: string; state?: string; assignee?: string | null; priority?: number; labels?: string[]; description?: string }
const mk = (t: T): string => insertTicket(db, projectId, "pm", {
  title: t.title, description: t.description ?? "body text", type: t.type ?? "Feature",
  state: (t.state ?? "Todo") as never, assignee: t.assignee ?? null, priority: t.priority ?? 0,
  labels: t.labels ?? ["dev-loop"], duplicateOf: null, relatedTo: [],
}, { title: t.title, type: t.type });

// the junior slice, filed out of pick order on purpose (queue must re-rank)
mk({ title: "improvement", type: "Improvement", assignee: "junior-dev" });
mk({ title: "feature", type: "Feature", assignee: "junior-dev" });
mk({ title: "plain bug", type: "Bug", assignee: "junior-dev" });
mk({ title: "edge bug", type: "Bug", assignee: "junior-dev", labels: ["dev-loop", "edge-case"] });
mk({ title: "urgent feature", type: "Feature", assignee: "junior-dev", priority: 1 });
mk({ title: "urgent bug", type: "Bug", assignee: "junior-dev", priority: 1 });
mk({ title: "blocked one", type: "Bug", assignee: "junior-dev", labels: ["dev-loop", "blocked"] });
mk({ title: "senior ticket", type: "Feature", assignee: "senior-dev" });
mk({ title: "junior wip", type: "Bug", state: "In Progress", assignee: "junior-dev" });
// pm/qa surfaces
mk({ title: "pm verify", state: "In Review", labels: ["dev-loop", "pm"] });
mk({ title: "qa verify", state: "In Review", labels: ["dev-loop", "qa"] });
mk({ title: "pm unblock", state: "Todo", labels: ["dev-loop", "blocked", "needs-pm"] });
mk({ title: "idea", state: "Backlog", labels: ["dev-loop", "pm"] });
mk({ title: "terminal blocked", state: "Canceled", labels: ["dev-loop", "blocked", "needs-pm"] });

const call = (actor: string): { status: number; body: Record<string, unknown> } => {
  const r = agentOp("queue", db, projectId, "qproj", actor, {}) as OpResult;
  return { status: r.status, body: r.body as Record<string, unknown> };
};
const titles = (rows: unknown): string[] => (rows as { title: string }[]).map((r) => r.title);

// ── 1. junior slice: §5 ranking, blocked excluded, senior's ticket invisible ─────────────────────
const jr = call("junior-dev");
ok(jr.status === 200, "junior-dev queue returns 200");
ok(JSON.stringify(titles(jr.body.todo)) === JSON.stringify(["urgent bug", "urgent feature", "edge bug", "plain bug", "feature", "improvement"]),
  `todo is the §5 pick order exactly (got: ${titles(jr.body.todo).join(" → ")})`);
ok(!titles(jr.body.todo).includes("blocked one"), "a `blocked` ticket never enters the pick set (§9)");
ok(!titles(jr.body.todo).includes("senior ticket"), "the senior slice is invisible to junior (§21b encoding)");
ok(JSON.stringify(titles(jr.body.inProgress)) === JSON.stringify(["junior wip"]), "own In Progress rides along (Step-0 orphan input)");
ok((jr.body.todo as { description: string }[]).every((t) => t.description === ""), "summaries only — no description bodies");

// FIFO within rank: a second urgent bug filed later sorts after the first
mk({ title: "urgent bug 2", type: "Bug", assignee: "junior-dev", priority: 1 });
ok(titles(call("junior-dev").body.todo).indexOf("urgent bug") < titles(call("junior-dev").body.todo).indexOf("urgent bug 2"),
  "FIFO within a rank (oldest first — no starvation)");

// ── 2. senior slice ───────────────────────────────────────────────────────────────────────────────
ok(JSON.stringify(titles(call("senior-dev").body.todo)) === JSON.stringify(["senior ticket"]), "senior sees exactly its own slice");

// ── 3. pm lists + todoDepth ───────────────────────────────────────────────────────────────────────
const pm = call("pm");
ok(titles(pm.body.verify).includes("pm verify") && !titles(pm.body.verify).includes("qa verify"), "pm verify = In Review + pm label only");
ok(JSON.stringify(titles(pm.body.unblock)) === JSON.stringify(["pm unblock"]), "pm unblock = blocked+needs-pm, terminal states excluded");
ok(titles(pm.body.backlog).includes("idea"), "pm backlog = the groom queue");
const depth = pm.body.todoDepth as { total: number; "junior-dev": number };
ok(depth["junior-dev"] === 7 && depth.total >= 8, `todoDepth counts unblocked Todo per tier (junior=${depth["junior-dev"]}, total=${depth.total})`);

// ── 4. qa lists ───────────────────────────────────────────────────────────────────────────────────
const qa = call("qa");
ok(titles(qa.body.verify).includes("qa verify") && !titles(qa.body.verify).includes("pm verify"), "qa verify = In Review + qa label only");
ok(titles(qa.body.blocked).includes("pm unblock") && titles(qa.body.blocked).includes("blocked one") && !titles(qa.body.blocked).includes("terminal blocked"),
  "qa blocked = every non-terminal blocked ticket (Job B routes by bail-shape)");

// ── 5. refusals ───────────────────────────────────────────────────────────────────────────────────
ok(call("reflect").status === 400, "queue refuses actors without a pick contract (reflect)");

console.log(fails === 0 ? "\nQUEUE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
