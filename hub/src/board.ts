#!/usr/bin/env node
// `dev-loop board snapshot | snapshots` — the board-only backup artifact (LOOP-338, Child B).
//
// The board had never been snapshotted once. On 2026-08-04 the whole `loop` board was
// cascade-deleted and recovery was a hand-run `sqlite3 .recover` two hours later; 19 tickets and 79
// comments were lost permanently, because no copy existed. `bundle export --backup` could already
// take one — nothing ever invoked it, and nothing reported its absence.
//
// Board-only, not a bundle: a bundle carries dev-loop.json plus every referenced secret VALUE plus
// the git deploy key, so writing that unattended and retaining N generations is a new secret-at-rest
// surface with a growing blast radius (LOOP-210 / LOOP-162). This artifact satisfies "no secrets"
// BY CONSTRUCTION — the code path never reads one, so no later edit can regress it into leaking one.
// It is also the RIGHT artifact: the incident wiped a board inside an otherwise intact workspace.
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace, wsHubDb, wsStateRoot } from "./workspace.ts";
import { listSnapshots, takeBoardSnapshot, restoreBoard, verifySnapshot } from "./board-snapshot.ts";
import { workspaceIsolationVerdict, activeFireMarker } from "./destructive-guard.ts"; // LOOP-341: the EXISTING gate, reused
import { join } from "node:path";

const DEFAULT_KEEP = 10;

function usage(): void {
  console.log(`dev-loop board <subcommand>

  snapshot [--dir <d>] [--keep <n>] [--reason <r>]   take ONE consistent copy of this workspace's
                                                     board (hub.db only — never a secret), prune to
                                                     the newest <n> generations, print its path
  snapshots [--dir <d>]                              list generations, newest first
  restore --from <snapshot> [--dir <d>]              REPLACE this workspace's board with a snapshot
                                                     (gated: needs the confirmation token; takes a
                                                     'pre-restore' copy first so it is undoable)

  --dir     default <workspace>/.dev-loop/snapshots/
  --keep    default ${DEFAULT_KEEP}; 0 disables pruning
  --reason  cadence | pre-<verb> | manual (default: manual) — rides the filename

The timestamp lives IN the filename, so listing and retention never depend on mtime (a restore or a
file copy rewrites mtimes and would otherwise silently reorder the generations).`);
}

// board-YYYYMMDDTHHMMSSZ → an ISO instant, for the age column only.
function fmtAge(takenAt: string, now: number): string {
  const iso = `${takenAt.slice(0, 4)}-${takenAt.slice(4, 6)}-${takenAt.slice(6, 11)}:${takenAt.slice(11, 13)}:${takenAt.slice(13, 15)}Z`;
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.max(0, Math.floor(ms / 60_000))}m`;
}

export function boardCmd(argv = process.argv.slice(2)): number {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { usage(); return 0; }

  let dir: string | undefined, keep = DEFAULT_KEEP, reason = "manual", from: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dir") dir = rest[++i];
    else if (a === "--from") from = rest[++i];
    else if (a === "--keep") {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 0) { console.error("dev-loop board: --keep must be a non-negative integer"); return 2; }
      keep = n;
    } else if (a === "--reason") {
      const r = rest[++i] ?? "";
      if (!/^[A-Za-z0-9._-]+$/.test(r)) { console.error("dev-loop board: --reason must match [A-Za-z0-9._-]+ (it rides the filename)"); return 2; }
      reason = r;
    } else if (a.startsWith("--i-understand-this-deletes-")) { /* the isolation token — read from argv by the verdict */ }
    else { console.error(`dev-loop board: unknown flag '${a}'`); return 2; }
  }

  const ws = resolveWorkspace();
  const snapDir = dir ?? join(wsStateRoot(ws), "snapshots");

  if (sub === "snapshot") {
    // A failure throws and exits NON-ZERO with the real error. Never a swallowed warning: silently
    // producing a corrupt backup is worse than failing to produce one, and that exact degradation
    // is the defect LOOP-337 removed from the bundle path.
    console.log(takeBoardSnapshot({ dbPath: wsHubDb(ws), dir: snapDir, keep, reason }));
    return 0;
  }
  if (sub === "snapshots") {
    const rows = listSnapshots(snapDir);
    if (!rows.length) { console.log(`no board snapshots in ${snapDir} — take one: dev-loop board snapshot`); return 0; }
    const now = Date.now();
    console.log(`board snapshots — ${snapDir} (newest first)`);
    for (const r of rows)
      console.log(`  ${r.takenAt}  ${fmtAge(r.takenAt, now).padStart(4)} ago  ${(r.bytes / 1024).toFixed(0).padStart(7)} KB  ${r.reason}`);
    return 0;
  }
  if (sub === "restore") {
    // The ONE child in this module that writes over a live board. Gated by the EXISTING
    // destructive-guard token — no new gate, and `--force` is untouched (it answers the
    // recoverability question and must never become the isolation token).
    if (!from) { console.error("dev-loop board restore: --from <snapshot> is required (list them: dev-loop board snapshots)"); return 2; }
    // LOOP-367: a FIRE may not destroy the live board, token or no token. Checked before --from is even
    // validated, so no ordering of arguments reaches the restore. See activeFireMarker() for why there is
    // no bypass flag.
    const marker = activeFireMarker();
    if (marker) {
      console.error(`dev-loop board restore: refusing inside an agent fire (${marker} is set). Replacing a live board is an operator action — the confirmation token answers "did you mean this project?", not "may a fire do this at all". Nothing has been written. If a restore is genuinely needed, file it on the board for the operator; to verify this verb, do it in a disposable workspace (mkdtemp + dev-loop team init --dir <tmp>) with the fire markers unset.`);
      return 4;
    }
    const verdict = workspaceIsolationVerdict(ws, argv);
    const live = verifySnapshot(wsHubDb(ws));
    // A NON-EMPTY board is protected: refuse without the token. An absent or already-broken board is
    // exactly what a restore is for, so it is not gated — there is nothing to lose.
    if (live.ok && (live.tickets ?? 0) > 0 && verdict.refusal) {
      console.error(`dev-loop board restore: this board still holds ${live.tickets} ticket(s) and ${live.comments} comment(s) — restoring REPLACES them. Pass ${verdict.requiredToken} to confirm. Nothing has been written.`);
      return 4;
    }
    const check = verifySnapshot(from);
    if (!check.ok) { console.error(`dev-loop board restore: ${check.error}. The existing board is untouched.`); return 1; }
    const r = restoreBoard({ from, dbPath: wsHubDb(ws), dir: snapDir, keep });
    console.log(`restored ${r.tickets} ticket(s) and ${r.comments} comment(s) from ${from}`);
    if (r.preRestore) console.log(`the board it replaced is kept at ${r.preRestore} — restore that generation to undo`);
    console.log(`restart the daemon so it stops serving the old board from its open connection: dev-loop daemon up`);
    return 0;
  }
  console.error(`dev-loop board: unknown subcommand '${sub}' (snapshot|snapshots|restore)`);
  usage();
  return 2;
}

if (isMainEntry(import.meta.url)) process.exit(boardCmd());
