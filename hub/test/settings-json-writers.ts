// settings_json's OTHER whole-row writers (LOOP-506) — the two LOOP-479 did not reach.
//
// LOOP-479 wrapped `settings set`'s read-modify-write in BEGIN IMMEDIATE. That serializes nothing on
// its own: `syncScratchProjectRow` and bundle's transport pass still read outside any transaction, and
// under WAL their SELECT is permitted WHILE `settings set` holds its reservation. Their UPDATE then
// waits for that commit and lands the copy read before it, erasing the key the sibling just wrote.
//
// So the race arm below spawns TWO processes and makes one HOLD the reservation across the other's
// read. A test that called the helpers in sequence would pass against the unfixed tree — the lost
// update only exists when the two overlap — which is why AC3 names the interleaving explicitly.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { seedOpApiGate } from "../src/bundle.ts";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(tmpRoot("dl-sjw-"));
// scrubFireEnv, not an ambient spread: inside a fire DEVLOOP_WORKSPACE/DEVLOOP_HUB_DB point at the
// PRODUCTION workspace and every mutator spawned here would write to it (team-edit.ts:22 records the
// 2026-08-04 incident). DEVLOOP_HUB_DB is emptied on top so nothing re-resolves to the live board.
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), DEVLOOP_HUB_DB: "", ...extra });
const run = (entry: string, args: string[], opts: { cwd?: string } = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", `${entry}.ts`), ...args], { cwd: opts.cwd ?? hubRoot, env: env(), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const rawSettings = (dbPath: string, key: string): string | null => {
  const db = openDb(dbPath);
  try { return (db.prepare("SELECT settings_json FROM projects WHERE key=?").get(key) as { settings_json: string | null } | undefined)?.settings_json ?? null; }
  finally { db.close(); }
};

// ── AC3 — the lost update: two processes, one holding the write reservation ───────────────────────
//
// Sequencing is handshake-driven, not sleep-driven, so a slow CI box cannot turn "the writer ran
// while the lock was held" into a pass by accident: the holder does not commit until the racer has
// signalled that it is about to call the writer.
{
  const dbPath = join(tmp, "race", "hub.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  {
    const db = openDb(dbPath);
    db.prepare("INSERT INTO projects (id,key,name,ticket_prefix,settings_json,created_at) VALUES (?,?,?,?,?,?)")
      .run("race-id", "race", "Race", "RACE", JSON.stringify({ humanWrite: { enabled: true } }), new Date().toISOString());
    db.close();
  }

  const holding = join(tmp, "race", "holding");
  const racerStarted = join(tmp, "race", "racer-started");
  // The holder stands in for a concurrent `settings set`: it takes the reservation, reads, waits for
  // the racer to be underway, then commits a sibling key. LOOP-479's verb has exactly this shape.
  const holderSrc = join(tmp, "race", "holder.mjs");
  writeFileSync(holderSrc, `
import { openDb } from ${JSON.stringify(join(hubRoot, "src", "db.ts"))};
import { writeFileSync, existsSync } from "node:fs";
const db = openDb(${JSON.stringify(dbPath)});
db.exec("BEGIN IMMEDIATE");
const row = db.prepare("SELECT settings_json FROM projects WHERE key=?").get("race");
const s = JSON.parse(row.settings_json);
writeFileSync(${JSON.stringify(holding)}, "1");
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const deadline = Date.now() + 10000;
while (!existsSync(${JSON.stringify(racerStarted)}) && Date.now() < deadline) nap(10);
// The racer has signalled; hold a moment longer so its SELECT (unfixed tree) or its BEGIN IMMEDIATE
// (fixed tree) definitely lands inside the reservation, then commit the sibling key.
nap(400);
s.sentinel = "from-holder";
db.prepare("UPDATE projects SET settings_json=? WHERE key=?").run(JSON.stringify(s), "race");
db.exec("COMMIT");
db.close();
`);
  const racerSrc = join(tmp, "race", "racer.mjs");
  writeFileSync(racerSrc, `
import { openDb } from ${JSON.stringify(join(hubRoot, "src", "db.ts"))};
import { syncScratchProjectRow } from ${JSON.stringify(join(hubRoot, "src", "team-edit.ts"))};
import { writeFileSync } from "node:fs";
const db = openDb(${JSON.stringify(dbPath)});
writeFileSync(${JSON.stringify(racerStarted)}, "1");
syncScratchProjectRow(db, "race", true);
db.close();
`);

  const holder = spawn("node", [holderSrc], { env: env(), stdio: "inherit" });
  const waitHolding = Date.now() + 10000;
  while (!existsSync(holding) && Date.now() < waitHolding) await new Promise((r) => setTimeout(r, 10));
  ok(existsSync(holding), "AC3 fixture: the holder acquired the write reservation before the racer started");

  const racer = spawn("node", [racerSrc], { env: env(), stdio: "inherit" });
  const codes = await Promise.all([
    new Promise<number>((res) => holder.on("close", (c) => res(c ?? 1))),
    new Promise<number>((res) => racer.on("close", (c) => res(c ?? 1))),
  ]);
  ok(codes[0] === 0 && codes[1] === 0, `AC3 fixture: both processes exited 0 (holder ${codes[0]}, racer ${codes[1]})`);

  const after = JSON.parse(rawSettings(dbPath, "race") ?? "{}") as Record<string, unknown>;
  ok(after.sentinel === "from-holder",
    "AC3: the concurrent writer's key SURVIVES the scratch projection — this is the lost update, and it is red on the unfixed tree");
  ok(after.scratch === true, "AC3: the scratch projection still landed its own key");
  ok(JSON.stringify(after.humanWrite) === JSON.stringify({ enabled: true }),
    "AC3: the pre-existing sibling key is untouched by either writer");
}

