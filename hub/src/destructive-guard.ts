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
