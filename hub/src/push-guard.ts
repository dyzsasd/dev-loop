#!/usr/bin/env node
// P1-2 — the ride-along push guard. `autoPush:false` means a fire's commit "rides the operator's next
// batched push" — so ANY later push carries EVERY unpushed commit before it, including work the operator
// has since Canceled (the field's MP-275: a canceled ticket's commit rode a junior ship's push into a
// Vercel prod deploy; revert d7b617f). Also flags passenger commits in origin/<defaultBranch>..HEAD that
// are not attributable to the PR's own ticket (LOOP-87: stacked branches drag parent-ticket commits).
// Two ranges, deliberately (LOOP-535): the approvals receipt covers what a push PUBLISHES to the branch
// ref, while ride-along/passenger/§17 cover CONTENT that would newly reach the default branch — which
// after a rebase is the narrower set, since `origin/<br>` is then the pre-rebase tip.
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
import { DatabaseSync } from "node:sqlite"; // R5 — the read-only probe below must NOT create/migrate
import { openDb } from "./db.ts";
import { resolveHubDbPath } from "./workspace.ts";
import { approvalsEnforced, loadWorkspace, inferProjectForRepo } from "./team-config.ts";
import { workspaceRootForRepoDir, workspaceForRepoDir, resolveDefaultBranchForRepoDir, registeredRepoRefFor } from "./repo-lock-path.ts";
import { defaultBranchPushVerdict, defaultBranchPushRefusalLine, docLandAllowlist, strategyDocRelPath, type DefaultBranchPushVerdict } from "./default-branch-push.ts";
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

/**
 * The `state` of an entry the guard could NOT evaluate, as opposed to one it evaluated and refused.
 *
 * An unavailable record is not an empty record. With enforcement on and the hub db missing — moved,
 * deleted, or resolved to the wrong path — the guard cannot tell an ungranted request from no request
 * at all, and reporting "no findings" would turn exactly that misconfiguration into a silent bypass of
 * the gate that exists to refuse. So the class degrades toward REFUSING, and it rides `approvals[]`
 * rather than a new result field on purpose: every consumer that already blocks on that array blocks
 * on this too, with nothing new to remember.
 */
export const APPROVALS_UNVERIFIABLE = "unverifiable";

export interface PushGuardResult { branch: string; ahead: number; unknownRefs: string[]; findings: PushGuardFinding[]; passengers: PushGuardPassenger[]; governance: PushGuardGovernance[]; approvals: PushGuardApproval[]; unresolvedDefaultBranch?: string; note?: string;
  // LOOP-567 — set ONLY when this push would put code on the default branch of a `landing:"pr"`
  // repo. Present ⇒ refuse. Absent is the normal case for every branch push and for `doc-land`.
  landing?: DefaultBranchPushVerdict }

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
  a.state === APPROVALS_UNVERIFIABLE
    ? `⛔ approval unverifiable: ${a.sha} "${a.subject}" carries work ${a.ticketId} and enforcement is on, but ${a.reason}. ` +
      `The record must be readable before this push can be evaluated: dev-loop doctor`
    : `⛔ approval required: ${a.sha} "${a.subject}" is work ${a.ticketId} marked as awaiting human approval — ${a.reason}. ` +
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

/**
 * The `team` block governing a repo directory, or undefined when the path is in no workspace.
 *
 * Best-effort by design: an unregistered or unreadable workspace resolves to "no config", which reads
 * as enforcement OFF. That is the correct direction here and only here — a path that is in no
 * workspace cannot have opted into a gate, so refusing it would block every caller outside a
 * workspace. It is NOT the same question as an enabled gate whose record is unreadable, which fails
 * closed (APPROVALS_UNVERIFIABLE).
 *
 * Which makes the WALK load-bearing rather than incidental (PR #287 review, P1). A bare
 * `findWorkspaceRoot` answers from THIS directory, and §7 puts every dev-tier ship in a linked
 * worktree that can sit outside the workspace tree — so the one invocation the gate was built for
 * read as "in no workspace" and turned the gate off, silently, in the safe-looking direction above.
 * `workspaceRootForRepoDir` asks the same question of the repo rather than of the directory.
 */
