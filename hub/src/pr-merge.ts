// pr merge — ONE verb that gates and lands a feature PR (LOOP-444).
//
// WHY THIS EXISTS. Until now Step 0.5 was two things an agent did in sequence: run
// `dev-loop merge-guard --pr <n> --strict --apply`, read its exit code, then run
// `gh pr merge <n> --squash --delete-branch`. Nothing machine-side refused the second when the
// first was skipped, so the enforcement lived in whichever tier reasoned carefully about its
// instructions. Measured 2026-08-06: `62178e6` (LOOP-357) merged at 20:52:11Z with NO required
// check in its rollup — 9 minutes after correct hold comments had been posted on sibling PRs, by a
// direct `gh pr merge` from a fire (`autoMergeRequest: None`); `c3454b7` (LOOP-355) landed the same
// way and broke `main`'s typecheck (LOOP-423). The hold held in the tier that consulted the guard
// and not in the tier that didn't.
//
// So the guard's verdict stops being advisory output a caller may ignore and becomes the
// PRECONDITION OF THE SAME CALL. There is no argv that squashes without the axes running: the
// merge subprocess is issued from inside this function, after they clear.
//
// It deliberately does NOT do branch protection on the forge — conventions §12c explains why
// required-check gating deadlocks the release pipeline's `GITHUB_TOKEN`-created `deploy/*` PRs
// (W38 names that posture). This is the in-product gate instead.
import { realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { isMainEntry } from "./is-entry.ts";
import type { ExecFn } from "./landing.ts";
import { defaultGhExec } from "./landing.ts";
import { acquireLock } from "./locks.ts";
import { tryResolveWorkspace, wsLockPath } from "./workspace.ts";
import {
  mergeGuard, unevaluatedHold, resolveRegistryCiFreshnessConfig, registryGhRepos, resolveGhRepo, skipClass,
  ghRepoFromRemote,
  type MergeGuardResult, type SkipReason, type CiFreshnessConfigResolution,
} from "./merge-guard.ts";

// One hold per axis that objected — never one collapsed "refused".
//
// AC4: `check-never-reported`, a board-state hold and a forge-review hold are three different next
// actions (re-dispatch the workflow / fix the ticket state / resolve the thread), and two of them
// can hold the same PR at once. A single exit code cannot carry that, and re-deriving one sentence
// over co-occurring causes is the mistake LOOP-433 records on the doctor side. So the exit code says
// only "held", and the holds are enumerated — one line, one machine `token`, per objecting axis.
export interface PrMergeHold {
  // `readiness` is not a guard axis: it is the green-AND-mergeable pre-filter §12c had the AGENT do
  // before it ran the guard at all. Folding the guard into the squash while dropping that filter
  // would be a REGRESSION — the verb would happily squash a PR whose checks are still running,
  // which the two-step never did. So the filter moves inside too, and it is labelled honestly.
  axis: "readiness" | "boardState" | "forgeReview" | "ciFreshness";
  token: string;   // stable machine token: pr-not-open | pr-draft | not-mergeable |
                   // mergeability-unknown | board-not-merge-eligible | unresolved-review | <ciVerdict>
  detail: string;  // the human line — the guard's own objection text for this axis
}

export interface PrMergeResult {
  merged: boolean;
  // Already MERGED before this call: the idempotent re-run §12c requires ("a second dev fire finds
  // the PR already merged and no-ops"). Checked BEFORE the guard on purpose — post-merge the ticket
  // is normally `In Review`, so the board axis would trip and a re-run would report a hold on work
  // that already landed (the LOOP-216 shape).
  alreadyMerged: boolean;
  holds: PrMergeHold[];
  // The guard ran but gated nothing it could have gated (merge-guard's EXIT_UNEVALUATED case).
  unevaluated: SkipReason | null;
  // Null when no repo could be resolved: this verb cannot address a PR without owner/repo, and
  // guessing between two registered repos would gate a DIFFERENT repo's PR #n (merge-guard's rule).
  ghRepo: string | null;
  guard: MergeGuardResult | null;
  // The argv actually issued to `gh`, or null when no merge was attempted. This is the field the
  // regression test asserts on: "no merge happened" must be checkable, not inferred.
  mergeArgv: string[] | null;
  mergeError: string | null;
  // Set when the per-repo landing lock could not be taken, in which case NOTHING below it ran: no
  // axis was read and no squash was attempted. It is deliberately not a `hold` — a hold names an
  // objection somebody must answer (fix the ticket, resolve the thread, re-dispatch the workflow),
  // and "another fire is landing in this repo" is none of those; it is a retry. Folding it into
  // exit 1 would send a caller looking for an objection that was never written (LOOP-455 AC3).
  lockUnavailable: string | null;
}

// This verb's exit contract. merge-guard's own numbering (0/1/2/3) is NOT re-used loosely: 3 keeps
// its exact meaning (could not evaluate), and 4 is added for "the gate cleared and the squash
// itself failed" — a caller must not read a forge error as a human objection. AC5: `merge-guard`'s
// contract for direct callers is untouched; this adds a caller, it does not re-number them.
export const PR_MERGE_EXIT = {
  merged: 0,       // squashed, or already merged (idempotent no-op)
  held: 1,         // ≥1 axis objected — every objecting axis is named
  usage: 2,        // bad invocation, incl. no/ambiguous repo resolution
  unevaluated: 3,  // --strict semantics: the gate checked nothing it could have checked
  mergeFailed: 4,  // axes clear, `gh pr merge` failed (forge error) — NOT an objection
  lockUnavailable: 5, // the per-repo landing lock could not be taken — the gate never ran (LOOP-455)
} as const;

// The squash Step 0.5 issues today, plus the explicit `--repo`. The repo is explicit because this
// verb inherits merge-guard's cwd-independence (LOOP-300 AC3: --pr resolves through the workspace
// repo registry), and a `gh pr merge` without --repo only works when the cwd IS the repo — the verb
// would then gate correctly from the workspace root and fail to land. `--delete-branch` is kept:
// §12c requires it ("feature branches must not pile up").
//
// `--match-head-commit` is what makes the gate's verdict apply to the revision it actually judged.
// The axes read a head SHA and its checks; the squash is a SEPARATE forge call some seconds later.
// A push landing in that window merges a head no axis ever saw — and this project deliberately has
// NO forge-side required-check protection (§12c: required-check gating deadlocks the release
// pipeline's GITHUB_TOKEN-created deploy/* PRs), so nothing else would catch it. The flag makes the
// forge itself refuse a head that moved, which surfaces as `mergeFailed` (exit 4) and re-gates from
// scratch on the next fire — the correct outcome, since the new head has not been judged.
export function mergeArgvFor(pr: number | string, ghRepo: string, headSha?: string | null): string[] {
  return [
    "pr", "merge", String(pr), "--repo", ghRepo, "--squash", "--delete-branch",
    ...(headSha ? ["--match-head-commit", headSha] : []),
  ];
}

// The ONLY ciFreshness verdicts that let the squash proceed — an allowlist, deliberately (see the
// ciFreshness branch in holdsFrom). `fresh-green`: checks green against the current tip.
// `stale-exempt`: behind the tip, but every file in the delta is configured CI-irrelevant, so
// re-verifying could not change a check result (LOOP-323). Every other verdict — including the ones
// the guard does not TRIP on — holds this call.
const CI_VERDICT_CLEARS_SQUASH: ReadonlySet<string> = new Set(["fresh-green", "stale-exempt"]);

function holdsFrom(g: MergeGuardResult): PrMergeHold[] {
  const holds: PrMergeHold[] = [];
  const bs = g.boardState, fr = g.forgeReview, cf = g.ciFreshness;
  if (!bs.skipped && bs.trip) {
    holds.push({
      axis: "boardState",
      token: "board-not-merge-eligible",
      detail: `ticket ${bs.ticketId} is ${bs.ticketState} — not merge-eligible on the board`,
    });
  }
  if (!fr.skipped && fr.trip) {
    const who = [...fr.changeRequesters, ...fr.unresolvedThreadAuthors].filter((v, i, a) => a.indexOf(v) === i);
    holds.push({
      axis: "forgeReview",
      token: "unresolved-review",
      detail: `PR has an unresolved objection from ${who.map((l) => `@${l}`).join(", ")} (CHANGES_REQUESTED or unresolved thread)`,
    });
  }
  if (cf.skipped) {
    // A SKIPPED CI axis normally lets the squash proceed, and must keep doing so: `no-pr-arg` and
    // `repo-not-automerge` mean the axis has nothing to say, and `forge-unreachable` is §3.4's
    // fail-open (an outage may not become a merge freeze). But `untargeted` is neither — it means
    // the axis could not work out WHAT to check and the caller can fix that. Letting it through is
    // how "ambiguity reported as absence" reached the squash. Keyed on the CLASS, not on the one
    // reason found today: any future untargeted skip fails closed here by construction, the same
    // reason CI_VERDICT_CLEARS_SQUASH is an allowlist.
    if (cf.skipReason && skipClass(cf.skipReason) === "untargeted") {
      holds.push({
        axis: "ciFreshness",
        token: cf.skipReason,
        detail: `the CI axis did not run (${cf.skipReason}) — the invocation did not identify what to check, so no check has cleared this squash; fix it with --repo <dir> and re-run`,
      });
    }
  } else if (cf.trip) {
    // The ciFreshness token IS the verdict, so `check-never-reported` (the workflow never
    // dispatched — a rebase cannot fix it) stays distinct from `stale` (a rebase is exactly the
    // fix) and from `red` (read the log). Collapsing them would send the wrong remedy.
    holds.push({
      axis: "ciFreshness",
      token: cf.verdict ?? "unknown",
      detail: `PR CI verdict=${cf.verdict ?? "unknown"}${cf.reason ? ` (${cf.reason})` : ""}`,
    });
  } else if (!CI_VERDICT_CLEARS_SQUASH.has(cf.verdict ?? "unknown")) {
    // An evaluated axis that did not trip is still not permission to squash. The guard's TRIP set is
    // deliberately narrow — `pending` and `unknown` do not trip, because tripping would objection-spam
    // every open PR whenever CI is merely slow (LOOP-407) or the forge blinked (§3.4: a gate must not
    // become a merge freeze). But "not an objection" is not "may be merged", and this is the call that
    // performs the squash: it may proceed only on a verdict that POSITIVELY certifies the checks.
    //
    // So the allowlist above is the gate, not a blocklist of known-bad verdicts. `unknown` is the
    // reason it is written that way: `readCiFreshness` degrades to it whenever the rollup read or the
    // compare call fails (hub/src/landing.ts) — the checks were never certified against the tip — yet
    // `gh pr merge` against the same forge can still succeed, landing exactly the unverified merge
    // this ticket exists to prevent. A blocklist also silently re-opens the hole every time a new
    // verdict is added to CiFreshnessVerdict; an allowlist fails closed on one by construction.
    //
    // These hold WITHOUT writing to the board: they are states of the world, not objections anyone
    // must answer — §12c's "pending ⇒ leave it for the next fire", enforced instead of instructed.
    const v = cf.verdict ?? "unknown";
    holds.push({
      axis: "ciFreshness",
      token: v,
      detail: v === "pending"
        ? `PR CI verdict=pending${cf.reason ? ` (${cf.reason})` : ""} — leave it for the next fire`
        : `PR CI verdict=${v}${cf.reason ? ` (${cf.reason})` : ""} — the checks were never certified green against the tip, so nothing has cleared this squash`,
    });
  }
  return holds;
}

// The green-AND-mergeable pre-filter, from ONE `gh pr view`. Returns the holds it found, plus
// whether the PR is already merged (which is not a hold — see PrMergeResult.alreadyMerged).
function readinessHolds(
  exec: ExecFn, pr: number | string, ghRepo: string,
): { holds: PrMergeHold[]; alreadyMerged: boolean; read: boolean; headSha: string | null } {
  let data: { state?: string; isDraft?: boolean; mergeable?: string; headRefOid?: string };
  try {
    // `headRefOid` rides this existing read rather than costing a call of its own: it is the head the
    // gate is about to judge, and the fallback SHA for the merge's --match-head-commit pin when the
    // CI axis was skipped and so reported no testedHead of its own.
    const r = exec(["pr", "view", String(pr), "--repo", ghRepo, "--json", "state,isDraft,mergeable,headRefOid"]);
    if (!r.ok) return { holds: [], alreadyMerged: false, read: false, headSha: null };
    data = JSON.parse(r.stdout) as typeof data;
  } catch {
    // Unreadable: do NOT invent a hold. The guard's axes read the same forge and have their own
    // degrade rules (§3.4 — an outage must not become a merge freeze), and if everything degrades the
    // merge attempt itself fails against that same forge and surfaces as mergeFailed.
    return { holds: [], alreadyMerged: false, read: false, headSha: null };
  }
  const headSha = data.headRefOid ?? null;
  if (data.state === "MERGED") return { holds: [], alreadyMerged: true, read: true, headSha };
  const holds: PrMergeHold[] = [];
  if (data.state && data.state !== "OPEN") {
    holds.push({ axis: "readiness", token: "pr-not-open", detail: `PR state is ${data.state} — there is nothing to land` });
  }
  if (data.isDraft) {
    holds.push({ axis: "readiness", token: "pr-draft", detail: "PR is a DRAFT — mark it ready for review first" });
  }
  if (data.mergeable === "CONFLICTING") {
    holds.push({ axis: "readiness", token: "not-mergeable", detail: `PR conflicts with the base branch — rebase the branch and force-with-lease (§12c: DIRTY never self-heals)` });
  } else if (data.mergeable !== undefined && data.mergeable !== "MERGEABLE") {
    // UNKNOWN: the forge has not finished computing mergeability (normal for a few seconds after a
    // push). §12c merges only a PR that IS mergeable, so this fails closed and retries next fire —
    // a transient recompute, not an outage, so no fail-open exception applies.
    holds.push({ axis: "readiness", token: "mergeability-unknown", detail: `PR mergeability is ${data.mergeable} — the forge has not computed it yet; re-run once it settles` });
  }
  return { holds, alreadyMerged: false, read: true, headSha };
}

// The gate-and-squash body. PRIVATE on purpose: it reads the axes and issues the squash, and doing
// that WITHOUT the per-repo lock is precisely the race LOOP-455 records. The exported entry point is
// the async `prMerge` below, which cannot be called without taking the lock — the same reason
// LOOP-444 made the guard the precondition of the squash rather than a step a caller performs first.
function prMergeUnlocked(
  repoDir: string,
  opts: {
    pr: number | string;
    ticketId?: string;
    ghRepo?: string;
    dbPath?: string;
    apply?: boolean;              // default true — this verb replaces `merge-guard --strict --apply`
    exec?: ExecFn;                // injected gh exec; the seam hub/test/merge-guard.ts already uses
    agentReviewers?: string[];
    mergeChecks?: string[];
    ciIrrelevantPaths?: string[];
    defaultBranch?: string;
    repoEligible?: boolean;
    ciConfigAmbiguous?: boolean;  // ≥2 registry entries share the selected remote — see holdsFrom
  },
): PrMergeResult {
  const exec = opts.exec ?? defaultGhExec;
  const apply = opts.apply ?? true;
  const ghRepo = opts.ghRepo ?? resolveGhRepo(repoDir);
  const base: PrMergeResult = {
    merged: false, alreadyMerged: false, holds: [], unevaluated: null,
    ghRepo, guard: null, mergeArgv: null, mergeError: null, lockUnavailable: null,
  };
  if (!ghRepo) return base;

  // Readiness first, because ALREADY-MERGED is decided here (see PrMergeResult.alreadyMerged) and a
  // merged PR must short-circuit before the guard can object to the now-In-Review ticket.
  const readiness = readinessHolds(exec, opts.pr, ghRepo);
  if (readiness.alreadyMerged) return { ...base, alreadyMerged: true };

  // The guard runs even when readiness already holds: a board-state or review objection is true
  // regardless of whether the PR happens to be mergeable, and reporting every cause at once is the
  // point (AC4). It also means the objection reaches the ticket on the first run, not the third.
  const guard = mergeGuard(repoDir, {
    pr: opts.pr, ghRepo, apply, exec,
    ...(opts.ticketId !== undefined ? { ticketId: opts.ticketId } : {}),
    ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}),
    ...(opts.agentReviewers !== undefined ? { agentReviewers: opts.agentReviewers } : {}),
    ...(opts.mergeChecks !== undefined ? { mergeChecks: opts.mergeChecks } : {}),
    ...(opts.ciIrrelevantPaths !== undefined ? { ciIrrelevantPaths: opts.ciIrrelevantPaths } : {}),
    ...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
    ...(opts.repoEligible !== undefined ? { repoEligible: opts.repoEligible } : {}),
    ...(opts.ciConfigAmbiguous ? { ciConfigAmbiguous: true } : {}),
  });
  const holds = [...readiness.holds, ...holdsFrom(guard)];
  if (holds.length > 0) return { ...base, guard, holds };

  // No axis objected — but under --strict a run that gated NOTHING it could have gated must not
  // report a clean pass either (LOOP-300 AC1). Same rule, same reason: a gate that checked nothing
  // has not cleared anything.
  //
  // Honest status: this branch is a FORWARD GUARD, not a live path. `unevaluatedHold` fires only on
  // an `untargeted` skip, and both of those reasons (`no-ticket-input`, `no-repo-resolved`) are
  // unreachable from here — this function always supplies `pr`, and it returned above if the repo
  // did not resolve. It stays because the classifier is shared and open to extension: a future
  // untargeted reason that CAN arise here must hold the squash, not slip through as clean. Its
  // mapping is pinned directly in hub/test/pr-merge.ts, which says the same thing.
  const hold = unevaluatedHold(guard);
  if (hold) return { ...base, guard, unevaluated: hold };

  // Pin the squash to the revision the gate judged. The CI axis's `testedHead` is the strongest
  // answer — it is the SHA the checks actually ran on — so it wins; the readiness read's headRefOid
  // is the fallback for a skipped CI axis (repo-not-automerge / no-merge-checks), where there is no
  // certified SHA but a mid-flight push is still not something to land silently.
  const pinnedHead = guard.ciFreshness.testedHead ?? readiness.headSha;
  const mergeArgv = mergeArgvFor(opts.pr, ghRepo, pinnedHead);
  try {
    const r = exec(mergeArgv);
    if (!r.ok) return { ...base, guard, mergeArgv, mergeError: (r.stderr || r.stdout || "gh pr merge failed").trim().split("\n")[0]! };
    return { ...base, guard, mergeArgv, merged: true };
  } catch (e) {
    return { ...base, guard, mergeArgv, mergeError: (e as Error).message.split("\n")[0]! };
  }
}