// ── AC4 — a malformed row is REFUSED by the real `team set projects.<key>.scratch` path ───────────
{
  const ws = join(tmp, "ws");
  const initR = run("team", ["init", "--dir", ws, "--key", "sjw-team", "--backend", "service"]);
  ok(initR.code === 0, `AC4 fixture: team init --backend service exits 0 (${initR.code})`);
  const addR = run("team", ["add-project", "fixture"], { cwd: ws });
  ok(addR.code === 0, `AC4 fixture: add-project exits 0 (${addR.code})`);

  const dbPath = join(ws, ".dev-loop", "hub.db");
  // Not a synthetic string: this is the shape the operator loses — a row carrying hand-written keys
  // that got truncated. Every one of them must still be there afterwards.
  const MALFORMED = '{"humanWrite":{"enabled":true},"workflow":{"transitions":';
  {
    const db = openDb(dbPath);
    db.prepare("UPDATE projects SET settings_json=? WHERE key=?").run(MALFORMED, "fixture");
    db.close();
  }
  ok(rawSettings(dbPath, "fixture") === MALFORMED, "AC4 fixture: the malformed row is in place");

  const setR = run("team", ["set", "projects.fixture.scratch", "true"], { cwd: ws });
  ok(rawSettings(dbPath, "fixture") === MALFORMED,
    "AC4: the row is BYTE-IDENTICAL after `team set projects.fixture.scratch true` — the fail-open `catch { settings = {} }` would have replaced it with {\"scratch\":true}");
  ok(/malformed settings_json/.test(setR.out),
    "AC4: the refusal is REPORTED, not swallowed — the operator learns the projection was skipped and why");
  ok(setR.code === 0,
    `AC4: \`team set\` still succeeds — the config write already landed, so a best-effort projection must not fail the verb (${setR.code})`);
  ok(JSON.parse(readFileSync(join(ws, "dev-loop.json"), "utf8")).projects.fixture?.scratch === true,
    "AC4: the config half of the set still landed");
}