function readTeamBlockFor(repoDir: string) {
  try {
    const root = workspaceRootForRepoDir(repoDir);
    return root ? loadWorkspace(root).file.team : undefined;
  } catch { return undefined; }
}

/**
 * LOOP-567 — the two config facts the default-branch class needs, read the same read-only way
 * `readTeamBlockFor` reads the team block: the repo registry's `landing`, and the doc-landing
 * allowlist of the project that OWNS this repo. Both come from one workspace load.
 *
 * Absent/unresolvable workspace ⇒ `{ landing: undefined }` ⇒ the verdict treats it as `direct` and
 * permits. That is the same degrade every other class here takes for an unregistered repo, and it
 * is the right direction: a repo this workspace does not know is not a repo whose landing mode this
 * workspace may assert. `allow: null` is different — it means the repo IS registered under `pr` and
 * its project has no repo-file strategyDoc, which the verdict fails CLOSED on.
 */
function readLandingFactsFor(repoDir: string): { landing: string | undefined; allow: { docRel: string; archivePrefix: string } | null } {
  try {
    const ws = workspaceForRepoDir(repoDir);
    if (!ws) return { landing: undefined, allow: null };
    const ref = registeredRepoRefFor(ws, repoDir);
    if (!ref) return { landing: undefined, allow: null };
    const landing = (ws.file.repos?.[ref] as { landing?: string } | undefined)?.landing;
    const infer = inferProjectForRepo(ws, ref);
    // An ambiguous owner is not a licence to guess which project's doc path is permitted — the
    // carve-out simply does not resolve, and the verdict falls back to refusing code on `pr`.
    const docRel = infer.kind === "unique" ? strategyDocRelPath(ws.file.projects[infer.key]?.strategyDoc) : null;
    return { landing, allow: docRel ? docLandAllowlist(docRel) : null };
  } catch { return { landing: undefined, allow: null }; }
}

// Extract the ticket id from a dev-loop/<id> branch name. Returns undefined for other branch shapes.
const branchTicketId = (br: string): string | undefined => {
  const m = br.match(/^dev-loop\/(.+)$/);
  if (!m) return undefined;
  return m[1].match(TICKET_RE)?.[0]; // "LOOP-54" from "dev-loop/LOOP-54"
};

/**
 * LOOP-548 — which ticket is this commit's WORK, as distinct from which tickets it merely names.
 *
 * The ride-along class below asks "is this commit canceled work?", and before this it answered by
 * scanning the whole message: every id anywhere in subject or body was read as attribution. That
 * makes the loop's own hand-off grammar unpushable. §3's close+follow-up rule and §21a's escalation
 * both require a follow-up to supersede a `Canceled` predecessor, so a well-written follow-up commit
 * names that predecessor in its rationale — and the guard read the citation as the work. Measured on
 * `dev-loop/LOOP-452` at bb9d7c8: subject `test(w37): … (LOOP-452)`, LOOP-452 In Progress, one
 * mention of the superseded LOOP-426 in the body, HELD with no flag that waives the gate — and a
 * branch that cannot be refreshed also cannot clear merge-guard's ciFreshness axis, so the ticket
 * could not land by any route.
 *
 * The passenger class twenty lines below already separates the two (`allIds.includes(ownId)`); this
 * gives the ride-along class the same notion, keyed on the SUBJECT because that is where the repo's
 * commit convention puts the id — and where both MP-275 fixtures (`CERT-1: canceled work rides
 * along`, `CERT-3: superseded duplicate`) put it, so that class is detected exactly as before.
 *
 * A subject naming NO ticket falls back to the whole message, which is LOOP-25's class: an agent
 * commit carrying the id only in a `Ticket-Id:` trailer is attributed by that trailer, because there
 * is nothing else to attribute it to.
 *
 * The residual is deliberate. A commit whose subject names a live ticket while its content is really
 * canceled work is no longer caught by a body reference. Attribution beats mention: the alternative
 * hard-stops the normal follow-up shape, and a check that fires on routine work gets routed around —
 * the same reasoning the generated-cheatsheet exemption above already records.
 */
function attributedTicketIds(msg: string): string[] {
  const inSubject = [...new Set(msg.split("\n")[0].match(TICKET_RE) ?? [])] as string[];
  return inSubject.length ? inSubject : ([...new Set(msg.match(TICKET_RE) ?? [])] as string[]);
}

