// dev-loop hub — the 5 CORE ticket ops as plain functions, for the DL-43 daemon agent op-API (/api/op/*).
//
// This MIRRORS the stdio MCP server's handlers (server.ts: list_issues / get_issue / save_issue /
// save_comment / list_comments) 1:1 — same filters, the same REPLACE-style labels + APPEND-only relatedTo
// merge, the DL-24 per-transition assignTo directive, and the DL-32 prod-promotion gate — reusing the
// shared ticketwrite.ts mechanics (DL-35) so the op-API behaves IDENTICALLY to the stdio server. server.ts
// stays the canonical stdio transport, 100% UNTOUCHED by DL-43 (its AC); this is the additive daemon-side
// mirror that P2's thin stdio shim will proxy to. The two policy copies are deliberately duplicated here
// (server.ts can't be edited this increment) — converging them onto this module is the sequenced P2/(2-n)
// follow-up (the "dispatch-sharing refactor", design §40). Until then, a change to save_issue policy must
// land in BOTH files; this header is the tripwire.
//
// Each function takes a hub connection + the caller's already-resolved+validated actor (the daemon resolves
// it from the X-Devloop-Actor header and the G1 phantom-actor guard BEFORE calling here) and returns an
// HTTP-shaped { status, body } the daemon serializes as JSON — the same payloads the stdio path returns via
// ok()/err(), with err() mapped to the right HTTP status. NO env read, NO mode gate, NO transport here: the
// daemon op-API layer owns the endpoint pipeline (writeOriginOk → actor → mode-honoring); this module is
// pure ticket policy, exactly like the stdio handlers.
import { DatabaseSync } from "node:sqlite";
import { actorExists, logEvent, STATES, type State, type Ticket } from "./db.ts";
import { insertTicket, updateTicketRow, insertComment, loadRelease } from "./ticketwrite.ts";

export interface OpResult { status: number; body: unknown }
const okR = (body: unknown): OpResult => ({ status: 200, body });
const errR = (status: number, error: string): OpResult => ({ status, body: { error } });

// The 5 core ticket ops served this increment (doc.*/topic.*/channel.*/mirror.* are later increments).
export const AGENT_OPS = ["list_issues", "get_issue", "save_issue", "save_comment", "list_comments"] as const;
export type AgentOp = (typeof AGENT_OPS)[number];
// The MUTATING subset — the daemon applies writeOriginOk + the dry-run mode gate to exactly these (reads
// never mutate, so they bypass both). Kept here next to AGENT_OPS so the two lists can't drift.
export const AGENT_WRITE_OPS = new Set<AgentOp>(["save_issue", "save_comment"]);
export const isAgentOp = (s: string): s is AgentOp => (AGENT_OPS as readonly string[]).includes(s);

// ─── row → API shape + readers (verbatim mirror of server.ts toTicket/getRow) ──
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
const getRow = (db: DatabaseSync, projectId: string, id: string): TicketRow | undefined =>
  db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as TicketRow | undefined;
// "me" → the caller's actor (the per-agent attribution win); empty/whitespace → unassigned; else verbatim.
const resolveAssignee = (actor: string, a: string | null | undefined): string | null =>
  a === undefined || a === null ? null
  : a === "me" ? actor
  : a.trim() === "" ? null
  : a;

// ─── DL-24 per-transition assignTo directive (mirror of server.ts) ─────────────
const ownerHandleOf = (labels: string[]): string | null =>
  labels.includes("pm") ? "pm" : labels.includes("qa") ? "qa" : null;
function loadTransitions(db: DatabaseSync, projectId: string): Record<string, { assignTo?: string | null }> {
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    const tr = (row?.settings_json ? JSON.parse(row.settings_json) : {})?.workflow?.transitions;
    return tr && typeof tr === "object" ? tr : {};
  } catch { return {}; } // malformed config ⇒ absent (fail-open), never bricks a write
}
function resolveAssignTo(db: DatabaseSync, projectId: string, actor: string, from: string, to: string, labels: string[]): string | null {
  const dir = loadTransitions(db, projectId)[`${from}->${to}`];
  if (!dir || dir.assignTo === undefined || dir.assignTo === null) return null;
  const v = dir.assignTo;
  if (v === "owner") {
    const o = ownerHandleOf(labels);
    if (!o) console.error(`[assignTo] ${from}->${to}: owner directive but ticket has no pm/qa label — assignee left untouched`);
    return o;
  }
  if (v === "self") return actor;
  if (actorExists(db, v)) return v;
  console.error(`[assignTo] ${from}->${to}: unknown handle '${v}' — assignee left untouched`);
  return null;
}

