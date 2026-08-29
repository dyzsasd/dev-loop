// destructive-guard — direct unit arms for the isolation gate's PREDICATES (LOOP-381).
//
// The module is the authorization surface for every verb that destroys operator data: it decides
// whether a destructive verb may run at all (`activeFireMarker`), against which target
// (`isolationVerdict` / `workspaceIsolationVerdict`), and under which token (`confirmationToken`).
// It exists because of two incidents — the 2026-08-04 cascade delete of 301 live tickets (LOOP-305)
// and the 2026-08-06 board-restore run BY A FIRE (LOOP-367) — so its predicates are the last thing
// in this codebase that should be covered only as a side effect of somebody else's suite.
//
// WHAT THIS FILE ADDS, and what it deliberately does NOT duplicate. Measured on this tree before it
// was written, not assumed:
//
//   | export                     | direct arms before LOOP-381 | this file |
//   |----------------------------|-----------------------------|-----------|
//   | activeFireMarker           | NONE                        | full      |
//   | workspaceIsolationVerdict  | NONE (CLI-level only)       | full      |
//   | FIRE_MARKERS               | NONE                        | full      |
//   | confirmationToken          | team-edit.ts, team-repair.ts| re-pinned |
//   | isScratchProject           | team-edit.ts:430-433        | re-pinned |
//   | isolationVerdict           | team-edit.ts:435-445        | re-pinned |
//   | commitBothHalves           | destructive-commit.ts (all) | NOT re-run|
//
// `commitBothHalves` already has a dedicated unit suite — destructive-commit.ts covers every one of
// the five paths (config-only, db-only, both-succeed, compensation-succeeds, compensation-fails,
// plus a byte-exactness arm and an UNVERIFIED-rollback arm). A second copy of those arms here would
// be two spellings of one contract, which is the drift the module's own docstring exists to prevent.
// Instead, the COVERAGE MAP at the bottom asserts mechanically that every runtime export of
// destructive-guard.ts is imported-and-exercised by some suite, so "every export has a direct unit
// test" is a checked claim rather than a comment that rots — and a NEW untested export fails here.
//
// The predicate arms re-pinned above are cheap (they are pure functions) and are kept in ONE
// mutation-testable file on purpose: inverting a guard's condition must fail a suite whose name says
// what it guards.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRE_MARKERS,
  TOKEN_PREFIX,
  activeFireMarker,
  confirmationToken,
  isScratchProject,
  isolationVerdict,
  workspaceIsolationVerdict,
} from "../src/destructive-guard.ts";
import { FIRE_MARKER_VARS } from "./env-scrub.ts";
import { codeOnly } from "./code-only.ts"; // LOOP-396: the ONE source-to-executable-text reduction
import type { Workspace } from "../src/team-config.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── AC1: isolation — the fire markers are scrubbed, and the ambient hub.db is a canary ──────────
//
// Two separate hazards, and they need separate treatment:
//
//  1. FIRE MARKERS. `activeFireMarker()` reads `process.env` by default, and this suite runs INSIDE
//     an agent fire as often as not (`DEVLOOP_DEV_SPLIT` is set on every run-agents fire). An arm
//     asserting "no marker ⇒ null" would fail there for a reason that has nothing to do with the
//     code. The scrub uses env-scrub.ts's FIRE_MARKER_VARS — the ONE union (LOOP-156) — never a
//     second local list. It runs before any arm; the module reads env at CALL time, not at import
//     time, so module-evaluation order is not a factor.
//  2. THE AMBIENT DB. `$DEVLOOP_HUB_DB` normally points at the LIVE board. This suite must never
//     open it. Rather than trusting that, the var is re-pointed at a CANARY db in this suite's own
//     tmpdir and its row count / size / mtime are compared before and after every arm: any code
//     path that resolves the ambient hub db lands on the canary, and the tripwire fires. (These
//     predicates are pure today; the tripwire is what keeps that true when the module grows.)
for (const v of FIRE_MARKER_VARS) delete process.env[v];
ok(FIRE_MARKER_VARS.every((v) => process.env[v] === undefined),
  "AC1: every fire-marker/workspace env var is scrubbed from this process before any arm runs");
ok(activeFireMarker() === null,
  "AC1: with the ambient env scrubbed, activeFireMarker() reports no fire — the arms below measure the code, not the launcher");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-destructive-guard-")));
