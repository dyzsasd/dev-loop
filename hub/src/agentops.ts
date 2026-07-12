// dev-loop hub — the agent op-API ops as plain functions: the SINGLE definition of every ticket/read policy
// the hub exposes. BOTH transports dispatch through these: the DL-43 daemon agent op-API (/api/op/*) and —
// since DL-69 (the dispatch-sharing refactor) — the stdio MCP server (server.ts), whose op-backed tool
// handlers (TOOL_NAMES minus whoami) are now thin call-throughs to agentOp() (server.ts's toMcp() maps
// {status,body}→MCP ok()/err()).
// So each policy — the read SELECTs, the save_issue/save_comment orchestration (the DL-24 per-transition
// assignTo + the DL-32 prod-promotion gate + the REPLACE-labels/APPEND-relatedTo merge), and the doc/
// channel/mirror/label families (which also reuse the shared ticketwrite/docstore/channelstore/
// mirrorstore/labelstore) — has EXACTLY ONE definition. The old "edit both files" drift tripwire is RETIRED:
// a change to any policy now lands in ONE place, and the differential-parity suite (test/shim.ts +
// test/agent-api.ts, shim ≡ stdio for all 25 tools) is the structural guard against a future re-divergence.
//
// Each function takes a hub connection + the caller's already-resolved+validated actor (server.ts resolves it
// from DEVLOOP_ACTOR + the G1 phantom-actor guard; the daemon from the X-Devloop-Actor header) and returns an
// HTTP-shaped { status, body }: the daemon serializes it as JSON; server.ts's toMcp() maps it to ok()/err()
// (a 200 → ok(body); a non-200 → err(body.error)). NO env read, NO mode gate, NO transport here — each
// transport owns its own pipeline (server.ts the stdio identity; the daemon op-API writeOriginOk → actor →
// mode-honoring) AROUND these pure-policy ops. (Only whoami stays native in server.ts — transport-specific
// identity, not an op. create_issue_label was the last native override; it now dispatches through here too,
// so its label.create attribution event fires identically on both transports.)
import { DatabaseSync } from "node:sqlite";
import { TOOL_NAMES, type ToolName } from "./tooldefs.ts"; // DL-85: the ONE tool/op name source; AGENT_OPS derives from it
import { STEWARD_HANDLES } from "./seed.ts"; // D1: the steward roster (ONE definition, next to AGENT_HANDLES) the override matrix grants cross-project access to
import { TEAM_INTAKE_PROJECT } from "./team-config.ts"; // D1: the reserved "_team" intake key — the only override pm may pass
import { actorExists, listActorHandles, logEvent, unifiedDiff, STATES, type State, type Ticket } from "./db.ts";
import { insertTicket, updateTicketRow, insertComment, loadRelease } from "./ticketwrite.ts";
// DL-62 doc/event family — the doc WRITES (docSave/docPublish, incl. the CAS + the single operator-publish
// gate) + the docstore-error→HTTP-status map are reused VERBATIM from the shared, side-effect-free docstore
// (exactly as the 5 ticket ops reuse ticketwrite.ts), so both transports share one publish gate + one CAS.
// The doc READS (doc.list/get/history/diff) + list_events are the SINGLE definition of those SELECTs — since
// DL-69 server.ts's handlers dispatch through them (no longer a 1:1 duplicate of a server.ts copy).
import { resolveDoc, latestVersion, docSave, docPublish, docArchive, statusForDocErr, DOC_KINDS, type DocSaveArgs, type DocPublishArgs, type DocArchiveArgs } from "./docstore.ts";
// DL-67 channel family — the channel register/send/poll/ack/status HANDLER logic + the DL-4 roadmap bridge are
// reused VERBATIM from the shared, side-effect-free channelstore (exactly as the doc family reuses
// docstore), so the op-API and the stdio server.ts can never drift. channel.send/poll are ASYNC
// (network/dryrun), so agentOp returns OpResult|Promise<OpResult> and the daemon awaits it. The op-API parses
// raw JSON → each handler hand-validates the shapes server.ts gets from zod (DL-63: a non-string arg → 400, never a 500).
import { channelRegister, channelSend, channelPoll, channelAck, channelStatus, statusForChannelErr,
  type ChannelRegisterArgs, type ChannelSendArgs, type ChannelAckArgs } from "./channelstore.ts";
// DL-68 P7 mirror + label/project — the FINAL slice. mirror.push's handler (reusing linear.ts's transport AS-IS)
// + mirror.status are reused VERBATIM from the shared mirrorstore (so the op-API + server.ts can't drift on the
// DL-11 DRYRUN invariant / reconcile-by-marker idempotency), and the label/project ops + the SINGLE LABEL_KINDS /
// DL-22 reject from labelstore. mirror.push is ASYNC (Linear network / dryrun build) → agentOp returns a Promise.
import { mirrorPush, mirrorStatus, mirrorPollComments, type MirrorPushArgs, type MirrorPollArgs } from "./mirrorstore.ts";
import { createLabel, listLabels, getProject } from "./labelstore.ts";

