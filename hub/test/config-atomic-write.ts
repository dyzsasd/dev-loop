// `dev-loop.json` is written through a same-directory tmp + rename, never in place.
//
// A plain writeFileSync opens with O_TRUNC: the file is emptied first and refilled after, so a reader
// that lands in that window sees a truncated or zero-length config. A half-written dev-loop.json is
// unloadable, and run-agents' configParses() gate then pauses every fire until someone restores it from
// git — from a verb (`dev-loop team set`) that doctor's own W28 remediation tells the operator to run.
// destructive-guard.ts already had writeConfigAtomic for exactly this reason, with the reasoning in its
// comment; the three writers of the file did not use it.
//
// Behavioural half: a reader hammering the file across many writes must never observe invalid JSON. The
// config is padded first so the write window is wide enough for the pre-fix truncation to be caught
// reliably rather than occasionally.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-atomic-"));
const env = () => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });

const ws = join(tmp, "ws");
team(["init", "--dir", ws, "--key", "atomic-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
const cfg = join(ws, "dev-loop.json");

// Widen the write window on purpose. The truncate-then-refill gap is sub-millisecond on a small file,
// so a modest fixture catches it only a handful of times in ~170k reads — close enough to zero that the
// test could pass on an unfixed build. ~480 KB across 24 real mutator runs puts the pre-fix signal well
// clear of zero.
const base = JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>;
for (let i = 0; i < 1200; i++) {
  (base as Record<string, unknown>)[`_pad_${i}`] = "x".repeat(400);
}
writeFileSync(cfg, JSON.stringify(base, null, 2) + "\n");

// A reader in a separate process, parsing as fast as it can while the writes run.
const readerSrc = join(tmp, "reader.mjs");
writeFileSync(readerSrc, `
import { readFileSync, writeFileSync } from "node:fs";
let bad = 0, reads = 0;
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  reads++;
  try { JSON.parse(readFileSync(${JSON.stringify(cfg)}, "utf8")); }
  catch { bad++; }
}
writeFileSync(${JSON.stringify(join(tmp, "reader.out"))}, JSON.stringify({ reads, bad }));
`);
const reader = spawnSync("node", ["-e", `
  const { spawn } = require("node:child_process");
  const c = spawn(process.execPath, [${JSON.stringify(readerSrc)}], { stdio: "ignore", detached: true });
  c.unref(); console.log(c.pid);
`], { encoding: "utf8" });
ok(reader.status === 0, "fixture: the concurrent reader started");

// Drive the real mutator repeatedly while the reader is running.
for (let i = 0; i < 24; i++) team(["set", "team.budget.perFireUsd", String(5 + (i % 3))], ws);

// Let the reader finish its window.
const until = Date.now() + 25_000;
let out: { reads: number; bad: number } | null = null;
while (Date.now() < until && out === null) {
  spawnSync("sleep", ["1"]);
  try { out = JSON.parse(readFileSync(join(tmp, "reader.out"), "utf8")) as { reads: number; bad: number }; } catch { /* not written yet */ }
}
ok(out !== null && out.reads > 0, `fixture: the reader observed the file (${out?.reads ?? 0} reads)`);
ok(out !== null && out.bad === 0, `no reader ever observed a partially written dev-loop.json (${out?.bad ?? "?"} bad of ${out?.reads ?? "?"})`);

// The config the mutators left behind is valid and carries the last edit.
const final = JSON.parse(readFileSync(cfg, "utf8")) as { team?: { budget?: { perFireUsd?: number } } };
ok(typeof final.team?.budget?.perFireUsd === "number", "the config is valid JSON after the writes and carries the edit");
// No tmp file is left behind on the happy path.
ok(readdirSync(ws).filter((f) => f.startsWith("dev-loop.json.tmp-")).length === 0, "no .tmp- file is left in the workspace");

console.log(fails === 0 ? "\nCONFIG_ATOMIC_WRITE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
