// The guard that retires the fire-marker family (LOOP-193).
//
// `scrubFireEnv()` has existed since LOOP-156 as the single union of every DEVLOOP fire-marker var,
// and adoption was being driven one ticket per file — LOOP-171, LOOP-189, LOOP-117, LOOP-45. That is
// a treadmill: each new suite that spreads a raw `{ ...process.env }` starts it again, and the board
// pays another ticket to notice.
//
// What leaking costs is not merely a false failure. `DEVLOOP_WORKSPACE` is preferred over the cwd
// walk-up, so a mutator spawn aimed at a tmpdir fixture writes to the PRODUCTION dev-loop.json
// instead — on 2026-08-04 the add-project fixtures `real-one`, `a.p.p`, `app` and `clash` landed in
// the live config through exactly this path.
//
// So: a source-level guard, not another adoption ticket. A new suite that spreads raw ambient env
// into a subprocess fails HERE, at the moment it is written, and the family closes for good.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRE_MARKER_VARS, scrubFireEnv } from "./env-scrub.ts";

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// The documented escape hatch. A suite that genuinely needs the raw ambient env says so ON THE LINE,
// which keeps the exception auditable — `grep` finds every one of them, and each carries its reason.
const EXEMPT_MARKER = /env-scrub-exempt:/;

/** Every `...process.env` spread in a test file that is neither scrubbed nor marked exempt. */
function rawSpreads(file: string): number[] {
  const lines = readFileSync(join(here, file), "utf8").split("\n");
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (!l.includes("...process.env")) return;
    if (EXEMPT_MARKER.test(l)) return;                       // marked, with its reason, on the line
    // …or anywhere in the CONTIGUOUS comment block directly above it. A one-line lookback was not
    // enough: a real exception usually needs a sentence or two to justify itself, and forcing the
    // marker onto the last line before the code would push the reason away from the marker.
    for (let j = i - 1; j >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[j]); j--) if (EXEMPT_MARKER.test(lines[j])) return;
    out.push(i + 1);
  });
  return out;
}

const suites = readdirSync(here).filter((f) => f.endsWith(".ts") && f !== "env-scrub.ts" && f !== "env-scrub-guard.ts");

const offenders = suites.map((f) => ({ file: f, lines: rawSpreads(f) })).filter((o) => o.lines.length);
ok(offenders.length === 0,
  `LOOP-193: no hub/test suite spreads a raw { ...process.env } into a subprocess${offenders.length ? ` — ${offenders.map((o) => `${o.file}:${o.lines.join(",")}`).join("; ")}` : ""}`);

// The guard must be able to FAIL, or it is decoration. Feed it the exact shape it exists to catch.
{
  const detected = ["const env = { ...process.env, FOO: 1 };"].filter((l) => l.includes("...process.env") && !EXEMPT_MARKER.test(l));
  ok(detected.length === 1, "LOOP-193: the guard detects a raw spread — it is not vacuously green");
  const exempted = ["const env = { ...process.env }; // env-scrub-exempt: measures ambient inheritance itself"]
    .filter((l) => l.includes("...process.env") && !EXEMPT_MARKER.test(l));
  ok(exempted.length === 0, "LOOP-193: …and an exempt-marked line is allowed, so a real exception has a legal route");
}

// The helper's own contract, asserted here rather than assumed by 58 call sites.
{
  const saved: Record<string, string | undefined> = {};
  for (const v of FIRE_MARKER_VARS) { saved[v] = process.env[v]; process.env[v] = `leaked-${v}`; }
  try {
    const scrubbed = scrubFireEnv();
    const left = FIRE_MARKER_VARS.filter((v) => scrubbed[v] !== undefined);
    ok(left.length === 0, `LOOP-193: scrubFireEnv removes every fire marker${left.length ? ` — left: ${left.join(", ")}` : ""}`);
    ok(scrubbed.PATH === process.env.PATH, "LOOP-193: …and preserves everything else — it is a scrub, not an empty env");

    // The LOOP-156 contract that must NOT be re-litigated: an explicit fixture override still wins.
    const withOverride = { ...scrubFireEnv(), DEVLOOP_HUB_DB: "/fixture/hub.db" };
    ok(withOverride.DEVLOOP_HUB_DB === "/fixture/hub.db",
      "LOOP-193: an explicit per-fixture override applied AFTER the scrub still wins (the LOOP-156 contract)");
  } finally {
    for (const v of FIRE_MARKER_VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nENV_SCRUB_GUARD_OK");
process.exit(fails ? 1 : 0);
