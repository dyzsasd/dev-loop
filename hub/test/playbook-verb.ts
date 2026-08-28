// job-scoped prompts (docs/design/job-scoped-prompts.md) — the PULL half of job-scoped delivery.
//
// `dev-loop playbook <agent> <job>` prints the BYTE-IDENTICAL slice a pushed (agent, job) fire loads:
// skills/_constitution.md + the job span + the shared playbooks it pulls. The push and pull paths MUST
// agree exactly (the "one authority" invariant) — a drift would mean an agent reading a different playbook
// mid-fire than the one its fire booted with. This suite pins: (1) pushed ≡ pulled, byte-for-byte;
// (2) an unknown job / unknown agent is refused cleanly (exit 1); (3) missing args → usage (exit 2);
// (4) process.exitCode (not process.exit) so a piped slice never truncates (LOOP-346); (5) --json shape.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleJobCorpus } from "../src/boot-prefix.ts";
import { pluginRoot } from "../src/context-bill.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = pluginRoot(); // the plugin payload root: skills/ + references/ live here
const verb = join(hubRoot, "src", "playbook-verb.ts");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// Spawn the verb, capturing stdout + exit code. stderr is the accounting line (kept off stdout for piping).
// Env is SCRUBBED of the fire/workspace markers by default (extra overrides applied on top), so the verb
// deterministically resolves NO workspace here — the pushed ≡ pulled checks below stay cheat-only regardless
// of ambient env; the lessons block passes DEVLOOP_WORKSPACE explicitly to opt one in.
const run = (args: string[], extraEnv: Record<string, string | undefined> = {}): { out: string; code: number } => {
  try {
    const out = execFileSync(process.execPath, [verb, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: { ...scrubFireEnv(), ...extraEnv } });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { out: err.stdout ?? "", code: err.status ?? 1 };
  }
};

// ── 1. pushed ≡ pulled, byte-for-byte, for every pm job ──────────────────────────────────────────────
for (const job of ["verify", "unblock", "groom", "review"]) {
  const pushed = assembleJobCorpus(root, "pm", job);
  const r = run(["pm", job, "--root", root]);
  ok(r.code === 0 && !!pushed && r.out.trimEnd().endsWith(pushed.text.trimEnd()) && r.out.includes(pushed.text.trim()),
    `pull 'pm ${job}' prints the byte-identical pushed corpus (exit ${r.code})`);
  ok(!!pushed && r.out.includes("skills/_constitution.md") && r.out.includes(`job:${job}`),
    `pull 'pm ${job}' carries the constitution + the ${job} job span`);
}

// ── 2. --json shape carries the exact corpus text + its hash/bytes ───────────────────────────────────
{
  const pushed = assembleJobCorpus(root, "pm", "verify");
  const j = JSON.parse(run(["pm", "verify", "--root", root, "--json"]).out) as { agent: string; job: string; bytes: number; hash: string; text: string };
  ok(!!pushed && j.text === pushed.text && j.hash === pushed.hash && j.bytes === pushed.bytes,
    "--json emits the exact corpus text + hash + bytes of the pushed slice");
  ok(j.text.length > 1000, `--json text is the full slice, not truncated by the exit (${j.text.length} chars)`);
}

// ── 3. unknown job / unknown agent / missing args are refused cleanly ────────────────────────────────
{
  const badJob = run(["pm", "nope", "--root", root]);
  ok(badJob.code === 1, `an unknown job is refused (exit ${badJob.code})`);
  const badAgent = run(["ghost", "verify", "--root", root]);
  ok(badAgent.code === 1, `an unknown agent is refused (exit ${badAgent.code})`);
  const missing = run(["pm", "--root", root]);
  ok(missing.code === 2, `missing <job> → usage exit 2 (got ${missing.code})`);
  const help = run(["--help"]);
  ok(help.code === 0 && /dev-loop playbook <agent> <job>/.test(help.out), `--help prints usage and exits 0 (got ${help.code})`);
}

