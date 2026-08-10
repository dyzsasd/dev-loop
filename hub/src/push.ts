#!/usr/bin/env node
// dev-loop push — ONE verb that gates and publishes a branch (LOOP-521, design approvals §16.3).
//
// WHY THIS EXISTS. `approvals.enforce: ["push"]` had exactly one enforcing consumer — `push-guard`
// (LOOP-394) — and on `landing:"pr"` nothing called it. Measured on the merged tree at `c66ac22`:
// the three callers are §7's direct merge-back (prose), `doc-land` (code), and pm-agent's reference
// to `doc-land`; the feature-branch push in `skills/dev-agent/SKILL.md` calls nothing at all. So the
// switch reached no reader and a fire could publish a branch carrying an ungranted `push:` request.
//
// The remedy is a VERB, not a rule (design §16.2, the operator's 2026-08-10 ruling on LOOP-499): a
// guard that depends on every future ship path remembering to call it is the same defect one level
// up — the shape LOOP-448 retired one month after LOOP-444 shipped `dev-loop pr merge`. So the guard
// stops being advisory output a caller may ignore and becomes the PRECONDITION OF THE SAME CALL:
// the push subprocess is issued from inside this function, after the gate clears, and there is no
// argv that reaches the push without it.
//
// It is `doc-land`'s step 3+4 generalised to a feature branch, wearing `pr merge`'s clothes. It does
// NOT open the PR (§16.3 D1): `gh pr create` publishes nothing new — the branch is already on origin
// by then — and folding it in would make one verb's failure modes span the git remote AND the forge
// API, a readability cost `pr merge` pays deliberately for the squash and should not pay twice.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { acquireRepoLock } from "./locks.ts";
import { repoLandingLockPath, resolveDefaultBranchForRepoDir } from "./repo-lock-path.ts";
import { resolveGhRepo } from "./merge-guard.ts";
import { pushGuard, approvalRefusalLine, type PushGuardResult } from "./push-guard.ts";

// A refusal names its CLASS, never one collapsed "refused" — the remedies differ (drop the commit /
// resolve the ticket / get the approval granted / configure the remote) and two classes can refuse
// the same push at once. `readiness` is deliberately not called a guard class: it is the pre-filter
// that decides whether there is a push to gate at all, and `pr merge` learned (AC/D2) that folding a
// gate into an action while dropping the caller's pre-filter is a REGRESSION. So it moves inside too,
// and it is labelled honestly rather than dressed up as an axis.
export interface PushHold {
  class: "readiness" | "findings" | "passengers" | "governance" | "approvals";
  token: string;   // stable machine token: no-branch | no-remote | ride-along | passenger |
                   // governance | ungranted-approval
  detail: string;  // the human line — the guard's own objection text for this class
}

export interface PushResult {
  pushed: boolean;
  // An empty `origin/<branch>..<branch>`: an idempotent success in its OWN words, never a refusal
  // (§16.3 D2; `doc-land`'s "already upstream" split is the precedent). An exit 0 that prints
  // nothing is the same unreadable silence as a wrong success line.
  nothingToPush: boolean;
  branch: string | null;
  remote: string;
  // The branch tip this call published (or would have). §16.6: `dev-loop push` is the first place in
  // the pr-mode ship path that knows both the granted key and whether the push landed, which is the
  // seam LOOP-500's discharge needs — so the sha is carried out even though C7 discharges nothing.
  sha: string | null;
  holds: PushHold[];
  // `unresolvedDefaultBranch` is a REFUSAL like every other guard class (§16.3 D3 — all five
  // hard-stop), but it exits 3, not 1: its remedy is different in kind (fetch, or create the remote
  // branch) and it means passenger detection did not run at all. "The gate checked nothing it could
  // have checked" is what 3 already means in `pr merge` and in `merge-guard` before it (D4).
  gateUnevaluated: string | null;
  guard: PushGuardResult | null;
  // The argv actually issued to `git`, or null when no push was attempted. This is the field the
  // regression test asserts on: "no push happened" must be checkable, not inferred (AC1; `pr
  // merge`'s `mergeArgv` is the pattern).
  pushArgv: string[] | null;
  pushError: string | null;
  // The INVOCATION could not be resolved — not a git repo, no workspace default branch. Distinct
  // from a readiness hold, which is a resolved repo whose branch/remote state refuses the push.
  unresolved: string | null;
  // Set when the per-repo landing lock could not be taken, in which case NOTHING below it ran: no
  // class was read and no push was attempted. Deliberately not a `hold` — a hold names an objection
  // somebody must answer, and "another fire is landing in this repo" is a retry, not an objection.
  lockUnavailable: string | null;
  // LOOP-528 — the branch tip AFTER a successful push, when it is no longer the `sha` that was
  // published. The refspec is pinned to the audited sha, so a commit made while the gate ran stays
  // local; a caller who is not told that would have to diff the remote to find out.
  advancedTo?: string;
  // LOOP-536 — the divergence verdict, ALWAYS reported once the branch and its upstream are both
  // resolved, not only when a force-publish happens. A caller whose push was refused as a
  // non-fast-forward must be able to read WHY the verb did not escalate, and `null` here would make
  // "not diverged" and "not eligible" indistinguishable.
  forcePublish: ForcePublish | null;
  dryRun: boolean;
}

