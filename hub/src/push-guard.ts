#!/usr/bin/env node
// P1-2 — the ride-along push guard. `autoPush:false` means a fire's commit "rides the operator's next
// batched push" — so ANY later push carries EVERY unpushed commit before it, including work the operator
// has since Canceled (the field's MP-275: a canceled ticket's commit rode a junior ship's push into a
// Vercel prod deploy; revert d7b617f). Also flags passenger commits in origin/<defaultBranch>..HEAD that
// are not attributable to the PR's own ticket (LOOP-87: stacked branches drag parent-ticket commits).
// Read-only on git, and on the hub's BOARD; the dev-agent ship sequence runs it `--strict` before
// `git push` (§12). One deliberate exception since LOOP-394: with `approvals.enforce` naming `push`,
// consulting the approvals record appends an `approval.attempt` ledger row — an audit line, per
// approvals §14 decision 4, and the only write this module makes. It is unreachable while the
// default-empty switch stays empty.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { ticketIdScanRe } from "./ticket-id.ts";
import { existsSync } from "node:fs";
import { openDb } from "./db.ts";
import { resolveHubDbPath, tryResolveWorkspace } from "./workspace.ts";
import { resolveDefaultBranchForPath, approvalsEnforced } from "./team-config.ts";
import { listApprovals, consultApproval, actionClasses } from "./approvals.ts"; // LOOP-394 — the record this guard consults

export interface PushGuardFinding { sha: string; subject: string; ticket: string; state: string }
export interface PushGuardPassenger {
  sha: string;
  subject: string;
  ticketId?: string;   // the other ticket's id; undefined when commit has no ticket ref (unattributable)
  boardState?: string; // that ticket's hub state; undefined when not in hub.db
  severity: "hard" | "warning"; // hard = Canceled/Duplicate; warning = open or unverifiable
}
/**
 * A §17 firewall breach (LOOP-35): an unpushed commit editing a GOVERNING file.
 *
 * §17 — "no agent auto-edits a SKILL / conventions / plugin file; structural changes are
 * operator-committed proposals" — is listed in STRATEGY.md's Goals as a HARD INVARIANT of every
 * phase, and for documents the code enforces it. For FILES nothing checked at all: an agent could
 * rewrite `references/conventions.md` or any `skills/**\/SKILL.md` and push it, and the only thing
 * standing between that and `main` was whether a human happened to read the diff.
 *
 * The generated cheatsheet range is EXEMPT by construction. `npm run cli-cheatsheet` rewrites the
 * span between `<!-- cli-cheatsheet:begin agent=X -->` and its `end`, and that is a mechanical
 * regeneration, not a structural change. Flagging it would put friction on the one path that is
 * supposed to be frictionless, and a check that fires on routine work gets routed around.
 */
export interface PushGuardGovernance { sha: string; subject: string; file: string; reason: "conventions" | "skill" }

/**
 * LOOP-394 (design approvals §7) — the FIRST enforcing consumer of the approvals record.
 *
 * The incident this closes (design §1 / LOOP-383's Why): the operator's LOOP-367 branch sat in the
 * shared checkout awaiting a human's push go-ahead, a fire found it and landed it to main, and
 * nothing could refuse — because the system had no representation of "this work awaits human
 * approval." The approval REQUEST is that representation, and this is the consumer that reads it.
 *
 * Request-driven, deliberately. The gate fires for a commit whose ticket carries a `push:` approval
 * row; it does NOT demand an approval for every commit. A blanket "every push needs a grant" would
 * be a capability gate in all but name — the operator would grant one standing thing per branch to
 * get any work through — and design §4 exists to keep exactly that shape unrepresentable.
 *
 * The KEY is `push:<branch>:<sha>` and matching is by that whole key, never by ticket. A grant for
 * one sha does not carry to the next commit on the same branch: that is the end-state property
 * (design §4), and it is what separates this from the capability grant it must not become.
 */
export interface PushGuardApproval {
  sha: string;          // short sha, as the other finding kinds report it
  subject: string;
  key: string;          // push:<branch>:<full-sha> — the exact key `dev-loop approve` takes
  ticketId: string;     // the ticket whose push: row put this commit under the gate
  state: string | null; // the ungranted row's derived state ("requested"/"revoked"/"expired"/…), null when no row matches the key
  reason: string;       // consultApproval's verdict reason, printed verbatim
}

export interface PushGuardResult { branch: string; ahead: number; unknownRefs: string[]; findings: PushGuardFinding[]; passengers: PushGuardPassenger[]; governance: PushGuardGovernance[]; approvals: PushGuardApproval[]; unresolvedDefaultBranch?: string; note?: string }

