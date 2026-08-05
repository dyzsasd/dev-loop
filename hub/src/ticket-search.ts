// The ONE ticket-search predicate (LOOP-97).
//
// "Search the board" was implemented twice, independently, and neither was a superset of the other:
//
//   axis                | web ?q= (views/board.ts) | agent query (agentops.ts)
//   --------------------|--------------------------|---------------------------
//   ticket id           | yes                      | NO
//   title               | yes                      | yes
//   description         | first 5,000 chars only   | full
//   COMMENT BODIES      | NO                       | yes
//   multi-word          | one literal substring    | whitespace-split, AND-ed
//
// The same query returned different answers depending on which surface you asked, and both failed
// SILENTLY — an empty result reads as "no such ticket", never as "this surface does not index that".
// A human searching for a phrase that appears only in a comment got nothing; an agent searching for
// a ticket id got nothing.
//
// The union is the correct target on every axis: id (an operator pastes one), comments (the §8 dedup
// query catches a reworded duplicate whose only match is a "review failed:" note), full description,
// and AND-ed terms. Nothing here is a new capability — each half already existed on one side.
//
// Zero-import leaf: `views/board.ts` and `agentops.ts` both consume it, and board.ts must stay free
// of agentops' zod tree.

/**
 * How many description characters the LIKE scans per row.
 *
 * ONE constant for BOTH paths, which is the point: the two surfaces used to disagree (web capped at
 * 5,000, the agent did not), so the same ticket matched on one and not the other with nothing saying
 * why. A leading-wildcard LIKE can never use an index, so an uncapped scan is the per-row cost of a
 * pathological multi-hundred-KB agent-authored description.
 *
 * The cap stays, and it is the WEB's value, because the cost argument that justified it applies
 * equally to both callers — the agent path simply never had it. Raising it is a decision with a
 * measurement behind it, which this ticket does not have; making the surfaces AGREE is the fix.
 */
export const SEARCH_DESC_CAP = 5000;

export interface SearchClause { sql: string; binds: string[] }

/** Escape LIKE metacharacters so a literal `%` in a query can never wildcard. */
const escapeLike = (term: string): string => term.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The WHERE fragment for a free-text query, and its binds.
 *
 * Whitespace splits the query into AND-ed terms: "daemon health probe" matches only tickets hitting
 * every term. Each term matches against id, title, the capped description, OR a comment body.
 *
 * Returns null for an empty/blank query — the caller adds nothing to its WHERE.
 *
 * `ticketsAlias` names the tickets table in the caller's query, because the comment EXISTS subquery
 * has to correlate back to it and the two call sites alias it differently.
 */
export function ticketSearchClause(query: string | undefined, ticketsAlias = "tickets"): SearchClause | null {
  const q = (query ?? "").trim();
  if (!q) return null;
  const sql: string[] = [];
  const binds: string[] = [];
  for (const term of q.split(/\s+/)) {
    const like = `%${escapeLike(term.toLowerCase())}%`;
    sql.push(
      `(lower(${ticketsAlias}.id) LIKE ? ESCAPE '\\'`
      + ` OR lower(${ticketsAlias}.title) LIKE ? ESCAPE '\\'`
      + ` OR lower(substr(${ticketsAlias}.description,1,${SEARCH_DESC_CAP})) LIKE ? ESCAPE '\\'`
      + ` OR EXISTS(SELECT 1 FROM comments c WHERE c.ticket_id=${ticketsAlias}.id AND lower(c.body) LIKE ? ESCAPE '\\'))`,
    );
    binds.push(like, like, like, like);
  }
  return { sql: sql.join(" AND "), binds };
}

/** What the search actually covers, for the input's placeholder — so the UI cannot over- or under-promise. */
export const SEARCH_CORPUS_LABEL = "id, title, description, comments";
