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

// DL-77 verify gate (the Ralph-Wiggum guard) + LOOP-157 two-hop close + LOOP-208 actor coverage. Enforced in
// updateTicketRow below — the SAME single-choke-point placement as stagingDeployRejection — so it covers BOTH the
// MCP save_issue transition AND the daemon board-move automatically. Two edges to Done are gated:
//   • In Progress → Done — the naive maker-self-accept shortcut — is REJECTED for everyone (Done is the OWNER's
//     verdict, reached via In Review).
//   • In Review → Done — LOOP-157/183 defeated the direct edge by splitting the self-accept into two legal calls
//     and by dropping the owner label mid-close. LOOP-208: those fixes keyed the gate on isDevTierActor — a
//     predicate that answers "is this a BUILDER?", not "is this actor entitled to sign off?". The roster has ten
//     agents; three are builders, two (qa/pm) are the verifier-owners, and the remaining five (sweep, reflect,
//     ops, architect, communication) are NEITHER — so they fell straight through the gate and could close a
//     qa/pm-owned ticket with rc=0. A deny-list keyed on a role the invariant never mentions grows a hole every
//     time the roster grows. So the gate now asks the RIGHT question — "is the actor this ticket's verifier-owner?":
//     an In Review → Done close is refused for EVERY actor that is not one of the ticket's own qa/pm owner labels
//     and is not the operator. Keys on the ticket's owner label (STORED ∪ incoming, so a label-drop-at-close can't
//     unlock it — LOOP-183 Vector A) + the actor handle — never the mutable assignee — and the refusal is
//     greppable + names the actual verifier-owner and the actor (observability), with no "builder tier" claim for
//     actors that are not one. RULING (LOOP-208): a single-owner ticket admits ONLY that owner (pm cannot close a
//     qa-owned ticket, nor qa a pm-owned one — "Done means verified by ITS owner", §3); a dual qa+pm-owned ticket
//     admits either owner. §9a's Todo/Backlog → Done parent-close is a different, ungated edge — unaffected.
// Every OTHER path to Done stays legal — In Review → Done by the ticket's own qa/pm owner or the operator (the
// verified close), any actor's In Review → Done on a ticket with NO qa/pm owner label (a §9a self-verified intake
// item), Todo → Done / Backlog → Done (the §9a intake parent-close, which MUST stay legal or it breaks PM's
// grooming), and In Progress → Canceled/Duplicate (terminal, NOT Done). Unlike the DL-38 gate this is
// UNCONDITIONAL (no opt-in config): "Done means verified" is a §3 loop invariant, not an operator preference.
// VERIFIER_OWNER_LABELS — the owner tiers whose sign-off "Done means verified" (§3) requires. Any non-owner,
// non-operator actor may neither close (verifyGateRejection) nor create-closed (verifyCreateGateRejection) a
// ticket carrying one. Deduped so a doubled label never inflates the refusal message.
const VERIFIER_OWNER_LABELS = new Set<string>(["qa", "pm"]);
const ownerLabelsOf = (labels: string[]): string[] => [...new Set(labels.filter((l) => VERIFIER_OWNER_LABELS.has(l)))];

