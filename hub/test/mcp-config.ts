// DL-44 — the hub MCP env template must not nest ${...} inside a ${VAR:-default} value.
//
// Under a CLI whose .mcp.json interpolation is non-recursive (matches `${` to the FIRST `}`), the inner
// `${HOME}`'s `}` closes the OUTER `${DEVLOOP_HUB_DB:-…}` group, so `"${DEVLOOP_HUB_DB:-${HOME}/.dev-loop/hub.db}"`
// resolves to the LITERAL string `${HOME/.dev-loop/hub.db}` — the hub then opens a fresh empty db at that
// relative path and drops a stray `${HOME` dir into the tree, silently forking the system-of-record.
//
// This asserts the committed template `config/mcp.example.json` (and the machine-local `.mcp.json`, if it
// exists) carry no nested-`${...}` env value, and that with DEVLOOP_HUB_DB unset the server's HOME-relative
// default (`~/.dev-loop/hub.db`) is what wins — on ANY interpolator. Deterministic, no DB, no network.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", ".."); // hub/test → repo root

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// A value NESTS iff a `${` appears before the first `}` closes a prior `${` — i.e. `${`…(no `}`)…`${`.
const nests = (v: string) => /\$\{[^}]*\$\{/.test(v);

// The naive (non-recursive) interpolator from the DL-44 repro: match `${` to the FIRST `}`, honor `:-`.
const naiveInterp = (s: string, env: Record<string, string | undefined>): string =>
  s.replace(/\$\{([^}]*)\}/g, (_m, body: string) => {
    const i = body.indexOf(":-");
    if (i >= 0) { const n = body.slice(0, i), d = body.slice(i + 2); return env[n] || d; } // `||`: unset OR empty → default
    return env[body] ?? "";
  });

// server.ts:18 / daemon.ts:830 — `process.env.DEVLOOP_HUB_DB ?? ~/.dev-loop/hub.db` (nullish: an absent var
// falls back; a present-but-empty "" would NOT — which is exactly why the template must OMIT the key, not
// pass a flat `${DEVLOOP_HUB_DB}` that some CLIs substitute to "" when unset).
const SERVER_DEFAULT = `${homedir()}/.dev-loop/hub.db`;
const serverDbPath = (envValue: string | undefined) => envValue ?? SERVER_DEFAULT;

function checkConfig(absPath: string, label: string, required: boolean) {
  if (!existsSync(absPath)) { ok(!required, `${label}: file present`); return; } // .mcp.json is machine-local → optional
  const cfg = JSON.parse(readFileSync(absPath, "utf8"));
  const servers = (cfg.mcpServers ?? {}) as Record<string, { env?: Record<string, string> }>;
  ok(Object.keys(servers).length > 0, `${label}: declares at least one mcpServer`);

  for (const [name, sv] of Object.entries(servers)) {
    const env = sv.env ?? {};

    // AC2: no env value nests ${...} inside another ${...}.
    for (const [k, v] of Object.entries(env)) {
      ok(!nests(String(v)), `${label}: ${name}.env.${k} has no nested \${...} (got ${JSON.stringify(v)})`);
    }

    // AC1: with DEVLOOP_HUB_DB unset in the launching shell, interpolate the env block (only HOME set) and
    // resolve the hub DB the way the server does → it MUST be the HOME default, with no leftover `${` literal.
    const shellEnv = { HOME: homedir() }; // DEVLOOP_HUB_DB intentionally absent
    const interp: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) interp[k] = naiveInterp(String(v), shellEnv);

    ok(!Object.values(interp).some((x) => x.includes("${")),
      `${label}: ${name} — no env value resolves to a literal \${...} when its vars are unset`);

    const dbPath = serverDbPath(interp.DEVLOOP_HUB_DB);
    ok(dbPath === SERVER_DEFAULT,
      `${label}: ${name} — DEVLOOP_HUB_DB unset → hub opens ${SERVER_DEFAULT} (got ${JSON.stringify(dbPath)})`);
  }
}

// The committed template is REQUIRED to be clean (it ships to every operator); the local .mcp.json is checked
// only if present (it's gitignored, machine-local — absent in a fresh clone / CI).
checkConfig(join(repoRoot, "config", "mcp.example.json"), "config/mcp.example.json", true);
checkConfig(join(repoRoot, ".mcp.json"), ".mcp.json", false);

console.log(fails === 0 ? "\nMCP_CONFIG_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
