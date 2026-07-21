# Local developer-code scanner

`local_code_scan.py` is a read-only incident scanner for source trees, installed
npm packages, npm caches, package-manager runtimes, editor extensions, and local
Git object databases. It uses the Python standard library and never imports or
executes scanned project code.

## Incident scan

Run the scanner from a trusted copy. On a suspect host, place the script on a
read-only or encrypted external volume and record its SHA-256 before use.

The developer profile prioritizes `~/workspace`, npm/NVM/pnpm/Yarn/Bun/Volta/
asdf/mise locations and caches, Homebrew/global `node_modules`, npm cacache
blobs, and VS Code-family extensions/cached VSIX files. `all-objects` includes
packed and unreachable local Git blobs, not only commits reachable from
branches and tags.

```bash
/usr/bin/python3 -I -S security/local_code_scan.py \
  --profile developer \
  --git-history all-objects \
  --format json \
  --output "$HOME/Desktop/local-code-scan.json"
```

To inspect Git object databases without rereading every current worktree file:

```bash
/usr/bin/python3 -I -S security/local_code_scan.py \
  --no-default-roots \
  --root "$HOME/workspace" \
  --git-history all-objects \
  --git-only \
  --format json \
  --output "$HOME/Desktop/local-git-object-scan.json"
```

Scan other code under the current user's home directory as a second pass:

```bash
/usr/bin/python3 -I -S security/local_code_scan.py \
  --profile home \
  --git-history all-objects \
  --format json \
  --output "$HOME/Desktop/local-code-home-scan.json"
```

The broader system-developer profile adds `/Users`, `/usr/local`, Homebrew,
system launch-agent directories, and temporary storage:

```bash
/usr/bin/python3 -I -S security/local_code_scan.py \
  --profile full \
  --git-history all-objects \
  --format json \
  --output "$HOME/Desktop/local-code-full-scan.json"
```

Do not add `sudo` merely to suppress permission errors. An unreadable requested
path makes the result incomplete (exit 2), which is materially different from a
clean result. If privileged offline inspection is required, run it from a known
clean recovery environment.

Large native packages are intentionally bounded. Archive recursion defaults to
two nested levels. A follow-up for explicitly
reviewed paths can raise `--max-file-mib`, `--max-archive-member-mib`, and
`--max-archive-total-mib`, or `--max-archive-depth`; reduce `--jobs` at the same
time to bound memory. A limit finding remains incomplete until that follow-up
finishes.

To scan only explicit paths:

```bash
/usr/bin/python3 -I -S security/local_code_scan.py \
  --no-default-roots \
  --root "$HOME/workspace" \
  --root /opt/homebrew/lib/node_modules
```

## Safety and reporting

- Directory traversal uses held directory descriptors plus `O_NOFOLLOW`;
  symlinks, devices, sockets, and FIFOs are never followed or read.
- `.git/objects` is not treated as a filesystem tree. Optional Git inspection
  uses `/usr/bin/git cat-file` with hooks, global config, replace objects, and
  optional locks disabled. Lazy object fetching and interactive prompts are
  disabled, so partial clones are not completed over the network.
- npm tar/tgz, Yarn ZIP caches, and VSIX/cacache archives are read in memory.
  Members are never extracted to disk; traversal/link/encryption names,
  malformed containers, and size/member/ratio/depth limit violations are
  reported as findings or incomplete scans.
- npm cacache content hashes are checked against their `content-v2` paths.
- Findings contain paths, rules, offsets, and hashes, but no source snippets,
  environment values, cookies, or credential contents.
- Finding/issue samples and untrusted metadata are size-bounded. Omitted sample
  counts remain in the report, and severity-specific reserves ensure later
  high/critical detections still control the exit status.
- Reports written through `--output` receive mode `0600`.
- `~/.quarantine` is excluded by default and listed in the report. Use
  `--include-quarantine` only for isolated evidence review; expected evidence
  hits do not mean an active path has been reinfected.

Severity and exit status:

- `critical`: verified incident hash/marker or active stealer staging.
- `high`: multiple independent loader/lifecycle indicators occur together.
- `review`: a single ambiguous heuristic requiring manual classification.
- Exit `0`: complete scan with no finding at or above `--fail-on`.
- Exit `1`: complete scan with a finding at or above the threshold.
- Exit `2`: incomplete scan or report-write failure. Findings are still kept.
- Exit `130`: interrupted by the operator.

The default threshold is `high`. Use `--fail-on review` for a noisy audit and
`--inventory-lifecycle` to list every npm lifecycle script.

This scanner is not an antivirus or runtime monitor. It does not prove that a
remote Git host is clean, inspect process memory/firmware, or structurally parse
ASAR containers. ASAR files still receive raw exact-hash/IOC checks. ZIP64 and
unsupported/encrypted archive members are reported incomplete rather than
silently skipped. Review all high/critical results before removing anything;
the scanner has no delete or quarantine operation.

## Tests

The tests use only synthetic inert payloads and temporary Git/tar fixtures:

```bash
/usr/bin/python3 -m unittest security.test_source_integrity security.test_local_code_scan
```
