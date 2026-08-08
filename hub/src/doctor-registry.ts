// doctor-registry.ts — LOOP-357 Child B + LOOP-428 Child C: the check table + the driver.
//
// Design §4 contracts verbatim. Not appended to doctor.ts (already 1,700+ lines).
// Child B introduced the registry with 11 workspace rows; Child C completes it: all 29 rows
// (design §7), the repo + board scope fan-out, and the single lazily-opened board db handle.

import type { Workspace, ResolvedRepo } from "./team-config.ts";
import { effectiveRepo, deliveryProjects } from "./team-config.ts";
import { findProject as findHubProject } from "./seed.ts";
// Rows 1-12 are imported STATICALLY and run SYNCHRONOUSLY. That is not a style choice: until
// row 13 (W22) the old doctorWorkspace emitted every line before its first `await`, and callers
// that invoke doctorWorkspace WITHOUT awaiting it (test/secrets.ts) can only observe output
// produced in that synchronous prefix. A dynamic import() here would push rows 1-12 behind a
// microtask and silently empty their output for those callers.
// The doctor.ts <-> doctor-registry.ts cycle is safe for these: they are hoisted function
// declarations, referenced only inside run() closures, never called at module-evaluation time.
import {
  checkConfigValidate, checkRepoRegistered, checkStrategyDocPointer, checkLinearMcpScope,
  checkFiresTaxonomy, checkCommsWebhook, checkProviderAuth, checkOpencodeDrift,
  checkOpencodeVersion, checkOwnerLiveness, checkDecisionQueueStall, checkSensitiveMistier,
} from "./doctor.ts";

// ── Contracts (design §4) ────────────────────────────────────────────────────

/** The four output sinks doctorWorkspace already builds. `fail` is the only one that flips ok. */
export interface DoctorOut {
  pass: (m: string) => void;
  fail: (m: string) => void;
  warn: (m: string) => void;
  info: (m: string) => void;
}

/** Everything a check may read. Built once per run; checks never construct their own. */
export interface DoctorCtx {
  ws: Workspace;
  opts: { exec?: import("./landing.ts").ExecFn; boardDb?: string };
  boardDb: string;               // opts.boardDb ?? wsHubDb(ws) — resolved ONCE
  out: DoctorOut;
  /**
   * THE board db handle, opened lazily on first use and closed once by the driver (design §5).
   * Every row that needs the board calls this — no check opens or closes a db of its own, which
   * is why exactly one openHubDbConn call remains on the doctor path. Board-scope rows get the
   * handle pre-resolved on their BoardCtx; workspace-scope rows that need a cross-project
   * aggregate (row 11) call it directly. NEVER close what this returns.
   */
  openBoardDb: () => import("node:sqlite").DatabaseSync;
}

/** Extra ctx for scope: "repo" rows — the driver iterates repos and supplies these. */
export interface RepoCtx extends DoctorCtx {
  ref: string;
  repo: ResolvedRepo;
  dir: string;
}

/** Extra ctx for scope: "board" rows — driver supplies an OPEN db + the resolved project. */
export interface BoardCtx extends DoctorCtx {
  db: import("node:sqlite").DatabaseSync;
  projectKey: string;
  projectId: string;
}

/** The three values runDoctor needs back from specific checks (§6). */
export interface DoctorReport {
  stalledRepo?: string;
  decisionStall?: { oldest: { id: string; enteredAt: string; state: string }; count: number } | null;
  skewResult?: { codeBehind: number; version: string } | null;
}

