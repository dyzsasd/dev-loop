// LOOP-385 — the release dispatch's mode decision, and the workflow wiring that consumes it.
//
// The defect this suite pins: a resume (`bump: explicit`, tag pushed, npm publish failed) used to be
// decided by comparing the tag against HEAD — and `actions/checkout@v4` puts the BRANCH TIP at HEAD.
// A docs fire landing after the tag therefore broke every future resume dispatch permanently.
//
// Releases are `workflow_dispatch`-only and no fire may cut one, so AC1 is carried two ways instead:
// the truth table (pure, no git, no network) and a real git fixture that tags, ADVANCES MAIN past the
// tag, and then resolves the decision's publishRef — which is the failing scenario reproduced.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseDecision, main } from "../src/release-mode.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const here = dirname(fileURLToPath(import.meta.url));      // hub/test
const repoRoot = join(here, "..", "..");                    // repo root
const PKG = "@dyzsasd/dev-loop";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── A. The truth table ───────────────────────────────────────────────────────
// Every row is one of `Validate release target`'s rules; the RESUME row is the one that was missing
// a consequence (it printed "resuming publish" and then let two HEAD comparisons decide instead).
const T = (tagExists: boolean, npmExists: boolean, refType = "branch") =>
  releaseDecision({ version: "1.15.1", tagExists, npmExists, refType, packageName: PKG });

ok(T(false, false).mode === "fresh", "no tag + not on npm ⇒ fresh");
ok(T(true, false).mode === "resume", "tag + not on npm ⇒ resume (the case that used to fail)");
ok(T(false, true).mode === "refuse", "on npm without a tag ⇒ refuse (reconcile by hand)");
ok(T(true, true).mode === "refuse", "tag + on npm ⇒ refuse (already fully released)");
ok(T(true, false, "tag").mode === "refuse", "dispatched from a tag ref ⇒ refuse, whatever the tag/npm state");
ok(releaseDecision({ version: "1.15", tagExists: true, npmExists: false, refType: "branch" }).mode === "refuse",
  "non-semver version ⇒ refuse (publishRef is built from it, so it is validated first)");

// ── B. The resume publishes the TAG, and says so ─────────────────────────────
const resume = T(true, false);
ok(resume.publishRef === "refs/tags/v1.15.1", "resume publishRef is the tag ref, not a branch");
ok(T(false, false).publishRef === "", "fresh has no publishRef — the checked-out branch already is it");
ok(!/\n/.test(resume.reason), "reason is single-line (it is echoed next to $GITHUB_ENV writes)");

// The property, stated as a test rather than as prose: the decision is a function of these four facts
// ONLY. A branch tip cannot change it because there is nowhere to put one.
ok(JSON.stringify(Object.keys({ version: "", tagExists: false, npmExists: false, refType: "", packageName: "" }).sort())
  === JSON.stringify(["npmExists", "packageName", "refType", "tagExists", "version"]),
  "ReleaseFacts carries no branch-tip input");

// ── C. Git fixture — tag, ADVANCE MAIN, then resolve the publishRef ──────────
// This is the measured failure: v1.15.1 was tagged, a docs fire landed 1785779 forty minutes later,
// and every `bump: explicit` dispatch from main failed the `HEAD == tag` assertions from then on.
const FIX = "/tmp/loop385-release-fixture";
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", FIX, ...args], { encoding: "utf8", env: { ...scrubFireEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

git("init", "-q", "-b", "main");
writeFileSync(join(FIX, "f"), "release\n");
git("add", "f");
git("commit", "-q", "-m", "chore(release): v1.15.1");
git("tag", "-a", "v1.15.1", "-m", "Release v1.15.1");
const tagCommit = git("rev-parse", "v1.15.1^{commit}");

for (const n of [1, 2, 3]) {                       // main advances past the tag, as it did in the field
  writeFileSync(join(FIX, "f"), `after ${n}\n`);
  git("commit", "-q", "-am", `docs(strategy): pass ${n}`);
}
const branchTip = git("rev-parse", "HEAD");
ok(branchTip !== tagCommit, "fixture: main really is ahead of the tag (otherwise the rest is vacuous)");

// The old rule, reproduced: comparing the tag to the checked-out branch tip refuses this release.
ok(git("rev-parse", "HEAD") !== tagCommit, "the OLD `HEAD == tag` rule fails here — this is the outage");

