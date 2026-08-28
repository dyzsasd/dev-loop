// LOOP-88 — the W-code namespace has a registry, and a collision is a TEST FAILURE.
//
// Two consecutive design gates had to hand-reassign a code (LOOP-74 vs LOOP-56, LOOP-81 vs LOOP-41),
// and a third collision (LOOP-82 taking W02, already held by the repo-registry validator) was caught
// while writing the registry. All three were caught by a human reading. Nothing caught them at merge
// time, and nothing at all catches a collision between two tickets that never share a gate.
//
// Two assertions, both mechanical:
//   1. the registry has no duplicate code;
//   2. every W-code literal anywhere in hub/src is registered — so a check cannot ship under an
//      unregistered (and therefore possibly colliding) code.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR_CODES, DOCTOR_CODE_SET, nextFreeDoctorCode } from "../src/doctor-codes.ts";
import { openDb } from "../src/db.ts";
import { checkBlockedNoBailShape } from "../src/doctor.ts";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// 1. no duplicates
const seen = new Map<string, string>();
const dups: string[] = [];
for (const row of DOCTOR_CODES) {
  const prev = seen.get(row.code);
  if (prev) dups.push(`${row.code}: '${prev}' vs '${row.name}'`);
  else seen.set(row.code, row.name);
}
ok(dups.length === 0, `LOOP-88: the registry has no duplicate code${dups.length ? ` — ${dups.join("; ")}` : ""}`);

// 2. every emitted code is registered.
// Both spellings the codebase uses: the rendered `[W##]` prefix (doctor.ts) and the `"W##"` code
// argument the config/lessons validators pass to their emit callback.
const emitted = new Map<string, string[]>();
for (const f of readdirSync(srcDir)) {
  if (!f.endsWith(".ts") || f === "doctor-codes.ts") continue;
  const text = readFileSync(join(srcDir, f), "utf8");
  for (const m of text.matchAll(/\[(W\d{2})\]|"(W\d{2})"/g)) {
    const code = m[1] ?? m[2];
    if (!code) continue;
    const files = emitted.get(code) ?? [];
    if (!files.includes(f)) files.push(f);
    emitted.set(code, files);
  }
}
const unregistered = [...emitted.entries()].filter(([c]) => !DOCTOR_CODE_SET.has(c));
ok(unregistered.length === 0,
  `LOOP-88: every W-code emitted in hub/src is registered${unregistered.length ? ` — unregistered: ${unregistered.map(([c, f]) => `${c} (${f.join(",")})`).join("; ")}` : ""}`);

// A code claimed by two DIFFERENT source files is the collision shape that shipped twice before.
// Some codes legitimately appear in several files (a check and its caller), so this reports rather
// than fails — but W02's real collision was two unrelated checks in ONE file, which assertion 1 and
// the registry's single-name-per-code shape now prevent by construction.
const multi = [...emitted.entries()].filter(([, f]) => f.length > 1);
if (multi.length) console.log(`•  codes referenced from >1 file (informational): ${multi.map(([c, f]) => `${c}:${f.join("+")}`).join(", ")}`);

// 3. the registry answers "which code do I take next?" so a filer never has to grep for it.
const next = nextFreeDoctorCode();
ok(!DOCTOR_CODE_SET.has(next), `LOOP-88: nextFreeDoctorCode() returns an unclaimed code (${next})`);

ok(DOCTOR_CODES.every((r) => r.name.trim().length > 0 && r.source.trim().length > 0),
  "LOOP-88: every registry row carries a name and a source file");