export interface DoctorCheck {
  /** W-codes this check can emit. [] for the code-less checks (repo existence, the info nudges). */
  codes: readonly string[];
  /** Stable handle for tests and failure messages. e.g. "w16-owner-liveness". */
  id: string;
  scope: "workspace" | "repo" | "board";
  /** Skip entirely when false. Keeps the gate OUT of the check body. */
  applies?: (ctx: DoctorCtx) => boolean;
  /**
   * true (DEFAULT): a throw is swallowed — the check never flips DOCTOR_OK. This is today's
   * behavior for all but the config/repo checks, currently spelled as ~15 hand-written try/catch
   * blocks each with a "best-effort — never fails doctor" comment.
   * false: the throw propagates (the caller's contract for a check that MUST be able to fail).
   */
  bestEffort?: boolean;
  run: (ctx: DoctorCtx | RepoCtx | BoardCtx) => void | Promise<void> | DoctorReport | Promise<DoctorReport | void>;
}

// ── Scope fan-out ─────────────────────────────────────────────────────────────

/** A board row's guard: service backend with a board db actually on disk. */
const boardApplies = (ctx: DoctorCtx): boolean => {
  // Imported lazily to keep this module free of node:fs at evaluation time.
  const { existsSync } = require_fs();
  return ctx.ws.file.team.backend === "service" && existsSync(ctx.boardDb);
};

// `createRequire`-free lazy fs handle: doctor-registry is imported by doctor.ts, which already
// pulls node:fs; a direct static import here is fine and cheaper than a dynamic one.
import { existsSync as fsExistsSync } from "node:fs";
const require_fs = () => ({ existsSync: fsExistsSync });

/**
 * Execute a single DoctorCheck, handling the scope fan-out (design §5).
 * - "workspace" runs the check once with ctx.
 * - "repo" iterates Object.keys(ws.file.repos) and hands each row a RepoCtx.
 * - "board" opens the db via the caller's lazy getter, iterates deliveryProjects(ws), resolves
 *   findHubProject and SKIPS unresolved keys, handing each row a BoardCtx.
 *
 * Board rows are deliberately NOT grouped into one pass: design §7 — rows 10/12/22/29 are
 * interleaved with workspace rows, and grouping them would reorder doctor's output.
 */
/** A value is awaitable. Used to keep SYNC rows off the microtask queue (see the import note above). */
export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === "function";
}

/** Build the per-item contexts a scoped row fans out over, in order. */
function scopeItems(check: DoctorCheck, ctx: DoctorCtx): Array<RepoCtx | BoardCtx> {
  if (check.scope === "repo") {
    return Object.keys(ctx.ws.file.repos).map((ref) => {
      const repo = effectiveRepo(ctx.ws, ref);
      return { ...ctx, ref, repo, dir: repo.absPath };
    });
  }
  const db = ctx.openBoardDb();
  const items: BoardCtx[] = [];
  for (const projectKey of deliveryProjects(ctx.ws)) {
    const projectId = findHubProject(db, projectKey);
    if (!projectId) continue;                      // an unseeded key is skipped, never an error
    items.push({ ...ctx, db, projectKey, projectId });
  }
  return items;
}

/** Finish a fan-out that turned out to be async, preserving item order (never concurrent). */
async function runRest(
  check: DoctorCheck, items: Array<RepoCtx | BoardCtx>, from: number,
  pending: unknown, report: DoctorReport,
): Promise<DoctorReport> {
  Object.assign(report, (await pending) ?? {});
  for (let j = from; j < items.length; j++) Object.assign(report, (await check.run(items[j])) ?? {});
  return report;
}

/**
 * Execute a single DoctorCheck, handling the scope fan-out (design §5).
 * - "workspace" runs the check once with ctx.
 * - "repo" iterates Object.keys(ws.file.repos) and hands each row a RepoCtx.
 * - "board" takes THE driver handle, iterates deliveryProjects(ws), resolves findHubProject and
 *   SKIPS unresolved keys, handing each row a BoardCtx.
 *
 * Deliberately NOT declared `async`: a sync row must return its value synchronously so its output
 * lands before the caller's first await (see the rows 1-12 import note). Rows fan out SEQUENTIALLY
 * — never Promise.all — so a repo's lines are never interleaved with another repo's.
 *
 * Board rows are also not grouped into one pass: design §7 — rows 10/12/22/29 are interleaved with
 * workspace rows, and grouping them would reorder doctor's output.
 */
