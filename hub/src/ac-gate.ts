// The COMPLETENESS axis of acceptance (LOOP-198).
//
// The board already gates the IDENTITY axis — LOOP-157 refuses a two-hop In Review→Done self-accept,
// because a builder tier cannot verify its own work. Nothing gated completeness.
//
// LOOP-153 listed three deliverables. B and C landed; A did not — and it went Done anyway. The
// consequence compounded: SIGINT-killed fires stayed subtracted from successRate, and the
// reported-vs-true gap grew from 3.4 points to 6.7 (reported 0.7867, true 0.8534) with every
// operator restart, permanently, for every consumer of that number.
//
// A partially-delivered ticket reads, in the diff and in the handoff comment, exactly like a
// complete one: the implementer's self-claim names what they DID, never what they skipped. The
// unchecked box is already sitting in the ticket body, in a machine-readable format, at the moment
// of the transition. This reads it.

import { execFileSync } from "node:child_process";

/** `- [ ]` / `- [x]` list items, with their text. Indentation and `*` bullets count. */
const CHECKBOX_RE = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]*(.*)$/gm;

export interface AcBox { checked: boolean; text: string }

export function parseAcBoxes(description: string): AcBox[] {
  const out: AcBox[] = [];
  for (const m of String(description ?? "").matchAll(CHECKBOX_RE)) {
    out.push({ checked: m[1].toLowerCase() === "x", text: m[2].trim() });
  }
  return out;
}

/**
 * A waiver comment: `AC-waived: <what> — <reason>`.
 *
 * The reason is REQUIRED. A waiver with no reason is not a waiver — it is the silent close this gate
 * exists to stop, wearing a marker. Rejected, and the refusal says so.
 *
 * A bare line, like every other marker on this board (`Blocked-by:`, `Design:`): a ticket that
 * QUOTES the marker while discussing it must not waive itself.
 */
const WAIVER_RE = /^[ \t]*AC-waived:[ \t]*(.+)$/im;

export function waiverReason(commentBodies: string[]): string | null {
  for (const body of commentBodies) {
    const m = WAIVER_RE.exec(String(body ?? ""));
    if (!m) continue;
    // Require substance after the marker AND after any separator, so `AC-waived: 3` alone is not a
    // waiver. An em-dash, a hyphen or a colon all separate the WHAT from the WHY.
    const rest = m[1].trim();
    const sep = rest.search(/[—–:-]/);
    const why = sep >= 0 ? rest.slice(sep + 1).trim() : "";
    if (why.length >= 3) return rest;
  }
  return null;
}

export interface AcGateInput { id: string; description: string; toState: string; fromState: string; actor: string; commentBodies: string[]; enabled?: boolean }

/**
 * OPT-IN, and the measurement is why (LOOP-198 AC5).
 *
 * Run retroactively over this board's 276 Done rows: 253 carry at least one checkbox, and **247 of
 * those 253 would have been refused** — many of them showing every box unchecked (7/7, 9/9). Zero
 * had a waiver.
 *
 * That is not 247 incomplete tickets. It is the convention: on this board the boxes are written and
 * never ticked, so an unchecked box carries no information about completeness. A gate keyed on a
 * signal nobody maintains refuses ~98% of closes, which is not a gate — it is a wall, and the first
 * thing it produces is a reflex waiver on every ticket, which is strictly worse than no gate at all.
 *
 * So the mechanism ships and the enforcement waits on the convention. Turn it on per team with
 * `dev-loop team set team.intake.acCompletenessGate true` once ticking the boxes is the practice;
 * until then it is inert and cannot refuse anything.
 */

/**
 * The refusal string, or null.
 *
 * ZERO checkboxes ⇒ no opinion. Older tickets and non-AC tickets predate this convention entirely,
 * and a gate that fires on them would be refusing something it cannot possibly have measured.
 *
 * The OPERATOR is exempt, consistent with every other gate in this layer: the operator is the human's
 * console, and a human ruling on a ticket IS the acceptance this gate stands in for. The waiver
 * remains available to every actor, including the operator, when the trail matters.
 */
