// LOOP-575 — the UNLANDED axis of the `→ Done` gate.
//
// `Done` is terminal, so a ticket that reaches it leaves every queue arm at once. Work still sitting
// on its own branch at that moment becomes unreachable by construction. Two live routes reached that
// state on 2026-08-11 and both are pinned below as fixtures:
//
//   route 1 (LOOP-502) — closed against PR #300, still open; the fix is on no shipping tree, and the
//                        ONLY commits on main naming the id are `docs(strategy)` passes citing it.
//   route 2 (LOOP-518) — closed on a direct push (4 lines) while its own PR carried a divergent
//                        27-line implementation of the same fix, which then went DIRTY.
//
// The controls matter as much as the routes: a predicate that refuses everything would pass both
// route arms while being useless, so a squash-LANDED branch and a ticket with no branch at all are
// asserted silent here.
import { execFileSync } from "node:child_process";
import { realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

import { join } from "node:path";
import { unlandedBranchResidue, unlandedWorkRejection } from "../src/ac-gate.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-unlanded-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ID = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...ID, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repo with a real `origin/main` remote-tracking ref — the base the axis measures against. */
function fixture(): string {
  const bare = join(tmp, "origin.git");
  const work = join(tmp, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", "-q", bare], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", "-q", work], { stdio: "ignore" });
  mkdirSync(join(work, "hub", "src"), { recursive: true });
  mkdirSync(join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "hub/src/ci-freshness.ts"), "export const classify = () => 'ok';\n");
  writeFileSync(join(work, "hub/src/merge-guard.ts"), "export const trip = () => 'demote';\n");
  writeFileSync(join(work, "docs/STRATEGY.md"), "# strategy\n");
  git(work, "add", "-A"); git(work, "commit", "-qm", "base");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  return work;
}

const BASE = "origin/main";
const write = (r: string, p: string, s: string) => writeFileSync(join(r, p), s);
const commit = (r: string, msg: string) => { git(r, "add", "-A"); git(r, "commit", "-qm", msg); };
/** Put the branch on the remote and return to main, exactly as a fire's ship step leaves it. */
const pushBranch = (r: string, b: string) => { git(r, "push", "-q", "origin", b); git(r, "checkout", "-q", "main"); };