/** The key grammar for this class, in ONE place — the guard, the refusal, and the tests all read it. */
export const pushApprovalKey = (branch: string, sha: string): string => `push:${branch}:${sha}`;

/**
 * The line a blocked agent actually reads (design §9.4). ONE copy, exported, so the test asserts the
 * shipped string rather than a paraphrase of it.
 *
 * It names the approval path and NO bypass. There is deliberately no flag that waives this for one
 * push: the route out is the operator granting the end state, which is safe to print only because C2
 * made `approve` itself fire-refused (design §2). A guard that documents its own bypass to the party
 * being guarded is a suggestion, not a gate.
 */
export const approvalRefusalLine = (a: PushGuardApproval): string =>
  `⛔ approval required: ${a.sha} "${a.subject}" is work ${a.ticketId} marked as awaiting human approval — ${a.reason}. ` +
  `The operator authorises this exact end state with: dev-loop approve ${a.key}`;

// §17's governed surface. `skills/**` and the ONE conventions file — the two the invariant names.
const GOVERNED_RE = /^(references\/conventions\.md|skills\/.+)$/;
const CHEATSHEET_BEGIN = /^<!-- cli-cheatsheet:begin agent=[a-z][a-z-]* -->$/;
const CHEATSHEET_END = /^<!-- cli-cheatsheet:end agent=[a-z][a-z-]* -->$/;

/**
 * The 1-indexed line ranges covered by cheatsheet markers in a file's content.
 *
 * Ranges are computed from the FILE, not from diff context. My first version walked the diff looking
 * for marker lines and it reported every regeneration as a breach: the diff is taken with
 * `--unified=0`, so there are no context lines and the markers are simply not in it. Positioning a
 * change needs line numbers, which is what the hunk headers carry.
 */
export function cheatsheetRanges(content: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: number | null = null;
  content.split("\n").forEach((line, i) => {
    const n = i + 1;
    if (CHEATSHEET_BEGIN.test(line.trim())) { open = n; return; }
    if (CHEATSHEET_END.test(line.trim()) && open !== null) { out.push([open, n]); open = null; }
  });
  return out;
}

const inRanges = (n: number, ranges: Array<[number, number]>): boolean => ranges.some(([a, b]) => n >= a && n <= b);

/**
 * Does this diff change anything OUTSIDE the generated cheatsheet ranges?
 *
 * Added lines are placed against the NEW file's ranges, removed lines against the OLD file's — a
 * regeneration rewrites lines that were inside the markers before and are inside them after, and
 * checking one side only would misplace half of every such hunk.
 *
 * A marker line that is itself added or removed is always a breach: moving or deleting the boundary
 * is a structural change to the range, not generated content within it.
 *
 * Conservative on the way out: an unparseable diff, or one whose hunk headers are missing, counts as
 * outside. An edit that cannot be placed is an edit that must be reported.
 */
export function touchesOutsideCheatsheet(diff: string, newContent = "", oldContent = ""): boolean {
  const newRanges = cheatsheetRanges(newContent);
  const oldRanges = cheatsheetRanges(oldContent);
  let oldLine = 0, newLine = 0, sawHunk = false;
  for (const raw of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { oldLine = Number(h[1]); newLine = Number(h[2]); sawHunk = true; continue; }
    if (!sawHunk) continue;                                        // preamble (file headers, mode bits)
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      const body = raw.slice(1).trim();
      if (CHEATSHEET_BEGIN.test(body) || CHEATSHEET_END.test(body)) return true;
      if (!inRanges(newLine, newRanges)) return true;
      newLine++;
    } else if (raw.startsWith("-")) {
      const body = raw.slice(1).trim();
      if (CHEATSHEET_BEGIN.test(body) || CHEATSHEET_END.test(body)) return true;
      if (!inRanges(oldLine, oldRanges)) return true;
      oldLine++;
    } else { oldLine++; newLine++; }                               // context (absent at --unified=0)
  }
  return false;
}

const TICKET_RE = ticketIdScanRe("g"); // the ONE canonical <PREFIX>-<n> id shape (§3 ticketPrefix; ticket-id.ts, LOOP-264)

// Extract the ticket id from a dev-loop/<id> branch name. Returns undefined for other branch shapes.
const branchTicketId = (br: string): string | undefined => {
  const m = br.match(/^dev-loop\/(.+)$/);
  if (!m) return undefined;
  return m[1].match(TICKET_RE)?.[0]; // "LOOP-54" from "dev-loop/LOOP-54"
};

