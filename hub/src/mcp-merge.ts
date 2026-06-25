// DL-61 (design U2) — merge (never clobber) the `dev-loop-hub` MCP server into a PRODUCT repo's `.mcp.json`,
// so init's `service` auto-wiring registers the hub server WITHOUT destroying any other MCP servers the
// product already declares. Composes onto DL-60's init-service seam (c). §16: env-NAME-only — the entry
// carries only `${VAR:-default}` env references (copied from the committed template), never a literal secret;
// the hub DB path is intentionally omitted (the server defaults to ~/.dev-loop/hub.db). §17: this is a
// data-file utility — it can only ever write the product `.mcp.json`, never a SKILL/conventions/code file.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_NAME = "dev-loop-hub";

export interface McpMergeOpts {
  mcpJsonPath: string;     // the PRODUCT repo's .mcp.json (the merge target)
  hubServerPath: string;   // absolute path to the dev-loop checkout's hub/src/server.ts (fills the entry's args)
  projectKey: string;      // pins the entry's DEVLOOP_PROJECT default
  templatePath?: string;   // default: the committed config/mcp.example.json shipped beside this hub code
}
export type McpMergeResult =
  | { ok: true; action: "created" | "merged" | "updated" | "unchanged"; servers: string[] }
  | { ok: false; error: string };

// Build the dev-loop-hub entry FROM the committed template (the single source of truth for its shape — so a
// future template change propagates), filling the absolute hub server.ts path into `args` and pinning the
// DEVLOOP_PROJECT default to the project key (matches the dogfood `.mcp.json` `${DEVLOOP_PROJECT:-<key>}`).
function buildEntry(templatePath: string, hubServerPath: string, projectKey: string): Record<string, unknown> {
  const tmpl = JSON.parse(readFileSync(templatePath, "utf8")) as { mcpServers?: Record<string, unknown> };
  const src = tmpl.mcpServers?.[SERVER_NAME];
  if (!src || typeof src !== "object") throw new Error(`template ${templatePath} has no mcpServers["${SERVER_NAME}"] entry`);
  // §16/DL-44: the key becomes the `${DEVLOOP_PROJECT:-<key>}` default; a key carrying `$`/`{`/`}` would
  // produce a NESTED ${...} (the DL-44 SoR-fork footgun) in the product .mcp.json — reject it loudly rather
  // than write a malformed config. Real project keys are plain identifiers, so this never bites in practice.
  if (/[${}]/.test(projectKey)) throw new Error(`project key ${JSON.stringify(projectKey)} contains '$', '{', or '}', which would break the .mcp.json \${VAR:-default} interpolation (DL-44) — use a plain identifier key`);
  // DL-66: the hub server path lands verbatim in the entry's `args` (line below) — another interpolated
  // .mcp.json string position — so a path carrying `$`/`{`/`}` would nest a `${...}` that Claude Code
  // mis-expands at parse-time interpolation, corrupting the resolved hub path and breaking the launch in that
  // pane. Guard it symmetrically with projectKey above; a real absolute checkout path never contains these
  // (same defense-in-depth bar the team set for the projectKey side in DL-44).
  if (/[${}]/.test(hubServerPath)) throw new Error(`hub server path ${JSON.stringify(hubServerPath)} contains '$', '{', or '}', which would nest a \${...} in the .mcp.json args that Claude Code mis-expands at parse-time interpolation, corrupting the resolved hub path (DL-66) — use a path without those characters`);
  const e = structuredClone(src) as { args?: unknown[]; env?: Record<string, string> };
  const args = (e.args ?? []) as unknown[];
  const idx = args.findIndex((a) => typeof a === "string" && a.endsWith("server.ts"));
  if (idx < 0) throw new Error(`template ${SERVER_NAME} entry has no server.ts arg to fill`);
  args[idx] = hubServerPath; // the real absolute path, replacing the <ABS-PATH-TO-dev-loop>/... placeholder
  e.args = args;
  // env stays NAME-only; pin the project key as the DEVLOOP_PROJECT default (single-level, no nested ${...} — DL-44)
  e.env = { ...(e.env ?? {}), DEVLOOP_PROJECT: `\${DEVLOOP_PROJECT:-${projectKey}}` };
  return e as Record<string, unknown>;
}

