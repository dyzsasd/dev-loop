#!/usr/bin/env node
// dev-loop doc-land — land PM's doc-only progress commits to origin/<defaultBranch>
// under landing:"pr" (design: landing-discipline §4.6, LOOP-57).
// Step-3 finding split: reference findings (Canceled/Duplicate ticket refs in commit prose) →
// WARN + land with annotation; passenger findings → hard stop, unchanged.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { isMainEntry } from "./is-entry.ts";
import { dirname, join } from "node:path";
import { resolveWorkspace, wsLockPath, resolveHubDbPath, resolveRepoFromCwd } from "./workspace.ts";
import { effectiveRepo, inferProjectForRepo } from "./team-config.ts";
import { pushGuard, approvalRefusalLine } from "./push-guard.ts";
import { withRepoLockPath } from "./locks.ts";

function die(msg: string, code = 1): never {
  process.stderr.write(`doc-land: ${msg}\n`); process.exit(code);
}

// Extract a repo-relative path from a project's strategyDoc DocRef.
// Returns null for non-file forms (hubDoc, linearDocument, Linear URL strings).
function strategyDocRelPath(strategyDoc: unknown): string | null {
  if (typeof strategyDoc === "string") {
    if (/linear\.app\/.*\/document\//.test(strategyDoc)) return null;
    return strategyDoc.trim() || null;
  }
  if (strategyDoc && typeof strategyDoc === "object") {
    const p = (strategyDoc as { path?: unknown }).path;
    if (typeof p === "string" && p.trim()) return p;
  }
  return null;
}

// Pull git's real diagnostics out of an execFileSync failure. git writes the actual reason
// (conflict paths, rejection hints) to stderr/stdout; the thrown Error.message is only
// "Command failed: <cmd>". A swallowed error is indistinguishable from a factual answer
// (LOOP-118 inherited scope), so surface the captured streams, not just message's first line.
function gitErrText(e: unknown): { summary: string; detail: string } {
  const err = e as { message?: string; stderr?: unknown; stdout?: unknown };
  const streams = [err.stderr, err.stdout]
    .map((s) => (s == null ? "" : String(s).trim()))
    .filter(Boolean);
  const detail = (streams.join("\n") || err.message || String(e)).trim();
  const summary = detail.split("\n")[0] || (err.message ?? "").split("\n")[0];
  return { summary, detail };
}

// LOOP-326 — `git status --porcelain` output → the paths blocking a rebase.
//
// The bug this replaces was a COMPOSITION bug, which is why the parsing is its own exported
// function now: two individually-correct lines. The shared `git()` helper ends in `.trim()` (right
// for `rev-parse`/`rev-list` and every other single-value call in this file), and the caller then
// did `l.slice(3)` per line. Porcelain v1 emits `XY<space>PATH`, and for an unstaged-only change
// column X is a SPACE — ` M hub/src/agentops.ts`. Trimming the whole BUFFER strips that leading
// space from the first line only, so line 1 became `M hub/src/agentops.ts` and `slice(3)` ate
// `M h`: the refusal that tells you which paths to resolve named `ub/src/agentops.ts`, a path that
// does not exist. Every later line kept its space and parsed correctly, which is how it survived —
// the defect is conditional on the FIRST entry being unstaged-only.
/**
 * Rebase onto origin WITHOUT touching the shared checkout (LOOP-325).
 *
 * A temp worktree detached at `refs/heads/<defaultBranch>` does the rebase, and the shared branch
 * ref is moved afterwards with `update-ref`. That call moves the ref only — no working-tree write,
 * no index write — so the unrelated modifications the caller measured stay byte-identical on disk.
 * Their staged/HEAD content is identical either side of the rebase (the rebase did not touch those
 * paths), so `git status` reports exactly what it reported before.
 *
 * LOOP-369 — it used to build the worktree from `HEAD`, i.e. from whatever the SHARED CHECKOUT
 * happened to have checked out, while every check around it read `origin/<db>...<db>`. With the
 * checkout on a feature branch the verb rebased that branch and then wrote the result over
 * `refs/heads/<db>`, destroying what the branch held — including the doc commit it was invoked to
 * land — and, because the range was empty afterwards, reported success. Measured on 2026-08-06:
 * `refs/heads/main` moved BACKWARDS from `915496c` to `1a4e9d6` and the doc commit became
 * unreachable from every ref, under the line `doc-land: landed`.
 *
 * The input is now the branch ref. Two guards make the whole class non-silent even if some other
 * cause ever empties the range: the rebase may not lose commits (`beforeShas` minus the ones
 * `git cherry` says are already upstream must survive), and the ref move is a compare-and-swap
 * against the value read before the rebase, so a concurrent writer causes a refusal, not a lost
 * update. Neither guard can be satisfied by destroying the work it is measuring.
 *
 * The worktree is removed on EVERY exit path. Leaving one behind would itself be the LOOP-132 defect
 * this session just added a doctor code for.
 */
function isolatedRebase(
  repoDir: string, defaultBranch: string, gitIdArgs: string[], dirtyPaths: string[],
): { ok: true; alreadyUpstream: number } | { ok: false; blockedMsg: string } {
  const g = (dir: string, args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const lines = (s: string): string[] => s.split("\n").filter(Boolean);
  // Read the ref — never HEAD — and pin its value for the compare-and-swap (AC3).
  let before: string;
  try { before = g(repoDir, ["rev-parse", `refs/heads/${defaultBranch}`]); }
  catch (e) { return { ok: false, blockedMsg: `could not read refs/heads/${defaultBranch} before rebasing: ${gitErrText(e).summary}` }; }
  // What the branch is carrying, and which of it origin already has BY PATCH. `git cherry` marks
  // the latter with a leading '-': those are the commits a rebase may legitimately empty (AC4).
  const beforeShas = lines(g(repoDir, ["rev-list", `origin/${defaultBranch}..${defaultBranch}`]));
  let alreadyUpstream = 0;
  try { alreadyUpstream = lines(g(repoDir, ["cherry", `origin/${defaultBranch}`, defaultBranch])).filter((l) => l.startsWith("-")).length; }
  catch { /* cherry is advisory; a failure just makes the guard below stricter */ }
  const wt = join(tmpdir(), `dev-loop-docland-${process.pid}-${Math.trunc(performance.now() * 1000)}`);
  try {
    g(repoDir, ["worktree", "add", "--detach", "-q", wt, `refs/heads/${defaultBranch}`]);
  } catch (e) {
    return { ok: false, blockedMsg: `could not create an isolated worktree to rebase in (the shared checkout has ${dirtyPaths.length} unrelated dirty path(s), so rebasing in place would destroy them): ${gitErrText(e).summary}` };
  }
  try {
    try {
      g(wt, [...gitIdArgs, "rebase", `origin/${defaultBranch}`]);
    } catch (e) {
      try { g(wt, ["rebase", "--abort"]); } catch { /* best-effort */ }
      return { ok: false, blockedMsg: `rebase onto origin/${defaultBranch} failed in an isolated worktree — the shared checkout was never written and its ${dirtyPaths.length} unrelated dirty path(s) are untouched. git says: ${gitErrText(e).summary}` };
    }
    const rebased = g(wt, ["rev-parse", "HEAD"]);
    // AC2 — a rebase may REWRITE commits; it may not make them vanish. Anything that was ahead and
    // is not accounted for by patch-equivalence went missing, and the ref must not move.
    const afterShas = lines(g(wt, ["rev-list", `origin/${defaultBranch}..${rebased}`]));
    const expected = beforeShas.length - alreadyUpstream;
    if (afterShas.length < expected) {
      const afterSubjects = new Set(afterShas.map((s) => g(wt, ["log", "-1", "--format=%s", s])));
      const missing = beforeShas
        .map((s) => ({ sha: s, subject: g(repoDir, ["log", "-1", "--format=%s", s]) }))
        .filter((c) => !afterSubjects.has(c.subject));
      return {
        ok: false,
        blockedMsg: `REFUSED — rebasing onto origin/${defaultBranch} would drop ${expected - afterShas.length} commit(s) that origin does not already have. `
          + `refs/heads/${defaultBranch} was NOT moved and still points at ${before.slice(0, 12)}. Missing:\n`
          + missing.map((c) => `  ${c.sha.slice(0, 12)} ${c.subject}`).join("\n"),
      };
    }
    // AC3 — compare-and-swap: pass the value read before the rebase, so a writer that moved the
    // branch in the meantime makes this fail instead of silently overwriting their work.
    try { g(repoDir, ["update-ref", `refs/heads/${defaultBranch}`, rebased, before]); }
    catch (e) {
      return { ok: false, blockedMsg: `rebased cleanly but ${defaultBranch} moved underneath us (expected it at ${before.slice(0, 12)}) — refusing to overwrite the newer value; re-run: ${gitErrText(e).summary}` };
    }
    return { ok: true, alreadyUpstream };
  } finally {
    try { g(repoDir, ["worktree", "remove", "--force", wt]); } catch { /* best-effort */ }
    try { rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export function parseDirtyPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.trim())        // drop blank lines — NEVER trim the buffer or a line's prefix
    .map((l) => l.slice(3).trim())  // XY<space> is exactly 3 columns; the path is what follows
    .filter(Boolean);
}

export async function docLand(argv: string[]): Promise<number> {
  let repoRef: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") { repoRef = argv[++i]; }
    else if (a === "--dry-run") { dryRun = true; }
    else if (a === "--help" || a === "-h") {
      console.log(`dev-loop doc-land — land PM doc-only progress commits to origin/<defaultBranch>

Usage: dev-loop doc-land [--repo <ref>] [--dry-run]
  --repo <ref>   repo ref to operate on (default: inferred from cwd)
  --dry-run      print what would push without mutating anything

Asserts origin/<defaultBranch>..<defaultBranch> touches ONLY the project's configured
strategyDoc path (+ its strategy-archive/ sibling). Fetches, rebases if diverged, runs
push-guard (reference findings downgraded to WARN; passengers hard-stop), then pushes
ff-only. One retry on rejection. Never force-pushes.
Design: landing-discipline §4.6 (LOOP-57).`);
      return 0;
    }
    else { die(`unknown option '${a}'`, 2); }
  }

  const ws = resolveWorkspace();

  // ── Resolve the repo ref ────────────────────────────────────────────────────────
  let ref: string;
  if (repoRef) {
    if (!ws.file.repos[repoRef]) die(`repo '${repoRef}' not registered in workspace '${ws.file.team.key}'`, 2);
    ref = repoRef;
  } else {
    const inferred = resolveRepoFromCwd(ws, process.cwd());
    if (!inferred) die("cannot infer repo from cwd — use --repo <ref>", 2);
    ref = inferred;
  }

  const repo = effectiveRepo(ws, ref);
  const repoDir = repo.absPath;
  // §19 fallback chain (repos.<ref>.defaultBranch → team.git.defaultBranch → "main"), resolved onto
  // the ResolvedRepo by LOOP-70/LOOP-107 (team-config.ts:494,503). No hardcoded branch here (LOOP-119).
  const defaultBranch = repo.defaultBranch;

  // ── Resolve strategyDoc path from the project that owns this repo ───────────────
  const infer = inferProjectForRepo(ws, ref);
  if (infer.kind === "none") die(`repo '${ref}' is not referenced by any project`, 1);
  if (infer.kind === "ambiguous") die(`repo '${ref}' is referenced by multiple projects (${infer.candidates.join(", ")}) — configure a unique project owner or use an explicit project assignment`, 1);
  const project = ws.file.projects[infer.key];
  const docRel = strategyDocRelPath(project?.strategyDoc);
  if (!docRel) die(`project '${infer.key}' has no repo-file strategyDoc configured — doc-land requires strategyDoc: { path: "..." } or a plain string path (not a hubDoc or linearDocument)`, 1);

  // Allowed paths: the strategyDoc file itself + its strategy-archive/ sibling directory
  const archivePrefix = join(dirname(docRel), "strategy-archive") + "/";

  const git = (args: string[]): string =>
    execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const gitOk = (args: string[]): boolean => { try { git(args); return true; } catch { return false; } };
  // Provide fallback identity flags for git rebase in environments without a global git config
  // (e.g., CI runners). Only used if no identity is found; never overrides a configured identity.
  const gitIdArgs = gitOk(["config", "user.email"]) ? [] as string[]
    : ["-c", "user.email=dev-loop@local", "-c", "user.name=dev-loop"];

  // If there's no remote origin/<defaultBranch>, nothing to land
  if (!gitOk(["rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`])) {
    console.log(`doc-land: no remote origin/${defaultBranch} — nothing to land`);
    return 0;
  }

  // ── Step 1: docs-only path assertion (load-bearing; do not widen the allowlist) ─
  // Runs BEFORE the lock — we fail fast on non-doc content without taking shared resources.
  // Three-dot (merge-base..HEAD) = exactly the paths OUR commits touch. Two-dot is a tree compare
  // that ALSO names files from origin's own commits we don't have — so any CODE commit landing on
  // origin/<defaultBranch> (the normal state of this repo: the loop lands dev PRs continuously) made
  // step-1 name another agent's file as PM's offender and refuse a legitimate doc-only landing before
  // the rebase could align the trees (LOOP-119). The load-bearing fence below is UNCHANGED: a non-doc
  // commit authored locally is still inside merge-base..HEAD and is still caught.
  const diffOutput = git(["diff", "--name-only", `origin/${defaultBranch}...${defaultBranch}`]);
  const changedFiles = diffOutput ? diffOutput.split("\n").filter(Boolean) : [];

  if (changedFiles.length === 0) {
    console.log(`doc-land: origin/${defaultBranch} is already up to date — nothing to land`);
    return 0;
  }

  const offenders = changedFiles.filter((f) => f !== docRel && !f.startsWith(archivePrefix));
  if (offenders.length) {
    process.stderr.write(`doc-land: REFUSED — range touches non-doc path(s) (load-bearing docs-only assertion):\n`);
    for (const o of offenders) process.stderr.write(`  ${o}\n`);
    process.stderr.write(`  allowed: '${docRel}' and '${archivePrefix}*'\n`);
    process.stderr.write(`doc-land: only strategyDoc progress commits may land via this verb\n`);
    return 1;
  }

  const dbPath = resolveHubDbPath(repoDir);
  const lockPath = wsLockPath(ws, `repo-${ref}`);

  // ── Steps 2–4 under the §7 repo lock (serializes fetch/rebase/push) ────────────
  return await withRepoLockPath(lockPath, { totalMs: 60_000 }, async () => {
    const attempt = async (): Promise<{ ok: boolean; blockedMsg?: string; isRejection?: boolean; landed?: number }> => {
      // Step 2: fetch + rebase if origin has moved ahead
      try { git(["fetch", "origin", defaultBranch]); }
      catch (e) { process.stderr.write(`doc-land: fetch warning: ${gitErrText(e).summary}\n`); }

      // Narrow the fault boundary (LOOP-118): rev-list (cheap, read-only) is separated from the rebase
      // so a rev-list failure is never mislabelled "rebase failed".
      // LOOP-369 — `entryAhead` is what this attempt SET OUT to land. Success is then a statement
      // about what was pushed, not an observation that the range ended up empty: the clobber emptied
      // the range by destroying it, and the old code read that emptiness as "landed".
      let behind = 0;
      let entryAhead = 0;
      let alreadyUpstream = 0;
      try {
        const counts = git(["rev-list", "--left-right", "--count", `origin/${defaultBranch}...${defaultBranch}`]);
        const [b, a] = (counts || "0\t0").split("\t").map(Number);
        behind = b || 0;
        entryAhead = a || 0;
      } catch (e) {
        return { ok: false, blockedMsg: `could not compare with origin/${defaultBranch}: ${gitErrText(e).summary}` };
      }
      if (behind > 0) {
        if (dryRun) {
          console.log(`doc-land (dry-run): would rebase ${behind} commit(s) from origin/${defaultBranch}`);
        } else {
          // AC1/AC2/AC3/AC6 (LOOP-217): preflight the tree before rebase to name the real blocker.
          // git refuses to rebase with either unmerged index entries or unstaged/uncommitted changes;
          // without this preflight, every such failure is mislabelled as a doc prose conflict.

          // AC1: unmerged index entries are a hard wedge — they won't self-clear, block immediately.
          let unmergedOut = "";
          try { unmergedOut = git(["ls-files", "--unmerged"]); } catch { /* ignore */ }
          if (unmergedOut.trim()) {
            const unmergedPaths = [...new Set(
              unmergedOut.trim().split("\n").map(l => l.split("\t")[1]).filter(Boolean)
            )];
            return {
              ok: false,
              blockedMsg: `unmerged index ${unmergedPaths.length === 1 ? "entry" : "entries"} must be resolved before re-running (rebase not attempted) — path(s): ${unmergedPaths.join(", ")}`,
            };
          }

          // LOOP-325 — the preflight used to block on ANY dirty tracked path, so PM's strategy-doc
          // commit sat unlandable for two fires while the doc ITSELF was clean and the shared
          // checkout cycled 7–9 unrelated dirty files mid-fire. Those paths have nothing to do with
          // this rebase, and waiting 30s for a shared tree that is dirty by design is a wait that
          // never ends.
          //
          // Three populations, three answers:
          //   • the DOC or its archive sibling is dirty  ⇒ REFUSE. That is an unlanded edit, and
          //     landing around it would silently drop someone's work.
          //   • unrelated tracked paths are dirty        ⇒ rebase in a TEMPORARY WORKTREE, so the
          //     shared checkout is never written and those edits survive byte-identical.
          //   • clean                                     ⇒ the in-place rebase, unchanged.
          const getDirtyPaths = (): string[] => {
            try {
              // NOT the shared `git()` helper: it ends in .trim(), which is right for every
              // single-value call in this file and wrong here (LOOP-326). Parsing lives in the
              // exported pure function below so the composition itself is testable.
              const out = execFileSync("git", ["-C", repoDir, "status", "--porcelain", "--untracked-files=no"],
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
              return parseDirtyPaths(out);
            } catch { return []; }
          };
          const dirtyPaths = getDirtyPaths();
          const dirtyDoc = dirtyPaths.filter((p) => p === docRel || p.startsWith(archivePrefix));
          if (dirtyDoc.length > 0) {
            return {
              ok: false,
              blockedMsg: `'${dirtyDoc.join(", ")}' has uncommitted changes — that is an unlanded doc edit, and landing around it would silently drop it. Commit or discard it, then re-run. (Distinct from an unmerged-index wedge: nothing is conflicted, the edit simply is not committed.)`,
            };
          }
          // LOOP-369 — the in-place rebase below is `git rebase origin/<db>` in the shared checkout,
          // so it rebases whatever is CHECKED OUT. That is the same wrong-branch defect one step
          // earlier, and the explicit `rebase <upstream> <branch>` form is not the answer: it checks
          // the branch out, writing the shared checkout that LOOP-325 exists to leave alone. So the
          // in-place fast path is reserved for the exact condition it was written for — clean tree,
          // already on the default branch — and everything else goes through the isolated rebase,
          // whose input is the ref.
          let headBranch = "";
          try { headBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]); } catch { /* detached or worse ⇒ isolate */ }
          const rebaseInWorktree = dirtyPaths.length > 0 || headBranch !== defaultBranch;

          // The isolated path: never write the shared checkout. A temp worktree detached at HEAD
          // rebases onto origin, the result is pushed from there, and the shared branch ref is
          // fast-forwarded with update-ref — which touches neither the working tree nor the index,
          // so the unrelated edits stay exactly as they are on disk.
          if (rebaseInWorktree) {
            const iso = isolatedRebase(repoDir, defaultBranch, gitIdArgs, dirtyPaths);
            if (!iso.ok) return { ok: false, blockedMsg: iso.blockedMsg };
            alreadyUpstream = iso.alreadyUpstream;
          } else try {
            git([...gitIdArgs, "rebase", `origin/${defaultBranch}`]);
          } catch (e) {
            // Check which paths are conflicted BEFORE aborting (abort clears the index state).
            // AC2: only emit the "prose merge" message when the doc path is genuinely conflicted.
            let conflictPaths: string[] = [];
            try {
              const ls = git(["ls-files", "--unmerged"]);
              conflictPaths = [...new Set(ls.split("\n").map(l => l.split("\t")[1]).filter(Boolean))];
            } catch { /* ignore */ }

            // Restore the shared checkout (LOOP-118); swallow abort's error ("no rebase in progress" ok).
            try { git(["rebase", "--abort"]); } catch { /* best-effort restore */ }

            const { summary, detail } = gitErrText(e);
            const extra = detail && detail !== summary ? `\n  ${detail.replace(/\n/g, "\n  ")}` : "";
            const docConflicted = conflictPaths.some(p => p === docRel || p.startsWith(archivePrefix));
            if (docConflicted) {
              // Genuine prose conflict in the strategy doc — only case warranting manual reconcile.
              return {
                ok: false,
                blockedMsg:
                  `doc content conflicts with origin/${defaultBranch} and cannot be auto-merged — ` +
                  `'${docRel}' must be reconciled by hand (a human/PM prose merge) against origin, then re-run. ` +
                  `The rebase was aborted and the checkout restored to its pre-rebase state.\n  git says: ${summary}${extra}`,
              };
            }
            // Non-doc cause: name the real blocker so the operator does not hand-edit the wrong file.
            const realPaths = conflictPaths.length > 0 ? conflictPaths.join(", ") : "(see git output)";
            return {
              ok: false,
              blockedMsg:
                `rebase blocked by a non-doc path — the checkout was restored. ` +
                `Resolve ${realPaths} and re-run.\n  git says: ${summary}${extra}`,
            };
          }
        }
      }

      // Step 3: push-guard with doc-land finding split
      // doc-land works on the defaultBranch itself, not a dev-loop/<id> branch,
      // so passenger detection (which keys on the dev-loop/<id> branch shape) naturally returns [].
      // We still check passengers for future-safety: if A2 or another caller extends detection here,
      // the hard-stop gate is in place.
      const guard = pushGuard(repoDir, defaultBranch, dbPath, defaultBranch);

      // Passengers → hard stop (unchanged from push-guard default behaviour)
      if (guard.passengers.length) {
        process.stderr.write(`doc-land: STOPPED — push-guard passenger finding(s):\n`);
        for (const p of guard.passengers) process.stderr.write(`  ⛔ passenger: ${p.sha} "${p.subject}"\n`);
        return { ok: false, blockedMsg: "push-guard: passenger commit found — drop it before landing" };
      }

      // Approvals → hard stop (LOOP-394). The step-1 docs-only assertion is what lets reference
      // findings below degrade to a warning, and it buys nothing here: "this range is only docs" says
      // nothing about whether the human has authorised publishing it. A `push:` row on the ticket is
      // the operator's statement that this work awaits them, and doc-land pushes to defaultBranch.
      if (guard.approvals.length) {
        process.stderr.write(`doc-land: STOPPED — the approvals gate refused this push:\n`);
        for (const a of guard.approvals) process.stderr.write(`  ${approvalRefusalLine(a)}\n`);
        return { ok: false, blockedMsg: "push-guard: this commit awaits human approval — not landed" };
      }

      // Reference findings (Canceled/Duplicate ticket refs in commit prose) →
      // downgrade to WARN: the step-1 docs-only assertion already guarantees these are reportage,
      // not published canceled work (a docs-only range cannot smuggle canceled work through prose).
      if (guard.findings.length) {
        console.log(`doc-land: push-guard reference finding(s) downgraded to WARN (step-1 docs-only assertion passed):`);
        for (const f of guard.findings)
          console.log(`  ⚠️  ${f.sha} "${f.subject}" references ${f.ticket} (${f.state}) — landing with annotation`);
      }

      if (dryRun) {
        const aheadCount = git(["rev-list", "--count", `origin/${defaultBranch}..${defaultBranch}`]);
        const refNote = guard.findings.length ? ` (${guard.findings.length} reference finding(s) annotated, not blocked)` : "";
        console.log(`doc-land (dry-run): would push ${aheadCount} commit(s) to origin/${defaultBranch} ff-only${refNote}`);
        return { ok: true };
      }

      // Step 4: ff-only push (never force)
      // LOOP-369 — count what is actually about to be pushed, so the success line can state it.
      let toPush = 0;
      try { toPush = Number(git(["rev-list", "--count", `origin/${defaultBranch}..${defaultBranch}`])) || 0; }
      catch (e) { return { ok: false, blockedMsg: `could not count the commits to push: ${gitErrText(e).summary}` }; }
      // AC4 — the one legitimate way to enter with commits and push none: origin already has them by
      // patch, so the rebase emptied them. That is reported in its OWN words and is not a land. It is
      // distinguishable from AC2's refusal, which exits non-zero and names commits as MISSING.
      if (toPush === 0) {
        // Step 1 runs before the fetch, against a possibly-stale origin ref, so "nothing to land"
        // can only be settled here. Either way the verb SAYS which of the two it was — an exit 0
        // that prints nothing is the same unreadable silence as a wrong success line.
        console.log(entryAhead > 0
          ? `doc-land: nothing new to land — the ${entryAhead} commit(s) on ${defaultBranch} are already upstream${alreadyUpstream > 0 ? ` (${alreadyUpstream} patch-equivalent to origin)` : ""}; origin/${defaultBranch} already carries this work`
          : `doc-land: origin/${defaultBranch} is already up to date — nothing to land`);
        return { ok: true, landed: 0 };
      }
      try {
        git(["push", "origin", `${defaultBranch}:${defaultBranch}`]);
        return { ok: true, landed: toPush };
      } catch (e) {
        return { ok: false, blockedMsg: `push rejected: ${gitErrText(e).summary}`, isRejection: true };
      }
    };

    // LOOP-369 — the success line states what was PUSHED. A run that entered with commits and pushed
    // none has no path to it: it either took AC4's already-upstream line above or refused.
    const landedLine = (r: { landed?: number }, suffix = ""): void => {
      if (dryRun || !r.landed) return;
      console.log(`doc-land: landed ${r.landed} commit(s) to origin/${defaultBranch}${suffix}`);
    };

    const first = await attempt();
    if (first.ok) {
      landedLine(first);
      return 0;
    }

    // Retry ONCE if and only if the push itself was rejected (concurrent activity on origin)
    if (first.isRejection) {
      process.stderr.write(`doc-land: push rejected — retrying once from fetch...\n`);
      const second = await attempt();
      if (second.ok) {
        landedLine(second, " (after retry)");
        return 0;
      }
      process.stderr.write(`doc-land: BLOCKED — ${second.blockedMsg ?? "push rejected after one retry"}\n`);
      process.stderr.write(`doc-land: NEVER a force-push; surface this as a board block for the operator\n`);
      return 1;
    }

    process.stderr.write(`doc-land: BLOCKED — ${first.blockedMsg}\n`);
    return 1;
  });
}

if (isMainEntry(import.meta.url)) {
  docLand(process.argv.slice(2)).then((c) => process.exit(c));
}
