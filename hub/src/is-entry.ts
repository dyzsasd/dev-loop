import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The ONE entry-point guard for every `node src/<x>.ts` CLI in hub/src (LOOP-63). Pass `import.meta.url`;
// returns true when THIS module is the process entry (it was run directly), false when it was imported.
//
// Why realpath BOTH sides: `import.meta.url` is a realpath-resolved, percent-ENCODED file URL, while
// `process.argv[1]` is the RAW invocation path (symlinks intact, space/`#`/non-ASCII left literal). The
// three ad-hoc idioms this replaces compared those two mismatched shapes directly, so a guard silently
// no-op'd whenever the checkout path held a URL-escapable char (macOS "Google Drive" / "iCloud Drive"
// checkouts) or was reached through a symlink (`/tmp`→`/private/tmp`) — main() never ran and the CLI
// exited 0 having done nothing (the LOOP-58 / LOOP-63 failure class). Resolving argv[1] through realpath
// and comparing decoded paths is correct on every one of those. test/consistency.ts (§8) fails CI if any
// hub/src file brings an ad-hoc idiom back.
export function isMainEntry(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
}
