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
