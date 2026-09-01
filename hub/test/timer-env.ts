// The bounded reader every env-configurable timer delay goes through.
//
// 24e219c introduced it for the seven DEVLOOP_*_TICK_MS knobs and said "one bounded reader now covers all
// seven". It covered seven of NINE — linear.ts's mirror-fetch abort and channel.ts's notify-fetch abort
// kept the bare `Number(env) || dflt` — and it had no test at all, so reverting the guard entirely would
// have left the suite green. Both halves are pinned here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timerEnvMs, MAX_TIMER_MS } from "../src/timer-env.ts";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const NAME = "DEVLOOP_TIMER_ENV_PROBE";
const withEnv = (v: string | undefined, fn: () => number): number => {
  const prev = process.env[NAME];
  if (v === undefined) delete process.env[NAME]; else process.env[NAME] = v;
  try { return fn(); } finally { if (prev === undefined) delete process.env[NAME]; else process.env[NAME] = prev; }
};
const read = (v: string | undefined) => withEnv(v, () => timerEnvMs(NAME, 60_000));

ok(read("250") === 250, `an in-range value passes through (got ${read("250")})`);
ok(read(undefined) === 60_000, "an absent value falls back to the default");
ok(read("") === 60_000, "…and so does an empty one (Number('') is 0, which is not a delay)");
ok(read("abc") === 60_000, "…and an unparseable one");

// The two shapes `Number(env) || dflt` let through. Both are coerced to 1ms by setTimeout/setInterval,
// so the failure is not a wrong cadence but a hot loop — or, on the abort timers, every request aborted
// about a millisecond in.
ok(read("-5") === 60_000, `a NEGATIVE value falls back — it is truthy, so the old expression accepted it (got ${read("-5")})`);
ok(read(String(MAX_TIMER_MS + 1)) === 60_000, `a value past the 32-bit timer limit falls back (got ${read(String(MAX_TIMER_MS + 1))})`);
ok(read(String(MAX_TIMER_MS)) === MAX_TIMER_MS, "…and the limit itself is still accepted — the bound is Node's, not a round number invented here");
ok(read("0") === 60_000, "zero falls back rather than becoming an immediate-fire timer");

// A structural arm: the guard is only worth having if every env-read delay actually goes through it.
// This is what would have caught 24e219c's two misses at the time.
const OFFENDER = /Number\(process\.env\.[A-Z_]*(TICK|TIMEOUT|CHECKPOINT)[A-Z_]*\)\s*\|\|/;
const offenders = ["daemon-notifiers.ts", "linear.ts", "channel.ts", "board-snapshot.ts"]
  .filter((f) => OFFENDER.test(readFileSync(join(srcDir, f), "utf8")));
ok(offenders.length === 0,
  `no timer delay is still read with the bare \`Number(env) || dflt\` (offenders: ${offenders.join(", ") || "none"})`);

console.log(fails === 0 ? "\nTIMER_ENV_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
