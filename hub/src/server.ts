// dev-loop hub — stdio MCP server. The loop's system of record for ONE project.
// Identity rides DEVLOOP_ACTOR (launcher-set per pane); project rides DEVLOOP_PROJECT; db DEVLOOP_HUB_DB.
// Tools mirror the Linear MCP op-shapes 1:1 so the agent SKILLs port unchanged (conventions §18).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";
import { openDb, nowIso, nextTicketId, logEvent, actorExists, listActorHandles, STATES, type State, type Ticket } from "./db.ts";
import { ensureActors, ensureProject, findProject } from "./seed.ts";

// ─── Environment / identity ──────────────────────────────────────────────────
const DB_PATH = process.env.DEVLOOP_HUB_DB ?? `${homedir()}/.dev-loop/hub.db`;
const PROJECT_KEY = process.env.DEVLOOP_PROJECT ?? "demo";
const ACTOR = process.env.DEVLOOP_ACTOR ?? "operator"; // who this MCP client IS (the attribution win)

// `dev-loop-hub doctor` — read-only health check (no server, no auto-create).
if (process.argv[2] === "doctor") {
  const { runDoctor } = await import("./doctor.ts");
  process.exit(runDoctor(DB_PATH) ? 0 : 1);
}

const db = openDb(DB_PATH);
ensureActors(db); // the 8 agents + operator are always present (needed for attribution + the guard below)

// P3/G1 — phantom-actor guard: a typo'd DEVLOOP_ACTOR would silently write an unattributable
// author into created_by / events.actor / comments.author. Refuse to start instead (exit non-zero
// ⇒ the MCP client can't connect ⇒ the failure is visible to the launching pane).
if (!actorExists(db, ACTOR)) {
  console.error(`[hub] DEVLOOP_ACTOR='${ACTOR}' is not a known actor. Valid: ${listActorHandles(db).join(", ")}. Fix DEVLOOP_ACTOR in the launcher.`);
  process.exit(1);
}

// P3/G2 — phantom-project guard: a typo'd DEVLOOP_PROJECT must NOT silently auto-create an empty
// board the agent then works in by mistake. The project must already exist; create it deliberately
// once (`node src/seed.ts <key> <name> <UNIQUE_PREFIX>`) or opt in with DEVLOOP_CREATE_PROJECT=1.
const projectId =
  process.env.DEVLOOP_CREATE_PROJECT === "1"
    ? ensureProject(db, PROJECT_KEY, process.env.DEVLOOP_PROJECT_NAME ?? PROJECT_KEY, process.env.DEVLOOP_TICKET_PREFIX ?? "DL")
    : findProject(db, PROJECT_KEY);
if (!projectId) {
  console.error(`[hub] unknown project '${PROJECT_KEY}'. Create it once: \`node ${import.meta.dirname}/seed.ts ${PROJECT_KEY} "<name>" <UNIQUE_PREFIX>\` (or set DEVLOOP_CREATE_PROJECT=1). Refusing to auto-create a phantom board from a typo.`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] });

interface TicketRow {
  id: string; project_id: string; title: string; description: string; type: string;
  state: State; assignee: string | null; priority: number; labels: string;
  duplicate_of: string | null; related_to: string; created_by: string; created_at: string; updated_at: string;
}
const toTicket = (r: TicketRow): Ticket => ({
  id: r.id, project_id: r.project_id, title: r.title, description: r.description, type: r.type,
  state: r.state, assignee: r.assignee, priority: r.priority,
  labels: JSON.parse(r.labels) as string[],
  duplicateOf: r.duplicate_of, relatedTo: JSON.parse(r.related_to) as string[],
  created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
});
const getRow = (id: string): TicketRow | undefined =>
  db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as TicketRow | undefined;
const resolveAssignee = (a: string | null | undefined): string | null =>
  a === undefined ? null : a === "me" ? ACTOR : a;

const server = new McpServer({ name: "dev-loop-hub", version: "0.1.0" });

