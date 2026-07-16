// Model-provider routing (docs/design/model-provider-routing.md) — render the team.providers registry
// (CUSTOM OpenAI-compatible endpoints, E16) into the WORKSPACE `opencode.json` `provider` block:
// create-or-merge, never clobber (the mcp-merge posture — a malformed file is an ERROR left untouched).
// The GLOBAL ~/.config/opencode/ is NEVER touched: real installs carry personal setups (oh-my-opencode
// etc.; PORTABILITY §5), and opencode merges project config over global, so the workspace file suffices.
// §16: entries carry `{env:VAR}` references (opencode's own env indirection) — never a literal secret.
// §17: a data-file utility — it can only ever write the workspace opencode.json, never SKILL/code files.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ProviderEntry } from "./team-config.ts";
import { tryResolveWorkspace } from "./workspace.ts";

// One registry entry → one opencode provider block (opencode.ai/docs/providers custom-provider shape).
// models render as `{ "<id>": {} }` — id-only entries; limits/display names stay opencode-side concerns.
export function renderProviderEntry(id: string, e: ProviderEntry): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: id,
    options: { baseURL: e.baseUrl, apiKey: `{env:${e.authTokenEnv}}`, ...(e.extraOptions ?? {}) },
    models: Object.fromEntries(e.models.map((m) => [m, {}])),
  };
}

export function renderOpencodeProviders(providers: Record<string, ProviderEntry>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(providers).map(([id, e]) => [id, renderProviderEntry(id, e)]));
}

export type OpencodeSyncResult =
  | { ok: true; action: "created" | "merged" | "updated" | "unchanged" | "empty"; providers: string[] }
  | { ok: false; error: string };

export function opencodeConfigPath(root: string): string { return join(root, "opencode.json"); }

function writeAtomic(path: string, obj: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`; // same dir → atomic rename; never a half-written opencode.json
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

// Sync = manage exactly the registry's ids inside the file's `provider` block: add or update IN PLACE.
// Hand-written provider entries (other ids) are untouched; an id REMOVED from the registry is the
// operator's to delete (sync never removes — the file may legitimately carry non-registry providers).
export function syncOpencodeConfig(root: string, providers: Record<string, ProviderEntry>): OpencodeSyncResult {
  const ids = Object.keys(providers);
  if (!ids.length) return { ok: true, action: "empty", providers: [] };
  const desired = renderOpencodeProviders(providers);
  const path = opencodeConfigPath(root);

  if (!existsSync(path)) {
    try { writeAtomic(path, { $schema: "https://opencode.ai/config.json", provider: desired }); }
    catch (e) { return { ok: false, error: `could not write ${path}: ${(e as Error).message}` }; }
    return { ok: true, action: "created", providers: ids };
  }

  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
  catch (e) { return { ok: false, error: `${path} is malformed JSON — left untouched (${(e as Error).message})` }; }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg))
    return { ok: false, error: `${path} is not a JSON object — left untouched` };
  const existing = cfg.provider;
  if ("provider" in cfg && (typeof existing !== "object" || existing === null || Array.isArray(existing)))
    return { ok: false, error: `${path} has a non-object "provider" — left untouched (partial/malformed)` };

  const block = (existing ?? {}) as Record<string, unknown>;
  let changed = false;
  let anyExisted = false;
  for (const id of ids) {
    const next = desired[id];
    if (id in block) anyExisted = true;
    if (JSON.stringify(block[id]) === JSON.stringify(next)) continue;
    block[id] = next;
    changed = true;
  }
  if (!changed) return { ok: true, action: "unchanged", providers: ids };
  cfg.provider = block;
  try { writeAtomic(path, cfg); } // re-serializes the WHOLE cfg → every other provider + top-level key survives
  catch (e) { return { ok: false, error: `could not write ${path}: ${(e as Error).message}` }; }
  return { ok: true, action: anyExisted ? "updated" : "merged", providers: ids };
}

// Doctor W14 companion: null = in sync (or nothing to sync); else a one-line drift description.
// Read-only — doctor never mutates (the sync itself is the operator-run `team sync-opencode`).
export function opencodeSyncDrift(root: string, providers: Record<string, ProviderEntry>): string | null {
  const ids = Object.keys(providers);
  if (!ids.length) return null;
  const path = opencodeConfigPath(root);
  if (!existsSync(path)) return `opencode.json missing (registry has ${ids.length} provider(s))`;
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
  catch { return "opencode.json is malformed JSON"; }
  const block = cfg?.provider as Record<string, unknown> | undefined;
  if (!block || typeof block !== "object" || Array.isArray(block)) return "opencode.json has no provider block";
  const desired = renderOpencodeProviders(providers);
  const stale = ids.filter((id) => JSON.stringify(block[id]) !== JSON.stringify(desired[id]));
  return stale.length ? `opencode.json provider(s) missing/stale: ${stale.join(", ")}` : null;
}

// `dev-loop team sync-opencode [--dir <path>]` — the operator-run sync verb (team.ts routes here).
export function syncOpencodeCmd(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`dev-loop team sync-opencode — render team.providers into <workspace>/opencode.json

Usage:
  dev-loop team sync-opencode [--dir <path>]

Create-or-merge, never clobber: registry entries are added/updated in place, hand-written providers and
every other key survive, and a malformed opencode.json is an error left untouched. Auth stays env-name
indirected ({env:VAR}); put the values in <workspace>/.dev-loop/secrets.env. Built-in opencode providers
(openrouter, zhipuai, …) need no registry entry — see \`opencode models\` for the launchable ids.`);
    return 0;
  }
  const dirIdx = argv.indexOf("--dir");
  const start = dirIdx >= 0 ? argv[dirIdx + 1] : process.cwd();
  if (dirIdx >= 0 && !start) { console.error("dev-loop team sync-opencode: --dir needs a path"); return 2; }
  const ws = tryResolveWorkspace(start!);
  if (!ws) { console.error(`dev-loop team sync-opencode: no workspace (dev-loop.json) found from ${start}`); return 2; }
  const r = syncOpencodeConfig(ws.root, ws.file.team.providers ?? {});
  if (!r.ok) { console.error(`❌ ${r.error}`); return 1; }
  if (r.action === "empty") { console.log("team.providers is empty — nothing to sync (built-in opencode providers need no entry)"); return 0; }
  console.log(`✅ opencode.json ${r.action} (${r.providers.join(", ")}) at ${opencodeConfigPath(ws.root)}`);
  return 0;
}