export interface OpResult { status: number; body: unknown }
const okR = (body: unknown): OpResult => ({ status: 200, body });
// `extra` rides alongside `error` in the body (e.g. doc.save's CONFLICT latestVersion/latestAuthor/hint) —
// the daemon serializes the body verbatim and server.ts/shim.ts spread it into the MCP error, so a caller
// can recover mechanically instead of parsing the prose. It must not carry an `error` key of its own.
const errR = (status: number, error: string, extra?: Record<string, unknown>): OpResult => ({ status, body: { error, ...extra } });

// The ops served by the op-API: the 5 core ticket ops + (DL-62) the doc/event family + (DL-67) the IM channel
// + (DL-68) mirror.* + the label/project ops — the op-API mirrors ALL 25 server.ts tools 1:1 (the shim is a
// 100% drop-in). The op names are the `/api/op/<op>` path segments and the MCP tool names (dotted for the
// doc/channel/mirror families). DL-85: they are EXACTLY TOOL_NAMES minus "whoami"
// (the only tool answered locally per-transport, never an op) — DERIVED from the one source so there is no
// second name copy here (the tool {name,description,inputSchema} triples live once in tooldefs.ts).
export type AgentOp = Exclude<ToolName, "whoami">;
export const AGENT_OPS: readonly AgentOp[] = TOOL_NAMES.filter((n): n is AgentOp => n !== "whoami");
// The MUTATING subset — the daemon applies writeOriginOk + the dry-run mode gate to exactly these (reads
// never mutate, so they bypass both). Kept here next to AGENT_OPS so the two lists can't drift. doc.save /
// doc.publish join the ticket writes; the doc/event reads stay read-only (parity with the read ticket ops).
export const AGENT_WRITE_OPS = new Set<AgentOp>(["save_issue", "save_comment", "doc.save", "doc.publish", "doc.archive", // D6: the archived-flag flip mutates the documents row
  "channel.register", "channel.send", "channel.poll", "channel.ack", // DL-67: the 4 channel writes (register/send/poll/ack mutate the channels/channel_messages tables); channel.status stays a read (query_only)
  "mirror.push", "mirror.pollComments", "create_issue_label"]); // DL-68/D5: the 3 writes (mirror.push → mirror_map + the one-way Linear network write; mirror.pollComments → needs-pm intake tickets + the machine-local acted-ledger; create_issue_label → labels). mirror.status/list_issue_labels/get_project stay reads (query_only)
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

