// P8 portability — the identity contract that EVERY CLI must satisfy: the per-agent identity the
// hub attributes writes to is exactly what the launcher set in DEVLOOP_ACTOR. `identity-check`
// reflects the process env (the launcher-side check); the fail-closed gate refuses an unknown actor
// (the same G1 guard the server enforces at startup) so a mis-wired launcher can't write unattributably.
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DB = "/tmp/hub-identity/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// seed actors + a project so actor-existence can be checked
execFileSync("node", ["src/seed.ts", "idp", "Identity Project", "ID", DB], { encoding: "utf8" });

function check(actor: string | null): { code: number; data: any } {
  const env: Record<string, string> = { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "idp" };
  if (actor) env.DEVLOOP_ACTOR = actor; else delete env.DEVLOOP_ACTOR;
  try {
    const out = execFileSync("node", ["src/server.ts", "identity-check"], { env, encoding: "utf8" });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, data: JSON.parse(err.stdout || "{}") };
  }
}

// a launcher that sets DEVLOOP_ACTOR=dev → the hub resolves + would attribute to 'dev'
const dev = check("dev");
ok(dev.code === 0 && dev.data.actor === "dev" && dev.data.actorKnown === true && dev.data.wouldStart === true, "DEVLOOP_ACTOR=dev → resolves to dev, known, would start (the contract every CLI must satisfy)");

// the fail-closed gate: an UNKNOWN actor (a mis-wired launcher / a CLI that injected garbage) is refused
const ghost = check("ghost");
ok(ghost.code === 1 && ghost.data.actorKnown === false && ghost.data.wouldStart === false, "an unknown DEVLOOP_ACTOR → exit 1, would NOT start (fail-closed; no unattributable writes)");

// no DEVLOOP_ACTOR → defaults to 'operator' (a seeded human actor) — detectable as NOT a per-agent pane
const none = check(null);
ok(none.code === 0 && none.data.actor === "operator", "unset DEVLOOP_ACTOR → defaults to operator (a CLI that fails to propagate shows 'operator', not the intended agent — the mis-attribution signal)");

// the secret-free shape: identity-check never emits anything but the resolved names + booleans
ok(!JSON.stringify(dev.data).match(/token|secret|key/i), "identity-check output carries no secret-ish field");

// --expect catches a WRONG-but-VALID actor (the mis-attribution gap Codex named) — not just unknown/unset
function checkExpect(actor: string, expect: string): { code: number; data: any } {
  const env: Record<string, string> = { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "idp", DEVLOOP_ACTOR: actor };
  try { return { code: 0, data: JSON.parse(execFileSync("node", ["src/server.ts", "identity-check", "--expect", expect], { env, encoding: "utf8" })) }; }
  catch (e) { const err = e as { status?: number; stdout?: string }; return { code: err.status ?? -1, data: JSON.parse(err.stdout || "{}") }; }
}
const mism = checkExpect("qa", "dev"); // qa is a VALID actor but NOT the intended 'dev'
ok(mism.code === 1 && mism.data.matchesExpectation === false, "identity-check --expect dev with DEVLOOP_ACTOR=qa → exit 1 (catches a wrong-but-valid mis-attribution, not just unknown)");
const matchExp = checkExpect("dev", "dev");
ok(matchExp.code === 0 && matchExp.data.pass === true, "identity-check --expect dev with DEVLOOP_ACTOR=dev → pass");

console.log(fails === 0 ? "\nIDENTITY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