/**
 * The approvals gate over one commit range (LOOP-394 / design §5, §7).
 *
 * Under the gate = the commit's ticket has AT LEAST ONE `push:` approval row. That row is the
 * operator's (or an agent's) statement that this work awaits a human; a ticket with no such row is
 * outside this feature entirely and is never touched here.
 *
 * Authorised = `consultApproval` returns `authorises` for `push:<branch>:<that commit's sha>`. The
 * lookup key is built from THIS commit, so a grant naming another sha simply does not match and the
 * verdict reads "no approval exists" — which is the design §4 end-state property, not a special case
 * anyone had to remember to write.
 */
function checkPushApprovals(
  commits: Array<{ sha: string; subject: string; msg: string }>,
  branch: string,
  dbFile: string,
  actor: string,
): PushGuardApproval[] {
  const out: PushGuardApproval[] = [];
  if (!commits.length || !existsSync(dbFile)) return out;
  const conn = openDb(dbFile);
  try {
    // One read of the (small) table, indexed by ticket: the question "is this ticket under the gate"
    // is asked once per commit and the answer never changes within a run.
    const byTicket = new Map<string, number>();
    for (const r of listApprovals(conn, {})) {
      if (!r.ticket_id || !r.action_key.startsWith("push:")) continue;
      byTicket.set(r.ticket_id, (byTicket.get(r.ticket_id) ?? 0) + 1);
    }
    if (!byTicket.size) return out;
    const now = new Date().toISOString();
    for (const c of commits) {
      const ids = [...new Set(c.msg.match(TICKET_RE) ?? [])] as string[];
      const gated = ids.find((id) => byTicket.has(id));
      if (!gated) continue;
      const key = pushApprovalKey(branch, c.sha);
      // The attempt IS ledgered (approvals §14 decision 4: the audit line must not depend on each
      // consumer remembering to ask). A ledger write can still fail — a busy db, a read-only handle —
      // and a safety gate that CRASHES is a safety gate that got skipped, so the verdict is re-taken
      // without the audit line rather than lost. `record:false` grants nothing and skips no check.
      let v;
      try { v = consultApproval(conn, key, now, { actor, ticketId: gated }); }
      catch { v = consultApproval(conn, key, now, { actor, ticketId: gated, record: false }); }
      if (v.authorises) continue;
      out.push({ sha: c.sha.slice(0, 7), subject: c.subject, key, ticketId: gated, state: v.state, reason: v.reason ?? "not authorised" });
    }
  } finally { conn.close(); }
  return out;
}

