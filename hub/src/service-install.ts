#!/usr/bin/env node
// `dev-loop service <install|uninstall|status|list>` — generate + install OS-scheduler units that own the
// dev-loop cadence by firing a STATELESS one-shot headless fire per agent (`dev-loop run --once --agents <a>`),
// plus a KeepAlive unit that holds the hub web-UI daemon up on a headless host. This is the recommended way to
// run the loop: the OS scheduler (launchd on macOS / systemd on Linux / cron fallback) replaces both the
// in-session `/loop` cadence and the bespoke long-running `dev-loop run` supervisor.
//
// Reuses, never re-implements: the cadence table + agent expansion from run-agents.ts (the SAME schedule the
// supervisor uses), project/cwd resolution from resolve-project.ts, and the deterministic per-project port +
// runfile dir from daemon-lifecycle.ts. The generators are PURE (no fs/spawn) so they're unit-testable; only
// `runService` touches the filesystem / launchctl / systemctl / crontab, and it honors --dry-run throughout.
//
// Idempotent: install records every {label,path} it wrote into a per-project manifest
// (~/.dev-loop/service-<project>.json), so a re-install cleanly replaces and `uninstall` removes EXACTLY what
// was installed (never a glob — multi-project safe). Side-effect-free on import (CLI guard keys on argv[1]).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_INTERVALS, VALID_AGENTS, expandAgentSpec, parseDuration,
  type Agent, type RunnerCli,
} from "./run-agents.ts";
import { loadProjectsConfig, resolveProjectFromCwd, type ProjectsConfig } from "./resolve-project.ts";
import { portForProject, daemonRunDir } from "./daemon-lifecycle.ts";
import { devloopDataDir, hubDbPath } from "./paths.ts";
import { findCompatibleNode } from "./node-runtime.ts";

export type Scheduler = "launchd" | "systemd" | "cron";
export type ServiceSub = "install" | "uninstall" | "status" | "list";

const here = dirname(fileURLToPath(import.meta.url));            // hub/src (dev) | dist (published)
const EXT = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
const isPluginRoot = (p: string) => existsSync(join(p, "skills")) && existsSync(join(p, "references"));
const defaultRoot = (): string => {
  const candidates = [join(here, "plugin"), resolve(here, "..", "..")];
  return candidates.find(isPluginRoot) ?? resolve(here, "..", "..");
};
// Reuse the SAME data-home + hub-db resolution as `dev-loop run`/`daemon` (paths.ts, 0.23.x) so the
// installed units, the runner, and the daemon all coordinate through one ~/.dev-loop by default.
const defaultDataDir = (): string => devloopDataDir();
const defaultHubDb = (): string => hubDbPath();

export interface ServiceOpts {
  sub: ServiceSub;
  project: string;
  cli: RunnerCli;
  agents: Agent[];
  intervals: Record<Agent, number>;
  scheduler: Scheduler;
  withDaemon: boolean;
  dryRun: boolean;
  cwd: string;                 // unit WorkingDirectory (the project repo)
  root: string;                // CLAUDE_PLUGIN_ROOT (skills/references live here)
  dataDir: string;             // CLAUDE_PLUGIN_DATA (runner-logs live under <dataDir>/<project>)
  hubDb: string;
  nodeBin: string;             // process.execPath — units invoke node by absolute path (PATH-independent)
  cliBin: string;              // resolved claude/codex bin baked into the unit env
}

type Kind = "launchd" | "systemd-service" | "systemd-timer" | "cron";
export interface GeneratedUnit {
  kind: Kind;
  agent: Agent | "daemon";
  label: string;
  path: string;                // absolute file path; for cron, the sentinel "crontab"
  contents: string;
  enableCmd?: string[];        // load/enable (launchd bootstrap / systemctl enable --now)
  disableCmd?: string[];       // unload/disable (launchd bootout / systemctl disable --now)
}
interface ManifestUnit { label: string; path: string; kind: Kind; agent: Agent | "daemon"; }
export interface ServiceManifest {
  project: string; scheduler: Scheduler; cli: RunnerCli; installedAt: string; units: ManifestUnit[];
}

