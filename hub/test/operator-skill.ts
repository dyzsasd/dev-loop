// WS-B — dev-loop-operator/ is the first-class, harness-neutral distributable (pure markdown + pure
// shell). This suite keeps it honest without a network or a real install:
//   • SKILL.md parses (frontmatter name/description) and stays within its size budget;
//   • every `dev-loop <verb>` the handbook mentions exists in cli.ts ROUTES — or is on the explicit
//     allow-list of verbs landing on sibling branches (`status`, `system`), so a merge can verify;
//     `daemon <sub>` / `hub <sub>` / `team <sub>` are checked one level deeper;
//   • scripts/ensure-install.sh passes `bash -n`, refuses an old node with the version message, and
//     under a FAKE PATH (fake node/npm/claude, a fake tarball as DEVLOOP_INSTALL_SOURCE) walks tier 1
//     → PATH hint → the labelled integrity skip → doctor → the ready line, then re-runs as a no-op;
//   • the shipped systemd/launchd templates are the shape the product's own binding readers parse.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIFECYCLE_SUBS, readAutostartBinding, readSystemdBinding } from "../src/daemon-lifecycle.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(hubRoot, "..");
const opDir = join(repoRoot, "dev-loop-operator");
const SKILL = join(opDir, "SKILL.md");
const SCRIPT = join(opDir, "scripts", "ensure-install.sh");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// Verbs referenced by the handbook that are being added on sibling branches of this workstream.
// Each entry is a claim to verify after merge: remove it once the verb is in cli.ts ROUTES.
const LANDING_ELSEWHERE = new Set<string>(); // status + system landed with WS-C; keep the seam for future sibling branches
const HUB_SUBS = new Set(["start", "stop", "status", "ensure"]);
const TEAM_SUBS = new Set(["init", "import", "repair", "set", "add-project", "add-repo", "add-provider", "sync-opencode"]);

// ── SKILL.md: frontmatter + budget ───────────────────────────────────────────────────────────────
const skill = readFileSync(SKILL, "utf8");
const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill);
ok(!!fm, "SKILL.md opens with a YAML frontmatter block");
ok(!!fm && /^name:\s*dev-loop-operator\s*$/m.test(fm[1]), "frontmatter: name is dev-loop-operator");
ok(!!fm && /^description:\s*>?-?\s*$/m.test(fm[1]) || !!fm && /^description:\s*\S/m.test(fm[1]), "frontmatter: description present");
ok(Buffer.byteLength(skill) <= 9.5 * 1024, `SKILL.md within its ~9KB budget (${Buffer.byteLength(skill)} bytes)`);
for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) ok(new RegExp(`^## §${n} `, "m").test(skill), `SKILL.md has section §${n}`);
ok(/harness-neutral/i.test(skill) && /Claude Code/.test(skill) && /Codex/.test(skill) && /opencode/.test(skill), "SKILL.md states it is harness-neutral and names Claude Code, Codex, opencode, plain shell");
ok(/ensure-install\.sh/.test(skill) && /pause --drain/.test(skill) && /W36/.test(skill) && /system propose/.test(skill), "SKILL.md covers install script, drain discipline, build skew, system proposals");

