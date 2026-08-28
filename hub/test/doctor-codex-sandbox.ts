// doctor-codex-sandbox.ts — W45 (WS-A C4, review 1): the codex lane on the SAFE default.
//
// Since WS-A the scheduler adds `--dangerously-bypass-approvals-and-sandbox` only on an explicit
// "bypass". Under the default `codex exec` runs approval:never + sandbox:read-only (codex-cli 0.147.0
// prints exactly those header lines), so an unattended fire's write-shaped tool calls are refused, the
// model ends its turn, the process exits 0 with a non-empty JSONL stream — and the ledger records a
// SUCCESS. The breaker never trips; W44 never fires. W45 is the only thing that says so, from config.
//
// Arms: (1) no codex routing ⇒ silent; (2) routed by an enabled project's agents.<h>.codingAgent with the
// posture unset ⇒ W45 naming the handle, the key and both choices; (3) team.codex.sandbox set (either value)
// ⇒ pass; (4) every routed handle pinned per-agent (team.agents.<h>.codexSandbox — the key the scheduler DOES
// read) ⇒ pass; (5) routed by a project/team defaultCodingAgent ⇒ every handle without its own codingAgent
// is on the default; a disabled project routes nothing; team.agents.<h>.codingAgent routes NOTHING (the
// scheduler's launch-profile resolver does not read it — verified by dry-run, see codexRoutedHandles);
// (6) the registry carries the row and doctor-codes registers the code.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCodexSandboxDefault } from "../src/doctor.ts";
import { loadWorkspace, codexRoutedHandles, codexSandboxUnpinned } from "../src/team-config.ts";
import { DOCTOR_CHECKS } from "../src/doctor-registry.ts";
import { DOCTOR_CODE_SET } from "../src/doctor-codes.ts";
import { AGENT_HANDLES } from "../src/seed.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-w45-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

let n = 0;
function wsWith(team: Record<string, unknown>, projects: Record<string, unknown> = {}) {
  const root = join(tmp, `ws${++n}`);
  mkdirSync(join(root, ".dev-loop"), { recursive: true });
  mkdirSync(join(root, "repo"), { recursive: true });
  writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: `w45-${n}`, backend: "service", ...team },
    repos: { repo: { path: "repo" } },
    projects,
  }));
  return loadWorkspace(root);
}
function runCheck(ws: ReturnType<typeof loadWorkspace>) {
  const passes: string[] = [], warns: string[] = [];
  checkCodexSandboxDefault(ws, (m) => passes.push(m), (m) => warns.push(m));
  return { passes, warns };
}