export function runScoped(check: DoctorCheck, ctx: DoctorCtx): DoctorReport | void | Promise<DoctorReport | void> {
  if (check.scope === "workspace") return check.run(ctx);

  const items = scopeItems(check, ctx);
  const report: DoctorReport = {};
  for (let i = 0; i < items.length; i++) {
    const r = check.run(items[i]);
    if (isThenable(r)) return runRest(check, items, i + 1, r, report);
    Object.assign(report, r ?? {});
  }
  return report;
}

// ── DOCTOR_CHECKS — design §7 order ───────────────────────────────────────────
// Array order IS the printed order (design §7). The golden harness (design §8) proves it.
// Child C seeds all 29 rows; the previous 11-row array is a subset of this one, unchanged
// in relative order.
//
// Circular-dependency note: rows 13+ use a dynamic await import() to reach doctor.ts's helpers,
// which avoids the cycle at module-evaluation time. Rows 1-12 cannot — they must stay synchronous
// (see the import note at the top) — so they take a static import instead; that is safe because
// they are hoisted function declarations never called during evaluation.

export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  // Row 1 — config validation (W01-W04, W07). NOT best-effort: a malformed config must fail doctor.
  {
    codes: ["W01", "W02", "W03", "W04", "W07"],
    id: "config-validate",
    scope: "workspace",
    bestEffort: false,
    run: (ctx) => { checkConfigValidate(ctx.ws, ctx.out); },
  },
  // Row 2 — every registered repo exists on disk + is a git repo. NOT best-effort: `fail` here
  // is the one repo finding that flips DOCTOR_OK.
  {
    codes: [],
    id: "repo-registered",
    scope: "repo",
    bestEffort: false,
    run: (ctx) => { const c = ctx as RepoCtx; checkRepoRegistered(c.ref, c.repo, c.dir, c.out); },
  },
  // Row 3 — W17 (project has repos but no strategyDoc)
  {
    codes: ["W17"],
    id: "w17-strategy-doc",
    scope: "workspace",
    bestEffort: true,
    run: (ctx) => { checkStrategyDocPointer(ctx.ws, ctx.out.warn); },
  },
  // Row 4 — W05 (linear steward MCP scope)
  {
    codes: ["W05"],
    id: "w05-linear-mcp-scope",
    scope: "workspace",
    bestEffort: true,
    run: (ctx) => { checkLinearMcpScope(ctx.ws, ctx.out.warn); },
  },
  // Row 5 — the 7d fire signal + W24 (failure-taxonomy blind spot)
  {
    codes: ["W24"],
    id: "fires-taxonomy",
    scope: "workspace",
    bestEffort: true,
    run: (ctx) => { checkFiresTaxonomy(ctx.ws, ctx.out.warn, ctx.out.info); },
  },
  // Row 6 — W12 (comms webhook resolvability)
  {
    codes: ["W12"],
    id: "w12-comms-webhook",
    scope: "workspace",
    bestEffort: true,
    run: (ctx) => { checkCommsWebhook(ctx.ws, ctx.out.pass, ctx.out.warn); },
  },
  // Row 7 — W13 (provider auth resolvability)
  {
    codes: ["W13"],
    id: "w13-provider-auth",
    scope: "workspace",
    bestEffort: true,
    run: (ctx) => { checkProviderAuth(ctx.ws, ctx.out.pass, ctx.out.warn); },
  },
  // Row 8 — W14 (opencode.json registry drift)
  {
    codes: ["W14"],
    id: "w14-opencode-drift",
    scope: "workspace",
    bestEffort: true,
    run: (ctx) => { checkOpencodeDrift(ctx.ws, ctx.out.pass, ctx.out.warn); },
  },
  // Row 9 — W15 (opencode preflight / certified version)
  {
    codes: ["W15"],
    id: "w15-opencode-version",
    scope: "workspace",
    bestEffort: true,
    run: (ctx) => { checkOpencodeVersion(ctx.ws, ctx.out.pass, ctx.out.warn); },
  },
  // Row 10 — W16 (owner liveness) — board scope
  {
    codes: ["W16"],
    id: "w16-owner-liveness",
    scope: "board",
    applies: boardApplies,
    bestEffort: true,
    run: (ctx) => { checkOwnerLiveness(ctx as BoardCtx); },
  },
  // Row 11 — W20 (operator decision queue stall) — stateful. Workspace scope, not board: it emits
  // ONE line for a CROSS-project aggregate (oldest item over all delivery projects), which a
  // per-project board fan-out cannot express. It reads the board through ctx.openBoardDb().
  {
    codes: ["W20"],
    id: "w20-decision-stall",
    scope: "workspace",
    applies: boardApplies,
    bestEffort: true,
    run: (ctx) => ({ decisionStall: checkDecisionQueueStall(ctx) }),
  },
  // Row 12 — W21 (sensitive mis-tier backstop) — board scope
  {
    codes: ["W21"],
    id: "w21-sensitive-mistier",
    scope: "board",
    applies: boardApplies,
    bestEffort: true,
    run: (ctx) => { checkSensitiveMistier(ctx as BoardCtx); },
  },
  // Row 13 — W22 (landing stall) — stateful
  {
    codes: ["W22"],
    id: "w22-landing-stall",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkLandingW22Stall } = await import("./doctor.ts");
      return { stalledRepo: await checkLandingW22Stall(ctx.ws, ctx.opts, ctx.out) };
    },
  },
  // Row 13a — W38 (mergeChecks on an unprotected default branch, LOOP-407). Not a design §7 row:
  // it is a NEW check, so it carries no §7 number and does not renumber the rows below it. Placed
  // here rather than at the array tail because doctorWorkspace called it between W22 and W19, and
  // the registry order IS the emission order.
  {
    codes: ["W38"],
    id: "w38-mergechecks-unprotected",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkMergeChecksUnprotectedW38 } = await import("./doctor.ts");
      await checkMergeChecksUnprotectedW38(ctx.ws, ctx.opts, ctx.out.warn);
    },
  },
  // Row 14 — W19 (unpushed doc commits) — repo scope
  {
    codes: ["W19"],
    id: "w19-unpushed-docs",
    scope: "repo",
    bestEffort: true,
    run: async (ctx) => {
      const { checkUnpushedDocs } = await import("./doctor.ts");
      checkUnpushedDocs(ctx as RepoCtx);
    },
  },
  // Row 15 — W18 (installed CLI vs origin skew) — stateful
  {
    codes: ["W18"],
    id: "w18-cli-skew",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkInstalledCliSkew } = await import("./doctor.ts");
      return { skewResult: checkInstalledCliSkew(ctx.ws, ctx.out) ?? null };
    },
  },
  // Row 16 — W23 (CLI-rename permission drift)
  {
    codes: ["W23"],
    id: "w23-permission-drift",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkPermissionDrift } = await import("./doctor.ts");
      checkPermissionDrift(ctx.ws, ctx.out.warn);
    },
  },
  // Row 17 — W26 (unmerged paths in shared checkout, LOOP-215)
  {
    codes: ["W26"],
    id: "w26-unmerged-paths",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { warnUnmergedPaths } = await import("./doctor.ts");
      warnUnmergedPaths(ctx.ws, ctx.out.warn);
    },
  },
  // Row 18 — W33 (dirty shared tree, LOOP-312)
  {
    codes: ["W33"],
    id: "w33-dirty-shared-tree",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkDirtySharedTree } = await import("./doctor.ts");
      checkDirtySharedTree(ctx.ws, ctx.out.warn);
    },
  },
  // Row 19 — W34 (in-repo worktrees, LOOP-132)
  {
    codes: ["W34"],
    id: "w34-in-repo-worktrees",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkInRepoWorktrees } = await import("./doctor.ts");
      checkInRepoWorktrees(ctx.ws, ctx.out.warn);
    },
  },
  // Row 20 — W35 (report trail, LOOP-28)
  {
    codes: ["W35"],
    id: "w35-report-trail",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkReportTrail } = await import("./doctor.ts");
      checkReportTrail(ctx.ws, ctx.out.warn);
    },
  },
  // Row 21 — W36 (scheduler build, LOOP-253)
  {
    codes: ["W36"],
    id: "w36-scheduler-build",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkSchedulerBuild } = await import("./doctor.ts");
      checkSchedulerBuild(ctx.ws, ctx.out.warn);
    },
  },
  // Row 22 — W31 (tier starvation, LOOP-329) — board scope on the DRIVER's handle (design §7)
  {
    codes: ["W31"],
    id: "w31-tier-starvation",
    scope: "board",
    applies: boardApplies,
    bestEffort: true,
    run: async (ctx) => {
      const { checkTierStarvationRow } = await import("./doctor.ts");
      checkTierStarvationRow(ctx as BoardCtx);
    },
  },
  // Row 23 — W37 (strategy doc budget, LOOP-282)
  {
    codes: ["W37"],
    id: "w37-strategy-budget",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkStrategyDocBudget } = await import("./doctor.ts");
      checkStrategyDocBudget(ctx.out.warn, ctx.out.info);
    },
  },
  // Row 24 — W30 (lessons liveness, LOOP-91)
  {
    codes: ["W30"],
    id: "w30-lessons-liveness",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkLessonsLiveness } = await import("./doctor.ts");
      checkLessonsLiveness(ctx.ws, ctx.out.warn);
    },
  },
  // Row 25 — W32 (board snapshot, LOOP-340)
  {
    codes: ["W32"],
    id: "w32-board-snapshot",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkBoardSnapshotW32 } = await import("./doctor.ts");
      checkBoardSnapshotW32(ctx.ws, ctx.out.warn);
    },
  },
  // Row 26 — W25 (daemon port band, LOOP-137)
  {
    codes: ["W25"],
    id: "w25-daemon-port-band",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkDaemonPortBand } = await import("./doctor.ts");
      await checkDaemonPortBand(ctx.out.warn);
    },
  },
  // Row 27 — W06 tree leaks on the workspace root
  {
    codes: ["W06"],
    id: "w06-tree-leaks-workspace",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkTreeLeaksWorkspace } = await import("./doctor.ts");
      checkTreeLeaksWorkspace(ctx.ws, ctx.out.warn, ctx.out.info);
    },
  },
  // Row 28 — W06 tree leaks per repo (LOOP-231). Its own row, not merged into row 27: today the
  // workspace root is scanned first, then each repo — two rows preserve that, one row cannot.
  {
    codes: ["W06"],
    id: "w06-tree-leaks-repo",
    scope: "repo",
    bestEffort: true,
    run: async (ctx) => {
      const { checkTreeLeaksRepo } = await import("./doctor.ts");
      checkTreeLeaksRepo(ctx as RepoCtx);
    },
  },
  // Row 29 — W27 (null-assignee stranded, LOOP-244) — board scope
  {
    codes: ["W27"],
    id: "w27-null-assignee",
    scope: "board",
    applies: boardApplies,
    bestEffort: true,
    run: async (ctx) => {
      const { checkNullAssigneeRow } = await import("./doctor.ts");
      checkNullAssigneeRow(ctx as BoardCtx);
    },
  },
  // Row 30 — W39 (secrets.env exposure, LOOP-430). Registered here rather than inline in
  // doctorWorkspace: that function sits at CRAP 89.6 against the 90 gate (LOOP-348), so an inline
  // block reads green locally and turns CI red.
  {
    codes: ["W39"],
    id: "w39-secrets-perms",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkSecretsPerms } = await import("./doctor.ts");
      checkSecretsPerms(ctx.ws, ctx.out.warn);
    },
  },
];
