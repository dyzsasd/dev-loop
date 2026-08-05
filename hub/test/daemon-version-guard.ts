// LOOP-252 regression: daemonUpForKey must REFUSE to downgrade a running daemon whose version is
// newer than the invoking CLI's. Before the fix, inequality alone triggered a restart ("running
// old code"), so a 1.13.0 CLI would kill and replace a live 1.14.0 daemon.
//
// Test strategy: spawn a real background subprocess that serves a fake /api/health reporting a
// NEWER version (99.99.99). Write a runfile pointing to that subprocess. Use async spawn (not
// spawnSync) for `daemon up` so the fake server can respond while daemon up is probing it.
// Assert: daemon up exits non-zero, prints direction-aware message, and does NOT kill the server.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { launchDaemonCli } from "./daemon-harness.ts";
import { scrubFireEnv } from "./env-scrub.ts";
import { createServer as netCreateServer } from "node:net";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.env.DEVLOOP_NODE || process.execPath;
const ROOT = `/tmp/dl-ver-guard-${process.pid}`;
const WS_KEY = "vgws";
const PROJ = "vgproj";
const WS_DB = join(ROOT, ".dev-loop", "hub.db");
const WS_RUN = join(ROOT, ".dev-loop");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// ── Step 1: create a workspace + project so the project is seeded in hub.db ───────────────────
const baseEnv = scrubFireEnv() as NodeJS.ProcessEnv;
const initResult = spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), "team", "init",
  "--dir", ROOT, "--key", WS_KEY, "--backend", "service", "--yes"],
  { cwd: "/tmp", encoding: "utf8", timeout: 30_000, env: baseEnv });
ok(initResult.status === 0, `setup: team init exits 0 (got ${initResult.status}: ${(initResult.stderr ?? "").split("\n")[0]})`);

const addProjResult = spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), "team", "add-project", PROJ, "--prefix", "VGR"],
  { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: baseEnv });
ok(addProjResult.status === 0, `setup: add-project exits 0 (got ${addProjResult.status}: ${(addProjResult.stderr ?? "").split("\n")[0]})`);
ok(existsSync(WS_DB), "setup: workspace hub.db exists");

// ── Step 2: pick a free port for the fake health server ────────────────────────────────────────
const FAKE_PORT = await new Promise<number>((res, rej) => {
  const s = netCreateServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as import("node:net").AddressInfo; s.close(() => res(port)); });
});

// ── Step 3: spawn a real background process to serve fake /api/health ─────────────────────────
// This is NOT daemon.ts — it's a small inline health server. daemon-guard.ts watches for
// daemon.ts / "daemon up" / "daemon ensure" spawns; this inline script doesn't match.
const FAKE_VERSION = "99.99.99";
const FAKE_ENTRY = "/fake/tree/hub/src/daemon.ts";
const serverScript = `
import { createServer } from "node:http";
const srv = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true, service: "dev-loop-hub", pid: process.pid, project: "${PROJ}",
      version: "${FAKE_VERSION}", actor: "operator", dbPresent: true,
      entryPath: "${FAKE_ENTRY}",
    }));
  } else { res.writeHead(404); res.end(); }
});
srv.listen(${FAKE_PORT}, "127.0.0.1", () => { process.stdout.write("READY\\n"); });
`;
const serverChild = spawn(NODE, ["--input-type=module"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...scrubFireEnv() },
});
serverChild.stdin!.end(serverScript);
const serverPid = serverChild.pid!;

// Wait for the server to be ready
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("fake server never started")), 8000);
  let buf = "";
  serverChild.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    if (buf.includes("READY")) { clearTimeout(timer); resolve(); }
  });
  serverChild.on("exit", (code: number | null) => { clearTimeout(timer); reject(new Error(`fake server exited ${code}`)); });
});

const fakeUrl = `http://127.0.0.1:${FAKE_PORT}`;
ok(serverPid > 0, `setup: fake health server started (pid ${serverPid}, port ${FAKE_PORT})`);

// Verify the fake server is responding correctly
const healthProbe = await fetch(`${fakeUrl}/api/health`).catch(() => null);
const healthBody = healthProbe ? await healthProbe.json().catch(() => null) as { version: string } | null : null;
ok(healthBody?.version === FAKE_VERSION, `setup: fake server reports version ${FAKE_VERSION} (got: ${JSON.stringify(healthBody)})`);

// ── Step 4: write a runfile pointing to the fake server ────────────────────────────────────────
mkdirSync(WS_RUN, { recursive: true });
const runfile = join(WS_RUN, `daemon-${PROJ}.json`);
writeFileSync(runfile, JSON.stringify({
  project: PROJ, pid: serverPid, port: FAKE_PORT, host: "127.0.0.1",
  url: fakeUrl, startedAt: new Date().toISOString(), version: FAKE_VERSION,
  actor: "operator", entryPath: FAKE_ENTRY,
}, null, 2));

// ── Step 5: invoke `daemon up` ASYNCHRONOUSLY so the fake server can respond ──────────────────
const upEnv = { ...scrubFireEnv(), DEVLOOP_ACTOR: "operator", DEVLOOP_HUB_DB: WS_DB, DEVLOOP_RUN_DIR: WS_RUN, DEVLOOP_PROJECT: PROJ };
const upChild = launchDaemonCli("daemon", "up", upEnv);
let upStdout = "", upStderr = "";
upChild.stdout?.on("data", (d: Buffer) => { upStdout += d.toString(); });
upChild.stderr?.on("data", (d: Buffer) => { upStderr += d.toString(); });
const [upCode] = await once(upChild, "exit") as [number | null];

// ── Assertions ─────────────────────────────────────────────────────────────────────────────────
ok(upCode !== 0, `AC1: daemon up exits non-zero when running daemon is newer (got exit ${upCode})`);
const combined = upStdout + upStderr;
ok(/NEWER/i.test(combined) || /stale/i.test(combined),
  `AC2: output contains "NEWER" or "stale" (got: ${combined.trim().slice(0, 300)})`);
ok(!combined.includes("running old code"),
  `AC2: output does NOT say "running old code" when daemon is newer (got: ${combined.trim().slice(0, 300)})`);

// Verify the runfile was NOT replaced (daemon was not killed/respawned)
const runfileAfter = JSON.parse(readFileSync(runfile, "utf8")) as { version: string; pid: number };
ok(runfileAfter.version === FAKE_VERSION && runfileAfter.pid === serverPid,
  `AC1: runfile still points to fake daemon after refused up (version=${runfileAfter.version}, pid=${runfileAfter.pid})`);

// Verify the fake server is still alive (not killed by daemon up)
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
ok(isAlive(serverPid), `AC1: fake daemon process still alive after refused up (pid=${serverPid})`);

// Cleanup
serverChild.kill("SIGKILL");
rmSync(ROOT, { recursive: true, force: true });

console.log(fails ? `${fails} CHECK(S) FAILED` : "daemon-version-guard: all checks passed");
process.exit(fails ? 1 : 0);
