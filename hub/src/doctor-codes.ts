// The W-code namespace, in ONE place (LOOP-88).
//
// A `W##` code is the operator's handle on a warning: what they search, what they cite, what a
// runbook pins. If two checks ship under one code the namespace stops being an identifier.
//
// Before this file, a filer picking a code for a new check grepped `doctor.ts` — which shows only
// the codes that have SHIPPED. That is blind to every code already claimed by a ticket that has not
// landed, so independently-filed doctor tickets converge on the same "next free" number. Two
// consecutive design gates had to hand-reassign a code (LOOP-74 vs LOOP-56; LOOP-81 vs LOOP-41),
// which is how the collisions were caught at all — by a human reading, not by any mechanism. A third
// was caught while writing this file: LOOP-82's new unknown-agent warning had taken W02, which the
// repo-registry validator already held.
//
// The codes are NOT all emitted from doctor.ts — W01/W02/W04/W07 come from the config validator and
// W03 from the lessons budget — but they are ONE operator-facing namespace, so they are registered
// together. `hub/test/doctor-codes.ts` asserts: no duplicate code, and every `[W##]`/`"W##"` literal
// anywhere in hub/src is registered here.
//
// Adding a check: add its row here FIRST. The test fails on an unregistered code, so a collision is
// caught at merge time instead of by the next reader.

// E-codes are a SECOND namespace, and it is the one with no home (LOOP-473). `W##` warns; `E##` is
// an error that blocks an unattended run. E00-E19 are all claimed by team-config.ts's validator,
// keyed by config PATH rather than by check — so there is no per-code name to tabulate, and a
// hand-copied inventory here would be stale the next time that validator grows a rule. Picking "the
// next free code in doctor.ts" therefore reads as E12, which collides with the intake validator at
// team-config.ts:260.
//
// So the E namespace is guarded by DERIVATION, not by a list: `hub/test/legacy-home.ts` scans every
// `E##` literal in hub/src and fails if a code registered below is also claimed by another file.
// Only E-codes emitted from a registered check appear in the table; team-config's stay its own.

export interface DoctorCode {
  code: string;
  /** Short name — what the check is about, not its full remediation text. */
  name: string;
  /** Where it is emitted from, so a reader can find the implementation. */
  source: string;
}

export const DOCTOR_CODES: readonly DoctorCode[] = [
  { code: "W01", name: "project references no repos", source: "team-config.ts" },
  { code: "W02", name: "repo registered but referenced by no project", source: "team-config.ts" },
  { code: "W03", name: "lessons INDEX/shard over budget", source: "lessons.ts" },
  { code: "W04", name: "unknown agent name in agents{} — the block never applies", source: "team-config.ts" },
  { code: "W05", name: "workspace/backend wiring nag", source: "doctor.ts" },
  { code: "W06", name: "state/bundle artifacts and agent state files leaking into a git work tree", source: "doctor.ts" },
  { code: "W07", name: "repo deploys but has no health probe", source: "team-config.ts" },
  { code: "W08", name: "config project with no hub.db row", source: "doctor.ts" },
  { code: "W09", name: "dev-loop not runnable on PATH", source: "doctor.ts" },
  { code: "W10", name: "agent interface / MCP wiring", source: "doctor.ts" },
  { code: "W11", name: "coding-agent binary missing", source: "doctor.ts" },
  { code: "W12", name: "provider auth env unresolvable", source: "doctor.ts" },
  { code: "W13", name: "provider key not resolvable from secrets", source: "doctor.ts" },
  { code: "W14", name: "opencode.json provider drift", source: "doctor.ts" },
  { code: "W15", name: "opencode version below the certified floor", source: "doctor.ts" },
  { code: "W16", name: "owner liveness — an owner handle that never fires", source: "doctor.ts" },
  { code: "W17", name: "project has repos but no strategyDoc", source: "doctor.ts" },
  { code: "W18", name: "installed CLI behind origin/main (release/install skew)", source: "doctor.ts" },
  { code: "W19", name: "hub db / schema advisory", source: "doctor.ts" },
  { code: "W20", name: "operator decision-queue stall", source: "doctor.ts" },
  { code: "W21", name: "sensitive ticket mis-tiered to junior", source: "doctor.ts" },
  { code: "W22", name: "landing stall — a wedged PR queue", source: "doctor.ts" },
  { code: "W23", name: "workspace needs `team repair`", source: "doctor.ts" },
  { code: "W24", name: "failure taxonomy blind — most failures carry no errorClass", source: "doctor.ts" },
  { code: "W25", name: "daemon port band exhausted — the next daemon cannot start", source: "doctor.ts" },
  { code: "W26", name: "shared checkout has unmerged or staged-uncommitted paths", source: "doctor.ts" },
  { code: "W27", name: "null-assignee stranded ticket", source: "doctor.ts" },
  { code: "W28", name: "daemon running old code (version skew)", source: "doctor.ts" },
  { code: "W29", name: "tombstoned-project divergence", source: "doctor.ts" },
  { code: "W30", name: "lessons library never written — no cross-fire learning reaches any fire", source: "doctor.ts" },
  { code: "W31", name: "dev tier starved — idle Todo slots with zero promotable Backlog", source: "doctor.ts" },
  { code: "W32", name: "board never snapshotted, or the snapshot cadence stopped", source: "doctor.ts" },
  { code: "W33", name: "shared checkout has uncommitted tracked modifications — destroyable by another fire", source: "doctor.ts" },
  { code: "W34", name: "worktree living INSIDE a registered repo's working tree", source: "doctor.ts" },
  { code: "W35", name: "agent fired but wrote no report — the fire left no durable trail (§22)", source: "doctor.ts" },
  { code: "W36", name: "running scheduler loaded a different build than the installed CLI", source: "doctor.ts" },
  { code: "W37", name: "strategy doc over its byte budget — every §20 R2 reader pays it each fire", source: "doctor.ts" },
  { code: "W38", name: "mergeChecks configured on an unprotected default branch — only merge-guard enforces them", source: "doctor.ts" },
  { code: "W39", name: "secrets.env readable by group/others — live provider keys exposed to every local account", source: "doctor.ts" },
  { code: "W40", name: "approval rows exist but approvals.enforce is empty — the record gates nothing", source: "doctor.ts" },
  { code: "W41", name: "never-expiring approval grant — an end-state authorization with no horizon", source: "doctor.ts" },
  { code: "W42", name: "hub projects row diverged from the resolved config mode/autonomy", source: "doctor.ts" },
  { code: "W43", name: "stale claim — In Progress ticket has had no activity for over 24h while its owner still fires", source: "doctor.ts" },
  { code: "W44", name: "agent firing consecutively but always failing — a dead lane", source: "doctor.ts" },
  { code: "W45", name: "codex lane on the SAFE default — team.codex.sandbox unset, an unattended codex fire cannot write and still records a success", source: "doctor.ts" },
  { code: "W46", name: "blocked ticket with no bail-shape label and no parseable Bail-shape comment — unroutable", source: "doctor.ts" },
  { code: "E20", name: "home-anchored ~/.dev-loop tree still holds state the seam removal would orphan", source: "legacy-home.ts" },
] as const;

export const DOCTOR_CODE_SET: ReadonlySet<string> = new Set(DOCTOR_CODES.map((c) => c.code));

/** The next unclaimed code, for a filer choosing one. Exposed so the answer is derived, not grepped. */
export function nextFreeDoctorCode(): string {
  for (let n = 1; n < 100; n++) {
    const c = `W${String(n).padStart(2, "0")}`;
    if (!DOCTOR_CODE_SET.has(c)) return c;
  }
  return "W99";
}
