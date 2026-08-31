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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
let armed = false;

// Only "exit" is hooked. It covers every way a suite ends on its own — process.exit(0) and (1) alike,
// and an uncaught throw — because that is the whole population of endings a suite controls. Signal
// handlers are deliberately NOT installed: several suites assert on signal delivery, and a handler here
// would change the process's disposition out from under them. A suite SIGKILLed by the runner's hang
// ceiling therefore still leaves its tree behind; that path is rare, already a failure, and the residue
// is then a symptom worth keeping rather than one worth hiding.
const sweep = () => {
  for (const dir of roots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort — never fail a green suite on cleanup */ }
  }
};

export function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  if (!armed) { armed = true; process.on("exit", sweep); }
  return dir;
}
