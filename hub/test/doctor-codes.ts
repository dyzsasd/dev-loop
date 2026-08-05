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

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDOCTOR_CODES_OK");
process.exit(fails ? 1 : 0);
