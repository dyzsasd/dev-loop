// dev-loop hub — stdio MCP server. The loop's system of record for ONE project.
// Identity rides DEVLOOP_ACTOR (launcher-set per pane); project rides DEVLOOP_PROJECT; db DEVLOOP_HUB_DB.
// Tools mirror the Linear MCP op-shapes 1:1 so the agent SKILLs port unchanged (conventions §18).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";
import { openDb, nowIso, nextTicketId, logEvent, actorExists, listActorHandles, unifiedDiff, STATES, type State, type Ticket } from "./db.ts";
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

// ─── P4 documents — versioned, attributable, operator-published (project-scoped) ──────
const DOC_KINDS = ["strategy", "roadmap", "decisions", "notes"] as const;
interface DocRow { id: string; project_id: string; kind: string; slug: string; title: string; status: string; current_version: number; created_by: string; created_at: string; updated_at: string; }
const resolveDoc = (slug?: string, kind?: string): DocRow | undefined =>
  slug ? db.prepare("SELECT * FROM documents WHERE project_id=? AND slug=?").get(projectId, slug) as DocRow | undefined
       : kind ? db.prepare("SELECT * FROM documents WHERE project_id=? AND kind=?").get(projectId, kind) as DocRow | undefined
              : undefined;
const latestVersion = (docId: string): number =>
  (db.prepare("SELECT max(version) v FROM document_versions WHERE doc_id=?").get(docId) as { v: number | null }).v ?? 0;

server.registerTool("doc.list", { description: "List this project's documents (no bodies).", inputSchema: { kind: z.string().optional() } },
  async (a) => ok((a.kind
    ? db.prepare("SELECT id,kind,slug,title,status,current_version,created_by,updated_at FROM documents WHERE project_id=? AND kind=? ORDER BY kind").all(projectId, a.kind)
    : db.prepare("SELECT id,kind,slug,title,status,current_version,created_by,updated_at FROM documents WHERE project_id=? ORDER BY kind").all(projectId))));

server.registerTool("doc.get", {
  description: "Get a document by slug or kind. Omit version → the published (current) version; if never published, the latest DRAFT with unpublished:true. version=N → that historical version.",
  inputSchema: { slug: z.string().optional(), kind: z.string().optional(), version: z.number().int().positive().optional() },
}, async (a) => {
  const d = resolveDoc(a.slug, a.kind);
  if (!d) return err(`no document ${a.slug ?? a.kind} in ${PROJECT_KEY}`);
  const ver = a.version ?? (d.current_version > 0 ? d.current_version : latestVersion(d.id));
  if (ver === 0) return ok({ ...d, version: 0, body: "", unpublished: true, empty: true });
  const v = db.prepare("SELECT version,body,status,summary,base_version,author,created_at FROM document_versions WHERE doc_id=? AND version=?").get(d.id, ver) as Record<string, unknown> | undefined;
  if (!v) return err(`no version ${ver} of ${d.slug}`);
  return ok({ id: d.id, kind: d.kind, slug: d.slug, title: d.title, status: d.status, current_version: d.current_version, ...v, ...(d.current_version === 0 ? { unpublished: true } : {}) });
});