const canaryPath = join(tmp, "canary-hub.db");
const canaryRows = () => {
  const db = new DatabaseSync(canaryPath);
  try { return (db.prepare("SELECT count(*) c FROM issues").get() as { c: number }).c; }
  finally { db.close(); }
};
{
  const db = new DatabaseSync(canaryPath);
  db.exec("CREATE TABLE issues(id TEXT)");
  for (const id of ["LOOP-1", "LOOP-2", "LOOP-3", "LOOP-4", "LOOP-5", "LOOP-6", "LOOP-7"]) {
    db.prepare("INSERT INTO issues(id) VALUES(?)").run(id);
  }
  db.close();
}
// Measured AFTER the seeding connection closes and BEFORE the env var is set, so the baseline is not
// taken through the same open that the final check is meant to catch.
const canaryBefore = { rows: canaryRows(), size: statSync(canaryPath).size, mtimeMs: statSync(canaryPath).mtimeMs };
process.env.DEVLOOP_HUB_DB = canaryPath;

// Every Workspace in this file is hand-built and lives only in memory — the predicates take a
// Workspace, never a path, so no arm below reads or writes any file at all.
const projectWs = (projects: Record<string, { scratch?: unknown }>) =>
  ({ file: { projects } } as unknown as Workspace);
const wsWs = (key: string, projects: Record<string, { scratch?: unknown }> = {}) =>
  ({ file: { team: { key }, projects } } as unknown as Workspace);

// ── FIRE_MARKERS: the union the gate consults ───────────────────────────────────────────────────
// The constant is load-bearing twice over: it is what `activeFireMarker` scans, and cli-agentops.ts's
// operator-attribution guard consumes the same list. The cross-check against env-scrub.ts is the one
// that matters — a marker added HERE but not to the test scrub union would make every fire-launched
// test run see itself as a fire, which is exactly how this suite's own AC1 arm would rot.
{
  ok([...FIRE_MARKERS].join(",") === "DEVLOOP_TEAM_SCOPE,DEVLOOP_DEV_SPLIT",
    `FIRE_MARKERS is the documented pair, in order (got: ${[...FIRE_MARKERS].join(",")})`);
  const missing = FIRE_MARKERS.filter((m) => !(FIRE_MARKER_VARS as readonly string[]).includes(m));
  ok(missing.length === 0,
    `FIRE_MARKERS ⊆ env-scrub's FIRE_MARKER_VARS — a marker the test scrub does not clear would break every in-fire test run (missing: ${missing.join(",") || "none"})`);
}

// ── activeFireMarker: the LOOP-367 gate — may a FIRE destroy at all? ────────────────────────────
{
  ok(activeFireMarker({}) === null,
    "activeFireMarker: an operator env (no marker) is NOT a fire — the gate PASSES");
  ok(activeFireMarker({ DEVLOOP_TEAM_SCOPE: "loop" }) === "DEVLOOP_TEAM_SCOPE",
    "activeFireMarker: DEVLOOP_TEAM_SCOPE names the fire — the gate REFUSES");
  ok(activeFireMarker({ DEVLOOP_DEV_SPLIT: "true" }) === "DEVLOOP_DEV_SPLIT",
    "activeFireMarker: DEVLOOP_DEV_SPLIT names the fire — the gate REFUSES");
  ok(activeFireMarker({ DEVLOOP_DEV_SPLIT: "" }) === null,
    "activeFireMarker: an EMPTY value is not a marker — an exported-but-empty var must not lock the operator out");
  // Presence, not truthiness. A fire launched with DEVLOOP_DEV_SPLIT=false is still a fire, and a
  // "helpful" boolean parse here would hand every legacy-split fire the destructive verbs.
  ok(activeFireMarker({ DEVLOOP_DEV_SPLIT: "false" }) === "DEVLOOP_DEV_SPLIT",
    "activeFireMarker: the VALUE is never parsed — DEVLOOP_DEV_SPLIT=false is still a fire (fail closed)");
  const both = activeFireMarker({ DEVLOOP_TEAM_SCOPE: "loop", DEVLOOP_DEV_SPLIT: "true" });
  ok(both !== null && (FIRE_MARKERS as readonly string[]).includes(both),
    `activeFireMarker: with both set it names one of the markers actually set (got: ${both})`);
  ok(activeFireMarker({ DEVLOOP_ACTOR: "senior-dev", DEVLOOP_PROJECT: "loop", DEVLOOP_HUB_DB: canaryPath }) === null,
    "activeFireMarker: a NON-marker DEVLOOP_* var does not trip it — the union is closed, not a prefix match");
}

