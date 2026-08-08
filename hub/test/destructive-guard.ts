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
{
  const src = readFileSync(join(hubRoot, "src", "destructive-guard.ts"), "utf8");
  const runtimeExports = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]).sort();
  const expected = [
    "FIRE_MARKERS", "TOKEN_PREFIX", "activeFireMarker", "commitBothHalves",
    "confirmationToken", "isScratchProject", "isolationVerdict", "workspaceIsolationVerdict",
  ];
  ok(runtimeExports.join(",") === expected.join(","),
    `coverage map: the module's runtime exports are the known set — a new export must be added here WITH a test (got: ${runtimeExports.join(",")})`);

  const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"\.\.\/src\/destructive-guard\.ts"/;
  const suites = readdirSync(join(hubRoot, "test")).filter((f) => f.endsWith(".ts") && f !== "run-all.ts");
  const coverage = new Map<string, string[]>();
  for (const file of suites) {
    const text = readFileSync(join(hubRoot, "test", file), "utf8");
    const m = importRe.exec(text);
    if (!m) continue;                          // a file that only MENTIONS the module is not coverage
    const imported = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const body = text.replace(m[0], "");       // the import itself must not count as a use
    for (const name of imported) {
      if (!new RegExp(`\\b${name}\\b`).test(body)) continue;
      coverage.set(name, [...(coverage.get(name) ?? []), file]);
    }
  }
  for (const name of expected) {
    const where = coverage.get(name) ?? [];
    ok(where.length > 0, `coverage map: ${name} is imported and exercised by a suite (${where.join(", ") || "NOTHING"})`);
  }

  // writeConfigAtomic is NOT exported, so AC2's "direct unit test" is unreachable for it without a
  // src change this ticket's scope forbids. That is recorded as a CHECKED fact — if it is ever
  // exported, the inventory arm above fails and this one does too, and the direct test becomes due.
  ok(/^function writeConfigAtomic\(/m.test(src) && !/^export function writeConfigAtomic/m.test(src),
    "coverage map: writeConfigAtomic is module-private — its contract is reachable only through commitBothHalves");
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
