// destructive-guard.ts — the isolation gate every destructive verb calls before it destroys operator data.
//
// LOOP-305 (LOOP-302 ①). On 2026-08-04 `dev-loop team remove-project loop --dry-run --force` cascade-deleted
// 301 tickets from the LIVE workspace. The recoverability guard had refused twice in the preceding 22 seconds
// ("project 'loop' has 301 ticket(s) — pass --force to remove anyway"), and `--force` was then added precisely
// because it READS as the switch that gets past a prompt. It is not: `--force` means "override the
// ticket/repo recoverability guard", which answers a different question ("is this recoverable?") than the one
// nobody was asked ("did you mean THIS workspace's THIS project?").
//
// This module owns that second question, and it is a MODULE rather than a check inside `removeProject`
// deliberately: 需要的是机制而非个案修补. A guard implemented at one call site leaves the next destructive verb
// exactly as exposed as `remove-project` was. Every verb that destroys operator data calls in here.
//
// The gate is an ISOLATION gate, not a refusal: a project the operator has marked disposable
// (`scratch: true`) passes with no token at all. That discriminator is the point — a gate that refused
// everything would be turned off within a week.
//
// Scope note: the recoverability guard (`--force` over ticket/repo counts) keeps its current meaning and this
// module never widens it. The two gates compose; `--force` must never become the token.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Workspace } from "./team-config.ts";

// The token's prefix, exported so the ONE place that must recognise a token-shaped argument naming the WRONG
// project (an argv loop, which cannot use `confirmationToken(key)` for that test) shares this definition
// instead of re-spelling the literal. A second copy of this string in a caller is exactly the drift this
// module exists to prevent.
export const TOKEN_PREFIX = "--i-understand-this-deletes-";

export interface IsolationVerdict {
  scratch: boolean;         // target is marked scratch:true in config
  requiredToken: string;    // `--i-understand-this-deletes-<key>`
  tokenPresent: boolean;    // the caller passed exactly that token
  refusal: string | null;   // null ⇒ the gate allows it; else the operator-facing reason
}

// The token embeds the target key, so it cannot be copy-pasted from a runbook onto a different project and
// cannot be reached by adding one more generic flag — the two ways `--force` was reached for.
export function confirmationToken(key: string): string {
  return `${TOKEN_PREFIX}${key}`;
}

// CONFIG is the authority, and nothing else is consulted. This is a decision, not an oversight:
//
//  - `scratch` already exists as a per-project config field (team-config.ts, validated E08, suppresses W01,
//    set by `team add-project --scratch`) and is already the sole predicate for `team repair`'s project reap.
//    It is this codebase's existing name for "a disposable project", so the gate consumes it rather than
//    inventing a workspace-level twin that could disagree with it.
//  - The hub.db `settings_json.scratch` mirror is deliberately NOT consulted. A key present in hub.db but
//    absent from config (the db-only case) therefore reads as NON-scratch ⇒ token required. That is fail
//    closed, and it is the correct default for a target whose config record someone has already removed.
export function isScratchProject(ws: Workspace, key: string): boolean {
  return ws.file.projects?.[key]?.scratch === true;
}

// The parenthetical below is not decoration. `--force` was reached for BECAUSE it read as the general
// override, so the refusal has to say, at the moment of refusal, that it is not one.
function refusalFor(key: string): string {
  return `project '${key}' is not marked scratch — a destructive verb on a real project requires the
naming token: pass ${confirmationToken(key)}. (--force does NOT grant this; it only
overrides the ticket/repo recoverability guard, which is a different question.)`;
}

// The verdict as DATA, so a `--dry-run` preview can report the same decision the live path enforces instead
// of re-deriving it (LOOP-290's rule: the preview derives from the same facts the live guard consumes).
//
// `tokenPresent` is an EXACT match against argv — never `startsWith(TOKEN_PREFIX)`, which would let
// `--i-understand-this-deletes-anything` name any project at all and reopen the whole hole.
export function isolationVerdict(ws: Workspace, key: string, argv: readonly string[]): IsolationVerdict {
  const scratch = isScratchProject(ws, key);
  const requiredToken = confirmationToken(key);
  const tokenPresent = argv.includes(requiredToken);
  return {
    scratch,
    requiredToken,
    tokenPresent,
    refusal: scratch || tokenPresent ? null : refusalFor(key),
  };
}