// ── every `dev-loop <verb>` in code spans/fences resolves ────────────────────────────────────────
const cliSrc = readFileSync(join(hubRoot, "src", "cli.ts"), "utf8");
const routesBlock = cliSrc.slice(cliSrc.indexOf("const ROUTES"), cliSrc.indexOf("};", cliSrc.indexOf("const ROUTES")));
const routes = new Set([...routesBlock.matchAll(/^\s*"?([a-z][a-z-]*)"?\s*:\s*\[/gm)].map((m) => m[1]));
routes.add("version"); routes.add("help");
ok(routes.size > 40 && routes.has("daemon") && routes.has("hub"), `parsed cli.ts ROUTES (${routes.size} verbs)`);
// Fenced blocks + inline spans, each scanned on its own (joining them would let `\s+` bridge two spans).
const spans = [...skill.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).concat([...skill.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
const mentions = spans.flatMap((c) => [...c.matchAll(/dev-loop\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)]);
ok(mentions.length >= 25, `SKILL.md mentions dev-loop verbs in code (${mentions.length} mentions)`);
const unknown = new Set<string>(), landing = new Set<string>();
for (const [, verb, sub] of mentions) {
  if (LANDING_ELSEWHERE.has(verb)) { landing.add(verb); continue; }
  if (!routes.has(verb)) { unknown.add(verb); continue; }
  if (verb === "daemon" && sub && !(LIFECYCLE_SUBS as readonly string[]).includes(sub)) unknown.add(`daemon ${sub}`);
  if (verb === "hub" && sub && !HUB_SUBS.has(sub)) unknown.add(`hub ${sub}`);
  if (verb === "team" && sub && !TEAM_SUBS.has(sub)) unknown.add(`team ${sub}`);
}
ok(unknown.size === 0, `every dev-loop verb the handbook mentions exists in cli.ts ROUTES${unknown.size ? ` (unknown: ${[...unknown].join(", ")})` : ""}`);
console.log(`   verbs referenced but landing on sibling branches: ${[...landing].join(", ") || "(none)"}`);

// ── templates are readable by the product's own binding readers ─────────────────────────────────
{
  const plist = readAutostartBinding(join(opDir, "templates", "launchd", "com.dyzsasd.dev-loop.daemon.plist"));
  ok(plist.installed && plist.workspace === "WORKSPACE_ROOT", "launchd template: readAutostartBinding sees the WORKSPACE_ROOT placeholder as the binding");
  for (const f of ["dev-loop-daemon@.service", "dev-loop-scheduler@.service"]) {
    const p = join(opDir, "templates", "systemd", f);
    const txt = readFileSync(p, "utf8");
    ok(/^\[Install\]$/m.test(txt) && /^WantedBy=default\.target$/m.test(txt) && /^ExecStart=.*dev-loop /m.test(txt), `systemd template ${f}: user unit with an ExecStart running dev-loop`);
    const b = readSystemdBinding(p);
    ok(b.installed && b.workspace === "%h/work/my-team", `systemd template ${f}: readSystemdBinding reads the WorkingDirectory/DEVLOOP_WORKSPACE placeholder`);
    for (const k of ["DEVLOOP_HOME", "DEVLOOP_PROJECTS_JSON", "DEVLOOP_HUB_DB", "DEVLOOP_RUN_DIR"]) ok(!txt.includes(k), `systemd template ${f}: carries no ${k}`);
  }
}

// ── ensure-install.sh ───────────────────────────────────────────────────────────────────────────
ok(spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" }).status === 0, "ensure-install.sh passes bash -n");
ok(/^set -euo pipefail$/m.test(readFileSync(SCRIPT, "utf8")), "ensure-install.sh sets -euo pipefail");
// Executed npm invocations only: comment lines dropped, double-quoted strings (messages/hints) blanked.
const execLines = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).map((l) => l.replace(/"[^"]*"/g, '""'));
const bareNpm = execLines.filter((l) => /\bnpm (install|i|ci)\b/.test(l) && [...l.matchAll(/\bnpm (install|i|ci)\b[^&|;)]*/g)].some((m) => !m[0].includes("--ignore-scripts")));
ok(bareNpm.length === 0, `every executed npm install/ci in ensure-install.sh passes --ignore-scripts${bareNpm.length ? ` (bare: ${bareNpm.map((l) => l.trim()).join(" || ")})` : ""}`);

const tmp = realpathSync(tmpRoot("dl-operator-"));
try {
  const fakebin = join(tmp, "fakebin"), prefix = join(tmp, "npm-global"), home = join(tmp, "home"), log = join(tmp, "npm-argv.log");
  mkdirSync(fakebin, { recursive: true }); mkdirSync(home, { recursive: true });
  const sh = (name: string, body: string) => { const p = join(fakebin, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
  const setNode = (v: string) => sh("node", `[ "$1" = "-v" ] && { echo "${v}"; exit 0; }\necho "fake node: $*" >&2; exit 1`);
  sh("claude", `echo "claude 9.9.9 (fake)"`);
  // The fake npm: records every argv, "installs" a dev-loop stub into the fake global prefix, reports it.
  sh("npm", `printf '%s\\n' "$*" >> "${log}"
case "$1" in
  prefix) echo "${prefix}";;
  install|i)
    mkdir -p "${prefix}/bin"
    printf '#!/bin/sh\\ncase "$1" in version) echo 9.9.9;; doctor) echo "fake doctor"; echo DOCTOR_OK;; *) echo "fake dev-loop $*";; esac\\n' > "${prefix}/bin/dev-loop"
    chmod +x "${prefix}/bin/dev-loop";;
  *) echo "fake npm: unexpected $*" >&2; exit 1;;
esac`);
  const tarball = join(tmp, "dyzsasd-dev-loop-9.9.9.tgz");
  writeFileSync(tarball, "not really a tarball\n");
  // A minimal PATH: the fakes first, then the system dirs the script's coreutils live in. The real
  // `dev-loop` (if this machine has one) must not be reachable, or the "install" arm is vacuous.
  const basePath = `${fakebin}:/usr/bin:/bin`;
  ok(!existsSync("/usr/bin/dev-loop") && !existsSync("/bin/dev-loop"), "precondition: no dev-loop in /usr/bin or /bin (the fake PATH is hermetic)");
  const run = (env: Record<string, string>) => spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 60_000, env: { PATH: basePath, HOME: home, ...env } });

  // (a) old node → refuses with the version floor in the message
  setNode("v22.0.0");
  const old = run({});
  ok(old.status !== 0, `old node (22.0.0) → non-zero exit (got ${old.status})`);
  ok(/node 22\.0\.0 is too old/.test(old.stderr) && /23\.6/.test(old.stderr) && /DEVLOOP_NODE/.test(old.stderr), "old node → message names the version, the 23.6 floor and DEVLOOP_NODE");
  ok(!existsSync(log), "old node → no npm was invoked");

  // (b) node OK, no coding CLI → refuses with hints; DEVLOOP_REQUIRE_CLI=0 downgrades to a warning
  setNode("v24.5.0");
  const noCliPath = join(tmp, "nocli"); mkdirSync(noCliPath, { recursive: true });
  for (const f of ["node", "npm"]) { writeFileSync(join(noCliPath, f), readFileSync(join(fakebin, f))); chmodSync(join(noCliPath, f), 0o755); }
  const noCli = spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 60_000, env: { PATH: `${noCliPath}:/usr/bin:/bin`, HOME: home } });
  ok(noCli.status !== 0 && /claude \| codex \| opencode/.test(noCli.stderr), `no coding CLI → refuses and names claude | codex | opencode (got ${noCli.status})`);
  ok(!existsSync(log), "no coding CLI → refused before any npm call");

  // (c) tier 1: DEVLOOP_INSTALL_SOURCE=<tarball> → fake npm installs → PATH hint → integrity skip → doctor → ready
  const first = run({ DEVLOOP_INSTALL_SOURCE: tarball });
  const out1 = `${first.stdout}${first.stderr}`;
  ok(first.status === 0, `tarball install run → exit 0 (got ${first.status})\n${first.status === 0 ? "" : out1}`);
  ok(/tier 1: DEVLOOP_INSTALL_SOURCE=/.test(out1), "tier 1 announced");
  const argv = existsSync(log) ? readFileSync(log, "utf8") : "";
  ok(argv.includes(`install -g ${tarball} --ignore-scripts`), `fake npm received \`install -g <tarball> --ignore-scripts\` (argv log: ${argv.trim().split("\n").join(" | ")})`);
  ok(/NOT on PATH/.test(out1) && out1.includes(`export PATH="${prefix}/bin:$PATH"`), "npm global bin not on PATH → the exact export line is printed");
  ok(/source integrity check skipped: no source tree/.test(out1), "no source tree → the integrity check is a clearly labelled skip");
  ok(/DOCTOR_OK/.test(out1) && /doctor: DOCTOR_OK/.test(out1), "reaches `dev-loop doctor` and reads its DOCTOR_OK marker");
  ok(/环境就绪 ✔ \/ ready/.test(out1), "ends with the 环境就绪 ✔ / ready line");
  ok(/claude 9\.9\.9/.test(out1) && /login is interactive/.test(out1), "coding CLI detected + the login hint printed");

  // (d) idempotent re-run: dev-loop now on PATH → no install, no npm install call, still ready
  const before = readFileSync(log, "utf8");
  const again = spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 60_000, env: { PATH: `${prefix}/bin:${basePath}`, HOME: home, DEVLOOP_INSTALL_SOURCE: tarball } });
  const out2 = `${again.stdout}${again.stderr}`;
  ok(again.status === 0 && /already installed/.test(out2) && /环境就绪 ✔ \/ ready/.test(out2), `re-run is a no-op that still ends ready (got ${again.status})`);
  ok(readFileSync(log, "utf8") === before, "re-run made no npm install call");

  // (e) a version pin that differs from the installed one → reinstall through the registry tier
  const pinned = spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 60_000, env: { PATH: `${prefix}/bin:${basePath}`, HOME: home, DEVLOOP_VERSION: "1.2.3" } });
  ok(pinned.status === 0 && /pin is 1\.2\.3/.test(`${pinned.stdout}${pinned.stderr}`), `a differing DEVLOOP_VERSION pin triggers a reinstall (got ${pinned.status})`);
  ok(readFileSync(log, "utf8").includes("install -g @dyzsasd/dev-loop@1.2.3 --ignore-scripts"), "tier 2 installs `@dyzsasd/dev-loop@<pin> --ignore-scripts`");
  // ── B4: the SessionStart hook is opt-in — env flag OR team.sessionStartHook in dev-loop.json ──
  // Source-mode run (dist is covered by build-artifact.ts). A workspace with no projects makes
  // `daemon up` a clean no-op, so the observable is only whether the hook ACTED (hook.log line).
  const hook = join(hubRoot, "src", "hook-session-start.ts");
  const runHook = (ws: string, env: Record<string, string>) => spawnSync(process.execPath, [hook], { cwd: ws, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", HOME: home, DEVLOOP_RUN_DIR: join(ws, ".dev-loop"), ...env } });
  const wsOff = join(tmp, "ws-off"), wsOn = join(tmp, "ws-on");
  for (const [ws, flag] of [[wsOff, false], [wsOn, true]] as const) {
    mkdirSync(join(ws, ".dev-loop"), { recursive: true });
    writeFileSync(join(ws, "dev-loop.json"), JSON.stringify({ schemaVersion: 2, team: { key: "t", backend: "service", ...(flag ? { sessionStartHook: true } : {}) }, projects: {}, repos: {} }));
  }
  const off = runHook(wsOff, {});
  ok(off.status === 0 && !existsSync(join(wsOff, ".dev-loop", "hook.log")), "hook: no flag, no config key → exit 0 and NO hook.log line (it did nothing)");
  const viaEnv = runHook(wsOff, { DEVLOOP_SESSION_HOOK: "1" });
  ok(viaEnv.status === 0 && existsSync(join(wsOff, ".dev-loop", "hook.log")) && /session-start .*daemon up → exit/.test(readFileSync(join(wsOff, ".dev-loop", "hook.log"), "utf8")), "hook: DEVLOOP_SESSION_HOOK=1 → acts and logs one line to <runDir>/hook.log");
  const viaCfg = runHook(wsOn, {});
  ok(viaCfg.status === 0 && existsSync(join(wsOn, ".dev-loop", "hook.log")), "hook: team.sessionStartHook: true in dev-loop.json → acts (read leniently, no validator involved)");
  ok(readFileSync(join(wsOn, ".dev-loop", "hook.log"), "utf8").trim().split("\n").length === 1, "hook: exactly one log line per session start");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nOPERATOR_SKILL_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
