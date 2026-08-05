// P4 [coverage]: the single-version invariant (design daemon-multicli §6). The three manifests that
// ship in lockstep — hub/package.json (the npm package), .claude-plugin/plugin.json, and
// .claude-plugin/marketplace.json — MUST carry the SAME version; otherwise `/plugin update` serves a
// stale cached SKILL set against a bumped plugin (the marketplace-cache bug class). `dev-loop
// release-version <v>` stamps all three; this is the guard that they never silently drift again.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // hub/test → repo root
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const read = (rel: string, raw = false): any => raw ? readFileSync(join(root, rel), "utf8") : JSON.parse(readFileSync(join(root, rel), "utf8"));

const hubPkg = read("hub/package.json");
const pkg = hubPkg.version;
const plugin = read(".claude-plugin/plugin.json").version;
const market = read(".claude-plugin/marketplace.json").plugins[0].version;

ok(typeof pkg === "string" && /^\d+\.\d+\.\d+/.test(pkg), `hub/package.json version is a semver (${pkg})`);
ok(pkg === plugin, `hub/package.json (${pkg}) === plugin.json (${plugin})`);
ok(plugin === market, `plugin.json (${plugin}) === marketplace.json plugins[0] (${market})`);
ok(read("hub/package.json").name === "@dyzsasd/dev-loop", "hub/package.json name is @dyzsasd/dev-loop (the published npm package — scoped; bare 'dev-loop' was blocked by npm as too similar to 'devloop'. The `dev-loop` BIN is unchanged)");
ok(read(".claude-plugin/marketplace.json").plugins[0].name === "dev-loop", "marketplace plugins[0].name is dev-loop (the Claude plugin name — distinct from the npm package)");

const scripts = hubPkg.scripts as Record<string, string>;
ok(typeof scripts["source-integrity"] === "string" && scripts["source-integrity"].includes("source_integrity.py"),
  "hub/package.json has a source-integrity script that invokes source_integrity.py (local gate parity with CI)");
// LOOP-159 — `verify` is now a script file, so the parity claim is checked against WHAT IT RUNS
// rather than against a string in package.json. The old assertion (`verify` contains the substring
// "source-integrity") passed on a chain that ran 3 of CI's 5 gating steps, which is exactly the gap
// LOOP-159 describes: a green `verify` that does not predict the check it exists to predict.
{
  const verifySrc = read("hub/verify.mjs", true) as string;
  const REQUIRED_CI_STEPS: Array<[string, RegExp]> = [
    ["security unittests", /security\.test_source_integrity/],
    ["bare source_integrity.py", /"security\/source_integrity\.py"/],
    ["typecheck", /"typecheck"/],
    ["test under coverage", /NODE_V8_COVERAGE/],
    ["CRAP ratchet", /quality\.ts[\s\S]*--coverage-dir/],
    ["whole-tree source integrity", /--whole-tree/],
  ];
  for (const [label, re] of REQUIRED_CI_STEPS)
    ok(re.test(verifySrc), `LOOP-159: verify reproduces CI's ${label} step`);
  // The trap: the ratchet must REUSE the coverage the test step produced, never re-run the suite
  // (quality.ts without --coverage-dir collects its own coverage and was still going at 2 minutes).
  ok(!/--test-cmd/.test(verifySrc), "LOOP-159: the CRAP step reuses the test step's coverage — it never re-runs the suite");
  ok(/python3 not found/.test(verifySrc), "LOOP-159: the python3 skip is preserved AND printed, never silent");
}

console.log(fails === 0 ? "\nVERSION_SYNC_OK" : `\n${fails} FAILED — run: node hub/src/release-version.ts <version>`);
process.exit(fails === 0 ? 0 : 1);