const log = (m: string): void => console.log(m);
const uid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);
// Testability + portability hooks: redirect where unit files land and skip the OS load/enable step (so a test
// can do a real file+manifest round-trip without touching the live ~/Library/LaunchAgents or the user crontab).
const launchdDir = (): string => process.env.DEVLOOP_LAUNCHD_DIR ?? join(homedir(), "Library", "LaunchAgents");
const systemdDir = (): string => process.env.DEVLOOP_SYSTEMD_DIR ?? join(homedir(), ".config", "systemd", "user");
const noLoad = (): boolean => process.env.DEVLOOP_SERVICE_NO_LOAD === "1";

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function plistEnvDict(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `      <key>${xmlEsc(k)}</key><string>${xmlEsc(v)}</string>`)
    .join("\n");
}
function pathValue(nodeBin: string, cliBin: string): string {
  const dirs = [dirname(nodeBin), dirname(cliBin), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs.filter(Boolean))].join(":");
}
function agentEnv(o: ServiceOpts): Record<string, string> {
  const cliBinKey = o.cli === "claude" ? "DEVLOOP_CLAUDE_BIN" : "DEVLOOP_CODEX_BIN";
  return {
    PATH: pathValue(o.nodeBin, o.cliBin),
    DEVLOOP_PROJECT: o.project,
    DEVLOOP_HUB_DB: o.hubDb,
    DEVLOOP_DATA_DIR: o.dataDir,   // the var run-agents/paths.ts actually read for the data home
    CLAUDE_PLUGIN_ROOT: o.root,
    CLAUDE_PLUGIN_DATA: o.dataDir, // legacy alias still honored for projects.json discovery + skill ${CLAUDE_PLUGIN_DATA}
    [cliBinKey]: o.cliBin,
  };
}
function daemonEnv(o: ServiceOpts): Record<string, string> {
  return {
    PATH: pathValue(o.nodeBin, o.cliBin),
    DEVLOOP_PROJECT: o.project,
    DEVLOOP_HUB_DB: o.hubDb,
    DEVLOOP_DATA_DIR: o.dataDir,
    DEVLOOP_DAEMON_PORT: String(portForProject(o.project)),
    DEVLOOP_DAEMON_SERVICE: "1",
    CLAUDE_PLUGIN_ROOT: o.root,
    CLAUDE_PLUGIN_DATA: o.dataDir,
  };
}
const cliEntry = (): string => join(here, `cli${EXT}`);
const daemonEntry = (): string => join(here, `daemon${EXT}`);
const runArgs = (o: ServiceOpts, agent: Agent): string[] =>
  [cliEntry(), "run", "--once", "--agents", agent, "--project", o.project, "--cli", o.cli];
const logDirFor = (o: ServiceOpts): string => join(o.dataDir, o.project, "runner-logs");
const daemonLog = (o: ServiceOpts): string => join(daemonRunDir(), `daemon-${o.project}.log`);

// cadence → scheduler-native cron expression (daily agents pin to 03:00 wall-clock).
function cronExprFor(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (ms >= 24 * 3_600_000) return "0 3 * * *";
  if (min >= 60 && min % 60 === 0) return `0 */${min / 60} * * *`;
  if (min >= 1 && 60 % min === 0) return `*/${min} * * * *`;
  return `*/${Math.max(1, min)} * * * *`;
}
const isDaily = (ms: number): boolean => ms >= 24 * 3_600_000;