export function pushGuard(repoDir: string, branch: string | undefined, dbPath: string | undefined, defaultBranch: string, opts: { enforcePush?: boolean; actor?: string } = {}): PushGuardResult {
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

  // LOOP-394 — the approvals gate covers the commits a push would PUBLISH, which is a different range
  // in the two cases: the unpushed tail for a tracked branch, and everything off the default branch
  // for a never-pushed one. The first push is the more dangerous of the two (nothing of it is on the
  // forge yet), so it is gated on the same footing rather than skipped with the note below.
  const hasUpstream = gitOk(["rev-parse", "--verify", "--quiet", `origin/${br}`]);
  const range = hasUpstream ? `origin/${br}..${br}`
    : gitOk(["rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`]) ? `origin/${defaultBranch}..${br}`
    : null;
  // Default-OFF (design §8): with the class absent from `approvals.enforce` nothing below runs, no db
  // handle is opened, and the result is byte-identical to the pre-LOOP-394 output (AC2).
  const approvals = opts.enforcePush && range
    ? checkPushApprovals(parseLog(git(["log", "-z", "--pretty=format:%H%n%B", range])), br, dbPath ?? resolveHubDbPath(repoDir), opts.actor ?? "unknown")
    : [];

  if (!hasUpstream) return { branch: br, ahead: 0, unknownRefs: [], findings: [], passengers, governance: [], approvals, unresolvedDefaultBranch, note: `no upstream origin/${br} — nothing to compare (first push of this branch)` };
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

  // §17 (LOOP-35) — governing-file edits in the unpushed range. Local git only, like every other
  // check here: no forge call, so it works offline and cannot be disabled by a `gh` outage.
  const governance: PushGuardGovernance[] = [];
  for (const c of commits) {
    let files: string[] = [];
    try { files = git(["show", "--pretty=format:", "--name-only", c.sha]).split("\n").map((f) => f.trim()).filter(Boolean); }
    catch { continue; }
    for (const f of files.filter((f) => GOVERNED_RE.test(f))) {
      let diff = "", after = "", before = "";
      try { diff = git(["show", "--pretty=format:", "--unified=0", c.sha, "--", f]); } catch { diff = ""; }
      try { after = git(["show", `${c.sha}:${f}`]); } catch { after = ""; }   // deleted in this commit
      try { before = git(["show", `${c.sha}^:${f}`]); } catch { before = ""; } // added in this commit
      // No diff readable ⇒ report it. An edit we cannot inspect is not an edit we may wave through.
      if (diff && !touchesOutsideCheatsheet(diff, after, before)) continue;
      governance.push({ sha: c.sha.slice(0, 7), subject: c.subject, file: f, reason: f.endsWith("conventions.md") ? "conventions" : "skill" });
    }
  }

  return { branch: br, ahead: commits.length, unknownRefs, findings, passengers, governance, approvals, unresolvedDefaultBranch };
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

Also enforces the approvals record for the 'push' action class when — and only when —
team.approvals.enforce lists it (default: enforces nothing). With it on, a commit whose ticket
carries a push: approval row must have a granted, unexpired approval keyed push:<branch>:<sha>;
grant one with 'dev-loop approve push:<branch>:<sha>'. Turn it on with:
  dev-loop team set team.approvals.enforce push
(a comma-separated list; the empty string clears it. Legal classes: ${actionClasses().join(", ")}.)

Usage: dev-loop push-guard [--repo <dir>] [--branch <b>] [--default-branch <b>] [--strict] [--json]
  --strict           exit 1 when any finding, passenger, §17 governing-file edit, ungranted push
                     approval, or unresolvable default branch is present
  --default-branch   the default branch name (resolved from workspace config when omitted)`);
      process.exit(0);
    } else { console.error(`push-guard: unknown option '${a}'`); process.exit(2); }
  }
  if (!repo) { console.error("push-guard: --repo needs a path"); process.exit(2); }

  // Resolved once, for BOTH the default branch and the enforcement switch. Before LOOP-394 the
  // workspace was read only on the fallback path, so `--default-branch` (what the ship sequence
  // passes) would have silently skipped the enforcement lookup — enforcement configured ON and off
  // in exactly the invocation the dev tiers use.
  const absRepo = resolve(repo);
  const ws = tryResolveWorkspace(absRepo);

  let defaultBranch: string;
  if (explicitDefaultBranch) {
    defaultBranch = explicitDefaultBranch;
  } else {
    const fromConfig = ws ? resolveDefaultBranchForPath(ws, absRepo) : undefined;
    if (!fromConfig) {
      console.error(`push-guard: cannot resolve the default branch for '${repo}' — not a registered repo; pass --default-branch <name>`);
      process.exit(strict ? 1 : 0);
    }
    defaultBranch = fromConfig;
  }

  // No workspace ⇒ no config ⇒ enforcement off. An unregistered repo cannot opt in by accident.
  const enforcePush = approvalsEnforced(ws?.file.team, "push");

  let r: PushGuardResult;
  try { r = pushGuard(repo, branch, undefined, defaultBranch, { enforcePush, actor: process.env.DEVLOOP_ACTOR }); }
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
    // §17 (LOOP-35). The finding names the ROUTE OUT, not just the refusal: the invariant is not
    // "never change these files", it is "changes to them are operator-committed proposals". A guard
    // that only says "refused" leaves the agent with no legal next move and invites a workaround.
    for (const g of r.governance)
      console.log(`⛔ §17 firewall: ${g.sha} "${g.subject}" edits ${g.file} — ${g.reason === "conventions" ? "conventions" : "a SKILL"} is operator-committed, not agent-editable. Route: drop it from this branch and file the change as a proposal for the operator to apply (an in-marker cli-cheatsheet regeneration is exempt and would not appear here).`);
    // LOOP-394 / design §9.4 — the refusal names the approval path and NO bypass. There is no flag
    // that turns this off for one push: the route out is the operator granting the end state, which
    // is safe to print only because C2 made `approve` itself fire-refused (design §2). If a bypass
    // ever appears in this message, the guard has become a suggestion.
    for (const a of r.approvals) console.log(approvalRefusalLine(a));
    if (r.unresolvedDefaultBranch) console.log(`⛔ push-guard: origin/${r.unresolvedDefaultBranch} does not exist — passenger detection did NOT run (a safety gate must not pass silently)`);
    if (r.unknownRefs.length) console.log(`note: ${r.unknownRefs.length} ticket ref(s) not verifiable here (${r.unknownRefs.slice(0, 5).join(", ")}${r.unknownRefs.length > 5 ? ", …" : ""}) — no matching row in the local hub`);
    if (!r.findings.length && !r.passengers.length && !r.governance.length && !r.approvals.length && !r.unresolvedDefaultBranch && !r.note) console.log("clean: no canceled/duplicate ticket refs, passengers, or §17 governing-file edits aboard");
  }
  process.exit(strict && (r.findings.length || r.passengers.length || r.governance.length || r.approvals.length || !!r.unresolvedDefaultBranch) ? 1 : 0);
}
