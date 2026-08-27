#!/usr/bin/env node
// `dev-loop pause` and `dev-loop resume` — manage scheduler pause state.
import { existsSync } from "node:fs";
import { openDb, logEvent } from "./db.ts";
import { tryResolveWorkspace } from "./workspace.ts";
import { wsHubDb } from "./workspace.ts";
import { writePause, clearPause, formatPause } from "./scheduler-pause.ts";
import { TEAM_INTAKE_PROJECT } from "./team-config.ts";
import { findProject } from "./seed.ts";

interface ParsedArgs {
  action: "pause" | "resume";
  reason?: string;
  until?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const action = args[0];
  if (action !== "pause" && action !== "resume") {
    console.error("usage: dev-loop pause --reason <text> [--until <iso>]");
    console.error("       dev-loop resume");
    process.exit(2);
  }

  const result: ParsedArgs = { action: action as "pause" | "resume" };
  if (action === "pause") {
    const reasonIdx = args.indexOf("--reason");
    if (reasonIdx === -1) {
      console.error("dev-loop pause: --reason is required");
      process.exit(2);
    }
    if (reasonIdx + 1 >= args.length) {
      console.error("dev-loop pause: --reason requires a value");
      process.exit(2);
    }
    result.reason = args[reasonIdx + 1];

    const untilIdx = args.indexOf("--until");
    if (untilIdx !== -1 && untilIdx + 1 < args.length) {
      result.until = args[untilIdx + 1];
      // Validate ISO format and ensure not in the past
      try {
        const untilMs = new Date(result.until).getTime();
        const now = Date.now();
        if (untilMs <= now) {
          console.error("dev-loop pause: --until must be in the future");
          process.exit(2);
        }
      } catch {
        console.error("dev-loop pause: --until must be a valid ISO-8601 instant");
        process.exit(2);
      }
    }
  }

  return result;
}

async function main(): Promise<void> {
  const ws = tryResolveWorkspace();
  if (!ws) {
    console.error("dev-loop pause/resume: no workspace here (no dev-loop.json in this directory or above)");
    process.exit(2);
  }

  const hubDbPath = wsHubDb(ws);
  if (!existsSync(hubDbPath)) {
    console.error(`dev-loop pause/resume: no hub.db at ${hubDbPath}`);
    process.exit(5);
  }

  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  const actor = process.env.DEVLOOP_ACTOR || "operator";

  try {
    const db = openDb(hubDbPath);

    // `events.project_id` holds a project UUID — every reader (list_events, the daemon notifiers)
    // filters `WHERE project_id=?` with an id resolved from a key. Stamping the KEY "_team" here
    // instead writes rows that match no such filter, so `dev-loop events --project _team` returns
    // nothing and the pause/resume audit line is unreachable (LOOP-593's AC6 failure). Resolve the
    // reserved intake project to its row id, and refuse if it is absent rather than write a pause
    // whose audit line is silently lost — a workspace with a hub.db but no `_team` row was never
    // seeded by `team init`.
    const teamProjectId = findProject(db, TEAM_INTAKE_PROJECT);
    if (!teamProjectId) {
      console.error(
        `dev-loop pause/resume: no '${TEAM_INTAKE_PROJECT}' project in ${hubDbPath} — this workspace was not seeded by 'dev-loop team init'`,
      );
      db.close();
      process.exit(5);
    }

    if (parsed.action === "pause") {
      const state = writePause(db, actor, parsed.reason!, parsed.until || null);
      logEvent(db, {
        project_id: teamProjectId,
        actor,
        kind: "scheduler.pause",
        data: { reason: parsed.reason, until: parsed.until || null }
      });
      console.log(`dev-loop pause: ${formatPause(state)}`);
    } else {
      // resume
      const cleared = clearPause(db);
      if (cleared) {
        logEvent(db, {
          project_id: teamProjectId,
          actor,
          kind: "scheduler.resume"
        });
        console.log("dev-loop resume: scheduler pause cleared");
      } else {
        console.log("dev-loop resume: no pause was active (idempotent)");
      }
    }

    db.close();
  } catch (e) {
    if (String(e).includes("SQLITE_BUSY")) {
      console.error("dev-loop pause/resume: hub.db is busy (daemon or another fire holding it) — try again");
      process.exit(5);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(`dev-loop pause/resume: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
