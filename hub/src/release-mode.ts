#!/usr/bin/env node
// `node hub/src/release-mode.ts …` — the ONE answer to "what is this release dispatch doing?" (LOOP-385).
//
// The release workflow used to decide this three times. `Validate release target` got it RIGHT and
// then only echoed it, so two later steps re-derived it from a question that is not the same question:
//
//   Commit and tag release       | TAG_COMMIT != HEAD_COMMIT  ⇒ exit 1
//   Verify final release refs    | test tag^{commit} = HEAD
//
// `actions/checkout@v4` checks out GITHUB_REF — the BRANCH, at its current tip — so both of those are
// really asking "has anything landed on the branch since the tag?". Any commit that has makes every
// future `bump: explicit` dispatch fail permanently: a docs fire landed 1785779 forty minutes after
// v1.15.1's tag, and the escape hatch was a hand-pushed `release/v1.15.1-resume` branch parked at the
// tag commit. The workaround was becoming the mechanism.
//
// On a resume there is nothing to compute and nothing to push: the tagged commit already carries the
// stamped manifests, the stamped changelog section and the release commit, and the tag is already on
// the remote. The only work left is to build that tree and publish it. So the resume path publishes
// from `refs/tags/v<version>` and the workflow skips every step whose job was to PRODUCE what the tag
// already holds. The two `HEAD == tag` assertions stay in the workflow untouched and stop being a
// failure mode, because after that checkout HEAD *is* the tag by construction — strictly stronger
// than "the branch happens to still equal it". On a path that decides which tree becomes a public
// package, the assertion is not deleted; it is made true.
//
// This module takes the PROBE RESULTS as inputs and touches neither git nor the network, so the whole
// truth table is testable with no fixture and without cutting a release (releases are
// workflow_dispatch-only and no fire may cut one). The defect is then expressible as a property
// rather than a repro: the decision cannot read the branch tip, because there is no input for it.

export type ReleaseMode = "fresh" | "resume" | "refuse";

/** Everything the decision is allowed to know. Deliberately no branch tip, and no way to ask for one. */
export interface ReleaseFacts {
  version: string;      // the resolved target version, bare semver
  tagExists: boolean;   // `git rev-parse -q --verify refs/tags/v<version>`
  npmExists: boolean;   // `npm view <pkg>@<version> version`
  refType: string;      // GITHUB_REF_TYPE — "branch" or "tag"
  packageName?: string; // for the human reason only
}

export interface ReleaseDecision {
  mode: ReleaseMode;
  /** The ref the publish must be built from. `refs/tags/v<version>` on resume; "" when the checked-out branch already is it. */
  publishRef: string;
  /** One line, safe for a log and for `$GITHUB_ENV` (no newlines). */
  reason: string;
}

export const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * The truth table, which is today's `Validate release target` rules plus the one that was missing:
 *
 *   refType     | tag | npm | mode    | why
 *   ------------|-----|-----|---------|-------------------------------------------------------
 *   not branch  |  *  |  *  | refuse  | run from a branch, not a tag
 *   branch      | no  | no  | fresh   | the normal release
 *   branch      | YES | no  | RESUME  | tag pushed, publish failed ⇒ publish FROM THE TAG
 *   branch      | no  | YES | refuse  | on npm without a tag — reconcile by hand
 *   branch      | YES | YES | refuse  | already fully released
 */
export function releaseDecision(f: ReleaseFacts): ReleaseDecision {
  const pkg = f.packageName ?? "the package";
  if (!SEMVER_RE.test(f.version)) {
    return { mode: "refuse", publishRef: "", reason: `version '${f.version}' is not bare semver — reconcile manually.` };
  }
  if (f.refType !== "branch") {
    return { mode: "refuse", publishRef: "", reason: `Run this workflow from a branch, not ${f.refType}.` };
  }
  if (f.tagExists && f.npmExists) {
    return { mode: "refuse", publishRef: "", reason: `v${f.version} is already fully released (tag + npm).` };
  }
  if (f.tagExists) {
    // The resume. Publish the TAGGED tree — never whatever the branch has drifted to since.
    return {
      mode: "resume",
      publishRef: `refs/tags/v${f.version}`,
      reason: `Tag v${f.version} exists but ${pkg}@${f.version} is not on npm — resuming publish from the tag (the branch tip is not consulted).`,
    };
  }
  if (f.npmExists) {
    return { mode: "refuse", publishRef: "", reason: `${pkg}@${f.version} is on npm but tag v${f.version} is missing — reconcile manually.` };
  }
  return { mode: "fresh", publishRef: "", reason: `Cutting a fresh release of v${f.version} from the checked-out branch.` };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Prints the two `KEY=VALUE` lines the workflow appends to $GITHUB_ENV on stdout, and the human
// reason on stderr (so `>> "$GITHUB_ENV"` captures only the assignments). A `refuse` exits 1, which
// is exactly what the inline bash did — the refusal behaviour is preserved, not relaxed.
//
// Both emitted values are closed sets: the mode is an enum and publishRef is built from a
// semver-validated version, so neither can inject a line into the env file.
function parseArgs(argv: string[]): ReleaseFacts {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bool = (name: string): boolean => {
    const v = get(name);
    return v === "1" || v === "true";
  };
  return {
    version: get("version") ?? "",
    tagExists: bool("tag-exists"),
    npmExists: bool("npm-exists"),
    refType: get("ref-type") ?? "",
    packageName: get("package"),
  };
}

export function main(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  const facts = parseArgs(argv);
  if (!facts.version || !facts.refType) {
    err("usage: release-mode.ts --version <semver> --tag-exists 0|1 --npm-exists 0|1 --ref-type <branch|tag> [--package <name>]");
    return 2;
  }
  const d = releaseDecision(facts);
  err(d.reason);
  if (d.mode === "refuse") return 1;
  out(`RELEASE_MODE=${d.mode}`);
  out(`PUBLISH_REF=${d.publishRef}`);
  return 0;
}

// Entry-point guard: the test imports releaseDecision/main without running the CLI. Compares
// resolved paths rather than `import.meta.url === \`file://${process.argv[1]}\`` — that spelling
// silently fails on any checkout path holding a URL-escaped character, which is the LOOP-58 defect.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  process.exit(main(process.argv.slice(2), (s) => console.log(s), (s) => console.error(s)));
}
