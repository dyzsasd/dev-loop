#!/usr/bin/env node
// `dev-loop release-version <semver>` — the SINGLE-VERSION stamp (P4, design daemon-multicli §6).
// Writes ONE version into the three manifests that MUST ship in lockstep, so a release can never drift
// (the marketplace-cache class of bug: a bumped plugin.json with a stale marketplace.json serves the old
// cached SKILLs): hub/package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json
// (plugins[0].version). Surgical single-line text replace per file ⇒ a 1-line diff, formatting preserved.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // hub/src → repo root
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: dev-loop release-version <semver>   (e.g. 0.21.0)\n  got: ${version ?? "(none)"}`);
  process.exit(2);
}

const files: Array<{ rel: string; cur: (j: any) => string }> = [
  { rel: "hub/package.json",                cur: (j) => j.version },
  { rel: ".claude-plugin/plugin.json",      cur: (j) => j.version },
  { rel: ".claude-plugin/marketplace.json", cur: (j) => j.plugins[0].version },
];

let changed = 0;
for (const f of files) {
  const path = join(repoRoot, f.rel);
  const txt = readFileSync(path, "utf8");
  const cur = f.cur(JSON.parse(txt)); // validate it parses + locate the current value
  if (cur === version) { console.log(`= ${f.rel}: already ${version}`); continue; }
  const needle = `"version": "${cur}"`; // the only version field in each file (plugins[0] in marketplace)
  if (!txt.includes(needle)) { console.error(`✗ ${f.rel}: could not find ${needle} to replace`); process.exit(1); }
  writeFileSync(path, txt.replace(needle, `"version": "${version}"`));
  console.log(`✓ ${f.rel}: ${cur} → ${version}`);
  changed++;
}
console.log(`\nstamped ${version} into ${changed} manifest(s) (lockstep — package.json + plugin.json + marketplace.json).`);