// ─── whoami ──────────────────────────────────────────────────────────────────
server.registerTool("whoami",
  { description: "The identity this session is acting as, and the active project.", inputSchema: {} },
  async () => ok({ actor: ACTOR, project: PROJECT_KEY, db: DB_PATH }));

// ─── list_issues (project-scoped; mirrors Linear filters) ─────────────────────
server.registerTool("list_issues", {
  description: "List tickets in the active project. Filter by state, assignee, type, label(s), or a title query.",
  inputSchema: {
    state: z.string().optional(), assignee: z.string().optional(), type: z.string().optional(),
    label: z.string().optional(), labels: z.array(z.string()).optional(), query: z.string().optional(),
    limit: z.number().int().positive().max(250).optional(),
  },
}, async (a) => {
  let rows = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY updated_at DESC").all(projectId) as TicketRow[]);
  let out = rows.map(toTicket);
  if (a.state) out = out.filter((t) => t.state === a.state);
  if (a.assignee) out = out.filter((t) => t.assignee === resolveAssignee(a.assignee));
  if (a.type) out = out.filter((t) => t.type === a.type);
  const want = [...(a.labels ?? []), ...(a.label ? [a.label] : [])];
  if (want.length) out = out.filter((t) => want.every((l) => t.labels.includes(l)));
  if (a.query) { const q = a.query.toLowerCase(); out = out.filter((t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)); } // §8 dedupe scans title+body (§18 line 962)
  return ok(a.limit ? out.slice(0, a.limit) : out); // no implicit cap — Sweep scans the full non-terminal set (§10 narrows via filters)
});

// ─── get_issue (ticket + its comments) ────────────────────────────────────────
server.registerTool("get_issue",
  { description: "Get one ticket with its comments.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const r = getRow(id);
    if (!r) return err(`no such ticket ${id} in ${PROJECT_KEY}`);
    const comments = db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id);
    return ok({ ...toTicket(r), comments });
  });

