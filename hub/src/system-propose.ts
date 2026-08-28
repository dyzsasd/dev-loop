#!/usr/bin/env node
// `dev-loop system propose|list|show|resolve` — the §17 firewall's SANCTIONED route (WS-C C6).
//
// conventions.md §17 draws a bright line: an agent MUST NOT rewrite conventions.md, a SKILL file, or
// the workspace config; a change there is drafted as a proposal and applied by the operator as a git
// commit. Until now "drafted as a proposal" meant a `[reflect-proposal]` ticket or a paragraph in a
// report — findable, but not a queue. This file gives the proposal a home the operator's read model
// (`dev-loop status` → decisionQueue.proposals) can count, and gives every agent, in any harness, a
// verb that is the RIGHT thing to do instead of an edit.
//
// It is a file inbox, not a hub table, on purpose: `<workspace>/.dev-loop/system-inbox/<ts>-<slug>.md`
// with a frontmatter header and the proposal as the body. A proposal is text the operator will read,
// diff and maybe apply by hand; a markdown file in the state tree is what they would have written
// themselves, it travels with the workspace (I4: copy the folder = migrate the machine), and it needs
// no schema migration. The hub db is not involved, so this works on the linear backend too.
//
// Authority: `propose` is AGENT-callable — filing authorises nothing, and a fire that could not file
// would route around the firewall (the same reasoning as `dev-loop request`). `resolve` is OPERATOR-
// ONLY, refused under a fire marker in exactly approvals-cli's shape: the guard names what the
// operator must do and deliberately names no flag, token or env change that would let a fire through.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace, wsStateRoot } from "./workspace.ts";
import { type Workspace } from "./team-config.ts";
import { activeFireMarker } from "./destructive-guard.ts"; // the ONE fire-marker list, owned there

export const PROPOSAL_STATUSES = ["open", "accepted", "rejected", "applied"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const PROPOSAL_SEVERITIES = ["low", "medium", "high"] as const;
export type ProposalSeverity = (typeof PROPOSAL_SEVERITIES)[number];
/** The resolutions an operator may write; `open` is the filing state, never a resolution. */
export const RESOLVE_STATUSES: readonly ProposalStatus[] = ["accepted", "rejected", "applied"];

export interface Proposal {
  id: string;            // `<compact-ts>-<slug>` — also the file's basename; lexicographic order = time order
  from: string;          // DEVLOOP_ACTOR at filing time
  fireId: string | null; // DEVLOOP_FIRE_ID when filed inside a fire
  target: string;        // the governing file the proposal is about (repo-relative path or a name)
  title: string;
  severity: ProposalSeverity;
  status: ProposalStatus;
  created: string;       // ISO
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;   // the operator's words at resolve time
  body: string;
  path: string;
}

export function inboxDir(ws: Workspace): string { return join(wsStateRoot(ws), "system-inbox"); }

// One line, no control characters: a frontmatter value must never be able to close the header or
// smuggle a second key (an agent writes these, and the operator reads them as truth).
const oneLine = (s: string, max = 400): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const ID_RE = /^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,60}$/;

export function slugOf(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "proposal";
}
export function compactTs(ms: number): string { return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }

export function renderProposal(p: Omit<Proposal, "path">): string {
  const nul = (v: string | null) => (v === null ? "" : oneLine(v));
  return [
    "---",
    `id: ${p.id}`,
    `from: ${oneLine(p.from)}`,
    `fireId: ${nul(p.fireId)}`,
    `target: ${oneLine(p.target)}`,
    `title: ${oneLine(p.title)}`,
    `severity: ${p.severity}`,
    `status: ${p.status}`,
    `created: ${p.created}`,
    `resolvedBy: ${nul(p.resolvedBy)}`,
    `resolvedAt: ${nul(p.resolvedAt)}`,
    `note: ${nul(p.note)}`,
    "---",
    p.body.replace(/\s+$/, ""),
    "",
  ].join("\n");
}

/** Tolerant parse: a hand-edited or torn file yields null rather than crashing the listing. */
export function parseProposal(text: string, path: string): Proposal | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const fm: Record<string, string> = {};
  for (const l of lines.slice(1, end)) { const m = /^([A-Za-z]+):\s?(.*)$/.exec(l); if (m) fm[m[1]] = m[2].trim(); }
  const status = PROPOSAL_STATUSES.find((s) => s === fm.status);
  const severity = PROPOSAL_SEVERITIES.find((s) => s === fm.severity) ?? "medium";
  if (!fm.id || !ID_RE.test(fm.id) || !status) return null;
  const opt = (k: string) => (fm[k] ? fm[k] : null);
  return {
    id: fm.id, from: fm.from || "?", fireId: opt("fireId"), target: fm.target || "?", title: fm.title || fm.id, severity, status,
    created: fm.created || "", resolvedBy: opt("resolvedBy"), resolvedAt: opt("resolvedAt"), note: opt("note"),
    body: lines.slice(end + 1).join("\n").replace(/\s+$/, ""), path,
  };
}