// ─── DL-32 prod-promotion gate (mirror of server.ts) ───────────────────────────
const ENV_LABELS = ["env:dev", "env:prod"];
const envLabelsOf = (labels: string[]): string[] => labels.filter((l) => ENV_LABELS.includes(l)).sort();
function prodPromotionRejection(db: DatabaseSync, projectId: string, actor: string, oldLabels: string[], newLabels: string[]): string | null {
  if (loadRelease(db, projectId).prodPromotionGate !== "human") return null;
  const adding = newLabels.includes("env:prod") && !oldLabels.includes("env:prod");
  return adding && actor !== "operator"
    ? `env:prod promotion is human-gated (prodPromotionGate:"human"): only the operator may add env:prod`
    : null;
}

// ─── the 5 ops ─────────────────────────────────────────────────────────────────

export interface ListIssuesArgs { state?: string; assignee?: string; type?: string; label?: string; labels?: string[]; query?: string; limit?: number }
function opListIssues(db: DatabaseSync, projectId: string, actor: string, a: ListIssuesArgs): OpResult {
  let out = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY updated_at DESC").all(projectId) as TicketRow[]).map(toTicket);
  if (a.state) out = out.filter((t) => t.state === a.state);
  if (a.assignee) out = out.filter((t) => t.assignee === resolveAssignee(actor, a.assignee));
  if (a.type) out = out.filter((t) => t.type === a.type);
  const want = [...(a.labels ?? []), ...(a.label ? [a.label] : [])];
  if (want.length) out = out.filter((t) => want.every((l) => t.labels.includes(l)));
  if (a.query) { const q = a.query.toLowerCase(); out = out.filter((t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)); }
  return okR(a.limit ? out.slice(0, a.limit) : out);
}

function opGetIssue(db: DatabaseSync, projectId: string, projectKey: string, a: { id?: string }): OpResult {
  if (!a.id) return errR(400, "id required");
  const r = getRow(db, projectId, a.id);
  if (!r) return errR(404, `no such ticket ${a.id} in ${projectKey}`);
  const comments = db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(a.id);
  return okR({ ...toTicket(r), comments });
}