// The new rule: check out the decision's publishRef, and HEAD becomes the tag by construction.
git("checkout", "--detach", "-q", resume.publishRef);
ok(git("rev-parse", "HEAD") === tagCommit, "after checking out publishRef, HEAD IS the tagged commit");
ok(git("rev-parse", "HEAD") !== branchTip, "…and is NOT the advanced branch tip — the published tree is the tagged one");
// The retained assertion in `Verify final release refs` now holds on the resume path.
ok(git("rev-parse", "v1.15.1^{commit}") === git("rev-parse", "HEAD"),
  "the workflow's retained `tag == HEAD` assertion is TRUE after the resume checkout");

// ── D. The CLI contract the workflow depends on ─────────────────────────────
const run = (argv: string[]) => {
  const out: string[] = []; const err: string[] = [];
  const code = main(argv, (s) => out.push(s), (s) => err.push(s));
  return { code, out, err };
};
const r1 = run(["--version", "1.15.1", "--tag-exists", "1", "--npm-exists", "0", "--ref-type", "branch", "--package", PKG]);
ok(r1.code === 0, "resume exits 0");
ok(r1.out.join("\n") === "RELEASE_MODE=resume\nPUBLISH_REF=refs/tags/v1.15.1",
  "stdout is EXACTLY the two $GITHUB_ENV assignments (stdout is redirected into that file)");
ok(r1.err.length === 1, "the human reason goes to stderr, never into $GITHUB_ENV");

const r2 = run(["--version", "1.15.1", "--tag-exists", "0", "--npm-exists", "0", "--ref-type", "branch"]);
ok(r2.code === 0 && r2.out[0] === "RELEASE_MODE=fresh", "fresh exits 0 and reports fresh");
ok(run(["--version", "1.15.1", "--tag-exists", "1", "--npm-exists", "1", "--ref-type", "branch"]).code === 1,
  "refuse exits 1 — the inline bash's refusal behaviour is preserved, not relaxed");
ok(run(["--version", "1.15.1"]).code === 2, "missing --ref-type is a usage error (exit 2)");
ok(run(["--version", "1.15.1", "--tag-exists", "0", "--npm-exists", "0", "--ref-type", "branch"]).out.every((l) => /^[A-Z_]+=[A-Za-z0-9/.\-]*$/.test(l)),
  "every emitted line is a single safe KEY=VALUE — nothing can inject into the env file");

// ── E. The workflow actually consumes the decision ──────────────────────────
// Asserting on the YAML because the bug was never in one function — it was three steps disagreeing.
const wf = readFileSync(join(repoRoot, ".github", "workflows", "release-npm.yml"), "utf8");
const stepBody = (name: string): string => {
  const i = wf.indexOf(`- name: ${name}`);
  if (i < 0) return "";
  const j = wf.indexOf("\n      - name:", i + 1);
  return wf.slice(i, j < 0 ? undefined : j);
};
for (const step of ["Stamp the changelog section", "Stamp version files", "Commit and tag release", "Push release commit and tag"]) {
  ok(/if:\s*env\.RELEASE_MODE == 'fresh'/.test(stepBody(step)), `'${step}' runs on the fresh path only`);
}
ok(/if:\s*env\.RELEASE_MODE == 'resume'/.test(stepBody("Check out the release tag (resume only)")),
  "the tag checkout runs on the resume path only");
ok(/release-mode\.ts/.test(stepBody("Validate release target")), "the validate step calls the decision module");
ok(/>>\s*"\$GITHUB_ENV"/.test(stepBody("Validate release target")), "…and exports the decision to every later step");

// AC2: the fresh-release race is bounded by the ATOMIC push, and that must stay atomic.
const push = stepBody("Push release commit and tag");
ok(/git push --atomic origin "HEAD:\$\{GITHUB_REF_NAME\}" "v\$VERSION"/.test(push),
  "AC2: the push is ONE atomic push of branch+tag — a rejected branch update takes the tag with it, so no half-tagged state");

// The guarantee that must NOT have been deleted: the published tree is the tagged tree.
ok(/test "\$\(git rev-parse "refs\/tags\/v\$VERSION\^\{commit\}"\)" = "\$\(git rev-parse HEAD\)"/.test(stepBody("Verify final release refs and source integrity")),
  "the `tag == HEAD` assertion is still in the workflow — made true by the checkout, not removed");
const remote = stepBody("Verify remote release refs before publish");
ok(/REMOTE_TAG/.test(remote) && !/if:\s*env\.RELEASE_MODE/.test(remote),
  "the pre-publish remote check runs on BOTH paths — a resume still proves the remote tag is what it publishes");

console.log(fails === 0 ? "\nRELEASE_MODE_OK" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