function verifyGateRejection(actor: string, fromState: string, next: TicketUpdateFields, storedLabels: string[]): string | null {
  if (fromState === "In Progress" && next.state === "Done")
    return `verify gate: In Progress → Done is not allowed — Done must be reached via In Review (owner verification); move to In Review first`;
  // LOOP-208 (was LOOP-157 + LOOP-183 Vector A): the close-edge gate keys on OWNERSHIP, not builder-tier. A ticket
  // carrying a qa/pm verifier-owner label may be closed In Review → Done ONLY by one of those owners or the
  // operator — every other actor is refused (the five non-builder, non-owner handles used to fall through). Read
  // owners from the STORED labels ∪ the incoming set — NOT next.labels alone: the agent save_issue path
  // REPLACE-merges labels, so gating on next.labels let a REPLACE that DROPS the qa/pm owner label in the SAME
  // In Review → Done write empty the owner set and unlock the close (LOOP-183 Vector A). The stored set is the
  // ticket's real ownership at the close; unioning the incoming set keeps the plain "still carries the label"
  // case covered too.
  if (fromState === "In Review" && next.state === "Done") {
    const owners = ownerLabelsOf([...storedLabels, ...(JSON.parse(next.labels) as string[])]);
    if (owners.length > 0 && actor !== "operator" && !owners.includes(actor))
      return `verify gate: In Review → Done blocked — '${actor}' is not the ${owners.join("/")} verifier-owner of this ticket; only that ${owners.join("/")} owner or the operator may close it`;
  }
  return null; // every other transition is the caller's concern
}

// LOOP-183 Vector B + LOOP-208: the create-edge twin of the verify gate. insertTicket writes the row verbatim —
// NONE of the updateTicketRow gates run on a create — so an actor could create a ticket DIRECTLY in Done on a
// qa/pm-owner-labelled ticket, reaching Done with zero owner verification (a distinct sink from the transition
// edge). Mirror the In Review → Done ownership rule at the create edge: only the ticket's own qa/pm owner (or the
// operator) may create a qa/pm-owned ticket already in Done; every other actor is refused — NOT just builder
// tiers (LOOP-208: sweep/reflect/ops/architect/communication fell through here too). Todo/Backlog intake creates
// (§9a) and non-owner-labelled creates stay legal (state ≠ Done, or no owner label). Wired into opSaveIssue's
// create path — the only create path with agent-controlled state (the daemon createTicket hardcodes Todo, the
// Linear mirror intake hardcodes Backlog).
export function verifyCreateGateRejection(actor: string, state: string, labels: string[]): string | null {
  if (state !== "Done") return null;
  const owners = ownerLabelsOf(labels);
  if (owners.length === 0 || actor === "operator" || owners.includes(actor)) return null;
  return `verify gate: create directly into Done blocked — '${actor}' is not the ${owners.join("/")} verifier-owner of this ticket; create it in Todo/Backlog and let the ${owners.join("/")} owner close it after review`;
}

// Field-report P1-1 terminal-state guard (MP-275). A fire's stale queue snapshot let agents lift tickets
// OUT of terminal states — a ticket the operator had just Canceled was re-implemented, rode a batched push,
// and DEPLOYED; a Done ticket was re-opened to In Review. Prompt/pick discipline cannot hold this line;
// the shared write path does: only the OPERATOR exits Done/Canceled — agents file a NEW ticket and link it
// via relatedTo instead (§3). Same single-choke-point placement as the two gates above, so the MCP
// save_issue, the CLI write verbs, and the daemon board-move are all covered. State-PRESERVING updates on
// a closed ticket (label/relatedTo hygiene, comments) stay legal, and Duplicate deliberately stays
// un-gated (its resolution lives on the duplicateOf target; Sweep re-routes mislabeled ones).
const TERMINAL_STATES = new Set<string>(["Done", "Canceled"]);
function terminalExitRejection(actor: string, fromState: string, next: TicketUpdateFields): string | null {
  if (next.state === fromState || !TERMINAL_STATES.has(fromState) || actor === "operator") return null;
  return `terminal-state guard: '${fromState}' → '${next.state}' — only the operator reopens a ${fromState} ticket (P1-1); file a NEW ticket for the follow-up and link it with relatedTo`;
}

