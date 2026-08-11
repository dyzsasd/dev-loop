// LOOP-360 regression: a §21a DESIGN PARENT reaches In Review without a commit.
//
// LOOP-309's handoff gate refuses `In Progress → In Review` unless a commit or a branch in the
// target repo names the ticket. That is right for code, and wrong for a design parent: its verified
// increment is the design doc plus the staged children, and on `backend:"service"` the doc lives in
// the hub db, not the repo — so no witness can ever exist however correctly the work was done.
// `designParentGate` covers only the `In Review → Done` edge, so the design hand-off fell straight
// through to a gate with no notion of design parents and the senior design tier could not deliver
// at all on a landing:"pr" repo. Measured on LOOP-348, which had its design doc saved and four
// children staged and still could not hand off.
//
// The exemption keys on what the ticket IS, never on the absence of a commit — so the two zero-commit
// code handoffs LOOP-309 exists to catch (LOOP-31, LOOP-294) are still refused. Both directions are
// asserted here; an exemption asserted in one direction only is unfalsifiable.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { insertTicket, updateTicketRow } from "../src/ticketwrite.ts";
import type { NewTicketFields, TicketUpdateFields } from "../src/ticketwrite.ts";
import { handoffGateRejection } from "../src/handoff-gate.ts";
import { AGENT_HANDLES } from "../src/seed.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-l360-")));
const cwd0 = process.cwd();
try {
  // ── 1. The gate's own contract, in both directions ────────────────────────────────────────────
  {
    const base = {
      fromState: "In Progress", toState: "In Review", actor: "senior-dev",
      repoRoot: tmp, landing: "pr" as const,
    };
    ok(handoffGateRejection({ ...base, id: "LOOP-348", isDesignParent: true }) === null,
      "LOOP-360: a design parent passes the handoff gate with no commit and no branch");
    const refused = handoffGateRejection({ ...base, id: "LOOP-348", isDesignParent: false });
    ok(refused !== null && /no commit or branch/.test(refused),
      "LOOP-360 control: the SAME input without the design-parent verdict is still refused — the exemption is what changes the answer, not the fixture");
    ok(handoffGateRejection({ ...base, id: "LOOP-348" }) !== null,
      "LOOP-360: the field is opt-in — omitting it leaves LOOP-309's behaviour exactly as it was");
  }

  // ── 2. The wiring: the REAL write path, on a workspace whose repo is landing:"pr" ──────────────
  // A unit test of the boolean alone would pass even if the call site never set it, so the decisive
  // assertions go through updateTicketRow with a resolvable workspace.
  const wsRoot = join(tmp, "ws");
  const repoDir = join(wsRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  execFileSync("git", ["-C", repoDir, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-qm", "init"]);
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "l360", backend: "service" },
    repos: { repo: { path: "repo", landing: "pr" } },
    // Lowercase: E11 rejects an uppercase project key, landingContextFor swallows the throw, and the
    // gate then goes silent — which passes every positive assertion below for the wrong reason. The
    // negative control at (b) is what catches that, and did.
    // The project must REFERENCE the repo (landingContextFor resolves through projects.<key>.repos,
    // whose entries are {ref, role} objects) — a project with no repos yields no repoRoot.
    projects: { tw: { prefix: "TW", devSplit: true, repos: [{ ref: "repo", role: "primary" }] } },
  }));

  const db = openDb(join(wsRoot, "hub.db"));
  for (const h of AGENT_HANDLES) {
    db.prepare("INSERT INTO actors(id,handle,kind,display_name,created_at) VALUES(?,?,?,?,?)")
      .run(h, h, "agent", h, "2024-01-01T00:00:00Z");
  }
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)")
    .run("p", "tw", "test", "2024-01-01T00:00:00Z");

  const newFields = (o: Partial<NewTicketFields> = {}): NewTicketFields => ({
    title: "t", description: "", type: "Improvement", state: "In Progress",
    assignee: null, priority: 0, labels: [], duplicateOf: null, relatedTo: [], ...o,
  });
  const toInReview = (o: Partial<TicketUpdateFields> = {}): TicketUpdateFields => ({
    title: "t", description: "", type: "Improvement", state: "In Review",
    assignee: "senior-dev", priority: 0, labels: "[]", duplicate_of: null, related_to: "[]", waiting_on: null, ...o,
  });

  // `landingContextFor` resolves the workspace from cwd; without this the gate sees no repoRoot and
  // stays silent, which would make every assertion below vacuously pass.
  process.chdir(wsRoot);

  // (a) The measured defect: a `Mode: design` parent, no commit anywhere.
  const designBody = "Mode: design\n\nDesign lives at hubDoc:design/l360-module.\n";
  const parentId = insertTicket(db, "p", "senior-dev",
    newFields({ description: designBody, assignee: "senior-dev", labels: ["dev-loop", "senior-dev"] }), {});
  const parentMove = updateTicketRow(db, "p", "senior-dev", parentId, "In Progress",
    toInReview({ description: designBody, labels: JSON.stringify(["dev-loop", "senior-dev"]) }));
  ok(parentMove.ok === true,
    `LOOP-360: a Mode:design parent moves In Progress → In Review through the real write path with no commit (${parentMove.ok ? "ok" : parentMove.error})`);

  // (b) The negative control, and the proof the fixture is live: an ordinary code ticket in the SAME
  // repo with no commit must STILL be refused. If the workspace had failed to resolve, the gate would
  // be silent here and this assertion would fail — so it validates the fixture as well as the scope.
  const codeId = insertTicket(db, "p", "junior-dev",
    newFields({ description: "an ordinary build ticket\n", assignee: "junior-dev", labels: ["dev-loop", "junior-dev"] }), {});
  const codeMove = updateTicketRow(db, "p", "junior-dev", codeId, "In Progress",
    toInReview({ assignee: "junior-dev", description: "an ordinary build ticket\n", labels: JSON.stringify(["dev-loop", "junior-dev"]) }));
  ok(codeMove.ok === false && /no commit or branch/.test(codeMove.error ?? ""),
    "LOOP-360 control: a non-design ticket with no commit is STILL refused — LOOP-309 is intact (and the workspace really resolved)");

  // (c) The reverse-link form: a parent carrying NO `Mode: design` marker, recognised only because a
  // child points at the design doc it owns. §21a documents three pointer forms and LOOP-344 exists
  // because two of them were resolving to nothing — the exemption must cover them too.
  const linkedParentId = insertTicket(db, "p", "senior-dev",
    newFields({ description: "Design doc: hubDoc:design/l360-linked (the module doc this parent owns)\n", assignee: "senior-dev", labels: ["dev-loop", "senior-dev"] }), {});
  // LOOP-379 — the child's link to its parent is now the `related_to` FIELD, not a sentence naming
  // it. This fixture used to write `relatedTo <id>` in prose while the column stayed empty, and the
  // parent resolved anyway because the derivation read bodies; it no longer does. §21a requires the
  // child to carry the link at filing, so the fixture now carries what the process writes.
  insertTicket(db, "p", "senior-dev", newFields({
    state: "Backlog", assignee: "junior-dev", labels: ["dev-loop", "junior-dev"],
    description: `Design: hubDoc:design/l360-linked\n\nrelatedTo ${linkedParentId}\n`,
    relatedTo: [linkedParentId],
  }), {});
  const linkedMove = updateTicketRow(db, "p", "senior-dev", linkedParentId, "In Progress",
    toInReview({ description: "Design doc: hubDoc:design/l360-linked (the module doc this parent owns)\n", labels: JSON.stringify(["dev-loop", "senior-dev"]) }));
  ok(linkedMove.ok === true,
    `LOOP-360: a parent resolved only through a child's \`Design: hubDoc:design/<slug>\` pointer is exempt too (${linkedMove.ok ? "ok" : linkedMove.error})`);

  db.close();
} finally {
  process.chdir(cwd0);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDESIGN_PARENT_HANDOFF_OK");
process.exit(fails ? 1 : 0);
