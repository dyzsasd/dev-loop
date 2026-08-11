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
import { dirtyTrackedFiles } from "./tree-snapshot.ts"; // LOOP-544: ONE porcelain parse, never a second copy

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

// ─── LOOP-544: the increment split across two trees ─────────────────────────────────────────────
//
// LOOP-309 above asks "does a commit exist?". A fire can answer that YES and still have shipped only
// HALF its increment: the src fix committed on its worktree branch, the regression test left
// uncommitted in the shared checkout. Every gate passes, because each gate only ever looks at one
// tree. Measured live three times in 24h — LOOP-517 (src on the branch, its assertions on `main` in
// the shared tree), LOOP-539, and a co-resident pair at 06:45Z carrying two tickets' work at once.
//
// WHY IT KEEPS HAPPENING — the mechanism, pinned on this ticket (AC1) rather than guessed at:
// every fire is SPAWNED in the shared checkout. `resolveCwd()` (run-agents.ts) resolves the fire's
// cwd from `repos.<ref>.path` in config, and config names the shared checkout; it cannot name the
// worktree, because the worktree does not exist yet — the fire creates it minutes after it is
// already running, and there is no later chdir. So the shared checkout is the process cwd for the
// fire's ENTIRE lifetime: every relative path and every `git` call without `-C` lands there by
// DEFAULT, and reaching the worktree takes an absolute path on every single write. Correctness
// depends on the fire never once relaxing, which is why it hits both tiers and hits fires that had
// already created their worktree correctly.
//
// So the detection must not depend on the fire noticing (AC2) — it runs here, in the write layer's
// single choke point, on the fire's own handoff. The fire cannot reach In Review around it.

/**
 * Attribution: WHICH uncommitted tracked files in the shared checkout are THIS ticket's?
 *
 * By CONTENT, not by timing: a file is attributed when its uncommitted diff ADDS a line naming the
 * ticket id. That is the discriminator the live diagnosis used —
 * `grep -c LOOP-517 <shared>/hub/test/team-edit.ts → 4` against `<worktree>/… → 0`.
 *
 * Timing attribution was the alternative and is deliberately NOT used. The pre-fire dirty record
 * (LOOP-320) says "dirty since the RUN began", which is run-scoped, not ticket-scoped: with fires
 * running concurrently it would refuse ticket B's honest handoff because ticket A left the tree
 * dirty. Content attribution cannot make that mistake — a hunk that names LOOP-544 is LOOP-544's.
 *
 * ADDED lines only. The failure being detected is a fire WRITING its work into the wrong tree, and
 * writing is an addition; scanning removals would let "this fire deleted a stale comment mentioning
 * another ticket" refuse that other ticket's handoff.
 *
 * KNOWN LIMIT, stated rather than papered over: an uncommitted edit that never names its ticket is
 * not attributable by this axis and does not trip the gate. It is the price of zero cross-ticket
 * false refusals, and the residual is covered by W33 (the tree is dirty at all) and LOOP-320 (the
 * ship commit cannot sweep it up).
 */
export function splitTreeFiles(repoRoot: string, ticketId: string): string[] {
  const dirty = dirtyTrackedFiles(repoRoot);
  if (!dirty.length) return [];
  const out: string[] = [];
  for (const file of dirty) {
    let patch = "";
    // `--` and the explicit path keep a filename that looks like a rev from being resolved as one.
    try {
      patch = execFileSync("git", ["-C", repoRoot, "diff", "HEAD", "--", file],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch { continue; } // unreadable diff ⇒ no attribution, never a hard failure
    for (const line of patch.split("\n")) {
      // `+++ b/path` is a header, not content — a ticket id in the PATH must not attribute the file.
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      if (line.includes(ticketId)) { out.push(file); break; }
    }
  }
  return out.sort();
}

/**
 * The absolute path of the ticket's own worktree, so a refusal can name BOTH trees (AC2).
 *
 * Reads `git worktree list --porcelain`, whose records are blank-line-separated and whose branch
 * line is a full ref (`branch refs/heads/dev-loop/LOOP-544`). Returns null when the fire never made
 * one — which is itself worth saying in the refusal, since then there is no second tree to move to.
 */
export function worktreeForTicket(repoRoot: string, ticketId: string): string | null {
  let out = "";
  try {
    out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && line.includes(ticketId)) return path;
  }
  return null;
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
  if (!hasLocalWorkFor(inp.repoRoot, inp.id))
    return `verify gate: In Progress → In Review blocked — no commit or branch in ${inp.repoRoot} references ${inp.id}, so there is nothing to review. `
      + `The work is still uncommitted in the working tree, where another fire's \`git checkout\` discards it silently and a \`git add -A\` lands it under someone else's ticket. `
      + `Commit it on a branch first (\`git checkout -b dev-loop/${inp.id}\`, then commit naming ${inp.id}), then hand off. `
      + `This check reads LOCAL git only — it does not require \`gh\`, a PR, or a network.`;
  // LOOP-544 — a commit exists, so LOOP-309 is satisfied; the increment can still be HALF here.
  return splitTreeRejection(inp.repoRoot, inp.id);
}

/**
 * AC3's chosen behaviour is BLOCK, not report-and-park, and the choice is not a preference.
 *
 * The state this ticket exists to prevent is a fix reaching the owner's verify queue WITHOUT its
 * regression test while that test demonstrably exists — §15 satisfied by inspection and violated in
 * fact. A parked report would leave the ticket in In Review with the owner already verifying it,
 * which is the exact state that has to be unreachable. Blocking also keeps the module's one
 * refusal shape (LOOP-309 above already blocks this same edge for the adjacent omission).
 *
 * The refusal names BOTH trees and the files (AC2), because "your increment is split" is not
 * actionable without knowing where the halves are.
 */
function splitTreeRejection(repoRoot: string, id: string): string | null {
  const files = splitTreeFiles(repoRoot, id);
  if (!files.length) return null;
  const wt = worktreeForTicket(repoRoot, id);
  return `verify gate: In Progress → In Review blocked — ${id}'s increment is split across TWO trees. `
    + `Its commit exists, but ${files.length} tracked file(s) naming ${id} are still UNCOMMITTED in the shared checkout ${repoRoot}: ${files.join(", ")}. `
    + (wt
      ? `The ticket's own worktree is ${wt} — that is the tree its branch commits from, and these files are not in it. `
      : `No worktree for \`dev-loop/${id}\` exists in this repo, so the commit was made somewhere these edits are not. `)
    + `Handing off now sends a half increment to the owner's verify queue: the committed half becomes the PR and this half stays behind, which is how a fix ships without its regression test and every gate still passes. `
    + `Every fire is spawned with its cwd set to the shared checkout, so a relative path writes HERE by default — move each file into the worktree and commit it there (\`git -C ${wt ?? `<worktree>`} …\`), then hand off. `
    + `This check reads LOCAL git only — no \`gh\`, no PR, no network.`;
}
