// servable.ts — the dev-tier SERVABLE-work predicate, deliberately kept in a LEAN, dependency-free leaf so the
// scheduler (run-agents.ts) can consume it WITHOUT dragging in agentops.ts's transitive `zod`/MCP tree.
//
// LOOP-144 shares this predicate between the `queue` op (agentops.opQueue) and the scheduler's per-fire
// queue-depth gate (run-agents.devTierQueueSkip) so the two can't drift on "what is servable". The obvious home
// was agentops.ts — but run-agents.ts must LOAD from a src-only checkout with no node_modules (LOOP-58: main()
// runs unconditionally, and `dev-loop run --help` on a spaced/URL-escaped path exercises exactly that load), and
// agentops.ts imports tooldefs.ts → `zod`. Importing agentops from the scheduler therefore breaks that load. This
// leaf imports only node:sqlite + the zod-free ./db.ts types, so it is safe to import from either side.
import { DatabaseSync } from "node:sqlite";
import type { State, Ticket } from "./db.ts";

// Row → API shape — a verbatim mirror of agentops.ts's toTicket/TicketRow (the accepted per-module adapter
// pattern in this codebase; kept private here so this leaf stays self-contained and agentops-free).
interface TicketRow {
  id: string; project_id: string; title: string; description: string; type: string;
  state: State; assignee: string | null; priority: number; labels: string;
  duplicate_of: string | null; related_to: string; waiting_on: string | null; created_by: string; created_at: string; updated_at: string;
}
const toTicket = (r: TicketRow): Ticket => ({
  id: r.id, project_id: r.project_id, title: r.title, description: r.description, type: r.type,
  state: r.state, assignee: r.assignee, priority: r.priority,
  labels: JSON.parse(r.labels) as string[],
  duplicateOf: r.duplicate_of, relatedTo: JSON.parse(r.related_to) as string[],
  waiting_on: r.waiting_on, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
});

// §5 pick rank: urgent bug → urgent feature → edge-case bug → bug → feature → urgent improvement → improvement (FIFO within a rank).
// LOOP-254: a priority=1 Improvement ranks strictly above ordinary Improvements and below Features
// (operator ruling 2026-08-01 — the urgency field PM/QA set must not be discarded for Improvements).
const PICK_RANK = (t: Ticket): number =>
  t.priority === 1 && t.type === "Bug" ? 0
  : t.priority === 1 && t.type === "Feature" ? 1
  : t.type === "Bug" && t.labels.includes("edge-case") ? 2
  : t.type === "Bug" ? 3            // §5 rank 3.5 — defects beat features
  : t.type === "Feature" ? 4
  : t.priority === 1 ? 4.5   // LOOP-254: urgent Improvement — above ordinary Improvements, below Features
  : 5;                              // Improvement and anything else

// The shared servable-Todo predicate — is this Todo ticket servable by the given actor?
// Encapsulates: assignee match (`mine`), `blocked` exclusion, and the Layer-2 defense
// (sensitive+junior exclusion per LOOP-80 Child B). Used by BOTH `servableSlice` AND
// `servableTodoDepth` so the two can't drift on "what is servable for this actor".
// LOOP-251: extracted from the inline filter in `servableSlice` into a single shared function.
function isTodoServableFor(t: Ticket, actor: string): boolean {
  if (t.labels.includes("blocked")) return false;
  const mine = actor === "dev" ? (t.assignee === null || t.assignee === "dev") : t.assignee === actor;
  const notSensitiveForJunior = actor !== "junior-dev" || !t.labels.includes("sensitive");
  return mine && notSensitiveForJunior;
}
// The dev tiers (§21b): the legacy single `dev` plus the split pair. ONE membership test so the `queue` op, the
// servable-slice predicate below, and the scheduler's queue-gate can't drift on "who has an assignee-based Todo
// slice". pm/qa/architect/stewards are NOT dev tiers.
export const isDevTierActor = (actor: string): boolean =>
  actor === "dev" || actor === "senior-dev" || actor === "junior-dev";