// ── pure generators ──────────────────────────────────────────────────────────────────────────────────────
export function renderLaunchdAgentPlist(o: ServiceOpts, agent: Agent): string {
  const label = `com.dev-loop.${o.project}.${agent}`;
  const args = [o.nodeBin, ...runArgs(o, agent)];
  const prog = args.map((a) => `    <string>${xmlEsc(a)}</string>`).join("\n");
  const lg = join(logDirFor(o), `${agent}.launchd.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEsc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${prog}
  </array>
  <key>StartInterval</key><integer>${Math.round(o.intervals[agent] / 1000)}</integer>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${xmlEsc(o.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${plistEnvDict(agentEnv(o))}
  </dict>
  <key>StandardOutPath</key><string>${xmlEsc(lg)}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(lg)}</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}
export function renderLaunchdDaemonPlist(o: ServiceOpts): string {
  const label = `com.dev-loop.${o.project}.daemon`;
  const args = [o.nodeBin, daemonEntry()];
  const prog = args.map((a) => `    <string>${xmlEsc(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEsc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${prog}
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${xmlEsc(o.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${plistEnvDict(daemonEnv(o))}
  </dict>
  <key>StandardOutPath</key><string>${xmlEsc(daemonLog(o))}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(daemonLog(o))}</string>
</dict></plist>
`;
}
function systemdEnvLines(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`).join("\n");
}
export function renderSystemdService(o: ServiceOpts, agent: Agent): string {
  return `[Unit]
Description=dev-loop fire: ${o.project}/${agent}

[Service]
Type=oneshot
WorkingDirectory=${o.cwd}
${systemdEnvLines(agentEnv(o))}
ExecStart=${o.nodeBin} ${runArgs(o, agent).join(" ")}
`;
}
export function renderSystemdTimer(o: ServiceOpts, agent: Agent): string {
  const ms = o.intervals[agent];
  const schedule = isDaily(ms) ? "OnCalendar=*-*-* 03:00:00" : `OnUnitActiveSec=${Math.round(ms / 1000)}`;
  return `[Unit]
Description=dev-loop cadence: ${o.project}/${agent}

[Timer]
OnBootSec=2min
${schedule}
Persistent=true

[Install]
WantedBy=timers.target
`;
}
export function renderSystemdDaemonService(o: ServiceOpts): string {
  return `[Unit]
Description=dev-loop hub daemon (web UI + circuit-breakers): ${o.project}

[Service]
Type=simple
WorkingDirectory=${o.cwd}
${systemdEnvLines(daemonEnv(o))}
ExecStart=${o.nodeBin} ${daemonEntry()}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}
const CRON_BEGIN = (p: string): string => `# >>> dev-loop service: ${p} (managed, do not edit) >>>`;
const CRON_END = (p: string): string => `# <<< dev-loop service: ${p} <<<`;
export function renderCronBlock(o: ServiceOpts): string {
  const lines: string[] = [CRON_BEGIN(o.project), `PATH=${pathValue(o.nodeBin, o.cliBin)}`];
  const envInline = `DEVLOOP_PROJECT=${o.project} DEVLOOP_HUB_DB=${o.hubDb} DEVLOOP_DATA_DIR=${o.dataDir} CLAUDE_PLUGIN_ROOT=${o.root} CLAUDE_PLUGIN_DATA=${o.dataDir} ${o.cli === "claude" ? "DEVLOOP_CLAUDE_BIN" : "DEVLOOP_CODEX_BIN"}=${o.cliBin}`;
  for (const agent of o.agents) {
    const lg = join(logDirFor(o), `${agent}.cron.log`);
    lines.push(`${cronExprFor(o.intervals[agent])} cd ${o.cwd} && ${envInline} ${o.nodeBin} ${runArgs(o, agent).join(" ")} >> ${lg} 2>&1`);
  }
  if (o.withDaemon) {
    const denv = `DEVLOOP_PROJECT=${o.project} DEVLOOP_HUB_DB=${o.hubDb}`;
    lines.push(`@reboot ${denv} ${o.nodeBin} ${cliEntry()} daemon up >> ${daemonLog(o)} 2>&1`);
    lines.push(`*/5 * * * * ${denv} ${o.nodeBin} ${cliEntry()} daemon up >> ${daemonLog(o)} 2>&1`); // self-healing watchdog
  }
  lines.push(CRON_END(o.project));
  return lines.join("\n") + "\n";
}

// Generate the full unit set for the chosen scheduler (PURE — no fs, no spawn).
export function generateUnits(o: ServiceOpts): GeneratedUnit[] {
  const out: GeneratedUnit[] = [];
  if (o.scheduler === "launchd") {
    const la = launchdDir();
    for (const agent of o.agents) {
      const label = `com.dev-loop.${o.project}.${agent}`;
      out.push({
        kind: "launchd", agent, label, path: join(la, `${label}.plist`), contents: renderLaunchdAgentPlist(o, agent),
        enableCmd: ["launchctl", "bootstrap", `gui/${uid()}`, join(la, `${label}.plist`)],
        disableCmd: ["launchctl", "bootout", `gui/${uid()}/${label}`],
      });
    }
    if (o.withDaemon) {
      const label = `com.dev-loop.${o.project}.daemon`;
      out.push({
        kind: "launchd", agent: "daemon", label, path: join(la, `${label}.plist`), contents: renderLaunchdDaemonPlist(o),
        enableCmd: ["launchctl", "bootstrap", `gui/${uid()}`, join(la, `${label}.plist`)],
        disableCmd: ["launchctl", "bootout", `gui/${uid()}/${label}`],
      });
    }
    return out;
  }
  if (o.scheduler === "systemd") {
    const ud = systemdDir();
    for (const agent of o.agents) {
      const base = `dev-loop-${o.project}-${agent}`;
      out.push({ kind: "systemd-service", agent, label: `${base}.service`, path: join(ud, `${base}.service`), contents: renderSystemdService(o, agent) });
      out.push({
        kind: "systemd-timer", agent, label: `${base}.timer`, path: join(ud, `${base}.timer`), contents: renderSystemdTimer(o, agent),
        enableCmd: ["systemctl", "--user", "enable", "--now", `${base}.timer`],
        disableCmd: ["systemctl", "--user", "disable", "--now", `${base}.timer`],
      });
    }
    if (o.withDaemon) {
      const base = `dev-loop-${o.project}-daemon`;
      out.push({
        kind: "systemd-service", agent: "daemon", label: `${base}.service`, path: join(ud, `${base}.service`), contents: renderSystemdDaemonService(o),
        enableCmd: ["systemctl", "--user", "enable", "--now", `${base}.service`],
        disableCmd: ["systemctl", "--user", "disable", "--now", `${base}.service`],
      });
    }
    return out;
  }
  // cron: one managed block in the user's crontab
  out.push({ kind: "cron", agent: "daemon", label: `cron:${o.project}`, path: "crontab", contents: renderCronBlock(o) });
  return out;
}

// ── manifest ─────────────────────────────────────────────────────────────────────────────────────────────
const manifestPath = (project: string): string => join(daemonRunDir(), `service-${project}.json`);
function readManifest(project: string): ServiceManifest | null {
  try { return JSON.parse(readFileSync(manifestPath(project), "utf8")) as ServiceManifest; } catch { return null; }
}
function writeManifest(m: ServiceManifest): void {
  mkdirSync(daemonRunDir(), { recursive: true });
  const f = manifestPath(m.project), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, f); // atomic (§11)
}
function removeManifest(project: string): void { try { unlinkSync(manifestPath(project)); } catch { /* gone */ } }

// ── cron crontab read/modify/write (block-scoped, leaves the operator's other lines intact) ───────────────
function readCrontab(): string {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : ""; // non-zero ⇒ no crontab yet → empty
}
export function stripCronBlock(current: string, project: string): string {
  const begin = CRON_BEGIN(project), end = CRON_END(project);
  const lines = current.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const ln of lines) {
    if (ln.trim() === begin) { inside = true; continue; }
    if (ln.trim() === end) { inside = false; continue; }
    if (!inside) out.push(ln);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
function installCrontab(text: string): boolean {
  const r = spawnSync("crontab", ["-"], { input: text, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
  return r.status === 0;
}

// ── resolution helpers (mirror run-agents.ts without coupling to its Options shape) ───────────────────────
function resolveProjectKey(explicit: string | undefined, cfg: ProjectsConfig | null): string {
  const e = explicit || process.env.DEVLOOP_PROJECT?.trim();
  if (e) return e;
  const fromCwd = cfg ? resolveProjectFromCwd(process.cwd(), cfg) : null;
  return fromCwd || cfg?.defaultProject || Object.keys(cfg?.projects ?? {})[0] || "demo";
}
function resolveCwd(cfg: ProjectsConfig | null, project: string): string {
  const p = cfg?.projects?.[project];
  const repos = (p?.repos ?? []) as Array<{ path?: string; role?: string }>;
  const primary = repos.find((r) => r.role === "primary" && r.path)?.path;
  const docs = repos.find((r) => r.role === "docs" && r.path)?.path;
  return p?.repoPath || primary || docs || repos.find((r) => r.path)?.path || process.cwd();
}
function resolveCliBin(cli: RunnerCli): string {
  const envBin = cli === "claude" ? process.env.DEVLOOP_CLAUDE_BIN : process.env.DEVLOOP_CODEX_BIN;
  if (envBin) return envBin;
  const r = spawnSync("which", [cli], { encoding: "utf8" });
  const found = r.status === 0 ? (r.stdout ?? "").trim().split("\n")[0] : "";
  if (found) return found;
  log(`⚠️  '${cli}' not found on PATH and DEVLOOP_${cli.toUpperCase()}_BIN is unset — baking the bare name '${cli}' into the unit. Install ${cli} or set DEVLOOP_${cli.toUpperCase()}_BIN before the units fire.`);
  return cli;
}

// ── orchestration ────────────────────────────────────────────────────────────────────────────────────────
export async function runService(o: ServiceOpts): Promise<number> {
  log(`dev-loop service ${o.sub} — project '${o.project}', scheduler '${o.scheduler}', cli '${o.cli}'${o.dryRun ? " [dry-run]" : ""}`);
  if (o.sub === "list") return listServices();
  if (o.sub === "status") return statusService(o);
  if (o.sub === "uninstall") return uninstallService(o.project, o.dryRun);
  return installService(o);
}

function installService(o: ServiceOpts): number {
  // idempotent replace: tear down a prior install first so re-running never leaves orphans.
  const prev = readManifest(o.project);
  if (prev) { log(`•  existing install found (${prev.units.length} units) — replacing`); uninstallService(o.project, o.dryRun); }

  const units = generateUnits(o);
  log(`•  generating ${units.length} unit(s): ${units.map((u) => u.agent).join(", ")}`);

  if (o.scheduler === "cron") {
    const u = units[0];
    const next = stripCronBlock(readCrontab(), o.project).replace(/\s*$/, "\n") + u.contents;
    if (o.dryRun) {
      log(`[dry-run] would write this managed block into your crontab:\n${u.contents}`);
    } else if (noLoad()) {
      mkdirSync(logDirFor(o), { recursive: true });
      log("•  (no-load) cron block generated; crontab left unchanged");
    } else {
      mkdirSync(logDirFor(o), { recursive: true });
      if (!installCrontab(next)) { log("❌ `crontab -` failed — crontab not modified"); return 1; }
      log("✅ crontab block installed");
    }
  } else {
    for (const u of units) {
      if (o.dryRun) {
        log(`[dry-run] would write ${u.path}:\n${u.contents}`);
        if (u.enableCmd) log(`[dry-run] would load: ${u.enableCmd.join(" ")}`);
        continue;
      }
      mkdirSync(dirname(u.path), { recursive: true });
      mkdirSync(logDirFor(o), { recursive: true });
      mkdirSync(daemonRunDir(), { recursive: true });
      writeFileSync(u.path, u.contents);
      if (o.scheduler === "systemd" && !noLoad()) spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
      if (u.enableCmd && !noLoad()) {
        const r = spawnSync(u.enableCmd[0], u.enableCmd.slice(1), { stdio: "inherit" });
        if (r.status !== 0) log(`⚠️  load failed (${u.enableCmd.join(" ")}) — unit written; load it by hand`);
      }
      log(`✅ ${u.label} → ${u.path}`);
    }
    if (o.scheduler === "systemd" && !o.dryRun && !noLoad()) {
      log("ℹ️  headless host? run `loginctl enable-linger $USER` so --user timers keep firing after logout.");
    }
  }

  if (!o.dryRun) {
    writeManifest({
      project: o.project, scheduler: o.scheduler, cli: o.cli, installedAt: new Date().toISOString(),
      units: units.map((u) => ({ label: u.label, path: u.path, kind: u.kind, agent: u.agent })),
    });
    log(`\n✅ installed — ${units.length} unit(s) for '${o.project}'. Manifest: ${manifestPath(o.project)}`);
  } else {
    log("\n[dry-run] service install preview complete — nothing written, nothing loaded.");
  }
  return 0;
}

function uninstallService(project: string, dryRun: boolean): number {
  const m = readManifest(project);
  if (!m) { log(`•  no service manifest for '${project}' — nothing to uninstall.`); return 0; }
  if (m.scheduler === "cron") {
    if (dryRun) { log(`[dry-run] would strip the managed crontab block for '${project}'`); return 0; }
    if (!installCrontab(stripCronBlock(readCrontab(), project))) { log("❌ `crontab -` failed — crontab not modified"); return 1; }
    log("✅ crontab block removed");
  } else {
    for (const u of m.units) {
      const disable = u.kind === "launchd"
        ? ["launchctl", "bootout", `gui/${uid()}/${u.label}`]
        : u.kind === "systemd-timer" || (u.kind === "systemd-service" && u.agent === "daemon")
          ? ["systemctl", "--user", "disable", "--now", u.label]
          : null;
      if (dryRun) {
        if (disable) log(`[dry-run] would unload: ${disable.join(" ")}`);
        log(`[dry-run] would remove ${u.path}`);
        continue;
      }
      if (disable && !noLoad()) spawnSync(disable[0], disable.slice(1), { stdio: "ignore" }); // best-effort (already unloaded is fine)
      try { unlinkSync(u.path); } catch { /* already gone */ }
      log(`✅ removed ${u.label}`);
    }
    if (m.scheduler === "systemd" && !dryRun && !noLoad()) spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  }
  if (!dryRun) { removeManifest(project); log(`\n✅ uninstalled '${project}'.`); }
  return 0;
}

function statusService(o: ServiceOpts): number {
  const m = readManifest(o.project);
  if (!m) { log(`•  '${o.project}' has no installed service (no manifest). Install with \`dev-loop service install\`.`); return 0; }
  log(`•  '${o.project}' — scheduler ${m.scheduler}, cli ${m.cli}, installed ${m.installedAt}`);
  for (const u of m.units) {
    const present = u.path === "crontab" ? "(crontab block)" : existsSync(u.path) ? "present" : "MISSING";
    log(`   ${u.agent.padEnd(14)} ${u.label}  [${present}]`);
  }
  log(`   logs: ${logDirFor(o)}  ·  daemon: ${daemonLog(o)}`);
  return 0;
}

function listServices(): number {
  const dir = daemonRunDir();
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.startsWith("service-") && f.endsWith(".json")); } catch { files = []; }
  if (!files.length) { log("•  no installed dev-loop services on this machine."); return 0; }
  for (const f of files) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as ServiceManifest;
      log(`   ${m.project.padEnd(16)} ${m.scheduler}  ${m.units.length} unit(s)  (installed ${m.installedAt})`);
    } catch { /* skip unreadable */ }
  }
  return 0;
}

// ── arg parsing + CLI guard ──────────────────────────────────────────────────────────────────────────────
export function parseServiceArgs(argv: string[]): ServiceOpts {
  const sub = (argv[0] as ServiceSub) || "install";
  if (!["install", "uninstall", "status", "list"].includes(sub)) {
    console.error(`dev-loop service: unknown subcommand '${sub}' (use install|uninstall|status|list)`);
    process.exit(2);
  }
  const rest = argv.slice(1);
  let project: string | undefined, cli: RunnerCli = (process.env.DEVLOOP_RUNNER_CLI as RunnerCli) || "claude";
  let scheduler: Scheduler | undefined, dryRun = false, withDaemon = true, devSplit = false;
  const agentSpecs: string[] = [];
  const intervals = { ...DEFAULT_INTERVALS };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = (): string => rest[++i] ?? (() => { console.error(`${a} requires a value`); process.exit(2); })();
    if (a === "--project") project = next();
    else if (a === "--cli") { const v = next(); if (v !== "claude" && v !== "codex") { console.error("--cli must be claude or codex"); process.exit(2); } cli = v; }
    else if (a === "--agents" || a === "--agent") agentSpecs.push(next());
    else if (a === "--dev-split") devSplit = true;
    else if (a === "--launchd") scheduler = "launchd";
    else if (a === "--systemd") scheduler = "systemd";
    else if (a === "--cron") scheduler = "cron";
    else if (a === "--no-daemon") withDaemon = false;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--interval") {
      const raw = next(); const eq = raw.indexOf("=");
      if (eq <= 0) { console.error("--interval must look like agent=duration"); process.exit(2); }
      const ag = raw.slice(0, eq) as Agent;
      if (!(VALID_AGENTS as readonly string[]).includes(ag)) { console.error(`unknown agent in --interval '${ag}'`); process.exit(2); }
      intervals[ag] = parseDuration(raw.slice(eq + 1));
    } else { console.error(`dev-loop service: unknown option '${a}'`); process.exit(2); }
  }
  let agents = expandAgentSpec(agentSpecs.length ? agentSpecs : ["core"]);
  if (devSplit) agents = [...new Set(agents.flatMap((x) => (x === "dev" ? (["senior-dev", "junior-dev"] as Agent[]) : [x])))];

  const cfg = loadProjectsConfig();
  const key = resolveProjectKey(project, cfg);
  const defaultScheduler: Scheduler = process.platform === "darwin" ? "launchd" : process.platform === "linux" ? "systemd" : "cron";
  return {
    sub, project: key, cli, agents, intervals,
    scheduler: scheduler ?? defaultScheduler,
    withDaemon, dryRun,
    cwd: resolveCwd(cfg, key),
    root: process.env.CLAUDE_PLUGIN_ROOT || process.env.DEVLOOP_PLUGIN_ROOT || defaultRoot(),
    dataDir: defaultDataDir(),
    hubDb: defaultHubDb(),
    // absolute, version-checked node baked into every unit (OS schedulers don't inherit shell PATH);
    // prefer the node already running this install, fall back to discovery.
    nodeBin: findCompatibleNode([process.execPath]) ?? process.execPath,
    cliBin: resolveCliBin(cli),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseServiceArgs(process.argv.slice(2));
  runService(opts).then((code) => process.exit(code)).catch((e) => { console.error(`dev-loop service: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
