// DL-13 — cwd→project resolver (hub/src/resolve-project.ts), the `resolve-project` subcommand, and the
// hub startup fallback (explicit DEVLOOP_PROJECT wins; else cwd; else demo). Uses REAL dirs because the
// resolver realpath-canonicalizes, and a seeded temp DB for the startup integration.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveProjectFromCwd } from "../src/resolve-project.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = "/tmp/hub-rp";
try { rmSync(ROOT, { recursive: true }); } catch {}
for (const d of ["work/repo/sub", "work/repo-2", "work/api", "work/web/src", "work/outside"]) mkdirSync(join(ROOT, d), { recursive: true });
const R = (p: string) => realpathSync(join(ROOT, p));
const cfg = { defaultProject: "alpha", projects: {
  alpha: { repoPath: R("work/repo") },
  beta: { repoPath: R("work/repo-2") },
  multi: { repos: [{ path: R("work/api") }, { path: R("work/web") }] },
} };

// ── resolver unit tests ──
ok(resolveProjectFromCwd(R("work/repo"), cfg) === "alpha", "exact repo path → its project");
ok(resolveProjectFromCwd(R("work/repo/sub"), cfg) === "alpha", "a descendant of a repo → its project");
ok(resolveProjectFromCwd(R("work/repo-2"), cfg) === "beta", "sibling repo-2 → beta, NOT alpha (segment-boundary safe)");
ok(resolveProjectFromCwd(R("work/api"), cfg) === "multi", "multi-repo repos[] → matches any of its paths");
ok(resolveProjectFromCwd(R("work/web/src"), cfg) === "multi", "a descendant of a second repos[] path → the project");
ok(resolveProjectFromCwd(R("work/outside"), cfg) === null, "cwd outside every repo → null (no guess)");
ok(resolveProjectFromCwd(R("work"), cfg) === null, "cwd ABOVE all repos → null");
const nestedCfg = { projects: { outer: { repoPath: R("work/repo") }, inner: { repoPath: R("work/repo/sub") } } };
ok(resolveProjectFromCwd(R("work/repo/sub"), nestedCfg) === "inner", "nested repos → the NEAREST ancestor (longest prefix) wins");
const tieCfg = { projects: { x: { repoPath: R("work/repo") }, y: { repoPath: R("work/repo") } } };
ok(resolveProjectFromCwd(R("work/repo/sub"), tieCfg) === null, "two distinct projects sharing a repo path → null (never guess)");

// ── `resolve-project` subcommand integration (the launcher reuses THIS matcher) ──
writeFileSync(join(ROOT, "projects.json"), JSON.stringify(cfg));
const sub = (cwd: string): string => { try { return execFileSync("node", ["src/server.ts", "resolve-project", "--cwd", cwd], { env: { ...process.env, DEVLOOP_PROJECTS_JSON: join(ROOT, "projects.json") }, encoding: "utf8" }).trim(); } catch { return "<exit1>"; } };
ok(sub(R("work/repo/sub")) === "alpha", "resolve-project subcommand → prints the cwd project (exit 0)");
ok(sub(R("work/outside")) === "<exit1>", "resolve-project subcommand on a non-match → non-zero exit, no output");

// ── hub startup: empty/unset DEVLOOP_PROJECT + cwd under a repo resolves; a present value WINS ──
const DB = "/tmp/hub-rp/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }
execFileSync("node", ["src/seed.ts", "alpha", "Alpha", "AL", DB], { encoding: "utf8" });
execFileSync("node", ["src/seed.ts", "beta", "Beta", "BE", DB], { encoding: "utf8" });
const SERVER = realpathSync("src/server.ts"); // absolute — the spawn cwd is a repo dir, not hub/
async function whoamiFrom(project: string, cwd: string): Promise<any> {
  const c = new Client({ name: "rp", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: [SERVER], cwd, env: { ...process.env, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECTS_JSON: join(ROOT, "projects.json"), DEVLOOP_ACTOR: "dev" } }));
  const r: any = await c.callTool({ name: "whoami", arguments: {} });
  const who = JSON.parse(r.content?.[0]?.text ?? "{}");
  await c.close();
  return who;
}
ok((await whoamiFrom("", R("work/repo/sub"))).project === "alpha", "empty DEVLOOP_PROJECT + cwd under a repo → hub auto-pins that project");
ok((await whoamiFrom("beta", R("work/repo/sub"))).project === "beta", "an explicit DEVLOOP_PROJECT WINS over the cwd match");

console.log(fails === 0 ? "\nRESOLVE_PROJECT_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