// Shared input-shape guard: a JSON array whose every element is a string — mirrors zod's z.array(z.string()).
// The op-API parses raw JSON (no zod), so list_issues + save_issue both re-check `labels` by hand with this
// (a non-array would crash a `[...]` spread or be JSON.stringify'd into the column → a 500); one definition the
// two ops share so they can't drift (DL-65 hoisted opSaveIssue's original local helper to module scope).
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export interface ListIssuesArgs { state?: string; assignee?: string; type?: string; label?: string; labels?: string[]; query?: string; relatedTo?: string; updatedSince?: string; fields?: string; limit?: number }
function opListIssues(db: DatabaseSync, projectId: string, actor: string, a: ListIssuesArgs): OpResult {
  // Re-validate the raw-JSON arg shapes the stdio path gets from zod (server.ts: query/assignee
  // z.string().optional(), labels z.array(z.string()).optional()). Without this a non-string `query`
  // (.toLowerCase() below), a non-array `labels` (the [...] spread below), or a non-string truthy `assignee`
  // (resolveAssignee → .trim()) throws a TypeError → the daemon's catch → an HTTP 500 echoing the raw JS error,
  // where the zod path returns a clean 400. Same guard class as opSaveIssue's labels / the doc-READ selectors
  // (docSelectorErr, DL-63) — the last unguarded read op (DL-65). state/type/label are compared (never bound or
  // method-called), so they keep today's behavior and need no guard.
  if (a.query !== undefined && typeof a.query !== "string") return errR(400, "query must be a string");
  if (a.labels !== undefined && !isStrArr(a.labels)) return errR(400, "labels must be an array of strings");
  if (a.assignee !== undefined && typeof a.assignee !== "string") return errR(400, "assignee must be a string");
  if (a.relatedTo !== undefined && typeof a.relatedTo !== "string") return errR(400, "relatedTo must be a string");
  if (a.updatedSince !== undefined && typeof a.updatedSince !== "string") return errR(400, "updatedSince must be an ISO string");
  if (a.fields !== undefined && a.fields !== "full" && a.fields !== "summary") return errR(400, "fields must be 'full' or 'summary'");
  // Push the equality filters (state/type/assignee) into SQL — byte-identical result set to the old
  // load-all-then-JS-filter, but fewer rows scanned + JSON.parsed per call. The (project_id, updated_at DESC)
  // index serves the ORDER BY without a temp B-tree. label/query stay in JS (need parsed JSON / substring);
  // LIMIT stays in JS because a label/query filter can reduce the count after SQL.
  const where = ["project_id=?"]; const binds: (string | null)[] = [projectId];
  if (a.state) { where.push("state=?"); binds.push(a.state); }
  if (a.type) { where.push("type=?"); binds.push(a.type); }
  if (a.assignee) { const who = resolveAssignee(actor, a.assignee); where.push(who === null ? "assignee IS NULL" : "assignee=?"); if (who !== null) binds.push(who); }
  if (a.updatedSince) { where.push("updated_at>=?"); binds.push(a.updatedSince); } // incremental board reads
  // L5: search is pushed to SQL — LIKE over title/description PLUS an EXISTS over comments(body), so the §8
  // dedup query catches a reworded duplicate whose only match is in a comment (e.g. a "review failed:" note).
  // Whitespace splits the query into AND-ed terms (a multi-noun query like "daemon health probe" matches only
  // tickets hitting every term). SQLite LIKE is case-insensitive for ASCII; %/_/\ in a term are escaped so a
  // literal % can't act as a wildcard.
  if (a.query && a.query.trim()) {
    for (const term of a.query.trim().split(/\s+/)) {
      const like = `%${term.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM comments c WHERE c.ticket_id=tickets.id AND c.body LIKE ? ESCAPE '\\'))");
      binds.push(like, like, like);
    }
  }
  let out = (db.prepare(`SELECT * FROM tickets WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`).all(...binds) as unknown as TicketRow[]).map(toTicket);
  const want = [...(a.labels ?? []), ...(a.label ? [a.label] : [])];
  if (want.length) out = out.filter((t) => want.every((l) => t.labels.includes(l)));
  if (a.relatedTo) out = out.filter((t) => t.relatedTo.includes(a.relatedTo!)); // L1: e.g. a design parent's staged children
  // L3: a default cap of 250 (the schema max) bounds a pathological unbounded read without regressing any
  // realistic board (which returned everything before); an explicit limit still wins. fields:"summary" drops
  // the description body — the bulk of the bytes (a 26-ticket board was ~100KB of descriptions) — for a
  // cheap board scan; the full body stays on get_issue.
  out = out.slice(0, a.limit ?? 250);
  if (a.fields === "summary") out = out.map((t) => ({ ...t, description: "" }));
  return okR(out);
}

function opGetIssue(db: DatabaseSync, projectId: string, projectKey: string, a: { id?: string }): OpResult {
  if (a.id === undefined) return errR(400, "id required"); // === undefined, NOT falsy: a zod-valid empty-string id ("" passes the bare z.string()) must fall through to the not-found lookup, byte-identical to the pre-DL-69 native handler; this guard exists only to stop an undefined → node:sqlite bind-crash
  const r = getRow(db, projectId, a.id);
  if (!r) return errR(404, `no such ticket ${a.id} in ${projectKey}`);
  const comments = db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(a.id);
  // L1: reverse of relatedTo — the tickets that point AT this one (a design parent sees its staged children;
  // a bug sees its coverage follow-up). related_to is a JSON array, so match the quoted id as a substring
  // (cheap at hub scale) then confirm membership after parse to avoid a false hit on a shared prefix.
  const referencedBy = (db.prepare("SELECT id,related_to FROM tickets WHERE project_id=? AND related_to LIKE ?").all(projectId, `%${JSON.stringify(a.id)}%`) as { id: string; related_to: string }[])
    .filter((row) => { try { return (JSON.parse(row.related_to) as string[]).includes(a.id!); } catch { return false; } })
    .map((row) => row.id);
  return okR({ ...toTicket(r), comments, referencedBy });
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
  if (a.labels !== undefined && !isStrArr(a.labels)) return errR(400, "labels must be an array of strings");
  if (a.relatedTo !== undefined && !isStrArr(a.relatedTo)) return errR(400, "relatedTo must be an array of strings");
  if (a.priority !== undefined && (typeof a.priority !== "number" || !Number.isInteger(a.priority) || a.priority < 0 || a.priority > 4)) return errR(400, `invalid priority; an integer 0..4`);
  if (a.state && !STATES.includes(a.state as State)) return errR(400, `invalid state '${a.state}'; one of ${STATES.join(", ")}`);
  if (a.assignee && a.assignee !== "me" && !actorExists(db, a.assignee)) return errR(400, `unknown assignee '${a.assignee}'; one of ${listActorHandles(db).join(", ")} (or "me"/null)`); // DL-69: the message is byte-identical to server.ts's (the single source) — agent-api.ts asserts only status 400
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
  if (a.issueId === undefined) return errR(400, "issueId required"); // === undefined, NOT falsy (DL-69): a zod-valid empty-string issueId must fall through to the not-found lookup, byte-identical to the pre-refactor native handler
  if (typeof a.body !== "string") return errR(400, "body required");
  if (!getRow(db, projectId, a.issueId)) return errR(404, `no such ticket ${a.issueId}`);
  const { id, createdAt } = insertComment(db, projectId, actor, a.issueId, a.body);
  return okR({ id, ticket_id: a.issueId, author: actor, body: a.body, created_at: createdAt });
}

function opListComments(db: DatabaseSync, projectId: string, projectKey: string, a: { issueId?: string }): OpResult {
  if (a.issueId === undefined) return errR(400, "issueId required"); // === undefined, NOT falsy (DL-69): a zod-valid empty-string issueId must fall through to the not-found lookup, byte-identical to the pre-refactor native handler
  if (!getRow(db, projectId, a.issueId)) return errR(404, `no such ticket ${a.issueId} in ${projectKey}`);
  return okR(db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(a.issueId));
}

// ─── DL-62: the doc/event family (verbatim mirror of server.ts list_events + doc.* handlers) ──────
// The doc READS + list_events are the SAME SELECTs server.ts runs (a JSON round-trip → byte-identical
// to the stdio ok() body — the differential-parity tripwire). The doc WRITES delegate to the shared
// docstore (docSave/docPublish), so the CAS + the single operator-publish gate live in ONE place.

function opListEvents(db: DatabaseSync, projectId: string, a: { ticketId?: string; limit?: number }): OpResult {
  // mirror server.ts's zod (limit: int 1..500) — the op-API parses raw JSON, so a bad limit must be a clean
  // 400 here, never bound into LIMIT (a non-int bind throws in node:sqlite → a 500; an uncapped limit drifts).
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) <= 0 || (a.limit as number) > 500)) return errR(400, "limit must be an integer 1..500");
  if (a.ticketId !== undefined && typeof a.ticketId !== "string") return errR(400, "ticketId must be a string");
  // L4: a ticketId scopes to one ticket's history (rides idx_events_ticket); else the project-wide feed.
  if (a.ticketId) return okR(db.prepare("SELECT actor,kind,ticket_id,data,created_at FROM events WHERE project_id=? AND ticket_id=? ORDER BY id DESC LIMIT ?").all(projectId, a.ticketId, a.limit ?? 50));
  return okR(db.prepare("SELECT actor,kind,ticket_id,data,created_at FROM events WHERE project_id=? ORDER BY id DESC LIMIT ?").all(projectId, a.limit ?? 50));
}

// Mirror server.ts's zod (the doc tools' `slug`/`kind` are OPTIONAL STRINGS). The op-API parses raw JSON
// with no zod, so a present-but-non-string slug/kind must 400 HERE — otherwise it binds into resolveDoc's
// parameterized query and node:sqlite throws "Provided value cannot be bound" → an HTTP 500 echoing the raw
// driver string (same class as opSaveIssue's non-array / opDocDiff's non-int guards, extended to the doc-READ
// selectors — DL-63). Absent (undefined) is fine: a read selects by slug OR kind, and doc.list by neither.
const docSelectorErr = (a: { slug?: unknown; kind?: unknown }): string | null =>
  a.slug !== undefined && typeof a.slug !== "string" ? "slug must be a string"
    : a.kind !== undefined && typeof a.kind !== "string" ? "kind must be a string"
      : null;

function opDocList(db: DatabaseSync, projectId: string, a: { kind?: string }): OpResult {
  const bad = docSelectorErr(a); if (bad) return errR(400, bad);
  // D6: `archived` rides the row (additive) so callers can see retirement state; archived docs are NOT
  // filtered out here — doc.list is the machine registry read (the web /docs index owns the default-hide).
  return okR(a.kind
    ? db.prepare("SELECT id,kind,slug,title,status,current_version,archived,created_by,updated_at FROM documents WHERE project_id=? AND kind=? ORDER BY kind").all(projectId, a.kind)
    : db.prepare("SELECT id,kind,slug,title,status,current_version,archived,created_by,updated_at FROM documents WHERE project_id=? ORDER BY kind").all(projectId));
}

function opDocGet(db: DatabaseSync, projectId: string, projectKey: string, a: { slug?: string; kind?: string; version?: number | "latest" }): OpResult {
  const bad = docSelectorErr(a); if (bad) return errR(400, bad);
  // mirror server.ts's zod (version: int>0 | "latest", optional). Re-check by hand (no zod on the op-API path):
  // an out-of-range version must 400 like the stdio path, not fall through to the version===0 empty-doc branch.
  if (a.version !== undefined && a.version !== "latest" && (!Number.isInteger(a.version) || (a.version as number) <= 0)) return errR(400, `version must be a positive integer or "latest"`);
  const d = resolveDoc(db, projectId, a.slug, a.kind);
  if (!d) return errR(404, `no document ${a.slug ?? a.kind} in ${projectKey}`);
  // "latest" → the newest version INCLUDING drafts past the published current — what doc.save's CAS keys on
  // (the CONFLICT-recovery read). The default stays the PUBLISHED version (readers see the operator-gated doc).
  const ver = a.version === "latest" ? latestVersion(db, d.id)
    : a.version ?? (d.current_version > 0 ? d.current_version : latestVersion(db, d.id));
  if (ver === 0) return okR({ ...d, version: 0, body: "", unpublished: true, empty: true });
  const v = db.prepare("SELECT version,body,status,summary,base_version,author,created_at FROM document_versions WHERE doc_id=? AND version=?").get(d.id, ver) as Record<string, unknown> | undefined;
  if (!v) return errR(404, `no version ${ver} of ${d.slug}`);
  return okR({ id: d.id, kind: d.kind, slug: d.slug, title: d.title, status: d.status, current_version: d.current_version, ...v, ...(d.current_version === 0 ? { unpublished: true } : {}) });
}

function opDocHistory(db: DatabaseSync, projectId: string, a: { slug?: string; kind?: string }): OpResult {
  const bad = docSelectorErr(a); if (bad) return errR(400, bad);
  const d = resolveDoc(db, projectId, a.slug, a.kind);
  if (!d) return errR(404, `no document ${a.slug ?? a.kind}`);
  return okR(db.prepare("SELECT version,status,author,summary,base_version,created_at FROM document_versions WHERE doc_id=? ORDER BY version DESC").all(d.id));
}

function opDocDiff(db: DatabaseSync, projectId: string, a: { slug?: string; kind?: string; from?: number; to?: number }): OpResult {
  const bad = docSelectorErr(a); if (bad) return errR(400, bad);
  // from/to come from zod (int>0) on the stdio/shim path; the op-API parses raw JSON, so re-check by hand —
  // a non-int bind would otherwise throw inside node:sqlite → a 500 instead of a clean 400 (opSaveIssue precedent).
  if (!Number.isInteger(a.from) || (a.from as number) <= 0) return errR(400, "from must be a positive integer");
  if (!Number.isInteger(a.to) || (a.to as number) <= 0) return errR(400, "to must be a positive integer");
  const d = resolveDoc(db, projectId, a.slug, a.kind);
  if (!d) return errR(404, `no document ${a.slug ?? a.kind}`);
  const body = (n: number) => (db.prepare("SELECT body FROM document_versions WHERE doc_id=? AND version=?").get(d.id, n) as { body: string } | undefined)?.body;
  const fromBody = body(a.from as number), toBody = body(a.to as number);
  if (fromBody === undefined || toBody === undefined) return errR(404, `missing version (have up to ${latestVersion(db, d.id)})`);
  return okR({ from: a.from, to: a.to, fromBody, toBody, unified: unifiedDiff(fromBody, toBody) });
}

// `db` MUST be a WRITABLE connection (docSave does BEGIN IMMEDIATE + INSERTs + a doc.save event). The CAS
// (a stale baseVersion → CONFLICT, never last-write-wins) lives inside docSave, shared with server.ts.
function opDocSave(db: DatabaseSync, projectId: string, actor: string, a: Partial<DocSaveArgs>): OpResult {
  // re-validate the zod shapes the stdio/shim path enforces (slug/body required, kind ∈ DOC_KINDS, baseVersion int≥0)
  if (typeof a.slug !== "string") return errR(400, "slug required (a string)"); // type-only, NOT non-empty (DL-69): a zod-valid empty-string slug must reach docSave (which creates/handles it), byte-identical to the pre-refactor native handler; only undefined/non-string is rejected (the INSERT-bind guard)
  if (typeof a.body !== "string") return errR(400, "body required (a string)");
  if (a.title !== undefined && typeof a.title !== "string") return errR(400, "title must be a string"); // server.ts zod: title/summary optional strings — a non-string would bind into the INSERT → a 500
  if (a.summary !== undefined && typeof a.summary !== "string") return errR(400, "summary must be a string");
  if (!Number.isInteger(a.baseVersion) || (a.baseVersion as number) < 0) return errR(400, "baseVersion must be a non-negative integer");
  if (!(DOC_KINDS as readonly string[]).includes(a.kind as string)) return errR(400, `invalid kind '${a.kind}'; one of ${DOC_KINDS.join(", ")}`);
  const r = docSave(db, projectId, actor, a as DocSaveArgs);
  return r.ok ? okR(r.data) : errR(statusForDocErr(r.error), r.error, r.conflict); // a CAS CONFLICT carries {latestVersion,latestAuthor,hint} for a mechanical retry
}

// `db` MUST be a WRITABLE connection (docPublish does BEGIN IMMEDIATE + UPDATEs + a doc.publish event). The
// OPERATOR-only gate lives inside docPublish (shared with server.ts) — cooperative role-attribution, not
// anti-spoof on one host (§18): only the actor the daemon resolved from X-Devloop-Actor as "operator" passes.
function opDocPublish(db: DatabaseSync, projectId: string, actor: string, a: Partial<DocPublishArgs>): OpResult {
  if (!Number.isInteger(a.version) || (a.version as number) <= 0) return errR(400, "version must be a positive integer");
  const r = docPublish(db, projectId, actor, a as DocPublishArgs);
  return r.ok ? okR(r.data) : errR(statusForDocErr(r.error), r.error);
}

// `db` MUST be a WRITABLE connection (docArchive UPDATEs documents + logs a doc.archive event). The
// design-only refusal + idempotent flip live inside docArchive (shared with server.ts) — D6 retention.
function opDocArchive(db: DatabaseSync, projectId: string, actor: string, a: Partial<DocArchiveArgs>): OpResult {
  // re-validate the zod shapes the stdio/shim path enforces (slug required string, archived optional boolean)
  if (typeof a.slug !== "string") return errR(400, "slug required (a string)");
  if (a.archived !== undefined && typeof a.archived !== "boolean") return errR(400, "archived must be a boolean");
  const r = docArchive(db, projectId, actor, a as DocArchiveArgs);
  return r.ok ? okR(r.data) : errR(statusForDocErr(r.error), r.error); // missing doc → 404; a singleton kind → 409 (kind-policy refusal, the DL-9 precedent)
}

// ─── DL-67: the IM channel family (channel.*) — thin op-API wrappers over the shared channelstore ──
// Mirror the doc/topic pattern: hand-validate the raw-JSON inputs to a clean 400 (server.ts gets these from
// zod — the DL-63 lesson), then delegate to channelstore (which owns the §16 line-build, the DL-4 roadmap
// bridge, the per-process send cap, and the channels/channel_messages writes); a ChannelResult error maps to
// its HTTP status via statusForChannelErr. channel.send/poll are ASYNC (network/dryrun) → they return Promises.
// channel.status is the only READ (query_only db, not in AGENT_WRITE_OPS); the 4 writes take writeDb.

function opChannelRegister(db: DatabaseSync, projectId: string, actor: string, a: { provider?: unknown; configRef?: unknown; secretRef?: unknown; channelRef?: unknown }): OpResult {
  if (a.provider !== "slack" && a.provider !== "lark") return errR(400, `provider must be "slack" or "lark"`);
  if (typeof a.configRef !== "string" || !a.configRef) return errR(400, "configRef required (a non-empty string)");
  if (a.secretRef !== undefined && typeof a.secretRef !== "string") return errR(400, "secretRef must be a string");
  if (typeof a.channelRef !== "string" || !a.channelRef) return errR(400, "channelRef required (a non-empty string)");
  const r = channelRegister(db, projectId, actor, a as ChannelRegisterArgs);
  return r.ok ? okR(r.data) : errR(statusForChannelErr(r.error), r.error);
}

// ASYNC (channelSend awaits sendVia / the DRYRUN build). Hand-validate the fields channelSend method-calls or
// binds (a wrong type would 500): ticketId (a SELECT bind), text + digest.headline (cleanLine→.replace),
// digest.openProposals (.slice/.map + cleanLine each). The numeric digest fields only feed template strings
// (coerced), so they need no guard — parity with the doc-family numeric handling.
async function opChannelSend(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: { kind?: unknown; ticketId?: unknown; bailShape?: unknown; digest?: unknown; replyTo?: unknown; text?: unknown }): Promise<OpResult> {
  if (a.kind !== "notify" && a.kind !== "digest" && a.kind !== "reply") return errR(400, `kind must be one of notify, digest, reply`);
  if (a.ticketId !== undefined && typeof a.ticketId !== "string") return errR(400, "ticketId must be a string");
  if (a.text !== undefined && typeof a.text !== "string") return errR(400, "text must be a string");
  if (a.bailShape !== undefined && typeof a.bailShape !== "string") return errR(400, "bailShape must be a string");
  if (a.digest !== undefined) {
    if (typeof a.digest !== "object" || a.digest === null || Array.isArray(a.digest)) return errR(400, "digest must be an object");
    const d = a.digest as Record<string, unknown>;
    if (d.headline !== undefined && typeof d.headline !== "string") return errR(400, "digest.headline must be a string");
    if (d.openProposals !== undefined && !isStrArr(d.openProposals)) return errR(400, "digest.openProposals must be an array of strings");
  }
  const r = await channelSend(db, projectId, projectKey, actor, a as ChannelSendArgs);
  return r.ok ? okR(r.data) : errR(statusForChannelErr(r.error), r.error);
}

// ASYNC (channelPoll awaits pollVia / the DRYRUN build + the DL-4 bridge). No input (the fixture rides env).
async function opChannelPoll(db: DatabaseSync, projectId: string, projectKey: string, actor: string): Promise<OpResult> {
  const r = await channelPoll(db, projectId, projectKey, actor);
  return r.ok ? okR(r.data) : errR(statusForChannelErr(r.error), r.error);
}

function opChannelAck(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: { messageId?: unknown; actedInto?: unknown }): OpResult {
  if (typeof a.messageId !== "string") return errR(400, "messageId must be a string");
  if (a.actedInto !== undefined && typeof a.actedInto !== "string") return errR(400, "actedInto must be a string");
  const r = channelAck(db, projectId, projectKey, actor, a as ChannelAckArgs);
  return r.ok ? okR(r.data) : errR(statusForChannelErr(r.error), r.error);
}

function opChannelStatus(db: DatabaseSync, projectId: string): OpResult {
  return okR(channelStatus(db, projectId)); // read; never origin/actor-gated upstream (parity with the read ticket/doc/topic ops)
}

// ─── DL-68: P7 mirror (mirror.push/mirror.status) + label/project (list_issue_labels/create_issue_label/
//     get_project) — thin op-API wrappers over the shared mirrorstore/labelstore ──
// Mirror the doc/topic/channel pattern: hand-validate the raw-JSON inputs to a clean 400 (server.ts gets these
// from zod — the DL-63/DL-65 lesson), then delegate to the shared store. mirror.push / create_issue_label errors
// are all client 400s (bad input / unset-or-literal token / DL-22 empty-name / bad-kind) — no 404/409 here, and
// a failed Linear network call is counted in `failed`, never an op error. mirror.push is ASYNC (Linear network /
// dryrun build) → it returns a Promise. The 3 reads take the query_only db (not in AGENT_WRITE_OPS).

// ASYNC (mirrorPush awaits the Linear transport / the DRYRUN build). Hand-validate the shapes server.ts gets
// from zod (teamId/tokenEnv non-empty strings, projectId optional string, stateMap an object, limit int 1..500)
// so a bad type is a clean 400, never a node:sqlite bind-throw 500 or a crash inside mirrorPush.
async function opMirrorPush(db: DatabaseSync, projectId: string, actor: string, a: { teamId?: unknown; tokenEnv?: unknown; projectId?: unknown; stateMap?: unknown; limit?: unknown }): Promise<OpResult> {
  if (typeof a.teamId !== "string" || !a.teamId) return errR(400, "teamId required (a non-empty string)");
  if (typeof a.tokenEnv !== "string" || !a.tokenEnv) return errR(400, "tokenEnv required (a non-empty string)");
  if (a.projectId !== undefined && typeof a.projectId !== "string") return errR(400, "projectId must be a string");
  if (a.stateMap !== undefined && (typeof a.stateMap !== "object" || a.stateMap === null || Array.isArray(a.stateMap))) return errR(400, "stateMap must be an object");
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 500)) return errR(400, "limit must be an integer 1..500");
  const r = await mirrorPush(db, projectId, actor, a as MirrorPushArgs);
  return r.ok ? okR(r.data) : errR(400, r.error); // §16-safe error (isEnvName / scrubErr inside mirrorstore); the token never appears
}

// ASYNC (mirrorPollComments awaits the Linear comment/content reads). Same hand-validation discipline as
// opMirrorPush: tokenEnv a non-empty string → a clean 400, never a crash inside the store. The poller's
// errors are all client 400s (bad input / unset-or-literal token); a failed Linear read is counted in
// `failed` + logged scrubbed, never an op error — parity with mirror.push's failure discipline.
async function opMirrorPollComments(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: { tokenEnv?: unknown }): Promise<OpResult> {
  if (typeof a.tokenEnv !== "string" || !a.tokenEnv) return errR(400, "tokenEnv required (a non-empty string)");
  const r = await mirrorPollComments(db, projectId, projectKey, actor, a as MirrorPollArgs);
  return r.ok ? okR(r.data) : errR(400, r.error); // §16-safe error (isEnvName / scrubErr inside mirrorstore); the token never appears
}

function opMirrorStatus(db: DatabaseSync, projectId: string): OpResult {
  return okR(mirrorStatus(db, projectId)); // read; coverage counts, no secret, no Linear read
}

function opListLabels(db: DatabaseSync, projectId: string): OpResult {
  return okR(listLabels(db, projectId)); // read
}

// `db` MUST be a WRITABLE connection. Validation (DL-22 empty-name + LABEL_KINDS) lives in the shared createLabel
// so server.ts + the op-API can't drift. The attributed `label.create` event is logged HERE (the identity win).
// Both transports now dispatch through this op (server.ts's former native override was removed) — so the
// label.create attribution event fires on stdio AND the op-API, the last DL-69 transport divergence closed.
function opCreateLabel(db: DatabaseSync, projectId: string, actor: string, a: { name?: unknown; kind?: unknown }): OpResult {
  if (typeof a.name !== "string") return errR(400, "name required (a string)"); // server.ts zod: name z.string() — a non-string would crash createLabel's .trim()
  if (a.kind !== undefined && typeof a.kind !== "string") return errR(400, "kind must be a string");
  const r = createLabel(db, projectId, a as { name: string; kind?: string });
  if (!r.ok) return errR(400, r.error); // DL-22: empty-name / bad-kind → a clean 400, never a fake success with a dropped row
  logEvent(db, { project_id: projectId, actor, kind: "label.create", data: { name: r.data.name, kind: r.data.kind } });
  return okR(r.data);
}

function opGetProject(db: DatabaseSync, projectId: string): OpResult {
  return okR(getProject(db, projectId)); // read
}

// ─── D1: the project override — a role-based permission matrix, enforced at the dispatch choke point ──────
// Hub identity pins an agent to ONE project at boot (DEVLOOP_PROJECT), which made the team-scope features
// (§9b team intake, ops owner-routed alerts, sweep per-project hygiene) dead letters on backend:"service".
// Every op-backed tool now takes an optional `project` arg (tooldefs.ts injects the schema); THIS resolver
// decides whether the caller may cross its boot pin — by ACTOR ROLE only (job-level conditions live
// prompt-side in the SKILLs; they are not server-enforceable — docs/design/2026-07-review-decisions.md D1):
//   • stewards (STEWARD_HANDLES: sweep/ops/reflect/communication, normally booted `_team`) → any existing
//     project key or `_team`;
//   • pm → `_team` ONLY (the §9b team-intake board), regardless of its booted project;
//   • every other actor → its booted project only (an explicit same-key pass is a no-op, never an error).
// FORBIDDEN-first, existence second: a forbidden actor gets the SAME 403 whether or not the key exists, so
// the matrix never leaks which project keys exist; only an ALLOWED actor's unknown key gets the 404 (the
// existing not-found shape). No `project` arg ⇒ exactly the booted behavior (backward compatible).
const STEWARD_ACTORS: ReadonlySet<string> = new Set(STEWARD_HANDLES);
export type ProjectOverride = { ok: true; projectId: string; projectKey: string } | { ok: false; result: OpResult };
export function resolveProjectOverride(db: DatabaseSync, bootedProjectId: string, bootedProjectKey: string, actor: string, requested: unknown): ProjectOverride {
  if (requested === undefined) return { ok: true, projectId: bootedProjectId, projectKey: bootedProjectKey };
  if (typeof requested !== "string") return { ok: false, result: errR(400, "project must be a string (a project key)") }; // the op-API parses raw JSON — mirror the stdio zod (DL-63)
  if (requested === bootedProjectKey) return { ok: true, projectId: bootedProjectId, projectKey: bootedProjectKey };
  if (!STEWARD_ACTORS.has(actor) && !(actor === "pm" && requested === TEAM_INTAKE_PROJECT))
    return { ok: false, result: errR(403, `FORBIDDEN: actor '${actor}' may not act on project '${requested}' (booted: '${bootedProjectKey}'). Only stewards (${STEWARD_HANDLES.join("/")}) may target another project; pm only '${TEAM_INTAKE_PROJECT}'.`) };
  const row = db.prepare("SELECT id,key FROM projects WHERE key=?").get(requested) as { id: string; key: string } | undefined;
  if (!row) return { ok: false, result: errR(404, `no such project '${requested}'`) };
  return { ok: true, projectId: row.id, projectKey: row.key };
}

// Dispatch one op. `db` is the WRITABLE connection for the write ops (save_issue/save_comment) and may be
// the daemon's query_only read connection for the read ops — the daemon passes the right one per op. `actor`
// is already resolved+validated by the daemon (the G1 guard). `args` is the parsed JSON body (a non-object
// body is normalized to {} by the caller). Throws only on a genuine DB fault (→ the daemon's 500 catch).
export function agentOp(op: AgentOp, db: DatabaseSync, projectId: string, projectKey: string, actor: string, args: Record<string, unknown>): OpResult | Promise<OpResult> {
  // D1 choke point: EVERY op resolves its effective project HERE, so no op can bypass the override matrix.
  // Both transports flow through this line (server.ts dispatches straight into agentOp; the daemon ALSO
  // pre-resolves with the same function for its dry-run mode gate, then passes the effective ids in — that
  // second resolve degenerates to the same-key fast path above, so the two can't disagree).
  const ov = resolveProjectOverride(db, projectId, projectKey, actor, args.project);
  if (!ov.ok) return ov.result;
  ({ projectId, projectKey } = ov);
  switch (op) {
    case "list_issues": return opListIssues(db, projectId, actor, args as ListIssuesArgs);
    case "get_issue": return opGetIssue(db, projectId, projectKey, args as { id?: string });
    case "save_issue": return opSaveIssue(db, projectId, projectKey, actor, args as SaveIssueArgs);
    case "save_comment": return opSaveComment(db, projectId, actor, args as { issueId?: string; body?: string });
    case "list_comments": return opListComments(db, projectId, projectKey, args as { issueId?: string });
    case "list_events": return opListEvents(db, projectId, args as { limit?: number });
    case "doc.list": return opDocList(db, projectId, args as { kind?: string });
    case "doc.get": return opDocGet(db, projectId, projectKey, args as { slug?: string; kind?: string; version?: number | "latest" });
    case "doc.history": return opDocHistory(db, projectId, args as { slug?: string; kind?: string });
    case "doc.diff": return opDocDiff(db, projectId, args as { slug?: string; kind?: string; from?: number; to?: number });
    case "doc.save": return opDocSave(db, projectId, actor, args as Partial<DocSaveArgs>);
    case "doc.publish": return opDocPublish(db, projectId, actor, args as Partial<DocPublishArgs>);
    case "doc.archive": return opDocArchive(db, projectId, actor, args as Partial<DocArchiveArgs>);
    case "channel.register": return opChannelRegister(db, projectId, actor, args as { provider?: unknown; configRef?: unknown; secretRef?: unknown; channelRef?: unknown });
    case "channel.send": return opChannelSend(db, projectId, projectKey, actor, args as { kind?: unknown; ticketId?: unknown; bailShape?: unknown; digest?: unknown; replyTo?: unknown; text?: unknown });
    case "channel.poll": return opChannelPoll(db, projectId, projectKey, actor);
    case "channel.ack": return opChannelAck(db, projectId, projectKey, actor, args as { messageId?: unknown; actedInto?: unknown });
    case "channel.status": return opChannelStatus(db, projectId);
    case "mirror.push": return opMirrorPush(db, projectId, actor, args as { teamId?: unknown; tokenEnv?: unknown; projectId?: unknown; stateMap?: unknown; limit?: unknown });
    case "mirror.pollComments": return opMirrorPollComments(db, projectId, projectKey, actor, args as { tokenEnv?: unknown });
    case "mirror.status": return opMirrorStatus(db, projectId);
    case "list_issue_labels": return opListLabels(db, projectId);
    case "create_issue_label": return opCreateLabel(db, projectId, actor, args as { name?: unknown; kind?: unknown });
    case "get_project": return opGetProject(db, projectId);
  }
}
