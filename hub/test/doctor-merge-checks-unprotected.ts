// LOOP-407 AC4 — W38: `mergeChecks` configured on a default branch the forge does not protect.
//
// Why the check exists: with no branch protection there are no forge-side required checks, so
// `mergeChecks` is enforced ONLY by `dev-loop merge-guard` at Step 0.5. Measured 2026-08-06 —
// PR #246 merged during a GitHub Actions major_outage having run neither configured check, because
// a PR with zero queued checks presents `mergeStateStatus: CLEAN`. That is this workspace's standing
// state and it has now produced two incidents (LOOP-149 2026-07-31, LOOP-407 2026-08-06).
//
// Tested at the exported function seam with an injected exec — no real `gh` call, no network.
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { checkMergeChecksUnprotectedW38 } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import type { ExecFn } from "../src/landing.ts";
import { tmpRoot } from "./tmp-root.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

function makeWs(repo: Record<string, unknown>): ReturnType<typeof loadWorkspace> {
  const tmp = realpathSync(tmpRoot("dl-w38-"));
  mkdirSync(join(tmp, "clone"), { recursive: true });
  writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test",
    team: { key: "test", backend: "service", mode: "live" },
    repos: { repo: { path: "clone", ...repo } },
    projects: { test: { repos: [{ ref: "repo" }] } },
  }));
  return loadWorkspace(tmp);
}

const QUALIFYING = {
  remote: "https://github.com/test-org/test-repo.git",
  landing: "pr",
  autoMerge: true,
  mergeChecks: ["Test (Node 23.6.0)", "Test (Node 24)"],
};

// The forge's real answer for an unprotected branch: `gh api …/protection` exits non-zero with a
// 404 body. That exact string is the ONLY signal the check acts on.
const NOT_PROTECTED: ExecFn = () => ({ ok: false, stdout: `{"message":"Branch not protected","status":"404"}`, stderr: "gh: Not Found (HTTP 404)" });
const PROTECTED: ExecFn = () => ({ ok: true, stdout: `{"required_status_checks":{"contexts":["Test (Node 24)"]}}`, stderr: "" });

const collect = async (ws: ReturnType<typeof loadWorkspace>, exec: ExecFn): Promise<string[]> => {
  const out: string[] = [];
  await checkMergeChecksUnprotectedW38(ws, { exec }, (m) => out.push(m));
  return out;
};

// AC4 — the finding.
{
  const w = await collect(makeWs(QUALIFYING), NOT_PROTECTED);
  ok(w.length === 1 && /\[W38\]/.test(w[0]!), `AC4: mergeChecks + unprotected default branch ⇒ one [W38] warning (got ${w.length})`);
  ok(/Test \(Node 23\.6\.0\)/.test(w[0] ?? "") && /Test \(Node 24\)/.test(w[0] ?? ""),
    "AC4: …naming the configured checks that nothing enforces");
  ok(/merge-guard/.test(w[0] ?? ""), "AC4: …and naming merge-guard as the only remaining gate");
}

// The healthy case: a protected branch is silent.
{
  ok((await collect(makeWs(QUALIFYING), PROTECTED)).length === 0,
    "AC4: a PROTECTED default branch produces no warning");
}

// Non-qualifying repos are silent — the check is about the autoMerge+mergeChecks combination.
{
  ok((await collect(makeWs({ ...QUALIFYING, mergeChecks: [] }), NOT_PROTECTED)).length === 0,
    "AC4: no mergeChecks ⇒ nothing to enforce ⇒ no warning");
  ok((await collect(makeWs({ ...QUALIFYING, autoMerge: false }), NOT_PROTECTED)).length === 0,
    "AC4: autoMerge off ⇒ a human merges ⇒ no warning");
  ok((await collect(makeWs({ ...QUALIFYING, landing: "direct" }), NOT_PROTECTED)).length === 0,
    "AC4: landing:'direct' ⇒ no PR to merge ⇒ no warning");
  ok((await collect(makeWs({ ...QUALIFYING, remote: "git@gitlab.com:o/r.git" }), NOT_PROTECTED)).length === 0,
    "AC4: a non-GitHub remote has no protection API to consult ⇒ no warning");
}

// FAIL-OPEN on infrastructure, exactly like every other forge axis: only an explicit
// "Branch not protected" answer warns. A dead gh, an unreachable forge, or a 403 from a token
// without admin scope must stay silent — the guard never blocks on infrastructure.
{
  const dead: ExecFn = () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
  ok((await collect(makeWs(QUALIFYING), dead)).length === 0, "AC4: gh missing ⇒ silent (fail-open on infrastructure)");
  const forbidden: ExecFn = () => ({ ok: false, stdout: `{"message":"Must have admin rights to Repository.","status":"403"}`, stderr: "gh: Forbidden" });
  ok((await collect(makeWs(QUALIFYING), forbidden)).length === 0, "AC4: a 403 (no admin scope) ⇒ silent, not a false finding");
  const unreachable: ExecFn = () => ({ ok: false, stdout: "", stderr: "dial tcp: lookup api.github.com: no such host" });
  ok((await collect(makeWs(QUALIFYING), unreachable)).length === 0, "AC4: an unreachable forge ⇒ silent");
}

// The env escape hatch every other forge check honors.
{
  const prev = process.env.DEVLOOP_DOCTOR_NO_FORGE;
  process.env.DEVLOOP_DOCTOR_NO_FORGE = "1";
  const w = await collect(makeWs(QUALIFYING), NOT_PROTECTED);
  if (prev === undefined) delete process.env.DEVLOOP_DOCTOR_NO_FORGE; else process.env.DEVLOOP_DOCTOR_NO_FORGE = prev;
  ok(w.length === 0, "AC4: DEVLOOP_DOCTOR_NO_FORGE=1 skips the check, like W22");
}

console.log(fails === 0 ? "\nW38_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