// ── AC1/AC2 — bundle's transport pass merges in SQL and refuses what it cannot read ───────────────
{
  const dbPath = join(tmp, "bundle", "hub.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const MALFORMED = '{"humanWrite":{"enabled":true},"trunc';
  {
    const db = openDb(dbPath);
    const now = new Date().toISOString();
    const ins = db.prepare("INSERT INTO projects (id,key,name,ticket_prefix,settings_json,created_at) VALUES (?,?,?,?,?,?)");
    ins.run("i1", "sib", "Sib", "SIB", JSON.stringify({ humanWrite: { enabled: true } }), now);
    ins.run("i2", "already", "Already", "ALR", JSON.stringify({ hub: { transport: "daemon" } }), now);
    ins.run("i3", "partial", "Partial", "PRT", JSON.stringify({ hub: { note: "keep" } }), now);
    ins.run("i4", "bad", "Bad", "BAD", MALFORMED, now);
    // Codex review, PR #321: valid JSON that json_set CANNOT traverse. Each returns the row unchanged
    // while SQLite still counts it in `changes` — so a json_valid-only predicate reports the gate live
    // over rows whose hub.transport was never set.
    ins.run("i5", "arrayroot", "ArrayRoot", "ARR", "[1,2]", now);
    ins.run("i6", "scalarroot", "ScalarRoot", "SCL", '"hello"', now);
    ins.run("i7", "hubarray", "HubArray", "HBA", '{"keep":1,"hub":[]}', now);
    ins.run("i8", "hubscalar", "HubScalar", "HBS", '{"keep":1,"hub":5}', now);
    // ...and the one untraversable shape that is NOT a refusal: JSON null is absence, and the JS loop
    // this replaced read it as absent, so refusing it would regress a row that used to seed.
    ins.run("i9", "hubnull", "HubNull", "HBN", '{"keep":1,"hub":null}', now);
    db.close();
  }
  // The SHIPPED statement, called directly — not a copy of the SQL pasted into the test. A test that
  // re-declares the query it is checking passes forever, however the real one changes.
  const db = openDb(dbPath);
  const { changed, refused: bad } = seedOpApiGate(db);
  db.close();

  ok(bad.includes("bad") && [...bad].sort().join(",") === "arrayroot,bad,hubarray,hubscalar,scalarroot",
    `AC2: every row this pass cannot safely merge is NAMED for the operator, not parsed into {} (${JSON.stringify([...bad].sort())})`);
  ok(rawSettings(dbPath, "bad") === MALFORMED,
    "AC2: bundle leaves the unreadable row BYTE-IDENTICAL — the old `catch { s = {} }` rewrote it as {\"hub\":{\"transport\":\"daemon\"}}, costing every other key in it");
  const sib = JSON.parse(rawSettings(dbPath, "sib") ?? "{}") as Record<string, unknown>;
  ok(JSON.stringify(sib.humanWrite) === JSON.stringify({ enabled: true }) && JSON.stringify(sib.hub) === JSON.stringify({ transport: "daemon" }),
    "AC1: json_set merges in SQL — the sibling key survives and $.hub is created when absent");
  const partial = JSON.parse(rawSettings(dbPath, "partial") ?? "{}") as { hub?: Record<string, unknown> };
  ok(partial.hub?.note === "keep" && partial.hub?.transport === "daemon",
    "AC1: an existing $.hub object is merged into, not replaced");
  ok(changed === 3, `AC1: a row already on transport=daemon is not rewritten (changes=${changed}, expected 3: sib, partial, hubnull)`);

  // ── the false-success class (Codex review, PR #321) ─────────────────────────────────────────────
  // The assertion that matters is that transport is SET, not that a row was counted: json_set returns
  // an untraversable row unchanged AND SQLite counts it as changed, so counting alone reports success.
  for (const k of ["arrayroot", "scalarroot", "hubarray", "hubscalar"]) {
    ok(bad.includes(k), `AC2: '${k}' is valid JSON that json_set cannot traverse — REFUSED and named, never counted as seeded`);
  }
  ok(rawSettings(dbPath, "arrayroot") === "[1,2]" && rawSettings(dbPath, "scalarroot") === '"hello"',
    "AC2: a non-object root is left byte-identical — parseSettingsJson refuses the same shape, so the two writers keep ONE policy");
  ok(JSON.parse(rawSettings(dbPath, "hubarray") ?? "{}").keep === 1 && JSON.parse(rawSettings(dbPath, "hubscalar") ?? "{}").keep === 1,
    "AC2: a row whose $.hub is a scalar/array keeps its other keys — refused, not flattened");
  const hubNull = JSON.parse(rawSettings(dbPath, "hubnull") ?? "{}") as { keep?: number; hub?: Record<string, unknown> };
  ok(hubNull.hub?.transport === "daemon" && hubNull.keep === 1,
    "AC1: $.hub null is ABSENCE, not a refusal — normalized away and seeded, matching the JS loop's `s.hub ?? {}`");
  for (const [k, r] of Object.entries({ sib: "sib", partial: "partial", hubnull: "hubnull" })) {
    const t = (JSON.parse(rawSettings(dbPath, r) ?? "{}") as { hub?: { transport?: string } }).hub?.transport;
    ok(t === "daemon", `AC1: every row counted in changes actually carries hub.transport=daemon ('${k}' → ${JSON.stringify(t)})`);
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
