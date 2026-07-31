// Review-admission gate (LOOP-110, LOOP-89 Child A).
// Exported pure check function — called from cli-agentops.ts ticketUpdate before save_issue.
// Fail-open on EVERY failure path; a false refusal would strand a legitimately-merged ticket.
import { type ExecFn } from "./landing.ts";
import type { Workspace } from "./team-config.ts";
import { reposOfProject } from "./team-config.ts";

function extractGhRepo(remote: string): string | null {
  const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}

export interface AdmissionResult {
  admitted: boolean;
  message?: string;
  prNumber?: number;
  prState?: string;
}

// Core predicate: returns admitted=true (allow) or admitted=false + refusal message.
// All inputs are injected so callers (CLI) and tests (unit) can drive it without network.
// `workspace` null → fail-open (same as workspace-not-found).
export function checkReviewAdmission(opts: {
  ticketId: string;
  currentState: string;
  labels: string[];
  workspace: Workspace | null;
  projectKey: string;
  exec: ExecFn;
}): AdmissionResult {
  const { ticketId, currentState, labels, workspace, projectKey, exec } = opts;

  // Gate only the In Progress → In Review edge.
  if (currentState !== "In Progress") return { admitted: true };

  // Operator escape hatch: DEVLOOP_ADMIT_UNLANDED=1 forces admit.
  if (process.env["DEVLOOP_ADMIT_UNLANDED"]) return { admitted: true };

  // No workspace → fail-open (non-workspace invocation, or WsNotFound).
  if (!workspace) return { admitted: true };

  // Resolve which repo entry applies: via repo:<ref> label, else single-repo heuristic.
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  let ghRepo: string | null = null;

  if (repoLabel) {
    const ref = repoLabel.slice(5); // "repo:dev-loop" → "dev-loop"
    const entry = workspace.file.repos[ref];
    if (!entry || entry.landing !== "pr" || !entry.autoMerge) return { admitted: true }; // bypass: not pr+autoMerge
    ghRepo = entry.remote ? extractGhRepo(entry.remote) : null;
  } else {
    // Single-repo project: the one repo must be pr+autoMerge for the gate to apply.
    const projRepos = reposOfProject(workspace, projectKey);
    if (projRepos.length !== 1) return { admitted: true }; // multi-repo without label → bypass
    const ref = projRepos[0].ref;
    const entry = workspace.file.repos[ref];
    if (!entry || entry.landing !== "pr" || !entry.autoMerge) return { admitted: true };
    ghRepo = entry.remote ? extractGhRepo(entry.remote) : null;
  }

  if (!ghRepo) return { admitted: true }; // non-GitHub remote or no remote → fail-open

  // Probe the PR (branch convention: dev-loop/<ticketId>).
  let prState: string | null = null;
  let prNumber: number | null = null;
  try {
    const r = exec(["pr", "list", "--repo", ghRepo, "--head", `dev-loop/${ticketId}`, "--state", "all", "--json", "state,number", "--limit", "1"]);
    if (!r.ok) return { admitted: true }; // gh error → fail-open
    const prs = JSON.parse(r.stdout) as Array<{ state: string; number: number }>;
    if (prs.length === 0) return { admitted: true }; // no PR found → fail-open
    prState = prs[0].state;
    prNumber = prs[0].number;
  } catch {
    return { admitted: true }; // ENOENT (gh not installed) / exec error → fail-open
  }

  if (prState === "MERGED") return { admitted: true, prState, prNumber };

  const message = [
    `review-admission gate: In Progress → In Review refused — PR #${prNumber ?? "?"} for ${ticketId} is ${prState ?? "unknown"}, not MERGED.`,
    `Under autoMerge the green PR must merge first (§12c). Merge it (a later fire's Step 0.5 will, on green),`,
    `or if escalating a real defect use Cancel + a follow-up ticket (§21a) — that path is not gated.`,
  ].join("\n");
  return { admitted: false, message, prState: prState ?? undefined, prNumber: prNumber ?? undefined };
}
