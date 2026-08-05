// LOOP-76 regression: concurrent cold-start port race.
// Pre-fix: N concurrent init-service calls (no runfile) all probe port 8787 as free via
// lcFreePort, then race to bind it — the loser's child crashes with EADDRINUSE and the
// parent waits out the full 8s health timeout before failing.
// Post-fix: a child death is detected in ≤150ms and the parent retries the next candidate
// port, so all N succeed on distinct ports.
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDaemonPid } from "./daemon-harness.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const N = 4; // concurrent cold starts — high enough to reliably trigger the race
const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = `/tmp/dl-loop76-${process.pid}`;
rmSync(TMP, { recursive: true, force: true });

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// One isolated workspace per concurrent call: own hub.db, run dir, projects.json.
const dirs = Array.from({ length: N }, (_, i) => {
  const base = join(TMP, `ws${i}`);
  const run = join(base, "run");
  mkdirSync(run, { recursive: true });
  const key = `race${i}`;
  writeFileSync(join(base, "projects.json"),
    JSON.stringify({ projects: { [key]: { backend: "service", mode: "live" } } }));
  return { base, run, key };
});

// Spawn all N init-service calls at the same moment — the race window is the gap between
// lcFreePort's probe close and the daemon's real bind; concurrent spawns reliably hit it.
const procs = dirs.map(({ base, run, key }) => {
  const p = spawn("node", [join(hubRoot, "src", "init-service.ts"), key, `Race ${key}`, "RC"], {
    env: {
      ...scrubFireEnv(),
      DEVLOOP_HUB_DB: join(base, "hub.db"),
      DEVLOOP_RUN_DIR: run,
      DEVLOOP_PROJECTS_JSON: join(base, "projects.json"),
      DEVLOOP_ACTOR: "operator",
    },
  });
  let out = "";
  p.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
  p.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
  return { p, key, run, out: () => out };
});

// Wait for all N processes to finish.
const results = await Promise.all(
  procs.map(({ p, key, run, out }) =>
    new Promise<{ key: string; code: number; run: string; out: string }>((resolve) => {
      p.on("close", (code: number | null) => resolve({ key, code: code ?? 1, run, out: out() }));
    })
  )
);

// Kill daemons on test exit — register any pid that made it into a runfile.
for (const { run, key } of results) {
  const rf = join(run, `daemon-${key}.json`);
  if (existsSync(rf)) {
    try {
      const { pid } = JSON.parse(readFileSync(rf, "utf8")) as { pid: number };
      if (pid > 0) registerDaemonPid(pid);
    } catch { /* ignore bad runfile */ }
  }
}

// AC1: all N callers exit 0.
const codes = results.map((r) => r.code);
ok(codes.every((c) => c === 0),
  `LOOP-76 AC1: all ${N} concurrent cold starts exit 0 (codes: ${codes.join(",")})`);

// AC2: all N daemons bound to distinct ports.
const ports = results.map(({ run, key }) => {
  try {
    return (JSON.parse(readFileSync(join(run, `daemon-${key}.json`), "utf8")) as { port: number }).port;
  } catch { return -1; }
});
const distinctPorts = new Set(ports).size === N && ports.every((p) => p > 0);
ok(distinctPorts,
  `LOOP-76 AC2: all ${N} daemons on distinct ports (${ports.join(",")})`);

// AC3: each daemon is reachable and identifies its own project.
const healthResults = await Promise.all(
  results.map(async ({ run, key }) => {
    try {
      const { port } = JSON.parse(readFileSync(join(run, `daemon-${key}.json`), "utf8")) as { port: number };
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2000);
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ac.signal }).finally(() => clearTimeout(t));
      if (r.status !== 200) return false;
      const b = (await r.json()) as { ok?: boolean; project?: string };
      return b.ok === true && b.project === key;
    } catch { return false; }
  })
);
ok(healthResults.every(Boolean),
  `LOOP-76 AC3: all ${N} daemons healthy and project-identified`);

rmSync(TMP, { recursive: true, force: true });
console.log(fails === 0 ? "\nCOLD_START_RACE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
