// destructive-commit — `commitBothHalves` (LOOP-306, LOOP-302 ②): the config half and the hub.db half
// commit together or roll back together, and no line claims a write that did not happen.
//
// These are UNIT arms against the contract itself, with a minimal table rather than the hub schema —
// commitBothHalves is schema-agnostic, so a two-column fixture is the honest unit and keeps the
// fault-injection deterministic. The CLI-level arms (a mid-cascade abort inside `remove-project`, and an
// unwritable workspace directory) live in team-edit.ts, where the real ten-statement cascade runs.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitBothHalves } from "../src/destructive-guard.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-destructive-commit-")));

// One fixture per arm: its own directory, its own config file, its own db — so a chmod or a rollback in
// one arm cannot reach another.
let n = 0;
function fixture(): { dir: string; configPath: string; db: DatabaseSync; rows: () => number } {
  const dir = join(tmp, `f${n++}`);
  mkdirSync(dir);   // throws if it exists — a collision must be loud, never a silently shared fixture
  const configPath = join(dir, "dev-loop.json");
  writeFileSync(configPath, JSON.stringify({ projects: { keep: {}, doomed: {} } }, null, 2) + "\n");
  const db = new DatabaseSync(join(dir, "t.db"));
  db.exec("CREATE TABLE t(k TEXT)");
  for (const k of ["keep", "doomed", "doomed"]) db.prepare("INSERT INTO t(k) VALUES(?)").run(k);
  return { dir, configPath, db, rows: () => (db.prepare("SELECT count(*) c FROM t").get() as { c: number }).c };
}
const NEW_CONFIG = JSON.stringify({ projects: { keep: {} } }, null, 2) + "\n";
const tmpResidue = (dir: string) => readdirSync(dir).filter((f) => f.includes(".tmp-"));

// ── happy path: both halves durable ───────────────────────────────────────────────────────────
{
  const f = fixture();
  const before = readFileSync(f.configPath, "utf8");
  commitBothHalves({
    configPath: f.configPath,
    configText: NEW_CONFIG,
    db: f.db,
    dbWork: () => { f.db.prepare("DELETE FROM t WHERE k=?").run("doomed"); },
  });
  ok(readFileSync(f.configPath, "utf8") === NEW_CONFIG, "happy: config half applied");
  ok(f.rows() === 1, `happy: db half applied and COMMITted (1 row left, got ${f.rows()})`);
  ok(before !== NEW_CONFIG, "happy: the fixture actually changed something (guards a vacuous pass)");
  ok(tmpResidue(f.dir).length === 0, "happy: no .tmp- residue left in the config directory");
  f.db.close();
}

// ── AC2: the config write is atomic — it becomes visible WHOLE, never partially ────────────────
// Observed from inside dbWork, which by construction runs AFTER the config write and BEFORE the COMMIT:
// at that instant the on-disk file must already parse as the complete new document. A plain
// `writeFileSync` to the live path has a window where a reader sees a truncated file; tmp+rename does not.
{
  const f = fixture();
  let seen = "";
  let parsedWhole = false;
  commitBothHalves({
    configPath: f.configPath,
    configText: NEW_CONFIG,
    db: f.db,
    dbWork: () => {
      seen = readFileSync(f.configPath, "utf8");
      try { parsedWhole = Object.keys((JSON.parse(seen) as { projects: object }).projects).join() === "keep"; }
      catch { parsedWhole = false; }
    },
  });
  ok(seen === NEW_CONFIG, "AC2: mid-commit the config file is byte-complete on disk (rename, not a partial write)");
  ok(parsedWhole, "AC2: mid-commit the config file parses as the finished document");
  f.db.close();
}

// ── AC4: db work fails ⇒ config restored to its original bytes, db rolled back, ORIGINAL error ──
{
  const f = fixture();
  const before = readFileSync(f.configPath, "utf8");
  const rowsBefore = f.rows();
  let threw: Error | null = null;
  try {
    commitBothHalves({
      configPath: f.configPath,
      configText: NEW_CONFIG,
      db: f.db,
      // Delete FIRST, then throw: the rollback has to undo real statements, not an empty transaction.
      dbWork: () => { f.db.prepare("DELETE FROM t WHERE k=?").run("doomed"); throw new Error("injected db failure"); },
    });
  } catch (e) { threw = e as Error; }
  ok(threw !== null, "AC4: a db-half failure throws (the caller cannot mistake it for success)");
  ok(/injected db failure/.test(threw?.message ?? ""), `AC4: the ORIGINAL error propagates, not a rollback error (got: ${threw?.message})`);
  ok(readFileSync(f.configPath, "utf8") === before, "AC4: the config half is restored to its original bytes");
  ok(f.rows() === rowsBefore, `AC4: the db half rolled back (${rowsBefore} rows before, ${f.rows()} after)`);
  ok(tmpResidue(f.dir).length === 0, "AC4: no .tmp- residue left by the failed commit or the restore");
  f.db.close();
}

