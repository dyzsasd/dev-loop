// DL-13 — cwd→project resolver (hub/src/resolve-project.ts), the `resolve-project` subcommand, and the
// hub startup resolution (explicit DEVLOOP_PROJECT wins; else cwd; else unresolved). Uses REAL dirs because the
// resolver realpath-canonicalizes, and a seeded temp DB for the startup integration.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveProjectFromCwd, loadProjectsConfig, repoFileStrategyPath } from "../src/resolve-project.ts";

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

// ── DX regression: a malformed projects.json must be LOUD, not silently identical to "no config" ──
// (a hand-edit trailing comma used to surface as a wrong "project not resolved" / doctor mis-diagnosis)
{
  const badPath = join(ROOT, "bad.projects.json");
  writeFileSync(badPath, '{"projects": {"alpha": {"repoPath": "/x"},}}'); // trailing comma
  const prevEnv = process.env.DEVLOOP_PROJECTS_JSON;
  process.env.DEVLOOP_PROJECTS_JSON = badPath;
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  const cfgBad = loadProjectsConfig();
  console.error = origErr;
  if (prevEnv === undefined) delete process.env.DEVLOOP_PROJECTS_JSON; else process.env.DEVLOOP_PROJECTS_JSON = prevEnv;
  ok(cfgBad === null, "malformed projects.json → null (falls through to next candidate)");
  ok(errs.some((l) => /malformed JSON/.test(l) && l.includes(badPath)), "malformed projects.json → one loud stderr line naming the file");
}

// ── docs P3b: repoFileStrategyPath — the ONE strategyDoc→repo-file rule (doc-home §19, PM SKILL §0) ──
{
  const repos = [
    { path: "/w/api", role: "primary", name: "api" },
    { path: "/w/handbook", role: "docs", name: "handbook" },
    { path: "/w/web", name: "web" },
  ];
  ok(repoFileStrategyPath({ repos, strategyDoc: "docs/STRATEGY.md" })?.abs === "/w/handbook/docs/STRATEGY.md",
    "P3b: a relative string roots at the DOC-HOME repo (role:'docs' wins over 'primary')");
  ok(repoFileStrategyPath({ repos: [repos[0], repos[2]], strategyDoc: "docs/STRATEGY.md" })?.abs === "/w/api/docs/STRATEGY.md",
    "P3b: no 'docs' role → 'primary' roots it");
  ok(repoFileStrategyPath({ repos: [repos[2]], strategyDoc: "docs/STRATEGY.md" })?.abs === "/w/web/docs/STRATEGY.md",
    "P3b: no roles at all → repos[0] roots it");
  ok(repoFileStrategyPath({ repoPath: "/w/solo", strategyDoc: { path: "docs/STRATEGY.md" } })?.abs === "/w/solo/docs/STRATEGY.md",
    "P3b: the { path } object form (the config-schema's usual spelling) is repo-file too; repoPath roots a repo-less legacy project");
  const q = repoFileStrategyPath({ repos, strategyDoc: "web:notes/plan.md" });
  ok(q?.abs === "/w/web/notes/plan.md" && q?.display === "web:notes/plan.md",
    "P3b: an explicit repo-qualified '<repo-name>:path' overrides the doc-home (display keeps the config spelling)");
  ok(repoFileStrategyPath({ repos, strategyDoc: "nosuch:notes/plan.md" })?.abs === "/w/handbook/nosuch:notes/plan.md",
    "P3b: a colon prefix that names NO registered repo falls through as a plain relative path (a colon is a legal filename byte)");
  ok(repoFileStrategyPath({ repos, strategyDoc: "/abs/STRATEGY.md" })?.abs === "/abs/STRATEGY.md",
    "P3b: an absolute path stands alone");
  ok(repoFileStrategyPath({ repos, strategyDoc: { hubDoc: "strategy" } }) === null, "P3b: { hubDoc } is NOT a repo file → null");
  ok(repoFileStrategyPath({ repos, strategyDoc: { linearDocument: "abc" } }) === null, "P3b: { linearDocument } is NOT a repo file → null");
  ok(repoFileStrategyPath({ repos, strategyDoc: "https://linear.app/team/document/strat-123" }) === null,
    "P3b: a linear.app/…/document/ string is the Linear form (PM precedence) → null");
  ok(repoFileStrategyPath({ repos, hub: { docs: true }, strategyDoc: "docs/STRATEGY.md" }) === null,
    "P3b: hub.docs:true → the hub doc is the north-star; the repo file is not watched → null");
  ok(repoFileStrategyPath({ repos }) === null, "P3b: no strategyDoc → null");
  ok(repoFileStrategyPath({ strategyDoc: "docs/STRATEGY.md" }) === null, "P3b: a zero-repo project has nothing to root the file at → null");
  ok(repoFileStrategyPath(undefined) === null, "P3b: an unknown project record → null");
}

console.log(fails === 0 ? "\nRESOLVE_PROJECT_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
