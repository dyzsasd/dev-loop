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
import { autostartPlistXml, readAutostartBinding, describeAutostartBinding, AUTOSTART_CARRIED_ENV, readSystemdBinding, listSystemdBindings } from "../src/daemon-lifecycle.ts";

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
  // that caused the incident. `--format plist` pins the LaunchAgent form: since WS-B the default
  // artifact on Linux is the systemd --user unit (asserted in its own arm below).
  const dry = cli(WS_B, { ...DECOY, DEVLOOP_NODE: NODE }, "daemon", "install-autostart", "--workspace", WS_A, "--dry-run", "--format", "plist");
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
    // Defaulted, not asserted-into: when the probe fails, the arms below must REPORT a failure —
    // a TypeError here would abort the file and silently take AC4–AC7 with it (it did: CI's run
    // ended at this line, so five later ACs reported neither pass nor fail).
    const got = { workspace: null as string | null, keys: [] as string[], ...JSON.parse(line) };
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

    // `daemon status`'s binding line reads a LaunchAgent plist, so the product prints it on darwin
    // only — asserting it elsewhere would assert a claim the product does not make. Everything above
    // and below this arm is platform-independent and DOES run on CI.
    if (process.platform === "darwin") {
      const status = cli(WS_A, {}, "daemon", "status");
      ok(/daemon autostart/.test(`${status.stdout ?? ""}${status.stderr ?? ""}`), "AC4: `daemon status` prints the autostart binding line");
      ok((status.stdout ?? "").includes(WS_A), `AC4: \`daemon status\` names the bound workspace`);
    } else ok(true, "AC4: `daemon status` binding line is macOS-only (not asserted: not darwin)");

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
    const withPlist = cli(WS_A, { DEVLOOP_PROJECT: "alpha" }, "doctor");
    const lines = `${withPlist.stdout ?? ""}${withPlist.stderr ?? ""}`.split("\n").filter((l) => l.includes("daemon autostart"));
    ok(lines.length > 0, "AC7: doctor emits an autostart line");
    if (process.platform === "darwin") {
      ok(lines.some((l) => l.includes(WS_A)), `AC7: present plist → doctor reports the binding (${lines[0] ?? ""})`);
      ok(!lines.some((l) => /^\s*(⚠|WARN)/.test(l)), "AC7: a bound plist is not a warning");
    } else ok(true, "AC7: plist arm is macOS-only (skipped: not darwin)");

    rmSync(PLIST, { force: true });
    const noPlist = cli(WS_A, { DEVLOOP_PROJECT: "alpha" }, "doctor");
    const nl = `${noPlist.stdout ?? ""}${noPlist.stderr ?? ""}`.split("\n").filter((l) => l.includes("daemon autostart"));
    ok(nl.length > 0, "AC7: doctor still reports autostart when absent");
    ok(!nl.some((l) => /⚠|WARN/.test(l)), `AC7: ABSENT plist is NOT graded a warning (${nl[0] ?? ""})`);
  }

  // ── LOOP-533 AC6 (discharging LOOP-468 AC4) — the VERB still installs the login item ───────────
  // LOOP-468 removed the autostart spawn from `postinstall.cjs`; `dev-loop daemon install-autostart`
  // was supposed to remain the explicit way to get one. build-artifact.ts now asserts the negative
  // half on the filesystem (a package install spawns nothing and writes no plist). This is the
  // positive half, and it belongs here: without it the pair is satisfiable by a verb that installs
  // nothing at all. `hub/test/init-service.ts:88` is NOT this assertion — it only checks that
  // `init perform` PRINTS the guidance string.
  //
  // A real install writes into FAKE_HOME (line 30), never the runner's home. The write is macOS-only
  // by design, so the off-darwin arm asserts the refusal instead — which is what the CI matrix
  // actually executes, and it is stated rather than silently skipped.
  rmSync(PLIST, { force: true });
  if (process.platform === "darwin") {
    const realInstall = cli(WS_A, { DEVLOOP_NODE: NODE }, "daemon", "install-autostart", "--workspace", WS_A);
    ok(realInstall.status === 0, `LOOP-533 AC6: a real install-autostart exits 0 (got ${realInstall.status}: ${(realInstall.stderr ?? "").split("\n")[0]})`);
    ok(existsSync(PLIST), "LOOP-533 AC6: …and the login item EXISTS on disk — the verb postinstall no longer calls still installs one");
    ok(/RunAtLoad/.test(existsSync(PLIST) ? readFileSync(PLIST, "utf8") : ""), "LOOP-533 AC6: …and it is a login item (RunAtLoad), not an inert plist");
    rmSync(PLIST, { force: true });
  } else {
    // Same claim, the only way this platform can carry it: the verb renders the login item it would
    // write. AC2 above already pins the plist's CONTENT; this pins that the render is reachable and
    // that the real write is refused for the platform, not because the verb became a no-op.
    const dryHere = cli(WS_A, { DEVLOOP_NODE: NODE }, "daemon", "install-autostart", "--workspace", WS_A, "--dry-run");
    ok(dryHere.status === 0 && /RunAtLoad/.test(dryHere.stdout ?? ""),
      `LOOP-533 AC6 (non-darwin): install-autostart still RENDERS a RunAtLoad login item (got ${dryHere.status}); the real write is macOS-only and its refusal is asserted above`);
  }

  // ── AC6 — uninstall removes whatever install wrote, previous format included ───────────────────
  // Removing a LaunchAgent means unloading it from launchd; the verb refuses off darwin by design.
  if (process.platform === "darwin") {
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
  } else ok(true, "AC6: uninstall-autostart is macOS-only (not asserted: not darwin)");

  // ── The platform seam itself — the LaunchAgent form still refuses off darwin, and writes nothing ─
  // This is what the reordering must NOT have loosened: `--dry-run` renders everywhere, the actual
  // LaunchAgent is still macOS-only.
  if (process.platform !== "darwin") {
    rmSync(PLIST, { force: true });
    const real = cli(WS_B, {}, "daemon", "install-autostart", "--workspace", WS_A, "--format", "plist");
    ok(real.status !== 0, `AC5: a real LaunchAgent install off darwin still refuses (got ${real.status})`);
    ok(!existsSync(PLIST), "AC5: …and wrote no plist");
  } else ok(true, "AC5: the off-darwin refusal is asserted on non-darwin runners");

  // ── WS-B — Linux: `install-autostart` binds a systemd --user unit, symmetric uninstall ──────────
  // A FAKE `systemctl` first on PATH records its argv and succeeds; HOME is the fixture home, so the
  // unit lands under the fake ~/.config/systemd/user and the real user's systemd is never touched.
  if (process.platform === "linux") {
    const fakebin = join(RROOT, "fakebin"), sysLog = join(RROOT, "systemctl.log");
    mkdirSync(fakebin, { recursive: true });
    writeFileSync(join(fakebin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sysLog}"\nexit 0\n`, { mode: 0o755 });
    const linuxEnv = { PATH: `${fakebin}:${process.env.PATH ?? ""}`, DEVLOOP_NODE: NODE };
    const UNIT = join(FAKE_HOME, ".config", "systemd", "user", "dev-loop-daemon@wsa.service");

    // dry-run: the default artifact on Linux is the unit; nothing is written, no systemctl runs
    const ldry = cli(WS_B, { ...DECOY, ...linuxEnv }, "daemon", "install-autostart", "--workspace", WS_A, "--dry-run");
    ok(ldry.status === 0, `L1: --dry-run (Linux default = systemd) exits 0 (got ${ldry.status}: ${(ldry.stderr ?? "").split("\n")[0]})`);
    ok(!existsSync(UNIT) && !existsSync(sysLog), "L1: --dry-run wrote no unit and ran no systemctl");
    const unitDry = ldry.stdout ?? "";
    ok(unitDry.includes(`WorkingDirectory=${WS_A}`) && unitDry.includes(`Environment="DEVLOOP_WORKSPACE=${WS_A}"`), "L1: the rendered unit binds WorkingDirectory + DEVLOOP_WORKSPACE to the workspace");
    ok(/ExecStart=.* up-all$/m.test(unitDry) && /^Type=oneshot$/m.test(unitDry) && /^RemainAfterExit=yes$/m.test(unitDry) && /^WantedBy=default\.target$/m.test(unitDry), "L1: unit runs `<node> <entry> up-all` as a oneshot user unit");
    for (const k of WORKSPACE_SELECTING) ok(!unitDry.includes(k) && !unitDry.includes(DECOY[k as keyof typeof DECOY]), `L1: unit carries no ${k} (name or decoy value)`);

    // real install: unit written under the fake HOME, systemctl --user daemon-reload + enable --now
    const inst = cli(WS_B, { ...DECOY, ...linuxEnv }, "daemon", "install-autostart", "--workspace", WS_A);
    ok(inst.status === 0, `L2: install-autostart on Linux exits 0 (got ${inst.status}: ${(inst.stderr ?? "").split("\n")[0]})`);
    ok(existsSync(UNIT), `L2: unit written at ${UNIT}`);
    const unitTxt = existsSync(UNIT) ? readFileSync(UNIT, "utf8") : "";
    ok(unitTxt.includes(`Environment="DEVLOOP_WORKSPACE=${WS_A}"`) && !WORKSPACE_SELECTING.some((k) => unitTxt.includes(k)), "L2: the written unit binds the workspace and carries no ambient decoy");
    const calls = existsSync(sysLog) ? readFileSync(sysLog, "utf8").trim().split("\n") : [];
    ok(calls.includes("--user daemon-reload") && calls.includes("--user enable --now dev-loop-daemon@wsa.service"), `L2: systemctl --user daemon-reload + enable --now <unit> (got: ${calls.join(" | ")})`);
    ok(/loginctl enable-linger/.test(inst.stdout ?? ""), "L2: the linger hint is printed");
    ok(!existsSync(PLIST), "L2: no plist was written on Linux");

    // the binding is readable: the reader, the listing, and `daemon status`
    const lb = readSystemdBinding(UNIT);
    ok(lb.installed && lb.workspace === WS_A && lb.kind === "systemd", `L3: readSystemdBinding reports the bound workspace (got ${lb.workspace})`);
    const all = listSystemdBindings(join(FAKE_HOME, ".config", "systemd", "user"));
    ok(all.length === 1 && all[0].workspace === WS_A, "L3: listSystemdBindings finds exactly the one unit");
    const st = cli(WS_A, linuxEnv, "daemon", "status");
    ok(/daemon autostart — installed, bound to workspace/.test(st.stdout ?? "") && (st.stdout ?? "").includes(WS_A), "L3: `daemon status` prints the systemd binding line naming the workspace");

    // uninstall: symmetric — disable --now, unlink, daemon-reload; an unresolvable target refuses
    const none = cli(NOWHERE, { ...linuxEnv, DEVLOOP_WORKSPACE: "" }, "daemon", "uninstall-autostart");
    ok(none.status !== 0 && existsSync(UNIT), `L4: uninstall with no resolvable workspace refuses and removes nothing (got ${none.status})`);
    const un = cli(NOWHERE, linuxEnv, "daemon", "uninstall-autostart", "--workspace", WS_A);
    ok(un.status === 0, `L4: uninstall-autostart --workspace exits 0 (got ${un.status}: ${(un.stderr ?? "").split("\n")[0]})`);
    ok(!existsSync(UNIT), "L4: the unit is gone");
    const calls2 = readFileSync(sysLog, "utf8").trim().split("\n");
    ok(calls2.includes("--user disable --now dev-loop-daemon@wsa.service") && calls2.filter((c) => c === "--user daemon-reload").length >= 2, `L4: systemctl --user disable --now <unit> + daemon-reload (got: ${calls2.join(" | ")})`);
    const again = cli(NOWHERE, linuxEnv, "daemon", "uninstall-autostart", "--all");
    ok(again.status === 0 && /nothing to remove/.test(again.stdout ?? ""), "L4: a second uninstall (--all) is a clean no-op");
  } else ok(true, "WS-B Linux systemd arm: not asserted (not linux)");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nautostart-binding: ALL PASS" : `\nautostart-binding: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