// ── AC4, byte-exactness: the restore replays the retained BYTES, not a decoded string ──────────
// The arm above compares an ASCII fixture, so it passes whether the retained Buffer is written back
// directly or decoded to a string first. This one discriminates: the retained file carries a lone 0x80
// continuation byte, which is not valid UTF-8. A `Buffer.toString()` round-trip on the compensating path
// substitutes U+FFFD for it and the restore silently rewrites the file it was rescuing — so the assertion
// is on the raw bytes, and the fixture is chosen so that a decode is the only way to fail it.
{
  const f = fixture();
  const rawPrior = Buffer.concat([Buffer.from('{"projects":{"keep":{}},"note":"'), Buffer.from([0x80]), Buffer.from('"}\n')]);
  writeFileSync(f.configPath, rawPrior);
  ok(Buffer.from(rawPrior.toString(), "utf8").compare(rawPrior) !== 0,
    "AC4 bytes: the fixture really is undecodable — a string round-trip changes it (guards a vacuous pass)");
  const rowsBefore = f.rows();
  let threw: Error | null = null;
  try {
    commitBothHalves({
      configPath: f.configPath,
      configText: NEW_CONFIG,
      db: f.db,
      dbWork: () => { f.db.prepare("DELETE FROM t WHERE k=?").run("doomed"); throw new Error("injected db failure"); },
    });
  } catch (e) { threw = e as Error; }
  ok(threw !== null, "AC4 bytes: the failure still throws");
  ok(readFileSync(f.configPath).compare(rawPrior) === 0,
    "AC4 bytes: the config is restored byte-for-byte, with no lossy UTF-8 substitution");
  ok(f.rows() === rowsBefore, `AC4 bytes: the db half still rolled back (${rowsBefore} rows before, ${f.rows()} after)`);
  f.db.close();
}

// ── AC5: the compensating restore ITSELF fails ⇒ one error naming BOTH halves' actual states ────
// The directory is made read-only from inside dbWork — after the config write has landed, before the
// throw — so the restore's tmp+rename cannot proceed. This is the one arm where the two halves really do
// end up disagreeing, and the whole point is that the message says so instead of reporting one half's
// outcome as if it were both.
{
  const f = fixture();
  let threw: Error | null = null;
  try {
    commitBothHalves({
      configPath: f.configPath,
      configText: NEW_CONFIG,
      db: f.db,
      dbWork: () => { chmodSync(f.dir, 0o555); throw new Error("injected db failure"); },
    });
  } catch (e) { threw = e as Error; }
  finally { chmodSync(f.dir, 0o755); }
  const m = threw?.message ?? "";
  ok(threw !== null, "AC5: a failed restore still throws — never a silent success");
  ok(/manual recovery is required/.test(m), "AC5: the error says manual recovery is required");
  ok(/config/.test(m) && /WRITTEN/.test(m), "AC5: the message names the CONFIG half's actual state (written)");
  ok(/hub\.db/.test(m) && /rolled back/.test(m), "AC5: the message names the DB half's actual state (rolled back)");
  ok(/injected db failure/.test(m), "AC5: the original failure is still reported inside the combined error");
  ok(f.rows() === 3, `AC5: the db half is still rolled back even though the restore failed (got ${f.rows()} rows)`);
  f.db.close();
}

// ── half-present shapes: one store only ────────────────────────────────────────────────────────
{
  const f = fixture();   // config half only (no db) — the linear/local shape
  commitBothHalves({ configPath: f.configPath, configText: NEW_CONFIG, db: undefined, dbWork: null });
  ok(readFileSync(f.configPath, "utf8") === NEW_CONFIG, "config-only: the config half applies with no db present");
  f.db.close();
}
{
  const f = fixture();   // db half only (configText null) — the db-only key shape
  const before = readFileSync(f.configPath, "utf8");
  commitBothHalves({
    configPath: f.configPath, configText: null, db: f.db,
    dbWork: () => { f.db.prepare("DELETE FROM t WHERE k=?").run("doomed"); },
  });
  ok(readFileSync(f.configPath, "utf8") === before, "db-only: the config file is not touched when configText is null");
  ok(f.rows() === 1, `db-only: the db half committed (got ${f.rows()} rows)`);
  f.db.close();
}
{
  const f = fixture();   // db half only, and it fails — nothing to compensate, error still propagates
  let threw: Error | null = null;
  const before = readFileSync(f.configPath, "utf8");
  try {
    commitBothHalves({
      configPath: f.configPath, configText: null, db: f.db,
      dbWork: () => { f.db.prepare("DELETE FROM t WHERE k=?").run("doomed"); throw new Error("injected db failure"); },
    });
  } catch (e) { threw = e as Error; }
  ok(/injected db failure/.test(threw?.message ?? ""), "db-only failure: the original error propagates unwrapped");
  ok(!/manual recovery/.test(threw?.message ?? ""), "db-only failure: no combined-failure message when there was no config half to restore");
  ok(f.rows() === 3, `db-only failure: rolled back (got ${f.rows()} rows)`);
  ok(readFileSync(f.configPath, "utf8") === before, "db-only failure: the config file is still untouched");
  f.db.close();
}

// ── AC7: the module states what it does NOT deliver ────────────────────────────────────────────
// An honest limit is only honest if it is written down where the next reader will meet it. This asserts
// the module comment, not the behaviour, and that is deliberate: the SIGKILL window it describes is
// outside a single process's reach, so the comment is the only artifact that can carry it.
{
  const src = readFileSync(join(hubRoot, "src", "destructive-guard.ts"), "utf8");
  ok(/not a distributed transaction/.test(src), "AC7: the module says it is not a distributed transaction");
  ok(/SIGKILL/.test(src), "AC7: the module names the SIGKILL window it cannot close");
  ok(/do not "improve" it/i.test(src), "AC7: the config-first ordering is recorded as a decision, not left to be 'tidied'");
}

rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? "\nDESTRUCTIVE_COMMIT_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
