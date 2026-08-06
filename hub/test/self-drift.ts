// LOOP-249 — does the repo this fire READS describe the code it is RUNNING?
//
// When an agent diagnoses dev-loop's own behaviour it reads the source tree in the workspace repo
// while executing the INSTALLED package. Those are two different trees, and nothing surfaced the
// gap: three verdicts named the wrong writer because the reader was looking at source the running
// binary did not contain.
//
// CONTENT-BASED, not version-string-based. A repo whose HEAD is newer than the installed version but
// whose output is identical must NOT warn — a version comparison would cry drift on every commit
// that changes nothing the running code executes.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfDrift, selfDriftLine } from "../src/self-drift.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-drift-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

/** A workspace repo (hub/src/**) and an installed package (src/**), each with a package.json. */
function mk(name: string, opts: { repoPkg: string; instPkg: string; repoSrc: Record<string, string>; instSrc: Record<string, string>; repoVersion?: string; instVersion?: string }): { repo: string; inst: string } {
  const repo = join(tmp, `${name}-repo`), inst = join(tmp, `${name}-inst`);
  mkdirSync(join(repo, "hub", "src"), { recursive: true });
  mkdirSync(join(inst, "src"), { recursive: true });
  writeFileSync(join(repo, "hub", "package.json"), JSON.stringify({ name: opts.repoPkg, version: opts.repoVersion ?? "1.14.0" }));
  writeFileSync(join(inst, "package.json"), JSON.stringify({ name: opts.instPkg, version: opts.instVersion ?? "1.13.0" }));
  for (const [f, body] of Object.entries(opts.repoSrc)) writeFileSync(join(repo, "hub", "src", f), body);
  for (const [f, body] of Object.entries(opts.instSrc)) writeFileSync(join(inst, "src", f), body);
  return { repo, inst };
}

try {
  const PKG = "@dyzsasd/dev-loop";

  // (a) DRIFT PRESENT — the measured case. Same package, different content.
  {
    const { repo, inst } = mk("drift", {
      repoPkg: PKG, instPkg: PKG,
      repoSrc: { "a.ts": "export const a = 2;\n", "b.ts": "export const b = 1;\n", "c.ts": "new file\n" },
      instSrc: { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" },
    });
    const d = selfDrift(repo, inst);
    ok(d !== null, "LOOP-249 (a): drift is detected when the two trees differ");
    ok(d?.differing === 2, `LOOP-249 (a): …counting BOTH the changed module and the one absent from the installed tree (got ${d?.differing}, want 2)`);
    ok(d?.sampled === 3, `LOOP-249 (a): …against the repo's module count (got ${d?.sampled})`);
    const line = selfDriftLine(repo, inst);
    ok(/self-drift/.test(line ?? "") && /1\.13\.0/.test(line ?? ""), `LOOP-249 (a): the line names the INSTALLED version (${line})`);
    ok(/2 of 3 source modules differ/.test(line ?? ""), "LOOP-249 (a): …and the module count");
    ok(/may not describe running behaviour/.test(line ?? ""),
      "LOOP-249 (a): …and says what it means for a reader, which is the whole point of surfacing it");
  }

  // (b) NO DRIFT — byte-identical content. The version strings still differ, and that must not warn:
  // this is the AC that separates a content check from a version check.
  {
    const same = { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" };
    const { repo, inst } = mk("same", { repoPkg: PKG, instPkg: PKG, repoSrc: same, instSrc: same, repoVersion: "9.9.9", instVersion: "1.0.0" });
    ok(selfDrift(repo, inst) === null,
      "LOOP-249 (b): identical CONTENT ⇒ no drift, even with the repo version far AHEAD of the installed one");
    ok(selfDriftLine(repo, inst) === null, "LOOP-249 (b): …so the boot prefix is byte-identical to today");
  }

  // (c) UNRELATED repo — the normal case. A product repo that is not this package says nothing.
  {
    const { repo, inst } = mk("other", {
      repoPkg: "some-product", instPkg: PKG,
      repoSrc: { "a.ts": "totally different\n" }, instSrc: { "a.ts": "export const a = 1;\n" },
    });
    ok(selfDrift(repo, inst) === null,
      "LOOP-249 (c): a workspace whose repo is NOT this package is silent — identity is by package NAME, not by path shape");
  }

  // Robustness: the check is advisory and must never fail a fire.
  ok(selfDrift(join(tmp, "nope"), join(tmp, "also-nope")) === null, "LOOP-249: absent trees ⇒ null, no throw");
  {
    const { repo, inst } = mk("nosrc", { repoPkg: PKG, instPkg: PKG, repoSrc: {}, instSrc: {} });
    ok(selfDrift(repo, inst) === null, "LOOP-249: a repo with no source modules ⇒ null (nothing comparable)");
  }
  {
    const bad = join(tmp, "badjson");
    mkdirSync(join(bad, "hub", "src"), { recursive: true });
    writeFileSync(join(bad, "hub", "package.json"), "{not json");
    ok(selfDrift(bad, bad) === null, "LOOP-249: an unparseable package.json ⇒ null, never a throw inside a fire");
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nSELF_DRIFT_OK");
process.exit(fails ? 1 : 0);
