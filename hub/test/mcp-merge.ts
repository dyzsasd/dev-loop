// DL-61 — `mergeMcpServer` §15 suite. Exercises the merge utility against the REAL committed template
// (config/mcp.example.json) + temp target files, asserting: create-new, merge-PRESERVING another server,
// idempotent no-duplicate re-run, update-in-place of a stale entry, a malformed/partial/non-object file is
// an ERROR with the original left BYTE-FOR-BYTE untouched, and the merged entry is §16 env-NAME-only (the
// installed `dev-loop serve` command, DEVLOOP_PROJECT pinned to the key, no literal secret,
// no nested ${...}). Legacy templates with a server.ts arg are still path-filled.
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
process.exit(fails === 0 ? 0 : 1);
