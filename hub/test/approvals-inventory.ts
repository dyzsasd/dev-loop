// LOOP-396 — approvals C5: the consumer inventory the build checks.
// Design: hubDoc:design/approvals §7 (the two consumer classes) + §10 (this suite). Parent LOOP-383.
//
// WHAT THIS SUITE IS FOR, since a reader could mistake it for bookkeeping.
// Design §7 names six ENFORCING consumers. That is a claim about a SET, and STANDING RULE 28 says a
// module's claim about a set is enforced by a test that derives the set from the source, or by
// nothing. `destructive-guard.ts` is the standing evidence: it claimed every destructive verb called
// in, incident falsified the claim twice (LOOP-305, LOOP-367), and each repair added exactly one call
// site — the prose was wrong for as long as nobody re-read it. `approvals.ts` makes the same shape of
// claim, so it gets the same treatment on its first day.
//
// THE ONE PROPERTY THAT MAKES THIS NON-VACUOUS: the comparison is a SET EQUALITY, so it fails in both
// directions. A new `consultApproval` call site with no inventory entry fails (the decay this exists
// to catch), and an inventory entry whose call site was deleted fails too (the claim outliving the
// code). A one-directional "every entry is real" check would go green the day someone wires up a
// seventh consumer and forgets the list — which is precisely the incident being prevented.
//
// AND THE PROPERTY THAT MAKES THE DERIVATION HONEST: a raw word search for `consultApproval` matches
// the ten times this module's own comments discuss it, so deleting every real call would leave this
// suite green off prose alone. Every file is therefore reduced to its EXECUTABLE text first
// (`codeOnly`, the same reduction destructive-guard.ts's coverage map runs — one implementation,
// extracted to ./code-only.ts by this ticket), and the reduction's discrimination is probed below
// rather than trusted.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_CLASSES, CONSUMER_INVENTORY, type ConsumerInventoryEntry } from "../src/approvals.ts";
import { codeOnly } from "./code-only.ts";

const hubRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(hubRoot, "src");

let fails = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) console.log(`  ok  ${label}`);
  else { fails++; console.log(`  FAIL ${label}`); }
};

// ─── The derivation ───────────────────────────────────────────────────────────────────────────────

/** Every `.ts` file under hub/src, path relative to hub/src (POSIX-separated, so it reads as written). */
const srcFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (e.name.endsWith(".ts")) out.push(relative(srcRoot, p).split(sep).join("/"));
  }
  return out.sort();
};

/**
 * A CALL, not a mention: the identifier followed by `(` in text that runs. `import { consultApproval }`
 * carries no paren and is correctly not a call — importing the function is not consulting the record.
 */
