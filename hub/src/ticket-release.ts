import type { DatabaseSync } from "node:sqlite";
import { findProject } from "./seed.ts";
import { updateTicketRow, insertComment, readTicketUpdateFields } from "./ticketwrite.ts";

// Releases tickets claimed by a fire that was killed by infrastructure: the watchdogs (timeout, stall,
// the LOOP-230 per-fire budget) and the provider-side kills the taxonomy already names — session-limit,
// spend-limit, rate-limit, auth, network. The line between the two groups was never a contract, only
// which killer happened to be an in-process timer: the agent's judgement ended the fire in NEITHER case,
// and its claim is stranded either way. session-limit is the common one in practice (20 of 30 failures
// in one workspace over 24h), and a stranded claim is invisible — pick reads Todo, so no lane ever
// returns to a ticket left In Progress. Queries the events ledger for claims this fire stamped (issue.transition →
// In Progress + matching fireId), re-checks each is still In Progress (a legitimately-advanced claim stays
// untouched), and moves it back to Todo with the tier assignee preserved (split-dev pick filter rides assignee
// on service). Best-effort: no-op when db is null/undefined (linear/local has no hub events ledger → Sweep backstop).
/**
 * Why the fire that held the claim ended. Every member is something OTHER than the agent's judgement —
 * the watchdogs, the provider-side kills the taxonomy names, and the operator's own stop.
 */
export type KillClass =
  | "timeout" | "stall" | "budget"
  | "session-limit" | "spend-limit" | "rate-limit" | "auth" | "network" | "budget-deadline"
  | "interrupt";

/**
 * The comment left on a released ticket. Every class has its own name, and an unrecognised one falls back
 * to the class itself rather than to a fixed string: the previous form defaulted to the literal
 * "timeout/stall", so widening the union silently mislabelled every new member — a session-limit release
 * (the most common kind in practice) told the reader the fire had timed out, contradicting the errorClass
 * in the same fire's ledger row.
 */
function releaseNote(killClass?: KillClass): string {
  if (killClass === "interrupt") {
    return "Released to Todo — the operator stopped the scheduler while this fire held the claim; runner-side automatic, not agent judgment. Any work the fire pushed is on its branch.";
  }
  const named: Partial<Record<KillClass, string>> = {
    timeout: "fire timeout", stall: "output stall", budget: "budget perFireUsd",
    "budget-deadline": "budget deadline", "session-limit": "provider session limit",
    "spend-limit": "provider spend limit", "rate-limit": "provider rate limit",
    auth: "provider auth failure", network: "network failure",
  };
  const name = killClass ? (named[killClass] ?? killClass) : "unrecorded cause";
  return `Released to Todo — fire killed by infrastructure (${name}); runner-side automatic, not agent judgment.`;
}

export function releaseClaimedTickets(
  db: DatabaseSync | null | undefined,
  project: string,
  actor: string,
  fireId: string,
  killClass?: KillClass,
): void {
  if (!db) return;
  try {
    const projectId = findProject(db, project);
    if (!projectId) return;
    const rows = db.prepare(
      `SELECT ticket_id FROM events WHERE project_id=? AND kind='issue.transition' AND json_extract(data,'$.to')='In Progress' AND json_extract(data,'$.fireId')=?`
    ).all(projectId, fireId) as { ticket_id: string }[];
    for (const { ticket_id } of rows) {
      try {
        // LOOP-587: the shared reader, never a hand-rolled column list — this loop's `catch` below is
        // per-ticket and silent, so a row missing a column would strand the release with no signal.
        const cur = readTicketUpdateFields(db, projectId, ticket_id);
        if (!cur || cur.state !== "In Progress") continue;
        updateTicketRow(db, projectId, actor, ticket_id, "In Progress", { ...cur, state: "Todo" });
        insertComment(db, projectId, actor, ticket_id, releaseNote(killClass));
      } catch { /* best-effort per ticket */ }
    }
  } catch { /* best-effort — never crash teardown */ }
}