// Publishing a rebased branch REWRITES a ref this same verb already published, so it is not a free
// addition — §16.8 records the spec call and this type is its shape.
export interface ForcePublish {
  // `origin/<branch>` exists and is NOT an ancestor of the tip being published: a plain push cannot
  // fast-forward it, which is precisely the state §12c's rebase remedy leaves behind.
  diverged: boolean;
  // Whether THIS branch may be force-published at all (§16.8 rule 2). Eligibility is a property of
  // the branch name, decided independently of the divergence, so a refusal can name which half
  // failed.
  eligible: boolean;
  reason: string;
  // The upstream tip the lease pins — and, after a successful force-publish, the sha this push
  // REPLACED on the remote. Carried out rather than ledgered here: §16.8 rule 3.
  overwrittenSha: string | null;
}

// This verb's exit contract — deliberately `pr merge`'s numbering (§16.3 D4): the two ship-path verbs
// must not teach two exit vocabularies to the same reader.
//
// The KEYS are load-bearing, not decoration: the `--help` exit table names each code with its key
// here, and hub/test/push-verb.ts parses that table and asserts it equals this object. A help text
// that can drift from the codes it documents is the decay STANDING RULE 28 names.
export const PUSH_EXIT = {
  pushed: 0,          // pushed, or nothing to push (idempotent)
  held: 1,            // ≥1 class refused — every refusing class is named
  usage: 2,           // bad invocation, incl. an unresolved repo/default branch
  unevaluated: 3,     // the gate could not evaluate what it could have (unresolvedDefaultBranch)
  pushFailed: 4,      // gate clear, `git push` itself failed — a remote error, NOT an objection
  lockUnavailable: 5, // the per-repo landing lock could not be taken — the gate never ran
} as const;

export type GitExec = (args: string[]) => { ok: boolean; stdout: string; stderr: string };

export const defaultGitExec = (repoDir: string): GitExec => (args) => {
  try {
    const stdout = execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e) {
    const err = e as { stderr?: unknown; stdout?: unknown; message?: string };
    const streams = [err.stderr, err.stdout].map((s) => (s == null ? "" : String(s).trim())).filter(Boolean);
    return { ok: false, stdout: "", stderr: (streams.join("\n") || err.message || String(e)).trim() };
  }
};

// The push this verb issues. There is no force variant and no flag that adds one: a gate whose
// action can be re-shaped by the caller is not a gate.
//
// LOOP-528 — the source is the SHA the gate cleared, not the branch NAME. `<branch>:<branch>`
// re-resolves the ref inside `git push`, so an ordinary `git commit` landing between the guard
// returning and the push publishes a tip nothing checked. The per-repo landing lock does not close
// that window: it serializes `dev-loop` verbs against each other, not the author's own editor, and
// this verb is called BY the author mid-fire (D7). Pinning the refspec makes the published tip
// exactly the audited one — a TOCTOU that a re-read-and-compare could only narrow.
//
// `--set-upstream` is DELIBERATELY absent, and its absence is why `setUpstreamArgvFor` exists below.
// git accepts `-u` with a sha source and then silently does not set the upstream (no warning, exit
// 0) — measured, not assumed — so keeping the flag here would have left an argv that claims a
// tracking write it never performs.
// LOOP-536 — `leaseSha` is the ONLY way this argv acquires force semantics, and it always spends it
// on `--force-with-lease=<ref>:<expected>`. There is deliberately no parameter, flag, or env that
// produces a bare `--force`: a lease whose expected value the caller could omit degrades to
// `--force-with-lease` reading remote-tracking refs, which this verb's own `git fetch` has just
// refreshed — i.e. a lease that leases nothing. Pinning the expected sha explicitly is what makes a
// concurrent writer's push FAIL here instead of being overwritten (§16.8 rule 1).
export function pushArgvFor(remote: string, branch: string, sha: string, leaseSha?: string): string[] {
  const lease = leaseSha ? [`--force-with-lease=refs/heads/${branch}:${leaseSha}`] : [];
  return ["push", ...lease, remote, `${sha}:refs/heads/${branch}`];
}

// Which branches may be force-published (§16.8 rule 2). A ticket branch is the loop's own scratch
// space — this verb published every commit on it — so rewriting it destroys only work this verb
// owns. Everything else is somebody's shared history, and the default branch is the one ref whose
// rewrite the whole team feels; both are refused whatever the divergence (AC3).
//
// Anchored to `dev-loop/<PREFIX>-<n>` rather than to the `dev-loop/` prefix alone: the prefix is a
// namespace and `dev-loop/main` would sit inside it.
export const TICKET_BRANCH = /^dev-loop\/[A-Za-z][A-Za-z0-9_]*-\d+$/;

export function forcePublishEligible(branch: string, defaultBranch: string): { eligible: boolean; reason: string } {
  // Checked separately from the pattern, and first: a workspace whose default branch is literally
  // named `dev-loop/X-1` must still never be force-published. The pattern is a heuristic about
  // ownership; this is the invariant.
  if (branch === defaultBranch) {
    return { eligible: false, reason: `'${branch}' is the default branch — never force-published, whatever the divergence` };
  }
  if (!TICKET_BRANCH.test(branch)) {
    return { eligible: false, reason: `'${branch}' is not a dev-loop/<ticket-id> branch — only the loop's own ticket branches may be force-published` };
  }
  return { eligible: true, reason: `'${branch}' is a dev-loop ticket branch, so a rebase may be republished under a lease` };
}

