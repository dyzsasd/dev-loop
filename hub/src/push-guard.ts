#!/usr/bin/env node
// P1-2 — the ride-along push guard. `autoPush:false` means a fire's commit "rides the operator's next
// batched push" — so ANY later push carries EVERY unpushed commit before it, including work the operator
// has since Canceled (the field's MP-275: a canceled ticket's commit rode a junior ship's push into a
// Vercel prod deploy; revert d7b617f). This verb enumerates origin/<branch>..<branch> BEFORE a push and
// reports commits whose referenced tickets are Canceled/Duplicate. Read-only on git AND the hub; the
// dev-agent ship sequence runs it `--strict` before `git push` (§12) and Sweep may quote it per repo.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openDb } from "./db.ts";
import { resolveHubDbPath } from "./workspace.ts";

export interface PushGuardFinding { sha: string; subject: string; ticket: string; state: string }
export interface PushGuardResult { branch: string; ahead: number; unknownRefs: string[]; findings: PushGuardFinding[]; note?: string }

const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g; // the <PREFIX>-<n> id shape (§3 ticketPrefix)

export function pushGuard(repoDir: string, branch?: string, dbPath?: string): PushGuardResult {
  const git = (args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const br = branch ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);
  try { git(["rev-parse", "--verify", "--quiet", `origin/${br}`]); }
  catch { return { branch: br, ahead: 0, unknownRefs: [], findings: [], note: `no upstream origin/${br} — nothing to compare (first push of this branch)` }; }
  const out = git(["log", "--pretty=%H\t%s", `origin/${br}..${br}`]);
  const commits = out ? out.split("\n").map((l) => { const i = l.indexOf("\t"); return { sha: l.slice(0, i), subject: l.slice(i + 1) }; }) : [];
  const refs = new Map<string, { sha: string; subject: string }[]>();
  for (const c of commits) {
    for (const id of c.subject.match(TICKET_RE) ?? []) (refs.get(id) ?? refs.set(id, []).get(id)!).push(c);
  }
  const findings: PushGuardFinding[] = [];
  const unknownRefs: string[] = [];
  const db = dbPath ?? resolveHubDbPath(repoDir);
  if (refs.size && existsSync(db)) {
    const conn = openDb(db);
    try {
      for (const [id, cs] of refs) {
        // ticket ids are a GLOBAL primary key across projects sharing one hub.db (seed.ts) — no project scope needed
        const row = conn.prepare("SELECT state FROM tickets WHERE id=?").get(id) as { state?: string } | undefined;
        if (!row) { unknownRefs.push(id); continue; }
        if (row.state === "Canceled" || row.state === "Duplicate")
          for (const c of cs) findings.push({ sha: c.sha.slice(0, 7), subject: c.subject, ticket: id, state: row.state as string });
      }
    } finally { conn.close(); }
  } else if (refs.size) {
    unknownRefs.push(...refs.keys()); // no local hub (linear/local backend) — states unverifiable here
  }
  return { branch: br, ahead: commits.length, unknownRefs, findings };
}

// CLI: dev-loop push-guard [--repo <dir>] [--branch <b>] [--strict] [--json]
// Exit codes (the write-layer contract): 0 clean/advisory · 1 findings under --strict · 2 usage.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  let repo = process.cwd(); let branch: string | undefined; let strict = false; let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") repo = argv[++i] ?? "";
    else if (a === "--branch") branch = argv[++i];
    else if (a === "--strict") strict = true;
    else if (a === "--json") asJson = true;
    else if (a === "--help" || a === "-h") {
      console.log(`dev-loop push-guard — enumerate origin/<branch>..<branch> before a push and flag commits
whose referenced tickets are Canceled/Duplicate (the MP-275 ride-along class). Read-only.

Usage: dev-loop push-guard [--repo <dir>] [--branch <b>] [--strict] [--json]
  --strict   exit 1 when findings exist (the dev-agent §12 pre-push gate); default is advisory (exit 0)`);
      process.exit(0);
    } else { console.error(`push-guard: unknown option '${a}'`); process.exit(2); }
  }
  if (!repo) { console.error("push-guard: --repo needs a path"); process.exit(2); }
  let r: PushGuardResult;
  try { r = pushGuard(repo, branch); }
  catch (e) { console.error(`push-guard: ${(e as Error).message.split("\n")[0]}`); process.exit(2); }
  if (asJson) { console.log(JSON.stringify(r, null, 2)); }
  else {
    if (r.note) console.log(`push-guard: ${r.note}`);
    else console.log(`push-guard: ${r.ahead} commit(s) ahead of origin/${r.branch}`);
    for (const f of r.findings) console.log(`⛔ ride-along: ${f.sha} "${f.subject}" references ${f.ticket} (${f.state}) — a push would publish canceled work; drop/park it (needs-operator) before pushing`);
    if (r.unknownRefs.length) console.log(`note: ${r.unknownRefs.length} ticket ref(s) not verifiable here (${r.unknownRefs.slice(0, 5).join(", ")}${r.unknownRefs.length > 5 ? ", …" : ""}) — no matching row in the local hub`);
    if (!r.findings.length && !r.note) console.log("clean: no canceled/duplicate ticket refs aboard");
  }
  process.exit(strict && r.findings.length ? 1 : 0);
}