export interface ProposeInput { from: string; fireId?: string | null; target: string; title?: string; severity?: ProposalSeverity; body: string }
export function writeProposal(ws: Workspace, input: ProposeInput, nowMs = Date.now()): Proposal {
  const dir = inboxDir(ws);
  mkdirSync(dir, { recursive: true });
  const title = oneLine(input.title ?? input.body.split("\n").find((l) => l.trim()) ?? input.target, 120);
  let id = `${compactTs(nowMs)}-${slugOf(input.title ?? input.target)}`;
  // Two proposals in the same second with the same slug: disambiguate rather than clobber.
  for (let n = 2; existsSync(join(dir, `${id}.md`)); n++) id = `${compactTs(nowMs)}-${slugOf(input.title ?? input.target).slice(0, 36)}-${n}`;
  const p: Proposal = {
    id, from: input.from, fireId: input.fireId ?? null, target: input.target, title, severity: input.severity ?? "medium",
    // body normalised to the on-disk form (trailing whitespace trimmed) so the returned object IS what parse reads back
    status: "open", created: new Date(nowMs).toISOString(), resolvedBy: null, resolvedAt: null, note: null, body: input.body.replace(/\s+$/, ""), path: join(dir, `${id}.md`),
  };
  writeFileSync(p.path, renderProposal(p), { flag: "wx" });
  return p;
}