// git puts the REASON a push failed on the second line and the destination banner on the first, so
// `stderr.split("\n")[0]` reports `To github.com:owner/repo.git` — a line that says a push happened
// to somewhere. Measured shape of a rejected push:
//
//   To /tmp/x/origin.git
//    ! [rejected]  08b2af2 -> dev-loop/AP-1 (non-fast-forward)
//   error: failed to push some refs to '/tmp/x/origin.git'
//   hint: Updates were rejected because ...
//
// So: drop the banner and the hints, keep everything else, join it. The hints are dropped because
// they restate the rejection for a human at a terminal and trebled the length of a field that ends
// up inside a one-line message; the `! [rejected] … (reason)` and `error:`/`fatal:` lines are what
// name the cause. FALLS BACK to the raw text whenever that filter leaves nothing — an unrecognised
// failure shape must not be reported as an empty reason, which is the defect one level down.
export function pushFailureReason(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const kept = lines.filter((l) => !/^To\s/.test(l) && !/^hint:/.test(l));
  const chosen = kept.length > 0 ? kept : lines;
  const joined = chosen.join("; ").trim();
  if (!joined) return "git push failed";
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

// The tracking `git push -u origin <branch>` used to set, restored as its own local step so the §17
// adoption stays a one-token substitution (D1) and `git status` still reports ahead/behind. It runs
// only after a successful push, writes no remote state, and a failure is reported without failing
// the push — the commits are published by then, and claiming otherwise would be the worse lie.
export function setUpstreamArgvFor(remote: string, branch: string): string[] {
  return ["branch", `--set-upstream-to=${remote}/${branch}`, branch];
}

function holdsFrom(g: PushGuardResult): PushHold[] {
  const holds: PushHold[] = [];
  // §16.3 D3 — every class hard-stops. `doc-land` downgrades reference findings to WARN and EARNS
  // that with a step-1 assertion that its range is docs-only (a docs-only range cannot smuggle
  // canceled work through prose). This verb makes no such assertion — its range is a feature
  // branch's whole unpushed tail — so it inherits no such downgrade. A verb that wraps a gate and
  // quietly weakens it is worse than no verb, because the caller now believes a gate ran.
  for (const f of g.findings) {
    holds.push({
      class: "findings",
      token: "ride-along",
      detail: `${f.sha} "${f.subject}" references ${f.ticket} (${f.state}) — a push would publish canceled work; drop/park it (needs-operator) before pushing`,
    });
  }
  for (const p of g.passengers) {
    // Both severities refuse: this verb inherits `push-guard --strict`, which exits 1 on any
    // passenger, and re-deciding that here would be a second answer to a question the guard owns.
    const detail = p.ticketId ? ` — ${p.ticketId} is ${p.boardState ?? "unverifiable"}` : " — no ticket id (unattributable)";
    holds.push({
      class: "passengers",
      token: "passenger",
      detail: `${p.sha} "${p.subject}"${detail}; ${p.severity === "hard" ? "drop or re-target this commit before pushing" : "re-cut or re-target when upstream lands"}`,
    });
  }
  for (const gv of g.governance) {
    holds.push({
      class: "governance",
      token: "governance",
      // The finding names the ROUTE OUT, not just the refusal (§17): the invariant is not "never
      // change these files", it is "changes to them are operator-committed proposals".
      detail: `${gv.sha} "${gv.subject}" edits ${gv.file} — ${gv.reason === "conventions" ? "conventions" : "a SKILL"} is operator-committed, not agent-editable. Route: drop it from this branch and file the change as a proposal for the operator to apply`,
    });
  }
  for (const a of g.approvals) {
    // The refusal names the approval path and NO bypass (design §9.4). There is no flag that turns
    // this off for one push: the route out is the operator granting the end state, which is safe to
    // print only because C2 made `approve` itself fire-refused (design §2).
    holds.push({ class: "approvals", token: "ungranted-approval", detail: approvalRefusalLine(a) });
  }
  return holds;
}

interface PushOpts {
  branch?: string;
  remote?: string;
  dryRun?: boolean;
  dbPath?: string;
  defaultBranch?: string;
  exec?: GitExec;
  // The gate itself, injectable so a unit arm can pin ONE class at a time without building five
  // repo states. The default is the real `push-guard` — and it is called with `enforcePush` left
  // UNSPECIFIED on purpose, so the switch resolves from the repo's own config exactly as it does for
  // `doc-land`: a caller cannot fall outside an enabled gate by omitting an argument.
  guard?: (ctx: { repoDir: string; branch: string; dbPath: string | undefined; defaultBranch: string; record: boolean; remote: string }) => PushGuardResult;
  lockPath?: string;
  lockWaitMs?: number;
}

// How long a contended call waits for the holder before giving up. Staleness (when a lock is treated
// as abandoned) is NOT set here — it is `REPO_LOCK_STALE_MS`, owned by the lock module, because a
// stale policy this caller chose would apply to whoever contends with it rather than to itself.
const LOCK_WAIT_MS = 120_000;

function pushUnlocked(repoDir: string, defaultBranch: string, opts: PushOpts): PushResult {
  const git = opts.exec ?? defaultGitExec(repoDir);
  const remote = opts.remote ?? "origin";
  const dryRun = opts.dryRun ?? false;
  const base: PushResult = {
    pushed: false, nothingToPush: false, branch: null, remote, sha: null, holds: [],
    gateUnevaluated: null, guard: null, pushArgv: null, pushError: null, unresolved: null,
    lockUnavailable: null, forcePublish: null, dryRun,
  };

  // ── Readiness ────────────────────────────────────────────────────────────────────
  // The remote first: without it there is nothing to publish to, and the fetch below would fail into
  // a warning that reads like a network blip rather than a missing configuration.
  if (!git(["remote", "get-url", remote]).ok) {
    return { ...base, holds: [{ class: "readiness", token: "no-remote", detail: `remote '${remote}' is not configured in this repo — nothing to push to` }] };
  }
  let branch = opts.branch;
  if (!branch) {
    const head = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    // A detached HEAD has no branch to publish, and guessing one from the commit graph would publish
    // a name nobody asked for.
    if (!head.ok || !head.stdout || head.stdout === "HEAD") {
      return { ...base, holds: [{ class: "readiness", token: "no-branch", detail: "HEAD is detached — pass --branch <b>, or check out the branch you mean to push" }] };
    }
    branch = head.stdout;
  }
  if (!git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    return { ...base, branch, holds: [{ class: "readiness", token: "no-branch", detail: `branch '${branch}' does not exist in this repo` }] };
  }
  const tip = git(["rev-parse", branch]);
  const sha = tip.ok ? tip.stdout : null;

  // Freshen the remote-tracking refs BEFORE the gate reads its range: the guard's passenger range is
  // `origin/<defaultBranch>..<branch>`, and a stale base makes it report commits origin already has.
  // A fetch is a base-clone mutation, which is why this whole body runs under the §7 lock (D5).
  // A failure is a WARNING, not a stop: stale refs make the guarded range WIDER, never narrower —
  // `origin/<branch>..<branch>` grows and `origin/<defaultBranch>..<branch>` grows — so the gate errs
  // toward refusing, which is the safe direction. (Nothing-to-push below is computed from the same
  // possibly-stale ref, and its error direction is "push something already upstream", a no-op.)
  //
  // IT RUNS UNDER `--dry-run` TOO, deliberately, and the contract says so rather than pretending
  // otherwise (PR #287 review, P2). The fetch updates remote-tracking refs — real local state — but
  // AC6's promise is that the dry run reports the verdict the real run WOULD, and a verdict measured
  // against a base the real run will not use is not that verdict. So the honest split is by kind, not
  // by count: the dry run writes nothing OUTWARD (no remote, no approvals ledger) and refreshes the
  // same base the real run reads. Skipping the fetch here would buy an untrue "mutates nothing" line
  // at the price of the one property the mode exists for.
  // LOOP-536 — the lease's expected value, read BEFORE the fetch, and this ordering is the whole
  // safety property. A lease pinned to the value our OWN fetch just retrieved expects whatever is on
  // the remote right now, so it authorises overwriting a commit we never looked at — a lease that
  // leases nothing. The honest expected value is "the tip we last SAW", which is the remote-tracking
  // ref as it stood on entry. Absent (never fetched) ⇒ we have seen nothing, so there is no lease to
  // take and no force-publish; that is the safe direction.
  const seenBefore = (() => {
    const r = git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]);
    return r.ok && r.stdout ? r.stdout : null;
  })();

  const fetched = git(["fetch", remote]);
  // Said out loud, as `doc-land` does: a silent fetch failure would let the reader believe the
  // ranges below were measured against a base they were not.
  if (!fetched.ok) process.stderr.write(`push: fetch warning: ${fetched.stderr.split("\n")[0]}\n`);

  // ── Nothing to push — an idempotent success, decided BEFORE the gate ──────────────
  // Publishing zero commits publishes nothing, so there is no gate question to answer. It is checked
  // here rather than after the guard so a re-run of an already-pushed branch costs no db handle and
  // reports the same line every time (AC7).
  const upstreamRef = `refs/remotes/${remote}/${branch}`;
  const hasUpstream = git(["rev-parse", "--verify", "--quiet", upstreamRef]).ok;
  if (hasUpstream) {
    const ahead = git(["rev-list", "--count", `${remote}/${branch}..${branch}`]);
    if (ahead.ok && Number(ahead.stdout) === 0) {
      return { ...base, branch, sha, nothingToPush: true };
    }
  }

  // ── Divergence — LOOP-536 ────────────────────────────────────────────────────────
  // Measured BEFORE the gate so the verdict is reported on every path below, refusals included: a
  // caller held on ciFreshness needs to know whether the rebase §12c prescribes is publishable here
  // before they run it, not only after the gate clears.
  //
  // `merge-base --is-ancestor` rather than a `rev-list --count` of the reverse range: the question is
  // "can this push fast-forward", which is exactly ancestry. A rebase makes the answer no even though
  // the replayed commits carry the same patch-ids — the shas differ, and refs move by sha.
  let forcePublish: ForcePublish | null = null;
  if (hasUpstream && sha) {
    const up = git(["rev-parse", upstreamRef]);
    const upstreamSha = up.ok && up.stdout ? up.stdout : null;
    if (upstreamSha) {
      // Divergence is measured against the FETCHED tip — that is the state a plain push would hit.
      const diverged = !git(["merge-base", "--is-ancestor", upstreamSha, sha]).ok;
      const branchEligible = forcePublishEligible(branch, defaultBranch);
      // …but the LEASE is `seenBefore` (above). When the two disagree, the remote moved under us and
      // git will refuse with `stale info` — which is the correct outcome, produced atomically at the
      // push rather than by a check that could go stale between here and there.
      const eligible = branchEligible.eligible && seenBefore !== null;
      const reason = !branchEligible.eligible
        ? branchEligible.reason
        : seenBefore === null
          ? `${remote}/${branch} was never fetched into this checkout before this call, so there is no tip we can claim to have seen — nothing to lease against`
          : branchEligible.reason;
      forcePublish = {
        diverged,
        eligible,
        // The reason names the half that decided the outcome. "Not diverged" is the common case and
        // says so plainly, because a caller reading `eligible:true, diverged:false` should not have
        // to infer that no lease was spent.
        reason: diverged ? reason : `${remote}/${branch} is an ancestor of ${sha.slice(0, 12)} — a plain fast-forward, no lease needed`,
        // The sha a successful force-publish REPLACES is the one the lease expects: if the remote
        // holds anything else, the push does not happen at all.
        overwrittenSha: diverged ? seenBefore : null,
      };
    }
  }

  // ── The gate ─────────────────────────────────────────────────────────────────────
  // `record: !dryRun` — the approvals consult inside the guard appends an `approval.attempt` ledger
  // row by default, so the one mode that promises to write nothing was writing to the audit trail
  // (D6; the R10 defect `doc-land` shipped and had to fix). `record:false` suppresses that row ONLY:
  // every check still runs and still refuses, so a dry run reports the verdict the real run would.
  //
  // `remote` is threaded in for the same reason the fetch above uses it: every range the gate
  // measures must belong to the remote this call will publish to, or a `--remote` that is not origin
  // gates a different remote's refs than it pushes (PR #287 review, P2).
  const runGuard = opts.guard ?? ((ctx) => pushGuard(ctx.repoDir, ctx.branch, ctx.dbPath, ctx.defaultBranch, { record: ctx.record, remote: ctx.remote, ...(process.env.DEVLOOP_ACTOR ? { actor: process.env.DEVLOOP_ACTOR } : {}) }));
  let guard: PushGuardResult;
  try {
    guard = runGuard({ repoDir, branch, dbPath: opts.dbPath, defaultBranch, record: !dryRun, remote });
  } catch (e) {
    // A gate that threw has not cleared anything. It is exit 3, not 2: the invocation was fine, the
    // evaluation was not.
    return { ...base, branch, sha, forcePublish, gateUnevaluated: `push-guard failed: ${(e as Error).message.split("\n")[0]}` };
  }
  const holds = holdsFrom(guard);
  const gateUnevaluated = guard.unresolvedDefaultBranch
    ? `${remote}/${guard.unresolvedDefaultBranch} does not exist — passenger detection did NOT run, so this gate has not checked what it could have`
    : null;
  if (holds.length > 0 || gateUnevaluated) {
    return { ...base, branch, sha, guard, holds, gateUnevaluated, forcePublish };
  }

  // ── The push ─────────────────────────────────────────────────────────────────────
  // `sha` was read at readiness, before the gate. Publishing it is safe by SUBSET: the guard measured
  // its range against the branch as it stood when the guard ran, which is `sha` or a descendant of
  // it, so the pinned tip is always inside the audited range. Anything committed since is simply not
  // published — reported below rather than swallowed, because a caller who expects their latest
  // commit on the forge must not have to diff the remote to discover it isn't.
  if (!sha) {
    // Unreachable via the readiness checks above (the branch resolved), so this is a guard against a
    // future refactor rather than a live path — but a null sha must not silently fall back to a
    // name-resolved refspec, which is the defect this block exists to close.
    return { ...base, branch, sha, guard, forcePublish, gateUnevaluated: `could not resolve the tip of '${branch}' — refusing to push a ref the gate cannot name` };
  }
  // LOOP-536 — the lease is spent on BOTH halves being true, and on nothing else. A diverged branch
  // that is not eligible gets the plain refspec and git's own rejection: the verb does not escalate
  // silently, and AC4's reason now says why the push failed (§16.8 rule 2).
  const leaseSha = forcePublish?.diverged && forcePublish.eligible ? forcePublish.overwrittenSha : null;
  const argv = pushArgvFor(remote, branch, sha, leaseSha ?? undefined);
  if (dryRun) {
    // Every check above ran and would have refused; the only thing skipped is the mutation. The argv
    // stays null because none was issued — a dry run must not leave a trace that reads like a push.
    return { ...base, branch, sha, guard, forcePublish };
  }
  const r = git(argv);
  if (!r.ok) {
    // LOOP-536 — git's REASON, not its destination banner. The old `split("\n")[0]` reported
    // `To <url>` for every rejection, in the human line and in `--json` alike.
    return { ...base, branch, sha, guard, forcePublish, pushArgv: argv, pushError: pushFailureReason(r.stderr || "git push failed") };
  }
  // Tracking, restored (see `setUpstreamArgvFor`). Reported, never fatal: the push already happened.
  const up = git(setUpstreamArgvFor(remote, branch));
  if (!up.ok) process.stderr.write(`push: pushed, but setting upstream failed: ${up.stderr.split("\n")[0]}\n`);
  const movedTo = git(["rev-parse", branch]);
  const advancedTo = movedTo.ok && movedTo.stdout !== sha ? movedTo.stdout : null;
  return { ...base, branch, sha, guard, forcePublish, pushArgv: argv, pushed: true, ...(advancedTo ? { advancedTo } : {}) };
}