const CALLS = /\bconsultApproval\s*\(/;
/** The declaration, which is the same shape as a call and must never be counted as one. */
const DECLARES = /\bexport\s+function\s+consultApproval\s*\(/;

const files = srcFiles(srcRoot);
const executable = new Map(files.map((f) => [f, codeOnly(readFileSync(join(srcRoot, f), "utf8"))]));

// Which file DECLARES consultApproval is derived, not assumed. The declaring module is excluded from
// the consumer set below — it is the record, not a consumer of it, and `coverageQuery` calling its own
// core is not a seventh enforcing verb. Hard-coding that exclusion by filename would silently keep
// excluding `approvals.ts` on the day the function moves elsewhere, so the exclusion follows the
// declaration and the declaration is asserted to be unique.
const declaringFiles = files.filter((f) => DECLARES.test(executable.get(f)!));
const callSites = files.filter((f) => CALLS.test(executable.get(f)!) && !declaringFiles.includes(f));

const migrated = CONSUMER_INVENTORY.filter((c) => c.status === "migrated");
const residual = CONSUMER_INVENTORY.filter((c) => c.status === "residual");
const sorted = (xs: readonly string[]): string => [...xs].sort().join(", ");

console.log("approvals-inventory");

// ─── Preconditions: a derivation that read nothing must not read as agreement ──────────────────────
{
  ok(files.length > 50, `scan: hub/src yields a plausible file count (got ${files.length})`);
  ok(declaringFiles.length === 1 && declaringFiles[0] === "approvals.ts",
    `scan: exactly one module declares consultApproval, and it is approvals.ts (got: ${sorted(declaringFiles)}) — the consumer-set exclusion follows this, so a split module fails here instead of quietly dropping a call site`);
  ok(CONSUMER_INVENTORY.length > 0 && migrated.length > 0,
    `inventory: non-empty, with at least one migrated entry (${migrated.length} migrated, ${residual.length} residual) — an all-residual list would make AC2's equality trivially true`);
}

// ─── The reduction discriminates — probed, not trusted ────────────────────────────────────────────
{
  const prose = codeOnly([
    "// consultApproval(db, key, now) — in a line comment",
    "/* consultApproval(db, key, now) — in a block comment */",
    'const msg = "consultApproval(db, key, now) in a string";',
    "const t = `prose consultApproval(db, key, now) more prose`;",
  ].join("\n"));
  ok(!CALLS.test(prose),
    "detector: a call written only in a comment, a string or template prose is NOT a call site — without this, deleting every real consult would still read as coverage");

  ok(CALLS.test(codeOnly("v = consultApproval(conn, key, now, { record: false });")),
    "detector: …while a real call IS one");
  ok(!CALLS.test(codeOnly('import { listApprovals, consultApproval, actionClasses } from "./approvals.ts";')),
    "detector: importing the name is not consulting the record");
  ok(DECLARES.test(codeOnly("export function consultApproval(\n  db: DatabaseSync,\n): Verdict {")),
    "detector: the declaration is recognised as a declaration — it has a call's shape and must not be counted as one");
}

// ─── AC1 — the declared inventory is well-formed ──────────────────────────────────────────────────
{
  const names = CONSUMER_INVENTORY.map((c) => c.consumer);
  ok(new Set(names).size === names.length, "AC1 consumer names are unique");
  const declaredFiles = CONSUMER_INVENTORY.map((c) => c.file);
  ok(new Set(declaredFiles).size === declaredFiles.length, "AC1 one entry per source file");

  for (const c of CONSUMER_INVENTORY) {
    let exists = false;
    try { exists = statSync(join(srcRoot, c.file)).isFile(); } catch { exists = false; }
    ok(exists, `AC1 ${c.consumer}: its source file hub/src/${c.file} exists`);
    ok(c.note.trim().length > 0, `AC1 ${c.consumer}: carries a note saying what the approval would authorise`);
  }

  for (const c of CONSUMER_INVENTORY) {
    if (c.actionClass !== null) {
      ok(Object.hasOwn(ACTION_CLASSES, c.actionClass),
        `AC1 ${c.consumer}: names a LEGAL action class (${c.actionClass}) — an entry may not invent a key grammar`);
    }
  }
  // A migrated consumer consults a key, so it has a class by construction. A residual may legitimately
  // have none — that is the finding that its end state is not yet nameable (design §4), not a blank.
  for (const c of migrated) {
    ok(c.actionClass !== null,
      `AC1 ${c.consumer}: a migrated consumer names its action class — it consults a key, so a null would be a false blank`);
  }
}

// ─── AC2 — the migrated set IS the derived set of call sites, both directions ──────────────────────
{
  const declared = migrated.map((c) => c.file);
  ok(sorted(callSites) === sorted(declared),
    `AC2 the derived consultApproval call sites equal the migrated entries — derived: [${sorted(callSites)}] · declared: [${sorted(declared)}]`);

  for (const f of callSites) {
    ok(declared.includes(f),
      `AC2 hub/src/${f} consults approvals and has an inventory entry — a new consumer without one fails HERE, which is the decay this suite exists to stop`);
  }
  for (const c of migrated) {
    ok(callSites.includes(c.file),
      `AC2 ${c.consumer} (hub/src/${c.file}) is declared migrated and really does call consultApproval — a claim outliving its code fails too`);
  }
}

// ─── AC3 — every residual names a real, currently-unmigrated verb ─────────────────────────────────
{
  for (const c of residual) {
    const text = executable.get(c.file);
    ok(text !== undefined,
      `AC3 ${c.consumer}: hub/src/${c.file} is a real source file under hub/src — a residual naming a deleted file is a stale list`);
    if (text !== undefined) {
      ok(!CALLS.test(text),
        `AC3 ${c.consumer}: hub/src/${c.file} still does NOT consult approvals — a residual that was quietly migrated must move to the migrated set, not sit here`);
    }
  }
}

// ─── AC4 — the residual set at this ticket's close ────────────────────────────────────────────────
{
  // Design §7's six enforcing consumers minus the one C4 migrated. Pinned by FILE, because the file is
  // what AC2/AC3 derive against; the consumer prose is checked alongside so a rename cannot silently
  // repoint an entry at a different verb.
  const expected: readonly { consumer: string; file: string }[] = [
    { consumer: "reopen (terminal-state guard)", file: "ticketwrite.ts" },
    { consumer: "board restore", file: "board.ts" },
    { consumer: "team remove-project", file: "team-edit.ts" },
    { consumer: "team repair --reap", file: "team-repair.ts" },
    { consumer: "up --bundle --force-reseed", file: "bundle.ts" },
  ];
  const shape = (xs: readonly { consumer: string; file: string }[]): string =>
    [...xs].map((c) => `${c.consumer}=${c.file}`).sort().join(" | ");
  ok(shape(residual as readonly ConsumerInventoryEntry[]) === shape(expected),
    `AC4 the residual set is exactly design §7's five unmigrated enforcing consumers — got: ${shape(residual as readonly ConsumerInventoryEntry[])}`);
  ok(migrated.length + residual.length === 6,
    `AC4 six enforcing consumers in total, matching design §7 (got ${migrated.length + residual.length})`);
}

console.log(fails === 0 ? "\nAPPROVALS_INVENTORY_OK" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