/** Newest first (the id's timestamp prefix sorts), optionally one status only. */
export function listProposals(ws: Workspace, opts: { status?: ProposalStatus | null } = {}): Proposal[] {
  const dir = inboxDir(ws);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; }
  const out: Proposal[] = [];
  for (const f of files) {
    let p: Proposal | null = null;
    try { p = parseProposal(readFileSync(join(dir, f), "utf8"), join(dir, f)); } catch { p = null; }
    if (p && (!opts.status || p.status === opts.status)) out.push(p);
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

export function readProposal(ws: Workspace, id: string): Proposal | null {
  if (!ID_RE.test(id)) return null;
  const path = join(inboxDir(ws), `${id}.md`);
  try { return parseProposal(readFileSync(path, "utf8"), path); } catch { return null; }
}

export function resolveProposal(ws: Workspace, id: string, r: { status: ProposalStatus; by: string; note?: string | null }, nowMs = Date.now()): Proposal {
  const p = readProposal(ws, id);
  if (!p) throw new Error(`no such proposal '${id}' (dev-loop system list)`);
  if (!RESOLVE_STATUSES.includes(r.status)) throw new Error(`--status must be one of ${RESOLVE_STATUSES.join("|")}`);
  const next: Proposal = { ...p, status: r.status, resolvedBy: r.by, resolvedAt: new Date(nowMs).toISOString(), note: r.note ?? null };
  writeFileSync(p.path, renderProposal(next));
  return next;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────────────
function usage(): void {
  console.log(`dev-loop system — propose a change to a GOVERNING file (SKILL.md / conventions.md / dev-loop.json)
without editing it: the §17 firewall's sanctioned route. Inbox: <workspace>/.dev-loop/system-inbox/.

Usage:
  dev-loop system propose --target <file> (--body TEXT | --body-file F | -) [--title T] [--severity low|medium|high] [--json]
                          agent-callable — files the proposal as DEVLOOP_ACTOR (+ DEVLOOP_FIRE_ID); authorises nothing
  dev-loop system list [--status open|accepted|rejected|applied] [--json]     newest first
  dev-loop system show <id> [--json]
  dev-loop system resolve <id> --status accepted|rejected|applied [--note T] [--json]
                          OPERATOR-ONLY — refused inside an agent fire (exit 4). \`applied\` = the operator
                          committed the change; \`accepted\` = will apply; \`rejected\` = will not, say why in --note
Exit: 0 ok · 1 domain (unknown id) · 2 usage · 4 refused inside a fire.
An open proposal counts in \`dev-loop status\` → decisionQueue.proposals until the operator resolves it.`);
}

function readBodyArg(argv: string[], i: { body?: string; bodyFile?: string; stdin?: boolean }): string | undefined {
  if (i.body !== undefined) return i.body;
  if (i.bodyFile !== undefined) return readFileSync(i.bodyFile, "utf8");
  if (i.stdin) return readFileSync(0, "utf8");
  return undefined;
}

export async function systemCli(argv = process.argv.slice(2)): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { usage(); return sub ? 0 : 2; }
  if (!["propose", "list", "show", "resolve"].includes(sub)) { console.error(`dev-loop system: unknown subcommand '${sub}'`); usage(); return 2; }

  // Parse the flat flag set once; each verb validates what it needs.
  const o: { target?: string; title?: string; severity?: string; status?: string; note?: string; body?: string; bodyFile?: string; stdin?: boolean; json: boolean; pos: string[] } = { json: false, pos: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = (): string => { const v = rest[++i]; if (v === undefined) { throw new Error(`${a} requires a value`); } return v; };
    try {
      if (a === "--json") o.json = true;
      else if (a === "-") o.stdin = true;
      else if (a === "--target") o.target = val();
      else if (a === "--title") o.title = val();
      else if (a === "--severity") o.severity = val();
      else if (a === "--status") o.status = val();
      else if (a === "--note") o.note = val();
      else if (a === "--body") o.body = val();
      else if (a === "--body-file") o.bodyFile = val();
      else if (a.startsWith("--")) { console.error(`dev-loop system ${sub}: unknown option '${a}'`); return 2; }
      else o.pos.push(a);
    } catch (e) { console.error(`dev-loop system ${sub}: ${(e as Error).message}`); return 2; }
  }
  const emit = (p: Proposal | Proposal[], text: () => string): void => { process.stdout.write((o.json ? JSON.stringify(p, null, 2) : text()) + "\n"); };
  const line = (p: Proposal) => `${p.id}  [${p.status}]  ${p.severity.padEnd(6)}  ${p.target}  — ${p.title}  (from ${p.from}${p.fireId ? ` fire ${p.fireId}` : ""}, ${p.created})`;

  const ws = resolveWorkspace(); // WsNotFound → the cli-bootstrap one-liner (LOOP-283)
  const actor = process.env.DEVLOOP_ACTOR?.trim() || "operator";

  if (sub === "propose") {
    if (!o.target) { console.error("dev-loop system propose: --target <file> is required (the governing file the change is about)"); return 2; }
    if (o.severity !== undefined && !PROPOSAL_SEVERITIES.includes(o.severity as ProposalSeverity)) { console.error(`dev-loop system propose: --severity must be one of ${PROPOSAL_SEVERITIES.join("|")}`); return 2; }
    let body: string | undefined;
    try { body = readBodyArg(rest, o); } catch (e) { console.error(`dev-loop system propose: ${(e as Error).message}`); return 2; }
    if (body === undefined || !body.trim()) { console.error("dev-loop system propose: needs --body TEXT, --body-file F, or '-' (stdin) — and it must not be empty"); return 2; }
    const p = writeProposal(ws, { from: actor, fireId: process.env.DEVLOOP_FIRE_ID?.trim() || null, target: o.target, title: o.title, severity: o.severity as ProposalSeverity | undefined, body });
    emit(p, () => `dev-loop system propose: filed ${p.id} → ${p.path}\n  the operator resolves it with: dev-loop system resolve ${p.id} --status accepted|rejected|applied`);
    return 0;
  }
  if (sub === "list") {
    if (o.status !== undefined && !PROPOSAL_STATUSES.includes(o.status as ProposalStatus)) { console.error(`dev-loop system list: --status must be one of ${PROPOSAL_STATUSES.join("|")}`); return 2; }
    const ps = listProposals(ws, { status: (o.status as ProposalStatus | undefined) ?? null });
    emit(ps, () => (ps.length ? ps.map(line).join("\n") : `dev-loop system list: no ${o.status ?? ""} proposals in ${inboxDir(ws)}`));
    return 0;
  }
  const id = o.pos[0];
  if (!id) { console.error(`usage: dev-loop system ${sub} <id> …`); return 2; }
  if (sub === "show") {
    const p = readProposal(ws, id);
    if (!p) { console.error(`dev-loop system show: no such proposal '${id}'`); return 1; }
    emit(p, () => `${line(p)}${p.resolvedBy ? `\n  resolved by ${p.resolvedBy} at ${p.resolvedAt}${p.note ? `: ${p.note}` : ""}` : ""}\n\n${p.body}`);
    return 0;
  }
  // resolve — the operator's act. Same shape as approvals-cli's grant refusal: the check runs BEFORE
  // the file is even read, names the marker, and names no way through.
  const marker = activeFireMarker();
  if (marker) {
    console.error(
      `dev-loop system resolve: refusing inside an agent fire (${marker} is set). ` +
      `Resolving a proposal to a governing file is the operator's act — an agent that could accept its own ` +
      `proposal would be editing the firewall from inside it (conventions §17). Nothing has been read or written. ` +
      `Leave it open; the operator resolves it from their own console, outside any fire.`,
    );
    return 4;
  }
  if (!o.status || !RESOLVE_STATUSES.includes(o.status as ProposalStatus)) { console.error(`dev-loop system resolve: --status must be one of ${RESOLVE_STATUSES.join("|")}`); return 2; }
  try {
    const p = resolveProposal(ws, id, { status: o.status as ProposalStatus, by: actor, note: o.note ?? null });
    emit(p, () => `dev-loop system resolve: ${p.id} → ${p.status} by ${p.resolvedBy}${p.note ? ` (${p.note})` : ""}`);
    return 0;
  } catch (e) { console.error(`dev-loop system resolve: ${(e as Error).message}`); return 1; }
}

if (isMainEntry(import.meta.url)) {
  systemCli().then((c) => { process.exitCode = c; }, (e) => { console.error(`dev-loop system: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
