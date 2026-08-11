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

// ── The firing arms ──────────────────────────────────────────────────────────────────────────────

const full = fixture((r) => {
  writeFileSync(join(r, "hub.db"), "sqlite");
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
ok(s?.hubDb === true, "AC3: a root-level hub.db is reported");
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
  ["a bare hub.db", (r: string) => writeFileSync(join(r, "hub.db"), "sqlite")],
  ["a bare projects.json", (r: string) => writeFileSync(join(r, "projects.json"), "{}")],
  ["a bare <agent>-state.json", (r: string) => writeFileSync(join(r, "ops-state.json"), "{}")],
  ["a project dir with reports/", (r: string) => mkdirSync(join(r, "p", "reports"), { recursive: true })],
  ["a project dir with its own hub.db", (r: string) => {
    mkdirSync(join(r, "p"), { recursive: true }); writeFileSync(join(r, "p", "hub.db"), "sqlite");
  }],
] as Array<[string, (r: string) => void]>) {
  ok(emitted(fixture(build)).length === 1, `AC3: ${label} alone fires E20`);
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
