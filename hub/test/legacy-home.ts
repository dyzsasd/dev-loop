// LOOP-473 — E20: the home-anchored `~/.dev-loop` detector, and the E namespace it takes a code from.
//
// Every arm runs against a FIXTURE root under mkdtemp. Nothing here reads the developer's real home
// directory: a check whose firing arm can only be exercised on one machine is a check whose passing
// arm nobody can write, and this one gates a removal that orphans data when it is wrong.
//
// The last block is the collision guard. E00-E19 belong to team-config.ts's validator and are keyed
// by config path, so there is no name list to compare against — the assertion DERIVES the claimed
// set by scanning hub/src, which is why it stays true as that validator grows.

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { legacyHomeState, describeLegacyHome, checkLegacyHome } from "../src/legacy-home.ts";
import { DOCTOR_CODES } from "../src/doctor-codes.ts";
import { openDb } from "../src/db.ts";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const roots: string[] = [];
function fixture(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "legacy-home-"));
  roots.push(root);
  build(root);
  return root;
}
/** Collect what checkLegacyHome would report, so both arms are observable. */
function emitted(root: string): string[] {
  const out: string[] = [];
  checkLegacyHome(root, (m) => out.push(m));
  return out;
}

/**
 * A REAL hub.db carrying the real schema, with the given row counts.
 *
 * The row counts are the evidence E20 rests on: "hub.db exists" is a filename, and a scaffold
 * created by a hub that was started once and never used carries the same filename as a board with
 * 52 tickets on it. Every hub.db arm below builds the file through openDb so the probe is exercised
 * against the schema the product actually writes.
 */
function makeHubDb(file: string, rows: { projects?: number; tickets?: number; events?: number }): void {
  const at = "2026-01-01T00:00:00.000Z";
  const db = openDb(file);
  try {
    for (let i = 0; i < (rows.projects ?? 0); i++) {
      db.prepare("INSERT INTO projects(id, key, name, ticket_prefix, created_at) VALUES(?,?,?,?,?)")
        .run(`p${i}`, `proj-${i}`, `Project ${i}`, `P${i}`, at);
    }
    for (let i = 0; i < (rows.tickets ?? 0); i++) {
      db.prepare("INSERT INTO tickets(id, project_id, title, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?)")
        .run(`P0-${i + 1}`, "p0", `ticket ${i}`, "operator", at, at);
    }
    for (let i = 0; i < (rows.events ?? 0); i++) {
      db.prepare("INSERT INTO events(project_id, actor, kind, created_at) VALUES(?,?,?,?)")
        .run("p0", "operator", "issue.create", at);
    }
  } finally { db.close(); }
}

// ── The NOT-a-hazard arms ────────────────────────────────────────────────────────────────────────

ok(legacyHomeState(join(tmpdir(), "legacy-home-does-not-exist-" + process.pid)) === null,
  "AC3: an absent root is not a finding");

ok(legacyHomeState(fixture(() => {})) === null,
  "AC3: an EMPTY legacy root is not a finding — nothing to orphan");

// The arm that separates state from scratch. On the machine this was written against the legacy root
// held `loop/wt/` full of worktrees; counting those would fire E20 at every operator whose fires ever
// hand-built the §7 path, for directories `git worktree list` already enumerates from any root.
const wtOnly = fixture((r) => {
  mkdirSync(join(r, "loop", "wt", "LOOP-1"), { recursive: true });
  mkdirSync(join(r, "loop", "wt", "LOOP-2"), { recursive: true });
});
ok(legacyHomeState(wtOnly) === null,
  "AC3: a root holding ONLY worktrees is not a finding — worktrees are reconstructible and reaped via git worktree list");
ok(emitted(wtOnly).length === 0, "AC3: the worktrees-only root emits nothing");

// A hidden directory is not a project dir.
ok(legacyHomeState(fixture((r) => { mkdirSync(join(r, ".cache", "reports"), { recursive: true }); })) === null,
  "AC3: a dot-directory is not counted as project state");

// D1 — an EMPTY hub.db. `dev-loop up` / a hub started once and never used leaves a fully-schema'd
// hub.db holding projects=0, tickets=0, events=0. Deciding the hazard from `entries.includes("hub.db")`
// reports that scaffold as "a whole board" and prescribes `dev-loop team import` for a board with
// nothing in it — the same false-positive the worktrees-only arm above exists to prevent.
const emptyDb = fixture((r) => { makeHubDb(join(r, "hub.db"), {}); });
ok(legacyHomeState(emptyDb) === null,
  "D1: a hub.db holding 0 projects / 0 tickets / 0 events is not a finding — an empty scaffold has nothing to orphan");
ok(emitted(emptyDb).length === 0, "D1: the empty-board root emits no E20");

// The counts are read, not the filename: one row in ANY of the three carriers is a board.
for (const [label, rows] of [
  ["one project", { projects: 1 }],
  ["one ticket", { projects: 1, tickets: 1 }],
  ["one event", { events: 1 }],
] as Array<[string, { projects?: number; tickets?: number; events?: number }]>) {
  const root = fixture((r) => { makeHubDb(join(r, "hub.db"), rows); });
  ok(emitted(root).length === 1, `D1: a hub.db holding ${label} fires E20`);
}