server.registerTool("doc.save", {
  description: "Create (baseVersion 0) or append a new DRAFT version. Optimistic CAS: baseVersion MUST equal the doc's latest version, else CONFLICT (never last-write-wins). NEVER publishes — only the operator can (doc.publish).",
  inputSchema: { slug: z.string(), kind: z.enum(DOC_KINDS), title: z.string().optional(), body: z.string(), baseVersion: z.number().int().min(0), summary: z.string().optional() },
}, async (a) => {
  const t = nowIso();
  db.exec("BEGIN IMMEDIATE"); // RESERVED lock before the read → cross-process CAS is atomic (§7)
  try {
    const d = db.prepare("SELECT * FROM documents WHERE project_id=? AND slug=?").get(projectId, a.slug) as DocRow | undefined;
    if (!d) {
      if (a.baseVersion !== 0) { db.exec("ROLLBACK"); return err(`baseVersion must be 0 to create a new doc '${a.slug}'`); }
      const id = randomUUID();
      db.prepare("INSERT INTO documents(id,project_id,kind,slug,title,status,current_version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'draft',0,?,?,?)").run(id, projectId, a.kind, a.slug, a.title ?? a.slug, ACTOR, t, t);
      db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES (?,?,1,?,'draft',?,0,?,?)").run(randomUUID(), id, a.body, a.summary ?? "", ACTOR, t);
      logEvent(db, { project_id: projectId, actor: ACTOR, kind: "doc.save", data: { slug: a.slug, version: 1, base: 0 } });
      db.exec("COMMIT");
      return ok({ doc: a.slug, kind: a.kind, version: 1, status: "draft" });
    }
    const latest = latestVersion(d.id);
    if (a.baseVersion !== latest) { db.exec("ROLLBACK"); return err(`CONFLICT: '${a.slug}' is at version ${latest}, your baseVersion ${a.baseVersion} is stale — re-read (doc.get) and re-apply`); }
    const nv = latest + 1;
    db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES (?,?,?,?,'draft',?,?,?,?)").run(randomUUID(), d.id, nv, a.body, a.summary ?? "", a.baseVersion, ACTOR, t);
    db.prepare("UPDATE documents SET title=?, updated_at=? WHERE id=?").run(a.title ?? d.title, t, d.id);
    logEvent(db, { project_id: projectId, actor: ACTOR, kind: "doc.save", data: { slug: a.slug, version: nv, base: a.baseVersion } });
    db.exec("COMMIT");
    return ok({ doc: a.slug, kind: d.kind, version: nv, status: "draft" });
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
});

server.registerTool("doc.history", { description: "A document's version ledger (no bodies; newest first).", inputSchema: { slug: z.string().optional(), kind: z.string().optional() } },
  async (a) => {
    const d = resolveDoc(a.slug, a.kind);
    if (!d) return err(`no document ${a.slug ?? a.kind}`);
    return ok(db.prepare("SELECT version,status,author,summary,base_version,created_at FROM document_versions WHERE doc_id=? ORDER BY version DESC").all(d.id));
  });

server.registerTool("doc.diff", { description: "Line diff between two versions of a document.", inputSchema: { slug: z.string().optional(), kind: z.string().optional(), from: z.number().int().positive(), to: z.number().int().positive() } },
  async (a) => {
    const d = resolveDoc(a.slug, a.kind);
    if (!d) return err(`no document ${a.slug ?? a.kind}`);
    const body = (n: number) => (db.prepare("SELECT body FROM document_versions WHERE doc_id=? AND version=?").get(d.id, n) as { body: string } | undefined)?.body;
    const fromBody = body(a.from), toBody = body(a.to);
    if (fromBody === undefined || toBody === undefined) return err(`missing version (have up to ${latestVersion(d.id)})`);
    return ok({ from: a.from, to: a.to, fromBody, toBody, unified: unifiedDiff(fromBody, toBody) });
  });

server.registerTool("doc.publish", {
  description: "OPERATOR-ONLY: publish a draft version → current (the live doc). Cooperative role-gate (DEVLOOP_ACTOR=operator), not anti-spoof — see §18/HUB-ARCHITECTURE §16.",
  inputSchema: { slug: z.string().optional(), kind: z.string().optional(), version: z.number().int().positive() },
}, async (a) => {
  if (ACTOR !== "operator") return err("FORBIDDEN: only the operator may publish a doc draft→current");
  const d = resolveDoc(a.slug, a.kind);
  if (!d) return err(`no document ${a.slug ?? a.kind}`);
  const v = db.prepare("SELECT version FROM document_versions WHERE doc_id=? AND version=?").get(d.id, a.version);
  if (!v) return err(`no version ${a.version} of ${d.slug} to publish`);
  const t = nowIso();
  db.prepare("UPDATE document_versions SET status='current' WHERE doc_id=? AND version=?").run(d.id, a.version);
  db.prepare("UPDATE documents SET status='current', current_version=?, updated_at=? WHERE id=?").run(a.version, t, d.id);
  logEvent(db, { project_id: projectId, actor: ACTOR, kind: "doc.publish", data: { slug: d.slug, version: a.version } });
  return ok({ doc: d.slug, status: "current", current_version: a.version });
});

// ─── P5 discussion board — the Director chairs; invited agents post per round ──────
// Two distinct gates (kept honest, both cooperative on one host — see §18/HUB-ARCH §16):
//   • chair-gate  = ACTOR === topic.opened_by  (per-topic, like post.add's invited-membership)
//   • invited-gate = ACTOR ∈ topic.invited      (your-lane: you post only AS yourself, once per round)
// Termination is STATE-FREE: topics carry round_opened_at (a wall-clock the Director reads to decide
// "this round is ripe") — the hub stores the data; the Director SKILL owns the maxRounds/budget policy.
interface TopicRow {
  id: string; project_id: string; question: string; invited: string; status: string;
  round: number; round_opened_at: string; opened_by: string; opened_at: string;
  closed_at: string | null; decision: string | null;
}
const getTopic = (id: string): TopicRow | undefined =>
  db.prepare("SELECT * FROM topics WHERE id=? AND project_id=?").get(id, projectId) as TopicRow | undefined;
const pendingFor = (t: TopicRow): string[] => {
  const invited = JSON.parse(t.invited) as string[];
  const answered = new Set(
    (db.prepare("SELECT author FROM posts WHERE topic_id=? AND round=? AND kind='perspective'").all(t.id, t.round) as { author: string }[])
      .map((r) => r.author));
  return invited.filter((h) => !answered.has(h));
};

server.registerTool("topic.open", {
  description: "Open a discussion topic (the caller becomes the chair = opened_by). invited = actor handles asked to post a perspective. Director-style use; any actor may chair its own topics.",
  inputSchema: { question: z.string().min(1), invited: z.array(z.string()).min(1) },
}, async (a) => {
  const bad = a.invited.filter((h) => !actorExists(db, h));
  if (bad.length) return err(`unknown invited actor(s): ${bad.join(", ")} — valid: ${listActorHandles(db).join(", ")}`);
  const id = randomUUID();
  const t = nowIso();
  db.prepare("INSERT INTO topics(id,project_id,question,invited,status,round,round_opened_at,opened_by,opened_at) VALUES (?,?,?,?,'open',1,?,?,?)")
    .run(id, projectId, a.question, JSON.stringify([...new Set(a.invited)]), t, ACTOR, t);
  logEvent(db, { project_id: projectId, actor: ACTOR, kind: "topic.open", data: { id, invited: a.invited } });
  return ok({ id, question: a.question, invited: [...new Set(a.invited)], status: "open", round: 1, opened_by: ACTOR });
});

server.registerTool("topic.list", {
  description: "List discussion topics (no post bodies). Each row carries the current round, round_opened_at, and YOUR/the invited set's `pending` for this round (who still owes a perspective).",
  inputSchema: { status: z.enum(["open", "closed"]).optional() },
}, async (a) => {
  const rows = (a.status
    ? db.prepare("SELECT * FROM topics WHERE project_id=? AND status=? ORDER BY opened_at DESC").all(projectId, a.status)
    : db.prepare("SELECT * FROM topics WHERE project_id=? ORDER BY opened_at DESC").all(projectId)) as TopicRow[];
  return ok(rows.map((t) => {
    const pending = t.status === "open" ? pendingFor(t) : [];
    return {
      id: t.id, question: t.question, status: t.status, round: t.round, round_opened_at: t.round_opened_at,
      opened_by: t.opened_by, opened_at: t.opened_at, closed_at: t.closed_at, decision: t.decision,
      invited: JSON.parse(t.invited) as string[], pending, youArePending: pending.includes(ACTOR),
    };
  }));
});

server.registerTool("topic.get", { description: "A topic + all its posts (perspectives + the chair's synthesis), oldest first.", inputSchema: { id: z.string() } },
  async (a) => {
    const t = getTopic(a.id);
    if (!t) return err(`no topic ${a.id} in ${PROJECT_KEY}`);
    const posts = db.prepare("SELECT round,author,kind,body,created_at FROM posts WHERE topic_id=? ORDER BY round, created_at").all(a.id);
    return ok({
      id: t.id, question: t.question, status: t.status, round: t.round, round_opened_at: t.round_opened_at,
      opened_by: t.opened_by, opened_at: t.opened_at, closed_at: t.closed_at, decision: t.decision,
      invited: JSON.parse(t.invited) as string[], pending: t.status === "open" ? pendingFor(t) : [], posts,
    });
  });

server.registerTool("post.add", {
  description: "Post YOUR perspective to an OPEN topic you're invited to — once per round, your lane only (attributed to DEVLOOP_ACTOR). Append-only; you never edit/synthesize/close.",
  inputSchema: { topicId: z.string(), body: z.string().min(1) },
}, async (a) => {
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE"); // read round+status then insert atomically vs a concurrent synthesize round-bump (§7)
  try {
    const t = db.prepare("SELECT * FROM topics WHERE id=? AND project_id=?").get(a.topicId, projectId) as TopicRow | undefined;
    if (!t) { db.exec("ROLLBACK"); return err(`no topic ${a.topicId} in ${PROJECT_KEY}`); }
    if (t.status !== "open") { db.exec("ROLLBACK"); return err(`CONFLICT: topic ${a.topicId} is closed`); }
    if (!(JSON.parse(t.invited) as string[]).includes(ACTOR)) { db.exec("ROLLBACK"); return err(`FORBIDDEN: '${ACTOR}' is not invited to topic ${a.topicId}`); }
    const dup = db.prepare("SELECT 1 FROM posts WHERE topic_id=? AND round=? AND author=? AND kind='perspective'").get(a.topicId, t.round, ACTOR);
    if (dup) { db.exec("ROLLBACK"); return err(`already posted in round ${t.round} — append-only, one perspective per round`); }
    db.prepare("INSERT INTO posts(id,topic_id,round,author,kind,body,created_at) VALUES (?,?,?,?,'perspective',?,?)")
      .run(randomUUID(), a.topicId, t.round, ACTOR, a.body, ts);
    logEvent(db, { project_id: projectId, actor: ACTOR, kind: "post.add", data: { topicId: a.topicId, round: t.round } });
    db.exec("COMMIT");
    return ok({ topicId: a.topicId, round: t.round, author: ACTOR, kind: "perspective", created_at: ts });
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
});

server.registerTool("topic.synthesize", {
  description: "CHAIR-ONLY (ACTOR === opened_by): write a synthesis post at the current round, optionally bumping to the next round (resets the round clock). Does NOT close — use topic.close to record the decision.",
  inputSchema: { topicId: z.string(), body: z.string().min(1), nextRound: z.boolean().optional() },
}, async (a) => {
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const t = db.prepare("SELECT * FROM topics WHERE id=? AND project_id=?").get(a.topicId, projectId) as TopicRow | undefined;
    if (!t) { db.exec("ROLLBACK"); return err(`no topic ${a.topicId} in ${PROJECT_KEY}`); }
    if (t.status !== "open") { db.exec("ROLLBACK"); return err(`CONFLICT: topic ${a.topicId} is closed`); }
    if (t.opened_by !== ACTOR) { db.exec("ROLLBACK"); return err(`FORBIDDEN: only the chair '${t.opened_by}' may synthesize topic ${a.topicId}`); }
    db.prepare("INSERT INTO posts(id,topic_id,round,author,kind,body,created_at) VALUES (?,?,?,?,'synthesis',?,?)")
      .run(randomUUID(), a.topicId, t.round, ACTOR, a.body, ts);
    let round = t.round;
    if (a.nextRound) { round = t.round + 1; db.prepare("UPDATE topics SET round=?, round_opened_at=? WHERE id=?").run(round, ts, t.id); }
    logEvent(db, { project_id: projectId, actor: ACTOR, kind: "topic.synthesize", data: { topicId: a.topicId, round: t.round, nextRound: !!a.nextRound } });
    db.exec("COMMIT");
    return ok({ topicId: a.topicId, synthesizedRound: t.round, round, status: "open" });
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
});

server.registerTool("topic.close", {
  description: "CHAIR-ONLY (ACTOR === opened_by): close the topic with a terminal decision. The decision is DATA (a recorded conclusion) — it NEVER auto-applies a code/SKILL/conventions change (§17).",
  inputSchema: { topicId: z.string(), decision: z.string().min(1) },
}, async (a) => {
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const t = db.prepare("SELECT * FROM topics WHERE id=? AND project_id=?").get(a.topicId, projectId) as TopicRow | undefined;
    if (!t) { db.exec("ROLLBACK"); return err(`no topic ${a.topicId} in ${PROJECT_KEY}`); }
    if (t.status !== "open") { db.exec("ROLLBACK"); return err(`CONFLICT: topic ${a.topicId} is already closed`); }
    if (t.opened_by !== ACTOR) { db.exec("ROLLBACK"); return err(`FORBIDDEN: only the chair '${t.opened_by}' may close topic ${a.topicId}`); }
    db.prepare("UPDATE topics SET status='closed', decision=?, closed_at=? WHERE id=?").run(a.decision, ts, t.id);
    logEvent(db, { project_id: projectId, actor: ACTOR, kind: "topic.close", data: { topicId: a.topicId, round: t.round } });
    db.exec("COMMIT");
    return ok({ topicId: a.topicId, status: "closed", decision: a.decision, closed_at: ts });
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
});

await server.connect(new StdioServerTransport());
