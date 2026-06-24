// dev-loop hub — shared ticket-write primitives (DL-29 / design §11 subsystem D).
// The daemon's opt-in human web-write routes (create/comment/move/assign) call these so a board-driven
// write is behaviourally identical to an agent-driven one: the SAME state set (STATES), the SAME
// attribution + event-log discipline (logEvent), the SAME unknown-assignee guard (actorExists). They take
// a WRITABLE connection — NEVER the daemon's query_only read connection — and the caller's resolved actor.
//
// NOTE (convergence, tracked follow-up): the MCP server's `save_issue`/`save_comment` (server.ts) still
// hold their own inline write logic; these primitives are the single home both should eventually share.
// They mirror that logic here so the daemon path is correct today; folding server.ts onto them is a
// separate, test-guarded refactor (it surgery's the loop's core SoR write path, so it earns its own fire).
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nowIso, nextTicketId, logEvent, actorExists, STATES, type State } from "./db.ts";

export type WriteResult = { ok: true; id: string } | { ok: false; status: number; error: string };

const exists = (db: DatabaseSync, projectId: string, id: string): boolean =>
  !!db.prepare("SELECT 1 FROM tickets WHERE id=? AND project_id=?").get(id, projectId);

// Create a Todo ticket (no labels/assignee by default — a human can move/assign/label it after). Mirrors
// the MCP create branch: id from nextTicketId, created_by = actor, an issue.create event.
export function createTicket(
  db: DatabaseSync, projectId: string, actor: string,
  a: { title: string; description?: string; type?: string },
): WriteResult {
  const title = (a.title ?? "").trim();
  if (!title) return { ok: false, status: 400, error: "title required" };
  const type = a.type ?? "Feature";
  const id = nextTicketId(db, projectId);
  const t = nowIso();
  db.prepare(`INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,duplicate_of,related_to,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, title, a.description ?? "", type, "Todo", null, 0, JSON.stringify([]), null, JSON.stringify([]), actor, t, t);
  logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.create", data: { title, type } });
  return { ok: true, id };
}

// Add a comment (author = actor). Body is operator DATA — stored verbatim, esc()'d at render (never a
// command-verb parser, never a channel scrub). Mirrors the MCP save_comment.
export function addComment(db: DatabaseSync, projectId: string, actor: string, id: string, body: string): WriteResult {
  if (!exists(db, projectId, id)) return { ok: false, status: 404, error: `no such ticket ${id}` };
  if (!(body ?? "").trim()) return { ok: false, status: 400, error: "comment body required" };
  const cid = randomUUID(); const t = nowIso();
  db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES (?,?,?,?,?)").run(cid, id, actor, body, t);
  logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "comment.add", data: {} });
  return { ok: true, id };
}

// Move a ticket to a new state. Honors the STATES set (the tickets.state CHECK's mirror) — an unknown
// state is rejected, never written. A real transition logs issue.transition (else issue.update). This is
// a deliberate single-field write: it does NOT apply the DL-24 assignTo directive (that is the agent
// save_issue path; a human board move is an explicit state set). Transition-guard parity rides "the
// engine" (AC2: "if/when the engine lands").
export function moveTicket(db: DatabaseSync, projectId: string, actor: string, id: string, toState: string): WriteResult {
  if (!STATES.includes(toState as State)) return { ok: false, status: 400, error: `invalid state '${toState}'; one of ${STATES.join(", ")}` };
  const cur = db.prepare("SELECT state FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as { state: string } | undefined;
  if (!cur) return { ok: false, status: 404, error: `no such ticket ${id}` };
  const t = nowIso();
  db.prepare("UPDATE tickets SET state=?,updated_at=? WHERE id=? AND project_id=?").run(toState, t, id, projectId);
  logEvent(db, cur.state !== toState
    ? { project_id: projectId, ticket_id: id, actor, kind: "issue.transition", data: { from: cur.state, to: toState } }
    : { project_id: projectId, ticket_id: id, actor, kind: "issue.update", data: {} });
  return { ok: true, id };
}

// Assign (or unassign) a ticket. Empty/whitespace → unassigned (null); a non-empty handle must be a known
// actor (mirrors the MCP unknown-assignee guard) — no "me" alias here (a web form names a handle).
export function assignTicket(db: DatabaseSync, projectId: string, actor: string, id: string, assignee: string): WriteResult {
  if (!exists(db, projectId, id)) return { ok: false, status: 404, error: `no such ticket ${id}` };
  const raw = (assignee ?? "").trim();
  const resolved = raw === "" ? null : raw;
  if (resolved !== null && !actorExists(db, resolved)) return { ok: false, status: 400, error: `unknown assignee '${resolved}'` };
  const t = nowIso();
  db.prepare("UPDATE tickets SET assignee=?,updated_at=? WHERE id=? AND project_id=?").run(resolved, t, id, projectId);
  logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.update", data: {} });
  return { ok: true, id };
}