export function acCompletenessRejection(inp: AcGateInput): string | null {
  if (inp.enabled !== true) return null; // opt-in — see the AC5 measurement above
  if (inp.toState !== "Done" || inp.fromState === "Done") return null;
  if (inp.actor === "operator") return null;
  const boxes = parseAcBoxes(inp.description);
  if (boxes.length === 0) return null;
  const unchecked = boxes.filter((b) => !b.checked);
  if (unchecked.length === 0) return null;
  if (waiverReason(inp.commentBodies)) return null;
  const shown = unchecked.slice(0, 3).map((b) => `  - [ ] ${b.text.slice(0, 90)}${b.text.length > 90 ? "…" : ""}`).join("\n");
  return `verify gate: → Done blocked — ${inp.id} has ${unchecked.length} of ${boxes.length} acceptance criteria still unchecked:\n${shown}${unchecked.length > 3 ? `\n  …and ${unchecked.length - 3} more` : ""}\n`
    + `A part that did not land reads exactly like one that did, which is why this is mechanical rather than a matter of reading more carefully. `
    + `Either check the boxes that are genuinely done, or comment a waiver naming the reason: \`AC-waived: <which> — <why>\` (a waiver with no reason is refused).`;
}

// ─── LOOP-575: the UNLANDED axis — the same `→ Done` edge, a different omission ──────────────────
//
// The axis above asks whether the ticket SAID it was finished. This one asks whether the ticket's
// own pushed work actually reached the shipping tree.
//
// `Done` is terminal, so a ticket that reaches it leaves EVERY queue arm at once: the dev tiers'
// repair arm is scoped to `inReview`, PM/QA Job A scans `In Review`, and nothing anywhere scans
// terminal tickets. Work still sitting on the ticket's branch at that moment is therefore not
// waiting — it is unreachable by construction, because returning to it requires a queue arm and
// there is none. That is the terminal corner of LOOP-454, whose remedy presupposes the ticket can
// still be fired on.
//
// Both live routes, measured 2026-08-11:
//   • LOOP-502 closed 08:54:02Z against PR #300, still OPEN — the ENOBUFS fix is on no shipping tree.
//   • LOOP-518 closed 08:40:52Z on a direct push (`a5a3bfc`, 4 lines) while PR #306 carried a
//     divergent 27-line implementation of the same fix, which has since gone DIRTY.
//
// LOCAL GIT ONLY, for the reason handoff-gate.ts states at length: this gate layer answers from
// local refs after a fetch and never calls the forge, so a `gh` outage cannot wall the board.

/**
 * Which of the ticket's own branches still carry content the base branch does not have?
 *
 * THE PREDICATE TRAP, and why the two obvious answers are both wrong (both measured on LOOP-502):
 *
 *   • `git log <base> --grep=<id>` reports it LANDED. Its three matches on this board are two
 *     `docs(strategy)` passes that merely cite the id and one unrelated ticket's merge body. A
 *     message-only witness is a false negative, and false-negative is the exact direction that lets
 *     this defect through — so the message is never the witness here.
 *   • `merge-base --is-ancestor <branch> <base>` reports EVERY branch unlanded, because this repo
 *     squash-merges: a legitimately landed branch head is never an ancestor of the base.
 *
 * So the witness is CONTENT. For each ref naming the ticket, take the paths the branch itself
 * changed since its merge-base, then ask whether the base still differs from the branch on any of
 * them. A squash-landed branch differs nowhere (the squash carries the same tree), so it is silent;
 * a branch whose work never landed — or whose work landed in a DIFFERENT form, which is LOOP-518's
 * route — still differs, and those paths are the residue.
 *
 * Restricting to the branch's OWN paths is what keeps the base's unrelated progress out of the
 * answer: main advances constantly, and a plain base..branch diff would call every landed branch
 * unlanded within minutes.
 *
 * KNOWN LIMIT, stated rather than papered over: if the base later MODIFIES a file the branch also
 * touched, that path re-enters the residue and a legitimately landed ticket can be refused. The
 * residue is reported per-path so the reader can see it, AC5's waiver clears it in one step, and
 * AC4's retroactive measurement is what decides whether the axis may enforce at all.
 */
