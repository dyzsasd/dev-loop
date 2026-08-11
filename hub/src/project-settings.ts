// Per-project settings predicates — a LEAN LEAF (LOOP-481).
//
// This module's only dependency is `node:sqlite`, and that is the point rather than an accident.
// `humanWriteEnabled` has two callers with nothing else in common:
//
//   · `daemon.ts` gates its own human-write POST routes on it (DL-29 subsystem D), and
//   · `doctor.ts` must read it to know whether W20 / NEXT may prescribe the board page at all
//     (LOOP-481 AC4 — while the flag is off that page renders zero `<form>`, so linking it as the
//     way to *rule* hands the operator a dead end).
//
// `doctor` runs on every boot. Reaching the predicate through `daemon.ts` would pull the daemon's
// whole module graph — which reaches the MCP tool definitions and, through them, `zod` — into that
// path: the exact shape that broke the LOOP-58 `--help` test when `run-agents.ts` grew an import
// that reached a package. Copying the expression into `doctor.ts` instead is the LOOP-429 defect,
// two definitions free to drift. So it is RELOCATED here, imported by both, and duplicated nowhere.
//
// `hub/test/project-settings.ts` pins that leanness mechanically: it loads this module from a tree
// with no `node_modules`, which fails outright the moment the graph reaches any package.
import type { DatabaseSync } from "node:sqlite";

/**
 * Is the board's opt-in human-write surface ON for this project?
 *
 * Read FRESH from `projects.settings_json` on every call, so the operator can flip the flag
 * (`dev-loop settings set humanWrite.enabled true --project <key>`) without restarting the daemon.
 * Absent, malformed, or anything other than the boolean `true` ⇒ false: the gate fails CLOSED, and
 * an unreadable row is never read as permission.
 *
 * The shipped predicate is exported rather than re-expressed by its consumers on purpose. LOOP-479's
 * regression test flips the switch through the supported command and then asserts with THIS function;
 * a test that re-implemented the expression would still pass with the real gate deleted.
 */
export function humanWriteEnabled(db: DatabaseSync, projectId: string): boolean {
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    return JSON.parse(row?.settings_json ?? "{}")?.humanWrite?.enabled === true;
  } catch { return false; }
}
