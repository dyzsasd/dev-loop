# Releasing

Releases are published by GitHub Actions, not from a local terminal. That keeps npm's 2FA prompt out of
the operator workflow and gives every npm release a matching git tag.

## One-time setup

Add an npm automation token to the GitHub repository secrets as `NPM_TOKEN`. The token needs publish
access for `@dyzsasd/dev-loop`.

## Cut a release

1. Open the **Release npm package** workflow in GitHub Actions.
2. Run it from `main`.
3. Enter the bare semver version, for example `0.23.1`.
4. Keep the npm tag as `latest` unless this is a prerelease.

The workflow validates that `v<version>` does not already exist and that the npm version has not already
been published. Then it stamps the shared version into:

- `hub/package.json`
- `hub/package-lock.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

After that it runs the hub test suite, creates a release commit if the version files changed, creates
`v<version>`, publishes `hub/` to npm with provenance, and pushes the commit plus tag back to GitHub.

If npm publishing fails, the workflow stops before pushing the tag. Fix the secret or package issue, then
rerun the workflow with the same version.
