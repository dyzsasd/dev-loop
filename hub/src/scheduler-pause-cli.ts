#!/usr/bin/env node
// `dev-loop pause` and `dev-loop resume` — manage scheduler pause state.
import { existsSync } from "node:fs";
import { openDb } from "./db.ts";
import { logEvent } from "./event-log.ts";
import { tryResolveWorkspace } from "./workspace.ts";
import { readPause, writePause, clearPause, formatPause } from "./scheduler-pause.ts";

function parseArgs(args: string[]): { action: string; reason?: string; until?: string } {
  const action = args[0];
  if (action !== "pause" && action !== "resume") {
    console.error("usage: dev-loop pause --reason <text> [--until <iso>]");
    console.error("       dev-loop resume");
    process.exit(2);
  }

  const result = { action };
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

  return result as any;
}

async function main(): Promise<void> {
  const ws = tryResolveWorkspace();
  if (!ws) {
    console.error("dev-loop pause/resume: no workspace here (no dev-loop.json in this directory or above)");
    process.exit(2);
  }

  const hubDbPath = ws.paths.hubDb;
  if (!existsSync(hubDbPath)) {
    console.error(`dev-loop pause/resume: no hub.db at ${hubDbPath}`);
    process.exit(5);
  }

  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  const actor = process.env.DEVLOOP_ACTOR || "operator";

  try {
    const db = openDb(hubDbPath);

    if (parsed.action === "pause") {
      const state = writePause(db, actor, parsed.reason!, parsed.until || null);
      logEvent(db, ws.file.team.key, "scheduler.pause", { actor, reason: parsed.reason });
      console.log(`dev-loop pause: ${formatPause(state)}`);
    } else {
      // resume
      const cleared = clearPause(db);
      if (cleared) {
        logEvent(db, ws.file.team.key, "scheduler.resume", { actor });
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
