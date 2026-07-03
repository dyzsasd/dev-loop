// `dev-loop hub start|stop|status` — workspace hub daemon lifecycle (service backend): start is
// idempotent, status reports RUNNING, stop truncates the WAL + removes the runfile, linear teams refuse.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-hublc-")));
const HOME = join(tmp, "home");
const env = { ...process.env, DEVLOOP_HOME: HOME };
const team = (args: string[], cwd = tmp) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env, encoding: "utf8" });
const hub = (sub: string, cwd: string) => { const r = spawnSync("node", [join(hubRoot, "src", "hub.ts"), sub], { cwd, env, encoding: "utf8", timeout: 20000 }); return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };

const ws = join(tmp, "ws");
try {
  team(["init", "--dir", ws, "--key", "hublc-team", "--backend", "service"]);
  const stateDir = join(ws, ".dev-loop");

  // start → running
  const start = hub("start", ws);
  ok(start.code === 0 && /up:.*RUNNING|up: started|RUNNING/.test(start.out), "hub start brings the daemon up");
  // idempotent second start → still one instance (no error)
  const start2 = hub("start", ws);
  ok(start2.code === 0, "hub start is idempotent (second start is a clean no-op)");
  const runfiles = () => readdirSync(stateDir).filter((f) => /^daemon-.*\.json$/.test(f));
  ok(runfiles().length === 1, "exactly one daemon runfile after a double start (single instance)");

  // status → RUNNING + size line
  const status = hub("status", ws);
  ok(/RUNNING/.test(status.out) && /hub\.db .* KB/.test(status.out), "hub status reports RUNNING + db/WAL sizes");

  // stop → WAL truncated + runfile removed
  const stop = hub("stop", ws);
  ok(stop.code === 0 && /checkpointed \+ truncated/.test(stop.out), "hub stop checkpoints + truncates the WAL");
  const wal = join(stateDir, "hub.db-wal");
  ok(!existsSync(wal) || statSync(wal).size === 0, "the WAL is empty (0 bytes) after stop");
  ok(runfiles().length === 0, "the daemon runfile is removed after stop");

  // linear team → refuses
  const lin = join(tmp, "lin");
  team(["init", "--dir", lin, "--key", "hublc-lin", "--backend", "linear", "--linear-team", "L"]);
  const refused = hub("status", lin);
  ok(refused.code !== 0 && /service-backend teams only/.test(refused.out), "hub refuses on a linear team (no hub.db)");

  console.log(fails === 0 ? "\nHUB_LIFECYCLE_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  // Always attempt to stop the daemon so a failed assertion never leaks a background process.
  try { hub("stop", ws); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