export interface SaveIssueArgs {
  id?: string; title?: string; description?: string; type?: string; state?: string;
  assignee?: string | null; priority?: number; labels?: string[]; duplicateOf?: string | null; relatedTo?: string[];
}
// MIRRORS server.ts save_issue exactly: validate → create (insertTicket) OR update (atomic read-merge-write
// under BEGIN IMMEDIATE: REPLACE labels, APPEND-only relatedTo union, DL-24 assignTo, DL-32 promo gate, the
// DL-38 staging gate inside updateTicketRow, the issue.promote env event). `db` MUST be a WRITABLE connection.
function opSaveIssue(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: SaveIssueArgs): OpResult {
  // Input validation the stdio path gets from its zod schema (server.ts) — the op-API parses raw JSON, so it
  // re-checks the SAME shapes by hand. The array fields are load-bearing: a non-array labels/relatedTo would
  // be JSON.stringify'd into the column and later crash a `t.labels.includes()` / `[...]` spread (a 500
  // poison-pill on every subsequent list_issues), so reject them up front — matching zod's array-of-strings.
  const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (a.labels !== undefined && !isStrArr(a.labels)) return errR(400, "labels must be an array of strings");
  if (a.relatedTo !== undefined && !isStrArr(a.relatedTo)) return errR(400, "relatedTo must be an array of strings");
  if (a.priority !== undefined && (typeof a.priority !== "number" || !Number.isInteger(a.priority) || a.priority < 0 || a.priority > 4)) return errR(400, `invalid priority; an integer 0..4`);
  if (a.state && !STATES.includes(a.state as State)) return errR(400, `invalid state '${a.state}'; one of ${STATES.join(", ")}`);
  if (a.assignee && a.assignee !== "me" && !actorExists(db, a.assignee)) return errR(400, `unknown assignee '${a.assignee}' (or "me"/null)`);
  if (!a.id) {
    if (!a.title) return errR(400, "title required to create a ticket");
    const promoReject = prodPromotionRejection(db, projectId, actor, [], a.labels ?? []);
    if (promoReject) return errR(403, promoReject);
    const id = insertTicket(db, projectId, actor,
      { title: a.title, description: a.description ?? "", type: a.type ?? "Feature", state: (a.state as State) ?? "Todo",
        assignee: resolveAssignee(actor, a.assignee), priority: a.priority ?? 0, labels: a.labels ?? [],
        duplicateOf: a.duplicateOf ?? null, relatedTo: a.relatedTo ?? [] },
      { title: a.title, type: a.type });
    return okR(toTicket(getRow(db, projectId, id)!));
  }
  // update — atomic read-merge-write (the APPEND-only relatedTo union must not lose a concurrent link).
  db.exec("BEGIN IMMEDIATE");
  try {
    const cur = getRow(db, projectId, a.id);
    if (!cur) { db.exec("ROLLBACK"); return errR(404, `no such ticket ${a.id} in ${projectKey}`); }
    const next = {
      title: a.title ?? cur.title, description: a.description ?? cur.description, type: a.type ?? cur.type,
      state: (a.state as State) ?? cur.state,
      assignee: a.assignee === undefined ? cur.assignee : resolveAssignee(actor, a.assignee),
      priority: a.priority ?? cur.priority,
      labels: a.labels ? JSON.stringify(a.labels) : cur.labels,                                    // REPLACE-style (§10#1)
      duplicate_of: a.duplicateOf === undefined ? cur.duplicate_of : a.duplicateOf,                 // scalar; undefined=keep
      related_to: a.relatedTo                                                                       // APPEND-only union (§18)
        ? JSON.stringify([...new Set([...(JSON.parse(cur.related_to) as string[]), ...a.relatedTo])])
        : cur.related_to,
    };
    if (next.state !== cur.state && a.assignee === undefined) {                                     // DL-24 assignTo (implicit assignee only)
      const resolved = resolveAssignTo(db, projectId, actor, cur.state, next.state, JSON.parse(next.labels) as string[]);
      if (resolved !== null) next.assignee = resolved;
    }
    const oldLabels = JSON.parse(cur.labels) as string[], newLabels = JSON.parse(next.labels) as string[];
    const promoReject = prodPromotionRejection(db, projectId, actor, oldLabels, newLabels);         // DL-32 prod gate
    if (promoReject) { db.exec("ROLLBACK"); return errR(403, promoReject); }
    const wr = updateTicketRow(db, projectId, actor, a.id, cur.state, next);                        // DL-38 staging gate inside ⇒ may reject
    if (!wr.ok) { db.exec("ROLLBACK"); return errR(wr.status, wr.error); }
    const fromEnv = envLabelsOf(oldLabels).join(","), toEnv = envLabelsOf(newLabels).join(",");     // DL-32 issue.promote on env change
    if (fromEnv !== toEnv) logEvent(db, { project_id: projectId, ticket_id: a.id, actor, kind: "issue.promote", data: { from: fromEnv, to: toEnv } });
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
  return okR(toTicket(getRow(db, projectId, a.id)!));
}

// `db` MUST be a WRITABLE connection (the comment INSERT + comment.add event go through insertComment).
function opSaveComment(db: DatabaseSync, projectId: string, actor: string, a: { issueId?: string; body?: string }): OpResult {
  if (!a.issueId) return errR(400, "issueId required");
  if (typeof a.body !== "string") return errR(400, "body required");
  if (!getRow(db, projectId, a.issueId)) return errR(404, `no such ticket ${a.issueId}`);
  const { id, createdAt } = insertComment(db, projectId, actor, a.issueId, a.body);
  return okR({ id, ticket_id: a.issueId, author: actor, body: a.body, created_at: createdAt });
}

function opListComments(db: DatabaseSync, projectId: string, projectKey: string, a: { issueId?: string }): OpResult {
  if (!a.issueId) return errR(400, "issueId required");
  if (!getRow(db, projectId, a.issueId)) return errR(404, `no such ticket ${a.issueId} in ${projectKey}`);
  return okR(db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(a.issueId));
}

// Dispatch one op. `db` is the WRITABLE connection for the write ops (save_issue/save_comment) and may be
// the daemon's query_only read connection for the read ops — the daemon passes the right one per op. `actor`
// is already resolved+validated by the daemon (the G1 guard). `args` is the parsed JSON body (a non-object
// body is normalized to {} by the caller). Throws only on a genuine DB fault (→ the daemon's 500 catch).
export function agentOp(op: AgentOp, db: DatabaseSync, projectId: string, projectKey: string, actor: string, args: Record<string, unknown>): OpResult {
  switch (op) {
    case "list_issues": return opListIssues(db, projectId, actor, args as ListIssuesArgs);
    case "get_issue": return opGetIssue(db, projectId, projectKey, args as { id?: string });
    case "save_issue": return opSaveIssue(db, projectId, projectKey, actor, args as SaveIssueArgs);
    case "save_comment": return opSaveComment(db, projectId, actor, args as { issueId?: string; body?: string });
    case "list_comments": return opListComments(db, projectId, projectKey, args as { issueId?: string });
  }
}
