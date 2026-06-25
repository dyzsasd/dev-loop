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
const read = (rel: string): any => JSON.parse(readFileSync(join(root, rel), "utf8"));

const pkg = read("hub/package.json").version;
const plugin = read(".claude-plugin/plugin.json").version;
const market = read(".claude-plugin/marketplace.json").plugins[0].version;

ok(typeof pkg === "string" && /^\d+\.\d+\.\d+/.test(pkg), `hub/package.json version is a semver (${pkg})`);
ok(pkg === plugin, `hub/package.json (${pkg}) === plugin.json (${plugin})`);
ok(plugin === market, `plugin.json (${plugin}) === marketplace.json plugins[0] (${market})`);
ok(read("hub/package.json").name === "dev-loop", "hub/package.json name is dev-loop (the published npm package)");
ok(read(".claude-plugin/marketplace.json").plugins[0].name === "dev-loop", "marketplace plugins[0].name is dev-loop");

console.log(fails === 0 ? "\nVERSION_SYNC_OK" : `\n${fails} FAILED — run: node hub/src/release-version.ts <version>`);
process.exit(fails === 0 ? 0 : 1);
