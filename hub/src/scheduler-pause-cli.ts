#!/usr/bin/env node
// `dev-loop pause` and `dev-loop resume` — manage scheduler pause state.
//
// WS-C C3 adds `--drain`: pause, then BLOCK until no fire is in flight. "In flight" is read from the
// scheduler's own runner logs through status.ts's `inFlightFires` (the same reader `dev-loop status`
// renders as DRAINING), so the drain and the status line cannot disagree. The pause is written FIRST
// and stays set on a timeout — a drain that times out has still stopped new fires, which is what the
// operator asked for; exit 1 tells them the old ones have not finished.
import { existsSync } from "node:fs";
import { openDb } from "./db.ts";
import { tryResolveWorkspace } from "./workspace.ts";
import { wsHubDb } from "./workspace.ts";
import { readPause, writePause, clearPause, formatPause } from "./scheduler-pause.ts";
import { formatAge, inFlightFires, readRunLock } from "./status.ts";

interface ParsedArgs {
  action: "pause" | "resume";
  reason?: string;
  until?: string;
  drain: boolean;
  timeoutS: number;
}

export const DEFAULT_DRAIN_TIMEOUT_S = 1800; // the longest fire wall the scheduler ships by default is 30m

function usage(): void {
  console.error("usage: dev-loop pause --reason <text> [--until <iso>] [--drain [--timeout <seconds>]]");
  console.error("       dev-loop resume");
  console.error("  --drain    after pausing, wait until no fire is in flight (progress on stdout); exit 0 drained,");
  console.error("             1 on timeout — the pause STAYS set either way. `dev-loop status` shows DRAINING meanwhile.");
}

function parseArgs(args: string[]): ParsedArgs {
  const action = args[0];
  if (action !== "pause" && action !== "resume") { usage(); process.exit(2); }
  if (args.includes("--help") || args.includes("-h")) { usage(); process.exit(0); }

  const result: ParsedArgs = { action: action as "pause" | "resume", drain: false, timeoutS: DEFAULT_DRAIN_TIMEOUT_S };
  if (action === "pause") {
    result.drain = args.includes("--drain");
    const reasonIdx = args.indexOf("--reason");
    if (reasonIdx === -1) {
      // A drain is its own reason; a bare pause still has to say why (the record is read back later).
      if (!result.drain) { console.error("dev-loop pause: --reason is required"); process.exit(2); }
      result.reason = "drain";
    } else {
      if (reasonIdx + 1 >= args.length) { console.error("dev-loop pause: --reason requires a value"); process.exit(2); }
      result.reason = args[reasonIdx + 1];
    }

    const untilIdx = args.indexOf("--until");
    if (untilIdx !== -1 && untilIdx + 1 < args.length) {
      result.until = args[untilIdx + 1];
      // Validate ISO format and ensure not in the past
      const untilMs = new Date(result.until).getTime();
      if (!Number.isFinite(untilMs)) { console.error("dev-loop pause: --until must be a valid ISO-8601 instant"); process.exit(2); }
      if (untilMs <= Date.now()) { console.error("dev-loop pause: --until must be in the future"); process.exit(2); }
    }

    const timeoutIdx = args.indexOf("--timeout");
    if (timeoutIdx !== -1) {
      const v = Number(args[timeoutIdx + 1]);
      if (!Number.isFinite(v) || v < 0) { console.error("dev-loop pause: --timeout must be a non-negative number of seconds"); process.exit(2); }
      result.timeoutS = v;
    }
  }

  return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the in-flight reader until it is empty or the deadline passes. Returns the fires still in
 * flight at the end (empty ⇒ drained). Progress lines go through `log` so a harness can read them.
 * DEVLOOP_DRAIN_POLL_MS shortens the poll for tests; the default is a gentle 5s.
 */
export async function drainUntilIdle(ws: NonNullable<ReturnType<typeof tryResolveWorkspace>>, timeoutS: number, log: (line: string) => void = (l) => console.log(l)): Promise<ReturnType<typeof inFlightFires>> {
  const pollMs = Math.max(20, Number(process.env.DEVLOOP_DRAIN_POLL_MS) || 5000);
  const deadline = Date.now() + timeoutS * 1000;
  let last = "";
  for (;;) {
    const lock = readRunLock(ws);
    if (!lock.alive) { log("dev-loop pause: no scheduler running — nothing is in flight"); return []; }
    const sinceMs = lock.startedAt ? Date.parse(lock.startedAt) : undefined;
    const inFlight = inFlightFires(ws, { sinceMs });
    if (!inFlight.length) return [];
    const line = `dev-loop pause: draining — ${inFlight.length} in flight: ${inFlight.map((f) => `${f.agent}@${f.project} (${formatAge(f.ageMs)})`).join(", ")}`;
    if (line !== last) { log(line); last = line; }
    if (Date.now() >= deadline) return inFlight;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
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

    if (parsed.action === "pause") {
      const state = writePause(db, actor, parsed.reason!, parsed.until || null);
      console.log(`dev-loop pause: ${formatPause(state)}`);
    } else {
      // resume
      const cleared = clearPause(db);
      if (cleared) {
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

  if (parsed.action === "pause" && parsed.drain) {
    const left = await drainUntilIdle(ws, parsed.timeoutS);
    if (left.length) {
      console.error(`dev-loop pause: drain timed out after ${parsed.timeoutS}s — ${left.length} still in flight (${left.map((f) => `${f.agent}@${f.project}`).join(", ")}). The pause STAYS set; \`dev-loop status\` shows DRAINING until they finish, \`dev-loop stop\` ends them.`);
      process.exit(1);
    }
    console.log("dev-loop pause: drained — no fire in flight; the scheduler is paused (`dev-loop resume` to continue)");
  }
}

main().catch((e) => {
  console.error(`dev-loop pause/resume: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
