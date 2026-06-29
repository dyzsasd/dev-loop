#!/usr/bin/env node
"use strict";

const { existsSync } = require("node:fs");
const { delimiter, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const MIN_NODE = "23.6.0";

function nodeVersionOk(v) {
  const [maj = 0, min = 0, patch = 0] = String(v || "").split(".").map((x) => Number(x));
  return maj > 23 || (maj === 23 && (min > 6 || (min === 6 && patch >= 0)));
}

function probeNode(bin) {
  if (!bin) return null;
  const r = spawnSync(bin, ["-p", "process.versions.node"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const version = (r.stdout || "").trim();
  return r.status === 0 && nodeVersionOk(version) ? bin : null;
}

function pathCandidates(names) {
  const out = [];
  for (const dir of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function findCompatibleNode() {
  const candidates = [
    process.env.DEVLOOP_NODE,
    process.execPath,
    ...pathCandidates(["node", "node24", "node23"]),
    "/opt/homebrew/opt/node@24/bin/node",
    "/opt/homebrew/opt/node@23/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/opt/node@24/bin/node",
    "/usr/local/opt/node@23/bin/node",
    "/usr/local/bin/node",
  ].filter(Boolean);
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const ok = probeNode(c);
    if (ok) return ok;
  }
  return null;
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || "");
}

const skip = envFlag("DEVLOOP_SKIP_AUTOSTART") || envFlag("DEVLOOP_NO_AUTOSTART");
const force = envFlag("DEVLOOP_POSTINSTALL_FORCE") || envFlag("DEVLOOP_INSTALL_AUTOSTART");
const globalInstall = process.env.npm_config_global === "true" || process.env.npm_config_location === "global";
const dryRun = envFlag("DEVLOOP_POSTINSTALL_DRY_RUN");

if (skip || (!force && !globalInstall)) process.exit(0);

if (process.platform !== "darwin" && !envFlag("DEVLOOP_POSTINSTALL_TEST_DARWIN")) {
  console.log("[dev-loop] autostart skipped: automatic login item installation is macOS-only. Run `dev-loop daemon up-all` from your OS process manager.");
  process.exit(0);
}

const node = findCompatibleNode();
if (!node) {
  console.log(`[dev-loop] autostart skipped: dev-loop daemon needs Node >= ${MIN_NODE}. Set DEVLOOP_NODE=/absolute/path/to/node and run \`dev-loop daemon install-autostart\`.`);
  process.exit(0);
}

const daemonEntry = join(__dirname, "dist", "daemon.js");
if (!existsSync(daemonEntry)) {
  console.log(`[dev-loop] autostart skipped: packaged daemon entry is missing at ${daemonEntry}.`);
  process.exit(0);
}

if (dryRun) {
  console.log(`[dev-loop] postinstall would run: ${node} ${daemonEntry} install-autostart`);
  process.exit(0);
}

const r = spawnSync(node, [daemonEntry, "install-autostart"], {
  stdio: "inherit",
  env: { ...process.env, DEVLOOP_NODE: node },
});

// Never fail npm install because a host disallows LaunchAgent writes/bootstrap.
if ((r.status || 0) !== 0) {
  console.log("[dev-loop] autostart was not installed automatically. You can retry with `dev-loop daemon install-autostart`.");
}
process.exit(0);
