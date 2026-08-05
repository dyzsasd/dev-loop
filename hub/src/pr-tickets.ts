// Every ticket a PR CLAIMS (LOOP-150).
//
// Every PR→ticket resolution in this codebase was one-branch-one-ticket: the id was parsed from the
// branch name and nothing else was ever consulted. A PR whose branch is `dev-loop/LOOP-A` but which
// also carries the fix for `LOOP-B` is, to every consumer of that resolution, a PR for `LOOP-A` only
// — and `LOOP-B` reads as having NO PR AT ALL.
//
// That is not hypothetical. PR #97 shipped on `dev-loop/LOOP-142` carrying LOOP-148's fix, and
// LOOP-148 read as unlanded while its code was already on main.
//
// Order matters: the BRANCH-derived id comes first when present. It is the id the PR was cut for,
// and every existing consumer treats the first (previously only) id as the PR's primary ticket —
// changing that order would silently re-point merge-guard's board axis at a passenger.
import { ticketIdScanRe } from "./ticket-id.ts";

export interface PrTicketSources { branch?: string | null; commitMessages?: string[]; title?: string | null; body?: string | null }

/**
 * Every ticket id the PR claims, deduped, branch-derived first.
 *
 * A pure function over already-fetched strings: the caller owns the `gh` call, so this stays
 * testable with fixtures and cannot itself fail on a forge outage.
 */
export function prTicketIds(src: PrTicketSources): string[] {
  const scan = ticketIdScanRe("g");
  const out: string[] = [];
  const add = (id: string): void => { if (id && !out.includes(id)) out.push(id); };

  const fromBranch = ticketFromBranch(src.branch ?? "");
  if (fromBranch) add(fromBranch);
  // Commits, then title/body. A commit message is the stronger claim — it is what actually shipped —
  // and prose in a body may merely REFERENCE another ticket, but both are claims a reader would act
  // on, and dropping either reintroduces the silent "no PR at all" answer this exists to remove.
  for (const text of [...(src.commitMessages ?? []), src.title ?? "", src.body ?? ""]) {
    for (const m of String(text).matchAll(scan)) add(m[0]);
  }
  return out;
}

/** The branch-shaped id: `dev-loop/<id>` or `fix/<id>-…`. Null when the branch carries none. */
export function ticketFromBranch(branch: string): string | null {
  const m = branch.match(/(?:dev-loop\/|fix\/)([^/\s]+)/);
  if (!m) return null;
  const hit = m[1].match(ticketIdScanRe());
  return hit ? hit[0] : null;
}
