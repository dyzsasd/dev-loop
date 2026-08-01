// LOOP-210 — bundle export must not silently drop a secret-bearing artifact into a git working tree,
// and doctor W06 must stop certifying a tree it did not measure. The bug: `bundle export --out` writes
// an artifact carrying every secret VALUE + hub.db with no tree guard, and W06 asked "is .dev-loop/
// ignored?" not "is anything here committable?" — so with .dev-loop/ ignored it printed a clean line
// one line after a committable bundle was written. All fixtures are hermetic (own temp git repos) and
// §16-clean: no real secret VALUES — export runs --insecure-plaintext on a minimal fresh workspace.
import { execFileSync, spawnSync } from "node:child_process";
import { scrubFireEnv } from "./env-scrub.ts";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
  ok(!/git add -A/.test(cleanOut), "W06: no false-positive bundle warning on a tree with no bundle artifact");

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
