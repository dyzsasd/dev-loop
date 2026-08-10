// LOOP-469 — an autostart binding is a WRITTEN, READABLE decision (design `state-locality`, I1).
//
// The incident: `install-autostart` snapshotted the install shell's DEVLOOP_HOME /
// DEVLOOP_PROJECTS_JSON / DEVLOOP_HUB_DB / DEVLOOP_RUN_DIR into the plist and wrote no
// WorkingDirectory, so at login `up-all` started whatever project set that shell had happened to
// export — a decision recorded nowhere an operator would read.
//
// AC5 note (how "fails on main" was established): main's `install-autostart` has no `--dry-run`, so
// running it to observe the plist would bootstrap a REAL LaunchAgent on the machine running the
// suite. The env-snapshot regression is therefore pinned two ways that are both safe: the rendered
// plist must carry no decoy (behaviour), and the install path must not READ the four
// workspace-selecting vars from process.env (source). The second fails on main for exactly the
// reason AC2 names; both were mutation-checked against this branch.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { autostartPlistXml, readAutostartBinding, describeAutostartBinding, AUTOSTART_CARRIED_ENV } from "../src/daemon-lifecycle.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.env.DEVLOOP_NODE || process.execPath;
const ROOT = `/tmp/dl-autostart-${process.pid}`;
// ROOT is canonicalized (/tmp is a symlink to /private/tmp on macOS): the product records the REAL
// path of the workspace it binds, so a fixture comparing against the symlinked path would fail on a
// correct implementation.
const RROOT = (() => { mkdirSync(`/tmp/dl-autostart-${process.pid}`, { recursive: true }); return realpathSync(`/tmp/dl-autostart-${process.pid}`); })();
const WS_A = join(RROOT, "wsA");          // the workspace we bind
const WS_B = join(RROOT, "wsB");          // a DIFFERENT workspace — the decoy the old plist would start
const FAKE_HOME = join(RROOT, "home");     // so no test ever touches the real ~/Library/LaunchAgents
const PLIST = join(FAKE_HOME, "Library", "LaunchAgents", "com.dyzsasd.dev-loop.daemon.plist");
const NOWHERE = join(RROOT, "nowhere");    // a dir with no dev-loop.json anywhere above it… except /tmp

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// The four vars whose presence in the plist would re-decide the workspace behind DEVLOOP_WORKSPACE's
// back: DEVLOOP_PROJECTS_JSON short-circuits loadProjectsConfig(); DEVLOOP_HUB_DB + DEVLOOP_RUN_DIR
// short-circuit resolveDaemonContext(); DEVLOOP_HOME re-points the legacy home anchor.
const WORKSPACE_SELECTING = ["DEVLOOP_PROJECTS_JSON", "DEVLOOP_HUB_DB", "DEVLOOP_HOME", "DEVLOOP_RUN_DIR"];
const DECOY = {
  DEVLOOP_PROJECTS_JSON: join(WS_B, "dev-loop.json"),
  DEVLOOP_HUB_DB: join(WS_B, ".dev-loop", "hub.db"),
  DEVLOOP_HOME: join(WS_B, ".dev-loop"),
  DEVLOOP_RUN_DIR: join(WS_B, ".dev-loop"),
};

function cli(cwd: string, extra: Record<string, string>, ...args: string[]) {
  return spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), ...args], {
    cwd, encoding: "utf8", timeout: 60_000,
    env: { ...scrubFireEnv(), HOME: FAKE_HOME, DEVLOOP_ACTOR: "operator", ...extra } as NodeJS.ProcessEnv,
  });
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(NOWHERE, { recursive: true });
mkdirSync(join(FAKE_HOME, "Library", "LaunchAgents"), { recursive: true });