// How long a contended call waits for the holder before giving up (AC3), and how long a lock may sit
// before it is treated as abandoned (AC5).
//
// STALE_MS is 15 minutes and that is not padding. `acquireLock` treats a lock as stale on EITHER a
// dead holder OR an age past staleMs, and the default 30s is far shorter than a slow gate-and-squash
// (seven forge round-trips plus the merge) — a second fire would break a LIVE holder's lock and
// re-create the exact interleaving this ticket closes. The dead-holder liveness check is what
// actually reaps a crashed fire, and it fires IMMEDIATELY regardless of age, so a long staleMs costs
// nothing in recovery time: a killed fire's lock (the ~50-minute budget kill is routine here) is
// taken over on the next attempt, never waited out. staleMs only bounds a holder that is alive but
// wedged, and 15 minutes is longer than any real landing.
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 120_000;

// The lock this verb serializes on. It ALWAYS resolves to a path — there is no "could not work out
// where to lock, so proceed unlocked" branch, because that branch would be the hole (AC5).
//
// Registered repo ⇒ `repo-<ref>`, byte-identical to what `dev-loop with-repo-lock <ref>` takes (§7).
// Sharing the name is the point, not a coincidence: in `landing:"direct"` the merge-back sequence
// pushes `defaultBranch` under that same lock, and a squash racing that push moves the same branch
// from two writers. One name, one serialization.
//
// The fallbacks key on the GitHub repo instead, because that — not the local directory — is what two
// racing fires actually contend for: two clones or two worktrees of one repo are different paths
// landing into the same branch, and a path-keyed lock would let them straight through.
export function prMergeLockPath(repoDir: string, ghRepo: string): string {
  const slug = `repo-gh-${ghRepo.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  const ws = tryResolveWorkspace(repoDir);
  if (!ws) {
    // No workspace: still lock, per-user and per-machine. Two fires always share a workspace, so this
    // is the standalone-invocation case rather than the racing one — but "unlikely to be contended"
    // is not a reason to skip the lock, and a skip here would be a fail-open nobody would see.
    return join(tmpdir(), "dev-loop-locks", `${slug}.lock`);
  }
  let real: string;
  try { real = realpathSync(repoDir); } catch { real = resolvePath(repoDir); }
  const entries = Object.entries(ws.file.repos ?? {}) as [string, { path?: string; remote?: string } | null][];
  for (const [ref, e] of entries) {
    if (!e?.path) continue;
    const abs = resolvePath(ws.root, e.path);
    let absReal = abs;
    try { absReal = realpathSync(abs); } catch { /* keep abs */ }
    if (absReal === real || abs === real) return wsLockPath(ws, `repo-${ref}`);
  }
  // The cwd is not a registered repo path (the workspace-root invocation this verb's --help
  // advertises). Match on the remote instead — one entry only; two entries sharing a remote is the
  // ambiguity `resolveRegistryCiFreshnessConfig` already refuses to guess through.
  const byRemote = entries.filter(([, e]) => e?.remote && ghRepoFromRemote(e.remote) === ghRepo);
  if (byRemote.length === 1) return wsLockPath(ws, `repo-${byRemote[0]![0]}`);
  return wsLockPath(ws, slug);
}

// `dev-loop pr merge` — the axes AND the squash under ONE per-repo lock (LOOP-455).
//
// WHY THE LOCK WRAPS BOTH. LOOP-444 closed the gap inside one call; this closes the gap BETWEEN two.
// Fires 1 and 2 gate PRs A and B concurrently, both reading CI freshness against the same base tip
// `T`, both getting `fresh-green`. Fire 1 squashes A and `main` becomes `T+1`. Fire 2 is already past
// its axes, so it squashes B — whose checks never ran against `T+1` and so never saw A's changes.
// `--match-head-commit` does not cover it: it pins the PR HEAD, and the head never moved — the BASE
// did. With the axes inside the lock, fire 2 cannot read freshness until fire 1 has finished
// landing, so it reads `T+1`, sees B behind the tip, and HOLDS as `stale` instead of squashing.
//
// Deliberately NOT the cheaper fix of re-reading the tip just before the squash: that narrows the
// window without closing it and would read as fixed while staying racy (the ticket says so outright).
export async function prMerge(
  repoDir: string,
  opts: Parameters<typeof prMergeUnlocked>[1] & { lockPath?: string; lockWaitMs?: number },
): Promise<PrMergeResult> {
  const ghRepo = opts.ghRepo ?? resolveGhRepo(repoDir);
  const base: PrMergeResult = {
    merged: false, alreadyMerged: false, holds: [], unevaluated: null,
    ghRepo, guard: null, mergeArgv: null, mergeError: null, lockUnavailable: null,
  };
  // No repo, nothing to serialize on and nothing to merge — the existing usage exit, unchanged.
  if (!ghRepo) return base;

  const lockPath = opts.lockPath ?? prMergeLockPath(repoDir, ghRepo);
  let release: () => void;
  try {
    release = await acquireLock(lockPath, { totalMs: opts.lockWaitMs ?? LOCK_WAIT_MS, staleMs: LOCK_STALE_MS });
  } catch (e) {
    // FAIL CLOSED, and this is the deliberate §3.4 classification AC5 asks for rather than an
    // inherited default. §3.4 fails OPEN for a forge outage on the reasoning that an outage must not
    // become a merge freeze — the forge being unreachable is evidence about the FORGE, not about
    // another writer. A lock we could not take is the opposite: the most likely reason is that
    // another fire is landing in this repo right now, which is the precise condition under which
    // merging is unsafe. So the two are not the same case and must not share a rule. A gate that
    // could not lock has not gated, and it says so with its own exit code instead of squashing.
    return { ...base, lockUnavailable: (e as Error).message };
  }
  try {
    return prMergeUnlocked(repoDir, { ...opts, ghRepo });
  } finally { release(); }
}

// ONE resolution for the whole verb: which GitHub repo this call addresses, and the CI-freshness
// config OF THAT REPO.
//
// It is one function because it was two, and they disagreed. `resolveGhRepo` answers from the
// workspace repo registry when the cwd is not a git repo (LOOP-300 AC3) — a mode this verb's own
// --help advertises — while the config lookup matched a REGISTERED PATH only. Run from the
// workspace root, the pair resolved a repo and then no config for it: `mergeChecks` empty, the CI
// axis skipped as `no-merge-checks`, no hold, and the squash issued with the check axis never run.
// A gate that skipped CI because it could not find its own config is not a gate that passed, and
// this verb exists precisely to refuse that squash (LOOP-423 is what one costs). Resolving the repo
// FIRST and reading the config for that repo is what makes the two answers the same answer.
// It returns the RESOLUTION, not a config-or-null: "could not choose between two entries" and
// "there is no entry" produce different squash decisions here, and collapsing them into null is
// what let an ambiguous workspace merge with the CI axis never run.
export function resolvePrMergeTarget(repoDir: string): {
  ghRepo: string | null;
  ciConfig: CiFreshnessConfigResolution;
} {
  const ghRepo = resolveGhRepo(repoDir);
  return { ghRepo, ciConfig: resolveRegistryCiFreshnessConfig(repoDir, ghRepo) };
}

// The exit code for a result, so the CLI and any programmatic caller cannot disagree about it.
export function prMergeExit(r: PrMergeResult): number {
  // First, because a lock failure means NOTHING ran: no axis, no squash. Left to fall through it
  // would land on `mergeFailed` (a resolved repo with no holds and no merge), reporting a forge
  // error for a merge that was never attempted.
  if (r.lockUnavailable) return PR_MERGE_EXIT.lockUnavailable;
  if (r.merged || r.alreadyMerged) return PR_MERGE_EXIT.merged;
  if (r.holds.length > 0) return PR_MERGE_EXIT.held;
  if (r.unevaluated) return PR_MERGE_EXIT.unevaluated;
  if (!r.ghRepo) return PR_MERGE_EXIT.usage;
  return PR_MERGE_EXIT.mergeFailed;
}

const HELP = `dev-loop pr merge <n> — gate and land a feature PR in ONE call (LOOP-444).

Usage: dev-loop pr merge <n> [--repo <dir>] [--ticket <id>] [--no-apply] [--lock-wait <dur>] [--json]
  <n>            PR number
  --repo <dir>   repo directory (default: cwd; the GitHub repo is also read from the workspace
                 repo registry when the cwd is not the target repo — two registered GitHub repos
                 are ambiguous and refused, never guessed)
  --ticket <id>  explicit ticket id for the board axis (default: the PR's dev-loop/<id> head)
  --no-apply     do not post the objection comment / route the ticket on a hold (read-only gate)
  --lock-wait    how long to wait for another fire's landing to finish (default 120s)
  --json         emit the result as JSON

This is \`merge-guard --strict --apply\` AND \`gh pr merge --squash --delete-branch\` as ONE
operation: the guard's three axes (board state, forge review, CI freshness) run inside this call
and the squash happens only when they all clear. There is no argv that skips the gate — that
skippability is what let a fire merge past a correct hold and break main (LOOP-423).

The squash carries \`--match-head-commit <the SHA the checks ran on>\`, so a push that lands
between the gate's read and the merge cannot slip an unjudged head past it (this project has no
forge-side required-check protection by design). Only a verdict that positively certifies the
checks — \`fresh-green\` or \`stale-exempt\` — clears the squash; \`pending\` and \`unknown\`
HOLD without writing to the board, since neither is evidence the checks passed.

A hold names EVERY axis that objected, one line each with a machine token
(board-not-merge-eligible | unresolved-review | check-never-reported | stale | red), because the
remedies differ and two axes can hold the same PR at once.

The axes AND the squash run under ONE per-repo lock this verb takes itself (the same lock
\`dev-loop with-repo-lock <ref>\` uses), so two concurrent fires cannot interleave. Without it both
read CI freshness against the same base tip, the first squashes, and the second lands a PR whose
checks never ran against the new tip — the head pin cannot catch that, since it is the BASE that
moved. Waiting, then re-reading the axes, is what turns the second call into a \`stale\` hold.

If the lock is held, this waits \`--lock-wait\` (default 120s) and then exits 5 WITHOUT merging —
never a silent pass. Exit 5 is a retry, not an objection: nothing is written to the ticket, because
"another fire is landing" is not something anyone must answer. A lock left by a crashed fire is
broken automatically (its holder is checked for liveness), so a killed fire cannot freeze the queue.

Exit codes: 0 merged (or already merged — idempotent) · 1 HELD by the gate · 2 usage/repo
  unresolved · 3 the gate could not evaluate any axis it could have (merge-guard's exit 3, same
  meaning) · 4 the gate cleared and \`gh pr merge\` itself failed (a forge error, not an objection)
  · 5 the per-repo landing lock could not be taken, so the gate never ran — re-run.
\`dev-loop merge-guard\`'s own exit contract is unchanged — this adds a caller.`;

if (isMainEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h" || argv.length === 0) { console.log(HELP); process.exit(0); }
  const sub = argv[0];
  if (sub !== "merge") {
    console.error(`dev-loop pr: unknown subcommand '${sub}' (expected: merge)`);
    process.exit(PR_MERGE_EXIT.usage);
  }
  let repo = process.cwd();
  let pr: string | undefined;
  let ticketId: string | undefined;
  let apply = true;
  let asJson = false;
  let lockWaitMs: number | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo") repo = argv[++i] ?? "";
    else if (a === "--ticket") ticketId = argv[++i];
    else if (a === "--no-apply") apply = false;
    else if (a === "--lock-wait") {
      const v = argv[++i] ?? "";
      const m = v.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);   // the `with-repo-lock --wait` grammar
      if (!m) { console.error(`dev-loop pr merge: invalid --lock-wait duration '${v}'`); process.exit(PR_MERGE_EXIT.usage); }
      const u = m[2] ?? "s";
      lockWaitMs = Math.round(Number(m[1]) * (u === "ms" ? 1 : u === "s" ? 1000 : u === "m" ? 60000 : 3600000));
    }
    else if (a === "--json") asJson = true;
    else if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
    else if (!a.startsWith("-") && pr === undefined) pr = a;
    else { console.error(`dev-loop pr merge: unknown option '${a}'`); process.exit(PR_MERGE_EXIT.usage); }
  }
  if (!pr || !/^\d+$/.test(pr)) {
    console.error("dev-loop pr merge: a PR NUMBER is required — `dev-loop pr merge <n>`");
    process.exit(PR_MERGE_EXIT.usage);
  }

  // Same registry resolution the guard's CLI does, so both surfaces gate on identical config — and
  // resolved ONCE, so the repo the config describes is the repo the axes gate and the squash targets.
  const { ghRepo: resolvedRepo, ciConfig: cfRes } = resolvePrMergeTarget(repo);
  const cfCfg = cfRes.kind === "resolved" ? cfRes.config : null;
  let result: PrMergeResult;
  try {
    result = await prMerge(repo, {
      pr, apply,
      ...(lockWaitMs !== undefined ? { lockWaitMs } : {}),
      ...(resolvedRepo ? { ghRepo: resolvedRepo } : {}),
      ...(ticketId !== undefined ? { ticketId } : {}),
      ...(cfRes.kind === "ambiguous" ? { ciConfigAmbiguous: true } : {}),
      ...(cfCfg ? { mergeChecks: cfCfg.mergeChecks, defaultBranch: cfCfg.defaultBranch, repoEligible: cfCfg.repoEligible, ciIrrelevantPaths: cfCfg.ciIrrelevantPaths } : {}),
    });
  } catch (e) {
    console.error(`dev-loop pr merge: ${(e as Error).message.split("\n")[0]}`);
    process.exit(PR_MERGE_EXIT.usage);
  }

  const exit = prMergeExit(result);
  if (asJson) {
    console.log(JSON.stringify({ ...result, exit }, null, 2));
  } else if (result.alreadyMerged) {
    console.log(`pr merge: PR #${pr} is already merged — nothing to do`);
  } else if (!result.ghRepo) {
    const candidates = registryGhRepos(repo);
    console.error(`pr merge: could not resolve the GitHub repo from '${repo}' or the workspace repo registry${candidates.length > 1 ? ` (registry has ${candidates.length}: ${candidates.join(", ")} — pass --repo <dir> to disambiguate)` : ""}`);
  } else if (result.lockUnavailable) {
    // Named as a retry, not an objection: there is nothing on the ticket to read, because no axis
    // ran and nothing was written. Saying "HELD" here would send a caller hunting for a comment.
    console.error(`pr merge: ⛔ another fire is landing in ${result.ghRepo} — PR #${pr} was NOT merged and the gate never ran (${result.lockUnavailable})`);
    console.error("  Nothing was written to the ticket. Re-run this verb once the other landing finishes; it will gate the PR against the tip that fire leaves behind.");
  } else if (result.holds.length > 0) {
    console.error(`pr merge: ⛔ HELD — PR #${pr} was NOT merged (${result.holds.length} objection${result.holds.length > 1 ? "s" : ""}):`);
    for (const h of result.holds) console.error(`  [${h.token}] ${h.axis}: ${h.detail}`);
    if (cfRes.kind === "ambiguous") {
      console.error(`  The CI config was ambiguous: ${cfRes.paths.length} repo entries share the remote ${cfRes.ghRepo} (${cfRes.paths.join(", ")}). Pass --repo <dir> to name the one to gate.`);
    }
    // Only claim a board write that HAPPENED. `applyTrip` runs when the guard TRIPS; a readiness
    // hold (draft/conflict/unknown-mergeability) and a non-tripping CI state (pending/unknown, and
    // an untargeted skip) hold this squash without any axis objecting, so nothing was written and
    // there is no audit trail to point an operator at. Reporting one anyway invites reliance on a
    // routing action that never occurred — so the line is keyed on the recorded action, not on
    // `apply` having been requested. `already_present` counts: the objection IS on the ticket.
    const applied = result.guard?.applied?.action;
    if (applied === "wrote" || applied === "already_present") {
      console.error("  The objection is recorded on the ticket. Fix the cause named above and re-run this verb.");
    } else {
      // Only say what did NOT happen when the caller ASKED for it; under --no-apply nobody expected
      // a write, and reporting its absence would be noise rather than a correction.
      if (apply) console.error("  No ticket comment was written: no axis objected — these holds are states of the world, not objections anyone must answer.");
      console.error("  Fix the cause named above and re-run this verb.");
    }
  } else if (result.unevaluated) {
    console.error(`pr merge: ⛔ COULD NOT EVALUATE — no axis ran (${result.unevaluated}); PR #${pr} was NOT merged. A gate that checked nothing has not cleared anything: fix the invocation (--repo <dir> / --ticket <id>) and re-run.`);
  } else if (result.mergeError) {
    console.error(`pr merge: the gate CLEARED but \`gh ${result.mergeArgv?.join(" ")}\` failed — ${result.mergeError}`);
    if (/head.*match|match.*head|not match/i.test(result.mergeError)) {
      console.error("  The PR head moved after the gate read it, so --match-head-commit refused the squash. That is the pin working: the new head has not been judged. Re-run this verb to gate the new head.");
    }
  } else {
    console.log(`pr merge: ✅ gate clear on all evaluated axes — PR #${pr} squashed and its branch deleted`);
  }
  process.exit(exit);
}
