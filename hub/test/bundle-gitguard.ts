// LOOP-210 — bundle export must not silently drop a secret-bearing artifact into a git working tree,
// and doctor W06 must stop certifying a tree it did not measure. The bug: `bundle export --out` writes
// an artifact carrying every secret VALUE + hub.db with no tree guard, and W06 asked "is .dev-loop/
// ignored?" not "is anything here committable?" — so with .dev-loop/ ignored it printed a clean line
// one line after a committable bundle was written. All fixtures are hermetic (own temp git repos) and
// §16-clean: no real secret VALUES — export runs --insecure-plaintext on a minimal fresh workspace.
import { execFileSync, spawnSync } from "node:child_process";
import { scrubFireEnv } from "./env-scrub.ts";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-gitguard-"));
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
  ok(/git rm --cached/.test(remSOut), "(l) staged leak: the remediation tells the operator to `git rm --cached` — a .gitignore rule does not unstage a tracked blob (LOOP-235 review P1 #7)");

  // (b) export into a NON-git-tree workspace ⇒ silent (no false positive).
  const plainWs = join(ROOT, "plain-ws"); mkdirSync(plainWs, { recursive: true });
  ok(cli(["team", "init", "--dir", plainWs, "--key", "gg2", "--backend", "service", "--yes"], ROOT).status === 0, "setup: plain-ws team init");
  const expPlain = cli(exportArgs(join(plainWs, "ws.bundle")), plainWs);
  ok(expPlain.status === 0, `(b) export outside a git tree exits 0 (got ${expPlain.status})`);
  ok(!/git working tree/.test(expPlain.stderr), "(b) export outside a git tree is silent — no tree warning");

  // (c) explicit --out to a path OUTSIDE the tree (from inside the git-ws) ⇒ unchanged / silent.
  const outsideDir = mkdtempSync(join(tmpdir(), "dl-outside-"));
  const expOut = cli(exportArgs(join(outsideDir, "ws.bundle")), gitWs);
  ok(expOut.status === 0, `(c) export with --out outside the tree exits 0 (got ${expOut.status})`);
  ok(!/git working tree/.test(expOut.stderr), "(c) --out to a path outside the tree is unchanged (no warning), even when the workspace root is a git tree");
} finally {
  try { execFileSync("rm", ["-rf", ROOT]); } catch { /* best-effort */ }
}
process.exit(fails === 0 ? 0 : 1);
