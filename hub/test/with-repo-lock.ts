// LOOP-455 regression: every contender for the shared repo lock uses ONE stale policy.
//
// THE DEFECT THIS PINS. `acquireLock` decides staleness in the CONTENDER, from `{pid, at}` — the
// holder encodes nothing about how long it intends to hold. `pr merge` asked for a 15-minute
// staleMs; `with-repo-lock` passed none and inherited the 30-second default. So the two agreed on
// the lock's NAME (`repo-<ref>`, the whole point of LOOP-455) and disagreed on when it expires:
// a `with-repo-lock` merge-back arriving 31 seconds into a slow gate-and-squash judged the LIVE
// holder abandoned, broke its lock, and entered the same branch's critical section — precisely
// during the slow landing the lock exists to protect.
//
// It is asserted end-to-end through the real CLI, not by comparing constants: a same-value check
// on two imports would pass with the argument still per-caller, which is the shape of the bug.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { REPO_LOCK_STALE_MS } from "../src/locks.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "with-repo-lock.ts");
const ROOT = mkdtempSync(join(tmpdir(), "dl-with-repo-lock-"));

// A fixture workspace with ONE registered repo, and its `repo-mine` lock already held.
const ws = join(ROOT, "ws");
const repo = join(ws, "checkout");
mkdirSync(repo, { recursive: true });
writeFileSync(join(ws, "dev-loop.json"), JSON.stringify({
  schemaVersion: 2, team: { key: "t455", backend: "service" }, repos: { mine: { path: "checkout" } }, projects: {},
}));
const lockPath = join(ws, ".dev-loop", "locks", "repo-mine.lock");
mkdirSync(dirname(lockPath), { recursive: true });

// The holder is THIS process: a real, live pid, so the liveness arm of `isStale` cannot be what
// decides — only the age bound can. Aged 2 minutes: past the 30s default that was in force, far
// inside the 15-minute policy the repo lock actually has.
const HELD_AGE_MS = 120_000;
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - HELD_AGE_MS).toISOString() }));

const marker = join(ROOT, "entered-the-critical-section");
const r = spawnSync(process.execPath, [CLI, "mine", "--wait", "1s", "--", "sh", "-c", `printf x > ${JSON.stringify(marker)}`], {
  cwd: ws,
  env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: ws },
  encoding: "utf8",
});

ok(HELD_AGE_MS > 30_000 && HELD_AGE_MS < REPO_LOCK_STALE_MS,
  `LOOP-455: the fixture lock is aged into the window the two policies disagreed about (${HELD_AGE_MS}ms: past the 30s default, inside ${REPO_LOCK_STALE_MS}ms)`);

// The load-bearing assertion: the command NEVER RAN. Not "it exited non-zero" — a command that ran
// and failed would also do that; what must be impossible is a second writer inside the section.
ok(!existsSync(marker),
  "LOOP-455: a live holder's lock is not broken mid-landing — the wrapped command never entered the critical section");
ok(r.status === 1,
  `LOOP-455: …and the contender reports the contention it lost, rather than proceeding (exit ${r.status})`);
ok((r.stderr ?? "").includes(lockPath),
  `LOOP-455: …on the SAME path pr merge takes for this ref, so the two really are one lock (stderr: ${JSON.stringify((r.stderr ?? "").trim().slice(0, 200))})`);
ok(existsSync(lockPath) && (JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }).pid === process.pid,
  "LOOP-455: …and the holder's lock file is still the holder's — it was not stolen and re-stamped");

// The control: the same call with NOTHING holding the lock runs the command. Without this arm every
// assertion above would also pass if `with-repo-lock` had simply stopped working.
const free = join(ROOT, "ran-when-free");
unlinkSync(lockPath);
const r2 = spawnSync(process.execPath, [CLI, "mine", "--wait", "1s", "--", "sh", "-c", `printf x > ${JSON.stringify(free)}`], {
  cwd: ws,
  env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: ws },
  encoding: "utf8",
});
ok(r2.status === 0 && existsSync(free) && !existsSync(lockPath),
  `LOOP-455/control: an UNCONTENDED call still runs its command and releases the lock (exit ${r2.status}, ran=${existsSync(free)}, lock left=${existsSync(lockPath)})`);

// ── The policy is only shared if EVERY contender uses it ────────────────────────────────────────
// The arms above drive ONE contender. But staleness is judged by whoever arrives, so a single module
// still taking a `repo-<ref>` path through the unpolicied primitives reopens the hole for everyone —
// `doc-land` and the worktree add/remove sequences lock the same paths, and with `withLock`'s 30s
// default either could break a live `pr merge` holder mid-squash. That is an invariant over the
// module set, not over one call, so it is asserted as one: any module that builds a `repo-` lock path
// must reach it through `acquireRepoLock` / `withRepoLockPath`.
const SRC = join(HERE, "..", "src");
const buildsRepoLock = (src: string): boolean => /wsLockPath\([^)]*`repo-/.test(src);
const found = readdirSync(SRC).filter((f) => f.endsWith(".ts") && buildsRepoLock(readFileSync(join(SRC, f), "utf8"))).sort();
// Pinned so the scan cannot pass by finding nothing — a predicate that silently stops matching its
// own motivating modules is the failure this list exists to catch.
//
// `pr-merge.ts` was on this list until LOOP-521, which moved the resolution it owned into
// `repo-lock-path.ts` so `pr merge` and `push` could not resolve two different names for one repo —
// so the module that BUILDS the path is now that one, and `pr-merge.ts` reaches it by import. The
// list follows the expression, not the verb: the invariant is unchanged and the count is unchanged,
// which is what keeps this from being a pin quietly relaxed to match whatever the tree happens to say.
for (const expected of ["doc-land.ts", "repo-lock-path.ts", "with-repo-lock.ts", "worktree.ts"]) {
  ok(found.includes(expected), `LOOP-455: the repo-lock scan still sees ${expected} (found: ${found.join(", ") || "none"})`);
}
for (const f of found) {
  const m = /\b(withLock|acquireLock)\s*\(/.exec(readFileSync(join(SRC, f), "utf8"));
  ok(!m, m
    ? `LOOP-455: ${f} builds a repo-<ref> lock path but takes it with a bare ${m[1]}(, which carries the 30s default and breaks live holders — use acquireRepoLock/withRepoLockPath`
    : `LOOP-455: ${f} reaches its repo-<ref> lock only through the shared policy`);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `${fails} CHECK(S) FAILED` : "with-repo-lock: all checks passed");
process.exit(fails ? 1 : 0);
