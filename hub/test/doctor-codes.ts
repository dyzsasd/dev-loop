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
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR_CODES, DOCTOR_CODE_SET, nextFreeDoctorCode } from "../src/doctor-codes.ts";
import { DOCTOR_CHECKS } from "../src/doctor-registry.ts";

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

// LOOP-359 (Child D, design §9): bind the dispatch to the W-code registry so the two inventories
// cannot drift. Every code registered with source:"doctor.ts" must appear in a DOCTOR_CHECKS row's
// codes[], or be EXPLICITLY exempted in REGISTRY_EXEMPT.
const REGISTRY_EXEMPT: Record<string, string> = {
  // W08-W11, W28, W29, W42 — still inline in doctorWorkspace, not yet migrated to the
  // DOCTOR_CHECKS table (post-Child-C residue). Migrate them as follow-up work.
  W08: "still inline in doctorWorkspace — not yet migrated to the registry table",
  W09: "still inline in doctorWorkspace — not yet migrated to the registry table",
  W10: "still inline in doctorWorkspace — not yet migrated to the registry table",
  W11: "still inline in doctorWorkspace — not yet migrated to the registry table",
  W28: "still inline in doctorWorkspace — not yet migrated to the registry table",
  W29: "still inline in doctorWorkspace — not yet migrated to the registry table",
  W42: "still inline in doctorWorkspace — not yet migrated to the registry table",
};
// Row ids must be unique and non-empty, and every row needs a run.


const doctorTsCodes = new Set(DOCTOR_CODES.filter((r) => r.source === "doctor.ts").map((r) => r.code));
const checkCodes = new Set(DOCTOR_CHECKS.flatMap((r) => r.codes));

// 1. Every DOCTOR_CODES row with source:"doctor.ts" appears in a DOCTOR_CHECKS row's codes[],
//    or is in REGISTRY_EXEMPT.
const unregisteredChecks = [...doctorTsCodes].filter((c) => !checkCodes.has(c) && !REGISTRY_EXEMPT[c]);
ok(unregisteredChecks.length === 0,
  `LOOP-359: every doctor.ts code appears in DOCTOR_CHECKS (or is exempt)${unregisteredChecks.length ? ` — missing: ${unregisteredChecks.join(", ")}` : ""}`);

// 2. Every code in DOCTOR_CHECKS is registered in DOCTOR_CODES.
const unregisteredCodes = [...checkCodes].filter((c) => !DOCTOR_CODE_SET.has(c));
ok(unregisteredCodes.length === 0,
  `LOOP-359: every DOCTOR_CHECKS code is registered in DOCTOR_CODES${unregisteredCodes.length ? ` — unregistered: ${unregisteredCodes.join(", ")}` : ""}`);

// 3. Row ids are unique, non-empty, and every row has a run.
const idSet = new Set<string>();
const idDups: string[] = [];
const idEmpty: string[] = [];
const noRun: string[] = [];
for (const row of DOCTOR_CHECKS) {
  if (!row.id || !row.id.trim()) idEmpty.push(row.id ?? "");
  else if (idSet.has(row.id)) idDups.push(row.id);
  else idSet.add(row.id);
  if (!row.run) noRun.push(row.id || "(no id)");
}
ok(idEmpty.length === 0, `LOOP-359: every DOCTOR_CHECKS row has a non-empty id${idEmpty.length ? ` — empty ids: ${idEmpty.length}` : ""}`);
ok(idDups.length === 0, `LOOP-359: DOCTOR_CHECKS row ids are unique${idDups.length ? ` — duplicates: ${idDups.join(", ")}` : ""}`);
ok(noRun.length === 0, `LOOP-359: every DOCTOR_CHECKS row has a run function${noRun.length ? ` — missing run: ${noRun.join(", ")}` : ""}`);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDOCTOR_CODES_OK");
process.exit(fails ? 1 : 0);
