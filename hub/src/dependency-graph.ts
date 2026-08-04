// dev-loop hub — read-only dependency-graph surface for §9c/W5 unpark queries (LOOP-105).
// Built on the Child-1 canonical parser (hub/src/blocked-by.ts) — NO new marker regex.
// Design R3: reported, never enforced — no state changes, no label strip, no auto-unpark.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { liveBlockerIds } from "./blocked-by.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

/** A single blocked ticket and its live blocker set. */
export interface BlockedEdge {
  ticketId: string;
  blockers: string[]; // live blocker ids from the canonical parser
}

/** Integrity flag for a blocked ticket. */
export interface IntegrityFlags {
  /** Blocker id does not exist / is cross-project — never reaches terminal. */
  dangling: string[];
  /** ≥1 live blocker edge AND every live blocker is terminal (Done/Canceled/Duplicate). */
  unparkEligible: boolean;
  /** This ticket is part of a dependency cycle (A→B→A). */
  cyclic: boolean;
  /** `blocked` label present but zero blocker edges (e.g. Human-Blocked or pre-step-1). */
  noEdge: boolean;
}

/** Per-blocker reverse fan-out (direct + transitive). */
export interface ReverseFanOut {
  blockerId: string;
  /** Tickets directly gated by this blocker (blocker appears in their live set). */
  direct: string[];
  /** Tickets transitively gated: blocker → A → B → C → {"A","B","C"}. */
  transitive: string[];
}

/** Full dependency-graph report for one project. */
export interface DependencyGraphReport {
  /** Every open `blocked` ticket mapped to its live blockers. */
  blockedEdges: BlockedEdge[];
  /** Reverse fan-out for every blocker that gates ≥1 ticket. */
  reverseFanOut: ReverseFanOut[];
  /** Integrity flags per blocked ticket, keyed by ticket id. */
  integrity: Record<string, IntegrityFlags>;
  /** Non-terminal blocker ids that resolved to no ticket row (dangling — cross-project or deleted). */
  allDangling: string[];
  /** Non-terminal blocker ids that gate tickets (for operator triage). */
  gatingOpen: string[];
}

const TERMINAL = new Set(["Done", "Canceled", "Duplicate"]);

// ─── Pure graph helpers ────────────────────────────────────────────────────

/**
 * Compute reverse transitive fan-out from a forward adjacency map.
 * Forward: ticketId → set of blocker ids.
 * Returns: blockerId → set of all tickets (direct + transitive) it gates.
 */
function transitiveReverseFanOut(
  forward: Map<string, Set<string>>,
): Map<string, Set<string>> {
  // Build reverse map: blockerId → set of tickets that list it directly.
  const reverse = new Map<string, Set<string>>();
  for (const [ticketId, blockers] of forward) {
    for (const blocker of blockers) {
      let gated = reverse.get(blocker);
      if (!gated) {
        gated = new Set();
        reverse.set(blocker, gated);
      }
      gated.add(ticketId);
    }
  }

  // Compute transitive closure: for each blocker, walk the graph.
  // If A blocks B and B blocks C, then A transitively blocks {B, C}.
  const result = new Map<string, Set<string>>();
  for (const blocker of reverse.keys()) {
    const visited = new Set<string>();
    const stack = [...(reverse.get(blocker) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const children = reverse.get(current);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }
    // Remove the blocker itself if it somehow appears (defensive).
    visited.delete(blocker);
    if (visited.size > 0) result.set(blocker, visited);
  }

  return result;
}

/**
 * Detect cycles using DFS in the forward graph (ticket → blockers).
 * Returns the set of ticket ids that are part of any cycle.
 */
function findCyclic(forward: Map<string, Set<string>>): Set<string> {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of forward.keys()) color.set(id, WHITE);

  const cyclic = new Set<string>();

  function dfs(node: string): void {
    color.set(node, GRAY);
    const neighbors = forward.get(node);
    if (neighbors) {
      for (const n of neighbors) {
        const c = color.get(n);
        if (c === GRAY) {
          // Back edge → cycle: mark all nodes in the stack.
          cyclic.add(node);
          cyclic.add(n);
        } else if (c === WHITE) {
          dfs(n);
        }
      }
    }
    color.set(node, BLACK);
  }

  for (const id of forward.keys()) {
    if (color.get(id) === WHITE) dfs(id);
  }

  return cyclic;
}

// ─── DB query wrapper ──────────────────────────────────────────────────────
type Db = import("node:sqlite").DatabaseSync;

