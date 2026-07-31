#!/usr/bin/env node
// dev-loop doc-land — land PM's doc-only progress commits to origin/<defaultBranch>
// under landing:"pr" (design: landing-discipline §4.6, LOOP-57).
// Step-3 finding split: reference findings (Canceled/Duplicate ticket refs in commit prose) →
// WARN + land with annotation; passenger findings → hard stop, unchanged.
import { execFileSync } from "node:child_process";
import { isMainEntry } from "./is-entry.ts";
import { dirname, join } from "node:path";
import { resolveWorkspace, wsLockPath, resolveHubDbPath, resolveRepoFromCwd } from "./workspace.ts";
import { effectiveRepo, inferProjectForRepo } from "./team-config.ts";
import { pushGuard } from "./push-guard.ts";
import { withLock } from "./locks.ts";

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
  return await withLock(lockPath, { totalMs: 60_000 }, async () => {
    const attempt = async (): Promise<{ ok: boolean; blockedMsg?: string; isRejection?: boolean }> => {
      // Step 2: fetch + rebase if origin has moved ahead
      try { git(["fetch", "origin", defaultBranch]); }
      catch (e) { process.stderr.write(`doc-land: fetch warning: ${gitErrText(e).summary}\n`); }

      // Narrow the fault boundary (LOOP-118): rev-list (cheap, read-only) is separated from the rebase
      // so a rev-list failure is never mislabelled "rebase failed".
      let behind = 0;
      try {
        const counts = git(["rev-list", "--left-right", "--count", `origin/${defaultBranch}...${defaultBranch}`]);
        behind = (counts || "0\t0").split("\t").map(Number)[0] || 0;
      } catch (e) {
        return { ok: false, blockedMsg: `could not compare with origin/${defaultBranch}: ${gitErrText(e).summary}` };
      }
      if (behind > 0) {
        if (dryRun) {
          console.log(`doc-land (dry-run): would rebase ${behind} commit(s) from origin/${defaultBranch}`);
        } else {
          try {
            git([...gitIdArgs, "rebase", `origin/${defaultBranch}`]);
          } catch (e) {
            // A real prose conflict in the strategy doc cannot be auto-merged (there is no merge
            // strategy for free-form text). Critically, `git rebase` leaves .git/rebase-merge/ in place
            // on failure — and this checkout is SHARED (PM/QA/Sweep/Ops all run git here), so a
            // left-behind rebase wedges every later git op until a human aborts. Abort now to restore
            // the checkout to its pre-rebase HEAD; swallow the abort's own error so it never masks the
            // real conflict (LOOP-118). A conflict is not a push rejection ⇒ no retry.
            try { git(["rebase", "--abort"]); } catch { /* best-effort restore; "no rebase in progress" is fine */ }
            const { summary, detail } = gitErrText(e);
            const extra = detail && detail !== summary ? `\n  ${detail.replace(/\n/g, "\n  ")}` : "";
            return {
              ok: false,
              blockedMsg:
                `doc content conflicts with origin/${defaultBranch} and cannot be auto-merged — ` +
                `'${docRel}' must be reconciled by hand (a human/PM prose merge) against origin, then re-run. ` +
                `The rebase was aborted and the checkout restored to its pre-rebase state.\n  git says: ${summary}${extra}`,
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
      try {
        git(["push", "origin", `${defaultBranch}:${defaultBranch}`]);
        return { ok: true };
      } catch (e) {
        return { ok: false, blockedMsg: `push rejected: ${gitErrText(e).summary}`, isRejection: true };
      }
    };

    const first = await attempt();
    if (first.ok) {
      if (!dryRun) console.log(`doc-land: landed — origin/${defaultBranch} is up to date`);
      return 0;
    }

    // Retry ONCE if and only if the push itself was rejected (concurrent activity on origin)
    if (first.isRejection) {
      process.stderr.write(`doc-land: push rejected — retrying once from fetch...\n`);
      const second = await attempt();
      if (second.ok) {
        if (!dryRun) console.log(`doc-land: landed — origin/${defaultBranch} is up to date (after retry)`);
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
