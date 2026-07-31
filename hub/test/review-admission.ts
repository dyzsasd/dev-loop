// §15 unit tests for the review-admission gate (LOOP-110, LOOP-89 Child A).
// One test per predicate row; all network calls go through an injectable ExecFn — NO live network.
import { checkReviewAdmission, type AdmissionResult } from "../src/review-admission.ts";
import type { ExecFn } from "../src/landing.ts";
import type { Workspace } from "../src/team-config.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ─── helpers ─────────────────────────────────────────────────────────────────
// Workspace with one repo whose landing/autoMerge are configurable.
function fakeWs(landing: "pr" | "direct", autoMerge: boolean): Workspace {
  return {
    root: "/fake",
    filePath: "/fake/dev-loop.json",
    warnings: [],
    file: {
      schemaVersion: 2,
      team: { key: "loop", name: "T", backend: "service" } as unknown as Workspace["file"]["team"],
      repos: { "dev-loop": { path: ".", remote: "git@github.com:owner/dev-loop.git", landing, autoMerge } },
      projects: { loop: { repos: [{ ref: "dev-loop" }] } } as Workspace["file"]["projects"],
    },
  };
}

// ExecFn that returns a gh pr list response with the given state (or an empty list if no state).
const prExec = (state: string | null, number = 42): ExecFn => (args) => {
  // Argv validation: must include --json state,number (LOOP-121 lesson: double the test doubles)
  const jsonIdx = args.indexOf("--json");
  if (jsonIdx === -1 || args[jsonIdx + 1] !== "state,number") {
    return { stdout: "", stderr: "unexpected --json fields", ok: false };
  }
  const body = state === null ? "[]" : JSON.stringify([{ state, number }]);
  return { stdout: body, stderr: "", ok: true };
};

const errorExec: ExecFn = () => { throw new Error("ENOENT: gh not found"); };
const badExitExec: ExecFn = () => ({ stdout: "", stderr: "gh error", ok: false });

const PR_WS = fakeWs("pr", true);
const DIRECT_WS = fakeWs("direct", false);
const PR_NO_AUTO_WS = fakeWs("pr", false);

const base = { ticketId: "LOOP-13", currentState: "In Progress", labels: [], projectKey: "loop" };

// ─── AC1: OPEN PR with failed checks (LOOP-13/14 shape) → REFUSED ────────────
{
  const r = checkReviewAdmission({ ...base, workspace: PR_WS, exec: prExec("OPEN") });
  ok(!r.admitted, "AC1: OPEN PR (concluded-red) → refused");
  ok(!!(r.message?.includes("LOOP-13") && r.message?.includes("OPEN") && r.message?.includes("not MERGED")), "AC1: refusal message names the ticket id, state, and MERGED");
}

// ─── AC2: OPEN/CONFLICTING PR with no checks ran (LOOP-19/#54 shape) → REFUSED ─
// gh pr list returns state:"OPEN" even for CONFLICTING — absent checks still refuse.
{
  const r = checkReviewAdmission({ ...base, ticketId: "LOOP-19", workspace: PR_WS, exec: prExec("OPEN", 54) });
  ok(!r.admitted, "AC2: OPEN/CONFLICTING (no checks ran) → refused (absent check fails closed)");
  ok(r.prNumber === 54, "AC2: prNumber captured from gh response");
}

// ─── AC3: OPEN PR with pending checks → REFUSED ──────────────────────────────
{
  const r = checkReviewAdmission({ ...base, ticketId: "LOOP-26", workspace: PR_WS, exec: prExec("OPEN", 55) });
  ok(!r.admitted, "AC3: OPEN PR (checks pending) → refused");
}

// ─── AC4: MERGED PR (LOOP-43/#38 shape) → ADMITTED ──────────────────────────
{
  const r = checkReviewAdmission({ ...base, ticketId: "LOOP-43", workspace: PR_WS, exec: prExec("MERGED", 38) });
  ok(r.admitted, "AC4: MERGED PR → admitted");
  ok(r.prState === "MERGED" && r.prNumber === 38, "AC4: admitted result carries MERGED state and PR number");
}

// ─── AC5: landing:"direct" → ADMITTED (bypass, no probe) ─────────────────────
{
  let probed = false;
  const trackExec: ExecFn = (args) => { probed = true; return prExec("OPEN")(args); };
  const r = checkReviewAdmission({ ...base, workspace: DIRECT_WS, exec: trackExec });
  ok(r.admitted, "AC5: landing:'direct' workspace → admitted (bypass)");
  ok(!probed, "AC5: no gh probe fired for a direct-landing repo");
}

// ─── AC6: landing:"pr" + autoMerge:false → ADMITTED (bypass) ─────────────────
{
  const r = checkReviewAdmission({ ...base, workspace: PR_NO_AUTO_WS, exec: prExec("OPEN") });
  ok(r.admitted, "AC6: landing:'pr' + autoMerge:false → admitted (bypass; §12b human-merge)");
}

// ─── AC7: failure paths → ADMITTED (fail-open) ───────────────────────────────
{
  const noGh = checkReviewAdmission({ ...base, workspace: PR_WS, exec: errorExec });
  ok(noGh.admitted, "AC7a: gh missing (ENOENT) → admitted (fail-open)");

  const ghErr = checkReviewAdmission({ ...base, workspace: PR_WS, exec: badExitExec });
  ok(ghErr.admitted, "AC7b: gh non-zero exit → admitted (fail-open)");

  const noPr = checkReviewAdmission({ ...base, workspace: PR_WS, exec: prExec(null) });
  ok(noPr.admitted, "AC7c: no PR found → admitted (fail-open)");

  const noWs = checkReviewAdmission({ ...base, workspace: null, exec: prExec("OPEN") });
  ok(noWs.admitted, "AC7d: workspace null → admitted (fail-open)");
}

// ─── AC8: DEVLOOP_ADMIT_UNLANDED=1 → ADMITTED ────────────────────────────────
{
  process.env["DEVLOOP_ADMIT_UNLANDED"] = "1";
  const r = checkReviewAdmission({ ...base, workspace: PR_WS, exec: prExec("OPEN") });
  ok(r.admitted, "AC8: DEVLOOP_ADMIT_UNLANDED=1 → admitted (escape hatch)");
  delete process.env["DEVLOOP_ADMIT_UNLANDED"];
}

// ─── AC9: refusal only on In Progress → In Review edge ───────────────────────
// Any currentState other than "In Progress" must bypass (the save_issue write is not gated).
for (const state of ["Todo", "Backlog", "In Review", "Done", "Canceled", "Blocked"]) {
  const r = checkReviewAdmission({ ...base, currentState: state, workspace: PR_WS, exec: prExec("OPEN") });
  ok(r.admitted, `AC9: currentState='${state}' → admitted (gate fires only on In Progress→In Review)`);
}

console.log(fails === 0 ? "\nREVIEW_ADMISSION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