interface TicketRow { id: string; state: string; labels: string }

/**
 * Build the full dependency-graph report for one project.
 * Pure function — all db reads happen here so callers pass only a db + projectId.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dependencyGraph(db: any, projectId: string): DependencyGraphReport {
  // 1. Fetch ALL non-terminal tickets in the project.
  const allTickets = db.prepare(
    "SELECT id, state, labels FROM tickets WHERE project_id=? AND state NOT IN ('Done','Canceled','Duplicate') ORDER BY id",
  ).all(projectId) as TicketRow[];

  // 2. Build the forward map: ticketId → set of blocker ids (from liveBlockerIds parser).
  const forward = new Map<string, Set<string>>();
  // Track ALL blocker ids referenced across the project.
  const allReferencedBlockerIds = new Set<string>();
  const blockedTickets: string[] = [];

  for (const t of allTickets) {
    let labels: string[] = [];
    try { labels = JSON.parse(t.labels) as string[]; } catch { /* no labels */ }

    const isBlocked = labels.includes("blocked");
    if (isBlocked) blockedTickets.push(t.id);

    // Parse blockers for EVERY non-terminal ticket (not just blocked ones),
    // because non-blocked tickets may still carry marker comments.
    const comments = db.prepare(
      "SELECT body FROM comments WHERE ticket_id=? ORDER BY created_at, rowid",
    ).all(t.id) as { body: string }[];

    const { live, hadReadFailure } = liveBlockerIds(comments);
    if (live.size > 0) {
      forward.set(t.id, live);
      for (const id of live) allReferencedBlockerIds.add(id);
    }
  }

  // 3. Look up state for every referenced blocker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blockerStates = new Map<string, string | null>(); // null = does not exist
  for (const id of allReferencedBlockerIds) {
    const row = db.prepare("SELECT state FROM tickets WHERE id=?").get(id) as { state: string } | undefined;
    blockerStates.set(id, row?.state ?? null);
  }

  // 4. Build per-ticket integrity flags.
  const integrity: Record<string, IntegrityFlags> = {};
  const allDangling = new Set<string>();
  const gatingOpen = new Set<string>();

  for (const ticketId of blockedTickets) {
    const blockers = forward.get(ticketId);
    const noEdge = !blockers || blockers.size === 0;

    const dangling: string[] = [];
    let allTerminal = true;

    if (blockers) {
      for (const id of blockers) {
        const state = blockerStates.get(id);
        if (state === null) {
          dangling.push(id);
        } else if (!TERMINAL.has(state)) {
          allTerminal = false;
        }
      }
    }

    // PM binding AC: unpark-eligible requires ≥1 live blocker edge.
    // A blocked ticket with zero live edges is NOT unpark-eligible.
    const unparkEligible = !noEdge && allTerminal && dangling.length === 0;

    integrity[ticketId] = { dangling, unparkEligible, cyclic: false, noEdge };
    for (const d of dangling) allDangling.add(d);
  }

  // 5. Detect cycles across the full forward graph (not just blocked tickets).
  const cyclicSet = findCyclic(forward);
  for (const id of cyclicSet) {
    if (integrity[id]) {
      integrity[id].cyclic = true;
    }
  }

  // 6. Build reverse fan-out (transitive).
  const transitiveReverse = transitiveReverseFanOut(forward);

  const reverseFanOut: ReverseFanOut[] = [];
  // Sort by blocker id for deterministic output.
  const sortedBlockers = [...transitiveReverse.keys()].sort();
  for (const blockerId of sortedBlockers) {
    const trans = transitiveReverse.get(blockerId)!;
    const direct = forward.size > 0
      ? [...forward.entries()]
          .filter(([, blockers]) => blockers.has(blockerId))
          .map(([id]) => id)
          .sort()
      : [];
    reverseFanOut.push({
      blockerId,
      direct,
      transitive: [...trans].sort(),
    });

    // Track open blockers that gate tickets.
    const state = blockerStates.get(blockerId);
    if (state && !TERMINAL.has(state)) gatingOpen.add(blockerId);
  }

  // 7. Build blockedEdges.
  const blockedEdges: BlockedEdge[] = blockedTickets
    .map((id) => ({
      ticketId: id,
      blockers: [...(forward.get(id) ?? [])].sort(),
    }))
    .sort((a, b) => a.ticketId.localeCompare(b.ticketId));

  return {
    blockedEdges,
    reverseFanOut,
    integrity,
    allDangling: [...allDangling].sort(),
    gatingOpen: [...gatingOpen].sort(),
  };
}