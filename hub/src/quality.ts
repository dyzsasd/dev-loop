#!/usr/bin/env node
// `dev-loop quality` — the CRAP gate + mutation probe (the quality-gauntlet design,
// docs/design/quality-gauntlet.md; modeled on unclebob/crap4java).
//
// CRAP(fn) = CC² × (1 − coverage)³ + CC — per FUNCTION, not per file: it scores the
// intersection of "complex" AND "untested", which is exactly the failure shape of
// agent-written code (clever logic nobody's tests exercise). Complexity alone flags
// well-tested hot spots; coverage alone flags trivial glue; the product flags risk.
//
// Two modes, one tool:
//   report/gate   run the repo's tests under NODE_V8_COVERAGE, map V8 function coverage
//                 onto TS/JS source functions, print the worst-first CRAP table;
//                 --threshold N turns the report into a GATE (exit 2 when exceeded).
//   --mutate      the test-strength probe: flip one operator/literal per sampled
//                 function, re-run the tests, restore the file byte-identically. A
//                 SURVIVING mutant = a test suite that doesn't bite (the 2026-07 field
//                 incident: all-null prices shipped under a fully GREEN suite —
//                 coverage can't catch that; a mutant survives it loudly).
//
// Deliberately dependency-free: complexity/function spans come from the TARGET repo's
// own `typescript` package when resolvable (real AST), else a per-FILE token fallback
// (degraded but honest — rows say file-level). Coverage is native V8 (NODE_V8_COVERAGE)
// — no jacoco/c8/istanbul. On Node's zero-build type-stripping, TS offsets are
// PRESERVED in the running file, so V8 ranges map 1:1 onto the .ts source.
//
// Exit codes: 0 ok · 1 usage/internal · 2 CRAP threshold exceeded · 3 surviving mutants
// (with --fail-on-survivors). Machine consumption: --json.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

// ─── types ───────────────────────────────────────────────────────────────────────────────────────

interface FnSpan { name: string; file: string; start: number; end: number; line: number; cc: number }
interface Row extends FnSpan { coverage: number | null; crap: number | null }
interface Mutant { file: string; line: number; from: string; to: string; fn: string; killed: boolean | null; note?: string }

