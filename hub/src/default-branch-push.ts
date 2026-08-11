// LOOP-567 — the refusal for a CODE push to the default branch of a `landing:"pr"` repo.
//
// WHY THIS EXISTS. Four commits reached `origin/main` of this `landing:"pr"` repo with no PR
// containing them (a46478f/9bea8dd/4257072 at 06:12:35Z, a5a3bfc at 07:15:09Z on 2026-08-11). The
// mechanism was not the `dev-loop push` verb and not a careless commit: the base clone's own ref
// reflogs record `merge dev-loop/<id>: Fast-forward` onto `main` followed 2–5 s later by
// `update by push`, and the junior-dev fire covering the first event says so in its own summary
// ("Recovered LOOP-459 orphan (merged to main)"). That is the §7 `landing:"direct"` MERGE-BACK
// sequence — bare `git`, run from the shared checkout during Step 0's orphan reclaim — executed in
// a repo configured `pr`. So the gap is not in the push verb; the verb was never on the path.
//
// TWO THINGS THIS MODULE IS CAREFUL ABOUT, both pinned by evidence and neither optional:
//
// 1. PLACEMENT. The refusal lives here, as a pure predicate consumed by `pushGuard`, because
//    `pushGuard` is the ONE chokepoint on the path of both mechanisms that legitimately reach the
//    default branch: `doc-land` calls it as a library immediately before its own bare
//    `git push origin <defaultBranch>`, and §7 mandates `dev-loop push-guard --strict` immediately
//    before the merge-back's `git push`. Implemented in the `push` verb instead it would catch
//    NEITHER instance while reading as fixed.
//
// 2. PREDICATE. "No PR contains the commit" does not identify the defect — `dev-loop doc-land`
//    produces exactly that shape four times a day in this repo, by design (§20 D4). Neither does
//    the reflog verb: `main@{…}: commit:` covers a doc-land landing and a code commit made directly
//    on `main` alike. The discriminator that survives all four observed cases is the PATH SET of the
//    pushed range, which is the assertion `doc-land` already makes about itself. So this module
//    asks what the range CONTAINS, never who is pushing.
//
// Lean leaf on purpose (the LOOP-481/LOOP-429 shape): no db, no git, no workspace resolution — a
// pure function over already-gathered facts, so `push-guard` (which runs on every ship) pays
// nothing for it and no consumer needs a private copy of the rule.

import { dirname, join } from "node:path";

// Resolve a project's `strategyDoc` DocRef to a repo-relative path; null for the non-file forms
// (hubDoc / linearDocument / a Linear URL string), which land through the hub, never through git.
//
// Single definition. Before LOOP-567 this existed twice — `context-bill.ts` and a private copy in
// `doc-land.ts` — and the allowlist below has to agree with `doc-land`'s step-1 assertion EXACTLY
// or the guard refuses the landing the assertion permits. Two copies of the rule that decides which
// pushes are legal is the LOOP-429 defect; both now import this one.
export function strategyDocRelPath(docRef: unknown): string | null {
  if (typeof docRef === "string") {
    if (/linear\.app\/.*\/document\//.test(docRef)) return null;
    return docRef.trim() || null;
  }
  if (docRef && typeof docRef === "object") {
    if ("hubDoc" in (docRef as object)) return null;
    if ("linearDocument" in (docRef as object)) return null;
    const p = (docRef as { path?: unknown }).path;
    if (typeof p === "string" && p.trim()) return p;
  }
  return null;
}

// The paths a default-branch push may carry: the strategy doc itself and its `strategy-archive/`
// sibling (§20 R2 rolls completed decision detail there). Mirrors `doc-land`'s step-1 allowlist —
// deliberately NOT widened: every other path is code as far as this gate is concerned.
export function docLandAllowlist(docRel: string): { docRel: string; archivePrefix: string } {
  return { docRel, archivePrefix: join(dirname(docRel), "strategy-archive") + "/" };
}

export interface DefaultBranchPushInput {
  /** The branch this push updates. */
  branch: string;
  /** The repo's resolved default branch. */
  defaultBranch: string;
  /** The repo registry's `landing` for this repo; absent ⇒ `"direct"` (§12b). */
  landing: string | undefined;
  /** Every path the pushed range touches. */
  changedPaths: string[];
  /**
   * The permitted doc paths, or null when the owning project has no repo-file strategyDoc. Null
   * means the doc-landing carve-out cannot apply, NOT that everything is permitted.
   */
  allow: { docRel: string; archivePrefix: string } | null;
}

export interface DefaultBranchPushVerdict {
  branch: string;
  landing: string;
  /** The paths that put this push outside the doc carve-out — never empty on a trip. */
  offenders: string[];
  allowed: string[];
}

// The verdict. Returns null when the push is permitted; a verdict object when it must be refused.
//
// Permitted, and each for its own reason:
//  · a push to any branch OTHER than the default branch — the whole `pr` flow is those pushes;
//  · a `direct`-mode repo — §7's merge-back is that mode's sanctioned landing (absent ⇒ `direct`);
//  · a docs-only range under `pr` — `dev-loop doc-land`, the §20 D4 path (AC3 case 3);
//  · a range that touches NOTHING. An empty path set is not evidence of a code push, and a gate
//    that refused it would refuse a no-op.
export function defaultBranchPushVerdict(inp: DefaultBranchPushInput): DefaultBranchPushVerdict | null {
  if (inp.branch !== inp.defaultBranch) return null;
  const landing = inp.landing ?? "direct";
  if (landing !== "pr") return null;
  if (!inp.changedPaths.length) return null;
  const allowed = inp.allow ? [inp.allow.docRel, `${inp.allow.archivePrefix}*`] : [];
  // No repo-file strategyDoc ⇒ no permitted path ⇒ every path is an offender. Fail CLOSED: the
  // carve-out exists for a configured doc-landing path, and a project without one has no landing
  // this gate is meant to let through.
  const offenders = inp.allow
    ? inp.changedPaths.filter((f) => f !== inp.allow!.docRel && !f.startsWith(inp.allow!.archivePrefix))
    : [...inp.changedPaths];
  if (!offenders.length) return null;
  return { branch: inp.branch, landing, offenders, allowed };
}

// The refusal line. It names the landing mode, what the range carried, and the route out — a
// refusal with no legal next move invites the workaround it was written to stop (the §17 shape).
export function defaultBranchPushRefusalLine(v: DefaultBranchPushVerdict): string {
  const shown = v.offenders.slice(0, 5).join(", ") + (v.offenders.length > 5 ? `, … (${v.offenders.length} total)` : "");
  const allowNote = v.allowed.length
    ? `only ${v.allowed.join(" and ")} may land on '${v.branch}' directly (that is \`dev-loop doc-land\`, §20 D4)`
    : `this project has no repo-file strategyDoc, so NOTHING may land on '${v.branch}' directly`;
  return `⛔ landing: this repo is landing:"pr" and the range would push code to '${v.branch}' — ${shown}. ${allowNote}. Route: put these commits on a dev-loop/<ticket-id> branch and open a PR (\`dev-loop push\` + \`gh pr create\`); Step 0.5 lands it with \`dev-loop pr merge\`. §7's merge-back sequence is the landing:"direct" path and does not apply here.`;
}