// ── 4. the verb prints the agent CLI cheat-sheet (always) and this project's §14 lessons (with a workspace) ──
// The mechanism fix: a job corpus carries the cheat-sheet + the §14 lessons slice. The cheat block comes
// from the SKILL (no workspace needed); the lessons come from the resolved workspace, so the pull verb must
// resolve the SAME workspace the pushed fire did → pushed ≡ pulled byte-for-byte WITH lessons.
{
  // cheat is present with NO workspace (scrubbed env above).
  const noWs = run(["pm", "verify", "--root", root]);
  ok(noWs.code === 0 && noWs.out.includes("### CLI cheat-sheet (exact verb forms + exit codes)") && noWs.out.includes("<!-- cli-cheatsheet:begin agent=pm -->"),
    "the verb prints the agent's CLI cheat-sheet block even with no workspace resolved");

  // Build a fixture workspace with §14 lessons, point the verb at it via DEVLOOP_WORKSPACE + DEVLOOP_PROJECT.
  const wsRoot = realpathSync(mkdtempSync(join(tmpdir(), "dl-pv-lessons-")));
  try {
    mkdirSync(join(wsRoot, "repo"), { recursive: true });
    mkdirSync(join(wsRoot, ".dev-loop", "lessons"), { recursive: true });
    writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, workspaceId: "pv-lessons", team: { key: "pv", backend: "service" },
      repos: { repo: { path: "repo" } }, projects: { proj1: { repos: [{ ref: "repo", role: "primary" }] } },
    }));
    writeFileSync(join(wsRoot, ".dev-loop", "lessons", "INDEX.md"),
      ["# INDEX", "", "## Shared", "- SENTINEL_PV_SHARED shared rule", "", "## PM", "- SENTINEL_PV_PM pm rule", ""].join("\n") + "\n");
    writeFileSync(join(wsRoot, ".dev-loop", "lessons", "proj1.md"),
      ["# proj1", "", "## PM", "- SENTINEL_PV_SHARD_PM shard pm rule", "", "## QA", "- SENTINEL_PV_QA qa rule (other role — excluded)", ""].join("\n") + "\n");

    const env = { DEVLOOP_WORKSPACE: wsRoot, DEVLOOP_PROJECT: "proj1" };
    const withWs = run(["pm", "verify", "--root", root], env);
    ok(withWs.code === 0 && withWs.out.includes("### lessons — your section + ## Shared") && withWs.out.includes("SENTINEL_PV_SHARED") && withWs.out.includes("SENTINEL_PV_PM") && withWs.out.includes("SENTINEL_PV_SHARD_PM"),
      "the verb prints this project's §14 lessons (INDEX + shard) when a workspace resolves");
    ok(withWs.code === 0 && !withWs.out.includes("SENTINEL_PV_QA"), "the verb's lessons slice excludes other roles (pm gets no ## QA)");
    ok(withWs.code === 0 && withWs.out.includes("### CLI cheat-sheet (exact verb forms + exit codes)"), "the verb still prints the cheat-sheet alongside lessons");

    // pushed ≡ pulled WITH lessons: the pushed corpus for the SAME (agent, job, workspace) is byte-identical
    // to the verb's slice (the one-authority invariant, now including the §14 lessons + cheat).
    const pushed = assembleJobCorpus(root, "pm", "verify", join(wsRoot, ".dev-loop"), "proj1");
    ok(!!pushed && withWs.out.trimEnd().endsWith(pushed.text.trimEnd()) && withWs.out.includes(pushed.text.trim()),
      "pull 'pm verify' with a workspace is byte-identical to the pushed job corpus (lessons + cheat included)");
    ok(!!pushed && pushed.lessonsBytes > 0, `the pushed corpus's lessonsBytes is the real injected count (>0) (got ${pushed?.lessonsBytes})`);
  } finally { rmSync(wsRoot, { recursive: true, force: true }); }
}

console.log(fails === 0 ? "\nPLAYBOOK_VERB_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