// ─── save_issue (create or update; REPLACE-style labels; mirrors Linear) ──────
server.registerTool("save_issue", {
  description: "Create (omit id) or update (with id) a ticket. labels REPLACE the full set (re-pass all). assignee 'me' = you, null clears.",
  inputSchema: {
    id: z.string().optional(), title: z.string().optional(), description: z.string().optional(),
    type: z.string().optional(), state: z.string().optional(),
    assignee: z.string().nullable().optional(), priority: z.number().int().min(0).max(4).optional(),
    labels: z.array(z.string()).optional(),
    duplicateOf: z.string().nullable().optional(), // §8 dedupe scalar (pair with state Duplicate); undefined=keep
    relatedTo: z.array(z.string()).optional(),     // §4 splits / §15 coverage; APPEND-ONLY union (§18 line 965)
  },
}, async (a) => {
  if (a.state && !STATES.includes(a.state as State)) return err(`invalid state '${a.state}'; one of ${STATES.join(", ")}`);
  if (a.assignee && a.assignee !== "me" && !actorExists(db, a.assignee)) return err(`unknown assignee '${a.assignee}'; one of ${listActorHandles(db).join(", ")} (or "me"/null)`);
  const t = nowIso();
  if (!a.id) {
    if (!a.title) return err("title required to create a ticket");
    const id = nextTicketId(db, projectId);
    db.prepare(`INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,duplicate_of,related_to,created_by,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, projectId, a.title, a.description ?? "", a.type ?? "Feature", (a.state as State) ?? "Todo",
      resolveAssignee(a.assignee), a.priority ?? 0, JSON.stringify(a.labels ?? []),
      a.duplicateOf ?? null, JSON.stringify(a.relatedTo ?? []), ACTOR, t, t);
    logEvent(db, { project_id: projectId, ticket_id: id, actor: ACTOR, kind: "issue.create", data: { title: a.title, type: a.type } });
    return ok(toTicket(getRow(id)!));
  }
  const cur = getRow(a.id);
  if (!cur) return err(`no such ticket ${a.id} in ${PROJECT_KEY}`);
  const next = {
    title: a.title ?? cur.title, description: a.description ?? cur.description, type: a.type ?? cur.type,
    state: (a.state as State) ?? cur.state,
    assignee: a.assignee === undefined ? cur.assignee : resolveAssignee(a.assignee),
    priority: a.priority ?? cur.priority,
    labels: a.labels ? JSON.stringify(a.labels) : cur.labels, // REPLACE-style (§10#1 mimicked)
    duplicate_of: a.duplicateOf === undefined ? cur.duplicate_of : a.duplicateOf, // scalar set; undefined=keep
    related_to: a.relatedTo // APPEND-ONLY union (re-read ∪ passed), never replace (§18 line 965)
      ? JSON.stringify([...new Set([...(JSON.parse(cur.related_to) as string[]), ...a.relatedTo])])
      : cur.related_to,
  };
  db.prepare(`UPDATE tickets SET title=?,description=?,type=?,state=?,assignee=?,priority=?,labels=?,duplicate_of=?,related_to=?,updated_at=? WHERE id=? AND project_id=?`)
    .run(next.title, next.description, next.type, next.state, next.assignee, next.priority, next.labels, next.duplicate_of, next.related_to, t, a.id, projectId);
  if (next.state !== cur.state)
    logEvent(db, { project_id: projectId, ticket_id: a.id, actor: ACTOR, kind: "issue.transition", data: { from: cur.state, to: next.state } });
  else
    logEvent(db, { project_id: projectId, ticket_id: a.id, actor: ACTOR, kind: "issue.update", data: {} });
  return ok(toTicket(getRow(a.id)!));
});

// ─── comments ────────────────────────────────────────────────────────────────
server.registerTool("save_comment",
  { description: "Add a comment to a ticket (authored as you).", inputSchema: { issueId: z.string(), body: z.string() } },
  async ({ issueId, body }) => {
    if (!getRow(issueId)) return err(`no such ticket ${issueId}`);
    const id = randomUUID(); const t = nowIso();
    db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES (?,?,?,?,?)").run(id, issueId, ACTOR, body, t);
    logEvent(db, { project_id: projectId, ticket_id: issueId, actor: ACTOR, kind: "comment.add", data: {} });
    return ok({ id, ticket_id: issueId, author: ACTOR, body, created_at: t });
  });
server.registerTool("list_comments",
  { description: "List a ticket's comments (chronological; the tail is the latest).", inputSchema: { issueId: z.string() } },
  async ({ issueId }) => {
    if (!getRow(issueId)) return err(`no such ticket ${issueId} in ${PROJECT_KEY}`); // project-scope guard (parity with get_issue)
    return ok(db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(issueId));
  });

// ─── labels ──────────────────────────────────────────────────────────────────
server.registerTool("list_issue_labels", { description: "List the project's labels.", inputSchema: {} },
  async () => ok(db.prepare("SELECT name,kind FROM labels WHERE project_id=? ORDER BY kind,name").all(projectId)));
server.registerTool("create_issue_label",
  { description: "Create a label if missing (idempotent).", inputSchema: { name: z.string(), kind: z.string().optional() } },
  async ({ name, kind }) => {
    db.prepare("INSERT OR IGNORE INTO labels(id,project_id,name,kind) VALUES (?,?,?,?)").run(randomUUID(), projectId, name, kind ?? "workflow");
    return ok({ name, kind: kind ?? "workflow" });
  });

// ─── projects (minimal) + events (attribution audit) ─────────────────────────
server.registerTool("get_project", { description: "The active project.", inputSchema: {} },
  async () => ok(db.prepare("SELECT id,key,name,ticket_prefix,mode,autonomy FROM projects WHERE id=?").get(projectId)));
server.registerTool("list_events",
  { description: "Recent attribution/audit events (who did what).", inputSchema: { limit: z.number().int().positive().max(500).optional() } },
  async ({ limit }) => ok(db.prepare("SELECT actor,kind,ticket_id,data,created_at FROM events WHERE project_id=? ORDER BY id DESC LIMIT ?").all(projectId, limit ?? 50)));

await server.connect(new StdioServerTransport());