try {
  const repo = fixture();

  // ── route 1 (LOOP-502): closed against an unmerged branch ─────────────────────────────────────
  git(repo, "checkout", "-q", "-b", "dev-loop/LOOP-502");
  write(repo, "hub/src/ci-freshness.ts", "export const classify = (e) => e.code === 'ENOBUFS' ? 'overflow' : 'ok';\n");
  commit(repo, "fix(ci-freshness): classify ENOBUFS as buffer overflow (LOOP-502)");
  pushBranch(repo, "dev-loop/LOOP-502");

  const r502 = unlandedBranchResidue(repo, BASE, "LOOP-502");
  ok(r502.length > 0, "AC1/AC7 route 1: LOOP-502's branch is classified UNLANDED — its fix is on no shipping tree");
  ok(r502.some((b) => b.paths.includes("hub/src/ci-freshness.ts")),
    "AC1: …and the refusal names the file that is stranded, not merely the branch");

  // ── AC2: the measured false negative — a docs commit that merely CITES the id ─────────────────
  // This is the arm that fails the moment the predicate is reverted to a bare `--grep`: on the live
  // board `git log origin/main --grep=LOOP-502` returned three rows and not one was the fix.
  write(repo, "docs/STRATEGY.md", "# strategy\n\n§20 pass 149 — the ENOBUFS classification (LOOP-502)\n");
  commit(repo, "docs(strategy): §20 pass 149 — a stranded fix (LOOP-502)");
  git(repo, "push", "-q", "origin", "main");
  ok(unlandedBranchResidue(repo, BASE, "LOOP-502").length > 0,
    "AC2: a `docs(strategy): … (LOOP-502)` commit on the base does NOT certify the ticket as landed");
  ok(execFileSync("git", ["-C", repo, "log", BASE, "--fixed-strings", "--grep=LOOP-502", "--format=%H"],
    { encoding: "utf8" }).trim().length > 0,
    "AC2 (control): …while a bare --grep predicate DOES match it — which is exactly the false negative");

  // ── route 2 (LOOP-518): closed on a direct push while a divergent PR stayed open ──────────────
  git(repo, "checkout", "-q", "-b", "dev-loop/LOOP-518");
  write(repo, "hub/src/merge-guard.ts", "export const trip = () => 'comment-only';\nexport const routed = () => 'deduped';\nexport const demotion = () => 'recorded';\n");
  commit(repo, "fix(merge-guard): forge trip from In Progress is comment-only, deduped routing (LOOP-518)");
  pushBranch(repo, "dev-loop/LOOP-518");
  // …and the SMALLER implementation reaches main directly, without that branch.
  write(repo, "hub/src/merge-guard.ts", "export const trip = () => 'stay-in-progress';\n");
  commit(repo, "fix(merge-guard): forge trip on In Progress stays In Progress (LOOP-518)");
  git(repo, "push", "-q", "origin", "main");

  const r518 = unlandedBranchResidue(repo, BASE, "LOOP-518");
  ok(r518.length > 0,
    "AC1/AC7 route 2: LOOP-518 is UNLANDED even though a commit naming it IS on main — the branch carries a divergent second implementation");
  ok(r518.some((b) => b.paths.includes("hub/src/merge-guard.ts")),
    "AC7 route 2: …and the residue names the file the two implementations disagree on");

  // ── control: a squash-LANDED branch is silent ────────────────────────────────────────────────
  // Without this arm every assertion above is satisfied by a predicate that always refuses.
  git(repo, "checkout", "-q", "-b", "dev-loop/LOOP-544");
  write(repo, "hub/src/handoff-gate.ts", "export const split = () => true;\n");
  commit(repo, "fix(handoff-gate): measure the increment (LOOP-544)");
  git(repo, "push", "-q", "origin", "dev-loop/LOOP-544");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--squash", "dev-loop/LOOP-544");
  commit(repo, "fix(handoff-gate): the verify gate measures the increment (LOOP-544) (#326)");
  git(repo, "push", "-q", "origin", "main");
  ok(unlandedBranchResidue(repo, BASE, "LOOP-544").length === 0,
    "control: a SQUASH-merged branch is landed — its head is not an ancestor of main, and the axis must not refuse it");

  // ── control: a ticket with no branch of its own (AC1's LOOP-560) ─────────────────────────────
  ok(unlandedBranchResidue(repo, BASE, "LOOP-560").length === 0,
    "AC1: a decision ticket carrying no code has no branch — no opinion");

  // ── the refusal wrapper ──────────────────────────────────────────────────────────────────────
  const gate = (o: Partial<Parameters<typeof unlandedWorkRejection>[0]> = {}) => unlandedWorkRejection({
    id: "LOOP-502", toState: "Done", fromState: "In Review", actor: "pm", commentBodies: [],
    repoRoot: repo, baseRef: BASE, enabled: true, ...o,
  });

  const refused = gate();
  ok(refused !== null, "AC1: the axis refuses the `In Review → Done` close while the work is stranded");
  ok(/^verify gate:/.test(refused ?? ""), "…in the same refusal shape as the gates beside it");
  ok(/dev-loop\/LOOP-502/.test(refused ?? "") && /ci-freshness/.test(refused ?? ""),
    "…naming the branch and the stranded path, so it is actionable without a second query");
  ok(gate({ enabled: false }) === null, "AC4: OPT-IN — inert unless team.intake.unlandedWorkGate is true");
  ok(gate({ actor: "operator" }) === null, "AC5: the operator is exempt, as in every other gate in this layer");
  ok(gate({ commentBodies: ["AC-waived: PR #300 — superseded by the LOOP-544 rewrite, closed deliberately"] }) === null,
    "AC5: a reasoned waiver clears the axis in ONE step");
  ok(gate({ commentBodies: ["AC-waived: PR #300"] }) !== null,
    "AC5: …but a waiver with NO reason does not — that is the silent close wearing a marker");
  ok(gate({ toState: "In Review" }) === null, "the axis is scoped to the `→ Done` edge only");
  ok(gate({ fromState: "Done" }) === null, "…and a Done → Done re-write is not a close");
  ok(gate({ repoRoot: undefined }) === null, "no repo to measure against ⇒ silent, never a hard failure");
  ok(gate({ repoRoot: join(tmp, "not-a-repo") }) === null, "an unreadable repo ⇒ silent — a check whose input is missing has no opinion");
  ok(gate({ id: "LOOP-560" }) === null, "…and a ticket with no branch closes untouched");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nAll unlanded-gate (LOOP-575) checks passed" : `\n${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
