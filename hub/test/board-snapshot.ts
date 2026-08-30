// LOOP-337 + LOOP-338 — the board snapshot: a copy that is actually openable, and an artifact the
// operator does not have to remember to take.
//
// `bundle export --backup` CLAIMED to take a live, WAL-checkpointed copy. Measured on node:sqlite /
// Node 23.6.0 it could instead emit an unopenable file with nothing detecting it, because
// `exec("PRAGMA wal_checkpoint(TRUNCATE)")` does not RAISE on a busy checkpoint (the surrounding
// catch was unreachable dead code) and `readFileSync` of a live SQLite main file is not an atomic
// read. On 2026-08-04 the whole board was cascade-deleted and there was no copy to restore from.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  snapshotBoardDb, takeBoardSnapshot, listSnapshots, pruneSnapshots, snapshotName,
  restoreBoard, verifySnapshot,                                          // LOOP-341, Child E
  boardSnapshotTick, startBoardSnapshot, snapshotBeforeDestructive, resolveBackupConfig, // LOOP-339, Child C
} from "../src/board-snapshot.ts";
import { commitBothHalves } from "../src/destructive-guard.ts";
import { scrubFireEnv } from "./env-scrub.ts";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-boardsnap-")));

// A WAL db with rows that were NEVER checkpointed — the shape the old path lost.
function makeWalDb(path: string, rows: number): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  for (let i = 0; i < rows; i++) db.prepare("INSERT INTO t(v) VALUES(?)").run(`row-${i}`);
  db.close(); // closing checkpoints; the caller re-opens and writes MORE to leave rows in the WAL
}

