// Atomic file replacement for the configuration files whose partial state is unrecoverable.
//
// It lived in destructive-guard.ts, private to commitBothHalves, until three unrelated writers needed the
// same guarantee: `dev-loop team set` / `add-project` / `add-repo` (team-edit.ts), `team init` and
// `team import` all replace dev-loop.json, and each did it with a plain writeFileSync. That opens with
// O_TRUNC — the file is emptied first and refilled after — so a reader landing in the window sees a
// truncated config, and an unloadable dev-loop.json pauses every fire until someone restores it from git.
// A shared guarantee needs a shared home; destructive-guard's job is gating destructive operations, not
// owning a file-write primitive.
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

// Write `configPath` through a same-directory tmp + rename, so a reader never observes a partially
// written file. Same directory is load-bearing: `renameSync` is only atomic within one filesystem, and a
// half-written `dev-loop.json` is unloadable — it takes the whole workspace down.
//
// Takes `string | Buffer` because the COMPENSATING path restores the exact bytes it retained. Passing the
// retained Buffer straight through keeps the restore byte-exact; decoding it to a string first would round
// -trip through UTF-8 and silently substitute U+FFFD for any byte sequence that did not decode — turning a
// rollback that promises "unchanged" into a quiet corruption of the file it was rescuing.
export function writeConfigAtomic(configPath: string, text: string | Buffer): void {
  const tmp = `${configPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, configPath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created, or already gone — not the failure worth reporting */ }
    throw e;
  }
}