// ── confirmationToken / TOKEN_PREFIX: the token names its target ────────────────────────────────
{
  ok(confirmationToken("loop") === `${TOKEN_PREFIX}loop` && TOKEN_PREFIX === "--i-understand-this-deletes-",
    "confirmationToken: prefix + key, and the prefix is the documented literal");
  ok(confirmationToken("loop") !== confirmationToken("other"),
    "confirmationToken: two targets never share a token — a runbook copy-paste cannot name another project");
}

// ── isScratchProject: CONFIG is the authority, and it fails closed ──────────────────────────────
{
  ok(isScratchProject(projectWs({ s: { scratch: true } }), "s") === true,
    "isScratchProject: scratch:true PASSES — a disposable project needs no token");
  ok(isScratchProject(projectWs({ s: {} }), "s") === false,
    "isScratchProject: a project without the flag is NOT scratch — REFUSES");
  ok(isScratchProject(projectWs({ other: { scratch: true } }), "absent") === false,
    "isScratchProject: a key absent from config (the db-only case) reads as non-scratch — fail closed");
  // `=== true`, not truthiness: config is operator-edited and JSON carries strings.
  ok(isScratchProject(projectWs({ s: { scratch: "true" } }), "s") === false,
    'isScratchProject: the STRING "true" is not the boolean — a mistyped config does not disarm the gate');
  ok(isScratchProject(projectWs({ s: { scratch: 1 } }), "s") === false,
    "isScratchProject: a truthy non-boolean does not disarm the gate either");
}

// ── isolationVerdict: the per-project gate ─────────────────────────────────────────────────────
{
  const refused = isolationVerdict(projectWs({ p: {} }), "p", ["--force"]);
  ok(refused.refusal !== null && refused.scratch === false && refused.tokenPresent === false,
    "isolationVerdict: --force alone does NOT satisfy the gate — REFUSES");
  ok(/--i-understand-this-deletes-p/.test(refused.refusal ?? "") && /--force does NOT grant this/.test(refused.refusal ?? ""),
    "isolationVerdict: the refusal names the required token AND says --force does not grant it");
  ok(refused.requiredToken === confirmationToken("p"),
    "isolationVerdict: requiredToken is confirmationToken(key) — one spelling of the token, not two");
  const allowed = isolationVerdict(projectWs({ p: {} }), "p", [confirmationToken("p")]);
  ok(allowed.refusal === null && allowed.tokenPresent === true,
    "isolationVerdict: the exact token PASSES a non-scratch target");
  ok(isolationVerdict(projectWs({ p: { scratch: true } }), "p", []).refusal === null,
    "isolationVerdict: a scratch project PASSES with no token — the gate discriminates, it is not a blanket refusal");
  ok(isolationVerdict(projectWs({ p: {}, q: {} }), "p", [confirmationToken("q")]).refusal !== null,
    "isolationVerdict: another project's token REFUSES — the token names ITS target");
  ok(isolationVerdict(projectWs({ p: {} }), "p", [`${TOKEN_PREFIX}p-and-more`, `${TOKEN_PREFIX}anything`]).refusal !== null,
    "isolationVerdict: an EXACT argv match, never startsWith — a prefix lookalike REFUSES");
}