// D1 — the probe cannot fail open. A file that is not a readable SQLite database holds contents
// nobody can enumerate, and "could not read it" is not evidence of emptiness.
const corruptDb = fixture((r) => { writeFileSync(join(r, "hub.db"), "this is not a sqlite database"); });
const corruptMsg = emitted(corruptDb)[0] ?? "";
ok(emitted(corruptDb).length === 1, "D1: an unreadable hub.db still fires E20 — an unopenable file is not an empty one");
ok(/could not be determined/.test(corruptMsg),
  `D1: the unreadable-hub.db finding says the contents could not be determined (got ${JSON.stringify(corruptMsg)})`);
ok(legacyHomeState(corruptDb)?.hubDb?.kind === "unreadable",
  "D1: the state records the probe outcome as unreadable, so the caller can word the finding from it");

// ── The firing arms ──────────────────────────────────────────────────────────────────────────────

const full = fixture((r) => {
  makeHubDb(join(r, "hub.db"), { projects: 1, tickets: 2, events: 3 });
  writeFileSync(join(r, "projects.json"), "{}");
  writeFileSync(join(r, "qa-state.json"), "{}");
  writeFileSync(join(r, "pm-state.json"), "{}");
  mkdirSync(join(r, "devplatform"), { recursive: true });
  writeFileSync(join(r, "devplatform", "qa-state.json"), "{}");
  mkdirSync(join(r, "platform-api", "reports"), { recursive: true });
  mkdirSync(join(r, "loop", "wt", "LOOP-1"), { recursive: true });   // scratch, alongside real state
});
const s = legacyHomeState(full);
ok(s !== null, "AC3: a populated legacy root IS a finding");
ok(s?.hubDb?.kind === "populated", "AC3: a root-level hub.db carrying rows is reported");
ok(describeLegacyHome(s!).includes("1 project") && describeLegacyHome(s!).includes("2 ticket") && describeLegacyHome(s!).includes("3 event"),
  `D1: the hub.db description carries the counts the judgement was made from (got ${JSON.stringify(describeLegacyHome(s!))})`);
ok(s?.projectsJson === true, "AC3: the v1 projects.json is reported");
ok(JSON.stringify(s?.stateFiles) === JSON.stringify(["pm-state.json", "qa-state.json"]),
  "AC3: root <agent>-state.json files are reported, sorted");
ok(JSON.stringify(s?.projectDirs) === JSON.stringify(["devplatform", "platform-api"]),
  `AC3: only project dirs HOLDING state are reported — 'loop' (worktrees only) is excluded (got ${JSON.stringify(s?.projectDirs)})`);

const msg = emitted(full)[0] ?? "";
ok(emitted(full).length === 1, "AC3: exactly one E20 line is emitted");
ok(msg.startsWith("[E20]"), "AC3: the finding is emitted under [E20]");
ok(msg.includes(full), "AC3: the message names the root it found");
ok(/dev-loop team import/.test(msg), "AC3: the remedy names the migration verb (LOOP-472's `dev-loop team import`)");
ok(/--dry-run/.test(msg), "AC3: the remedy tells the operator to dry-run the migration first");
ok(describeLegacyHome(s!).includes("hub.db") && describeLegacyHome(s!).includes("devplatform"),
  "AC3: the description names the evidence, not just a count");

// Each carrier ALONE is enough — one surviving artifact still orphans on removal.
for (const [label, build] of [
  ["a bare populated hub.db", (r: string) => makeHubDb(join(r, "hub.db"), { projects: 1, tickets: 1 })],
  ["a bare unreadable hub.db", (r: string) => writeFileSync(join(r, "hub.db"), "not sqlite")],
  ["a bare projects.json", (r: string) => writeFileSync(join(r, "projects.json"), "{}")],
  ["a bare <agent>-state.json", (r: string) => writeFileSync(join(r, "ops-state.json"), "{}")],
  ["a project dir with reports/", (r: string) => mkdirSync(join(r, "p", "reports"), { recursive: true })],
  ["a project dir with its own hub.db", (r: string) => {
    mkdirSync(join(r, "p"), { recursive: true }); writeFileSync(join(r, "p", "hub.db"), "sqlite");
  }],
  ["an empty hub.db ALONGSIDE a real carrier", (r: string) => {
    makeHubDb(join(r, "hub.db"), {}); writeFileSync(join(r, "projects.json"), "{}");
  }],
] as Array<[string, (r: string) => void]>) {
  ok(emitted(fixture(build)).length === 1, `AC3: ${label} alone fires E20`);
}

