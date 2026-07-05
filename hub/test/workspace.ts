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
  process.env.DEVLOOP_WORKSPACE = root;
  ok(ws.findWorkspaceRoot(tmp) === root, "DEVLOOP_WORKSPACE overrides cwd (even from outside)");
  process.env.DEVLOOP_WORKSPACE = "relative/path";
  ok(threw(() => ws.findWorkspaceRoot(root)), "DEVLOOP_WORKSPACE must be absolute → throws");
  process.env.DEVLOOP_WORKSPACE = join(tmp, "no-such");
  ok(threw(() => ws.findWorkspaceRoot(root)), "DEVLOOP_WORKSPACE with no dev-loop.json → throws");
  delete process.env.DEVLOOP_WORKSPACE;

  // ── resolveWorkspace loads + validates + self-registers the index ──
  const loaded = ws.resolveWorkspace(join(root, "mcp-bff"));
  ok(loaded.file.team.key === "jinko-dev", "resolveWorkspace loads + validates the file");
  ok(existsSync(ws.workspacesIndexPath()), "resolveWorkspace writes the convenience index");
  ok(ws.readWorkspaceIndex()["jinko-dev"] === root, "index maps team key → workspace root");

  // ── DEVLOOP_TEAM uses the index ──
  process.env.DEVLOOP_TEAM = "jinko-dev";
  ok(ws.findWorkspaceRoot(tmp) === root, "DEVLOOP_TEAM resolves via the index from anywhere");
  process.env.DEVLOOP_TEAM = "ghost-team";
  ok(threw(() => ws.findWorkspaceRoot(tmp)), "DEVLOOP_TEAM not in the index → throws");
  delete process.env.DEVLOOP_TEAM;

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