// ── workspaceIsolationVerdict: the LOOP-316 gap — the WORKSPACE-scoped gate ─────────────────────
// Nothing unit-tested this before LOOP-381: its only coverage was through `board restore` at the CLI.
// It guards `up --bundle --force-reseed`, which overwrites dev-loop.json AND .dev-loop/secrets.env —
// every key in the workspace.
{
  const refused = workspaceIsolationVerdict(wsWs("loop"), ["--force-reseed"]);
  ok(refused.refusal !== null && refused.tokenPresent === false,
    "workspaceIsolationVerdict: --force-reseed alone does NOT satisfy the gate — REFUSES");
  ok(refused.requiredToken === confirmationToken("loop") && /--i-understand-this-deletes-loop/.test(refused.refusal ?? ""),
    "workspaceIsolationVerdict: the token names the WORKSPACE key, and the refusal prints it");
  ok(/secrets\.env/.test(refused.refusal ?? "") && /dev-loop\.json/.test(refused.refusal ?? ""),
    "workspaceIsolationVerdict: the refusal names BOTH stores it would destroy");
  ok(/Nothing has been written/.test(refused.refusal ?? ""),
    "workspaceIsolationVerdict: the refusal states that nothing was written — the operator needs the state, not just the no");
  const allowed = workspaceIsolationVerdict(wsWs("loop"), ["--force-reseed", confirmationToken("loop")]);
  ok(allowed.refusal === null && allowed.tokenPresent === true,
    "workspaceIsolationVerdict: the exact workspace token PASSES");
  // The fail-safe the docstring claims: a workspace has no `scratch` concept, so a scratch PROJECT
  // sharing the workspace's key must not suppress the workspace-level gate.
  const scratchNamesake = workspaceIsolationVerdict(wsWs("loop", { loop: { scratch: true } }), ["--force-reseed"]);
  ok(scratchNamesake.refusal !== null && scratchNamesake.scratch === false,
    "workspaceIsolationVerdict: a scratch PROJECT of the same key does not disarm the WORKSPACE gate — always token-gated");
  ok(workspaceIsolationVerdict(wsWs("team-key", { proj: {} }), [confirmationToken("proj")]).refusal !== null,
    "workspaceIsolationVerdict: a PROJECT token REFUSES — workspace key and project key are different keys");
  ok(workspaceIsolationVerdict(wsWs("loop"), [`${TOKEN_PREFIX}loop-and-more`]).refusal !== null,
    "workspaceIsolationVerdict: exact argv match here too — a prefix lookalike REFUSES");
}

