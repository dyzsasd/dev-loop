// Unit coverage for the shared agent roster/group validator (agent-roster.ts). The bundle-load
// integration proof lives in bundle.ts (a tampered manifest.run.agents REFUSES + nothing
// materializes); this pins the pure decision directly — group expansion, roster membership, dedup,
// and the fail-closed rejects (unknown token, flag-smuggling `-…`, empty spec) LOOP-184 depends on.
import { parseAgentSpec, AGENT_GROUPS } from "../src/agent-roster.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

// group aliases expand to the documented rosters
eq(parseAgentSpec("core"), ["pm", "qa", "senior-dev", "junior-dev", "sweep"], "core expands to the split roster");
eq(parseAgentSpec("legacy"), ["pm", "qa", "dev", "sweep"], "legacy expands to the single-dev roster");
ok(parseAgentSpec("all")?.length === AGENT_GROUPS.all.length, "all expands to every agent");

// bare handles + comma lists + dedup + whitespace tolerance (mirrors the run --agents parser)
eq(parseAgentSpec("pm,qa"), ["pm", "qa"], "comma list of bare handles");
eq(parseAgentSpec("senior-dev"), ["senior-dev"], "a hyphenated handle is one token, never read as a flag");
eq(parseAgentSpec("core,pm,pm"), ["pm", "qa", "senior-dev", "junior-dev", "sweep"], "overlapping tokens de-dup");
eq(parseAgentSpec(" core , qa "), ["pm", "qa", "senior-dev", "junior-dev", "sweep"], "surrounding whitespace + trailing tolerance");

// fail-closed rejects (LOOP-184): every one returns null so the caller REFUSES the load
ok(parseAgentSpec("bogus-agent") === null, "unknown agent ⇒ null");
ok(parseAgentSpec("core,bogus") === null, "one unknown token in a list ⇒ null");
ok(parseAgentSpec("--force") === null, "a --flag ⇒ null (never smuggled into the run argv)");
ok(parseAgentSpec("-x") === null, "a -short-flag ⇒ null");
ok(parseAgentSpec("core,--agents=evil") === null, "a flag hidden after a valid token ⇒ null");
ok(parseAgentSpec("") === null, "empty spec ⇒ null");
ok(parseAgentSpec("   ") === null, "whitespace-only spec ⇒ null");
ok(parseAgentSpec(",") === null, "a lone comma ⇒ null");
ok(parseAgentSpec(undefined as unknown as string) === null, "a non-string ⇒ null (defensive)");

console.log(fails ? `agent-roster: ${fails} FAILED` : "agent-roster: all checks passed");
process.exit(fails ? 1 : 0);
