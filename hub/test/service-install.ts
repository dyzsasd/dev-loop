import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_INTERVALS } from "../src/run-agents.ts";
import {
  generateUnits, renderLaunchdAgentPlist, renderLaunchdDaemonPlist,
  renderSystemdService, renderSystemdTimer, renderCronBlock, stripCronBlock,
  type ServiceOpts, type ServiceManifest,
} from "../src/service-install.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(hubRoot, "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const baseOpts = (over: Partial<ServiceOpts>): ServiceOpts => ({
  sub: "install", project: "demo", cli: "claude",
  agents: ["pm", "sweep", "reflect"], intervals: { ...DEFAULT_INTERVALS },
  scheduler: "launchd", withDaemon: true, dryRun: false,
  cwd: "/work/demo", root: repoRoot, dataDir: "/data", hubDb: "/run/hub.db",
  nodeBin: "/abs/bin/node", cliBin: "/usr/local/bin/claude", ...over,
});

// ── pure generators ──────────────────────────────────────────────────────────────────────────────────────
const pm = renderLaunchdAgentPlist(baseOpts({}), "pm");
ok(/<string>com\.dev-loop\.demo\.pm<\/string>/.test(pm), "launchd agent plist carries the per-project label");
ok(/<key>StartInterval<\/key><integer>300<\/integer>/.test(pm), "pm cadence renders as StartInterval 300s");
ok(/<string>--once<\/string>/.test(pm) && /<string>pm<\/string>/.test(pm), "agent unit invokes `run --once --agents pm`");
ok(pm.includes("/abs/bin/node"), "the absolute node (process.execPath) is baked into ProgramArguments");
ok(/<key>PATH<\/key>/.test(pm) && pm.includes("/usr/local/bin") && pm.includes("/opt/homebrew/bin"), "unit PATH includes the cli bin dir + homebrew (the launchd PATH gotcha)");
ok(pm.includes("<key>DEVLOOP_CLAUDE_BIN</key>"), "the resolved claude bin is baked into the unit env");

const dpl = renderLaunchdDaemonPlist(baseOpts({}));
ok(/<key>KeepAlive<\/key><true\/>/.test(dpl), "daemon plist is KeepAlive (held up on a headless host)");
ok(/<key>DEVLOOP_DAEMON_SERVICE<\/key><string>1<\/string>/.test(dpl), "daemon unit sets DEVLOOP_DAEMON_SERVICE=1 (writes the runfile)");
ok(/<key>DEVLOOP_DAEMON_PORT<\/key><string>\d+<\/string>/.test(dpl), "daemon unit bakes the deterministic per-project port");
ok(/daemon\.(ts|js)/.test(dpl), "daemon unit runs the foreground daemon boot, not `daemon up`");

// ── generateUnits counts ──
const launchd = generateUnits(baseOpts({ scheduler: "launchd" }));
ok(launchd.length === 4, "launchd: one unit per agent + the daemon unit (3 + 1)");
ok(launchd.filter((u) => u.agent === "daemon").length === 1, "launchd includes exactly one daemon unit");
ok(generateUnits(baseOpts({ scheduler: "launchd", withDaemon: false })).length === 3, "--no-daemon omits the daemon unit");

const sys = generateUnits(baseOpts({ scheduler: "systemd" }));
ok(sys.length === 3 * 2 + 1, "systemd: a .service + .timer per agent, plus the daemon .service");
ok(renderSystemdTimer(baseOpts({}), "reflect").includes("OnCalendar=*-*-* 03:00:00"), "a daily agent maps to a wall-clock OnCalendar timer");
ok(renderSystemdTimer(baseOpts({}), "pm").includes("OnUnitActiveSec=300"), "a 5-min agent maps to OnUnitActiveSec=300");
ok(/Type=oneshot/.test(renderSystemdService(baseOpts({}), "pm")) && /run --once --agents pm/.test(renderSystemdService(baseOpts({}), "pm")), "systemd service is a oneshot firing `run --once`");

