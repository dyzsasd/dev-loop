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
export class Calc {
  private base: number;
  constructor(base: number) { this.base = base > 0 ? base : 0; }
  scale(n: number): number { return n < 0 ? 0 : n * this.base; }
}
export const twice = (n: number): number => n > 0 ? n * 2 : 0;
export const helpers = { neg: (n: number): number => n < 0 ? -n : n };
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
  // The naming-branch helpers exist for fnName coverage, not as CRAP targets — exercise them so
  // `dead` stays the unambiguous worst row and --sample 2 still reaches grade.
  writeFileSync(join(dir, "tests", "extra.test.ts"), `import test from "node:test";
import assert from "node:assert/strict";
import { Calc, twice, helpers } from "../src/calc.ts";
test("naming helpers", () => {
  assert.equal(new Calc(3).scale(2), 6);
  assert.equal(new Calc(-1).scale(-5), 0);
  assert.equal(twice(4), 8);
  assert.equal(twice(-1), 0);
  assert.equal(helpers.neg(-3), 3);
  assert.equal(helpers.neg(3), 3);
});
`);
  execFileSync("git", ["init", "-qb", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const TEST_CMD = "node --test tests/calc.test.ts tests/extra.test.ts";
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
// fnName's naming branches (its own CRAP row on the 1.7.0 self-audit): class prefix,
// constructor, const-arrow inference, property-assignment inference.
const names = new Set(rows.map((r) => r.name));
ok(names.has("Calc.scale") && names.has("Calc.constructor"), `class members render Class.member (got ${[...names].filter((n) => n.startsWith("Calc")).join(", ")})`);
ok(names.has("twice"), "a const-assigned arrow borrows the variable name");
ok(names.has("neg"), "a property-assigned arrow borrows the property name");
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

// ── 6. the Go backend (skipped cleanly when no go toolchain) ─────────────────────────────────────
const goOk = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
if (!goOk) {
  console.log("⏭  go toolchain not found — Go backend checks skipped (CI runners carry go; local dev may not)");
} else {
  const gdir = mkdtempSync(join(tmpdir(), "devloop-quality-go-fix-"));
  writeFileSync(join(gdir, "go.mod"), "module qfixgo\n\ngo 1.21\n");
  // Grade: CC 4 (1 + 3 if) — fully tested incl. the n<0 boundary (the probe's < → <= flip must be
  // KILLED by TestGrade(0)). Dead: CC 3 (1 + if + &&) — untested ⇒ CRAP = 3²·1³+3 = 12 EXACTLY,
  // because the claimed-bytes denominator means an untested Go fn is a true 0% (no V8-style
  // declaration-line floor).
  writeFileSync(join(gdir, "calc.go"), `package qfixgo

func Grade(n int) string {
	if n < 0 {
		return "bad"
	}
	if n > 10 {
		return "big"
	}
	if n > 5 {
		return "hi"
	}
	return "lo"
}

func Dead(a, b int) int {
	if a > 0 && b > 0 {
		return a - b
	}
	return a + b
}
`);
  writeFileSync(join(gdir, "calc_test.go"), `package qfixgo

import "testing"

func TestGrade(t *testing.T) {
	if Grade(-1) != "bad" || Grade(0) != "lo" || Grade(7) != "hi" || Grade(11) != "big" {
		t.Fatal("grade wrong")
	}
}
`);
  execFileSync("git", ["init", "-qb", "main"], { cwd: gdir });
  execFileSync("git", ["add", "-A"], { cwd: gdir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: gdir });
  const gorig = readFileSync(join(gdir, "calc.go"), "utf8");

  const grep = runQuality(gdir, ["--json", "."]);
  const grows = grep.out?.rows ?? [];
  const gGrade = grows.find((r) => r.name === "Grade");
  const gDead = grows.find((r) => r.name === "Dead");
  ok(gGrade?.cc === 4 && gDead?.cc === 3, `Go CC via the token scanner (Grade 4, Dead 3; got ${gGrade?.cc}/${gDead?.cc})`);
  ok(gGrade?.coverage === 100, `Go coverage from -coverprofile blocks (Grade 100%; got ${gGrade?.coverage})`);
  ok(gDead?.coverage === 0 && gDead?.crap === 12,
    `claimed-bytes denominator: an untested Go fn is a TRUE 0% ⇒ CRAP exactly 12 (got ${gDead?.coverage}% / ${gDead?.crap})`);
  ok(grows[0]?.name === "Dead", "Go rows sort into the same worst-first report");
  ok(runQuality(gdir, [".", "--threshold", "10"]).status === 2, "the same --threshold gate semantics apply to Go (exit 2)");

  const gmut = runQuality(gdir, ["--json", ".", "--mutate", "--sample", "2"]);
  const mDead = gmut.out?.mutants?.find((m) => m.fn === "Dead");
  const mGrade = gmut.out?.mutants?.find((m) => m.fn === "Grade");
  ok(mDead?.killed === false, `Go mutation probe: the untested fn SURVIVES (got ${JSON.stringify(mDead)})`);
  ok(mGrade?.killed === true, `Go mutation probe: the boundary flip on the tested fn is KILLED (got ${JSON.stringify(mGrade)})`);
  ok(readFileSync(join(gdir, "calc.go"), "utf8") === gorig, "Go file restored byte-identically after the probe");
}

console.log(fails === 0 ? "\nQUALITY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
