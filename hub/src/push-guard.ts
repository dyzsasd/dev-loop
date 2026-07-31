#!/usr/bin/env node
// P1-2 — the ride-along push guard. `autoPush:false` means a fire's commit "rides the operator's next
// batched push" — so ANY later push carries EVERY unpushed commit before it, including work the operator
// has since Canceled (the field's MP-275: a canceled ticket's commit rode a junior ship's push into a
// Vercel prod deploy; revert d7b617f). Also flags passenger commits in origin/<defaultBranch>..HEAD that
// are not attributable to the PR's own ticket (LOOP-87: stacked branches drag parent-ticket commits).
// Read-only on git AND the hub; the dev-agent ship sequence runs it `--strict` before `git push` (§12).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { existsSync } from "node:fs";
import { openDb } from "./db.ts";
import { resolveHubDbPath, tryResolveWorkspace } from "./workspace.ts";
import { resolveDefaultBranchForPath } from "./team-config.ts";

export interface PushGuardFinding { sha: string; subject: string; ticket: string; state: string }
export interface PushGuardPassenger {
  sha: string;
  subject: string;
  ticketId?: string;   // the other ticket's id; undefined when commit has no ticket ref (unattributable)
  boardState?: string; // that ticket's hub state; undefined when not in hub.db
  severity: "hard" | "warning"; // hard = Canceled/Duplicate; warning = open or unverifiable
}
export interface PushGuardResult { branch: string; ahead: number; unknownRefs: string[]; findings: PushGuardFinding[]; passengers: PushGuardPassenger[]; unresolvedDefaultBranch?: string; note?: string }

const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g; // the <PREFIX>-<n> id shape (§3 ticketPrefix)

// Extract the ticket id from a dev-loop/<id> branch name. Returns undefined for other branch shapes.
const branchTicketId = (br: string): string | undefined => {
  const m = br.match(/^dev-loop\/(.+)$/);
  if (!m) return undefined;
  return m[1].match(TICKET_RE)?.[0]; // "LOOP-54" from "dev-loop/LOOP-54"
};

