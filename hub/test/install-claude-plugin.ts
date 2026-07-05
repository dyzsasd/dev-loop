// install-claude-plugin: the marketplace it writes must PIN the plugin version to this CLI's own version
// (default), so `/plugin install` never resolves the floating npm `latest` and silently installs an older
// plugin than the CLI (the add-project-missing bug). --version overrides; --version latest opts out.
import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudePlugin } from "../src/install-claude-plugin.ts";
import { pkgVersion } from "../src/paths.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-icp-")));

// Run installClaudePlugin quietly into a tmp dest and return the parsed marketplace plugin source.
function sourceFor(args: string[]): Record<string, string> {
  const dest = join(tmp, `d-${Math.abs(hash(args.join(",")))}`);
  const orig = console.log; console.log = () => {};
  try { installClaudePlugin(["--dest", dest, ...args]); } finally { console.log = orig; }
  const mk = JSON.parse(readFileSync(join(dest, ".claude-plugin", "marketplace.json"), "utf8"));
  return mk.plugins[0].source;
}
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

try {
  const version = pkgVersion();
  ok(!!version && /^\d+\.\d+\.\d+/.test(version), `this CLI has a semver version (${version})`);

  const def = sourceFor([]);
  ok(def.source === "npm" && def.package === "@dyzsasd/dev-loop", "default writes an npm source for @dyzsasd/dev-loop");
  ok(def.version === version, `default PINS the plugin to this CLI's version (${version}) — never floating latest`);

  const pinned = sourceFor(["--version", "9.9.9"]);
  ok(pinned.version === "9.9.9", "--version <semver> overrides the pin");

  const latest = sourceFor(["--version", "latest"]);
  ok(!("version" in latest), "--version latest opts back into the floating latest (no pin)");

  console.log(fails === 0 ? "\nINSTALL_CLAUDE_PLUGIN_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