// servableSlice — a dev tier's SERVABLE work: its §5-ranked Todo slice (own assignee, `blocked` excluded, and —
// for junior — `sensitive` excluded per LOOP-80 Child B) PLUS its own In Progress (the Step-0 orphan-resume
// input) PLUS its own In Review (landing/repair only — a §12c fire-start pass: merge green, fix+repush red,
// leave merged-but-unverified alone; LOOP-112). This is the SINGLE source both `opQueue` and the
// scheduler's queue-depth fire-gate (LOOP-144) consume, so the gate can't grow a second, drifting copy of
// "what is servable". Callers pass a dev-tier actor (isDevTierActor); a non-dev actor yields empty slices.
// Output is summarized (no bodies). Hub issues NO network/gh calls — landing state is CLI-side only.
export function servableSlice(db: DatabaseSync, projectId: string, actor: string): { todo: Ticket[]; inProgress: Ticket[]; inReview: Ticket[] } {
  const summary = (t: Ticket): Ticket => ({ ...t, description: "" });
  const byState = (state: string): Ticket[] =>
    (db.prepare("SELECT * FROM tickets WHERE project_id=? AND state=? ORDER BY created_at").all(projectId, state) as unknown as TicketRow[]).map(toTicket);
  // Layer-2 queue defense (design sensitive-routing §2 / LOOP-80 Child B): a residual sensitive+junior
  // row (written before the Layer-1 write gate or via a raw path) must never be served to junior-dev.
  const notSensitiveForJunior = (t: Ticket): boolean => actor !== "junior-dev" || !t.labels.includes("sensitive");
  const todo = byState("Todo")
    .filter((t) => isTodoServableFor(t, actor))
    .sort((x, y) => PICK_RANK(x) - PICK_RANK(y) || x.created_at.localeCompare(y.created_at))
    .map(summary);
  const inProgress = byState("In Progress").filter((t) => t.assignee === actor && notSensitiveForJunior(t)).map(summary);
  // inReview: landing/repair only — NOT a pick list (LOOP-112). Keyed on assignee===actor OR, for split-dev
  // tiers, the tier label (LOOP-244): a null-assignee InReview ticket whose tier label still names the actor
  // is landable by Step 0.5 even if the assignee was cleared on handoff. The label fallback only applies
  // when assignee IS NULL — an explicitly-assigned ticket stays in its owner's slice only. Legacy `dev`
  // actor uses assignee only (actor==="dev" excluded from label-match) so null-assignee "dev" never bleeds in.
  const tierLabel = isDevTierActor(actor) && actor !== "dev";
  const inReview = byState("In Review")
    .filter((t) => (t.assignee === actor || (tierLabel && t.assignee === null && t.labels.includes(actor))) && notSensitiveForJunior(t))
    .map(summary);
  return { todo, inProgress, inReview };
}

// pm job-lanes (job-scoped prompts, docs/design/job-scoped-prompts.md) — the two counts the pm-maintenance
// lane gate reads to pick its job (verify vs unblock) without a full agentops board scan. `verify` = pm-owned
// In Review rows (owner label `pm`); `unblock` = rows routable to pm's unblock job: any `needs-pm` row (the
// SKILL's "blocked+needs-pm OR needs-pm without blocked"), plus a `blocked` row carrying a pm-shaped bail
// label (`decision-needed`/`scope-design`). Terminal states are excluded. Same leaf as servableSlice so the
// scheduler consumes it WITHOUT the agentops (zod) tree (LOOP-58).
const TERMINAL_STATES = new Set(["Done", "Canceled", "Duplicate"]);
export function pmMaintenanceSlice(db: DatabaseSync, projectId: string): { verify: number; unblock: number } {
  const rows = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY created_at").all(projectId) as unknown as TicketRow[]).map(toTicket);
  let verify = 0, unblock = 0;
  for (const t of rows) {
    if (TERMINAL_STATES.has(t.state)) continue;
    const L = t.labels;
    if (t.state === "In Review" && L.includes("pm")) verify++;
    if (L.includes("needs-pm") || (L.includes("blocked") && (L.includes("decision-needed") || L.includes("scope-design")))) unblock++;
  }
  return { verify, unblock };
}

// qa job-lanes (job-scoped prompts) — the two counts the qa-maintenance lane gate reads to pick its job
// (verify vs unblock) without a full agentops board scan, mirroring pmMaintenanceSlice. `verify` = qa-owned
// In Review rows (owner label `qa`); `unblock` = rows routable to qa's unblock job: any `needs-qa` row, plus
// a `blocked` row carrying qa's `info-needed` bail shape (§9). Terminal states are excluded. Same leaf so the
// scheduler consumes it WITHOUT the agentops (zod) tree (LOOP-58).
export function qaMaintenanceSlice(db: DatabaseSync, projectId: string): { verify: number; unblock: number } {
  const rows = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY created_at").all(projectId) as unknown as TicketRow[]).map(toTicket);
  let verify = 0, unblock = 0;
  for (const t of rows) {
    if (TERMINAL_STATES.has(t.state)) continue;
    const L = t.labels;
    if (t.state === "In Review" && L.includes("qa")) verify++;
    if (L.includes("needs-qa") || (L.includes("blocked") && L.includes("info-needed"))) unblock++;
  }
  return { verify, unblock };
}