try {
  // ── Setup: two real workspaces, each with its own backend:"service" project ────────────────────
  for (const [dir, key, proj, prefix] of [[WS_A, "wsa", "alpha", "ALP"], [WS_B, "wsb", "beta", "BET"]] as const) {
    mkdirSync(dir, { recursive: true });
    const init = cli("/tmp", {}, "team", "init", "--dir", dir, "--key", key, "--backend", "service", "--yes");
    ok(init.status === 0, `setup: team init ${key} → exit 0 (got ${init.status}: ${(init.stderr ?? "").split("\n")[0]})`);
    const add = cli(dir, {}, "team", "add-project", proj, "--prefix", prefix);
    ok(add.status === 0, `setup: add-project ${proj} → exit 0 (got ${add.status}: ${(add.stderr ?? "").split("\n")[0]})`);
  }

  // ── AC1 — no discoverable workspace and no argument ⇒ REFUSE, write nothing ────────────────────
  {
    const r = cli(NOWHERE, { DEVLOOP_WORKSPACE: "" }, "daemon", "install-autostart");
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // /tmp itself must not be a workspace, or the ascent would find one and this arm is vacuous.
    ok(!existsSync("/tmp/dev-loop.json"), "AC1 precondition: /tmp holds no dev-loop.json (the ascent finds nothing)");
    ok(r.status !== 0, `AC1: refuses with a non-zero exit (got ${r.status})`);
    ok(/--workspace/.test(out), "AC1: the refusal names `--workspace <workspace-root>`");
    ok(!existsSync(PLIST), "AC1: no plist was written");
  }
  // ── AC1b — an argument that is not a workspace is also a refusal, not a guess ──────────────────
  {
    const r = cli(NOWHERE, {}, "daemon", "install-autostart", "--workspace", NOWHERE);
    ok(r.status !== 0, `AC1b: --workspace <not-a-workspace> refuses (got ${r.status})`);
    ok(/dev-loop\.json/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`), "AC1b: the refusal says why (no dev-loop.json)");
    ok(!existsSync(PLIST), "AC1b: no plist was written");
  }

  // ── AC2/AC5 — the generated plist binds the workspace and carries no ambient decoy ─────────────
  // Rendered through the real CLI with all four decoys exported, i.e. exactly the install-time shell
  // that caused the incident.
  const dry = cli(WS_B, { ...DECOY, DEVLOOP_NODE: NODE }, "daemon", "install-autostart", "--workspace", WS_A, "--dry-run");
  ok(dry.status === 0, `AC2: --dry-run exits 0 (got ${dry.status}: ${(dry.stderr ?? "").split("\n")[0]})`);
  const xml = dry.stdout ?? "";
  ok(!existsSync(PLIST), "AC2: --dry-run wrote no plist (it renders only)");
  ok(new RegExp(`<key>WorkingDirectory</key><string>${WS_A}</string>`).test(xml), "AC2: plist sets WorkingDirectory to the bound workspace");
  ok(new RegExp(`<key>DEVLOOP_WORKSPACE</key><string>${WS_A}</string>`).test(xml), "AC2: plist sets DEVLOOP_WORKSPACE to the bound workspace");
  for (const k of WORKSPACE_SELECTING) {
    ok(!xml.includes(`<key>${k}</key>`), `AC2: plist does NOT carry ${k} from the ambient environment`);
    ok(!xml.includes(DECOY[k as keyof typeof DECOY]), `AC2: plist contains no ${k} decoy VALUE`);
  }
  ok(xml.includes("<key>DEVLOOP_NODE</key>"), "AC2: DEVLOOP_NODE IS carried (it names the interpreter, not a workspace)");
  ok(!AUTOSTART_CARRIED_ENV.some((k) => WORKSPACE_SELECTING.includes(k)), "AC5: the carried-env allow-list contains no workspace-selecting var");

  // AC5 (source arm) — the install path must not READ the four vars from process.env. This is the
  // assertion that is RED on main: main's installAutostart loops over exactly these names.
  {
    const src = readFileSync(join(hubRoot, "src", "daemon-lifecycle.ts"), "utf8");
    const install = src.slice(src.indexOf("function installAutostart("), src.indexOf("function uninstallAutostart("));
    ok(install.length > 0, "AC5: located installAutostart() in source");
    for (const k of WORKSPACE_SELECTING)
      ok(!install.includes(k), `AC5: installAutostart() never mentions ${k} (main snapshots it)`);
  }

  // ── AC3 — up-all under that plist starts only the bound workspace's service projects ───────────
  // The plist's EnvironmentVariables + WorkingDirectory are applied EXACTLY as launchd would, and
  // nothing else: this is the login environment, reconstructed.
  {
    const envPairs = [...xml.matchAll(/<key>(DEVLOOP_[A-Z_]+)<\/key><string>([^<]*)<\/string>/g)]
      .reduce<Record<string, string>>((a, m) => (a[m[1]] = m[2], a), {});
    const wd = /<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/.exec(xml)?.[1] ?? "";
    ok(wd === WS_A, `AC3: reconstructed login cwd is the bound workspace (${wd})`);
    const probe = join(RROOT, "probe.mjs");
    writeFileSync(probe, `const m = await import(${JSON.stringify(join(hubRoot, "src", "daemon-lifecycle.ts"))});\nconsole.log(JSON.stringify(m.upAllServiceKeys()));\n`);
    const r = spawnSync(NODE, [probe], {
      cwd: wd, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH ?? "", HOME: FAKE_HOME, ...envPairs } as NodeJS.ProcessEnv,
    });
    ok(r.status === 0, `AC3: up-all resolution runs under the login env (got ${r.status}: ${(r.stderr ?? "").split("\n").slice(-3).join(" | ")})`);
    const line = (r.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}";
    const got = JSON.parse(line) as { workspace: string | null; keys: string[] };
    ok(got.workspace === WS_A, `AC3: up-all resolves the BOUND workspace (got ${got.workspace})`);
    ok(got.keys.includes("alpha"), `AC3: it starts the bound workspace's service project (keys: ${got.keys.join(",")})`);
    ok(!got.keys.includes("beta"), "AC3: a project belonging to a DIFFERENT workspace is NOT started");
  }

  // ── AC4 — the binding is readable without parsing the plist by hand ────────────────────────────
  {
    mkdirSync(dirname(PLIST), { recursive: true });
    writeFileSync(PLIST, autostartPlistXml({ node: NODE, entry: "/x/daemon.ts", workspace: WS_A, logDir: join(WS_A, ".dev-loop") }));
    const b = readAutostartBinding(PLIST);
    ok(b.installed && b.workspace === WS_A, `AC4: readAutostartBinding reports the bound workspace (got ${b.workspace})`);
    ok(describeAutostartBinding(b).includes(WS_A), "AC4: the one-line description names the workspace");

    const status = cli(WS_A, {}, "daemon", "status");
    ok(/daemon autostart/.test(`${status.stdout ?? ""}${status.stderr ?? ""}`), "AC4: `daemon status` prints the autostart binding line");
    if (process.platform === "darwin")
      ok((status.stdout ?? "").includes(WS_A), `AC4: \`daemon status\` names the bound workspace`);
    else ok(true, "AC4: binding line is macOS-only (skipped: not darwin)");

    // Absent → informational, and it must NOT read as a deficiency (AC7's polarity, at the source).
    const none = readAutostartBinding(join(RROOT, "no-such.plist"));
    ok(!none.installed && none.workspace === null, "AC4: absent plist reports not-installed");
    ok(!/install-autostart` to start service projects at login/.test(describeAutostartBinding(none)),
      "AC7: the absent-plist line no longer prescribes the verb as a fix for a warning");
    ok(/default/.test(describeAutostartBinding(none)), "AC7: the absent-plist line states it is the designed default");

    // A pre-LOOP-469 plist (no WorkingDirectory, no DEVLOOP_WORKSPACE) IS a real deficiency.
    const legacy = join(RROOT, "legacy.plist");
    writeFileSync(legacy, `<?xml version="1.0"?><plist version="1.0"><dict>\n  <key>Label</key><string>com.dyzsasd.dev-loop.daemon</string>\n  <key>RunAtLoad</key><true/>\n  <key>EnvironmentVariables</key>\n  <dict>\n      <key>DEVLOOP_HUB_DB</key><string>${DECOY.DEVLOOP_HUB_DB}</string>\n  </dict>\n</dict></plist>\n`);
    const lb = readAutostartBinding(legacy);
    ok(lb.installed && lb.workspace === null, "AC4: a legacy plist reads as installed-but-unbound");
    ok(/NO workspace/.test(describeAutostartBinding(lb)), "AC7: installed-but-unbound is described as a deficiency");
  }

  // ── AC7 — doctor's classification for both states ──────────────────────────────────────────────
  {
    const withPlist = cli(WS_A, {}, "doctor");
    const lines = `${withPlist.stdout ?? ""}${withPlist.stderr ?? ""}`.split("\n").filter((l) => l.includes("daemon autostart"));
    ok(lines.length > 0, "AC7: doctor emits an autostart line");
    if (process.platform === "darwin") {
      ok(lines.some((l) => l.includes(WS_A)), `AC7: present plist → doctor reports the binding (${lines[0] ?? ""})`);
      ok(!lines.some((l) => /^\s*(⚠|WARN)/.test(l)), "AC7: a bound plist is not a warning");
    } else ok(true, "AC7: plist arm is macOS-only (skipped: not darwin)");

    rmSync(PLIST, { force: true });
    const noPlist = cli(WS_A, {}, "doctor");
    const nl = `${noPlist.stdout ?? ""}${noPlist.stderr ?? ""}`.split("\n").filter((l) => l.includes("daemon autostart"));
    ok(nl.length > 0, "AC7: doctor still reports autostart when absent");
    ok(!nl.some((l) => /⚠|WARN/.test(l)), `AC7: ABSENT plist is NOT graded a warning (${nl[0] ?? ""})`);
  }

  // ── AC6 — uninstall removes whatever install wrote, previous format included ───────────────────
  for (const [label, body] of [
    ["current", autostartPlistXml({ node: NODE, entry: "/x/daemon.ts", workspace: WS_A, logDir: join(WS_A, ".dev-loop") })],
    ["legacy", `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.dyzsasd.dev-loop.daemon</string><key>RunAtLoad</key><true/></dict></plist>\n`],
  ] as const) {
    mkdirSync(dirname(PLIST), { recursive: true });
    writeFileSync(PLIST, body);
    const r = cli(WS_A, {}, "daemon", "uninstall-autostart");
    ok(r.status === 0, `AC6 (${label}): uninstall-autostart exits 0 (got ${r.status})`);
    ok(!existsSync(PLIST), `AC6 (${label}): the plist is gone`);
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nautostart-binding: ALL PASS" : `\nautostart-binding: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
