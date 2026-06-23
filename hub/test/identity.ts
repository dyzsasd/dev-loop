// P8 portability — the identity contract that EVERY CLI must satisfy: the per-agent identity the
// hub attributes writes to is exactly what the launcher set in DEVLOOP_ACTOR. `identity-check`
// reflects the process env (the launcher-side check); the fail-closed gate refuses an unknown actor
// (the same G1 guard the server enforces at startup) so a mis-wired launcher can't write unattributably.
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

// ─── DL-6: an empty-string assignee must never be stored verbatim ─────────────
// save_issue keyed its actor-existence guard on truthiness, so assignee:"" slipped
// past it (whitespace + unknown handles are correctly rejected) and was stored as
// "" — an unattributable non-actor limbo value, violating the "assignee is always
// null or a known actor handle" invariant this suite guards. It must normalize to
// null (the documented "null clears" semantics) on BOTH create and update.
async function hub(actor: string): Promise<Client> {
  const c = new Client({ name: `idtest-${actor}`, version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "idp", DEVLOOP_HUB_DB: DB },
  }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any }> {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: !r.isError, data };
}

const devc = await hub("dev");

// create with assignee:"" → normalized to null, NOT stored verbatim as ""
const created = await call(devc, "save_issue", { title: "DL-6 empty-assignee create", type: "Bug", labels: ["dev-loop", "Bug", "qa"], assignee: "" });
ok(created.ok && created.data.assignee === null, `save_issue create assignee:"" → stored as null, not "" (got ${JSON.stringify(created.data?.assignee)})`);
const cid = created.data.id;

// update path: a valid assignee must not be clobbered to "" — "" clears it to null
await call(devc, "save_issue", { id: cid, assignee: "qa" });
const cleared = await call(devc, "save_issue", { id: cid, assignee: "" });
ok(cleared.ok && cleared.data.assignee === null, `save_issue update assignee "qa"→"" → cleared to null, not "" (got ${JSON.stringify(cleared.data?.assignee)})`);

// controls — unchanged: whitespace-only + unknown handles stay REJECTED
const ws = await call(devc, "save_issue", { id: cid, assignee: "  " });
ok(!ws.ok, 'save_issue assignee:"  " (whitespace) → still rejected (unchanged control)');
const unk = await call(devc, "save_issue", { id: cid, assignee: "hacker" });
ok(!unk.ok, 'save_issue assignee:"hacker" (unknown) → still rejected (unchanged control)');

// and a real claim still resolves to the acting actor
const claimed = await call(devc, "save_issue", { id: cid, assignee: "me" });
ok(claimed.ok && claimed.data.assignee === "dev", 'save_issue assignee:"me" → resolves to the acting actor (dev)');

await devc.close();

console.log(fails === 0 ? "\nIDENTITY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
