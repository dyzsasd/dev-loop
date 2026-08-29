// workspace-index-isolation.ts — the workspace index never records what cannot outlive the machine.
//
// The index maps `DEVLOOP_TEAM=<key>` to a workspace root, so it is the one dev-loop file that
// cannot live inside a workspace. It is written on EVERY workspace resolution (resolveWorkspace →
// upsertWorkspaceIndex), which is how a real machine's index came to hold entries for a dozen
// `/var/folders/.../dl-*` paths that had not existed for weeks: every suite that resolved a fixture
// workspace without relocating the index wrote itself into the developer's home.
//
// The rule asserted here: the MACHINE-DEFAULT index records durable roots only, and an index the
// caller explicitly relocated (DEVLOOP_HOME) records everything — including the temp roots the
// suites need, because that file dies with the fixture that owns it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspaceIndex, upsertWorkspaceIndex, workspacesIndexPath } from "../src/workspace.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-wsidx-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ENV_KEYS = ["DEVLOOP_HOME", "XDG_CONFIG_HOME", "DEVLOOP_WORKSPACE", "DEVLOOP_TEAM", "DEVLOOP_HUB_DB", "DEVLOOP_DATA_DIR"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/** A byte-level fingerprint of a file that may not exist — "absent" is a state, not an error. */
const snapshot = (p: string): string => { try { return `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`; } catch { return "(absent)"; } };

try {
  // ── The real machine index is untouched by a fixture `team init` ────────────────────────────────
  // Deliberately run WITHOUT DEVLOOP_HOME: that is the shape every un-isolated suite has, and the
  // one that filled the real index. The assertion is on the operator's actual file.
  {
    for (const k of ENV_KEYS) delete process.env[k];
    const realIndex = workspacesIndexPath();
    const before = snapshot(realIndex);
    const ws = join(tmp, "fixture-ws");
    mkdirSync(ws, { recursive: true });
    const env = { ...scrubFireEnv(), DEVLOOP_HOME: undefined, DEVLOOP_TEAM: undefined } as NodeJS.ProcessEnv;
    const r = spawnSync(process.execPath, [join(hubRoot, "src", "team.ts"), "init", "--dir", ws, "--key", "wsidx", "--backend", "service", "--yes"],
      { cwd: tmp, env, encoding: "utf8" });
    ok(r.status === 0, `fixture: team init exits 0 (${r.status}) ${(r.stderr ?? "").slice(0, 200)}`);
    ok(existsSync(join(ws, "dev-loop.json")), "fixture: the workspace really was created");
    ok(snapshot(realIndex) === before,
      `a fixture team init leaves the machine index byte-identical (${realIndex})`);
    ok(!Object.hasOwn(readWorkspaceIndex(), "wsidx"),
      "…so the ephemeral team key is not resolvable through it, which is the honest answer for a path the OS will reclaim");
  }

  // ── DEVLOOP_HOME is the isolation seam: that index records everything ──────────────────────────
  {
    const home = join(tmp, "home");
    process.env.DEVLOOP_HOME = home;
    const ws2 = join(tmp, "isolated-ws");
    mkdirSync(ws2, { recursive: true });
    writeFileSync(join(ws2, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, team: { key: "wsidx2", backend: "service" }, repos: {}, projects: {},
    }));
    upsertWorkspaceIndex("wsidx2", ws2);
    ok(workspacesIndexPath() === join(home, "workspaces.json"), "DEVLOOP_HOME relocates the index file");
    ok(readWorkspaceIndex().wsidx2 === ws2,
      `…and a temp-rooted workspace IS recorded there — the fixture owns that file (${JSON.stringify(readWorkspaceIndex())})`);
    delete process.env.DEVLOOP_HOME;
  }

  // ── The skip is about the ROOT, not about the index location ───────────────────────────────────
  // XDG_CONFIG_HOME moves the machine default (it is still nobody's private file), so the durable
  // root is recorded and the ephemeral one is not — asserted on the same index, in the same process.
  {
    const xdg = join(tmp, "xdg");
    process.env.XDG_CONFIG_HOME = xdg;
    const durable = "/opt/dev-loop-workspaces/team-a"; // a path outside the OS temp dir; never created
    upsertWorkspaceIndex("durable", durable);
    upsertWorkspaceIndex("ephemeral", join(tmp, "some-fixture"));
    const idx = readWorkspaceIndex();
    ok(workspacesIndexPath() === join(xdg, "dev-loop", "workspaces.json"), "the machine default follows XDG_CONFIG_HOME");
    ok(idx.durable === durable, `a durable root is recorded in the machine-default index (${JSON.stringify(idx)})`);
    ok(!Object.hasOwn(idx, "ephemeral"), `a root under $TMPDIR is not (${JSON.stringify(idx)})`);
    // /tmp is the OTHER temp root, and fixtures in this repo use it directly — checking only
    // os.tmpdir() left /private/tmp/... entries in the index after a full run.
    upsertWorkspaceIndex("posix-tmp", "/tmp/dl-some-fixture/ws");
    ok(!Object.hasOwn(readWorkspaceIndex(), "posix-tmp"),
      `a root under /tmp is not either (${JSON.stringify(readWorkspaceIndex())})`);
    delete process.env.XDG_CONFIG_HOME;
  }
} finally {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nWORKSPACE_INDEX_ISOLATION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
