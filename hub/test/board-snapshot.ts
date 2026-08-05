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
import { snapshotBoardDb, takeBoardSnapshot, listSnapshots, pruneSnapshots, snapshotName } from "../src/board-snapshot.ts";
import { scrubFireEnv } from "./env-scrub.ts";

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

    const list = run(["board", "snapshots"]);
    ok(list.code === 0 && /newest first/.test(list.out) && /manual/.test(list.out),
      `LOOP-338 AC2: 'board snapshots' lists generations with age and size (code ${list.code})`);

    const badFlag = run(["board", "snapshot", "--reason", "bad reason with spaces"]);
    ok(badFlag.code === 2, `LOOP-338: a reason that would break the filename contract is refused (got ${badFlag.code})`);
    const badKeep = run(["board", "snapshot", "--keep", "-1"]);
    ok(badKeep.code === 2, `LOOP-338: a negative --keep is refused (got ${badKeep.code})`);
  }

  // snapshotName is the one place the filename contract lives.
  ok(snapshotName(new Date(Date.UTC(2026, 7, 5, 16, 2, 20)), "cadence") === "board-20260805T160220Z-cadence.db",
    "LOOP-338: the filename contract is a single function, so listing and retention cannot disagree with writing");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nBOARD_SNAPSHOT_OK");
process.exit(fails ? 1 : 0);