// ── Decision 1 — W46 registered + the check fires only on an unroutable block ─────────────────────
ok(DOCTOR_CODE_SET.has("W46"), "Decision 1: W46 (unroutable block) is registered in the doctor-codes namespace");
{
  const ROOT = mkdtempSync(join(tmpdir(), "dl-w46-"));
  try {
    const db = openDb(join(ROOT, "hub.db"));
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')").run();
    const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const NOW = "2026-08-01T00:00:00.000Z";
    // LOOP-1: blocked, NO bail-shape label, NO Bail-shape comment → the fail-closed hole (W46)
    ins.run("LOOP-1", "p1", "Unroutable block", "", "Feature", "Todo", 2, JSON.stringify(["dev-loop", "Feature", "pm", "blocked", "needs-pm"]), "[]", "pm", NOW, NOW, null);
    // LOOP-2: blocked WITH a bail-shape label → routable, silent
    ins.run("LOOP-2", "p1", "Labelled block", "", "Feature", "Todo", 2, JSON.stringify(["dev-loop", "Feature", "pm", "blocked", "needs-pm", "decision-needed"]), "[]", "pm", NOW, NOW, null);
    // LOOP-3: blocked, no label, but a legacy parseable Bail-shape comment → routable (sweep backfills), silent
    ins.run("LOOP-3", "p1", "Legacy comment block", "", "Bug", "Todo", 2, JSON.stringify(["dev-loop", "Bug", "qa", "blocked", "needs-qa"]), "[]", "qa", NOW, NOW, null);
    const insComment = db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES(?,?,?,?,?)");
    const addComment = (id: string, ticket: string, body: string, at = NOW) => { insComment.run(id, ticket, "pm", body, at); };
    insComment.run("c3", "LOOP-3", "qa", "Bail-shape: info-needed\nneed the repro", NOW);
    // LOOP-4: blocked + no signal but TERMINAL → not a live routing hole, silent
    ins.run("LOOP-4", "p1", "Terminal block", "", "Feature", "Canceled", 2, JSON.stringify(["dev-loop", "Feature", "pm", "blocked"]), "[]", "pm", NOW, NOW, null);
    // LOOP-5: not blocked → silent
    ins.run("LOOP-5", "p1", "Normal ticket", "", "Feature", "Todo", 2, JSON.stringify(["dev-loop", "Feature", "pm"]), "[]", "pm", NOW, NOW, null);

    // D2 — the SECOND blocking mechanism. `ticket create --blocked-by` (LOOP-190) writes a
    // `Blocked-by: <id>` marker comment; blocked-by.ts parses it, dependency-graph.ts routes it and
    // the §9c auto-unpark clears it when the blocker goes terminal. Such a ticket needs no unblock
    // OWNER — the edge is what releases it — so a bail-shape label is not the only routable signal.
    // Ids below are chosen so that no asserted id is a substring of another.
    // LOOP-61: blocked by a LIVE edge onto non-terminal LOOP-62 → routed by the graph, silent.
    ins.run("LOOP-61", "p1", "Sequenced behind live work", "", "Feature", "Todo", 2, JSON.stringify(["dev-loop", "Feature", "pm", "blocked"]), "[]", "pm", NOW, NOW, null);
    ins.run("LOOP-62", "p1", "The live blocker", "", "Feature", "In Progress", 2, JSON.stringify(["dev-loop", "Feature", "pm"]), "[]", "pm", NOW, NOW, null);
    addComment("c61", "LOOP-61", "Blocked-by: LOOP-62");
    // LOOP-71: the only edge names a TERMINAL blocker → nothing will ever release it, W46 stands.
    ins.run("LOOP-71", "p1", "Edge onto a closed blocker", "", "Feature", "Todo", 2, JSON.stringify(["dev-loop", "Feature", "pm", "blocked"]), "[]", "pm", NOW, NOW, null);
    ins.run("LOOP-72", "p1", "The closed blocker", "", "Feature", "Done", 2, JSON.stringify(["dev-loop", "Feature", "pm"]), "[]", "pm", NOW, NOW, null);
    addComment("c71", "LOOP-71", "Blocked-by: LOOP-72");
    // LOOP-81: the edge names an id with NO ticket row. A dangling id can never go terminal, so §9c
    // never fires on it — the ticket reaches no owner and no edge, and W46 stands.
    ins.run("LOOP-81", "p1", "Dangling edge", "", "Feature", "Todo", 2, JSON.stringify(["dev-loop", "Feature", "pm", "blocked"]), "[]", "pm", NOW, NOW, null);
    addComment("c81", "LOOP-81", "Blocked-by: LOOP-404");
    // LOOP-91: the edge was RETIRED by a later `Unblocked-by:`. The parser folds the pair to an empty
    // live set, so there is no edge left to route on and W46 stands.
    ins.run("LOOP-91", "p1", "Retired edge", "", "Feature", "Todo", 2, JSON.stringify(["dev-loop", "Feature", "pm", "blocked"]), "[]", "pm", NOW, NOW, null);
    ins.run("LOOP-92", "p1", "The retired blocker", "", "Feature", "In Progress", 2, JSON.stringify(["dev-loop", "Feature", "pm"]), "[]", "pm", NOW, NOW, null);
    addComment("c91a", "LOOP-91", "Blocked-by: LOOP-92");
    addComment("c91b", "LOOP-91", "Unblocked-by: LOOP-92", "2026-08-02T00:00:00.000Z");

    const warns: string[] = [];
    const out = { pass: () => {}, fail: () => {}, warn: (m: string) => warns.push(m), info: () => {} };
    checkBlockedNoBailShape({ db, projectKey: "loop", projectId: "p1", out } as unknown as Parameters<typeof checkBlockedNoBailShape>[0]);
    db.close();

    const named = (id: string) => warns.length === 1 && warns[0]!.includes(id);
    ok(warns.length === 1 && /\[W46\]/.test(warns[0]!), `Decision 1: W46 warns exactly once for the unroutable block (got ${warns.length})`);
    ok(named("LOOP-1"), "Decision 1: W46 names the blocked-with-no-signal ticket (LOOP-1)");
    ok(warns.length === 1 && !warns[0]!.includes("LOOP-2") && !warns[0]!.includes("LOOP-3") && !warns[0]!.includes("LOOP-4") && !warns[0]!.includes("LOOP-5"),
      "Decision 1: W46 is silent on labelled / legacy-comment / terminal / non-blocked tickets");
    ok(!named("LOOP-61"),
      `D2: W46 is silent on a block carrying a live 'Blocked-by:' edge — the dependency graph routes it, no unblock owner is needed (got ${JSON.stringify(warns[0] ?? "")})`);
    ok(named("LOOP-71"), "D2: a 'Blocked-by:' edge onto a TERMINAL blocker still reports W46 — nothing will release it");
    ok(named("LOOP-81"), "D2: a 'Blocked-by:' edge naming a ticket that does not exist still reports W46 — a dangling id can never go terminal");
    ok(named("LOOP-91"), "D2: an edge retired by a later 'Unblocked-by:' still reports W46 — the live set is empty");
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDOCTOR_CODES_OK");
process.exit(fails ? 1 : 0);