// ── The retired anchor has exactly two readers ───────────────────────────────────────────────────
// `~/.dev-loop` is no longer the last rung of any state ladder (design/state-locality, I3): a
// workspace answers, or the resolver reports that it cannot. Two callers still NAME the location on
// purpose — the migration verb that copies state OUT of it (paths.ts legacyHomeRoot, read by
// team-import.ts) and the E20 row that reports it is still occupied (doctor-registry.ts). A third
// caller is how the fallback grows back, so the set is asserted from the source rather than
// remembered. Comment lines are skipped: this file's own prose names the path it is about.
{
  const srcFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".ts")) srcFiles.push(join(dir, e.name));
    }
  };
  walk(srcDir);
  ok(srcFiles.length > 50, `the source scan sees the whole tree (${srcFiles.length} files)`);
  const readers = new Set<string>();
  for (const file of srcFiles) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      if (/homedir\(\)/.test(line) && line.includes(".dev-loop")) readers.add(file.slice(srcDir.length + 1));
    }
  }
  const expected = ["doctor-registry.ts", "paths.ts"];
  ok(JSON.stringify([...readers].sort()) === JSON.stringify(expected),
    `LOOP-473: the home anchor is composed in exactly ${expected.join(" + ")} (found ${JSON.stringify([...readers].sort())})`);
}

// ── …and no packaged prompt text still teaches it ────────────────────────────────────────────────
// Every agent fire receives DEVLOOP_DATA_DIR (run-agents.ts sets it to the workspace's state root),
// so `${DEVLOOP_DATA_DIR:-~/.dev-loop}` in a skill or a conventions file was a default that could
// only fire when the variable was missing — and it taught the agent to write into the retired tree
// when it did. The scheduler's substitution for that literal is gone with it, so a reappearance now
// reaches the agent verbatim: an unexpanded `${...}` in a prompt, or a path under a home anchor.
{
  const repoRoot = join(srcDir, "..", "..");
  const promptFiles: string[] = [];
  const walkText = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walkText(join(dir, e.name));
      else if (e.name.endsWith(".md")) promptFiles.push(join(dir, e.name));
    }
  };
  walkText(join(repoRoot, "skills"));
  walkText(join(repoRoot, "references"));
  ok(promptFiles.length > 20, `the prompt-text scan sees skills/ + references/ (${promptFiles.length} files)`);
  const offenders = promptFiles
    .filter((f) => readFileSync(f, "utf8").includes("~/.dev-loop"))
    .map((f) => f.slice(repoRoot.length + 1));
  ok(offenders.length === 0,
    `LOOP-473: no packaged skill or reference names the retired ~/.dev-loop anchor (found ${JSON.stringify(offenders)})`);
}

// ── AC6 / the registry ───────────────────────────────────────────────────────────────────────────

const row = DOCTOR_CODES.find((r) => r.code === "E20");
ok(!!row, "LOOP-88: E20 is registered in DOCTOR_CODES");
ok(row?.source === "legacy-home.ts", "LOOP-88: the E20 row points at the file that emits it");

// The collision guard, DERIVED. team-config.ts owns E00-E19 keyed by config path; picking "the next
// free code in doctor.ts" yields E12, which is that file's intake validator. Assert no code in the
// registry is also claimed by a file that is not its declared source.
// A `codes: [...]` entry in the DOCTOR_CHECKS dispatch table names a code without emitting it —
// that is the table's whole job — so it is stripped before scanning. Stripping the SHAPE rather
// than excusing the filename keeps the assertion honest if the dispatch table ever moves or a
// second one appears.
const claimedBy = new Map<string, Set<string>>();
for (const f of readdirSync(srcDir)) {
  if (!f.endsWith(".ts") || f === "doctor-codes.ts") continue;
  const text = readFileSync(join(srcDir, f), "utf8").replace(/codes:\s*\[[^\]]*\]/g, "codes: []");
  for (const m of text.matchAll(/\[(E\d{2})\]|"(E\d{2})"/g)) {
    const code = m[1] ?? m[2];
    if (!code) continue;
    (claimedBy.get(code) ?? claimedBy.set(code, new Set()).get(code)!).add(f);
  }
}
const registeredE = DOCTOR_CODES.filter((r) => /^E\d{2}$/.test(r.code));
const collisions = registeredE
  .map((r) => ({ code: r.code, foreign: [...(claimedBy.get(r.code) ?? [])].filter((f) => f !== r.source) }))
  .filter((x) => x.foreign.length > 0);
ok(collisions.length === 0,
  `LOOP-473: no registered E-code is also claimed by another file${collisions.length ? ` — ${collisions.map((c) => `${c.code} also in ${c.foreign.join(",")}`).join("; ")}` : ""}`);

// And the code we took must be genuinely past everything team-config.ts holds — the assertion above
// only catches an EXACT reuse, not a filer who picks a code below the claimed high-water mark.
const claimedNums = [...claimedBy.keys()].map((c) => Number(c.slice(1)));
const highWater = claimedNums.length ? Math.max(...claimedNums.filter((n) => !registeredE.some((r) => Number(r.code.slice(1)) === n))) : -1;
ok(registeredE.every((r) => Number(r.code.slice(1)) > highWater),
  `LOOP-473: every registered E-code sits above the namespace high-water mark (${highWater}) held elsewhere in hub/src`);

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nLEGACY_HOME_OK");
process.exit(fails ? 1 : 0);
