#!/usr/bin/env node
// `node hub/src/release.ts <semver>` — one-shot release helper (P2-13). SOURCE-TREE ONLY, like
// release-version.ts: it stamps .claude-plugin/* (absent from the npm package) and syncs the
// hub/ payload copy, so it is NOT routed through the published `dev-loop` CLI. Runs, in order:
//   1. release-version <semver>            — stamp the 3 lockstep manifests (version-sync invariant)
//   2. sync hub payload                    — rm -rf hub/{skills,references} && cp -R ../{skills,references}
//                                            (what `dev-loop run` reads; consistency.ts asserts byte-identity)
//   3. version-sync + consistency + docs   — the three fast guards
//   4. print the /plugin reinstall hint    — the version-keyed plugin cache needs a reinstall
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, cpSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src
const hub = join(here, "..");                          // hub/
const repo = join(hub, "..");                          // repo root
const node = process.execPath;

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: node hub/src/release.ts <semver>   (e.g. 0.28.0)\n  got: ${version ?? "(none)"}`);
  process.exit(2);
}

const step = (label: string, cmd: string, args: string[], cwd: string): void => {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.status !== 0) { console.error(`✗ ${label} FAILED — release aborted`); process.exit(r.status ?? 1); }
};

// 1. stamp the version across the 3 lockstep manifests.
step(`stamp version ${version}`, node, [join(here, "release-version.ts"), version], repo);

// 2. re-generate the packaged payload copy (hub/skills + hub/references) from the source of truth.
console.log("\n▶ sync hub payload (skills + references)");
for (const d of ["skills", "references"]) {
  rmSync(join(hub, d), { recursive: true, force: true });
  cpSync(join(repo, d), join(hub, d), { recursive: true });
  console.log(`  synced hub/${d}`);
}

// 3. the three fast guards (fail closed — a red guard aborts the release).
for (const t of ["version-sync", "consistency", "docs"]) {
  step(`test/${t}`, node, [join(hub, "test", `${t}.ts`)], hub);
}

console.log(`\n✅ released ${version}. Commit + push the branch, then reinstall to pick it up:
   /plugin uninstall dev-loop@dev-loop && /plugin install dev-loop@dev-loop && /reload-plugins`);
