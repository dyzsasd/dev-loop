// `In Progress → In Review` requires a COMMIT to exist (LOOP-309).
//
// A single junior-dev fire moved two tickets to In Review having committed nothing at all. Both
// diffs were correct — they were simply still sitting uncommitted in the shared main checkout:
//
//   ticket    | handed off              | branch | commit | PR   | where the code actually was
//   ----------|-------------------------|--------|--------|------|-----------------------------
//   LOOP-31   | 13:01:21Z → In Review   | none   | none   | none | uncommitted in the shared tree
//   LOOP-294  | 13:05:12Z → In Review   | none   | none   | none | uncommitted in the same tree
//
// That is what makes it a process defect rather than a code defect: nothing in the pipeline
// distinguished "built and shipped" from "built and left in the working tree". The increment reached
// the owner's verify queue looking exactly like a shipped one, and the tree was one `git checkout`
// from destroying it (LOOP-312) and one `git add -A` from landing it inside an unrelated commit
// (LOOP-320).
//
// WHY LOCAL GIT ONLY, and why this does not go through landing.ts:
//
// A commit is a LOCAL fact; a PR is a FORGE fact. `git log --all --grep=<id>` answers offline,
// deterministically, with no network and no `gh`. LOOP-274 documents the opposite hazard —
// `annotateTicketLanding` reporting a forge outage as `no-pr` — so a gate keyed on PR EXISTENCE
// would refuse every handoff whenever `gh` is unreachable. `landing.ts` is the forge-side reader and
// this must not route through it. The `dev-loop queue` landing annotation stays exactly as it is:
// advisory, and accurate for the forge-outage case LOOP-274 owns.
import { execFileSync } from "node:child_process";

/**
 * Does any LOCAL ref carry work for this ticket?
 *
 * Two independent witnesses, either of which is sufficient:
 *   • a commit message referencing the id, reachable from ANY local ref (`--all` covers the ticket's
 *     own branch, main, and any worktree branch — a dev-tier fire ships from a per-ticket worktree,
 *     whose branch is a local ref of the same repository);
 *   • a branch whose NAME carries the id (`dev-loop/<id>`), which covers the case where the commit
 *     message did not name the ticket but the branch does.
 *
 * `--fixed-strings` matters: ids are `PREFIX-123`, and a bare `-` is harmless but a regex-special id
 * prefix would not be. Never a network call.
 */
export function hasLocalWorkFor(repoRoot: string, ticketId: string): boolean {
  const git = (args: string[]): string => execFileSync("git", ["-C", repoRoot, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    if (git(["log", "--all", "--fixed-strings", `--grep=${ticketId}`, "--format=%H", "-1"]).trim()) return true;
  } catch { /* fall through to the branch witness */ }
  try {
    if (git(["branch", "--all", "--list", `*${ticketId}*`, "--format=%(refname)"]).trim()) return true;
  } catch { /* fall through */ }
  return false;
}

export interface HandoffGateInput {
  id: string;
  fromState: string;
  toState: string;
  actor: string;
  repoRoot?: string;               // absent ⇒ nothing to check against; the gate stays silent
  landing?: "pr" | "direct";
  /**
   * LOOP-360 — this ticket is a §21a DESIGN PARENT, so the commit witness below can never exist.
   *
   * The caller resolves it (this module stays db-free) through the ONE shared predicate in
   * design-parent.ts that `opQueue` and the `In Review → Done` gate already use — never a second
   * copy of the rule, which is the defect LOOP-344 exists to prevent.
   */
  isDesignParent?: boolean;
}

/**
 * The refusal string, or null.
 *
 * Scope is deliberately narrow. Only `landing: "pr"` repos are gated: under `direct` there is no
 * intermediate artifact to require, so a refusal there would be inventing a rule the config does not
 * imply. The operator is never gated — the console reopens and re-routes tickets by hand.
 *
 * LOOP-360 — a DESIGN PARENT is exempt, and the exemption keys on what the ticket IS, never on the
 * absence of a commit. A design parent's verified increment is the design doc plus the staged
 * children (§21a); on `backend:"service"` that doc lives in the hub db, not the repo, so no commit
 * or branch can reference the id however correctly the work was done. Exempting "has no commit"
 * instead would readmit LOOP-31 and LOOP-294 — the two zero-commit handoffs this gate exists to
 * catch — so a junior code ticket with nothing committed is still refused.
 */
export function handoffGateRejection(inp: HandoffGateInput): string | null {
  if (inp.fromState !== "In Progress" || inp.toState !== "In Review") return null;
  if (inp.landing !== "pr") return null;
  if (inp.actor === "operator") return null;
  if (inp.isDesignParent) return null;
  if (!inp.repoRoot) return null;
  if (hasLocalWorkFor(inp.repoRoot, inp.id)) return null;
  return `verify gate: In Progress → In Review blocked — no commit or branch in ${inp.repoRoot} references ${inp.id}, so there is nothing to review. `
    + `The work is still uncommitted in the working tree, where another fire's \`git checkout\` discards it silently and a \`git add -A\` lands it under someone else's ticket. `
    + `Commit it on a branch first (\`git checkout -b dev-loop/${inp.id}\`, then commit naming ${inp.id}), then hand off. `
    + `This check reads LOCAL git only — it does not require \`gh\`, a PR, or a network.`;
}