// ── cron ──
const cron = renderCronBlock(baseOpts({ scheduler: "cron" }));
ok(/\*\/5 \* \* \* \*.*--agents pm/.test(cron), "pm cron cadence = */5");
ok(/\*\/30 \* \* \* \*.*--agents sweep/.test(cron), "sweep cron cadence = */30");
ok(/0 3 \* \* \*.*--agents reflect/.test(cron), "a daily agent pins to 03:00");
ok(/@reboot.*daemon up/.test(cron) && /\*\/5 \* \* \* \*.*daemon up/.test(cron), "cron brings the daemon up at boot + a self-healing watchdog");
const surrounding = "MAILTO=me\n" + cron + "0 0 * * * other-job\n";
const stripped = stripCronBlock(surrounding, "demo");
ok(!/dev-loop service: demo/.test(stripped), "stripCronBlock removes the managed block");
ok(/MAILTO=me/.test(stripped) && /other-job/.test(stripped), "stripCronBlock preserves the operator's other crontab lines");

// ── CLI install → manifest → uninstall round-trip (NO_LOAD + redirected dirs: never touches real launchd) ──
const tmp = mkdtempSync(join(tmpdir(), "dl-service-"));
try {
  const la = join(tmp, "LaunchAgents");
  const env = {
    DEVLOOP_LAUNCHD_DIR: la,
    DEVLOOP_SERVICE_NO_LOAD: "1",
    DEVLOOP_RUN_DIR: tmp,                       // manifest + daemonRunDir → tmp
    DEVLOOP_HUB_DB: join(tmp, "hub.db"),
    DEVLOOP_CLAUDE_BIN: "/usr/bin/true",        // resolveCliBin short-circuits (no `which`, no warning)
    CLAUDE_PLUGIN_DATA: join(tmp, "data"),
  };
  const svc = (args: string[]) => spawnSync("node", ["src/service-install.ts", ...args], { cwd: hubRoot, encoding: "utf8", env: { ...process.env, ...env } });
  const manifest = join(tmp, "service-demo.json");

  // route smoke: the same command via the `dev-loop` CLI dispatch (cli.ts → service-install.ts)
  const route = spawnSync("node", ["src/cli.ts", "service", "install", "--project", "demo", "--cli", "claude", "--agents", "pm", "--launchd", "--dry-run"], { cwd: hubRoot, encoding: "utf8", env: { ...process.env, ...env } });
  ok((route.status ?? 1) === 0, "`dev-loop service` routes through cli.ts and exits 0");

  // dry-run writes nothing
  const dry = svc(["install", "--project", "demo", "--cli", "claude", "--agents", "pm", "--launchd", "--dry-run"]);
  ok((dry.status ?? 1) === 0, "dry-run install exits 0");
  ok(!existsSync(manifest), "dry-run writes no manifest");
  ok(!existsSync(la), "dry-run writes no unit files");

  // real install (no-load): files + manifest written, no launchctl
  const ins = svc(["install", "--project", "demo", "--cli", "claude", "--agents", "pm,sweep", "--launchd"]);
  ok((ins.status ?? 1) === 0, "install exits 0");
  ok(existsSync(join(la, "com.dev-loop.demo.pm.plist")), "install wrote the pm plist");
  ok(existsSync(join(la, "com.dev-loop.demo.sweep.plist")), "install wrote the sweep plist");
  ok(existsSync(join(la, "com.dev-loop.demo.daemon.plist")), "install wrote the daemon plist");
  const man = JSON.parse(readFileSync(manifest, "utf8")) as ServiceManifest;
  ok(man.units.length === 3 && man.scheduler === "launchd" && man.project === "demo", "the manifest records all 3 units + scheduler/project");

  // re-install is idempotent (clean replace, still 3 units)
  const reinstall = svc(["install", "--project", "demo", "--cli", "claude", "--agents", "pm,sweep", "--launchd"]);
  ok((reinstall.status ?? 1) === 0 && (JSON.parse(readFileSync(manifest, "utf8")) as ServiceManifest).units.length === 3, "re-install cleanly replaces (no orphan units)");

  // status + list read the manifest
  ok(/scheduler launchd/.test(svc(["status", "--project", "demo"]).stdout ?? ""), "status reports the installed scheduler");
  ok(/demo/.test(svc(["list"]).stdout ?? ""), "list enumerates the installed project");

  // uninstall removes EXACTLY what was installed
  const un = svc(["uninstall", "--project", "demo"]);
  ok((un.status ?? 1) === 0, "uninstall exits 0");
  ok(!existsSync(join(la, "com.dev-loop.demo.pm.plist")), "uninstall removed the pm plist");
  ok(!existsSync(join(la, "com.dev-loop.demo.daemon.plist")), "uninstall removed the daemon plist");
  ok(!existsSync(manifest), "uninstall removed the manifest");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nSERVICE_INSTALL_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
