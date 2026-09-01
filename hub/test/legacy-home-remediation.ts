// A remediation line must not send an operator to a file the runtime no longer reads.
//
// The 1.0 workspace model retired ~/.dev-loop: paths.ts exposes it only as legacyHomeRoot(), with two
// deliberate callers (`team import`, which copies state OUT of it, and doctor's E20, which reports state
// still sitting behind it). Three "no project resolved" messages nevertheless told the operator to run
// "from inside a repo configured in ~/.dev-loop/projects.json" — following that advice creates a file
// nothing reads and reproduces the same error. run-agents.ts already had the correct wording; this test
// is what keeps the other entry points from drifting back.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// "configured in ~/.dev-loop/…" is the shape that misdirects: it presents the retired root as a place to
// PUT configuration. A message that names the path to say it is no longer read (run-agents.ts) is correct
// and must keep working, so the pattern is deliberately narrow.
const MISDIRECT = /configured in ~\/\.dev-loop/;
const offenders: string[] = [];
for (const f of readdirSync(srcDir).filter((n) => n.endsWith(".ts"))) {
  const body = readFileSync(join(srcDir, f), "utf8");
  body.split("\n").forEach((line, i) => { if (MISDIRECT.test(line)) offenders.push(`${f}:${i + 1}`); });
}
ok(offenders.length === 0, `no operator-facing text offers ~/.dev-loop as a place to configure projects (${offenders.join(", ") || "none"})`);

// The three corrected messages must still tell the operator what to do INSTEAD, or the fix would have
// removed the misdirection and left them with nothing.
for (const f of ["cli-tickets.ts", "server.ts", "shim.ts"]) {
  const body = readFileSync(join(srcDir, f), "utf8");
  const hasNoProject = /no project resolved/.test(body);
  ok(hasNoProject && /dev-loop team init/.test(body), `${f}: the "no project resolved" message names the workspace verb that actually fixes it`);
}

// The retired root must stay reachable through exactly its two intended callers — a third would be the
// regression paths.ts warns about.
const paths = readFileSync(join(srcDir, "paths.ts"), "utf8");
ok(/export function legacyHomeRoot/.test(paths), "legacyHomeRoot() still exists for `team import` and doctor's E20");
ok(/DEVLOOP_HOME/.test(paths) && /string \| undefined/.test(paths), "devloopHome() still returns undefined rather than defaulting to the retired root");

console.log(fails === 0 ? "\nLEGACY_HOME_REMEDIATION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
