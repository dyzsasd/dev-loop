import type { DatabaseSync } from "node:sqlite";
import { findProject } from "./seed.ts";
import { updateTicketRow, insertComment, type TicketUpdateFields } from "./ticketwrite.ts";

// Releases tickets claimed by a fire that was killed by infrastructure (timeout or stall).
// Queries the events ledger for claims this fire stamped (issue.transition → In Progress + matching fireId),
// re-checks each is still In Progress (a legitimately-advanced claim stays untouched), and moves it back to
// Todo with the tier assignee preserved (split-dev pick filter rides assignee on service). Best-effort:
// no-op when db is null/undefined (linear/local has no hub events ledger → degrades to Sweep backstop).
export function releaseClaimedTickets(
  db: DatabaseSync | null | undefined,
  project: string,
  actor: string,
  fireId: string,
  killClass?: "timeout" | "stall",
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
        const cur = db.prepare(
          `SELECT title,description,type,state,assignee,priority,labels,duplicate_of,related_to FROM tickets WHERE id=? AND project_id=?`
        ).get(ticket_id, projectId) as TicketUpdateFields | undefined;
        if (!cur || cur.state !== "In Progress") continue;
        updateTicketRow(db, projectId, actor, ticket_id, "In Progress", { ...cur, state: "Todo" });
        const killName = killClass === "timeout" ? "timeout" : killClass === "stall" ? "stall" : "timeout/stall";
        insertComment(db, projectId, actor, ticket_id,
          `Released to Todo — fire killed by infrastructure (${killName}); runner-side automatic, not agent judgment.`);
      } catch { /* best-effort per ticket */ }
    }
  } catch { /* best-effort — never crash teardown */ }
}