// ── The two halves commit together (LOOP-306, LOOP-302 ②) ──────────────────────────────────────
//
// A destructive verb that removes a project writes TWO stores: the config file and hub.db. Before this,
// each half ran independently and printed its OWN success line, so a failure in either left the other
// applied and already announced — in the incident the CLI reported `removed project 'loop' from
// dev-loop.json` while the file was unchanged, and the surviving config entry is what let the next
// find-or-create re-seed an empty board and hide the wipe for two hours.
//
// WHAT THIS IS: a COMPENSATING two-phase commit, not a distributed transaction. The db half is a real
// SQLite transaction; the config half is a tmp+rename that is undone by rewriting the retained bytes. A
// `SIGKILL` (or a power loss) between the rename and the COMMIT is outside any single-process design's
// reach and WILL leave the halves disagreeing. That window is not closed here, and this comment says so
// rather than implying an atomicity that is not delivered.
//
// WHY CONFIG FIRST: the two possible residues of a half-completed removal are not equally bad.
//   - db deleted, config kept  → the next find-or-create re-seeds an empty same-key project. THIS IS THE
//                                INCIDENT: it is what hid the wipe.
//   - config deleted, db kept  → an orphaned, unreferenced db row. Benign and self-healing: nothing
//                                re-seeds (there is no config record to seed from) and re-running the
//                                verb finishes it through the existing db-only path.
// So the config write goes first and the db transaction second, and the un-closable SIGKILL window above
// lands on the benign residue. The ordering is a decision, not an accident — do not "improve" it.
export interface TwoPhase {
  configPath: string;
  configText: string | null;    // already-validated, already-serialized (null ⇒ no config half)
  db: DatabaseSync | undefined;
  dbWork: (() => void) | null;  // runs INSIDE the transaction; must not BEGIN/COMMIT/ROLLBACK itself
}

// Write `configPath` through a same-directory tmp + rename, so a reader never observes a partially
// written file. Same directory is load-bearing: `renameSync` is only atomic within one filesystem, and a
// half-written `dev-loop.json` is unloadable — it takes the whole workspace down.
//
// Takes `string | Buffer` because the COMPENSATING path restores the exact bytes it retained. Passing the
// retained Buffer straight through keeps the restore byte-exact; decoding it to a string first would round
// -trip through UTF-8 and silently substitute U+FFFD for any byte sequence that did not decode — turning a
// rollback that promises "unchanged" into a quiet corruption of the file it was rescuing.
function writeConfigAtomic(configPath: string, text: string | Buffer): void {
  const tmp = `${configPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, configPath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created, or already gone — not the failure worth reporting */ }
    throw e;
  }
}

/** Throws on failure, having restored both halves. Returns only when BOTH halves are durable. */
export function commitBothHalves(p: TwoPhase): void {
  const doConfig = p.configText !== null;
  const doDb = !!(p.db && p.dbWork);
  // 1. Retain the current bytes BEFORE anything is begun or written, so a failure to read is a failure
  //    with nothing to undo. A missing config file is a caller bug (it computed a new config from one),
  //    and it surfaces here untouched rather than as a half-applied removal.
  const priorConfig = doConfig ? readFileSync(p.configPath) : null;

  // 2. BEGIN IMMEDIATE before the config write: the write lock must be taken NOW, not on the first
  //    statement, or the lock arrives after the config file has already changed and a concurrent writer
  //    can interleave between the halves.
  if (doDb) p.db!.exec("BEGIN IMMEDIATE");

  let configWritten = false;
  try {
    if (doConfig) { writeConfigAtomic(p.configPath, p.configText!); configWritten = true; }
    if (doDb) p.dbWork!();
    if (doDb) p.db!.exec("COMMIT");
  } catch (e) {
    // Guarded: a ROLLBACK on a transaction that never began (or that SQLite already unwound) must not
    // mask the original error — that error is the one the operator needs.
    if (doDb) { try { p.db!.exec("ROLLBACK"); } catch { /* nothing to roll back */ } }
    if (configWritten) {
      try {
        writeConfigAtomic(p.configPath, priorConfig!);
      } catch (restoreErr) {
        // 7. The compensation itself failed. Report BOTH halves' actual states — never a silent success,
        //    and never a message that reports one half's outcome as if it were both.
        throw new Error(
          `destructive write left the two halves INCONSISTENT and manual recovery is required:\n` +
          `  config (${p.configPath}): WRITTEN, and the restore to its prior bytes FAILED — ${(restoreErr as Error).message}\n` +
          `  hub.db: rolled back (unchanged)\n` +
          `  original failure: ${(e as Error).message}`,
        );
      }
    }
    throw e;
  }
}
