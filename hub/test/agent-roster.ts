// Unit coverage for the shared agent roster/group validator (agent-roster.ts). The bundle-load
// integration proof lives in bundle.ts (a tampered manifest.run.agents REFUSES + nothing
// materializes); this pins the pure decision directly — group expansion, roster membership, dedup,
// and the fail-closed rejects (unknown token, flag-smuggling `-…`, empty spec) LOOP-184 depends on.
import { parseAgentSpec, AGENT_GROUPS } from "../src/agent-roster.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

// group aliases expand to the documented rosters. Job-scoped prompts: pm/qa expand to their LANES
// (pm-maintenance/pm-groom/pm-review, qa-maintenance/qa-hunt) so the default run job-boots them; the
// bare `pm`/`qa` tokens stay valid as EXPLICIT inputs (below), just not in the default groups.
const CORE = ["pm-maintenance", "pm-groom", "pm-review", "qa-maintenance", "qa-hunt", "senior-dev", "junior-dev", "sweep"];
const LEGACY = ["pm-maintenance", "pm-groom", "pm-review", "qa-maintenance", "qa-hunt", "dev", "sweep"];
eq(parseAgentSpec("core"), CORE, "core expands to the split roster (pm/qa as lanes)");
eq(parseAgentSpec("legacy"), LEGACY, "legacy expands to the single-dev roster (pm/qa as lanes + dev)");
ok(parseAgentSpec("all")?.length === AGENT_GROUPS.all.length, "all expands to every agent");

// bare pm/qa are STILL valid explicit tokens (the whole-role classic-boot / comparison), and a bare
// lane token is accepted too (parity with run-agents.ts expandAgentSpec).
eq(parseAgentSpec("pm,qa"), ["pm", "qa"], "comma list of bare handles — the whole-role tokens stay valid");
eq(parseAgentSpec("pm-maintenance,qa-hunt"), ["pm-maintenance", "qa-hunt"], "bare pm/qa lane tokens are accepted explicit inputs");
eq(parseAgentSpec("senior-dev"), ["senior-dev"], "a hyphenated handle is one token, never read as a flag");
eq(parseAgentSpec("core,pm-maintenance,pm-maintenance"), CORE, "overlapping tokens de-dup (pm-maintenance already in core)");
eq(parseAgentSpec(" core , qa-hunt "), CORE, "surrounding whitespace + trailing tolerance (qa-hunt already in core)");

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

// ── LOOP-269 AC1: prototype-chain tokens REFUSE, they do not crash ────────────────────────────────
// AGENT_GROUPS was an ordinary object literal, so `AGENT_GROUPS[name]` resolved every Object.prototype
// key to an INHERITED value — truthy — and the `push(...)` spread then threw
// `TypeError: Spread syntax requires ...iterable`. On the bundle-load trust boundary that means the
// operator gets a stack trace instead of the die() naming run.agents: a refusal that cannot say what it
// refused. The table is null-prototype now, so there is no inherited key to find.
const PROTO_KEYS = ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty", "isPrototypeOf",
  "propertyIsEnumerable", "toLocaleString"];
for (const k of PROTO_KEYS) {
  let threw = "";
  let got: unknown = "unset";
  try { got = parseAgentSpec(k); } catch (e) { threw = (e as Error).message; }
  ok(!threw && got === null, `prototype key ${JSON.stringify(k)} ⇒ null, never a throw${threw ? ` (THREW ${threw})` : ` (got ${JSON.stringify(got)})`}`);
}
// mixed into an otherwise valid list — the pre-fix crash happened here too, so a valid prefix must not
// rescue it: one bad token refuses the WHOLE spec (same rule as "core,bogus" above).
for (const spec of ["core,constructor", "constructor,core", "pm,toString,qa"]) {
  let threw = "";
  let got: unknown = "unset";
  try { got = parseAgentSpec(spec); } catch (e) { threw = (e as Error).message; }
  ok(!threw && got === null, `prototype key mixed into a valid list ${JSON.stringify(spec)} ⇒ null, never a throw${threw ? ` (THREW ${threw})` : ` (got ${JSON.stringify(got)})`}`);
}
// The table itself has no prototype — this is what makes the property structural rather than a check
// each reader has to remember. run-agents.ts expandAgentSpec reads the SAME object the same way.
// This single assertion subsumes "AGENT_GROUPS[<some prototype key>] is undefined": with no prototype
// there is no inherited key for ANY reader to reach. Asserted this way on purpose — spelling the
// bracket-literal form out instead trips security/source_integrity.py's `function-constructor` rule,
// which exists to catch exactly the `obj[<that key>][<that key>]("code")()` escape, and a test is not
// a reason to teach that scanner an exception. The behavioural half is the PROTO_KEYS loop above,
// which drives the same lookup through parseAgentSpec.
ok(Object.getPrototypeOf(AGENT_GROUPS) === null, "AGENT_GROUPS has a null prototype (no inherited key is reachable by ANY reader)");

// TOTALITY: no string input makes parseAgentSpec throw. The list mixes the prototype keys with the
// shapes a corrupt/tampered manifest realistically carries.
for (const spec of [...PROTO_KEYS, "", " ", ",", ",,,", "core", "core,,qa", "__proto__,core", "-",
  "--force", "\u0000", "a".repeat(5000), "core,__proto__,qa", "constructor,constructor"]) {
  let threw = "";
  try { parseAgentSpec(spec); } catch (e) { threw = (e as Error).message; }
  ok(!threw, `no throw for ${JSON.stringify(spec.length > 24 ? `${spec.slice(0, 24)}…` : spec)}${threw ? ` (THREW ${threw})` : ""}`);
}

console.log(fails ? `agent-roster: ${fails} FAILED` : "agent-roster: all checks passed");
process.exit(fails ? 1 : 0);