interface Opts {
  paths: string[];
  changed: boolean;
  threshold: number | null;
  json: boolean;
  testCmd: string | null;
  coverageDir: string | null;
  keepCoverage: boolean;
  mutate: boolean;
  sample: number;
  failOnSurvivors: boolean;
  mutateTestCmd: string | null;
  top: number;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────

function usage(): void {
  console.log(`dev-loop quality — per-function CRAP report/gate + mutation probe (CRAP = CC² × (1−cov)³ + CC)

Usage:
  dev-loop quality                     analyze every source file under src/
  dev-loop quality --changed           analyze files changed per \`git status\` (the cheap per-fire gate)
  dev-loop quality <path ...>          analyze these files / directories
  dev-loop quality --mutate            + mutation probe on the worst-CRAP functions

Options:
  --threshold <n>       GATE: exit 2 when the max CRAP score exceeds n (absent = report-only)
  --test-cmd <cmd>      coverage/test command (default: \`npm test\`), run with NODE_V8_COVERAGE
  --coverage-dir <dir>  reuse an existing NODE_V8_COVERAGE dir instead of running tests
  --keep-coverage       keep the collected coverage dir (prints its path)
  --top <n>             show only the worst n rows (default 25; 0 = all)
  --json                machine output: { rows, mutants, maxCrap }
  --mutate              mutation probe: flip one operator/literal per sampled function,
                        re-run tests, restore byte-identically; SURVIVED = a test gap
  --sample <n>          how many worst-CRAP functions to mutate (default 5)
  --mutate-test-cmd <c> test command for mutants (default: --test-cmd / npm test)
  --fail-on-survivors   exit 3 when any mutant survives

Config hook: \`repos.<ref>.build.quality\` (e.g. "dev-loop quality --changed --threshold 30")
runs as the fourth Step-5 ship gate after typecheck/build/test (conventions §19).`);
}

function die(msg: string, code = 1): never { console.error(`dev-loop quality: ${msg}`); process.exit(code); }

function parseArgs(argv: string[]): Opts {
  const o: Opts = { paths: [], changed: false, threshold: null, json: false, testCmd: null, coverageDir: null,
    keepCoverage: false, mutate: false, sample: 5, failOnSurvivors: false, mutateTestCmd: null, top: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--changed") o.changed = true;
    else if (a === "--threshold") { o.threshold = Number(next()); if (!Number.isFinite(o.threshold)) die("--threshold must be a number"); }
    else if (a === "--json") o.json = true;
    else if (a === "--test-cmd") o.testCmd = next();
    else if (a === "--coverage-dir") o.coverageDir = resolve(next());
    else if (a === "--keep-coverage") o.keepCoverage = true;
    else if (a === "--mutate") o.mutate = true;
    else if (a === "--sample") { o.sample = Number(next()); if (!Number.isInteger(o.sample) || o.sample <= 0) die("--sample must be a positive integer"); }
    else if (a === "--fail-on-survivors") o.failOnSurvivors = true;
    else if (a === "--mutate-test-cmd") o.mutateTestCmd = next();
    else if (a === "--top") { o.top = Number(next()); if (!Number.isInteger(o.top) || o.top < 0) die("--top must be a non-negative integer"); }
    else if (a.startsWith("--")) die(`unknown option '${a}'`);
    else o.paths.push(a);
  }
  return o;
}

// ─── file selection (crap4java §5: default src/**, --changed via git status, explicit paths) ─────

const SRC_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".next"]);
const isTestFile = (p: string) => /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/)/.test(p);

function walk(dir: string, out: string[]): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (SRC_EXT.test(e) && !e.endsWith(".d.ts")) out.push(p);
  }
}

function selectFiles(root: string, o: Opts): string[] {
  const out: string[] = [];
  if (o.changed) {
    const st = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    for (const line of st.split("\n")) {
      const p = line.slice(3).trim();
      if (p && SRC_EXT.test(p) && !p.endsWith(".d.ts") && !isTestFile(p) && existsSync(join(root, p))) out.push(resolve(root, p));
    }
  } else if (o.paths.length) {
    for (const raw of o.paths) {
      const p = resolve(root, raw);
      if (!existsSync(p)) die(`no such path: ${raw}`);
      if (statSync(p).isDirectory()) { const sub = join(p, "src"); walk(existsSync(sub) ? sub : p, out); }
      else out.push(p);
    }
  } else {
    const src = join(root, "src");
    walk(existsSync(src) ? src : root, out);
  }
  return [...new Set(out)].filter((p) => !isTestFile(relative(root, p))).sort();
}

// ─── complexity: real AST via the target repo's own `typescript`, else per-file token fallback ───

// Loaded once; null ⇒ fallback mode. The TARGET repo's typescript wins (its parser matches its
// syntax level); our own devDependency is the second chance (covers plain-JS repos).
type TsModule = typeof import("typescript");
function loadTypescript(root: string): TsModule | null {
  for (const from of [join(root, "package.json"), join(import.meta.dirname ?? ".", "package.json")]) {
    try { return createRequire(from)("typescript") as TsModule; } catch { /* next candidate */ }
  }
  return null;
}

// The decision points crap4java counts (if / loops / case / catch / ternary / && / ||) plus `??`.
function isDecisionNode(ts: TsModule, n: import("typescript").Node): boolean {
  const K = ts.SyntaxKind;
  switch (n.kind) {
    case K.IfStatement: case K.ForStatement: case K.ForInStatement: case K.ForOfStatement:
    case K.WhileStatement: case K.DoStatement: case K.CaseClause: case K.CatchClause:
    case K.ConditionalExpression: return true;
    case K.BinaryExpression: {
      const op = (n as import("typescript").BinaryExpression).operatorToken.kind;
      return op === K.AmpersandAmpersandToken || op === K.BarBarToken || op === K.QuestionQuestionToken;
    }
    default: return false;
  }
}

