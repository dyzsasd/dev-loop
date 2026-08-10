// workspace.ts — discovery precedence, the .dev-loop path API, index self-heal, cwd→repo matching.
// devloopHome() reads DEVLOOP_HOME at CALL time (not cached), so setting it before we invoke any ws.* is
// enough to isolate the convenience index from the real ~/.dev-loop.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ws from "../src/workspace.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const threw = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-ws-")));
process.env.DEVLOOP_HOME = join(tmp, "home");
delete process.env.DEVLOOP_WORKSPACE;
delete process.env.DEVLOOP_TEAM;
delete process.env.DEVLOOP_HUB_DB; // LOOP-418: the no-argument assertions below read this ladder,
                                   // and every agent fire exports it at the LIVE workspace.

try {
  const root = join(tmp, "workspace");
  mkdirSync(join(root, "jinko-dev-platform", "src"), { recursive: true });
  mkdirSync(join(root, "mcp-bff"), { recursive: true });
  writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "jinko-dev", backend: "linear", linearTeam: "Loop-1" },
    repos: { portal: { path: "jinko-dev-platform" }, bff: { path: "mcp-bff", owner: "devplatform" } },
    projects: {
      devplatform: { repos: [{ ref: "portal", role: "primary" }, { ref: "bff" }] },
      agentapi: { repos: [{ ref: "bff" }] },
    },
  }));

  // ── discovery: cwd ascent ──
  ok(ws.findWorkspaceRoot(join(root, "jinko-dev-platform", "src")) === root, "ascent: a deep repo subdir resolves the workspace root");
  ok(ws.findWorkspaceRoot(root) === root, "ascent: the workspace root resolves itself");
  ok(ws.findWorkspaceRoot(tmp) === null, "ascent: a dir above the workspace resolves nothing");

  // ── discovery: DEVLOOP_WORKSPACE precedence + hard errors ──
  // The env ladder answers the NO-ARGUMENT call — "the caller named no root" (LOOP-371).
  process.env.DEVLOOP_WORKSPACE = root;
  ok(ws.findWorkspaceRoot() === root, "DEVLOOP_WORKSPACE answers the no-argument call (even from outside)");
  // …and an explicit argument outranks it: the caller DID name a root (LOOP-418 AC1).
  ok(ws.findWorkspaceRoot(tmp) === null, "explicit arg outranks DEVLOOP_WORKSPACE: a dir above the workspace still resolves nothing");
  ok(ws.findWorkspaceRoot(join(root, "mcp-bff")) === root, "explicit arg outranks DEVLOOP_WORKSPACE: ascent from the named dir");
  process.env.DEVLOOP_WORKSPACE = "relative/path";
  ok(threw(() => ws.findWorkspaceRoot()), "DEVLOOP_WORKSPACE must be absolute → throws");
  ok(!threw(() => ws.findWorkspaceRoot(root)), "a broken DEVLOOP_WORKSPACE cannot fail a call that named its own root");
  process.env.DEVLOOP_WORKSPACE = join(tmp, "no-such");
  ok(threw(() => ws.findWorkspaceRoot()), "DEVLOOP_WORKSPACE with no dev-loop.json → throws");
  delete process.env.DEVLOOP_WORKSPACE;

  // ── resolveWorkspace loads + validates + self-registers the index ──
  const loaded = ws.resolveWorkspace(join(root, "mcp-bff"));
  ok(loaded.file.team.key === "jinko-dev", "resolveWorkspace loads + validates the file");
  ok(existsSync(ws.workspacesIndexPath()), "resolveWorkspace writes the convenience index");
  ok(ws.readWorkspaceIndex()["jinko-dev"] === root, "index maps team key → workspace root");

  // ── DEVLOOP_TEAM uses the index ──
  process.env.DEVLOOP_TEAM = "jinko-dev";
  ok(ws.findWorkspaceRoot() === root, "DEVLOOP_TEAM resolves via the index from anywhere");
  ok(ws.findWorkspaceRoot(tmp) === null, "explicit arg outranks DEVLOOP_TEAM");
  process.env.DEVLOOP_TEAM = "ghost-team";
  ok(threw(() => ws.findWorkspaceRoot()), "DEVLOOP_TEAM not in the index → throws");
  delete process.env.DEVLOOP_TEAM;

  // ── LOOP-418 AC3: an explicit root outranks DEVLOOP_HUB_DB, and BOTH directions are asserted ──
  // DEVLOOP_HUB_DB is set in every agent fire, so a test that hands a fixture root its own path was
  // silently answered about the LIVE workspace. Asserting only the explicit direction would pass on
  // a patch that ignored the env entirely — hence the no-argument assertion beside it.
  {
    const wsB = join(tmp, "workspace-b");
    mkdirSync(join(wsB, "sub", "deeper"), { recursive: true });
    writeFileSync(join(wsB, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "team-b", backend: "linear", linearTeam: "Loop-2" },
      repos: {}, projects: {},
    }));
    process.env.DEVLOOP_HUB_DB = join(root, ".dev-loop", "hub.db"); // points at workspace A
    ok(ws.findWorkspaceRoot(wsB) === wsB, "AC3: explicit root B outranks DEVLOOP_HUB_DB→A");
    ok(ws.findWorkspaceRoot(join(wsB, "sub", "deeper")) === wsB, "AC3: explicit subdir of B ascends to B, not A");
    ok(ws.findWorkspaceRoot() === root, "AC3: the no-argument call still resolves A from DEVLOOP_HUB_DB");
    // resolveWorkspace/tryResolveWorkspace forward the same distinction (they are the product entry points).
    ok(ws.resolveWorkspace(wsB).file.team.key === "team-b", "AC3: resolveWorkspace(B) loads B under DEVLOOP_HUB_DB→A");
    ok(ws.tryResolveWorkspace()?.file.team.key === "jinko-dev", "AC3: tryResolveWorkspace() still loads A from the env");
    delete process.env.DEVLOOP_HUB_DB;
  }

  // ── a corrupt index is non-fatal (convenience only) ──
  writeFileSync(ws.workspacesIndexPath(), "{ broken json");
  ok(Object.keys(ws.readWorkspaceIndex()).length === 0, "a corrupt index reads as empty, never throws");
  ok(ws.findWorkspaceRoot(join(root, "mcp-bff")) === root, "discovery still works via ascent when the index is broken");

  // ── path API (R1 layout) ──
  ok(ws.wsStateRoot(loaded) === join(root, ".dev-loop"), "wsStateRoot");
  ok(ws.wsProjectDir(loaded, "devplatform") === join(root, ".dev-loop", "devplatform"), "wsProjectDir");
  ok(ws.wsTeamDir(loaded) === join(root, ".dev-loop", "team"), "wsTeamDir");
  ok(ws.wsLessonsDir(loaded) === join(root, ".dev-loop", "lessons"), "wsLessonsDir");
  ok(ws.wsHubDb(loaded) === join(root, ".dev-loop", "hub.db"), "wsHubDb is inside the workspace (I4)");
  ok(ws.wsWorktree(loaded, "DEV-1", "bff") === join(root, ".dev-loop", "wt", "DEV-1", "bff"), "wsWorktree keys by ticket+ref (shared-repo safe)");
  ok(ws.wsLockPath(loaded, "repo-bff") === join(root, ".dev-loop", "locks", "repo-bff.lock"), "wsLockPath");
  ok(ws.wsFireLedger(loaded) === join(root, ".dev-loop", "team", "fires.jsonl"), "wsFireLedger under team/");

  ws.ensureStateDirs(loaded);
  ok(existsSync(ws.wsTeamDir(loaded)) && existsSync(ws.wsLessonsDir(loaded)) && existsSync(join(ws.wsStateRoot(loaded), "locks")), "ensureStateDirs scaffolds the tree");

  // ── resolveRepoFromCwd (DL-13 matcher over the registry) ──
  ok(ws.resolveRepoFromCwd(loaded, join(root, "jinko-dev-platform", "src")) === "portal", "cwd→repo: deep subdir → its ref");
  ok(ws.resolveRepoFromCwd(loaded, join(root, "mcp-bff")) === "bff", "cwd→repo: exact repo dir → its ref");
  ok(ws.resolveRepoFromCwd(loaded, root) === null, "cwd→repo: at the workspace root (above any repo) → null");

  console.log(fails === 0 ? "\nWORKSPACE_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