// senior-dev Mode pick (job-scoped prompts, §21a) — which JOB corpus a senior-dev fire loads: `design`
// (author the module design, stage junior children) vs `directcode` (ship an escalation itself). Read from
// the picked ticket's `Mode:` marker, deterministically:
//   • the deciding ticket = the one senior-dev works THIS fire — an In Progress orphan it resumes (Step 0),
//     else the top of its §5-ranked servable Todo (a fresh pick).
//   • `Mode: direct-code` at the description head ⇒ `directcode`; `Mode: design` ⇒ `design`.
//   • no marker ⇒ a follow-up (a non-empty `relatedTo`, i.e. it supersedes a Canceled predecessor per §21a)
//     defaults to `directcode`; otherwise `design`.
//   • nothing to pick ⇒ `design` (the normal complex path). Zero board access / read error is handled by the
//     caller's fail-open (it defaults the job), never here.
// Same leaf as servableSlice so the scheduler consumes it WITHOUT the agentops (zod) tree (LOOP-58).
export function seniorDevModePick(db: DatabaseSync, projectId: string): "design" | "directcode" {
  const byState = (state: string): Ticket[] =>
    (db.prepare("SELECT * FROM tickets WHERE project_id=? AND state=? ORDER BY created_at").all(projectId, state) as unknown as TicketRow[]).map(toTicket);
  const inProgress = byState("In Progress").filter((t) => t.assignee === "senior-dev");
  const todo = byState("Todo")
    .filter((t) => isTodoServableFor(t, "senior-dev"))
    .sort((x, y) => PICK_RANK(x) - PICK_RANK(y) || x.created_at.localeCompare(y.created_at));
  const picked = inProgress[0] ?? todo[0] ?? null;
  if (!picked) return "design"; // nothing to pick ⇒ the normal complex path
  const head = (picked.description ?? "").trimStart();
  if (head.startsWith("Mode: direct-code")) return "directcode";
  if (head.startsWith("Mode: design")) return "design";
  return picked.relatedTo.length > 0 ? "directcode" : "design"; // no marker ⇒ follow-up is direct-code, else design
}

/**
 * The BACKLOG side, per tier (LOOP-329) — the count no surface reported.
 *
 * Every surface that reports dev-tier load reported only the Todo side. A tier that HAS CAPACITY AND
 * NOTHING IT IS ALLOWED TO PULL was therefore invisible to the operator and re-derived by hand by PM
 * on every fire. Measured on this board 2026-08-05: senior-dev sat at 6/10 Todo — 4 idle slots —
 * with ZERO promotable Backlog anywhere, while 66 junior tickets queued at a tier already over cap.
 *
 * Deliberately the SAME predicate `servableTodoDepth` uses, not a fourth hand-rolled `assignee ===`
 * filter — that duplication is what LOOP-169 exists to stop. The one difference is the state, so the
 * two counts can never disagree about who may pull what.
 *
 * `blocked` is excluded from every count: a blocked row is not promotable, and counting it would
 * report candidates that no promotion can reach.
 */
export function servableBacklogDepth(db: DatabaseSync, projectId: string): { total: number; "senior-dev": number; "junior-dev": number; dev: number } {
  const allBacklog = (db.prepare("SELECT * FROM tickets WHERE project_id=? AND state='Backlog' ORDER BY created_at").all(projectId) as unknown as TicketRow[]).map(toTicket);
  let total = 0, senior = 0, junior = 0, dev = 0;
  for (const t of allBacklog) {
    if (t.labels.includes("blocked")) continue;  // not promotable ⇒ not a candidate
    total++;
    if (isTodoServableFor(t, "senior-dev")) senior++;
    if (isTodoServableFor(t, "junior-dev")) junior++;
    if (isTodoServableFor(t, "dev")) dev++;
  }
  return { total, "senior-dev": senior, "junior-dev": junior, dev };
}

// servableTodoDepth — the §5a todoDepth cap input, computed from the SAME servable-Todo
// predicate as `servableSlice`, not a raw `assignee ===` filter over non-blocked Todo.
// Makes a SINGLE pass over all non-blocked Todo rows and counts per tier through the shared
// `isTodoServableFor` predicate. `total` is the count of ALL non-blocked Todo rows (the
// board-wide funnel number, unchanged from the previous inline computation — LOOP-169).
// LOOP-251: replaces the inline todoDepth object literal in `agentops.ts` `opQueue`.
export function servableTodoDepth(db: DatabaseSync, projectId: string): { total: number; "senior-dev": number; "junior-dev": number; dev: number } {
  const allTodo = (db.prepare("SELECT * FROM tickets WHERE project_id=? AND state='Todo' ORDER BY created_at").all(projectId) as unknown as TicketRow[]).map(toTicket);
  let total = 0, senior = 0, junior = 0, dev = 0;
  for (const t of allTodo) {
    if (t.labels.includes("blocked")) continue;  // total excludes blocked
    total++;
    if (isTodoServableFor(t, "senior-dev")) senior++;
    if (isTodoServableFor(t, "junior-dev")) junior++;
    if (isTodoServableFor(t, "dev")) dev++;
  }
  return { total, "senior-dev": senior, "junior-dev": junior, dev };
}
