// Does the repo this fire READS describe the code it is RUNNING? (LOOP-249)
//
// When an agent diagnoses dev-loop's OWN behaviour, it reads the source tree in the workspace repo
// while executing the INSTALLED package. Those are two different trees, and nothing surfaced the
// gap: three verdicts named the wrong writer because the reader was looking at source the running
// binary did not contain.
//
// A FIRE is the right place, not doctor. The drift is only dangerous at the moment an agent reasons
// from source about observed behaviour, and that moment is inside a fire. Doctor runs before an
// unattended run — exactly when the drift matters least and is most likely to be stale by the time
// it does.
//
// CONTENT-BASED, not version-string-based: a repo whose HEAD is newer than the installed version but
// whose built output is identical must NOT warn. A version comparison would cry drift on every
// commit that changes nothing the running code executes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SelfDrift { installedVersion: string; repoHead: string; differing: number; sampled: number }

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Every `.ts` under a src dir, repo-relative, sorted — the comparable surface. */
function srcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(r);
    }
  };
  walk(root, "");
  return out.sort();
}

const readJson = (p: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return null; }
};

/**
 * The drift between the repo in this workspace and the package actually executing, or null.
 *
 * Null in every case where the question does not apply or cannot be answered:
 *   • the workspace hosts no repo that IS this package (the normal case — a product repo unrelated
 *     to dev-loop pays nothing and says nothing);
 *   • the installed tree cannot be located or read;
 *   • the two trees are identical.
 *
 * Identity is by package NAME, from each side's package.json. A path heuristic would misfire on any
 * checkout that merely looks like the CLI's own.
 */
export function selfDrift(repoRoot: string, installedRoot: string): SelfDrift | null {
  const repoPkg = readJson(join(repoRoot, "hub", "package.json")) ?? readJson(join(repoRoot, "package.json"));
  const instPkg = readJson(join(installedRoot, "package.json"));
  if (!repoPkg || !instPkg) return null;
  if (typeof repoPkg.name !== "string" || repoPkg.name !== instPkg.name) return null; // not self-hosting

  const repoSrc = join(repoRoot, "hub", "src");
  const instSrc = join(installedRoot, "src");
  if (!existsSync(repoSrc) || !existsSync(instSrc)) return null;

  const files = srcFiles(repoSrc);
  if (!files.length) return null;
  let differing = 0;
  for (const f of files) {
    let a: string, b: string;
    try { a = sha(readFileSync(join(repoSrc, f))); } catch { continue; }
    try { b = sha(readFileSync(join(instSrc, f))); } catch { differing++; continue; } // present here, absent there
    if (a !== b) differing++;
  }
  if (differing === 0) return null; // identical content ⇒ no drift, whatever the versions say

  let repoHead = "unknown";
  try { repoHead = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* keep */ }
  return { installedVersion: String(instPkg.version ?? "0.0.0"), repoHead, differing, sampled: files.length };
}

/** The one banner line, or null when there is nothing to say. */
export function selfDriftLine(repoRoot: string, installedRoot: string): string | null {
  let d: SelfDrift | null;
  try { d = selfDrift(repoRoot, installedRoot); } catch { return null; } // advisory only — never fails a fire
  if (!d) return null;
  return `⚠ self-drift: running ${d.installedVersion}, repo HEAD ${d.repoHead}, ${d.differing} of ${d.sampled} source modules differ — source reads may not describe running behaviour`;
}

/** Where the RUNNING package lives: the dir containing the src/ this module was loaded from. */
export function installedRootOf(moduleDir: string): string { return join(moduleDir, ".."); }