// ── AC2 coverage map: every runtime export is imported AND exercised by some suite ──────────────
//
// The inventory is parsed from the module rather than listed by hand, so a NEW export that nobody
// tested fails this arm instead of passing unnoticed. The expected-set assertion above the loop is
// what keeps the loop from passing vacuously if the parse ever breaks and yields nothing.
//
// Two ways that guarantee can hold on paper and be green anyway — both closed here, because an
// assertion that cannot discriminate is worse than no assertion (PR #271 review):
//   1. An export written in a form the parse does not recognize (`export async function`,
//      `export class`, `export let`, `export { name }`, `export * from`) would be MISSING from the
//      inventory, and the unchanged expected list would still match. So every `export` line is
//      CLASSIFIED, and one that matches no known form FAILS this arm rather than being skipped.
//   2. "Exercised" measured by a raw word search counts a name that survives only in a comment or
//      an assertion label — deleting every real call to `activeFireMarker` would leave this map
//      green off the section comments alone. So each suite is reduced to its EXECUTABLE text first
//      (`codeOnly` below), and that reduction is itself asserted.
{
  const src = readFileSync(join(hubRoot, "src", "destructive-guard.ts"), "utf8");

  // Every `export` line is classified into: type-only (no runtime value to exercise), a declaration
  // whose name we capture, a named re-export list, or UNREADABLE — which fails.
  const TYPE_ONLY = /^export\s+(?:type|interface)\b/;
  const DECLARED = /^export\s+(?:async\s+)?(?:(function)\s*\*?|const|let|var|class)\s+(\w+)/;
  const NAMED_LIST = /^export\s*\{([^}]*)\}/;
  // The KIND is captured with the name, because what counts as exercising an export depends on it
  // (PR #271 review, third round): a function is exercised by being CALLED, a constant by being
  // READ. So the kind must survive every export FORM, not just the declaration form — a name
  // re-exported as `export { activeFireMarker }` carries no kind on its own line, and defaulting it
  // to "not callable" would silently drop it to the weaker read rule, where `const f = <name>`
  // counts and no suite need ever call it (PR #271 review, fourth round). The kind is therefore
  // resolved from the LOCAL declaration the list names; a spec whose local declaration this file
  // cannot find is UNREADABLE and fails the arm, rather than being guessed at.
  const LOCAL_CALLABLE = (local: string) =>
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s+${local}\\b|class\\s+${local}\\b` +
      `|(?:const|let|var)\\s+${local}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\(|[\\w$]+\\s*=>))`, "m");
  const LOCAL_VALUE = (local: string) =>
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s+${local}\\b|class\\s+${local}\\b` +
      `|(?:const|let|var)\\s+${local}\\b)`, "m");
  const classifyExports = (source: string) => {
    const runtime: Array<{ name: string; callable: boolean }> = [];
    const unreadable: string[] = [];
    for (const line of source.split("\n")) {
      if (!/^export\b/.test(line)) continue;
      if (TYPE_ONLY.test(line)) continue;
      const declared = DECLARED.exec(line);
      if (declared) { runtime.push({ name: declared[2], callable: declared[1] === "function" }); continue; }
      const list = NAMED_LIST.exec(line);
      if (list) {
        for (const spec of list[1].split(",")) {
          const s = spec.trim();
          if (!s || /^type\b/.test(s)) continue;
          const parts = s.split(/\s+as\s+/);     // a suite imports the EXPORTED name, not the local one
          const local = parts[0]!.trim();
          const name = (parts[1] ?? parts[0]).trim();
          if (!LOCAL_VALUE(local).test(source)) { unreadable.push(`${line.trim()} (no local declaration of ${local})`); continue; }
          runtime.push({ name, callable: LOCAL_CALLABLE(local).test(source) });
        }
        continue;
      }
      unreadable.push(line.trim());
    }
    return { runtime, unreadable };
  };

  // The list branch is unreachable from today's module — every export there is a declaration — so
  // it is asserted on synthetic sources, which is precisely why its defect survived three review
  // rounds. Each probe pins ONE decision: the kind is read from the local declaration, and an
  // unresolvable local fails rather than defaulting.
  for (const [source, want, why] of [
    ["function activeFireMarker() {}\nexport { activeFireMarker };",
      { name: "activeFireMarker", callable: true }, "a named-exported function is still exercised only by a CALL"],
    ["const arrow = (x) => x;\nexport { arrow };",
      { name: "arrow", callable: true }, "…including one declared as an arrow"],
    ["const TOKEN_PREFIX = \"--x-\";\nexport { TOKEN_PREFIX };",
      { name: "TOKEN_PREFIX", callable: false }, "while a named-exported constant keeps the read rule"],
    ["function local() {}\nexport { local as renamed };",
      { name: "renamed", callable: true }, "a rename exports the new name and the old name's kind"],
  ] as const) {
    const got = classifyExports(source);
    ok(got.unreadable.length === 0 && got.runtime.length === 1
      && got.runtime[0]!.name === want.name && got.runtime[0]!.callable === want.callable,
      `coverage map: ${JSON.stringify(want)} — ${why} (got: ${JSON.stringify(got.runtime)}${got.unreadable.length ? ` unreadable: ${got.unreadable.join(" | ")}` : ""})`);
  }
  ok(classifyExports("export { mystery };").unreadable.length === 1,
    "coverage map: a named export whose local declaration is not in the module is UNREADABLE — an unresolvable kind fails the arm instead of defaulting to the weaker rule");

  const { runtime, unreadable } = classifyExports(src);
  ok(unreadable.length === 0,
    `coverage map: every export line is a form this inventory can read — extend the classifier before adding one it cannot (unreadable: ${unreadable.join(" | ") || "none"})`);

  const runtimeExports = runtime.map((e) => e.name).sort();
  const callableExport = new Map(runtime.map((e) => [e.name, e.callable]));
  const expected = [
    "FIRE_MARKERS", "TOKEN_PREFIX", "activeFireMarker", "commitBothHalves",
    "confirmationToken", "isScratchProject", "isolationVerdict", "workspaceIsolationVerdict",
  ];
  ok(runtimeExports.join(",") === expected.join(","),
    `coverage map: the module's runtime exports are the known set — a new export must be added here WITH a test (got: ${runtimeExports.join(",")})`);

  // The reduction that makes this map honest lives in ./code-only.ts — one implementation, because
  // LOOP-396's consumer inventory asks the source tree the same question and a second copy is a
  // second thing to get wrong. The probe arms below stayed here: they assert the shared scrub, and
  // they belong beside the claim it protects.

  // The reduction is asserted, not trusted: this map's honesty rests entirely on it. Every name
  // below appears in THIS file only inside these probe literals, so the arms are independent of the
  // suite's own coverage — the scrub drops them here and the real call sites above are what count.
  const probe = codeOnly([
    "// activeFireMarker, in a line comment",
    "/* isolationVerdict, in a block comment */",
    'ok(x, "confirmationToken, in an assertion label");',
    "const s = `prose isScratchProject ${commitBothHalves(p)} more prose`;",
    "const re = /FIRE_MARKERS[/x]\\/TOKEN_PREFIX/g;",
    "const half = total / notARegexRead / 2;",
  ].join("\n"));
  // FIRE_MARKERS sits inside the pattern's character class and TOKEN_PREFIX behind an escaped
  // slash, so between them they pin both ways the scanner could end the literal early and hand the
  // rest of the pattern back as code.
  for (const prose of ["activeFireMarker", "isolationVerdict", "confirmationToken", "isScratchProject", "FIRE_MARKERS", "TOKEN_PREFIX"]) {
    ok(!new RegExp(`\\b${prose}\\b`).test(probe),
      `coverage map: the scrub drops ${prose} when it survives only in prose or a regex PATTERN — neither touches the binding, so a deleted arm cannot read as coverage`);
  }
  for (const code of ["commitBothHalves", "ok", "re", "notARegexRead"]) {
    ok(new RegExp(`\\b${code}\\b`).test(probe),
      `coverage map: the scrub keeps ${code} — a template substitution, a call, and an identifier BETWEEN two division operators are executable references`);
  }
  // The other half of "exercised", which no scrub can decide: a TYPE-ONLY import is erased before
  // anything runs, so it is not coverage however the name is then mentioned. Asserted on the
  // predicate itself, since no suite in the tree imports this module that way today — which is
  // exactly why it would have gone unnoticed.
  const importsAsValue = (text: string): boolean =>
    /import\s*\{([^}]*)\}\s*from\s*"\.\.\/src\/destructive-guard\.ts"/.test(text);
  ok(!importsAsValue('import type { commitBothHalves } from "../src/destructive-guard.ts";\ntype T = typeof commitBothHalves;\n'),
    "coverage map: a type-only import is NOT coverage — it is erased before anything runs");
  ok(importsAsValue('import { commitBothHalves } from "../src/destructive-guard.ts";\ncommitBothHalves(p);\n'),
    "coverage map: …while a value import still is");

  // A VALUE import only — `import type { … }` is erased before anything runs, so a suite that
  // imports a name that way and mentions it in a type position (`typeof commitBothHalves`) has not
  // exercised it. The scrub cannot catch that, because a type annotation IS code; the fix has to be
  // here, at what counts as an import (PR #271 review, second round). Inline `{ type X, y }`
  // specifiers are dropped for the same reason.
  // What counts as EXERCISING an imported name, after the scrub and the value-import rule have both
  // had their say (PR #271 review, third round). A word search cannot answer it: a value import
  // followed by `type T = typeof commitBothHalves` or a bare `void commitBothHalves` leaves the
  // identifier standing in executable text, so deleting the last real test arm would leave this map
  // green — the same "assertion that cannot discriminate" this block exists to prevent, one level up.
  //   • a FUNCTION is exercised by being CALLED — the name in call position;
  //   • a CONSTANT has no call form, so it is exercised by being READ — any reference that is not a
  //     type query (`typeof X`) or a discarded one (`void X`).
  // Both rules are asserted on synthetic inputs below, since no suite in the tree is written this
  // way today — which is exactly why it would have gone unnoticed.
  const exercises = (body: string, name: string, callable: boolean): boolean => {
    if (callable) return new RegExp(`\\b${name}\\s*\\(`).test(body);
    for (const m of body.matchAll(new RegExp(`(?:\\b(typeof|void)\\s+)?\\b${name}\\b`, "g")))
      if (!m[1]) return true;
    return false;
  };
  for (const [body, name, callable, want, why] of [
    ["type T = typeof commitBothHalves;", "commitBothHalves", true, false, "a type query is erased before anything runs"],
    ["void commitBothHalves;", "commitBothHalves", true, false, "a discarded reference calls nothing"],
    ["commitBothHalves(p);", "commitBothHalves", true, true, "…while a call is the exercise"],
    ["type T = typeof TOKEN_PREFIX;", "TOKEN_PREFIX", false, false, "a constant in a type query is erased too"],
    ["const s = TOKEN_PREFIX + k;", "TOKEN_PREFIX", false, true, "…while reading it is the only exercise a constant has"],
  ] as const) {
    ok(exercises(body, name, callable) === want,
      `coverage map: ${JSON.stringify(body)} ${want ? "exercises" : "does NOT exercise"} ${name} — ${why}`);
  }

  const importRe = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/src\/destructive-guard\.ts"/;
  const suites = readdirSync(join(hubRoot, "test")).filter((f) => f.endsWith(".ts") && f !== "run-all.ts");
  const coverage = new Map<string, string[]>();
  for (const file of suites) {
    const text = readFileSync(join(hubRoot, "test", file), "utf8");
    const m = importRe.exec(text);
    if (!m) continue;                          // a file that only MENTIONS the module is not coverage
    const imported = m[1].split(",").map((s) => s.trim()).filter((s) => s && !/^type\b/.test(s))
      .map((s) => s.split(/\s+as\s+/)[0]!).filter(Boolean);
    const body = codeOnly(text.replace(m[0], ""));   // the import itself must not count as a use
    for (const name of imported) {
      if (!exercises(body, name, callableExport.get(name) ?? false)) continue;
      coverage.set(name, [...(coverage.get(name) ?? []), file]);
    }
  }
  for (const name of expected) {
    const where = coverage.get(name) ?? [];
    ok(where.length > 0, `coverage map: ${name} is imported and exercised by a suite (${where.join(", ") || "NOTHING"})`);
  }

  // writeConfigAtomic MOVED to src/atomic-write.ts: three config writers outside this module needed the
  // same guarantee (team-edit's `team set`/`add-project`/`add-repo`, team-init, team-import), and a
  // shared guarantee cannot live behind one module's private helper. The old note here said that if it
  // were ever exported "the direct test becomes due" — it is now due and it exists. This module's own
  // export surface is unchanged: it imports the helper and does not re-export it, so the inventory arm
  // above still holds.
  ok(!/function writeConfigAtomic\(/m.test(src) && /import \{ writeConfigAtomic \} from "\.\/atomic-write\.ts"/.test(src),
    "coverage map: writeConfigAtomic lives in atomic-write.ts and is imported here, neither defined nor re-exported");
  const atomicSuite = readFileSync(join(hubRoot, "test", "atomic-write.ts"), "utf8");
  ok(/writeConfigAtomic/.test(atomicSuite) && /tmp/.test(atomicSuite),
    "coverage map: …and the direct unit test its move made due exists in test/atomic-write.ts");
  const commitSuite = readFileSync(join(hubRoot, "test", "destructive-commit.ts"), "utf8");
  ok(/no \.tmp- residue/.test(commitSuite) && /byte-complete on disk \(rename, not a partial write\)/.test(commitSuite),
    "coverage map: writeConfigAtomic's tmp+rename contract IS asserted — the atomic-write and residue arms in destructive-commit.ts");
  ok(/the config is restored byte-for-byte, with no lossy UTF-8 substitution/.test(commitSuite),
    "coverage map: writeConfigAtomic's byte-exact restore path is asserted in destructive-commit.ts");
  // AC3's five commitBothHalves paths live there too — named, so a verifier can check the claim
  // instead of trusting this comment.
  for (const [label, probe] of [
    ["config-only", /config-only: the config half applies with no db present/],
    ["db-only", /db-only: the db half committed/],
    ["both-succeed", /happy: db half applied and COMMITted/],
    ["compensation-succeeds", /the config half is restored to its original bytes/],
    ["compensation-fails", /manual recovery is required/],
  ] as const) {
    ok(probe.test(commitSuite), `coverage map: commitBothHalves' ${label} path is asserted in destructive-commit.ts (AC3)`);
  }
}

// ── AC1 tripwire, read back ────────────────────────────────────────────────────────────────────
// stat FIRST, then count: re-opening the canary to count is this suite's own access, and taking the
// mtime after it would measure the measurement.
{
  const size = statSync(canaryPath).size;
  const mtimeMs = statSync(canaryPath).mtimeMs;
  const rows = canaryRows();
  ok(process.env.DEVLOOP_HUB_DB === canaryPath,
    "AC1: $DEVLOOP_HUB_DB still points at the canary — no arm re-pointed it at a real board");
  ok(rows === canaryBefore.rows, `AC1: the canary db still holds every row (${canaryBefore.rows} before, ${rows} after)`);
  ok(size === canaryBefore.size, `AC1: the canary db's size is unchanged (${canaryBefore.size} → ${size})`);
  ok(mtimeMs === canaryBefore.mtimeMs, "AC1: the canary db's mtime is unchanged — nothing under test opened it for writing");
  ok(canaryPath.startsWith(tmp) && tmp.startsWith(realpathSync(tmpdir())),
    "AC1: every path this suite created lives under its own mkdtemp dir, never under the real workspace");
}

rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? "\nDESTRUCTIVE_GUARD_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