export function unlandedBranchResidue(repoRoot: string, baseRef: string, ticketId: string): { branch: string; paths: string[] }[] {
  const git = (args: string[]): string => execFileSync("git", ["-C", repoRoot, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);
  let refs: string[];
  try {
    // Both local heads and remote-tracking refs: PM's LOOP-384 note is explicit that the
    // unreachable work is NOT always behind a PR, so a local-only branch counts exactly as much.
    //
    // Filtered HERE rather than by a `refs/heads/*<id>*` pattern: for-each-ref matches with
    // wildmatch under pathname semantics, so `*` does not cross a `/` and that pattern silently
    // matches nothing at all for the one branch shape this board uses — `dev-loop/<id>`. A pattern
    // that matches zero refs and one that has no work to report are the same empty output, so the
    // mistake reads exactly like a clean board.
    refs = lines(git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]))
      .filter((r) => r.includes(ticketId));
  } catch { return []; } // no git, not a repo, unreadable ⇒ no opinion, never a hard failure
  const out: { branch: string; paths: string[] }[] = [];
  const seenTip = new Set<string>();
  for (const ref of refs) {
    try {
      // A local branch and its remote-tracking twin at the same tip are ONE piece of work; reporting
      // both would double every refusal.
      const tip = git(["rev-parse", ref]).trim();
      if (!tip || seenTip.has(tip)) continue;
      seenTip.add(tip);
      // Nothing on this branch that the base lacks ⇒ merged the ordinary way; no question to ask.
      if (!lines(git(["rev-list", "--max-count=1", `${baseRef}..${ref}`])).length) continue;
      const mergeBase = git(["merge-base", baseRef, ref]).trim();
      if (!mergeBase) continue;
      const own = lines(git(["diff", "--name-only", mergeBase, ref]));
      if (!own.length) continue;
      const residue = lines(git(["diff", "--name-only", baseRef, ref, "--", ...own]));
      if (residue.length) out.push({ branch: ref.replace(/^refs\/(heads|remotes)\//, ""), paths: residue });
    } catch { continue; } // one unreadable ref must not blind the axis to the others
  }
  return out;
}

export interface UnlandedGateInput {
  id: string; toState: string; fromState: string; actor: string; commentBodies: string[];
  repoRoot?: string;    // absent ⇒ nothing to measure against; the axis stays silent
  baseRef?: string;     // `origin/<defaultBranch>`, resolved by the caller
  enabled?: boolean;
}

/**
 * The refusal string, or null.
 *
 * OPT-IN, on the same reasoning ac-gate's own author recorded above and for the same kind of
 * measured reason — the AC4 count is posted on LOOP-575 and quoted in the ticket's close. Turn it on
 * with `dev-loop team set team.intake.unlandedWorkGate true`.
 *
 * The OPERATOR is exempt, consistent with every other gate in this layer (AC5): the console closes
 * and re-routes tickets by hand, and a human ruling on a ticket IS the acceptance this stands in
 * for. Every actor keeps the waiver — `AC-waived: <what> — <why>`, the marker this module already
 * defines — so a legitimate close with knowingly-abandoned work stays one step, not two.
 */
export function unlandedWorkRejection(inp: UnlandedGateInput): string | null {
  if (inp.enabled !== true) return null; // opt-in — see AC4's retroactive measurement on LOOP-575
  if (inp.toState !== "Done" || inp.fromState === "Done") return null;
  if (inp.actor === "operator") return null;
  if (!inp.repoRoot || !inp.baseRef) return null;
  if (waiverReason(inp.commentBodies)) return null;
  const stranded = unlandedBranchResidue(inp.repoRoot, inp.baseRef, inp.id);
  if (!stranded.length) return null;
  const shown = stranded.slice(0, 3).map((b) => `  - ${b.branch}: ${b.paths.slice(0, 4).join(", ")}${b.paths.length > 4 ? ` …and ${b.paths.length - 4} more` : ""}`).join("\n");
  return `verify gate: → Done blocked — ${inp.id} still has pushed work that is not on ${inp.baseRef}:\n${shown}${stranded.length > 3 ? `\n  …and ${stranded.length - 3} more branch(es)` : ""}\n`
    + `Done is terminal, so closing now takes this work out of every queue arm at once — no agent scans terminal tickets, so nothing will ever come back for it. `
    + `Land the branch (\`dev-loop pr merge <pr>\`), or close its PR and say why on the ticket, then close. `
    + `If the work is knowingly abandoned, comment a waiver naming the reason: \`AC-waived: <which> — <why>\`. `
    + `This check reads LOCAL git only — it does not require \`gh\`, a PR, or a network.`;
}
