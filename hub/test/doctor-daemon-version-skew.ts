// doctor-daemon-version-skew.ts — LOOP-259 regression: daemon version skew (W28) flips DOCTOR_OK
// to DOCTOR_FAILED. A matching version stays clean.
import { createServer } from "node:http";
import { readFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { runDoctor } from "../src/doctor.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-doc-w259-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const capture = async (fn: () => Promise<unknown>): Promise<string> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
};

// Build a fixture workspace with a seeded hub.db
function buildFixture(): { wsRoot: string; dbPath: string } {
  const wsRoot = join(tmp, "ws");
  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "w259-test", backend: "service" },
    repos: {},
    projects: { loop: { prefix: "LOOP" } },
  }));
  const dbPath = join(wsRoot, ".dev-loop", "hub.db");
  const db = openDb(dbPath);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')").run();
  db.close();
  return { wsRoot, dbPath };
}

// Start a local test server that returns a given version
function startServer(version: string): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, project: "loop", version }));
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

try {
  // ── Arm A: daemon version MISMATCH → W28 fires + DOCTOR_FAILED ──
  {
    const { wsRoot, dbPath } = buildFixture();
    const { server, port } = await startServer("0.0.0.0-fake");
    const url = `http://127.0.0.1:${port}`;
    const runDir = join(wsRoot, ".dev-loop");
    writeFileSync(join(runDir, "daemon-loop.json"), JSON.stringify({ url }));

    process.env.DEVLOOP_PROJECT = "loop";
    process.env.DEVLOOP_RUN_DIR = runDir;

    const out = await capture(() => runDoctor(dbPath, { reconcile: true }));
    ok(out.includes("[W28]"), "Arm A: W28 fires on daemon version mismatch");
    ok(out.includes("DOCTOR_FAILED"), "Arm A: DOCTOR_FAILED when version skew");

    server.close();
    delete process.env.DEVLOOP_PROJECT;
    delete process.env.DEVLOOP_RUN_DIR;
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch {}
  }

  // ── Arm B: daemon version MATCHES → no W28, DOCTOR_OK ──
  {
    const { wsRoot, dbPath } = buildFixture();
    // The MATCHING arm must match by CONSTRUCTION, not by a version literal — a hardcoded "1.14.0"
    // made this suite fail on the 1.15.0 release stamp, which is exactly a fixture depending on the
    // ambient environment (here: the current release number) rather than pinning its own inputs.
    const pkgVersion = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
    const { server, port } = await startServer(pkgVersion);
    const url = `http://127.0.0.1:${port}`;
    const runDir = join(wsRoot, ".dev-loop");
    writeFileSync(join(runDir, "daemon-loop.json"), JSON.stringify({ url }));

    process.env.DEVLOOP_PROJECT = "loop";
    process.env.DEVLOOP_RUN_DIR = runDir;

    const out = await capture(() => runDoctor(dbPath, { reconcile: true }));
    ok(!out.includes("[W28]"), "Arm B: no W28 when version matches");
    ok(out.includes("DOCTOR_OK"), "Arm B: DOCTOR_OK when version matches");

    server.close();
    delete process.env.DEVLOOP_PROJECT;
    delete process.env.DEVLOOP_RUN_DIR;
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch {}
  }
} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  delete process.env.DEVLOOP_PROJECT;
  delete process.env.DEVLOOP_RUN_DIR;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails > 0) process.exit(1);