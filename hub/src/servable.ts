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
  duplicate_of: string | null; related_to: string; created_by: string; created_at: string; updated_at: string;
}
const toTicket = (r: TicketRow): Ticket => ({
  id: r.id, project_id: r.project_id, title: r.title, description: r.description, type: r.type,
  state: r.state, assignee: r.assignee, priority: r.priority,
  labels: JSON.parse(r.labels) as string[],
  duplicateOf: r.duplicate_of, relatedTo: JSON.parse(r.related_to) as string[],
  created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
});

// §5 pick rank: urgent bug → urgent feature → edge-case bug → bug → feature → improvement (FIFO within a rank).
const PICK_RANK = (t: Ticket): number =>
  t.priority === 1 && t.type === "Bug" ? 0
  : t.priority === 1 && t.type === "Feature" ? 1
  : t.type === "Bug" && t.labels.includes("edge-case") ? 2
  : t.type === "Bug" ? 3            // §5 rank 3.5 — defects beat features
  : t.type === "Feature" ? 4
  : 5;                              // Improvement and anything else

// The dev tiers (§21b): the legacy single `dev` plus the split pair. ONE membership test so the `queue` op, the
// servable-slice predicate below, and the scheduler's queue-gate can't drift on "who has an assignee-based Todo
// slice". pm/qa/architect/stewards are NOT dev tiers.
export const isDevTierActor = (actor: string): boolean =>
  actor === "dev" || actor === "senior-dev" || actor === "junior-dev";

// servableSlice — a dev tier's SERVABLE work: its §5-ranked Todo slice (own assignee, `blocked` excluded, and —
// for junior — `sensitive` excluded per LOOP-80 Child B) PLUS its own In Progress (the Step-0 orphan-resume
// input). This is the SINGLE source both `opQueue` and the scheduler's queue-depth fire-gate (LOOP-144) consume,
// so the gate can't grow a second, drifting copy of "what is servable". Callers pass a dev-tier actor
// (isDevTierActor); a non-dev actor just yields its (empty) assignee slice. Output is summarized (no bodies).
export function servableSlice(db: DatabaseSync, projectId: string, actor: string): { todo: Ticket[]; inProgress: Ticket[] } {
  const summary = (t: Ticket): Ticket => ({ ...t, description: "" });
  const byState = (state: string): Ticket[] =>
    (db.prepare("SELECT * FROM tickets WHERE project_id=? AND state=? ORDER BY created_at").all(projectId, state) as unknown as TicketRow[]).map(toTicket);
  const mine = (t: Ticket): boolean => actor === "dev" ? (t.assignee === null || t.assignee === "dev") : t.assignee === actor;
  // Layer-2 queue defense (design sensitive-routing §2 / LOOP-80 Child B): a residual sensitive+junior
  // row (written before the Layer-1 write gate or via a raw path) must never be served to junior-dev.
  const notSensitiveForJunior = (t: Ticket): boolean => actor !== "junior-dev" || !t.labels.includes("sensitive");
  const todo = byState("Todo")
    .filter((t) => mine(t) && !t.labels.includes("blocked") && notSensitiveForJunior(t))
    .sort((x, y) => PICK_RANK(x) - PICK_RANK(y) || x.created_at.localeCompare(y.created_at))
    .map(summary);
  const inProgress = byState("In Progress").filter((t) => t.assignee === actor && notSensitiveForJunior(t)).map(summary);
  return { todo, inProgress };
}
