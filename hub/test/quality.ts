// quality tool tests — the CRAP gate + mutation probe (quality-gauntlet design).
// Contracts under test: (1) per-function CC via real AST + the crap4java formula over native
// V8 coverage; (2) worst-first report ordering, N/A handling; (3) --threshold gate exit 2;
// (4) the mutation probe flips ONE site, detects KILLED vs SURVIVED, restores the file
// byte-identically, and exit 3 rides --fail-on-survivors; (5) --changed file selection.
// All through the CLI (quality.ts is an entry that runs main() on import).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const here = dirname(fileURLToPath(import.meta.url));
const QUALITY = join(here, "..", "src", "quality.ts");

interface Row { name: string; file: string; line: number; cc: number; coverage: number | null; crap: number | null }
interface Mutant { file: string; line: number; from: string; to: string; fn: string; killed: boolean | null; note?: string }
interface Out { maxCrap: number | null; rows: Row[]; mutants: Mutant[] }

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "devloop-quality-fix-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "qfix", type: "module" }));
  // grade: CC = 1 + if + if + ternary = 4 — fully exercised by the test below (incl. the n<0 boundary,
  // which the mutation probe's first flip `<` → `<=` must break: grade(0) flips "lo" → "bad" ⇒ KILLED).
  // dead:  CC = 1 + if + && = 3 — never imported by any test ⇒ coverage ~0 ⇒ the worst CRAP row.
  writeFileSync(join(dir, "src", "calc.ts"), `export function grade(n: number): string {
  if (n < 0) return "bad";
  if (n > 10) return "big";
  return n > 5 ? "hi" : "lo";
}
export function dead(a: number, b: number): number {
  if (a && b) return a - b;
  return a + b;
}
`);
  writeFileSync(join(dir, "tests", "calc.test.ts"), `import test from "node:test";
import assert from "node:assert/strict";
import { grade } from "../src/calc.ts";
test("grade", () => {
  assert.equal(grade(-1), "bad");
  assert.equal(grade(0), "lo");
  assert.equal(grade(7), "hi");
  assert.equal(grade(11), "big");
});
`);
  execFileSync("git", ["init", "-qb", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const TEST_CMD = "node --test tests/calc.test.ts";
function runQuality(cwd: string, args: string[]): { status: number; out: Out | null; raw: string } {
  const r = spawnSync(process.execPath, [QUALITY, ...args], { cwd, encoding: "utf8" });
  let out: Out | null = null;
  try { out = JSON.parse(r.stdout) as Out; } catch { /* non-JSON runs */ }
  return { status: r.status ?? -1, out, raw: `${r.stdout}\n${r.stderr}` };
}

const repo = fixtureRepo();
const orig = readFileSync(join(repo, "src", "calc.ts"), "utf8");

// ── 1. CRAP rows: AST complexity + V8 coverage + the crap4java formula ───────────────────────────
const rep = runQuality(repo, ["--json", "--test-cmd", TEST_CMD]);
ok(rep.status === 0, `report run exits 0 (got ${rep.status})`);
const rows = rep.out?.rows ?? [];
const grade = rows.find((r) => r.name === "grade");
const dead = rows.find((r) => r.name === "dead");
ok(grade?.cc === 4, `grade CC = 4 (1 + if + if + ternary; got ${grade?.cc})`);
ok(dead?.cc === 3, `dead CC = 3 (1 + if + &&; got ${dead?.cc})`);
ok((grade?.coverage ?? 0) > 90, `grade is covered by the suite (got ${grade?.coverage?.toFixed(1)}%)`);
ok((dead?.coverage ?? 100) < 10, `dead is uncovered (got ${dead?.coverage?.toFixed(1)}%)`);
// The formula itself, verified against the row's own inputs (V8 counts the declaration line as
// executed, so an "untested" fn still shows a few covered bytes — assert the MATH, not a guess).
const expectCrap = (r?: Row) => r && r.coverage !== null ? r.cc * r.cc * Math.pow(1 - r.coverage / 100, 3) + r.cc : NaN;
ok(dead?.crap !== null && Math.abs((dead?.crap ?? 0) - expectCrap(dead)) < 0.01,
  `CRAP(dead) matches CC²·(1−cov)³+CC exactly (got ${dead?.crap?.toFixed(2)}, expect ${expectCrap(dead).toFixed(2)})`);
ok(grade?.crap !== null && Math.abs((grade?.crap ?? 0) - expectCrap(grade)) < 0.01,
  `CRAP(grade) matches the formula too (got ${grade?.crap?.toFixed(2)})`);
ok(rows[0]?.name === "dead", `worst CRAP sorts first (got '${rows[0]?.name}')`);
ok(rep.out?.maxCrap !== null && Math.abs((rep.out?.maxCrap ?? 0) - (dead?.crap ?? -1)) < 0.01, "maxCrap = the worst row's score");

// ── 2. threshold gate ────────────────────────────────────────────────────────────────────────────
ok(runQuality(repo, ["--test-cmd", TEST_CMD, "--threshold", "5"]).status === 2, "--threshold 5 gates: exit 2 (max ≈ 12 exceeds it)");
ok(runQuality(repo, ["--test-cmd", TEST_CMD, "--threshold", "50"]).status === 0, "--threshold 50 passes: exit 0");

// ── 3. mutation probe: SURVIVED on the untested fn, restore byte-identical ───────────────────────
const mut = runQuality(repo, ["--json", "--test-cmd", TEST_CMD, "--mutate", "--sample", "1"]);
const m0 = mut.out?.mutants?.[0];
ok(m0?.fn === "dead" && m0?.killed === false, `worst-CRAP fn is probed and SURVIVES (no test touches dead; got ${JSON.stringify(m0)})`);
ok(readFileSync(join(repo, "src", "calc.ts"), "utf8") === orig, "mutated file restored byte-identically");
ok(mut.status === 0, "survivors without --fail-on-survivors still exit 0");
ok(runQuality(repo, ["--test-cmd", TEST_CMD, "--mutate", "--sample", "1", "--fail-on-survivors"]).status === 3,
  "--fail-on-survivors turns a survivor into exit 3");

// ── 4. mutation probe: KILLED when the suite bites (sample 2 reaches grade) ──────────────────────
const mut2 = runQuality(repo, ["--json", "--test-cmd", TEST_CMD, "--mutate", "--sample", "2"]);
const mGrade = mut2.out?.mutants?.find((m) => m.fn === "grade");
ok(mGrade?.killed === true, `grade's boundary flip (< → <=) is KILLED by its test (got ${JSON.stringify(mGrade)})`);
ok(readFileSync(join(repo, "src", "calc.ts"), "utf8") === orig, "file restored after the killed mutant too");

// ── 5. --changed selection ───────────────────────────────────────────────────────────────────────
writeFileSync(join(repo, "src", "extra.ts"), "export function five(): number { return 5; }\n");
const chg = runQuality(repo, ["--json", "--changed", "--test-cmd", TEST_CMD]);
const chgFiles = new Set((chg.out?.rows ?? []).map((r) => r.file));
ok(chgFiles.has("src/extra.ts") && !chgFiles.has("src/calc.ts"), `--changed analyzes only git-changed files (got ${[...chgFiles].join(", ")})`);

console.log(fails === 0 ? "\nQUALITY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