try {
  // ── LOOP-337 AC2: the WAL-only write survives, and the CONTROL proves it matters ──────────────
  {
    const src = join(tmp, "wal.db");
    makeWalDb(src, 5);
    // Re-open and write rows that stay in the WAL: hold the connection open so nothing checkpoints.
    const live = new DatabaseSync(src);
    live.exec("PRAGMA journal_mode=WAL");
    for (let i = 0; i < 20; i++) live.prepare("INSERT INTO t(v) VALUES(?)").run(`wal-only-${i}`);

    const snap = join(tmp, "snap-wal.db");
    snapshotBoardDb(src, snap);
    const sdb = new DatabaseSync(snap, { readOnly: true });
    const snapCount = (sdb.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
    sdb.close();
    ok(snapCount === 25, `LOOP-337 AC2: the snapshot carries the WAL-only rows (got ${snapCount}, want 25)`);

    // THE CONTROL. Without it this test would pass against the broken code too: copy the main file
    // the way the old path did and show the WAL-only rows are NOT there.
    const naive = join(tmp, "naive.db");
    writeFileSync(naive, readFileSync(src));
    let naiveCount = -1;
    try {
      const ndb = new DatabaseSync(naive, { readOnly: true });
      naiveCount = (ndb.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
      ndb.close();
    } catch { naiveCount = -1; } // an unopenable copy is the other half of the same defect
    ok(naiveCount !== 25,
      `LOOP-337 AC2 control: the naive readFileSync copy does NOT recover them (got ${naiveCount === -1 ? "unopenable" : naiveCount}) — so the assertion above is not vacuous`);
    live.close();
  }

  // ── LOOP-337 AC3: a concurrent reader — precisely the case that corrupted the old path ───────
  {
    const src = join(tmp, "concurrent.db");
    makeWalDb(src, 10);
    const reader = new DatabaseSync(src, { readOnly: true });
    reader.exec("BEGIN");                       // hold an open read transaction ACROSS the snapshot
    reader.prepare("SELECT COUNT(*) FROM t").get();
    const snap = join(tmp, "snap-concurrent.db");
    let threw = "";
    try { snapshotBoardDb(src, snap); } catch (e) { threw = (e as Error).message; }
    ok(threw === "", `LOOP-337 AC3: the snapshot succeeds with an open read txn on the source (${threw})`);
    const sdb = new DatabaseSync(snap, { readOnly: true });
    ok((sdb.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n === 10,
      "LOOP-337 AC3: …and it is COMPLETE — this is the case that used to corrupt the artifact");
    sdb.close();
    try { reader.exec("ROLLBACK"); } catch { /* ignore */ }
    reader.close();
  }

  // ── LOOP-337 R3/R4: atomicity, and no artifact survives a failure ────────────────────────────
  {
    const src = join(tmp, "r34.db");
    makeWalDb(src, 3);
    // R3 — VACUUM INTO REFUSES a non-empty target ("file is not a database") and silently overwrites
    // a zero-length one, so writing straight to `dest` is not safe. The temp+rename shape is what
    // makes an occupied destination work at all, and makes the replacement ATOMIC: no reader ever
    // sees a half-written generation.
    //
    // My first version of this test asserted the occupied file was left UNTOUCHED. That was me
    // testing VACUUM INTO's raw constraint rather than the behaviour the design chose — overwriting
    // an existing generation atomically is exactly what a snapshot should do.
    const dest = join(tmp, "occupied.db");
    writeFileSync(dest, "not a database at all");
    let err = "";
    try { snapshotBoardDb(src, dest); } catch (e) { err = (e as Error).message; }
    ok(err === "", `LOOP-337 R3: an OCCUPIED destination is replaced, not refused — that is what temp+rename buys (${err})`);
    const replaced = new DatabaseSync(dest, { readOnly: true });
    ok((replaced.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n === 3,
      "LOOP-337 R3: …and what lands is a VALID board, not the bytes that were there before");
    replaced.close();
    const strays = readdirSync(tmp).filter((f) => f.startsWith(".board-snapshot-"));
    ok(strays.length === 0, `LOOP-337 R3: no temp file is left behind on the SUCCESS path either (found ${strays.join(",")})`);

    let missErr = "";
    try { snapshotBoardDb(join(tmp, "does-not-exist.db"), join(tmp, "out.db")); } catch (e) { missErr = (e as Error).message; }
    ok(missErr !== "" && !existsSync(join(tmp, "out.db")),
      "LOOP-337 R4: a missing SOURCE also throws and writes nothing");
  }

  // ── LOOP-338 AC3: retention is by EMBEDDED TIMESTAMP, never mtime ─────────────────────────────
  {
    const src = join(tmp, "retention.db");
    makeWalDb(src, 2);
    const dir = join(tmp, "gens");
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
    for (let i = 0; i < 5; i++) takeBoardSnapshot({ dbPath: src, dir, keep: 0, reason: "cadence", now: at(i) });
    ok(listSnapshots(dir).length === 5, "LOOP-338: keep=0 disables pruning entirely");

    // Give the files DELIBERATELY MISLEADING mtimes: the two OLDEST by embedded timestamp are made
    // to look newest. An mtime-based implementation keeps the wrong three and fails below.
    const files = readdirSync(dir).sort();
    const future = Date.now() / 1000 + 86_400;
    utimesSync(join(dir, files[0]), future, future);
    utimesSync(join(dir, files[1]), future, future);

    pruneSnapshots(dir, 3);
    const left = listSnapshots(dir).map((s) => s.takenAt).sort();
    ok(left.length === 3, `LOOP-338 AC3: keep=3 leaves exactly 3 (got ${left.length})`);
    ok(left.join(",") === ["20260101T000002Z", "20260101T000003Z", "20260101T000004Z"].join(","),
      `LOOP-338 AC3: the two removed are the oldest BY EMBEDDED TIMESTAMP, despite mtimes saying otherwise (left ${left.join(",")})`);

    // Retention never touches a file that is not ours.
    writeFileSync(join(dir, "not-a-snapshot.txt"), "keep me");
    pruneSnapshots(dir, 1);
    ok(existsSync(join(dir, "not-a-snapshot.txt")), "LOOP-338: an unrelated file in the directory is never pruned");
  }

  // ── LOOP-338 AC1/AC2/AC4: the CLI verb, end to end, on a workspace carrying a real secret ─────
  {
    const ws = join(tmp, "ws");
    const env = { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") } as NodeJS.ProcessEnv;
    const run = (args: string[]) => {
      const r = spawnSync("node", [join(hubRoot, "src", "cli.ts"), ...args], { cwd: ws, env, encoding: "utf8" });
      return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
    };
    spawnSync("node", [join(hubRoot, "src", "team.ts"), "init", "--dir", ws, "--key", "snapws", "--backend", "service", "--yes"],
      { cwd: tmp, env, encoding: "utf8" });

    // A REAL secret value in the workspace, referenced by NAME from config — the shape AC4 requires.
    // Deliberately NOT shaped like a real credential. My first version used an `sk-live-…` literal and
    // GitGuardian flagged the repo — correctly: a secret scanner cannot tell a fixture from the real
    // thing, and a repo that trains people to ignore its scanner is worse off. The assertion only
    // needs a string that is unique in the artifact, not one that looks plausible.
    const SECRET = "FIXTURE-VALUE-NOT-A-CREDENTIAL-zzq1";
    mkdirSync(join(ws, ".dev-loop"), { recursive: true });
    writeFileSync(join(ws, ".dev-loop", "secrets.env"), `MY_PROVIDER_KEY=${SECRET}\n`, { mode: 0o600 });
    spawnSync("node", [join(hubRoot, "src", "team.ts"), "add-project", "alpha", "--prefix", "ALPHA"], { cwd: ws, env, encoding: "utf8" });

    const snap = run(["board", "snapshot", "--reason", "manual"]);
    const path = snap.out.trim().split("\n").pop() ?? "";
    ok(snap.code === 0 && existsSync(path), `LOOP-338 AC1: 'board snapshot' writes one artifact and prints its path (code ${snap.code}, ${path})`);
    ok(/board-\d{8}T\d{6}Z-manual\.db$/.test(path), `LOOP-338 AC1: …named per the contract (${path})`);
    if (platform() !== "win32")
      ok((statSync(path).mode & 0o777) === 0o600, `LOOP-338 AC1: …mode 0600 (got ${(statSync(path).mode & 0o777).toString(8)})`);

    // AC4 — no secret material, AND it is a real board. Both halves: "no secrets" must not be
    // satisfiable by writing an empty or broken file.
    const bytes = readFileSync(path);
    ok(!bytes.includes(Buffer.from(SECRET)), "LOOP-338 AC4: the secret VALUE appears nowhere in the artifact bytes");
    ok(!bytes.includes(Buffer.from("MY_PROVIDER_KEY")), "LOOP-338 AC4: …nor even the env NAME — the code path never reads secrets.env");
    const sdb = new DatabaseSync(path, { readOnly: true });
    const projects = (sdb.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    sdb.close();
    ok(projects >= 1, `LOOP-338 AC4: …and it opens as a SQLite board carrying the project rows (got ${projects})`);

    // ── LOOP-341 AC1/AC4: the restore verb is gated by the EXISTING token ─────────────────────
    // This is the one child in the module that writes over a live board, so it reuses
    // destructive-guard's confirmation token rather than inventing a gate — and `--force` is
    // untouched, because --force answers the recoverability question and must never become the
    // isolation token.
    {
      // Give the live board rows so it is the PROTECTED case.
      const liveDb = openDb(join(ws, ".dev-loop", "hub.db"));
      // "snapws" is the TEAM key; the project added above is "alpha". The isolation TOKEN names the
      // workspace (team) key, which is what workspaceIsolationVerdict gates on — they are different keys.
      const lpid = findProject(liveDb, "alpha")!;
      for (let i = 0; i < 3; i++)
        liveDb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'t','d','Improvement','Todo',2,'[]','[]','pm','t','t')").run(`SNAP-${i}`, lpid);
      liveDb.close();
      const src2 = run(["board", "snapshot", "--reason", "manual"]);
      const gen = src2.out.trim().split("\n").pop() ?? "";
      const beforeBytes = readFileSync(join(ws, ".dev-loop", "hub.db"));

      const ungated = run(["board", "restore", "--from", gen]);
      ok(ungated.code === 4 && /--i-understand-this-deletes-/.test(`${ungated.out}${ungated.err}`),
        `LOOP-341 AC1/AC4: restoring onto a NON-EMPTY board without the token is refused, naming it (code ${ungated.code})`);
      ok(Buffer.compare(readFileSync(join(ws, ".dev-loop", "hub.db")), beforeBytes) === 0,
        "LOOP-341 AC4: …and the existing board is BYTE-identical afterwards — not merely the same row count");

      const gated = run(["board", "restore", "--from", gen, "--i-understand-this-deletes-snapws"]);
      ok(gated.code === 0 && /restored 3 ticket/.test(gated.out),
        `LOOP-341 AC1: the existing token clears it (code ${gated.code}) ${gated.err.slice(-140)}`);
      ok(/restore that generation to undo/.test(gated.out),
        "LOOP-341 AC5: …and it tells the operator where the replaced board went");
      const bad = run(["board", "restore", "--from", join(tmp, "not-sqlite.db"), "--i-understand-this-deletes-snapws"]);
      ok(bad.code !== 0, `LOOP-341 AC3: a bad --from is refused at the CLI too (code ${bad.code})`);
      ok(run(["board", "restore"]).code === 2, "LOOP-341: --from is required");

      // ── LOOP-367: a FIRE may not restore a live board, token or no token ───────────────────
      // On 2026-08-06 the qa fire read `board restore --help`, hit the isolation gate, and supplied
      // `--i-understand-this-deletes-loop` 44 seconds later — against the LIVE workspace. The token
      // was never the question a fire needed answered. Every assertion below runs with the token
      // PRESENT, because a guard that only holds when the caller forgot the token is not a guard.
      for (const marker of ["DEVLOOP_DEV_SPLIT", "DEVLOOP_TEAM_SCOPE"]) {
        const fired = spawnSync("node", [join(hubRoot, "src", "cli.ts"), "board", "restore", "--from", gen, "--i-understand-this-deletes-snapws"],
          { cwd: ws, env: { ...env, [marker]: "1" }, encoding: "utf8" });
        const said = `${fired.stdout ?? ""}${fired.stderr ?? ""}`;
        ok(fired.status === 4, `LOOP-367: 'board restore' WITH the token is refused inside a fire (${marker} set) — code ${fired.status}`);
        ok(said.includes(marker), `LOOP-367: …and the refusal names the marker that triggered it (${marker})`);
        ok(!/^restored \d+ ticket/m.test(said), `LOOP-367: …and nothing was restored (${marker})`);
      }
      // The suppressor is the ABSENCE of a marker — an empty value must not read as "in a fire",
      // or every non-fire caller with a stale exported empty var loses the verb.
      const emptyMarker = spawnSync("node", [join(hubRoot, "src", "cli.ts"), "board", "restore", "--from", gen, "--i-understand-this-deletes-snapws"],
        { cwd: ws, env: { ...env, DEVLOOP_DEV_SPLIT: "" }, encoding: "utf8" });
      ok(emptyMarker.status === 0, `LOOP-367: an EMPTY marker is not a fire — the operator's restore still works (code ${emptyMarker.status})`);
    }

    const list = run(["board", "snapshots"]);
    ok(list.code === 0 && /newest first/.test(list.out) && /manual/.test(list.out),
      `LOOP-338 AC2: 'board snapshots' lists generations with age and size (code ${list.code})`);

    const badFlag = run(["board", "snapshot", "--reason", "bad reason with spaces"]);
    ok(badFlag.code === 2, `LOOP-338: a reason that would break the filename contract is refused (got ${badFlag.code})`);
    const badKeep = run(["board", "snapshot", "--keep", "-1"]);
    ok(badKeep.code === 2, `LOOP-338: a negative --keep is refused (got ${badKeep.code})`);
  }

  // ── LOOP-341: the RESTORE — a backup never restored from is not a backup ─────────────────────
  // Children A-D produce an artifact and warn about its absence; none of them proves it can be
  // turned back into a board. The 2026-08-04 recovery was an improvised `sqlite3 .recover` run under
  // pressure two hours after the loss, and it still lost 19 tickets and 79 comments permanently.
  {
    const boardPath = join(tmp, "restore-live.db");
    const dir = join(tmp, "restore-gens");
    const db = openDb(boardPath);
    ensureSeed(db, "rst", "Restore", "RST");
    const pidR = findProject(db, "rst")!;
    const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'d','Improvement','Todo',2,'[]','[]','pm','t','t')");
    for (let i = 0; i < 12; i++) ins.run(`RST-${i}`, pidR, `ticket ${i}`);
    const MARKER = "the one comment body that must survive verbatim - LOOP-341 AC2";
    db.prepare("INSERT INTO comments(ticket_id,author,body,created_at) VALUES(?,?,?,?)").run("RST-0", "pm", MARKER, "t");
    for (let i = 1; i < 5; i++) db.prepare("INSERT INTO comments(ticket_id,author,body,created_at) VALUES(?,?,?,?)").run(`RST-${i}`, "qa", `c${i}`, "t");
    db.prepare("INSERT INTO documents(id,project_id,kind,slug,title,created_by,created_at,updated_at) VALUES('d1',?,'design','x','X','pm','t','t')").run(pidR);
    db.close();

    const snap = takeBoardSnapshot({ dbPath: boardPath, dir, keep: 10, reason: "manual" });

    // DESTROY the board — the incident's shape.
    const wiped = openDb(boardPath);
    wiped.exec("DELETE FROM comments"); wiped.exec("DELETE FROM tickets"); wiped.exec("DELETE FROM documents");
    wiped.close();
    const after = openDb(boardPath);
    ok((after.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n === 0, "LOOP-341 fixture: the board is wiped");
    after.close();

    // AC2 — the round trip: counts AND content. Counts alone are satisfied by a restore that
    // scrambles what it puts back.
    const r = restoreBoard({ from: snap, dbPath: boardPath, dir, keep: 10 });
    const back = new DatabaseSync(boardPath, { readOnly: true });
    const t2 = (back.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
    const c2 = (back.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
    const d2 = (back.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    const body = (back.prepare("SELECT body FROM comments WHERE ticket_id='RST-0'").get() as { body: string }).body;
    back.close();
    ok(t2 === 12 && c2 === 5 && d2 === 1, `LOOP-341 AC2: tickets/comments/documents all restored (${t2}/${c2}/${d2}, want 12/5/1)`);
    ok(body === MARKER, "LOOP-341 AC2: ...and one specific comment body survives VERBATIM - counts alone prove nothing");

    // AC5 - the restore is itself undoable.
    ok(r.preRestore !== null && existsSync(r.preRestore), `LOOP-341 AC5: a pre-restore copy of the replaced board exists (${r.preRestore})`);
    ok(/-pre-restore\.db$/.test(r.preRestore ?? ""), "LOOP-341 AC5: ...reasoned pre-restore, so it is findable in the listing");

    // AC3 - verify BEFORE landing: three bad inputs, existing board untouched each time.
    const good = readFileSync(boardPath);
    const truncated = join(tmp, "truncated.db");
    writeFileSync(truncated, readFileSync(snap).subarray(0, 200));
    const notSqlite = join(tmp, "not-sqlite.db");
    writeFileSync(notSqlite, "this is plainly not a database");
    const emptyFile = join(tmp, "empty.db");
    writeFileSync(emptyFile, "");
    for (const [label, bad] of [["truncated", truncated], ["non-SQLite", notSqlite], ["zero-length", emptyFile]] as const) {
      let err = "";
      try { restoreBoard({ from: bad, dbPath: boardPath, dir, keep: 10 }); } catch (e) { err = (e as Error).message; }
      ok(err !== "" && /refusing to restore/.test(err), `LOOP-341 AC3: a ${label} --from is REFUSED (${err.slice(0, 60)})`);
      ok(Buffer.compare(readFileSync(boardPath), good) === 0, `LOOP-341 AC3: ...and the existing board is BYTE-identical after the ${label} refusal`);
    }
    ok(!verifySnapshot(join(tmp, "no-such-file.db")).ok, "LOOP-341 AC3: a missing --from is refused too");

    // The schema probe's DISCRIMINATING case. The three bad inputs above are each caught twice over
    // — the open throws, or the COUNT throws — so removing the probe leaves them all still refused
    // (mutation-checked: 0 red). What the probe uniquely buys is the MESSAGE for a file that is a
    // perfectly valid SQLite database and simply is not a board: without it the operator gets
    // "no such table: tickets" instead of a named diagnosis. Asserted here so the probe is
    // load-bearing for something rather than defence-in-depth nobody checks.
    const validNonBoard = join(tmp, "valid-but-not-a-board.db");
    { const other = new DatabaseSync(validNonBoard); other.exec("CREATE TABLE unrelated(x TEXT)"); other.close(); }
    const nb = verifySnapshot(validNonBoard);
    ok(!nb.ok && /not a hub board/.test(nb.error ?? "") && /projects/.test(nb.error ?? ""),
      `LOOP-341 AC3: a VALID SQLite db that is not a board is refused by NAME, not by a stray "no such table" (${nb.error})`);
  }

  // ── LOOP-339: the TRIGGERS — the whole point of AC1, "a snapshot nobody has to remember" ─────
  {
    const src = join(tmp, "trig.db");
    makeWalDb(src, 4);
    const dir = join(tmp, "trig-gens");

    // Trigger 1 — the cadence tick, best-effort by design: a failed periodic backup must never take
    // the daemon down. It writes a `cadence`-reasoned generation.
    const madeLog: string[] = [];
    const made = boardSnapshotTick({ dbPath: src, dir, keep: 5, log: (m) => madeLog.push(m) });
    ok(made !== null && /-cadence\.db$/.test(made), `LOOP-339: the cadence tick writes a cadence-reasoned generation (${made})`);
    // A SUCCESSFUL tick must leave a line. Failure and skip already did; success did not, and that made
    // the cadence unauditable: an operator could see that generations exist but not that the timer ran,
    // and could not tell a timer that stopped firing from one whose writes were failing. Observed live —
    // one daemon produced a generation on four consecutive cycles and none on the fifth, and the reason
    // was unrecoverable because neither outcome left a trace.
    ok(madeLog.some((l) => /board snapshot written:/.test(l) && l.includes(made ?? "\u0000")),
      `LOOP-339: a successful tick logs the generation it wrote (${madeLog.join(" | ") || "<silent>"})`);
    const logged: string[] = [];
    const failed = boardSnapshotTick({ dbPath: join(tmp, "gone.db"), dir, keep: 5, log: (m) => logged.push(m) });
    ok(failed === null && logged.some((l) => /board snapshot FAILED/.test(l)),
      "LOOP-339: a failing cadence tick returns null and LOGS — best-effort, but never silent");

    // Two daemons can share one hub.db — a workspace with a `_team` daemon and a project daemon has two,
    // both holding <workspace>/.dev-loop/hub.db and both running this timer. Measured on the live
    // workspace: they ticked a second apart and wrote BYTE-IDENTICAL generations (two pairs, same
    // SHA-256). The wasted disk is bounded by `keep`; the retention WINDOW is not — every generation
    // duplicated means `keep: 10` holds five distinct points in time, and the older generations are the
    // whole reason the cadence exists. A second writer inside the same interval is refused.
    {
      // The guard compares against the timestamp EMBEDDED in the newest generation's filename, which is
      // stamped from the real clock — so the test drives the real clock too, with a short interval,
      // rather than threading a fake one through the writer just to observe it.
      const dupDir = join(tmp, "dup-gens");
      const INTERVAL = 2_000; // interval/2 = 1s, long enough that two back-to-back ticks fall inside it
      const first = boardSnapshotTick({ dbPath: src, dir: dupDir, keep: 10, intervalMs: INTERVAL });
      ok(first !== null, `two-daemon: the first daemon's tick writes a generation (${first})`);
      const dupLog: string[] = [];
      const second = boardSnapshotTick({ dbPath: src, dir: dupDir, keep: 10, intervalMs: INTERVAL, log: (m) => dupLog.push(m) });
      ok(second === null, `two-daemon: a second daemon ticking inside the same interval is refused (${second})`);
      ok(dupLog.some((l) => /already covers this interval/.test(l)),
        `two-daemon: …and says why, naming the generation that covers it (${dupLog.join(" | ") || "<silent>"})`);
      ok(listSnapshots(dupDir).filter((g) => g.reason === "cadence").length === 1,
        `two-daemon: exactly ONE generation exists for that interval (${listSnapshots(dupDir).filter((g) => g.reason === "cadence").length})`);
      // The NEXT interval must still be taken — the guard bounds duplicates, it does not stop the cadence.
      spawnSync("sleep", ["2"]);
      const next = boardSnapshotTick({ dbPath: src, dir: dupDir, keep: 10, intervalMs: INTERVAL });
      const gens = listSnapshots(dupDir).filter((g) => g.reason === "cadence").length;
      ok(next !== null && gens === 2, `two-daemon: the next interval is still taken — the cadence is not stopped (${next}, ${gens} generations)`);
      // A tick with no interval declared keeps the old unconditional behaviour (the manual verb path).
      const unguarded = boardSnapshotTick({ dbPath: src, dir: dupDir, keep: 10 });
      ok(unguarded !== null, "two-daemon: a tick with no interval declared is unguarded, as before");
    }

    // everyHours: 0 ⇒ not started at all, the same posture every other daemon notifier has.
    ok(startBoardSnapshot({ dbPath: src, dir, keep: 5, intervalMs: 0 }) === null,
      "LOOP-339: intervalMs 0 (everyHours 0) does not start a timer at all");
    const timer = startBoardSnapshot({ dbPath: src, dir, keep: 5, intervalMs: 60_000 });
    ok(timer !== null, "LOOP-339: a positive interval starts one");
    if (timer) clearInterval(timer);

    // Trigger 2 — the pre-destructive-verb copy is FAIL-CLOSED, which is the opposite posture from
    // trigger 1 and deliberately so: its entire purpose is to exist before an irreversible write.
    const pre = snapshotBeforeDestructive({ dbPath: src, dir, keep: 5, verb: "remove-project" });
    ok(pre !== null && /-pre-remove-project\.db$/.test(pre), `LOOP-339: the pre-verb copy is reasoned pre-<verb> (${pre})`);
    // Fail-closed means "if there IS a board and we cannot copy it, refuse" — NOT "refuse when there
    // is nothing to copy". An ABSENT or UNREADABLE db returns null so the verb stays usable:
    // `remove-project --force` exists to clean up config when the db is already broken (LOOP-280
    // AC4), and wedging that would turn a recovery tool into a dead end. My first version threw
    // here and broke exactly that test.
    ok(snapshotBeforeDestructive({ dbPath: join(tmp, "gone.db"), dir, keep: 5, verb: "remove-project" }) === null,
      "LOOP-339: an ABSENT board returns null — there is nothing to protect, so the verb stays usable");
    const corrupt = join(tmp, "corrupt.db");
    writeFileSync(corrupt, "this is not a sqlite database");
    ok(snapshotBeforeDestructive({ dbPath: corrupt, dir, keep: 5, verb: "remove-project" }) === null,
      "LOOP-339: an UNREADABLE board likewise — that is the state --force exists for");
    // But a REAL board that cannot be written to its destination still refuses (the fail-closed half).
    //
    // The unwritable destination is a path UNDER A REGULAR FILE, which mkdir(2) rejects with ENOTDIR
    // on every POSIX platform. It was `/proc/<nonexistent>` first, and that HUNG the whole CI job:
    // procfs answers a nonexistent entry with ENOENT, and Node's recursive mkdirSync treats ENOENT as
    // "create the parent and retry" — the parent /proc already exists, so it retried forever inside a
    // synchronous call. Passing on macOS (where /proc does not exist at all, so the first mkdir fails
    // outright) is what hid it. ENOTDIR is in Node's terminal-error set, so it can never recurse.
    const notADir = join(tmp, "a-regular-file");
    writeFileSync(notADir, "x");
    let hardFail = "";
    try { snapshotBeforeDestructive({ dbPath: src, dir: join(notADir, "snapshots"), keep: 5, verb: "remove-project" }); }
    catch (e) { hardFail = (e as Error).message; }
    ok(hardFail !== "", "LOOP-339: a READABLE board that cannot be copied DOES throw — the fail-closed half is intact");

    // The two-phase commit refuses the destructive write when the snapshot fails, and changes NOTHING.
    const cfgPath = join(tmp, "twophase.json");
    writeFileSync(cfgPath, '{"before":true}');
    let commitErr = "";
    try {
      commitBothHalves({
        configPath: cfgPath, configText: '{"after":true}', db: undefined, dbWork: null,
        preSnapshot: () => { throw new Error("disk full"); },
      });
    } catch (e) { commitErr = (e as Error).message; }
    ok(/refusing the destructive write/.test(commitErr) && /disk full/.test(commitErr),
      `LOOP-339: commitBothHalves REFUSES when the pre-snapshot fails, naming the cause (${commitErr.slice(0, 70)})`);
    ok(readFileSync(cfgPath, "utf8") === '{"before":true}',
      "LOOP-339: …and nothing was written — the refusal happens BEFORE anything is begun");

    // Trigger 3 — config. everyHours 0 disables; the defaults are 6h / keep 10.
    const off = resolveBackupConfig({ backup: { everyHours: 0 } }, join(tmp, "sr"));
    ok(off.intervalMs === 0, "LOOP-339: team.backup.everyHours 0 resolves to a disabled cadence");
    const dflt = resolveBackupConfig(undefined, join(tmp, "sr"));
    ok(dflt.intervalMs === 6 * 3_600_000 && dflt.keep === 10 && dflt.dir.endsWith("snapshots"),
      `LOOP-339: the shipped defaults are 6h / keep 10 / <state>/snapshots (got ${dflt.intervalMs}, ${dflt.keep})`);
    const tuned = resolveBackupConfig({ backup: { everyHours: 2, keep: 3, dir: "/custom" } }, join(tmp, "sr"));
    ok(tuned.intervalMs === 2 * 3_600_000 && tuned.keep === 3 && tuned.dir === "/custom",
      "LOOP-339: config overrides every field");
  }

  // snapshotName is the one place the filename contract lives.
  ok(snapshotName(new Date(Date.UTC(2026, 7, 5, 16, 2, 20)), "cadence") === "board-20260805T160220Z-cadence.db",
    "LOOP-338: the filename contract is a single function, so listing and retention cannot disagree with writing");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nBOARD_SNAPSHOT_OK");
process.exit(fails ? 1 : 0);
