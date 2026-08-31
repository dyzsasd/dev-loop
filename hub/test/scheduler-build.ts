// LOOP-253 — the third upgrade axis: which build is orchestrating the loop?
//
// The installed package is checked, a running daemon is checked (W28), and the long-lived
// `run-agents` scheduler was not. Node caches every module at import time and never reloads, so a
// reinstall mid-run leaves the orchestrator executing boot-time code while `doctor` — a fresh
// process each invocation — reports the new build. Measured: LOOP-144/220/175/223 were live for
// doctor and inert in the loop, with DOCTOR_OK printing.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import {
  writeSchedulerBuild, readSchedulerBuild, schedulerBuildPath, schedulerAlive,
  schedulerSkew, pkgVersionOf, teamDirOf, type SchedulerBuild,
} from "../src/scheduler-build.ts";
import { checkSchedulerBuild } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-schedbuild-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  // ── the record ────────────────────────────────────────────────────────────────────────────────
  {
    const dir = join(tmp, "team");
    ok(readSchedulerBuild(dir) === null, "LOOP-253: no record yet ⇒ null, not a throw");
    const rec = writeSchedulerBuild(dir, new Date(Date.UTC(2026, 7, 5, 12, 0, 0)));
    ok(rec !== null && rec.pid === process.pid, "LOOP-253: the boot record carries this process's pid");
    ok(!!rec && typeof rec.version === "string" && rec.version !== "", `LOOP-253: …and the version it LOADED (${rec?.version})`);
    ok(!!rec && rec.modulePath.endsWith("hub"), `LOOP-253: …and the resolved module path, because two installs can share a version (${rec?.modulePath})`);
    const back = readSchedulerBuild(dir);
    ok(back?.pid === process.pid && back?.version === rec?.version, "LOOP-253: it round-trips through the file");
    ok(JSON.parse(readFileSync(schedulerBuildPath(dir), "utf8")).startedAt === "2026-08-05T12:00:00.000Z",
      "LOOP-253: startedAt is recorded, so the reader can tell how long the stale build has been orchestrating");

    // It is its OWN file — scheduler.json is typed Record<agent, CursorMap> and every consumer
    // indexes it by agent handle. A process-identity key there would make that type a lie.
    ok(schedulerBuildPath(dir).endsWith("scheduler-build.json"),
      "LOOP-253: recorded beside scheduler.json, not inside it — the cursor map's type stays honest");

    // Corrupt records must not wedge doctor.
    writeFileSync(schedulerBuildPath(dir), "{ not json");
    ok(readSchedulerBuild(dir) === null, "LOOP-253: a corrupt record reads as absent, never a throw");
    writeFileSync(schedulerBuildPath(dir), JSON.stringify({ version: 1, pid: "x" }));
    ok(readSchedulerBuild(dir) === null, "LOOP-253: …as does a well-formed JSON of the wrong shape");
  }

  // ── the skew, direction-aware (LOOP-252's AC) ────────────────────────────────────────────────
  {
    const mk = (version: string): SchedulerBuild => ({ version, modulePath: "/x", pid: process.pid, startedAt: "t" });
    ok(schedulerSkew(mk("1.13.0"), "1.13.0") === null, "LOOP-253: same build ⇒ no finding");
    ok(schedulerSkew(null, "1.13.0") === null, "LOOP-253: no scheduler recorded ⇒ no finding");
    const older = schedulerSkew(mk("1.12.0"), "1.13.0");
    ok(older?.direction === "older", `LOOP-253: a scheduler behind the installed CLI reports 'older' (${older?.direction})`);
    const newer = schedulerSkew(mk("1.14.0"), "1.13.0");
    ok(newer?.direction === "newer",
      `LOOP-253: a scheduler AHEAD reports 'newer' — someone downgraded, or it was launched from a checkout; calling that "old code" sends the reader to the wrong remedy (${newer?.direction})`);
    ok(schedulerSkew(mk("1.9.0"), "1.10.0")?.direction === "older",
      "LOOP-253: the comparison is numeric per segment, not lexical — 1.9.0 is OLDER than 1.10.0");
    ok(schedulerSkew(mk("1.13.0-rc.1"), "1.13.0")?.direction !== undefined,
      "LOOP-253: a prerelease shape still produces a finding — a different build is a different build");
    ok(schedulerSkew(mk("weird"), "1.13.0")?.direction === "older",
      "LOOP-253: an incomparable version falls back to 'older', whose remedy (restart) is right either way");
  }

  // ── liveness: a stale record is not a finding ────────────────────────────────────────────────
  {
    ok(schedulerAlive({ version: "x", modulePath: "/x", pid: process.pid, startedAt: "t" }),
      "LOOP-253: this very process reads as alive");
    // A pid that cannot exist. kill(pid, 0) sends NO signal — the AC forbids signalling the
    // scheduler, and a zero-signal existence probe does not signal it.
    ok(!schedulerAlive({ version: "x", modulePath: "/x", pid: 2_147_480_000, startedAt: "t" }),
      "LOOP-253: a dead pid reads as not-alive, so a record left by a finished run is not reported");
  }

  // ── W36 through doctor ───────────────────────────────────────────────────────────────────────
  {
    const wsRoot = join(tmp, "ws");
    mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
    mkdirSync(join(wsRoot, "repo"), { recursive: true });
    writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, team: { key: "sb-test", backend: "service" },
      repos: { repo: { path: "repo" } }, projects: {},
    }));
    const teamDir = teamDirOf(join(wsRoot, ".dev-loop"));
    const w36 = (): string => {
      const lines: string[] = [];
      checkSchedulerBuild(loadWorkspace(wsRoot), (m) => lines.push(m));
      return lines.join("\n");
    };

    ok(!w36().includes("[W36]"), "LOOP-253: no scheduler ever recorded ⇒ doctor is silent");

    // A LIVE process running the SAME build as installed: silent.
    writeSchedulerBuild(teamDir);
    ok(!w36().includes("[W36]"), "LOOP-253: a live scheduler on the installed build ⇒ silent");

    // A LIVE process (this one) recorded against a different version: the finding.
    const live = readSchedulerBuild(teamDir)!;
    writeFileSync(schedulerBuildPath(teamDir), JSON.stringify({ ...live, version: "0.0.1-ancient" }));
    const warned = w36();
    ok(warned.includes("[W36]"), "LOOP-253: a live scheduler on a different build raises W36");
    ok(/0\.0\.1-ancient/.test(warned) && new RegExp(pkgVersionOf().replace(/\./g, "\\.")).test(warned),
      `LOOP-253: …naming BOTH versions (${warned.slice(0, 150)})`);
    ok(/older/.test(warned), "LOOP-253: …and the direction");
    ok(/dev-loop run/.test(warned), "LOOP-253: …and the restart command that clears it");

    // A DEAD pid on a different build: silent. A record outliving its process is not a finding —
    // reporting it would make W36 permanent after the first run that ever exits.
    writeFileSync(schedulerBuildPath(teamDir), JSON.stringify({ ...live, version: "0.0.1-ancient", pid: 2_147_480_000 }));
    ok(!w36().includes("[W36]"), "LOOP-253: a record whose process is gone ⇒ silent, not a permanent warning");

    // Restarting on the installed build clears it — the ticket's step 4.
    writeSchedulerBuild(teamDir);
    ok(!w36().includes("[W36]"), "LOOP-253: restarting on the installed build clears the warning");
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nSCHEDULER_BUILD_OK");
process.exit(fails ? 1 : 0);
