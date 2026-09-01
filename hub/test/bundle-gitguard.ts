// LOOP-210 — bundle export must not silently drop a secret-bearing artifact into a git working tree,
// and doctor W06 must stop certifying a tree it did not measure. The bug: `bundle export --out` writes
// an artifact carrying every secret VALUE + hub.db with no tree guard, and W06 asked "is .dev-loop/
// ignored?" not "is anything here committable?" — so with .dev-loop/ ignored it printed a clean line
// one line after a committable bundle was written. All fixtures are hermetic (own temp git repos) and
// §16-clean: no real secret VALUES — export runs --insecure-plaintext on a minimal fresh workspace.
import { execFileSync, spawnSync } from "node:child_process";
import { scrubFireEnv } from "./env-scrub.ts";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = tmpRoot("dl-gitguard-");
try {
  const cli = (args: string[], cwd: string, env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env: { ...scrubFireEnv(), ...env } as NodeJS.ProcessEnv });
  const gitInit = (dir: string) => { execFileSync("git", ["-C", dir, "init", "-q"]); execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]); execFileSync("git", ["-C", dir, "config", "user.name", "t"]); };
  const exportArgs = (out: string) => ["bundle", "export", "--out", out, "--insecure-plaintext", "--backup", "--force"];

  // ── WS1: workspace root IS a git work tree, with .dev-loop/ gitignored (the exact W06 arm) ──
  const gitWs = join(ROOT, "git-ws"); mkdirSync(gitWs, { recursive: true });
  ok(cli(["team", "init", "--dir", gitWs, "--key", "gg1", "--backend", "service", "--yes"], ROOT).status === 0, "setup: git-ws team init");
  gitInit(gitWs);
  writeFileSync(join(gitWs, ".gitignore"), ".dev-loop/\n");

  // (DOCTOR_OK / no false positive) — clean tree, .dev-loop/ ignored, NO bundle artifact yet ⇒ the
  // reassuring info line prints and there is NO bundle-artifact W06 warn.
  const docClean = cli(["doctor"], gitWs);
  const cleanOut = `${docClean.stdout}${docClean.stderr}`;
  ok(/is gitignored/.test(cleanOut), "W06: clean tree (no artifact) still prints the .dev-loop/ gitignored info line");
  ok(!/secret\/state-bearing/.test(cleanOut), "W06: no false-positive bundle warning on a tree with no bundle artifact");

  // (a) export --out INSIDE the git tree ⇒ a stderr warning naming the artifact + the exposure.
  const inTreeOut = join(gitWs, "ws.bundle");
  const expIn = cli(exportArgs(inTreeOut), gitWs);
  ok(expIn.status === 0, `(a) export into a git tree exits 0 (got ${expIn.status}: ${(expIn.stderr ?? "").split("\n")[0]})`);
  ok(existsSync(inTreeOut), "(a) the artifact was still written (warn, never silently refuse)");
  ok(/git working tree/.test(expIn.stderr) && expIn.stderr.includes(inTreeOut), "(a) export warns on stderr and names the artifact path");
  ok(/secret VALUE/.test(expIn.stderr), "(a) the warning states the exposure (secrets + hub.db)");

  // (d) doctor on that same tree (.dev-loop/ ignored, ws.bundle un-ignored) ⇒ W06 warns naming the
  // artifact and does NOT print the clean line. This arm fails against pre-LOOP-210 code.
  const docDirty = cli(["doctor"], gitWs);
  const dirtyOut = `${docDirty.stdout}${docDirty.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(dirtyOut), "(d) W06 warns for an un-ignored bundle artifact while .dev-loop/ IS ignored (names ws.bundle)");
  ok(!/is gitignored/.test(dirtyOut), "(d) the reassuring 'clean' line is suppressed once an un-ignored artifact is present");

  // (e) LOOP-235 — STAGE the un-ignored artifact (`git add -A`, the common pre-commit operator habit) and
  // re-run doctor on the SAME tree: W06 must STILL warn (a staged bundle is one `git commit` from history
  // — MORE imminent, not less) and must NOT regress to the reassuring "clean" line. Fails against an
  // untracked-only `unignoredBundleArtifacts` (a staged file drops out of `git ls-files --others`).
  execFileSync("git", ["-C", gitWs, "add", "-A"]);
  ok(/^A\s+ws\.bundle$/m.test(execFileSync("git", ["-C", gitWs, "status", "--short"], { encoding: "utf8" })), "(e) precondition: ws.bundle is now STAGED (git add -A), not untracked");
  const docStaged = cli(["doctor"], gitWs);
  const stagedOut = `${docStaged.stdout}${docStaged.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(stagedOut), "(e) W06 still warns for a STAGED un-ignored bundle artifact (names ws.bundle)");
  ok(!/is gitignored/.test(stagedOut), "(e) the reassuring 'clean' line stays suppressed once the artifact is staged, not just untracked");

  // (f) LOOP-235 review P1 #1 — STAGE the bundle, then garble the WORKTREE copy so index and worktree
  // diverge (`AM`): the index blob still carries the magic and the next `git commit` still leaks it, but
  // a worktree-file probe now sees non-magic bytes and misses. W06 must probe the INDEX blob (`:ws.bundle`),
  // not the worktree. Fails against a worktree-only `unignoredBundleArtifacts`, passes against the index probe.
  writeFileSync(join(gitWs, "ws.bundle"), "not-a-bundle-anymore"); // ws.bundle is already STAGED from (e)
  ok(/^AM\s+ws\.bundle$/m.test(execFileSync("git", ["-C", gitWs, "status", "--short"], { encoding: "utf8" })), "(f) precondition: ws.bundle is STAGED-then-worktree-modified (AM) — the worktree copy no longer holds the magic");
  const docAM = cli(["doctor"], gitWs);
  const amOut = `${docAM.stdout}${docAM.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(amOut), "(f) W06 warns off the STAGED INDEX blob even after the worktree copy was overwritten to non-magic (names ws.bundle)");
  ok(!/is gitignored/.test(amOut), "(f) the reassuring 'clean' line stays suppressed while the index still holds a bundle");

  // (g) LOOP-235 review P1 #2 — a bundle COMMITTED then DELETED in a later commit, both UNPUSHED. The
  // endpoint diff `upstream..HEAD` nets to empty (add+delete cancel), yet `git push` still ships the
  // intermediate commit's blob. W06 must walk EVERY unpushed commit, not just the endpoint. Needs a real
  // upstream to define "unpushed", so wire a bare remote. Fails against the endpoint-diff scan.
  const upWs = join(ROOT, "up-ws"); mkdirSync(upWs, { recursive: true });
  ok(cli(["team", "init", "--dir", upWs, "--key", "gg3", "--backend", "service", "--yes"], ROOT).status === 0, "setup: up-ws team init");
  gitInit(upWs);
  writeFileSync(join(upWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(upWs, "README"), "x\n");
  execFileSync("git", ["-C", upWs, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", upWs, "commit", "-qm", "init"]);
  const bareRemote = join(ROOT, "up-remote.git");
  execFileSync("git", ["init", "--bare", "-q", bareRemote]);
  execFileSync("git", ["-C", upWs, "remote", "add", "origin", bareRemote]);
  execFileSync("git", ["-C", upWs, "push", "-q", "-u", "origin", "HEAD:refs/heads/main"]); // establishes @{upstream}=origin/main, pushes init
  const upBundle = join(upWs, "ws.bundle");
  ok(cli(exportArgs(upBundle), upWs).status === 0, "(g) setup: bundle export into up-ws");
  execFileSync("git", ["-C", upWs, "add", "ws.bundle"]);
  execFileSync("git", ["-C", upWs, "commit", "-qm", "add bundle (unpushed)"]);
  execFileSync("git", ["-C", upWs, "rm", "-q", "ws.bundle"]);
  execFileSync("git", ["-C", upWs, "commit", "-qm", "remove bundle (unpushed)"]);
  ok(execFileSync("git", ["-C", upWs, "diff", "--name-only", "@{upstream}..HEAD"], { encoding: "utf8" }).trim() === "", "(g) precondition: the endpoint diff upstream..HEAD is EMPTY (add+delete net out — why an endpoint-only scan misses it)");
  ok(!existsSync(upBundle), "(g) precondition: ws.bundle is gone from the worktree AND index — its only reachable copy is the intermediate unpushed commit");
  const docUp = cli(["doctor"], upWs);
  const upOut = `${docUp.stdout}${docUp.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(upOut), "(g) W06 warns for a bundle carried by an unpushed intermediate commit even though the endpoint diff is empty (names ws.bundle)");
  ok(!/is gitignored/.test(upOut), "(g) the reassuring 'clean' line is suppressed while an unpushed commit still carries the artifact");

  // (h) LOOP-235 review P1 #3 — a bundle introduced BY an unpushed MERGE commit (e.g. staged during
  // conflict resolution). It lives in NEITHER parent, so the per-commit walk only meets it at the merge —
  // and a plain `diff-tree -r` emits nothing for a merge (git suppresses merge diffs unless a merge mode
  // is asked), so both the endpoint- and per-parent-commit scans miss it while `git push` still ships it.
  // W06's walk must pass `-c` (combined diff) so a merge reports paths differing from ALL parents. Fails
  // against the pre-`-c` scan.
  const mergeWs = join(ROOT, "merge-ws"); mkdirSync(mergeWs, { recursive: true });
  ok(cli(["team", "init", "--dir", mergeWs, "--key", "gg4", "--backend", "service", "--yes"], ROOT).status === 0, "setup: merge-ws team init");
  gitInit(mergeWs);
  writeFileSync(join(mergeWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(mergeWs, "README"), "x\n");
  execFileSync("git", ["-C", mergeWs, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", mergeWs, "commit", "-qm", "init"]);
  const mergeRemote = join(ROOT, "merge-remote.git");
  execFileSync("git", ["init", "--bare", "-q", mergeRemote]);
  execFileSync("git", ["-C", mergeWs, "remote", "add", "origin", mergeRemote]);
  execFileSync("git", ["-C", mergeWs, "push", "-q", "-u", "origin", "HEAD:refs/heads/main"]); // @{upstream}=origin/main
  execFileSync("git", ["-C", mergeWs, "checkout", "-q", "-b", "feat"]);
  writeFileSync(join(mergeWs, "feat.txt"), "feat\n");
  execFileSync("git", ["-C", mergeWs, "add", "feat.txt"]);
  execFileSync("git", ["-C", mergeWs, "commit", "-qm", "feat work (unpushed)"]);
  execFileSync("git", ["-C", mergeWs, "checkout", "-q", "main"]);
  execFileSync("git", ["-C", mergeWs, "merge", "--no-ff", "--no-commit", "feat"]); // pause before the merge commit
  const mergeBundle = join(mergeWs, "ws.bundle");
  ok(cli(exportArgs(mergeBundle), mergeWs).status === 0, "(h) setup: bundle export into the pending merge");
  execFileSync("git", ["-C", mergeWs, "add", "ws.bundle"]);
  execFileSync("git", ["-C", mergeWs, "commit", "--no-edit", "-q"]); // finalize a real 2-parent merge carrying ws.bundle
  const mParents = execFileSync("git", ["-C", mergeWs, "rev-list", "--parents", "-n", "1", "HEAD"], { encoding: "utf8" }).trim().split(/\s+/).length - 1;
  ok(mParents === 2, `(h) precondition: HEAD is a real 2-parent merge commit (got ${mParents})`);
  ok(spawnSync("git", ["-C", mergeWs, "cat-file", "-e", "HEAD^1:ws.bundle"]).status !== 0 &&
     spawnSync("git", ["-C", mergeWs, "cat-file", "-e", "HEAD^2:ws.bundle"]).status !== 0,
     "(h) precondition: ws.bundle exists in NEITHER parent — its only reachable copy is the merge commit itself");
  ok(execFileSync("git", ["-C", mergeWs, "diff-tree", "-r", "--no-commit-id", "--name-only", "--diff-filter=AM", "--root", "HEAD"], { encoding: "utf8" }).trim() === "",
     "(h) precondition: a plain (non-combined) diff-tree of the merge is EMPTY — exactly why the pre-`-c` scan misses it");
  const docMerge = cli(["doctor"], mergeWs);
  const mergeOut = `${docMerge.stdout}${docMerge.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(mergeOut), "(h) W06 warns for a bundle introduced by an unpushed merge commit (names ws.bundle)");
  ok(!/is gitignored/.test(mergeOut), "(h) the reassuring 'clean' line is suppressed while an unpushed merge commit carries the artifact");

  // (i) LOOP-235 review P1 #4 — a bundle COMMITTED on a branch with NO `@{upstream}` (a fresh branch never
  // pushed, or a repo with no remote at all). `git push origin HEAD:refs/heads/X` still ships that commit,
  // but the old `@{upstream}..HEAD` arm skipped ENTIRELY when `rev-parse @{upstream}` failed. The scan must
  // enumerate `HEAD --not --remotes` (what a push would transfer) so it works with no tracking ref. Here:
  // no remote at all → the committed bundle is invisible to the staged + untracked arms. Fails against the
  // upstream-gated arm.
  const noUpWs = join(ROOT, "noup-ws"); mkdirSync(noUpWs, { recursive: true });
  ok(cli(["team", "init", "--dir", noUpWs, "--key", "gg5", "--backend", "service", "--yes"], ROOT).status === 0, "setup: noup-ws team init");
  gitInit(noUpWs);
  writeFileSync(join(noUpWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(noUpWs, "README"), "x\n");
  execFileSync("git", ["-C", noUpWs, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", noUpWs, "commit", "-qm", "init"]);
  const noUpBundle = join(noUpWs, "ws.bundle");
  ok(cli(exportArgs(noUpBundle), noUpWs).status === 0, "(i) setup: bundle export into noup-ws");
  execFileSync("git", ["-C", noUpWs, "add", "ws.bundle"]);
  execFileSync("git", ["-C", noUpWs, "commit", "-qm", "add bundle (committed, no upstream, never pushed)"]);
  ok(spawnSync("git", ["-C", noUpWs, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).status !== 0,
     "(i) precondition: the branch has NO @{upstream} — exactly why the old upstream-gated arm skipped");
  ok(execFileSync("git", ["-C", noUpWs, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim() === "",
     "(i) precondition: nothing staged (index == HEAD after commit — the staged arm sees nothing)");
  ok(execFileSync("git", ["-C", noUpWs, "ls-files", "ws.bundle"], { encoding: "utf8" }).trim() === "ws.bundle" &&
     !execFileSync("git", ["-C", noUpWs, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").includes("ws.bundle"),
     "(i) precondition: ws.bundle is committed/tracked (not in the untracked set) — only the committed-history arm can catch it");
  const docNoUp = cli(["doctor"], noUpWs);
  const noUpOut = `${docNoUp.stdout}${docNoUp.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(noUpOut), "(i) W06 warns for a committed bundle on a branch with no upstream (names ws.bundle)");
  ok(!/is gitignored/.test(noUpOut), "(i) the reassuring 'clean' line is suppressed while a committed no-upstream bundle is present");

  // (j) LOOP-235 review P1 #5 — a bundle-bearing commit reachable from an UNRELATED remote-tracking ref: a
  // feature commit F pushed to `fork/feat`, then merged into a branch that tracks `origin/main`. A push to
  // origin still ships F, but `rev-list HEAD --not --remotes` SUBTRACTS it (F is on fork/*) and the merge's
  // combined diff omits it (unchanged from the feature parent) — so the P1 #4 form misses it. The scan must
  // range against the tracked destination (`@{push}`/`@{upstream}`), which includes F. Fails against the
  // `--not --remotes` form, passes against `<dest>..HEAD`.
  const mrWs = join(ROOT, "mr-ws"); mkdirSync(mrWs, { recursive: true });
  ok(cli(["team", "init", "--dir", mrWs, "--key", "gg6", "--backend", "service", "--yes"], ROOT).status === 0, "setup: mr-ws team init");
  gitInit(mrWs);
  writeFileSync(join(mrWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(mrWs, "README"), "x\n");
  execFileSync("git", ["-C", mrWs, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", mrWs, "commit", "-qm", "init"]);
  const mrOrigin = join(ROOT, "mr-origin.git");
  execFileSync("git", ["init", "--bare", "-q", mrOrigin]);
  execFileSync("git", ["-C", mrWs, "remote", "add", "origin", mrOrigin]);
  execFileSync("git", ["-C", mrWs, "push", "-q", "-u", "origin", "HEAD:refs/heads/main"]); // main tracks origin/main
  const mrFork = join(ROOT, "mr-fork.git");
  execFileSync("git", ["init", "--bare", "-q", mrFork]);
  execFileSync("git", ["-C", mrWs, "remote", "add", "fork", mrFork]);
  execFileSync("git", ["-C", mrWs, "checkout", "-q", "-b", "feat"]);
  const mrBundle = join(mrWs, "ws.bundle");
  ok(cli(exportArgs(mrBundle), mrWs).status === 0, "(j) setup: bundle export on the feat branch");
  execFileSync("git", ["-C", mrWs, "add", "ws.bundle"]);
  execFileSync("git", ["-C", mrWs, "commit", "-qm", "feat: add bundle (pushed only to fork)"]);
  const mrFeatSha = execFileSync("git", ["-C", mrWs, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", mrWs, "push", "-q", "fork", "HEAD:refs/heads/feat"]);
  execFileSync("git", ["-C", mrWs, "fetch", "-q", "fork"]); // ensure refs/remotes/fork/feat exists so --not --remotes subtracts F
  execFileSync("git", ["-C", mrWs, "checkout", "-q", "main"]);
  execFileSync("git", ["-C", mrWs, "merge", "--no-ff", "--no-edit", "-q", "feat"]); // F enters main's tree via a merge commit, unchanged from the feat parent
  const revListNotRemotes = execFileSync("git", ["-C", mrWs, "rev-list", "HEAD", "--not", "--remotes"], { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
  ok(!revListNotRemotes.includes(mrFeatSha), "(j) precondition: the bundle-adding commit F is reachable from fork/* so 'rev-list HEAD --not --remotes' OMITS it (why the P1 #4 form misses)");
  ok(execFileSync("git", ["-C", mrWs, "rev-list", "@{upstream}..HEAD"], { encoding: "utf8" }).split("\n").map((s) => s.trim()).includes(mrFeatSha), "(j) precondition: F IS in @{upstream}..HEAD — the range a push to the tracked origin would ship");
  ok(execFileSync("git", ["-C", mrWs, "ls-files", "ws.bundle"], { encoding: "utf8" }).trim() === "ws.bundle" &&
     execFileSync("git", ["-C", mrWs, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim() === "",
     "(j) precondition: ws.bundle is committed/tracked and nothing is staged — only the committed-history arm, ranged against the destination, reaches it");
  const docMr = cli(["doctor"], mrWs);
  const mrOut = `${docMr.stdout}${docMr.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(mrOut), "(j) W06 warns for a bundle on a commit that is on an unrelated remote but still shipped by a push to the tracked destination (names ws.bundle)");
  ok(!/is gitignored/.test(mrOut), "(j) the reassuring 'clean' line is suppressed for the multi-remote destination case");

  // (k) LOOP-235 review P1 #6 — a committed bundle that REPLACES a tracked symlink at an existing path is a
  // TYPE change (`T`), which Git reports as neither `A` nor `M`; the `--diff-filter=AM` scan skipped it, so
  // after the staged arm clears (committed) doctor could print clean while the next push still ships the blob.
  // The committed walk must include `T`. Fails against `--diff-filter=AM`, passes against `AMT`.
  const tcWs = join(ROOT, "tc-ws"); mkdirSync(tcWs, { recursive: true });
  ok(cli(["team", "init", "--dir", tcWs, "--key", "gg7", "--backend", "service", "--yes"], ROOT).status === 0, "setup: tc-ws team init");
  gitInit(tcWs);
  writeFileSync(join(tcWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(tcWs, "README"), "x\n");
  symlinkSync("README", join(tcWs, "link")); // 'link' starts life as a symlink (mode 120000)
  execFileSync("git", ["-C", tcWs, "add", "README", ".gitignore", "link"]);
  execFileSync("git", ["-C", tcWs, "commit", "-qm", "init (link is a symlink)"]);
  const tcRemote = join(ROOT, "tc-remote.git");
  execFileSync("git", ["init", "--bare", "-q", tcRemote]);
  execFileSync("git", ["-C", tcWs, "remote", "add", "origin", tcRemote]);
  execFileSync("git", ["-C", tcWs, "push", "-q", "-u", "origin", "HEAD:refs/heads/main"]); // the symlink version is on the upstream
  rmSync(join(tcWs, "link"));
  ok(cli(exportArgs(join(tcWs, "link")), tcWs).status === 0, "(k) setup: bundle export OVER the path that was a symlink (now a regular file)");
  execFileSync("git", ["-C", tcWs, "add", "link"]);
  execFileSync("git", ["-C", tcWs, "commit", "-qm", "replace symlink with bundle (unpushed, a TYPE change)"]);
  const tcStatusLine = execFileSync("git", ["-C", tcWs, "diff-tree", "-r", "--no-commit-id", "--name-status", "HEAD"], { encoding: "utf8" }).split("\n").find((l) => /\blink$/.test(l)) ?? "";
  ok(/^T\b/.test(tcStatusLine), `(k) precondition: 'link' is a TYPE change (T) symlink→regular-file in the unpushed commit (got '${tcStatusLine}')`);
  ok(!execFileSync("git", ["-C", tcWs, "diff-tree", "-r", "-c", "--no-commit-id", "--name-only", "--diff-filter=AM", "--root", "HEAD"], { encoding: "utf8" }).split("\n").map((s) => s.trim()).includes("link"),
     "(k) precondition: a --diff-filter=AM scan OMITS the type-changed path (why the pre-fix arm missed it)");
  ok(execFileSync("git", ["-C", tcWs, "diff-tree", "-r", "-c", "--no-commit-id", "--name-only", "--diff-filter=AMT", "--root", "HEAD"], { encoding: "utf8" }).split("\n").map((s) => s.trim()).includes("link"),
     "(k) precondition: --diff-filter=AMT DOES enumerate the type-changed path");
  const docTc = cli(["doctor"], tcWs);
  const tcOut = `${docTc.stdout}${docTc.stderr}`;
  ok(/\[W06\][^\n]*\blink\b/.test(tcOut), "(k) W06 warns for a bundle that replaced a symlink at a tracked path — a TYPE change (names link)");
  ok(!/is gitignored/.test(tcOut), "(k) the reassuring 'clean' line is suppressed for the type-change case");

  // (l) LOOP-235 review P1 #7 — the REMEDIATION, not the detection. The staged/committed arms now DETECT a
  // tracked bundle, but a blob already in the index is not removed by a .gitignore rule (nor by moving the
  // worktree file): follow the old "add it to .gitignore" advice, `git commit`, and the secret still ships.
  // W06 must tell the operator to `git rm --cached <path>` for a TRACKED leak — and must NOT bolt that clause
  // onto an UNTRACKED leak, where a .gitignore rule is the correct fix. The staged assertion fails against the
  // untracked-only remediation string and passes against the state-aware one.
  const remWs = join(ROOT, "rem-ws"); mkdirSync(remWs, { recursive: true });
  ok(cli(["team", "init", "--dir", remWs, "--key", "gg8", "--backend", "service", "--yes"], ROOT).status === 0, "setup: rem-ws team init");
  gitInit(remWs);
  writeFileSync(join(remWs, ".gitignore"), ".dev-loop/\n");
  ok(cli(exportArgs(join(remWs, "ws.bundle")), remWs).status === 0, "(l) setup: bundle export into rem-ws");
  // untracked leak: the .gitignore advice is right, and the unstage clause must be ABSENT (precise remediation).
  const docRemU = cli(["doctor"], remWs);
  const remUOut = `${docRemU.stdout}${docRemU.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(remUOut) && /\.gitignore/.test(remUOut), "(l) untracked leak: W06 warns and still advises .gitignore");
  ok(!/rm --cached/.test(remUOut), "(l) untracked leak: NO unstage clause — a .gitignore rule is the correct fix for an untracked file");
  // stage it: the same blob now lives in the index, where a .gitignore rule cannot reach it.
  execFileSync("git", ["-C", remWs, "add", "-A"]);
  ok(/^A\s+ws\.bundle$/m.test(execFileSync("git", ["-C", remWs, "status", "--short"], { encoding: "utf8" })), "(l) precondition: ws.bundle is now STAGED (a blob in the index)");
  const docRemS = cli(["doctor"], remWs);
  const remSOut = `${docRemS.stdout}${docRemS.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(remSOut), "(l) staged leak: W06 still warns (names ws.bundle)");
  // Codex P1 fix: -f is required so the command also works for AM blobs (staged then modified in worktree).
  ok(/git rm -f --cached/.test(remSOut), "(l) staged leak: the remediation tells the operator to `git rm -f --cached` — handles AM state where index and worktree differ");

  // (s) LOOP-235 review (PRRT_kwDOS6Puk86VoHA5) — `git rm --cached` clears only the INDEX; the worktree copy
  // survives as an untracked file and a later routine `git add -A` re-stages the identical secret. The staged
  // remediation must ALSO name deleting/moving/.gitignoring the worktree copy, not just unstaging. Fails
  // against the index-only remediation string, passes against the worktree-inclusive one.
  ok(/worktree copy/.test(remSOut) && /re-stage/.test(remSOut),
     "(s) staged leak: remediation also says to delete/move the worktree copy so a later `git add -A` cannot re-stage the same blob (LOOP-235 review PRRT_…VoHA5)");

  // (m) LOOP-235 review P1 #8 — a bundle in an unpushed COMMIT needs different advice than a staged one:
  // `git rm --cached` clears only the index, so the committed blob still ships on the next push. The
  // remediation must tell the operator to REWRITE/DROP the unpushed commit, not to unstage. Fails against a
  // remediation that lumps "staged or committed" into a single `git rm --cached` clause.
  const cmWs = join(ROOT, "cm-ws"); mkdirSync(cmWs, { recursive: true });
  ok(cli(["team", "init", "--dir", cmWs, "--key", "gg9", "--backend", "service", "--yes"], ROOT).status === 0, "setup: cm-ws team init");
  gitInit(cmWs);
  writeFileSync(join(cmWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(cmWs, "README"), "x\n");
  execFileSync("git", ["-C", cmWs, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", cmWs, "commit", "-qm", "init"]);
  ok(cli(exportArgs(join(cmWs, "ws.bundle")), cmWs).status === 0, "(m) setup: bundle export into cm-ws");
  execFileSync("git", ["-C", cmWs, "add", "ws.bundle"]);
  execFileSync("git", ["-C", cmWs, "commit", "-qm", "add bundle (committed, unpushed)"]);
  ok(execFileSync("git", ["-C", cmWs, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim() === "",
     "(m) precondition: nothing staged — the bundle's only reachable copy is an unpushed COMMIT, not the index");
  const docCm = cli(["doctor"], cmWs);
  const cmOut = `${docCm.stdout}${docCm.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(cmOut), "(m) committed leak: W06 warns (names ws.bundle)");
  ok(/unpushed commit/.test(cmOut) && /rebase|reset/.test(cmOut),
     "(m) committed leak: remediation says to rewrite/drop the unpushed commit, not just `git rm --cached` (LOOP-235 review P1 #8)");

  // (n) LOOP-235 review P1 #9 — the tracked (staged/committed) scans must NOT truncate: a secret-leak guard
  // that stops after N candidates can print clean while a bundle past the cutoff still commits. Stage a bulk
  // change LARGER than the old per-arm cap (2000) with the bundle sorted LAST, and W06 must still warn.
  // Fails against a staged arm that breaks at the cap.
  const bulkN = 2050; // comfortably past the historical 2000 per-arm cap
  const bulkWs = join(ROOT, "bulk-ws"); mkdirSync(bulkWs, { recursive: true });
  ok(cli(["team", "init", "--dir", bulkWs, "--key", "gg10", "--backend", "service", "--yes"], ROOT).status === 0, "setup: bulk-ws team init");
  gitInit(bulkWs);
  writeFileSync(join(bulkWs, ".gitignore"), ".dev-loop/\n");
  mkdirSync(join(bulkWs, "bulk"), { recursive: true });
  for (let i = 0; i < bulkN; i++) writeFileSync(join(bulkWs, "bulk", `f${String(i).padStart(5, "0")}.txt`), "");
  ok(cli(exportArgs(join(bulkWs, "zz-ws.bundle")), bulkWs).status === 0, "(n) setup: bundle export as zz-ws.bundle (sorts AFTER the bulk files)");
  execFileSync("git", ["-C", bulkWs, "add", "-A"]);
  const stagedNames = execFileSync("git", ["-C", bulkWs, "diff", "--cached", "--name-only"], { encoding: "utf8" }).split("\n").filter(Boolean);
  ok(stagedNames.length > 2000 && stagedNames[stagedNames.length - 1] === "zz-ws.bundle",
     `(n) precondition: >2000 staged paths (got ${stagedNames.length}) with zz-ws.bundle sorted LAST — past the old 2000 cap`);
  const docBulk = cli(["doctor"], bulkWs);
  const bulkOut = `${docBulk.stdout}${docBulk.stderr}`;
  ok(/\[W06\][^\n]*zz-ws\.bundle/.test(bulkOut),
     "(n) W06 still warns for a bundle past the 2000th staged candidate — the tracked scan is not truncated (LOOP-235 review P1 #9)");
  ok(!/is gitignored/.test(bulkOut), "(n) the reassuring 'clean' line is suppressed for the bulk-staged case");

  // (o) LOOP-235 review (no-destination, follow-up to P1 #5) — a committed bundle on a branch with NEITHER
  // `@{push}` NOR `@{upstream}`, whose commit is ALSO reachable from an unrelated remote-tracking ref. The
  // old no-destination fallback `HEAD --not --remotes` SUBTRACTS that commit (it is on a remote), so the scan
  // is empty and doctor prints clean — yet `git push origin HEAD:<branch>` still ships it. With no destination
  // the push target is unknowable, so the scan must range over ALL of HEAD. Fails against `HEAD --not
  // --remotes`, passes against `["HEAD"]`.
  const ndWs = join(ROOT, "nd-ws"); mkdirSync(ndWs, { recursive: true });
  ok(cli(["team", "init", "--dir", ndWs, "--key", "gg11", "--backend", "service", "--yes"], ROOT).status === 0, "setup: nd-ws team init");
  gitInit(ndWs);
  writeFileSync(join(ndWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(ndWs, "README"), "x\n");
  execFileSync("git", ["-C", ndWs, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", ndWs, "commit", "-qm", "init"]);
  const ndOrigin = join(ROOT, "nd-origin.git"); execFileSync("git", ["init", "--bare", "-q", ndOrigin]);
  execFileSync("git", ["-C", ndWs, "remote", "add", "origin", ndOrigin]);
  execFileSync("git", ["-C", ndWs, "push", "-q", "origin", "HEAD:refs/heads/main"]); // origin/main = C0 (no bundle); NO -u ⇒ not tracking
  const ndFork = join(ROOT, "nd-fork.git"); execFileSync("git", ["init", "--bare", "-q", ndFork]);
  execFileSync("git", ["-C", ndWs, "remote", "add", "fork", ndFork]);
  execFileSync("git", ["-C", ndWs, "checkout", "-q", "-b", "feat"]);
  ok(cli(exportArgs(join(ndWs, "ws.bundle")), ndWs).status === 0, "(o) setup: bundle export on feat");
  execFileSync("git", ["-C", ndWs, "add", "ws.bundle"]);
  execFileSync("git", ["-C", ndWs, "commit", "-qm", "feat: add bundle (unpushed to origin, pushed to fork)"]);
  const ndSha = execFileSync("git", ["-C", ndWs, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", ndWs, "push", "-q", "fork", "HEAD:refs/heads/feat"]); // no -u
  execFileSync("git", ["-C", ndWs, "fetch", "-q", "fork"]); // create refs/remotes/fork/feat so --not --remotes subtracts ndSha
  ok(spawnSync("git", ["-C", ndWs, "rev-parse", "--verify", "--quiet", "@{upstream}"]).status !== 0 &&
     spawnSync("git", ["-C", ndWs, "rev-parse", "--verify", "--quiet", "@{push}"]).status !== 0,
     "(o) precondition: branch feat has NEITHER @{upstream} NOR @{push} — the no-destination fallback path");
  ok(!execFileSync("git", ["-C", ndWs, "rev-list", "HEAD", "--not", "--remotes"], { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean).includes(ndSha),
     "(o) precondition: 'rev-list HEAD --not --remotes' OMITS the bundle commit (it is on fork/*) — why the old fallback prints clean");
  ok(execFileSync("git", ["-C", ndWs, "rev-list", "HEAD"], { encoding: "utf8" }).split("\n").map((s) => s.trim()).includes(ndSha),
     "(o) precondition: 'rev-list HEAD' (all of HEAD, the new no-destination range) DOES include the bundle commit");
  const docNd = cli(["doctor"], ndWs);
  const ndOut = `${docNd.stdout}${docNd.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(ndOut), "(o) W06 warns for a committed bundle with no push destination, reachable from an unrelated remote (names ws.bundle)");
  ok(!/is gitignored/.test(ndOut), "(o) the reassuring 'clean' line is suppressed for the no-destination case");

  // (p) LOOP-235 review (both-states remediation) — the SAME path carries a bundle in an unpushed COMMIT and
  // a DIFFERENT bundle STAGED in the index. Collapsing the path to a single "hardest" state (committed) drops
  // the staged clause, so the operator is told only to rewrite history — a soft reset then leaves the staged
  // bundle in the index, ready to leak in the replacement commit. W06 must print BOTH remediations. Fails
  // against the hardest-state-wins collapse, passes when both states are retained.
  const bsWs = join(ROOT, "bs-ws"); mkdirSync(bsWs, { recursive: true });
  ok(cli(["team", "init", "--dir", bsWs, "--key", "gg12", "--backend", "service", "--yes"], ROOT).status === 0, "setup: bs-ws team init");
  gitInit(bsWs);
  writeFileSync(join(bsWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(bsWs, "README"), "x\n");
  execFileSync("git", ["-C", bsWs, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", bsWs, "commit", "-qm", "init"]);
  const bsBundle = join(bsWs, "ws.bundle");
  ok(cli(exportArgs(bsBundle), bsWs).status === 0, "(p) setup: first bundle export (to be committed)");
  execFileSync("git", ["-C", bsWs, "add", "ws.bundle"]);
  execFileSync("git", ["-C", bsWs, "commit", "-qm", "add bundle v1 (committed, unpushed)"]);
  const bsCommittedOid = execFileSync("git", ["-C", bsWs, "rev-parse", "HEAD:ws.bundle"], { encoding: "utf8" }).trim();
  ok(cli(exportArgs(bsBundle), bsWs).status === 0, "(p) setup: second bundle export OVER the same path");
  appendFileSync(bsBundle, Buffer.from([0])); // force a DISTINCT index blob (magic header intact) so the path has a real staged change
  execFileSync("git", ["-C", bsWs, "add", "ws.bundle"]);
  const bsStagedOid = execFileSync("git", ["-C", bsWs, "rev-parse", ":ws.bundle"], { encoding: "utf8" }).trim();
  ok(bsStagedOid !== bsCommittedOid &&
     execFileSync("git", ["-C", bsWs, "diff", "--cached", "--name-only"], { encoding: "utf8" }).split("\n").includes("ws.bundle"),
     "(p) precondition: ws.bundle is BOTH a staged index blob AND a distinct blob in an unpushed commit");
  const docBs = cli(["doctor"], bsWs);
  const bsOut = `${docBs.stdout}${docBs.stderr}`;
  ok(/\[W06\][^\n]*ws\.bundle/.test(bsOut), "(p) W06 warns (names ws.bundle)");
  ok(/git rm -f --cached/.test(bsOut) && /unpushed commit/.test(bsOut) && /rebase|reset/.test(bsOut),
     "(p) both remediations present: `git rm -f --cached` (staged) AND rewrite the unpushed commit (committed) — not collapsed to one (LOOP-235 review both-states)");

  // (q) LOOP-235 review P2 — the tracked scan probes blobs through a shared, batched `git cat-file --batch`
  // (one process per content-budget group) instead of a subprocess per path, which the no-destination
  // all-of-HEAD scan above would otherwise explode into a `cat-file` per blob in history. This exercises the
  // batch's correctness: TWO bundles at different paths across TWO unpushed commits must BOTH be named, and
  // the non-bundle blobs sharing the batch must NOT be — a mis-mapped OID→path or a wrong magic offset in the
  // batch parser would surface here.
  const bqWs = join(ROOT, "bq-ws"); mkdirSync(bqWs, { recursive: true });
  ok(cli(["team", "init", "--dir", bqWs, "--key", "gg13", "--backend", "service", "--yes"], ROOT).status === 0, "setup: bq-ws team init");
  gitInit(bqWs);
  writeFileSync(join(bqWs, ".gitignore"), ".dev-loop/\n");
  writeFileSync(join(bqWs, "README"), "x\n");
  execFileSync("git", ["-C", bqWs, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", bqWs, "commit", "-qm", "init"]);
  mkdirSync(join(bqWs, "a"), { recursive: true });
  writeFileSync(join(bqWs, "a", "plain.txt"), "not a bundle\n".repeat(400)); // a non-bundle blob sharing the batch
  ok(cli(exportArgs(join(bqWs, "a", "one.bundle")), bqWs).status === 0, "(q) setup: bundle export a/one.bundle");
  execFileSync("git", ["-C", bqWs, "add", "a"]);
  execFileSync("git", ["-C", bqWs, "commit", "-qm", "commit 1: one.bundle + plain.txt (unpushed)"]);
  mkdirSync(join(bqWs, "b"), { recursive: true });
  writeFileSync(join(bqWs, "b", "data.bin"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])); // an 8-byte blob (< MAGIC) in the same batch
  ok(cli(exportArgs(join(bqWs, "b", "two.bundle")), bqWs).status === 0, "(q) setup: bundle export b/two.bundle");
  execFileSync("git", ["-C", bqWs, "add", "b"]);
  execFileSync("git", ["-C", bqWs, "commit", "-qm", "commit 2: two.bundle + data.bin (unpushed)"]);
  const docBq = cli(["doctor"], bqWs);
  const bqOut = `${docBq.stdout}${docBq.stderr}`;
  ok(/\[W06\][^\n]*one\.bundle/.test(bqOut) && /\btwo\.bundle\b/.test(bqOut),
     "(q) batched scan names BOTH bundles across two unpushed commits (one.bundle + two.bundle)");
  ok(!/plain\.txt/.test(bqOut) && !/data\.bin/.test(bqOut),
     "(q) the non-bundle blobs sharing the batch are NOT flagged — the batch parser maps magic to the right OID/path");
  ok(!/is gitignored/.test(bqOut), "(q) the reassuring 'clean' line is suppressed while unpushed bundles are present");

  // (r) LOOP-235 Codex P1 fix — moved.json dual-state: already in HEAD (committed) AND re-staged.
  // Before the fix, indexState() returned "committed" only, omitting the "staged" remediation step.
  // indexStates() returns both, so W06 now recommends BOTH `git rm -f --cached` AND commit rewrite.
  const dualWs = join(ROOT, "dual-ws"); mkdirSync(dualWs, { recursive: true });
  ok(cli(["team", "init", "--dir", dualWs, "--key", "gg14", "--backend", "service", "--yes"], ROOT).status === 0, "setup: dual-ws team init");
  gitInit(dualWs);
  writeFileSync(join(dualWs, "README"), "x\n");
  execFileSync("git", ["-C", dualWs, "add", "README"]);
  execFileSync("git", ["-C", dualWs, "commit", "-qm", "init"]);
  // Write moved.json, commit it (so it's in HEAD), then stage a NEW version
  const dualMovedPath = join(dualWs, ".dev-loop", "moved.json");
  mkdirSync(join(dualWs, ".dev-loop"), { recursive: true });
  writeFileSync(dualMovedPath, JSON.stringify({ from: "a", to: "b" }));
  execFileSync("git", ["-C", dualWs, "add", dualMovedPath]);
  execFileSync("git", ["-C", dualWs, "commit", "-qm", "add moved.json (committed, unpushed)"]);
  writeFileSync(dualMovedPath, JSON.stringify({ from: "x", to: "y" })); // modify and re-stage
  execFileSync("git", ["-C", dualWs, "add", dualMovedPath]);
  const docDual = cli(["doctor"], dualWs);
  const dualOut = `${docDual.stdout}${docDual.stderr}`;
  ok(/\[W06\][^\n]*moved\.json/.test(dualOut), "(r) W06 warns for moved.json in both HEAD and staged");
  ok(/git rm -f --cached/.test(dualOut), "(r) dual-state moved.json: staged remediation (`git rm -f --cached`) is present");
  ok(/unpushed commit/.test(dualOut) && /rebase|reset/.test(dualOut), "(r) dual-state moved.json: committed remediation (rewrite/drop commit) is present");

  // (t) LOOP-235 review (PRRT_kwDOS6Puk86VoHA7) — a moved.json marker already in a PUSHED commit must NOT get
  // "rewrite the unpushed commit" advice: rewriting published history won't un-leak it and misdirects the
  // operator. indexStates() is now push-aware via unpushedRange (the SAME range the bundle arm ships), so a
  // pushed marker is classified "published" and W06 says rotate + .gitignore instead of rebase/reset. Fails
  // against the pre-fix `cat-file -e HEAD:<rel>` classification, which calls ANY committed blob "committed".
  // NOTE: .dev-loop/ is deliberately NOT gitignored here — an un-ignored marker is the only state in which the
  // moved.json arm fires, and it is exactly the misconfiguration whose remediation this guards.
  const pubWs = join(ROOT, "pub-ws"); mkdirSync(pubWs, { recursive: true });
  ok(cli(["team", "init", "--dir", pubWs, "--key", "gg15", "--backend", "service", "--yes"], ROOT).status === 0, "setup: pub-ws team init");
  gitInit(pubWs);
  writeFileSync(join(pubWs, "README"), "x\n");
  execFileSync("git", ["-C", pubWs, "add", "README"]);
  execFileSync("git", ["-C", pubWs, "commit", "-qm", "init"]);
  const pubMoved = join(pubWs, ".dev-loop", "moved.json");
  mkdirSync(join(pubWs, ".dev-loop"), { recursive: true });
  writeFileSync(pubMoved, JSON.stringify({ from: "a", to: "b" }));
  execFileSync("git", ["-C", pubWs, "add", pubMoved]);
  execFileSync("git", ["-C", pubWs, "commit", "-qm", "add moved.json (to be pushed)"]);
  const pubRemote = join(ROOT, "pub-remote.git");
  execFileSync("git", ["init", "--bare", "-q", pubRemote]);
  execFileSync("git", ["-C", pubWs, "remote", "add", "origin", pubRemote]);
  execFileSync("git", ["-C", pubWs, "push", "-q", "-u", "origin", "HEAD:refs/heads/main"]); // moved.json is now PUSHED (in @{upstream})
  ok(execFileSync("git", ["-C", pubWs, "rev-list", "@{upstream}..HEAD", "--", ".dev-loop/moved.json"], { encoding: "utf8" }).trim() === "",
     "(t) precondition: moved.json is in NO unpushed commit (@{upstream}..HEAD carries nothing for it) — it is already published");
  ok(spawnSync("git", ["-C", pubWs, "cat-file", "-e", "HEAD:.dev-loop/moved.json"]).status === 0,
     "(t) precondition: moved.json IS in HEAD — the pre-fix `cat-file -e HEAD:<rel>` check would call it 'committed' and emit rebase/reset advice");
  const docPub = cli(["doctor"], pubWs);
  const pubOut = `${docPub.stdout}${docPub.stderr}`;
  const pubW06 = pubOut.split("\n").find((l) => /secret\/state-bearing/.test(l)) ?? ""; // the artifact-leak line only
  ok(/moved\.json/.test(pubW06), "(t) W06 still warns for an un-ignored, already-pushed moved.json (names moved.json)");
  ok(/rotate/.test(pubW06) && /\.gitignore/.test(pubW06), "(t) published marker: remediation says rotate/revoke the secret + .gitignore going forward");
  ok(!/rebase|reset/.test(pubW06) && !/unpushed commit/.test(pubW06),
     "(t) published marker: NO rewrite-history advice (rebase/reset/unpushed commit) — rewriting already-pushed history won't un-leak it (LOOP-235 review PRRT_…VoHA7)");

  // (b) export into a NON-git-tree workspace ⇒ silent (no false positive).
  const plainWs = join(ROOT, "plain-ws"); mkdirSync(plainWs, { recursive: true });
  ok(cli(["team", "init", "--dir", plainWs, "--key", "gg2", "--backend", "service", "--yes"], ROOT).status === 0, "setup: plain-ws team init");
  const expPlain = cli(exportArgs(join(plainWs, "ws.bundle")), plainWs);
  ok(expPlain.status === 0, `(b) export outside a git tree exits 0 (got ${expPlain.status})`);
  ok(!/git working tree/.test(expPlain.stderr), "(b) export outside a git tree is silent — no tree warning");

  // (c) explicit --out to a path OUTSIDE the tree (from inside the git-ws) ⇒ unchanged / silent.
  const outsideDir = tmpRoot("dl-outside-");
  const expOut = cli(exportArgs(join(outsideDir, "ws.bundle")), gitWs);
  ok(expOut.status === 0, `(c) export with --out outside the tree exits 0 (got ${expOut.status})`);
  ok(!/git working tree/.test(expOut.stderr), "(c) --out to a path outside the tree is unchanged (no warning), even when the workspace root is a git tree");
} finally {
  try { execFileSync("rm", ["-rf", ROOT]); } catch { /* best-effort */ }
}
process.exit(fails === 0 ? 0 : 1);
