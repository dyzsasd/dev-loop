// doctor-registry.ts — LOOP-357 Child B: the check table + the driver.
//
// Design §4 contracts verbatim. Not appended to doctor.ts (already 1,700+ lines).
// New file — the registry is introduced here and grows in Children C/D.

import type { Workspace, ResolvedRepo } from "./team-config.ts";

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

/**
 * Execute a single DoctorCheck, handling the scope fan-out.
 * For "workspace" scope, runs the check once with ctx.
 * "repo" and "board" scopes are not yet wired in Child B — they arrive in Child C.
 */
export async function runScoped(check: DoctorCheck, ctx: DoctorCtx): Promise<DoctorReport | void> {
  // Child B: only workspace-scope rows are migrated; repo/board arrive in Child C.
  if (check.scope === "workspace") {
    return check.run(ctx);
  }
  // For non-workspace rows in Child B, no-op (they run inline in doctor.ts).
  return undefined;
}

// ── DOCTOR_CHECKS — design §7 order ───────────────────────────────────────────
// Child B: 11 rows migrated from doctor.ts — W20 (row 11) + rows 17-26.
// Design §7: "Seed the array in the exact current sequence."
// Future children add the remaining 18 rows.
//
// Circular-dependency note: the run functions use dynamic await import() to reference
// doctor.ts's helper functions. This avoids the cycle at module evaluation time.
// At runtime the module graph is fully loaded.

export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  // Row 11 — W20 (operator decision queue stall)
  {
    codes: ["W20"],
    id: "w20-decision-stall",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkDecisionQueueStall } = await import("./doctor.ts");
      return { decisionStall: checkDecisionQueueStall(ctx.ws, ctx.out.warn) };
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
  // Row 22 — W31 (tier starvation, LOOP-329) — keeps its own db open (Child C moves it to the driver's handle)
  {
    codes: ["W31"],
    id: "w31-tier-starvation",
    scope: "workspace",
    bestEffort: true,
    run: async (ctx) => {
      const { checkTierStarvation } = await import("./doctor.ts");
      checkTierStarvation(ctx.ws, ctx.boardDb, ctx.out.warn);
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
];