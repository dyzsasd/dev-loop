// WHICH REGISTERED REPO IS THIS DIRECTORY? — the one answer every landing verb resolves through
// (LOOP-521 AC5; extracted from pr-merge.ts, which owned the lock half alone until `dev-loop push`).
//
// WHY IT IS ITS OWN MODULE. Two verbs now serialize on the landing lock: `pr merge` (the squash) and
// `push` (the fetch + the push). They must take THE SAME NAME — two names is not serialization — and
// the only way to guarantee that is one resolution both import. A push verb importing the merge verb
// would be a layering inversion, and a second copy of the resolution is exactly the drift the
// approvals arc (design approvals §16.3 D5) exists to stop.
//
// The lock name is the FIRST consumer of that resolution, not the only one. A directory also decides
// which default branch the gate measures its passenger range against, and — the one that bites
// silently — whether `approvals.enforce` covers the push at all. Those three answers must come from
// one matcher: a repo that is registered for the lock but unregistered for the enforcement switch is
// a gate that turns itself off in exactly the invocation §7 mandates (PR #287 review, P1).
//
// The name is also what `dev-loop with-repo-lock <ref>` takes (§7), so a registered repo resolves to
// `repo-<ref>` and the direct merge-back sequence, the squash, and the push all queue behind each
// other rather than interleaving.
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath, sep } from "node:path";
import { tmpdir } from "node:os";
import { tryResolveWorkspace, findWorkspaceRoot, wsLockPath } from "./workspace.ts";
import { effectiveRepo, type Workspace } from "./team-config.ts";
import { ghRepoFromRemote } from "./merge-guard.ts";

const canonPath = (p: string): string => { try { return realpathSync(p); } catch { return resolvePath(p); } };