export function pushGuard(repoDir: string, branch: string | undefined, dbPath: string | undefined, defaultBranch: string): PushGuardResult {
  const git = (args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const gitOk = (args: string[]): boolean => { try { git(args); return true; } catch { return false; } };
  const parseLog = (raw: string) => raw ? raw.split("\0").filter(Boolean).map((r) => {
    const nl = r.indexOf("\n"); const sha = r.slice(0, nl); const msg = r.slice(nl + 1);
    return { sha, subject: msg.split("\n")[0], msg };
  }) : [];
  const br = branch ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);

  // ── LOOP-55: passenger detection runs off origin/<defaultBranch>, not origin/<br> ──
  // Runs BEFORE the upstream check so a fresh (never-pushed) feature branch is still caught.
  // Uses origin/<defaultBranch>..branch — the commits that would ride a first push of this branch.
  const passengers: PushGuardPassenger[] = [];
  let unresolvedDefaultBranch: string | undefined;
  const ownId = branchTicketId(br);
  if (ownId) {
    if (gitOk(["rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`])) {
      const pCommits = parseLog(git(["log", "-z", "--pretty=format:%H%n%B", `origin/${defaultBranch}..${br}`]));
      // Open hub.db for passenger ticket-state lookups (read-only).
      const pgDb = dbPath ?? resolveHubDbPath(repoDir);
      const pgConn = existsSync(pgDb) ? openDb(pgDb) : null;
      try {
        for (const c of pCommits) {
          const allIds = [...new Set(c.msg.match(TICKET_RE) ?? [])] as string[];
          // Commit references this branch's own ticket → not a passenger.
          if (allIds.includes(ownId)) continue;
          // Attribution by ticket id (LOOP-87): look up each referenced ticket's state.
          // Commits with no ticket ref are reported as unattributable (warning) rather than silently dropped.
          const otherIds = allIds;
          let ticketId: string | undefined = otherIds[0];
          let boardState: string | undefined;
          let severity: "hard" | "warning" = "warning";
          if (pgConn && otherIds.length > 0) {
            for (const pid of otherIds) {
              const row = pgConn.prepare("SELECT state FROM tickets WHERE id=?").get(pid) as { state?: string } | undefined;
              if (row?.state === "Canceled" || row?.state === "Duplicate") {
                ticketId = pid; boardState = row.state; severity = "hard"; break;
              }
              if (row && !boardState) { ticketId = pid; boardState = row.state; }
            }
          }
          passengers.push({ sha: c.sha.slice(0, 7), subject: c.subject, ticketId, boardState, severity });
        }
      } finally { pgConn?.close(); }
    } else {
      // origin/<defaultBranch> doesn't resolve — record it; the caller must fail loud (AC4: never silent).
      unresolvedDefaultBranch = defaultBranch;
    }
  }

  try { git(["rev-parse", "--verify", "--quiet", `origin/${br}`]); }
  catch { return { branch: br, ahead: 0, unknownRefs: [], findings: [], passengers, unresolvedDefaultBranch, note: `no upstream origin/${br} — nothing to compare (first push of this branch)` }; }
  // -z NUL-terminates each record so newlines in the body don't split records; %B is the full commit
  // message (subject + body), which allows ticket refs in trailers/footers to be detected (LOOP-25).
  const commits = parseLog(git(["log", "-z", "--pretty=format:%H%n%B", `origin/${br}..${br}`]));
  const refs = new Map<string, { sha: string; subject: string }[]>();
  for (const c of commits) {
    for (const id of c.msg.match(TICKET_RE) ?? []) (refs.get(id) ?? refs.set(id, []).get(id)!).push(c);
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

  return { branch: br, ahead: commits.length, unknownRefs, findings, passengers, unresolvedDefaultBranch };
}

// CLI: dev-loop push-guard [--repo <dir>] [--branch <b>] [--default-branch <b>] [--strict] [--json]
// Exit codes (the write-layer contract): 0 clean/advisory · 1 findings under --strict · 2 usage.
if (isMainEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  let repo = process.cwd(); let branch: string | undefined; let strict = false; let asJson = false;
  let explicitDefaultBranch: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") repo = argv[++i] ?? "";
    else if (a === "--branch") branch = argv[++i];
    else if (a === "--default-branch") explicitDefaultBranch = argv[++i];
    else if (a === "--strict") strict = true;
    else if (a === "--json") asJson = true;
    else if (a === "--help" || a === "-h") {
      console.log(`dev-loop push-guard — enumerate origin/<branch>..<branch> before a push and flag commits
whose referenced tickets are Canceled/Duplicate (the MP-275 ride-along class), and flag passenger
commits not attributable to the PR's own ticket (LOOP-55, LOOP-87). Read-only.

Usage: dev-loop push-guard [--repo <dir>] [--branch <b>] [--default-branch <b>] [--strict] [--json]
  --strict           exit 1 when any finding, passenger, or unresolvable default branch is present
  --default-branch   the default branch name (resolved from workspace config when omitted)`);
      process.exit(0);
    } else { console.error(`push-guard: unknown option '${a}'`); process.exit(2); }
  }
  if (!repo) { console.error("push-guard: --repo needs a path"); process.exit(2); }

  let defaultBranch: string;
  if (explicitDefaultBranch) {
    defaultBranch = explicitDefaultBranch;
  } else {
    const absRepo = resolve(repo);
    const ws = tryResolveWorkspace(absRepo);
    const fromConfig = ws ? resolveDefaultBranchForPath(ws, absRepo) : undefined;
    if (!fromConfig) {
      console.error(`push-guard: cannot resolve the default branch for '${repo}' — not a registered repo; pass --default-branch <name>`);
      process.exit(strict ? 1 : 0);
    }
    defaultBranch = fromConfig;
  }

  let r: PushGuardResult;
  try { r = pushGuard(repo, branch, undefined, defaultBranch); }
  catch (e) { console.error(`push-guard: ${(e as Error).message.split("\n")[0]}`); process.exit(2); }
  if (asJson) { console.log(JSON.stringify(r, null, 2)); }
  else {
    if (r.note) console.log(`push-guard: ${r.note}`);
    else console.log(`push-guard: ${r.ahead} commit(s) ahead of origin/${r.branch}`);
    for (const f of r.findings) console.log(`⛔ ride-along: ${f.sha} "${f.subject}" references ${f.ticket} (${f.state}) — a push would publish canceled work; drop/park it (needs-operator) before pushing`);
    for (const p of r.passengers) {
      const icon = p.severity === "hard" ? "⛔" : "⚠";
      const detail = p.ticketId
        ? ` — ${p.ticketId} is ${p.boardState ?? "unverifiable"}`
        : " — no ticket id (unattributable)";
      const remedy = p.severity === "hard"
        ? "drop or re-target this commit before push"
        : "re-cut or re-target when upstream lands";
      console.log(`${icon} passenger: ${p.sha} "${p.subject}"${detail}; ${remedy}`);
    }
    if (r.unresolvedDefaultBranch) console.log(`⛔ push-guard: origin/${r.unresolvedDefaultBranch} does not exist — passenger detection did NOT run (a safety gate must not pass silently)`);
    if (r.unknownRefs.length) console.log(`note: ${r.unknownRefs.length} ticket ref(s) not verifiable here (${r.unknownRefs.slice(0, 5).join(", ")}${r.unknownRefs.length > 5 ? ", …" : ""}) — no matching row in the local hub`);
    if (!r.findings.length && !r.passengers.length && !r.unresolvedDefaultBranch && !r.note) console.log("clean: no canceled/duplicate ticket refs or passengers aboard");
  }
  process.exit(strict && (r.findings.length || r.passengers.length || !!r.unresolvedDefaultBranch) ? 1 : 0);
}
