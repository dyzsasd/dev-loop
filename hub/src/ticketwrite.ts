// dev-loop hub — the single home for ticket/comment writes (DL-29 daemon routes + DL-35 server.ts convergence).
// EVERY ticket INSERT/UPDATE and comment INSERT in the hub lives here (grep: no other src file writes the
// tickets/comments tables). Two callers share these:
//   • the MCP server (server.ts save_issue/save_comment) — the agent write path; it computes its own merge
//     (REPLACE labels, APPEND-only relatedTo, DL-24 assignTo) inside its own BEGIN IMMEDIATE txn, then calls
//     the raw mechanics below to do the write + log the event.
//   • the daemon's opt-in human web-write routes (create/comment/move/assign) — the board write path; the
//     narrow primitives (createTicket/addComment/moveTicket/assignTicket) wrap the same mechanics.
// The mechanics take a WRITABLE connection (NEVER the daemon's query_only read connection) and the caller's
// resolved actor. Attribution + the event-log discipline (logEvent) + the unknown-assignee guard
// (actorExists) + the state set (STATES) are uniform across both paths by construction.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nowIso, nextTicketId, logEvent, actorExists, STATES, type State } from "./db.ts";

export type WriteResult = { ok: true; id: string } | { ok: false; status: number; error: string };

// Fully-resolved column values for a create. The caller resolves defaults/aliases (state, assignee, labels…)
// before calling — the mechanic does no policy, only the write.
export interface NewTicketFields {
  title: string; description: string; type: string; state: string;
  assignee: string | null; priority: number; labels: string[];
  duplicateOf: string | null; relatedTo: string[];
}
// Fully-merged next-row values for an update. labels/related_to are the PRE-SERIALIZED JSON strings exactly as
// stored (the caller owns REPLACE-vs-append policy); duplicate_of is the scalar column value.
export interface TicketUpdateFields {
  title: string; description: string; type: string; state: string;
  assignee: string | null; priority: number;
  labels: string; duplicate_of: string | null; related_to: string;
}
// A stored row, narrowed to the columns an update copies (moveTicket/assignTicket read the row to rewrite it).
type StoredRow = TicketUpdateFields;

const exists = (db: DatabaseSync, projectId: string, id: string): boolean =>
  !!db.prepare("SELECT 1 FROM tickets WHERE id=? AND project_id=?").get(id, projectId);
const rowFor = (db: DatabaseSync, projectId: string, id: string): StoredRow | undefined =>
  db.prepare("SELECT title,description,type,state,assignee,priority,labels,duplicate_of,related_to FROM tickets WHERE id=? AND project_id=?")
    .get(id, projectId) as StoredRow | undefined;

// ─── release/env config + the staging-deploy gate (DL-32 / DL-38, design §7) ──
export interface ReleaseConfig {
  prodPromotionGate?: string;          // DL-32: "human" gates ADDING env:prod (enforced ACTOR-side in server.ts)
  requireDeployBeforeReview?: boolean; // DL-38: the staging-deploy gate (this file)
  deployRepos?: string[];              // DL-38 opt-(a): repos that deploy — match the ticket's repo:<name> label
  hasDeploy?: boolean;                 // DL-38 opt-(a): the single-repo project deploys
}
// Read settings_json.workflow.release fresh (a live, operator-set, opt-in config). Malformed ⇒ {} (fail-open).
export function loadRelease(db: DatabaseSync, projectId: string): ReleaseConfig {
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    const r = (row?.settings_json ? JSON.parse(row.settings_json) : {})?.workflow?.release;
    return r && typeof r === "object" ? r : {};
  } catch { return {}; } // never brick a write on malformed config
}
// DL-38 staging-deploy gate (design §7). Enforced in updateTicketRow below — the shared write path — so it
// covers BOTH the MCP save_issue transition AND the daemon board-move automatically. The In Progress → In
// Review transition is REJECTED when requireDeployBeforeReview is on AND the ticket's repo deploys (its
// repo:<name> ∈ deployRepos, or single-repo hasDeploy) AND it lacks env:dev. A non-deploying repo bypasses
// (carve-out — else docs-only/no-deploy work could never earn env:dev and would deadlock). No ACTOR context.
function stagingDeployRejection(db: DatabaseSync, projectId: string, fromState: string, next: TicketUpdateFields): string | null {
  if (!(fromState === "In Progress" && next.state === "In Review")) return null; // only this edge is gated
  const rel = loadRelease(db, projectId);
  if (rel.requireDeployBeforeReview !== true) return null; // default off ⇒ unchanged behavior
  const labels = JSON.parse(next.labels) as string[];
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  const repoDeploys = repoLabel
    ? Array.isArray(rel.deployRepos) && rel.deployRepos.includes(repoLabel.slice(5))
    : rel.hasDeploy === true; // single-repo (no repo:<name> label)
  if (!repoDeploys) return null;                // carve-out: a non-deploying repo never needs env:dev (no deadlock)
  if (labels.includes("env:dev")) return null;  // gate satisfied — staged
  return `staging-deploy gate: In Progress → In Review requires env:dev (this repo deploys and requireDeployBeforeReview is on)`;
}