// The git root that ENCLOSES `dir` — the nearest ancestor with a `.git` entry — or null. Walking up is
// load-bearing, not defensive: these verbs run from wherever the fire happens to be (the worktree
// root, `hub/`, any package subdirectory), and a lock whose NAME depends on the cwd is not a lock.
export function gitRootOf(dir: string): string | null {
  let cur = resolvePath(dir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// The base clone a LINKED WORKTREE belongs to, or null when `dir` is not one (a plain clone, or not a
// git dir at all). Read from the filesystem rather than `git rev-parse --git-common-dir`, because this
// function is the lock's NAME: it must answer identically wherever it runs, without a subprocess that
// can be absent, slow, or fail into the fallback this exists to avoid.
//
// A linked worktree's `.git` is a FILE holding `gitdir: <base>/.git/worktrees/<name>`; a plain clone's
// is a directory (readFileSync → EISDIR → null). The path is matched structurally, so a SUBMODULE's
// gitdir (`<super>/.git/modules/<name>`) does not answer — a submodule is not a worktree of its
// superproject and must not borrow its lock.
export function baseCloneOf(dir: string): string | null {
  let raw: string;
  try { raw = readFileSync(join(dir, ".git"), "utf8"); } catch { return null; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  if (!m) return null;
  let abs = resolvePath(dir, m[1]!); // git may record it relative (worktree.useRelativePaths)
  try { abs = realpathSync(abs); } catch { /* keep the resolved form */ }
  const parts = abs.split(sep);
  const i = parts.lastIndexOf("worktrees");
  if (i < 1 || parts[i - 1] !== ".git") return null;
  const base = parts.slice(0, i - 1).join(sep) || sep;
  try { return realpathSync(base); } catch { return base; }
}

// Every path that identifies the same registered repo as `dir`: `dir` itself, the git root enclosing
// it, and — when that root is a linked worktree — the base clone that owns it.
export function repoRootsOf(dir: string): string[] {
  const roots: string[] = [];
  const push = (p: string): void => { const c = canonPath(p); if (!roots.includes(c)) roots.push(c); };
  push(dir);
  const root = gitRootOf(dir);
  if (!root) return roots;
  push(root);
  const base = baseCloneOf(root);
  if (base) push(base);
  return roots;
}

// The workspace ROOT that owns the repo `dir` belongs to, or null.
//
// `findWorkspaceRoot(dir)` alone is NOT this question, and the difference is not academic: a linked
// worktree placed OUTSIDE the workspace tree — `git worktree add /tmp/x` in a registered repo, or one an
// agent put beside the checkout — has no `dev-loop.json` above it, so the upward walk answers "in no
// workspace" for a repo that is plainly registered. `repoRootsOf` adds the git root and, through the
// common dir, the BASE CLONE (:66-76), which is the checkout the registry names and is inside.
//
// The example that used to stand here — `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project>/wt/<ticket>` — has
// not been produced since the 1.0 workspace model: `wsWorktree` (workspace.ts) puts a dev-tier worktree
// at `<workspace>/.dev-loop/wt/<ticket>/<ref>`, INSIDE the tree, where the upward walk does resolve it.
// The indirection is still load-bearing, for every worktree that is not under that path.
//
// Deliberately the bare root walk rather than `resolveWorkspace`: callers that document themselves as
// read-only (push-guard) need the config WITHOUT hydrating secrets into `process.env` or upserting
// the machine-global index.
export function workspaceRootForRepoDir(dir: string): string | null {
  for (const root of repoRootsOf(dir)) { const r = findWorkspaceRoot(root); if (r) return r; }
  return null;
}

// The same question, answered with a resolved `Workspace` for callers that already resolve one.
export function workspaceForRepoDir(dir: string): Workspace | null {
  for (const root of repoRootsOf(dir)) { const ws = tryResolveWorkspace(root); if (ws) return ws; }
  return null;
}

// The registry ref whose repo CONTAINS `dir` — the base clone itself, a package subdirectory of it,
// or one of its linked worktrees — or null. This is the matcher; every consumer below is a reader of
// it, so the lock name, the default branch, and the enforcement switch cannot disagree about which
// repo a directory is.
export function registeredRepoRefFor(ws: Workspace, dir: string): string | null {
  const selves = repoRootsOf(dir);
  const entries = Object.entries(ws.file.repos ?? {}) as [string, { path?: string } | null][];
  for (const [ref, e] of entries) {
    if (!e?.path) continue;
    const abs = resolvePath(ws.root, e.path);
    let absReal = abs;
    try { absReal = realpathSync(abs); } catch { /* keep abs */ }
    if (selves.includes(absReal) || selves.includes(abs)) return ref;
  }
  return null;
}

// The registered default branch for the repo `dir` belongs to, or undefined when it belongs to none.
// The gate's passenger range is measured against this, so an unresolvable one must stay a loud
// refusal in the caller — never a guessed "main" (LOOP-119's class).
export function resolveDefaultBranchForRepoDir(dir: string): string | undefined {
  const ws = workspaceForRepoDir(dir);
  if (!ws) return undefined;
  const ref = registeredRepoRefFor(ws, dir);
  return ref ? effectiveRepo(ws, ref).defaultBranch : undefined;
}

// The lock a landing verb serializes on. It ALWAYS resolves to a path — there is no "could not work
// out where to lock, so proceed unlocked" branch, because that branch would be the hole.
//
// Registered repo ⇒ `repo-<ref>`, byte-identical to what `dev-loop with-repo-lock <ref>` takes (§7).
// Sharing the name is the point, not a coincidence: in `landing:"direct"` the merge-back sequence
// pushes `defaultBranch` under that same lock, and a squash racing that push moves the same branch
// from two writers. One name, one serialization.
//
// The fallbacks key on the GitHub repo instead, because that — not the local directory — is what two
// racing fires actually contend for: two clones or two worktrees of one repo are different paths
// landing into the same branch, and a path-keyed lock would let them straight through. `ghRepo` is
// nullable for `push`, which (unlike `pr merge`) has no forge call to make and so can run in a repo
// whose remote names no GitHub repo at all; the LAST resort then keys on the canonical git root,
// which is weaker than the gh slug but is still a lock — the one thing this function may not return
// is "none".
export function repoLandingLockPath(repoDir: string, ghRepo: string | null): string {
  const slug = ghRepo
    ? `repo-gh-${ghRepo.replace(/[^A-Za-z0-9._-]+/g, "-")}`
    : `repo-path-${(gitRootOf(repoDir) ?? canonPath(repoDir)).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "")}`;
  const ws = workspaceForRepoDir(repoDir);
  if (!ws) {
    // No workspace: still lock, per-user and per-machine. Two fires always share a workspace, so this
    // is the standalone-invocation case rather than the racing one — but "unlikely to be contended"
    // is not a reason to skip the lock, and a skip here would be a fail-open nobody would see.
    return join(tmpdir(), "dev-loop-locks", `${slug}.lock`);
  }
  // A ticket worktree is not the base clone, and landing FROM one is the normal dev-tier invocation
  // (§7 makes the worktree mandatory for both split tiers, in every landing mode). Neither a worktree
  // nor a package subdirectory equals a registered `path`, so without this the ref match falls through
  // to the remote match — which needs the OPTIONAL `remote` — and then to `repo-gh-<owner-repo>`, a
  // name `with-repo-lock <ref>` never takes. Two names is not serialization. So the cwd is resolved to
  // the repo that owns it, and a registry entry without a `remote` is still matched by path.
  const byPath = registeredRepoRefFor(ws, repoDir);
  if (byPath) return wsLockPath(ws, `repo-${byPath}`);
  const entries = Object.entries(ws.file.repos ?? {}) as [string, { path?: string; remote?: string } | null][];
  // The cwd is not a registered repo path (the workspace-root invocation these verbs' --help
  // advertise). Match on the remote instead — one entry only; two entries sharing a remote is the
  // ambiguity `resolveRegistryCiFreshnessConfig` already refuses to guess through.
  const byRemote = ghRepo
    ? entries.filter(([, e]) => e?.remote && ghRepoFromRemote(e.remote) === ghRepo)
    : [];
  if (byRemote.length === 1) return wsLockPath(ws, `repo-${byRemote[0]![0]}`);
  return wsLockPath(ws, slug);
}