// ─── sensitive → senior-dev re-tier gate (design sensitive-routing §2 / LOOP-79 Child A) ──────
// Applied in both insertTicket and updateTicketRow so every write path is covered by construction.
// Rule: sensitive+junior-dev present AND senior-dev actor exists → silently correct to senior-dev
// and log issue.retier. Strict no-op otherwise (incl. legacy no-senior-dev projects).
function applySensitiveRetier(
  db: DatabaseSync,
  assignee: string | null,
  labels: string[],
): { assignee: string | null; labels: string[]; retiered: { from: string; to: string } | null } {
  if (!labels.includes("sensitive")) return { assignee, labels, retiered: null };
  const isJunior = assignee === "junior-dev" || labels.includes("junior-dev");
  if (!isJunior || !actorExists(db, "senior-dev")) return { assignee, labels, retiered: null };
  const newLabels = [...new Set(labels.map((l) => (l === "junior-dev" ? "senior-dev" : l)))];
  return { assignee: "senior-dev", labels: newLabels, retiered: { from: "junior-dev", to: "senior-dev" } };
}

// ─── the raw mechanics: the ONLY tickets/comments writers in the hub ──────────

// THE ticket INSERT. Allocates the id, writes all 14 columns, logs issue.create. `createEventData` is passed
// in so each caller logs exactly what it logged before this convergence (the MCP path logs the RAW {title,type}
// — type possibly undefined when omitted — which differs from the resolved type written to the row).
export function insertTicket(
  db: DatabaseSync, projectId: string, actor: string, f: NewTicketFields, createEventData: Record<string, unknown>,
): string {
  const retier = applySensitiveRetier(db, f.assignee, f.labels);
  const assignee = retier.assignee;
  const labels = retier.labels;
  const id = nextTicketId(db, projectId);
  const t = nowIso();
  db.prepare(`INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,duplicate_of,related_to,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, f.title, f.description, f.type, f.state, assignee, f.priority, JSON.stringify(labels), f.duplicateOf, JSON.stringify(f.relatedTo), actor, t, t);
  logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.create", data: createEventData });
  if (retier.retiered) {
    logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.retier", data: { from: retier.retiered.from, to: retier.retiered.to, reason: "sensitive" } });
  }
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
  // Apply sensitive re-tier before transition gates (design sensitive-routing §2, LOOP-79 Child A).
  const labelsArr = JSON.parse(next.labels) as string[];
  const retier = applySensitiveRetier(db, next.assignee, labelsArr);
  const resolved: TicketUpdateFields = retier.retiered
    ? { ...next, assignee: retier.assignee, labels: JSON.stringify(retier.labels) }
    : next;

  // LOOP-183 Vector A: the verify gate keys on the ticket's STORED owner labels (read here, pre-write) so dropping
  // the qa/pm owner label in `resolved` cannot unlock a dev-tier self-close. rowFor reads within the caller's txn.
  const storedRow = rowFor(db, projectId, id);
  const storedLabels = storedRow ? (JSON.parse(storedRow.labels) as string[]) : [];
  const gate = terminalExitRejection(actor, fromState, resolved)
    ?? stagingDeployRejection(db, projectId, fromState, resolved)
    ?? verifyGateRejection(actor, fromState, resolved, storedLabels);
  if (gate) return { ok: false, status: 400, error: gate };
  const t = nowIso();
  db.prepare(`UPDATE tickets SET title=?,description=?,type=?,state=?,assignee=?,priority=?,labels=?,duplicate_of=?,related_to=?,updated_at=? WHERE id=? AND project_id=?`)
    .run(resolved.title, resolved.description, resolved.type, resolved.state, resolved.assignee, resolved.priority, resolved.labels, resolved.duplicate_of, resolved.related_to, t, id, projectId);
  logEvent(db, resolved.state !== fromState
    ? { project_id: projectId, ticket_id: id, actor, kind: "issue.transition", data: { from: fromState, to: resolved.state, assignee: resolved.assignee } }
    : { project_id: projectId, ticket_id: id, actor, kind: "issue.update", data: {} });
  if (retier.retiered) {
    logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.retier", data: { from: retier.retiered.from, to: retier.retiered.to, reason: "sensitive" } });
  }
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