function isFunctionNode(ts: TsModule, n: import("typescript").Node): boolean {
  const K = ts.SyntaxKind;
  return n.kind === K.FunctionDeclaration || n.kind === K.MethodDeclaration || n.kind === K.Constructor
    || n.kind === K.GetAccessor || n.kind === K.SetAccessor || n.kind === K.FunctionExpression || n.kind === K.ArrowFunction;
}

// Complexity of ONE function body: nested function-likes are their own rows, so the walk
// does not descend into them (the classic per-method reading of cyclomatic complexity).
function ccOf(ts: TsModule, fn: import("typescript").Node): number {
  let cc = 1;
  const visit = (n: import("typescript").Node): void => {
    if (n !== fn && isFunctionNode(ts, n)) return;
    if (isDecisionNode(ts, n)) cc++;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return cc;
}

function fnName(ts: TsModule, n: import("typescript").Node, sf: import("typescript").SourceFile): string {
  const K = ts.SyntaxKind;
  const own = (n as { name?: import("typescript").Node }).name;
  let base = own ? own.getText(sf) : "";
  if (!base) {
    // Anonymous function/arrow: borrow the nearest assignment target so the report row is findable.
    const p = n.parent as import("typescript").Node | undefined;
    if (p && (p.kind === K.VariableDeclaration || p.kind === K.PropertyAssignment || p.kind === K.PropertyDeclaration))
      base = (p as { name?: import("typescript").Node }).name?.getText(sf) ?? "";
    else if (p && p.kind === K.BinaryExpression) base = (p as import("typescript").BinaryExpression).left.getText(sf);
  }
  if (!base) base = n.kind === K.Constructor ? "constructor" : "<anon>";
  // Class context prefix, crap4java-style Method@Class readability.
  let cls = "";
  for (let a = n.parent; a; a = a.parent) {
    if (a.kind === K.ClassDeclaration || a.kind === K.ClassExpression) { cls = (a as { name?: import("typescript").Node }).name?.getText(sf) ?? ""; break; }
  }
  return cls ? `${cls}.${base}` : base;
}

function parseFunctions(ts: TsModule | null, root: string, file: string, source: string): FnSpan[] {
  const rel = relative(root, file);
  if (!ts) {
    // Fallback (no typescript resolvable): one file-level row — degraded but honest.
    let cc = 1;
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const m of stripped.matchAll(/\b(if|for|while|case|catch)\b|\&\&|\|\||\?\?/g)) { void m; cc++; }
    return [{ name: "<file>", file: rel, start: 0, end: source.length, line: 1, cc }];
  }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: FnSpan[] = [];
  const visit = (n: import("typescript").Node): void => {
    if (isFunctionNode(ts, n) && (n as { body?: unknown }).body) {
      const start = n.getStart(sf);
      out.push({ name: fnName(ts, n, sf), file: rel, start, end: n.getEnd(),
        line: sf.getLineAndCharacterOfPosition(start).line + 1, cc: ccOf(ts, n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ─── coverage: native V8 (NODE_V8_COVERAGE), painted per file, OR-merged across processes ────────

function runTests(root: string, cmd: string, covDir: string): void {
  console.error(`quality: running tests for coverage — ${cmd}  (NODE_V8_COVERAGE=${covDir})`);
  // Test output rides STDERR: stdout belongs to the report (--json consumers parse it — a TAP line
  // leaking into stdout would corrupt the machine output).
  const r = spawnSync("bash", ["-c", cmd], { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, NODE_V8_COVERAGE: covDir } });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) console.error(`quality: test command exited ${r.status ?? "?"} — coverage may be partial (rows still computed)`);
}

// covered[file] = Uint8Array over source length; 1 = executed at least once in some process.
// Per process, ranges are painted outer-first (sorted start asc / end desc) so nested
// uncovered branches override their covered parents; processes then OR together —
// covered anywhere is covered (a worker that never loaded the file must not erase another's data).
function collectCoverage(root: string, covDir: string, wanted: Map<string, string>): Map<string, Uint8Array> {
  const merged = new Map<string, Uint8Array>();
  let files: string[] = [];
  try { files = readdirSync(covDir).filter((f) => f.startsWith("coverage-") && f.endsWith(".json")); } catch { return merged; }
  for (const f of files) {
    let data: { result?: { url?: string; functions?: { ranges?: { startOffset: number; endOffset: number; count: number }[] }[] }[] };
    try { data = JSON.parse(readFileSync(join(covDir, f), "utf8")); } catch { continue; }
    const perProc = new Map<string, Uint8Array>();
    for (const script of data.result ?? []) {
      if (!script.url?.startsWith("file://")) continue;
      let p: string; try { p = decodeURIComponent(new URL(script.url).pathname); } catch { continue; }
      const src = wanted.get(p);
      if (src === undefined) continue;
      const paint = perProc.get(p) ?? new Uint8Array(src.length);
      const ranges = (script.functions ?? []).flatMap((fn) => fn.ranges ?? []);
      ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      for (const r of ranges) {
        const s = Math.min(Math.max(r.startOffset, 0), src.length);
        const e = Math.min(Math.max(r.endOffset, 0), src.length);
        paint.fill(r.count > 0 ? 1 : 0, s, e);
      }
      perProc.set(p, paint);
    }
    for (const [p, paint] of perProc) {
      const m = merged.get(p);
      if (!m) merged.set(p, paint);
      else for (let i = 0; i < paint.length; i++) if (paint[i]) m[i] = 1;
    }
  }
  void root;
  return merged;
}

function coverageOf(paint: Uint8Array | undefined, start: number, end: number): number | null {
  if (!paint || end <= start) return paint ? 100 : null;
  let hit = 0;
  for (let i = start; i < end && i < paint.length; i++) hit += paint[i];
  return (hit / (end - start)) * 100;
}

// CRAP = CC² × (1 − cov)³ + CC (crap4java formula, coverage as a fraction).
function crapScore(cc: number, coveragePct: number | null): number | null {
  if (coveragePct === null) return null;
  const un = 1 - coveragePct / 100;
  return cc * cc * un * un * un + cc;
}

// ─── report (crap4java shape: worst first, N/A at the bottom) ────────────────────────────────────

function formatReport(rows: Row[], top: number): string {
  const shown = top > 0 ? rows.slice(0, top) : rows;
  const w = { fn: 34, file: 40 };
  const clip = (s: string, n: number) => s.length <= n ? s : `…${s.slice(-(n - 1))}`;
  const lines: string[] = ["CRAP Report", "==========="];
  lines.push(`${"Function".padEnd(w.fn)} ${"File:Line".padEnd(w.file)} ${"CC".padStart(4)} ${"Cov%".padStart(7)} ${"CRAP".padStart(8)}`);
  lines.push("-".repeat(w.fn + w.file + 22));
  for (const r of shown)
    lines.push(`${clip(r.name, w.fn).padEnd(w.fn)} ${clip(`${r.file}:${r.line}`, w.file).padEnd(w.file)} ${String(r.cc).padStart(4)} ${(r.coverage === null ? "N/A" : r.coverage.toFixed(1)).padStart(7)} ${(r.crap === null ? "N/A" : r.crap.toFixed(1)).padStart(8)}`);
  if (top > 0 && rows.length > top) lines.push(`… ${rows.length - top} more row(s) (--top 0 for all)`);
  return lines.join("\n");
}

// ─── mutation probe ──────────────────────────────────────────────────────────────────────────────

// One flip per site, deterministic order: the first mutable token inside the function span.
const OP_FLIPS: Record<string, string> = { "===": "!==", "!==": "===", "==": "!=", "!=": "==",
  "<": "<=", "<=": "<", ">": ">=", ">=": ">", "&&": "||", "||": "&&", "+": "-", "-": "+" };

function findMutationSite(ts: TsModule, source: string, file: string, span: FnSpan): { pos: number; from: string; to: string } | null {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const K = ts.SyntaxKind;
  let found: { pos: number; from: string; to: string } | null = null;
  const visit = (n: import("typescript").Node): void => {
    if (found) return;
    const s = n.getStart(sf);
    if (s < span.start || n.getEnd() > span.end) { if (n.getEnd() < span.start || s > span.end) return; }
    if (n.kind === K.BinaryExpression) {
      const opTok = (n as import("typescript").BinaryExpression).operatorToken;
      const op = opTok.getText(sf);
      const flip = OP_FLIPS[op];
      // `+` on strings concatenates — flipping to `-` yields NaN, still a behavior change; allowed.
      if (flip && opTok.getStart(sf) >= span.start && opTok.getEnd() <= span.end) { found = { pos: opTok.getStart(sf), from: op, to: flip }; return; }
    }
    if ((n.kind === K.TrueKeyword || n.kind === K.FalseKeyword) && s >= span.start) {
      found = { pos: s, from: n.getText(sf), to: n.kind === K.TrueKeyword ? "false" : "true" }; return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function runMutation(ts: TsModule, root: string, rows: Row[], o: Opts): Mutant[] {
  const testCmd = o.mutateTestCmd ?? o.testCmd ?? "npm test";
  const pool = rows.filter((r) => r.name !== "<file>").slice(0, o.sample);
  const mutants: Mutant[] = [];
  const restores: { path: string; bytes: string }[] = [];
  const restoreAll = () => { for (const r of restores.splice(0)) { try { writeFileSync(r.path, r.bytes); } catch { console.error(`quality: FAILED to restore ${r.path} — original saved at ${r.path}.quality-orig`); try { writeFileSync(`${r.path}.quality-orig`, r.bytes); } catch { /* double fault */ } } } };
  process.on("SIGINT", () => { restoreAll(); process.exit(130); });
  process.on("uncaughtException", (e) => { restoreAll(); console.error(e); process.exit(1); });

  for (const row of pool) {
    const abs = resolve(root, row.file);
    // Mutating a file the operator/agent is mid-edit on would merge our flip into THEIR change — refuse.
    // Outside a git repo there is nothing to protect against (and nothing to restore FROM) — proceed;
    // the byte-identical restore + sha verification below is the real safety net either way.
    let dirty = "";
    try { dirty = execFileSync("git", ["status", "--porcelain", "--", row.file], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not a git repo */ }
    if (dirty) { mutants.push({ file: row.file, line: row.line, from: "", to: "", fn: row.name, killed: null, note: "skipped: file has uncommitted changes" }); continue; }
    const source = readFileSync(abs, "utf8");
    const site = findMutationSite(ts, source, abs, row);
    if (!site) { mutants.push({ file: row.file, line: row.line, from: "", to: "", fn: row.name, killed: null, note: "skipped: no mutable operator/literal in span" }); continue; }
    const before = sha(source);
    const mutated = source.slice(0, site.pos) + site.to + source.slice(site.pos + site.from.length);
    restores.push({ path: abs, bytes: source });
    writeFileSync(abs, mutated);
    console.error(`quality: mutant ${row.file}:${row.line} ${row.name}  ${site.from} → ${site.to}  … running tests`);
    const r = spawnSync("bash", ["-c", testCmd], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env }, encoding: "utf8" });
    writeFileSync(abs, source);
    restores.pop();
    if (sha(readFileSync(abs, "utf8")) !== before) die(`restore verification FAILED for ${row.file} — check the working tree`, 1);
    const killed = r.status !== 0;
    mutants.push({ file: row.file, line: row.line, from: site.from, to: site.to, fn: row.name, killed });
    console.error(`quality:   ${killed ? "KILLED (a test caught it)" : "SURVIVED — no test noticed this behavior change"}`);
  }
  return mutants;
}

// ─── main ────────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const files = selectFiles(root, o);
  if (!files.length) { console.log("No source files to analyze."); return; }

  const ts = loadTypescript(root);
  if (!ts) console.error("quality: no `typescript` resolvable (repo or dev-loop) — falling back to per-FILE complexity rows");

  const sources = new Map<string, string>();
  for (const f of files) sources.set(f, readFileSync(f, "utf8"));

  // coverage
  let covDir = o.coverageDir;
  let ephemeral = false;
  if (!covDir) {
    covDir = mkdtempSync(join(tmpdir(), "devloop-quality-"));
    ephemeral = true;
    runTests(root, o.testCmd ?? "npm test", covDir);
  }
  const painted = collectCoverage(root, covDir, sources);
  if (!painted.size) console.error(`quality: no V8 coverage matched the analyzed files (dir: ${covDir}) — all rows N/A. If tests run COMPILED output (dist/), point paths at what actually runs, or run tests directly on source (zero-build).`);

  // rows
  const rows: Row[] = [];
  for (const f of files) {
    const src = sources.get(f)!;
    const paint = painted.get(f);
    for (const span of parseFunctions(ts, root, f, src)) {
      const cov = coverageOf(paint, span.start, span.end);
      rows.push({ ...span, coverage: cov, crap: crapScore(span.cc, cov) });
    }
  }
  rows.sort((a, b) => (a.crap === null ? 1 : 0) - (b.crap === null ? 1 : 0) || (b.crap ?? 0) - (a.crap ?? 0) || b.cc - a.cc);
  const maxCrap = rows.find((r) => r.crap !== null)?.crap ?? null;

  // mutation probe
  let mutants: Mutant[] = [];
  if (o.mutate) {
    if (!ts) die("--mutate needs a resolvable `typescript` (AST-precise flips only — no blind regex edits)");
    mutants = runMutation(ts, root, rows, o);
  }

  if (ephemeral && !o.keepCoverage) { try { rmSync(covDir!, { recursive: true, force: true }); } catch { /* tmp */ } }
  else if (o.keepCoverage) console.error(`quality: coverage kept at ${covDir}`);

  // output
  if (o.json) {
    console.log(JSON.stringify({ maxCrap, rows, mutants }, null, 2));
  } else {
    console.log(formatReport(rows, o.top));
    if (mutants.length) {
      console.log("\nMutation Probe\n==============");
      for (const m of mutants)
        console.log(`${m.killed === null ? "SKIP    " : m.killed ? "KILLED  " : "SURVIVED"} ${m.file}:${m.line} ${m.fn}${m.from ? `  ${m.from} → ${m.to}` : ""}${m.note ? `  (${m.note})` : ""}`);
      const run = mutants.filter((m) => m.killed !== null);
      const survived = run.filter((m) => !m.killed).length;
      console.log(`${run.length} mutant(s) run: ${run.length - survived} killed, ${survived} survived${survived ? " — a surviving mutant is a test that doesn't bite" : ""}`);
    }
  }

  const survivors = mutants.some((m) => m.killed === false);
  if (o.threshold !== null && maxCrap !== null && maxCrap > o.threshold) {
    console.error(`quality: CRAP threshold exceeded — max ${maxCrap.toFixed(1)} > ${o.threshold}`);
    process.exit(2);
  }
  if (o.failOnSurvivors && survivors) process.exit(3);
}

main();