// DL-77 verify gate (the Ralph-Wiggum guard). Enforced in updateTicketRow below — the SAME single-choke-point
// placement as stagingDeployRejection — so it covers BOTH the MCP save_issue transition AND the daemon board-move
// automatically. The maker-self-accept edge In Progress → Done is REJECTED: Done is the OWNER's verdict and must
// be reached via In Review (owner verification). Every OTHER path to Done stays legal — In Review → Done (the
// verified close), Todo → Done / Backlog → Done (the §9a intake parent-close, which MUST stay legal or it breaks
// PM's grooming), and In Progress → Canceled/Duplicate (terminal, NOT Done). Unlike the DL-38 gate this is
// UNCONDITIONAL (no opt-in config): "Done means verified" is a §3 loop invariant, not an operator preference.
function verifyGateRejection(fromState: string, next: TicketUpdateFields): string | null {
  if (fromState === "In Progress" && next.state === "Done")
    return `verify gate: In Progress → Done is not allowed — Done must be reached via In Review (owner verification); move to In Review first`;
  return null; // every other transition is the caller's concern
}

// ─── the raw mechanics: the ONLY tickets/comments writers in the hub ──────────

// THE ticket INSERT. Allocates the id, writes all 14 columns, logs issue.create. `createEventData` is passed
// in so each caller logs exactly what it logged before this convergence (the MCP path logs the RAW {title,type}
// — type possibly undefined when omitted — which differs from the resolved type written to the row).
export function insertTicket(
  db: DatabaseSync, projectId: string, actor: string, f: NewTicketFields, createEventData: Record<string, unknown>,
): string {
  const id = nextTicketId(db, projectId);
  const t = nowIso();
  db.prepare(`INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,duplicate_of,related_to,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, f.title, f.description, f.type, f.state, f.assignee, f.priority, JSON.stringify(f.labels), f.duplicateOf, JSON.stringify(f.relatedTo), actor, t, t);
  logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.create", data: createEventData });
  return id;
}

// THE ticket UPDATE — the post-DL-35 converged "applyTicketWrite" path. Enforces the transition gates FIRST
// (the DL-38 staging-deploy gate + the DL-77 verify gate — so both the MCP save_issue transition and the daemon
// board-move are covered automatically), then writes the caller-merged `next` row and logs issue.transition (with the resolved assignee) on a real
// state change else issue.update. TXN-AGNOSTIC: it never BEGINs/COMMITs — the MCP's atomic read-merge-write
// txn (and the daemon's single-op writes) stay the caller's concern; a gate rejection writes NOTHING.
export function updateTicketRow(
  db: DatabaseSync, projectId: string, actor: string, id: string, fromState: string, next: TicketUpdateFields,
): WriteResult {
  const gate = stagingDeployRejection(db, projectId, fromState, next) ?? verifyGateRejection(fromState, next);
  if (gate) return { ok: false, status: 400, error: gate };
  const t = nowIso();
  db.prepare(`UPDATE tickets SET title=?,description=?,type=?,state=?,assignee=?,priority=?,labels=?,duplicate_of=?,related_to=?,updated_at=? WHERE id=? AND project_id=?`)
    .run(next.title, next.description, next.type, next.state, next.assignee, next.priority, next.labels, next.duplicate_of, next.related_to, t, id, projectId);
  logEvent(db, next.state !== fromState
    ? { project_id: projectId, ticket_id: id, actor, kind: "issue.transition", data: { from: fromState, to: next.state, assignee: next.assignee } }
    : { project_id: projectId, ticket_id: id, actor, kind: "issue.update", data: {} });
  return { ok: true, id };
}

// THE comment INSERT. Mechanic only — existence/body policy is the caller's. Returns the new id + timestamp
// (the MCP echoes them back to the caller). Body is operator/agent DATA — stored verbatim, esc()'d at render
// (never a command-verb parser, never a channel scrub).
export function insertComment(
  db: DatabaseSync, projectId: string, actor: string, ticketId: string, body: string,
): { id: string; createdAt: string } {
  const id = randomUUID();
  const t = nowIso();
  db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES (?,?,?,?,?)").run(id, ticketId, actor, body, t);
  logEvent(db, { project_id: projectId, ticket_id: ticketId, actor, kind: "comment.add", data: {} });
  return { id, createdAt: t };
}

// ─── daemon human-write primitives: narrow wrappers over the mechanics above ──

// Create a Todo ticket (no labels/assignee by default — a human can move/assign/label it after).
export function createTicket(
  db: DatabaseSync, projectId: string, actor: string,
  a: { title: string; description?: string; type?: string },
): WriteResult {
  const title = (a.title ?? "").trim();
  if (!title) return { ok: false, status: 400, error: "title required" };
  const type = a.type ?? "Feature";
  const id = insertTicket(db, projectId, actor,
    { title, description: a.description ?? "", type, state: "Todo", assignee: null, priority: 0, labels: [], duplicateOf: null, relatedTo: [] },
    { title, type });
  return { ok: true, id };
}

// Add a comment (author = actor). A web form must not post an empty body → 400 (the MCP agent path does not
// enforce this; the guard is the daemon's policy, the INSERT mechanic is shared).
export function addComment(db: DatabaseSync, projectId: string, actor: string, id: string, body: string): WriteResult {
  if (!exists(db, projectId, id)) return { ok: false, status: 404, error: `no such ticket ${id}` };
  if (!(body ?? "").trim()) return { ok: false, status: 400, error: "comment body required" };
  insertComment(db, projectId, actor, id, body);
  return { ok: true, id };
}

// Move a ticket to a new state. Honors the STATES set (the tickets.state CHECK's mirror) — an unknown state is
// rejected, never written. A deliberate single-field intent: it reads the row and rewrites it with only `state`
// changed (so the shared UPDATE mechanic does the write). Does NOT apply the DL-24 assignTo directive — a human
// board move is an explicit state set (that directive is the agent save_issue path's).
export function moveTicket(db: DatabaseSync, projectId: string, actor: string, id: string, toState: string): WriteResult {
  if (!STATES.includes(toState as State)) return { ok: false, status: 400, error: `invalid state '${toState}'; one of ${STATES.join(", ")}` };
  const cur = rowFor(db, projectId, id);
  if (!cur) return { ok: false, status: 404, error: `no such ticket ${id}` };
  return updateTicketRow(db, projectId, actor, id, cur.state, { ...cur, state: toState }); // propagates the DL-38 gate
}

// Assign (or unassign) a ticket. Empty/whitespace → unassigned (null); a non-empty handle must be a known actor
// (mirrors the MCP unknown-assignee guard) — no "me" alias here (a web form names a handle). Reads the row and
// rewrites it with only `assignee` changed (state unchanged ⇒ the shared mechanic logs issue.update).
export function assignTicket(db: DatabaseSync, projectId: string, actor: string, id: string, assignee: string): WriteResult {
  const cur = rowFor(db, projectId, id);
  if (!cur) return { ok: false, status: 404, error: `no such ticket ${id}` };
  const raw = (assignee ?? "").trim();
  const resolved = raw === "" ? null : raw;
  if (resolved !== null && !actorExists(db, resolved)) return { ok: false, status: 400, error: `unknown assignee '${resolved}'` };
  return updateTicketRow(db, projectId, actor, id, cur.state, { ...cur, assignee: resolved }); // assignee-only ⇒ no transition ⇒ gate never fires
}
