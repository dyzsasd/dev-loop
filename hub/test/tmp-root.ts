// NOT a suite (run-all.ts lists it under NON_SUITES): the shared temp-root factory every suite uses
// instead of calling mkdtempSync directly.
//
// Suites created their temp trees with `mkdtempSync(join(tmpdir(), "dl-…"))` and, in most files, never
// removed them. Each one holds a whole workspace — hub.db, worktrees, node fixtures — so the residue is
// not small: measured on the maintainer's machine, 3264 directories and 1.3 GB had accumulated over four
// days, the oldest surviving from a run three days earlier. Nothing reported it. The suites all passed,
// and the runner has no view of what a suite leaves on disk — the same blind spot that let a fire's
// background service hold a port for two days (see fire-group-reap.ts).
//
// `tmpRoot` returns EXACTLY what mkdtempSync returned — no realpath, no normalisation — so converting a
// call site cannot change what that suite sees. The only added behaviour is the sweep at process exit.
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
let armed = false;

// Only "exit" is hooked. It covers every way a suite ends on its own — process.exit(0) and (1) alike,
// and an uncaught throw — because that is the whole population of endings a suite controls. Signal
// handlers are deliberately NOT installed: several suites assert on signal delivery, and a handler here
// would change the process's disposition out from under them. That decision stands, so a SIGKILLed suite
// cannot clean up after itself — and SIGKILL is not hypothetical: it is what the runner's hang ceiling
// sends, and six trees from six different suites were found surviving a day of local runs.
//
// The suite therefore also writes each root to the manifest named by DEVLOOP_TEST_TMP_MANIFEST, which
// run-all sets per suite and drains once the suite is over — killed or not. The parent needs no signal
// disposition of its own, so nothing here changes for the suites that assert on delivery. A normal exit
// still sweeps below; the manifest only covers the endings a suite does not control.
const sweep = () => {
  for (const dir of roots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort — never fail a green suite on cleanup */ }
  }
};

export function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  const manifest = process.env.DEVLOOP_TEST_TMP_MANIFEST;
  // Append, never truncate: one suite may take several roots, and the write must survive the suite's death.
  if (manifest) { try { appendFileSync(manifest, `${dir}\n`); } catch { /* the sweep below is the primary path */ } }
  if (!armed) { armed = true; process.on("exit", sweep); }
  return dir;
}