try {
  // ── 1. no codex routing anywhere ⇒ silent (like W15: the check engages only when the config targets the lane)
  {
    const r = runCheck(wsWith({}, { loop: { prefix: "LOOP", repos: [{ ref: "repo" }] } }));
    ok(r.passes.length === 0 && r.warns.length === 0, "W45: a workspace that routes nothing to codex prints nothing (neither pass nor warn)");
  }

  // ── 2. routed by an enabled project's agents.<h>.codingAgent, posture unset ⇒ W45
  const LOOP = { prefix: "LOOP", repos: [{ ref: "repo" }] };
  {
    const ws = wsWith({}, { loop: { ...LOOP, agents: { sweep: { codingAgent: "codex" } } } });
    const r = runCheck(ws);
    ok(r.warns.length === 1 && /^\[W45\]/.test(r.warns[0]), "W45: projects.loop.agents.sweep.codingAgent=codex with team.codex.sandbox unset warns");
    ok(/sweep \(via projects\.loop\.agents\.sweep\.codingAgent\)/.test(r.warns[0] ?? ""), "W45: the warning names the handle AND where its codex routing comes from");
    ok(/team\.codex\.sandbox is unset/.test(r.warns[0] ?? "") && /team set team\.codex\.sandbox bypass/.test(r.warns[0] ?? "") && /team set team\.codex\.sandbox safe/.test(r.warns[0] ?? ""),
      "W45: the warning names the key and BOTH choices as `team set` commands");
    ok(/approval:never sandbox:read-only/.test(r.warns[0] ?? "") && /exits 0/.test(r.warns[0] ?? ""),
      "W45: the warning states the mechanism — approval:never + read-only sandbox, and that the fire still exits 0");
    ok(codexSandboxUnpinned(ws, AGENT_HANDLES).map((x) => x.handle).join() === "sweep", "W45 predicate: codexSandboxUnpinned lists exactly the unpinned routed handle");
  }

  // ── 3. team.codex.sandbox set ⇒ pass, either value (an explicit "safe" is the operator's choice)
  for (const sandbox of ["bypass", "safe"] as const) {
    const r = runCheck(wsWith({ codex: { sandbox } }, { loop: { ...LOOP, agents: { sweep: { codingAgent: "codex" } } } }));
    ok(r.warns.length === 0 && r.passes.length === 1 && new RegExp(`team\\.codex\\.sandbox="${sandbox}"`).test(r.passes[0]),
      `W45: team.codex.sandbox="${sandbox}" pins the posture — pass, no warning`);
  }

  // ── 4. every routed handle pinned per-agent (team.agents.<h>.codexSandbox) ⇒ pass; one unpinned sibling
  //      ⇒ warn names ONLY the sibling. team.agents.<h>.codingAgent alone routes NOTHING (see header).
  {
    const pinned = runCheck(wsWith({ agents: { sweep: { codexSandbox: "bypass" } } }, { loop: { ...LOOP, agents: { sweep: { codingAgent: "codex" } } } }));
    ok(pinned.warns.length === 0 && pinned.passes.length === 1 && /agents\.<h>\.codexSandbox on every routed handle/.test(pinned.passes[0]),
      "W45: team.agents.sweep.codexSandbox pins the only routed handle — pass");
    const mixed = runCheck(wsWith({ agents: { sweep: { codexSandbox: "bypass" } } }, { loop: { ...LOOP, agents: { sweep: { codingAgent: "codex" }, ops: { codingAgent: "codex" } } } }));
    ok(mixed.warns.length === 1 && /ops \(via/.test(mixed.warns[0]) && !/sweep/.test(mixed.warns[0]),
      "W45: with one handle pinned and one not, the warning names only the unpinned one");
    const teamAgentsOnly = wsWith({ agents: { sweep: { codingAgent: "codex" } } }, { loop: LOOP });
    ok(codexRoutedHandles(teamAgentsOnly, AGENT_HANDLES).length === 0 && runCheck(teamAgentsOnly).warns.length === 0,
      "W45 routing: team.agents.sweep.codingAgent=codex routes nothing — the scheduler's launch-profile resolver does not read it (an honest silence, not a false warning)");
  }

  // ── 5. project-scope routing: defaultCodingAgent=codex on an ENABLED project puts every handle without
  //      its own codingAgent on the default; a disabled project routes nothing; a project-scope per-agent
  //      override routes just that handle.
  {
    const ws = wsWith({}, { loop: { prefix: "LOOP", repos: [{ ref: "repo" }], defaultCodingAgent: "codex", agents: { qa: { codingAgent: "claude" } } } });
    const routed = codexRoutedHandles(ws, AGENT_HANDLES);
    ok(routed.length === AGENT_HANDLES.length - 1 && !routed.some((r) => r.handle === "qa") && routed.every((r) => r.via === "projects.loop.defaultCodingAgent"),
      "W45 routing: projects.loop.defaultCodingAgent=codex routes every handle except the one with its own codingAgent");
    const r = runCheck(ws);
    ok(r.warns.length === 1 && /via projects\.loop\.defaultCodingAgent/.test(r.warns[0]) && !/\bqa\b/.test(r.warns[0]), "W45: a project-level codex default warns and excludes the claude-pinned handle");
    const disabled = wsWith({}, { loop: { prefix: "LOOP", repos: [{ ref: "repo" }], enabled: false, defaultCodingAgent: "codex" } });
    ok(codexRoutedHandles(disabled, AGENT_HANDLES).length === 0 && runCheck(disabled).warns.length === 0, "W45 routing: a DISABLED project's codex default routes nothing (its fires never launch)");
    const perAgent = wsWith({}, { loop: { prefix: "LOOP", repos: [{ ref: "repo" }], agents: { "junior-dev": { codingAgent: "codex" } } } });
    const pa = codexRoutedHandles(perAgent, AGENT_HANDLES);
    ok(pa.length === 1 && pa[0].handle === "junior-dev" && pa[0].via === "projects.loop.agents.junior-dev.codingAgent", "W45 routing: a project-scope agents.<h>.codingAgent=codex routes exactly that handle");
    const teamDefault = wsWith({ defaultCodingAgent: "codex" }, { loop: LOOP });
    ok(codexRoutedHandles(teamDefault, AGENT_HANDLES).length === AGENT_HANDLES.length && codexRoutedHandles(teamDefault, AGENT_HANDLES).every((r) => r.via === "team.defaultCodingAgent"),
      "W45 routing: team.defaultCodingAgent=codex (merged into an enabled project) routes every handle via the team default");
    ok(codexRoutedHandles(wsWith({ defaultCodingAgent: "codex" }), AGENT_HANDLES).length === 0,
      "W45 routing: team.defaultCodingAgent=codex with NO enabled project routes nothing (nothing can fire)");
  }

  // ── 6. registry + namespace: the check is a DOCTOR_CHECKS row, workspace-scope, and W45 is registered
  {
    const row = DOCTOR_CHECKS.find((c) => c.id === "w45-codex-sandbox-default");
    ok(!!row && row.scope === "workspace" && row.codes.includes("W45"), "W45: registered as a workspace-scope DOCTOR_CHECKS row carrying the code");
    ok(DOCTOR_CODE_SET.has("W45"), "W45: the code is registered in doctor-codes.ts (the LOOP-88 namespace)");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nDOCTOR_CODEX_SANDBOX_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
