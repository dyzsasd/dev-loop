# Releasing

Releases are published by GitHub Actions, not from a local terminal. That keeps npm's 2FA prompt out of
the operator workflow and gives every npm release a matching git tag.

## One-time setup — publish auth (either one)

1. **npm trusted publishing (OIDC, recommended — no secret to rotate).** On npmjs.com →
   `@dyzsasd/dev-loop` → Settings → Trusted Publisher: add GitHub Actions with repository
   `dyzsasd/dev-loop` and workflow `release-npm.yml`. The workflow exchanges the Actions id-token
   automatically when no `NPM_TOKEN` secret is present.
2. **`NPM_TOKEN` repository secret.** An npm automation/granular token with publish access for
   `@dyzsasd/dev-loop`, added as a GitHub repository secret. Takes precedence when set.

## Version bump conventions

The workflow computes the version — you pick the bump type, matching what actually shipped since the
last release:

| Bump | When | Examples from this repo |
|---|---|---|
| `patch` | Bug fixes, docs, internal refactors, test-only changes — nothing an operator must learn. | A daemon fix, a README sweep, a doctor message tweak. |
| `minor` | New operator-facing capability, backward compatible — new commands/flags, new config fields, new warning codes, new files the runtime reads. | `.dev-loop/secrets.env`, a new agent, a new `team set` path. |
| `major` | Breaking: config schema breaks, CLI verbs removed/renamed, state layout migrations that need operator action. | A `dev-loop.json` schemaVersion bump. |
| `explicit` | Escape hatch: resume a half-finished release (tag pushed, npm publish failed) or cut a prerelease. Fills the `version` input. | Re-running a failed publish with the same version. |

When in doubt between patch and minor: if `references/config-schema.md` or a SKILL changed, it is
minor.

**Changelog rule.** Every release ships a `## <version>` section in `CHANGELOG.md` — the workflow
refuses to release without one. Accumulate entries under `## Unreleased` as PRs land; the workflow
renames that heading into the version being cut (the rename rides the release commit). Finalizing the
heading by hand before releasing also works — matching `## <version>` passes the gate directly.

## Cut a release

1. Open the **Release npm package** workflow in GitHub Actions.
2. Run it from `main`.
3. Pick the bump type (`patch` / `minor` / `major`); leave `version` empty.
4. Keep the npm tag as `latest` unless this is a prerelease.

The workflow then: computes the version from `hub/package.json` → validates the tag/npm state →
stamps the changelog heading → stamps the shared version into `hub/package.json`,
`hub/package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` →
typechecks + runs the full hub test suite → creates the release commit + `v<version>` tag → pushes
them → publishes `hub/` to npm with provenance.

## If publishing fails

The push happens BEFORE the publish (npm versions are irrevocable; git pushes are recoverable), so a
failed publish leaves the tag + release commit on `main` with nothing on npm. Fix the auth/package
issue, then re-run the workflow with `bump: explicit` and the SAME version — the validation step
detects the pushed tag, skips re-tagging, and resumes the publish. (Do NOT re-run with a bump type:
the manifests already carry the new version, so a bump would compute the version after it.)

### The resume contract: a resume publishes the TAG, not the branch tip

**`main` may advance freely after the tag is pushed. It does not affect the resume.** A resume
dispatch checks out `refs/tags/v<version>` and publishes that tree; the branch tip is never
consulted, never compared, and never required to still equal the tag.

That is worth stating because the opposite used to be true and cost a release. `actions/checkout@v4`
checks out the branch at its current tip, and two steps asserted `HEAD == tag`. When a docs commit
landed 40 minutes after `v1.15.1`'s tag, every subsequent `bump: explicit` dispatch failed on that
assertion regardless of the npm state, and the only way through was a hand-pushed
`release/v1.15.1-resume` branch parked at the tag commit. **Do not re-invent that branch** — if a
resume fails today, the cause is not the branch tip, and pushing a resume branch will not help.

Mechanically (LOOP-385): `Validate release target` probes git + npm and calls
`hub/src/release-mode.ts`, which returns `fresh` or `resume` once for the whole job and exports
`RELEASE_MODE` / `PUBLISH_REF`. On `resume` the tag is checked out and every step whose job was to
*produce* what the tag already holds is skipped — changelog stamping, version stamping, the release
commit and tag, and the push. Everything that *proves* the artifact still runs: install, typecheck,
the full test suite, build, source integrity, and the pre-publish check that the remote tag is the
commit being published. The `HEAD == tag` assertions were kept, not deleted — after the tag checkout
they are true by construction, which is a stronger guarantee than "the branch happens to still match".

### The residual race on a FRESH release

A fresh release still has a window: the version is computed and the tests run (~9 minutes) before the
release commit and tag are pushed. If someone lands on `main` inside that window, the push is
rejected.

**This is bounded, not fixed, and deliberately so.** The push is a single
`git push --atomic origin "HEAD:<branch>" "v<version>"`, so a non-fast-forward branch update takes
the tag down with it: the job fails at the push step with git's own `fetch first` message, having
left **no half-tagged state** — nothing on the remote, nothing on npm. Re-run the workflow from the
start; there is nothing to clean up. Do not split that push into two commands, and do not pause the
loop for a release window on account of this race — the atomic push is what makes the window safe to
lose.
