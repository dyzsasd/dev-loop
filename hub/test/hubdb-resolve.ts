// Field report P2 #1/#2 — the operator-CLI hub-DB ladder (workspace.ts resolveHubDbPath):
// explicit DEVLOOP_HUB_DB > discovered workspace .dev-loop/hub.db > machine-global default.
// `dev-loop op`/`tickets` used to jump straight to the global default and `seed` to ./hub.db in cwd —
// reading or CREATING a different board than the workspace the operator was standing in.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveHubDbPath, wsHubDb, tryResolveWorkspace } from "../src/workspace.ts";
import { hubDbPath } from "../src/paths.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-hubdb-"));
const savedEnv = process.env.DEVLOOP_HUB_DB;
try {
  const cli = (args: string[], cwd: string, env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], {
      cwd, encoding: "utf8",
      env: { ...process.env, DEVLOOP_HUB_DB: undefined, ...env } as NodeJS.ProcessEnv, // the ladder must work WITHOUT the env crutch
    });

  // workspace for the e2e legs
  const ws = join(ROOT, "ws");
  mkdirSync(ws, { recursive: true });
  ok(cli(["team", "init", "--dir", ws, "--key", "dbt", "--backend", "service", "--yes"], ROOT).status === 0, "setup: team init");
  ok(cli(["team", "add-project", "dbtproj", "--prefix", "DBT"], ws).status === 0, "setup: add-project (seeds the WS hub.db)");

  // ── unit: the ladder itself ──────────────────────────────────────────────────────────────────────
  delete process.env.DEVLOOP_HUB_DB;
  ok(resolveHubDbPath(ws) === wsHubDb(tryResolveWorkspace(ws)!), "ladder: inside a workspace → its .dev-loop/hub.db");
  const bare = join(ROOT, "bare"); mkdirSync(bare, { recursive: true });
  ok(resolveHubDbPath(bare) === hubDbPath(), "ladder: no workspace → the machine-global default");
  process.env.DEVLOOP_HUB_DB = join(ROOT, "explicit.db");
  ok(resolveHubDbPath(ws) === join(ROOT, "explicit.db"), "ladder: explicit DEVLOOP_HUB_DB beats the workspace");
  delete process.env.DEVLOOP_HUB_DB;

  // ── e2e: tickets reads the WS board without the env crutch (used to hit the global db → exit 1) ──
  const t = cli(["tickets", "--limit", "1", "--json"], ws, { DEVLOOP_PROJECT: "dbtproj" });
  ok(t.status === 0, `tickets at the workspace root exits 0 without DEVLOOP_HUB_DB (got ${t.status}: ${(t.stderr ?? "").split("\n")[0]})`);
  ok(!/not seeded/.test(`${t.stdout}${t.stderr}`), "tickets found the WS-seeded project (no phantom 'not seeded')");

  // ── e2e: seed defaults into the WS db, never ./hub.db in cwd (the day-1 double-db split) ─────────
  const s = cli(["seed", "dbtproj2", "Second", "DB2"], ws);
  // realpath-agnostic (macOS /var → /private/var): assert the workspace-relative tail, not the tmp prefix
  ok(s.status === 0 && /\/ws\/\.dev-loop\/hub\.db/.test(`${s.stdout}${s.stderr}`),
    `seed defaults to the WS .dev-loop/hub.db (got: ${(s.stdout ?? "").trim().split("\n").pop()})`);
  ok(!existsSync(join(ws, "hub.db")), "seed created NO ./hub.db in cwd");
} finally {
  if (savedEnv === undefined) delete process.env.DEVLOOP_HUB_DB; else process.env.DEVLOOP_HUB_DB = savedEnv;
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "hubdb-resolve: all checks passed");
process.exit(fails ? 1 : 0);