function writeAtomic(path: string, obj: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`; // same dir → rename is atomic on one filesystem (never a half-written .mcp.json)
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort — never leave a stray temp in the product repo */ }
    throw e; // caller maps this to a clean {ok:false}, so a write failure warns rather than crashing the bootstrap
  }
}

export function mergeMcpServer(opts: McpMergeOpts): McpMergeResult {
  const { mcpJsonPath, hubServerPath, projectKey } = opts;
  const here = dirname(fileURLToPath(import.meta.url)); // hub/src
  const templatePath = opts.templatePath ?? join(here, "..", "..", "config", "mcp.example.json");

  let entry: Record<string, unknown>;
  try { entry = buildEntry(templatePath, hubServerPath, projectKey); }
  catch (e) { return { ok: false, error: `could not build the ${SERVER_NAME} entry: ${(e as Error).message}` }; }

  // No existing file → create a fresh `.mcp.json` carrying just our server.
  if (!existsSync(mcpJsonPath)) {
    try { writeAtomic(mcpJsonPath, { mcpServers: { [SERVER_NAME]: entry } }); }
    catch (e) { return { ok: false, error: `could not write ${mcpJsonPath}: ${(e as Error).message}` }; }
    return { ok: true, action: "created", servers: [SERVER_NAME] };
  }

  // Existing file → MERGE, never clobber. A malformed / partial file is an ERROR, left UNTOUCHED (never destroyed).
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(readFileSync(mcpJsonPath, "utf8")) as Record<string, unknown>; }
  catch (e) { return { ok: false, error: `${mcpJsonPath} is malformed JSON — left untouched (${(e as Error).message})` }; }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg))
    return { ok: false, error: `${mcpJsonPath} is not a JSON object — left untouched` };
  const existingServers = cfg.mcpServers;
  if ("mcpServers" in cfg && (typeof existingServers !== "object" || existingServers === null || Array.isArray(existingServers)))
    return { ok: false, error: `${mcpJsonPath} has a non-object "mcpServers" — left untouched (partial/malformed)` };

  const servers = (existingServers ?? {}) as Record<string, unknown>;
  const existed = SERVER_NAME in servers;
  if (existed && JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry))
    return { ok: true, action: "unchanged", servers: Object.keys(servers) }; // idempotent: identical → no write

  servers[SERVER_NAME] = entry; // add or update IN PLACE — never a duplicate key; other servers untouched
  cfg.mcpServers = servers;
  try { writeAtomic(mcpJsonPath, cfg); } // re-serializes the WHOLE cfg → preserves every other server + top-level key
  catch (e) { return { ok: false, error: `could not write ${mcpJsonPath}: ${(e as Error).message}` }; }
  return { ok: true, action: existed ? "updated" : "merged", servers: Object.keys(servers) };
}

// CLI: `node src/mcp-merge.ts <.mcp.json path> <abs hub/src/server.ts> <project-key> [template]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mcpJsonPath, hubServerPath, projectKey, templatePath] = process.argv.slice(2);
  if (!mcpJsonPath || !hubServerPath || !projectKey) {
    console.error(`[hub] usage: node src/mcp-merge.ts <.mcp.json path> <abs hub/src/server.ts> <project-key> [template]`);
    process.exit(2);
  }
  const r = mergeMcpServer({ mcpJsonPath, hubServerPath, projectKey, templatePath });
  if (r.ok) { console.log(`✅ ${SERVER_NAME} ${r.action} in ${mcpJsonPath} (servers: ${r.servers.join(", ")})`); process.exit(0); }
  console.error(`❌ ${r.error}`); process.exit(1);
}