// `dev-loop push` — the gate AND the push under ONE per-repo lock.
//
// D5: the lock is taken unconditionally and under the SAME NAME `dev-loop pr merge` and
// `dev-loop with-repo-lock <ref>` take. A push to `dev-loop/<id>` does not move `defaultBranch`, so
// the push itself has little to race — but the `git fetch` that freshens `origin/<defaultBranch>`
// before the gate reads its range IS a base-clone mutation (§7), and when `--branch` is the default
// branch (the `landing:"direct"` merge-back) this push races `pr merge`'s squash exactly as two
// squashes race each other.
export async function push(repoDir: string, opts: PushOpts = {}): Promise<PushResult> {
  const remote = opts.remote ?? "origin";
  const base: PushResult = {
    pushed: false, nothingToPush: false, branch: opts.branch ?? null, remote, sha: null, holds: [],
    gateUnevaluated: null, guard: null, pushArgv: null, pushError: null, unresolved: null,
    lockUnavailable: null, forcePublish: null, dryRun: opts.dryRun ?? false,
  };

  // CANONICALIZE before matching the registry. The match compares absolute paths by string equality
  // against `join(ws.root, <path>)`, and `ws.root` is canonicalized on resolution — so a repo named
  // through a symlinked ancestor (`/var` → `/private/var` on macOS; any symlinked checkout root)
  // misses its own registry entry and the verb reports "not a registered repo" for a repo that
  // plainly is one. Measured on this ticket's fixture workspace, which lives under `/var/folders/...`.
  const abs = (() => { try { return realpathSync(resolve(repoDir)); } catch { return resolve(repoDir); } })();

  // The default branch is what the gate's passenger range is measured against, so an unresolvable
  // one is a usage failure, not a silent default: guessing "main" here would make the gate measure a
  // range nobody configured (LOOP-119's class).
  //
  // Resolved through the repo's ROOTS, not through this directory alone (PR #287 review, P1). §7 runs
  // every dev-tier ship in a linked worktree — this verb's whole reason to exist is to be the push in
  // that sequence — and a worktree equals no registered `path`, so the exact-path match answered "not
  // a registered repo" for the one invocation the verb was built for. Worse than the exit 2 Codex
  // named: `pushGuard` resolves `approvals.enforce` from the same path, so the gate this ticket
  // exists to install would have resolved itself OFF there. One matcher, so it cannot.
  let defaultBranch = opts.defaultBranch;
  if (!defaultBranch) {
    defaultBranch = resolveDefaultBranchForRepoDir(abs);
    if (!defaultBranch) {
      return { ...base, unresolved: `cannot resolve the default branch for '${repoDir}' — neither it nor the repo it belongs to is registered in this workspace; pass --default-branch <name>` };
    }
  }

  const lockPath = opts.lockPath ?? repoLandingLockPath(abs, resolveGhRepo(abs));
  let release: () => void;
  try {
    release = await acquireRepoLock(lockPath, { totalMs: opts.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (e) {
    // FAIL CLOSED. The most likely reason the lock is held is that another fire is landing in this
    // repo right now, which is the precise condition under which pushing on top is unsafe. A gate
    // that could not lock has not gated, and it says so with its own exit code instead of pushing.
    return { ...base, lockUnavailable: (e as Error).message };
  }
  try {
    return pushUnlocked(abs, defaultBranch, { ...opts, defaultBranch });
  } finally { release(); }
}

// The exit code for a result, so the CLI and any programmatic caller cannot disagree about it.
export function pushExit(r: PushResult): number {
  // First, because a lock failure means NOTHING ran: no class was read, no push attempted.
  if (r.lockUnavailable) return PUSH_EXIT.lockUnavailable;
  if (r.unresolved) return PUSH_EXIT.usage;
  // Holds outrank `gateUnevaluated` (as in `pr merge`) because an objection somebody must answer is
  // more actionable than "I could not check everything" — and EVERY refusing class is printed either
  // way, so nothing is hidden by the precedence.
  if (r.holds.length > 0) return PUSH_EXIT.held;
  if (r.gateUnevaluated) return PUSH_EXIT.unevaluated;
  if (r.pushError) return PUSH_EXIT.pushFailed;
  return PUSH_EXIT.pushed;
}

const HELP = `dev-loop push — gate AND publish a branch in ONE call (LOOP-521).

Usage: dev-loop push [--repo <dir>] [--branch <b>] [--remote <name>] [--default-branch <b>]
                     [--dry-run] [--lock-wait <dur>] [--json]
  --repo <dir>       repo directory (default: cwd)
  --branch <b>       branch to push (default: the checked-out branch)
  --remote <name>    remote to push to (default: origin)
  --default-branch   the default branch the gate measures passengers against (resolved from
                     workspace config when omitted)
  --dry-run          run every check and report the verdict the real run would. It writes nothing
                     OUTWARD: not the remote, not the approvals ledger. It DOES run the same
                     \`git fetch\` (updating remote-tracking refs) — the verdict is measured against
                     the base the real run would use, or it is not that verdict
  --lock-wait        how long to wait for another fire's landing to finish (default 120s)
  --json             emit the result as JSON

This is \`push-guard --strict\` AND \`git push\` as ONE operation: the guard's classes run inside
this call and the push happens only when they all clear. THERE IS NO FLAG THAT WAIVES THE GATE —
that skippability is the defect this verb exists to remove (the pr-mode ship path called the guard
nowhere at all, so \`approvals.enforce: ["push"]\` reached no reader). It does NOT open the PR.

Every guard class hard-stops: ride-along commits referencing Canceled/Duplicate tickets, passenger
commits not attributable to this branch's ticket, §17 governing-file edits, and an ungranted
\`push:<branch>:<sha>\` approval when team.approvals.enforce lists \`push\`. \`doc-land\` downgrades
reference findings to a warning and EARNS that with its docs-only range assertion; this verb makes
no such assertion, so it inherits no such downgrade.

Nothing to push is a SUCCESS in its own words (exit 0), not a refusal — re-running after a
successful push says so instead of printing nothing.

A REBASED branch is published under a lease. §12c prescribes a rebase as the remedy for a stale
ciFreshness hold or a DIRTY mergeStateStatus, and a rebased branch is by construction not a
fast-forward of what is on the remote. So when the branch has diverged from \`<remote>/<branch>\`
AND it is a \`dev-loop/<ticket-id>\` branch, the push carries
\`--force-with-lease=refs/heads/<branch>:<the sha the fetch above saw>\`: a concurrent writer's push
makes it FAIL rather than be overwritten. THERE IS NO BARE \`--force\`, and no flag adds one. The
default branch and any non-\`dev-loop/\` branch are never force-published, whatever the divergence —
those pushes stay plain, and git's own rejection is reported with its reason.

The gate AND the push run under ONE per-repo lock this verb takes itself — the same lock
\`dev-loop pr merge\` and \`dev-loop with-repo-lock <ref>\` take, because the \`git fetch\` that
freshens the base before the gate reads its range is a base-clone mutation (§7).

Exit codes (the name after each number is its key in PUSH_EXIT, which a test pins against this text):
  0 pushed           the branch was pushed — or there was nothing to push (idempotent)
  1 held             the gate refused; every refusing class is named, one line + machine token each
  2 usage            bad invocation, or the repo/default branch could not be resolved
  3 unevaluated      the gate could not evaluate what it could have (origin/<defaultBranch> missing,
                     so passenger detection never ran) — a different remedy in kind from a refusal
  4 pushFailed       the gate cleared and \`git push\` itself failed (a remote error, not an objection)
  5 lockUnavailable  the per-repo landing lock could not be taken, so the gate never ran — re-run
\`dev-loop push-guard\`'s own exit contract is unchanged — this adds a caller.`;

// The exit table above, parsed back out: `hub/test/push-verb.ts` asserts this equals PUSH_EXIT, so
// the help cannot drift from the codes it documents (AC3; the hub/test/cli-cheatsheet.ts pattern).
// Exported rather than duplicated in the test — one parser, one answer.
export function documentedExitCodes(help: string = HELP): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of help.matchAll(/^ {2}(\d) ([A-Za-z]+) /gm)) out[m[2]!] = Number(m[1]);
  return out;
}
export const PUSH_HELP = HELP;

if (isMainEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  let repo = process.cwd();
  let branch: string | undefined;
  let remote: string | undefined;
  let explicitDefaultBranch: string | undefined;
  let dryRun = false;
  let asJson = false;
  let lockWaitMs: number | undefined;
  // LOOP-528 — every value-taking flag reads its value through this, so a flag standing LAST on the
  // line is a usage error rather than its own default. `argv[++i]` alone returns undefined there, and
  // each of these flags treats undefined as "not passed": `dev-loop push --branch` pushed the current
  // branch, and `--remote` published to origin, in both cases naming something the caller did not.
  // A flag the caller typed and the parser dropped must not be a silent success.
  const valueFor = (flag: string, i: number): string => {
    const v = argv[i + 1];
    // A following flag is not a value: `--branch --dry-run` is the same typo one token later.
    if (v === undefined || v.startsWith("--")) { console.error(`dev-loop push: ${flag} needs a value`); process.exit(PUSH_EXIT.usage); }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo") { repo = valueFor(a, i); i++; }
    else if (a === "--branch") { branch = valueFor(a, i); i++; }
    else if (a === "--remote") { remote = valueFor(a, i); i++; }
    else if (a === "--default-branch") { explicitDefaultBranch = valueFor(a, i); i++; }
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") asJson = true;
    else if (a === "--lock-wait") {
      const v = valueFor(a, i); i++;
      const m = v.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);   // the `with-repo-lock --wait` grammar
      if (!m) { console.error(`dev-loop push: invalid --lock-wait duration '${v}'`); process.exit(PUSH_EXIT.usage); }
      const u = m[2] ?? "s";
      lockWaitMs = Math.round(Number(m[1]) * (u === "ms" ? 1 : u === "s" ? 1000 : u === "m" ? 60000 : 3600000));
    }
    else if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
    else { console.error(`dev-loop push: unknown option '${a}'`); process.exit(PUSH_EXIT.usage); }
  }
  if (!repo) { console.error("dev-loop push: --repo needs a path"); process.exit(PUSH_EXIT.usage); }

  let result: PushResult;
  try {
    result = await push(repo, {
      ...(branch !== undefined ? { branch } : {}),
      ...(remote !== undefined ? { remote } : {}),
      ...(explicitDefaultBranch !== undefined ? { defaultBranch: explicitDefaultBranch } : {}),
      ...(lockWaitMs !== undefined ? { lockWaitMs } : {}),
      dryRun,
    });
  } catch (e) {
    console.error(`dev-loop push: ${(e as Error).message.split("\n")[0]}`);
    process.exit(PUSH_EXIT.usage);
  }

  const exit = pushExit(result);
  const label = result.dryRun ? "push (dry-run)" : "push";
  if (asJson) {
    console.log(JSON.stringify({ ...result, exit }, null, 2));
  } else if (result.unresolved) {
    console.error(`push: ${result.unresolved}`);
  } else if (result.lockUnavailable) {
    // Named as a retry, not an objection: no class ran and nothing was written.
    console.error(`push: ⛔ another fire is landing in this repo — '${result.branch ?? "the branch"}' was NOT pushed and the gate never ran (${result.lockUnavailable})`);
    console.error("  Re-run once the other landing finishes; it will gate the branch against the base that fire leaves behind.");
  } else if (result.holds.length > 0 || result.gateUnevaluated) {
    console.error(`push: ⛔ HELD — '${result.branch}' was NOT pushed:`);
    for (const h of result.holds) console.error(`  [${h.token}] ${h.class}: ${h.detail}`);
    if (result.gateUnevaluated) console.error(`  [unresolved-default-branch] ${result.gateUnevaluated}`);
    console.error("  There is no flag that waives this gate. Fix the cause named above and re-run.");
  } else if (result.nothingToPush) {
    console.log(`${label}: nothing to push — ${result.remote}/${result.branch} already carries ${result.branch} (${result.sha?.slice(0, 12) ?? "?"})`);
  } else if (result.pushError) {
    console.error(`push: the gate CLEARED but \`git ${result.pushArgv?.join(" ")}\` failed — ${result.pushError}`);
    // LOOP-536 — the one failure the verb can explain rather than merely relay. A diverged branch it
    // declined to force-publish would otherwise report a bare `(non-fast-forward)` and leave the
    // caller to guess whether the verb tried and failed or never tried.
    if (result.forcePublish?.diverged && !result.forcePublish.eligible) {
      console.error(`  ${result.branch} has diverged from ${result.remote}/${result.branch}, and this verb did NOT force-publish it: ${result.forcePublish.reason}.`);
      console.error("  Republishing it is a history rewrite somebody else owns — do it yourself, deliberately, or re-target the work onto a dev-loop/<ticket-id> branch.");
    }
  } else if (result.dryRun) {
    const wouldForce = result.forcePublish?.diverged && result.forcePublish.eligible
      ? ` It has diverged from ${result.remote}/${result.branch}, so the real run would republish it under a lease pinned to ${result.forcePublish.overwrittenSha?.slice(0, 12)} — the sha it would overwrite.`
      : "";
    console.log(`push (dry-run): the gate CLEARS — would push ${result.branch} (${result.sha?.slice(0, 12) ?? "?"}) to ${result.remote}.${wouldForce} Nothing was written outward: not the remote, not the approvals ledger (the base was fetched, as the real run would).`);
  } else {
    console.log(`push: ✅ gate clear — pushed ${result.branch} (${result.sha?.slice(0, 12) ?? "?"}) to ${result.remote}`);
    // The force-publish receipt the operator reads (§16.8 rule 3): a push that REPLACED a published
    // sha says which one, in its own output, rather than describing an append that did not happen.
    if (result.forcePublish?.diverged && result.forcePublish.eligible) {
      console.log(`  force-published under a lease: this REPLACED ${result.forcePublish.overwrittenSha?.slice(0, 12)} on ${result.remote}/${result.branch}. The lease held, so no other writer's commit was overwritten.`);
    }
    // The refspec is pinned to the audited sha, so a commit made while the gate ran is still local.
    // Said out loud: the alternative is a caller who believes their newest commit is on the forge.
    if (result.advancedTo) console.log(`  note: ${result.branch} has since advanced to ${result.advancedTo.slice(0, 12)} — that commit was NOT gated and NOT pushed; re-run to publish it.`);
  }
  process.exit(exit);
}
