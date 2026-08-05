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