/**
 * Was this path ALREADY a real approvals record, before anyone opened it? Returns the reason it is
 * not, or `null` when it is usable (R5, PR #283 review).
 *
 * `existsSync` was not this question. `openDb` CREATES the current schema on any path it is handed —
 * a zero-byte or newly-created file opens clean, `listApprovals` returns nothing, and the gate reads
 * "no ticket is under approval" from a record it just fabricated. That is the R1 fail-open surviving
 * one input further out: an unavailable record read as an empty one.
 *
 * So the probe is READ-ONLY and runs BEFORE `openDb`: no create, no migrate. A missing file, a
 * non-SQLite file, and a SQLite file with no `approvals` table all answer the same way — unverifiable,
 * which fails closed — while a real record answers `null` and is opened normally.
 */
export function approvalsRecordUnusable(dbFile: string): string | null {
  if (!existsSync(dbFile)) return "the approvals record is unavailable";
  let probe: DatabaseSync;
  try { probe = new DatabaseSync(dbFile, { readOnly: true }); }
  catch { return "the approvals record is unreadable (not a database)"; }
  try {
    const row = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'").get();
    return row ? null : "the approvals record is uninitialised (no approvals table)";
  } catch { return "the approvals record is unreadable"; }
  // A handle that failed to read may also fail to close; that must not become the caller's exception.
  finally { try { probe.close(); } catch { /* nothing usable to close */ } }
}

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
 *
 * `record` is whether the consult appends its `approval.attempt` ledger row (R10, PR #283 review). It
 * says nothing about the VERDICT: every check runs and refuses identically either way — the only
 * difference is whether the audit trail gains a line. It exists for the caller that is inspecting
 * rather than pushing, and `doc-land --dry-run` is that caller today.
 */
function checkPushApprovals(
  commits: Array<{ sha: string; subject: string; msg: string }>,
  branch: string,
  dbFile: string,
  actor: string,
  unusable: string | null,
  record: boolean,
): PushGuardApproval[] {
  const out: PushGuardApproval[] = [];
  if (!commits.length) return out;
  // Fail CLOSED when the record is unreadable (APPROVALS_UNVERIFIABLE above). Only a commit carrying a
  // ticket ref can ever be under this gate — it keys on `ticket_id` — so the refusal names those and
  // stays silent about the rest rather than blanket-refusing a range it never had a claim on.
  if (unusable) {
    for (const c of commits) {
      const id = ([...new Set(c.msg.match(TICKET_RE) ?? [])] as string[])[0];
      if (!id) continue;
      out.push({
        sha: c.sha.slice(0, 7), subject: c.subject, key: pushApprovalKey(branch, c.sha), ticketId: id,
        state: APPROVALS_UNVERIFIABLE,
        reason: `${unusable} at ${dbFile}`,
      });
    }
    return out;
  }
  const conn = openDb(dbFile);
  try {
    // One read of the (small) table, indexed by ticket: the question "is this ticket under the gate"
    // is asked once per commit and the answer never changes within a run.
    const byTicket = new Map<string, number>();
    for (const r of listApprovals(conn, {})) {
      if (!r.ticket_id || !r.action_key.startsWith("push:")) continue;
      byTicket.set(r.ticket_id, (byTicket.get(r.ticket_id) ?? 0) + 1);
    }
    // The project each referenced ticket belongs to — `null` when this record has no row for it at
    // all. `tickets.project_id` is NOT NULL, so the two answers never blur (R8, PR #283 review).
    const ticketRow = conn.prepare("SELECT project_id FROM tickets WHERE id=?");
    const owner = new Map<string, string | null>();
    const projectOf = (id: string): string | null => {
      if (!owner.has(id)) owner.set(id, ((ticketRow.get(id) as { project_id?: string } | undefined)?.project_id) ?? null);
      return owner.get(id)!;
    };
    const now = new Date().toISOString();
    for (const c of commits) {
      const ids = [...new Set(c.msg.match(TICKET_RE) ?? [])] as string[];
      // No ticket ref at all: this gate keys on `ticket_id` and never had a claim on such a commit —
      // the same silence the unreadable-record branch above keeps.
      if (!ids.length) continue;
      const gatedIds = ids.filter((id) => byTicket.has(id));
      const key = pushApprovalKey(branch, c.sha);
      const unverifiable = (ticketId: string, why: string): void => {
        out.push({ sha: c.sha.slice(0, 7), subject: c.subject, key, ticketId, state: APPROVALS_UNVERIFIABLE, reason: why });
      };
      if (!gatedIds.length) {
        // R8 (PR #283 review) — "this ticket has no push: row" is an ANSWER only from a record that
        // knows the ticket. `DEVLOOP_HUB_DB` (or a programmatic dbPath) can select another
        // workspace's initialised hub: it passes the R5 probe, `listApprovals` returns rows that are
        // not about this work, and the real record's ungranted request is never read — `--strict`
        // exits 0 on precisely the push the gate exists to refuse. A record holding no row for ANY
        // ticket this commit names cannot speak for it, so the verdict is unverifiable, not clean.
        //
        // Ticket presence is a PROXY for "is this the workspace's own record": hub.db carries no
        // workspace identity to compare against (dev-loop.json's workspaceId has no counterpart in
        // the schema), so the exact check does not exist yet — LOOP-496. The proxy is exact for the
        // case that motivated it and errs toward refusing, which is this module's direction.
        if (ids.some((id) => projectOf(id) !== null)) continue;
        unverifiable(ids[0], `the approvals record at ${dbFile} holds no ticket ${ids.join(", ")} — it is not this work's record, so whether this work awaits approval cannot be read from it`);
        continue;
      }
      // R7 (PR #283 review) — the grant lookup is SCOPED to the project of the ticket under the gate.
      // Unscoped, `consultApproval` does its documented key-only match across every row, so in a
      // workspace whose projects share history (an upstream and its fork) a `push:<branch>:<sha>`
      // granted in project A authorises the identical branch+sha in project B. The scope comes from
      // the gated TICKET rather than from the repo directory because the ticket is what carries the
      // request, and a repo may be referenced by several projects. A workspace-scoped grant
      // (project_id NULL) still authorises — that narrowing is consultApproval's, not re-stated here.
      // This binds the LOOKUP, not the key: `push:<branch>:<sha>` is design §4 / AC4 and is unchanged
      // (the repo-in-the-key question Codex also raised is a spec call — LOOP-497).
      //
      // EVERY gated ticket the commit names is consulted, not just the first (R9). Scoping made that
      // load-bearing: each gated ticket now carries its OWN scope, so stopping at the first one lets a
      // grant in that ticket's project stand in for a different project's ungranted request on the
      // same commit. Unscoped they were interchangeable — the key alone decided — which is why the
      // `find` was harmless before R7 and is a hole after it.
      for (const gated of gatedIds) {
        const projectId = projectOf(gated);
        if (projectId === null) {
          unverifiable(gated, `${gated} carries a push: approval row in ${dbFile} but the record holds no ticket row for it, so the scope a grant would have to match cannot be resolved`);
          continue;
        }
        // The attempt IS ledgered (approvals §14 decision 4: the audit line must not depend on each
        // consumer remembering to ask) — unless the caller is only INSPECTING, which is not an attempt
        // to do anything. A ledger write can still fail — a busy db, a read-only handle — and a safety
        // gate that CRASHES is a safety gate that got skipped, so the verdict is re-taken without the
        // audit line rather than lost. `record:false` grants nothing and skips no check.
        let v;
        try { v = consultApproval(conn, key, now, { actor, ticketId: gated, projectId, record }); }
        catch { v = consultApproval(conn, key, now, { actor, ticketId: gated, projectId, record: false }); }
        if (v.authorises) continue;
        out.push({ sha: c.sha.slice(0, 7), subject: c.subject, key, ticketId: gated, state: v.state, reason: v.reason ?? "not authorised" });
      }
    }
  } finally { conn.close(); }
  return out;
}

export function pushGuard(repoDir: string, branch: string | undefined, dbPath: string | undefined, defaultBranch: string, opts: { enforcePush?: boolean; actor?: string; record?: boolean; remote?: string } = {}): PushGuardResult {
  // Every range below is measured against the remote the caller will actually PUSH TO. It was
  // hardcoded `origin`, which was correct while every caller pushed to origin — `dev-loop push`
  // accepts `--remote <name>`, so a non-origin push would have been gated against a different
  // remote's refs: the wrong commit range, or "unevaluated" for a remote that resolves fine
  // (PR #287 review, P2). Defaulted, so every existing caller is byte-identical.
  const remote = opts.remote ?? "origin";
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
  // Resolved HERE, before anything opens the db, because `openDb` creates the current schema on any
  // path it is handed — passenger detection below opens the very same file, so a probe run after it
  // would be judging a record that call had just fabricated (R5, PR #283 review). Whether the class is
  // enforced is a property of the WORKSPACE, not of who called this function: left unspecified it
  // resolves from the repo's own config, so a programmatic caller — doc-land's ff-only push is the one
  // that exists today — cannot fall outside an enabled gate by omitting an argument, and the next such
  // caller inherits the gate instead of having to remember it. An explicit boolean still wins: the CLI
  // passes the switch it already resolved, and the tests pin both states. Read the config, don't
  // RESOLVE the workspace: resolveWorkspace hydrates secrets into process.env and upserts the
  // machine-global index, and neither belongs in a guard this module documents as read-only.
  const enforcePush = opts.enforcePush ?? approvalsEnforced(readTeamBlockFor(repoDir), "push");
  // Default-OFF (design §8): with the class absent from `approvals.enforce` nothing here runs, no db
  // handle is opened — not even the read-only probe — and the result is byte-identical to the
  // pre-LOOP-394 output (AC2).
  const approvalsDbFile = enforcePush ? (dbPath ?? resolveHubDbPath(workspaceRootForRepoDir(repoDir) ?? repoDir)) : "";
  const recordUnusable = enforcePush ? approvalsRecordUnusable(approvalsDbFile) : null;
  // A record classified unusable must stay untouched for the REST of the guard, not just until the
  // next `openDb` (R6, PR #283 review). The other two axes open the same path, and `openDb` creates
  // the schema — so a first `--strict` run refused while initialising the very table it was refusing
  // for, and the second run found a usable, empty record and permitted the push. The refusal repaired
  // its own cause. Null while enforcement is off, so those axes behave exactly as before (AC2).
  const rejectedDb = recordUnusable ? approvalsDbFile : null;

  // ── The base this push is measured against — resolved ONCE, read by all four classes ──────────
  // With a remote: origin/<defaultBranch>, as always. With NO remote — a `git init` workspace on
  // `landing:"direct"`, which is a supported shape and the one worktree reap was fixed for in
  // 6c61f0e — the LOCAL <defaultBranch>. Every ref under `origin/` is unresolvable there, so the
  // guard used to report that passenger detection had not run (exit 1 under --strict, so nothing
  // could ever land) and to widen its range to the branch's whole history, which on a direct-landing
  // repo IS main's history: it re-flagged commits that landed weeks ago as ride-alongs.
  //
  // The predicate is whether THIS REPOSITORY has the remote, not whether the registry declares one:
  // the question being asked is "can origin/<defaultBranch> resolve", the registry can be stale in
  // either direction, and push-guard also runs on repos that are in no registry at all.
  const hasRemote = gitOk(["remote", "get-url", remote]);
  const baseRef = hasRemote
    ? (gitOk(["rev-parse", "--verify", "--quiet", `${remote}/${defaultBranch}`]) ? `${remote}/${defaultBranch}` : null)
    : (gitOk(["rev-parse", "--verify", "--quiet", defaultBranch]) ? defaultBranch : null);

  const passengers: PushGuardPassenger[] = [];
  let unresolvedDefaultBranch: string | undefined;
  const ownId = branchTicketId(br);
  if (ownId) {
    if (baseRef) {
      const pCommits = parseLog(git(["log", "-z", "--pretty=format:%H%n%B", `${baseRef}..${br}`]));
      // Open hub.db for passenger ticket-state lookups (read-only).
      const pgDb = dbPath ?? resolveHubDbPath(workspaceRootForRepoDir(repoDir) ?? repoDir);
      // An unreadable db degrades to the SAME path an absent one already takes (no state lookups,
      // passengers reported as unverifiable warnings). Before R5 it threw out of pushGuard entirely,
      // which took the approvals gate down with it — a corrupt record must make the safety gate
      // REFUSE, not disappear.
      let pgConn = null;
      if (existsSync(pgDb) && pgDb !== rejectedDb) { try { pgConn = openDb(pgDb); } catch { pgConn = null; } }
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
      // No base ref at all — neither origin/<defaultBranch> nor a local one. Record it; the caller
      // must fail loud (AC4: never silent).
      unresolvedDefaultBranch = defaultBranch;
    }
  }

  // LOOP-394 — the approvals gate covers the commits a push would PUBLISH, which is a different range
  // in the two cases: the unpushed tail for a tracked branch, and everything off the default branch
  // for a never-pushed one. The first push is the more dangerous of the two (nothing of it is on the
  // forge yet), so it is gated on the same footing rather than skipped with the note below.
  const hasUpstream = gitOk(["rev-parse", "--verify", "--quiet", `${remote}/${br}`]);
  const range = hasUpstream ? `${remote}/${br}..${br}`
    : baseRef ? `${baseRef}..${br}`
    // Neither remote ref resolves — an empty or brand-new remote, i.e. the first push the forge has
    // ever seen from this repo. That push publishes the branch's ENTIRE history, so that history is
    // the range. Absent refs make the published set WIDER, never narrower, and a `null` here read as
    // "no commits" — the same unavailable-is-not-empty fail-open R1 closed for the record itself.
    // Guarded on the branch resolving: an unborn branch genuinely publishes nothing.
    : gitOk(["rev-parse", "--verify", "--quiet", br]) ? br
    : null;
  // Ledgering the attempt is the DEFAULT — a consumer that forgot to ask for it would silently lose the
  // audit line, which is the failure approvals §14 decision 4 exists to prevent. Only a caller that
  // states it is inspecting opts out, and opting out changes nothing else about the verdict below.
  const approvals = enforcePush && range
    ? checkPushApprovals(parseLog(git(["log", "-z", "--pretty=format:%H%n%B", range])), br, approvalsDbFile, opts.actor ?? "unknown", recordUnusable, opts.record !== false)
    : [];

  // LOOP-528 — `findings` and `governance` measure the SAME range the approvals gate just measured.
  // Until this commit they were hard-coded `[]` whenever the branch had no upstream, and the verb
  // above cannot tell an empty class from an unevaluated one: `dev-loop push` reported a five-class
  // gate having run three. §16.3 D3 names that failure exactly — "a verb that wraps a gate and
  // quietly weakens it is worse than no verb, because the caller now believes a gate ran" — and the
  // case it happened in is the dev tier's normal one, the first push of `dev-loop/<id>`. The
  // §17 `governance` class is the one that matters most there: a first push carrying a
  // `conventions.md` or SKILL edit read clean.
  //
  // The range was never actually unavailable. `range` above already answers "what would this push
  // publish" for all three cases, and the approvals gate has been using it since LOOP-394; these two
  // classes were simply re-deriving `origin/<br>..<br>` for themselves and getting nothing. They now
  // read `range`, so the three classes that scan commits scan the same commits by construction.
  //
  // `range === null` is the one genuinely unevaluable case (no remote ref AND no local branch). It is
  // NOT reported as three empty classes: `unresolvedDefaultBranch` carries it, which is what
  // `dev-loop push` maps to exit 3 (D4 — "the gate checked nothing it could have checked"). Set here
  // rather than left to the passenger block above, which only sets it for a `dev-loop/<id>` branch —
  // an unevaluable range fails open on every other branch name otherwise.
  if (!range && !unresolvedDefaultBranch) unresolvedDefaultBranch = defaultBranch;
  // -z NUL-terminates each record so newlines in the body don't split records; %B is the full commit
  // message (subject + body), which allows ticket refs in trailers/footers to be detected (LOOP-25).
  const commits = range ? parseLog(git(["log", "-z", "--pretty=format:%H%n%B", range])) : [];

  // LOOP-535 — the ride-along and §17 classes judge CONTENT that would newly reach the default
  // branch; the approvals receipt above judges the commits this push PUBLISHES to the branch ref.
  // Those are the same set for a first push and for a fast-forward, and they diverge for exactly one
  // operation: a REBASE, which is what §12c prescribes as the remedy for a `stale` ciFreshness hold
  // or a `DIRTY` mergeStateStatus. After a rebase `origin/<br>` is the PRE-rebase tip, so
  // `origin/<br>..<br>` also contains every default-branch commit the rebase brought in — commits
  // already on `origin/<defaultBranch>`, which this push publishes nothing new about. Judging them
  // hard-stopped the refresh on already-published work with no flag to waive it: measured on
  // dev-loop/LOOP-396 rebased onto afc8bc6, the range held 12 commits where 1 was the branch's own,
  // and 9 findings named Canceled tickets belonging to commits (35f70b6, 7d9c7cf, c7a9e11, 8cbebbf,
  // 4cf6130) that were already ancestors of origin/main — one of them 1daa96d, LOOP-528's own fix.
  //
  // So subtract what the default branch already carries. This preserves LOOP-528's fix rather than
  // reverting it: the no-upstream arm is untouched, so a FIRST push still gates all five classes
  // (`origin/<defaultBranch>..<br>` already excludes the default branch by construction), and the
  // no-refs arm has no default-branch ref to subtract. Only the tracked-branch arm narrows.
  // `ahead` keeps counting `range` — it is printed as "ahead of origin/<branch>", which for a
  // rebased branch genuinely IS the wider number.
  const subtractPublished = hasUpstream && !!baseRef;
  const scanCommits = !range ? []
    : subtractPublished
      ? parseLog(git(["log", "-z", "--pretty=format:%H%n%B", range, "--not", baseRef!]))
      : commits;
  // Every referenced id, so `unknownRefs` still reports a ghost ref wherever it appears (LOOP-25).
  // Whether a reference is this commit's WORK is a separate question, asked per finding below.
  const refs = new Map<string, { sha: string; subject: string; msg: string }[]>();
  for (const c of scanCommits) {
    for (const id of c.msg.match(TICKET_RE) ?? []) (refs.get(id) ?? refs.set(id, []).get(id)!).push(c);
  }
  const findings: PushGuardFinding[] = [];
  const unknownRefs: string[] = [];
  // LOOP-528 — the THIRD reader of "which workspace is this directory". `d29c1f4` moved the default
  // branch, the `approvals.enforce` switch and the passenger db onto `workspaceRootForRepoDir` so a
  // call from a per-ticket worktree (the only place §7 lets a dev tier ship from) resolves the
  // workspace that owns the repo rather than the worktree's own path; this lookup was left behind and
  // silently degraded to "no local hub" there, reporting every ticket ref as unverifiable.
  const db = dbPath ?? resolveHubDbPath(workspaceRootForRepoDir(repoDir) ?? repoDir);
  // Same degrade as the passenger axis (R5): an UNREADABLE db is reported as unverifiable refs, the
  // path an absent one already takes, instead of throwing out of the guard and taking the approvals
  // gate with it.
  let conn = null;
  if (refs.size && existsSync(db) && db !== rejectedDb) { try { conn = openDb(db); } catch { conn = null; } }
  if (conn) {
    try {
      for (const [id, cs] of refs) {
        // ticket ids are a GLOBAL primary key across projects sharing one hub.db (seed.ts) — no project scope needed
        const row = conn.prepare("SELECT state FROM tickets WHERE id=?").get(id) as { state?: string } | undefined;
        if (!row) { unknownRefs.push(id); continue; }
        if (row.state === "Canceled" || row.state === "Duplicate")
          // LOOP-548 — a finding means "this commit IS canceled work", so it needs the commit to be
          // ATTRIBUTED to the terminal ticket, not merely to name it.
          for (const c of cs) {
            if (!attributedTicketIds(c.msg).includes(id)) continue;
            findings.push({ sha: c.sha.slice(0, 7), subject: c.subject, ticket: id, state: row.state as string });
          }
      }
    } finally { conn.close(); }
  } else if (refs.size) {
    unknownRefs.push(...refs.keys()); // no local hub (linear/local backend) — states unverifiable here
  }

  // §17 (LOOP-35) — governing-file edits in the unpushed range. Local git only, like every other
  // check here: no forge call, so it works offline and cannot be disabled by a `gh` outage.
  const governance: PushGuardGovernance[] = [];
  for (const c of scanCommits) {
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

  // LOOP-567 — the default-branch class. Measured on `range`, the set this push PUBLISHES, because
  // the question is what would REACH the branch, not what a rebase dragged through the branch ref.
  // One `git log --name-only` spawn over the same range the approvals gate used, so the class cannot
  // disagree with the receipt about which commits were judged.
  let landingVerdict: DefaultBranchPushVerdict | undefined;
  if (range && br === defaultBranch) {
    const facts = readLandingFactsFor(repoDir);
    // Only pay for the path scan once the cheap config predicate says the mode can trip. A `direct`
    // repo — the majority — spawns no extra git.
    if ((facts.landing ?? "direct") === "pr") {
      let changedPaths: string[] = [];
      try {
        changedPaths = [...new Set(git(["log", "--name-only", "--pretty=format:", range]).split("\n").map((f) => f.trim()).filter(Boolean))];
      } catch {
        // An unreadable range is NOT an empty one. The gate's own note records the same distinction
        // for the commit classes; here it decides a push to the default branch, so it fails closed
        // with a path set that cannot be mistaken for a doc landing.
        changedPaths = ["<unreadable range>"];
      }
      landingVerdict = defaultBranchPushVerdict({ branch: br, defaultBranch, landing: facts.landing, changedPaths, allow: facts.allow }) ?? undefined;
    }
  }

  // The note still reports a first push, but it no longer says "nothing to compare" — that sentence
  // described the bug. It names the range the three commit-scanning classes actually used, because a
  // reader judging a clean verdict needs to know WHICH commits were clean (LOOP-528 AC1).
  const note = hasUpstream ? undefined
    : range ? `no upstream ${remote}/${br} — first push of this branch; gated over ${range}`
    : `no upstream ${remote}/${br} and no ${hasRemote ? `${remote}/${defaultBranch}` : `local ${defaultBranch}`} or local ${br} — the range could not be resolved, so findings/passengers/governance did NOT run`;
  return { branch: br, ahead: commits.length, unknownRefs, findings, passengers, governance, approvals, unresolvedDefaultBranch, ...(note ? { note } : {}), ...(landingVerdict ? { landing: landingVerdict } : {}) };
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
  const ws = workspaceForRepoDir(absRepo);

  let defaultBranch: string;
  if (explicitDefaultBranch) {
    defaultBranch = explicitDefaultBranch;
  } else {
    const fromConfig = resolveDefaultBranchForRepoDir(absRepo);
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
  // AC2's byte-identity binds the --json surface too (R5, PR #283 review): with the gate off,
  // `approvals` is not part of the advertised contract, so it is not emitted and a script or snapshot
  // written against the pre-LOOP-394 shape keeps parsing unchanged. `undefined` drops the key while
  // leaving every other field in its original position. With the gate on, the field IS the point.
  if (asJson) { console.log(JSON.stringify(enforcePush ? r : { ...r, approvals: undefined }, null, 2)); }
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
    // LOOP-567 — the refusal for code on a `landing:"pr"` default branch. Printed alongside the
    // other classes rather than short-circuiting, so one run still reports everything it found.
    if (r.landing) console.log(defaultBranchPushRefusalLine(r.landing));
    // Names the ref that was actually missing. A repo with no remote has no `origin/main` to be
    // missing — saying so sent an operator looking for a remote that was never configured.
    if (r.unresolvedDefaultBranch) console.log(`⛔ push-guard: no base ref for '${r.unresolvedDefaultBranch}' (neither origin/${r.unresolvedDefaultBranch} nor a local ${r.unresolvedDefaultBranch}) — passenger detection did NOT run (a safety gate must not pass silently)`);
    if (r.unknownRefs.length) console.log(`note: ${r.unknownRefs.length} ticket ref(s) not verifiable here (${r.unknownRefs.slice(0, 5).join(", ")}${r.unknownRefs.length > 5 ? ", …" : ""}) — no matching row in the local hub`);
    if (!r.findings.length && !r.passengers.length && !r.governance.length && !r.approvals.length && !r.landing && !r.unresolvedDefaultBranch && !r.note) console.log("clean: no canceled/duplicate ticket refs, passengers, or §17 governing-file edits aboard");
  }
  process.exit(strict && (r.findings.length || r.passengers.length || r.governance.length || r.approvals.length || !!r.landing || !!r.unresolvedDefaultBranch) ? 1 : 0);
}
