// LOOP-394 — approvals C4: the first ENFORCING consumer (push-guard), the enforce switch, and its
// discovery path. Design: hubDoc:design/approvals (parent LOOP-383). One block per AC.
//
// The load-bearing assertions are AC2 and AC4, and they pull in opposite directions on purpose:
//   AC2 — with the switch empty the guard's output is byte-identical to before, so a workspace that
//         never opted in cannot be changed by this increment;
//   AC4 — a grant for a DIFFERENT sha does not authorise the push. That is the design §4 end-state
//         property, and it is the ONE assertion that distinguishes this from a capability grant. A
//         happy-path-only test passes just as well against `push:<branch>` matching by prefix.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { pushGuard, pushApprovalKey, approvalRefusalLine, APPROVALS_UNVERIFIABLE } from "../src/push-guard.ts";
import { grantApproval, requestApproval, actionClasses } from "../src/approvals.ts";
import { approvalsEnforced, validateTeamFile } from "../src/team-config.ts";
import { SETTABLE } from "../src/team-edit.ts";
import { DOCTOR_CODE_SET } from "../src/doctor-codes.ts";
import { DOCTOR_CHECKS } from "../src/doctor-registry.ts";
import { checkApprovalsHealth } from "../src/doctor.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-approvals-enforce-"));
try {
  // ── fixture: a real bare origin + clone, real hub rows, real approvals ──────────────────────────
  const origin = join(ROOT, "origin.git");
  const work = join(ROOT, "work");
  mkdirSync(origin, { recursive: true });
  const git = (dir: string, args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  git(work, ["commit", "--allow-empty", "-qm", "baseline"]);
  git(work, ["push", "-qu", "origin", "main"]);

  const dbPath = join(ROOT, "hub.db");
  const conn = openDb(dbPath);
  conn.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  const tk = (id: string) =>
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'Todo',0,'[]','[]','pm','t','t')").run(id, "p", "t-" + id);
  tk("AP-1"); tk("AP-2");

  // The branch under test: one commit for the gated ticket, on a tracked branch so the range is the
  // ordinary unpushed tail (the first-push range gets its own block below).
  git(work, ["checkout", "-qb", "dev-loop/AP-1"]);
  git(work, ["push", "-qu", "origin", "dev-loop/AP-1"]);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, ["add", "a.txt"]);
  git(work, ["commit", "-qm", "feat: the gated change (AP-1)"]);
  const sha = git(work, ["rev-parse", "HEAD"]);
  const key = pushApprovalKey("dev-loop/AP-1", sha);

  // ── AC1 — the switch is a validated config field, and an unknown class is an ERROR ──────────────
  //
  // Checked against validateTeamFile rather than the mutator alone: the mutator is one writer, the
  // validator is what every reader passes through, so a hand-edited file must be refused too.
  {
    const base = (approvals: unknown) => ({
      schemaVersion: 2, workspaceId: "w",
      team: { key: "t", backend: "service", ...(approvals === undefined ? {} : { approvals }) },
      repos: {}, projects: {},
    });
    const errs = (f: unknown) => validateTeamFile(f).errors.filter((e) => e.path.startsWith("team.approvals"));

    ok(errs(base(undefined)).length === 0, "AC1 no approvals block → no error (the field is optional)");
    ok(errs(base({ enforce: [] })).length === 0, "AC1 empty enforce list → no error (the DEFAULT state is legal)");
    ok(errs(base({ enforce: ["push", "reopen"] })).length === 0, "AC1 known classes → no error");

    const unknown = errs(base({ enforce: ["pushh"] }));
    ok(unknown.length === 1 && unknown[0].code === "E18" && /unknown action class 'pushh'/.test(unknown[0].message),
      "AC1 unknown class name → E18 naming the class");
    ok(unknown.length === 1 && actionClasses().every((c) => unknown[0].message.includes(c)),
      "AC1 the unknown-class error enumerates every legal class (the operator can fix it from the message)");
    ok(errs(base({ enforce: "push" }))[0]?.code === "E18", "AC1 a bare string instead of a list → E18");
    ok(errs(base({ enforce: ["push", "push"] }))[0]?.code === "E18", "AC1 a duplicated class → E18");
    ok(errs(base({ enfroce: ["push"] }))[0]?.code === "E18", "AC1 a typo'd KEY is refused, not silently ignored");

    // The resolver is the single reader, and its default is the whole safety story of this increment.
    ok(approvalsEnforced(undefined, "push") === false, "AC1 resolver: no team block → off");
    ok(approvalsEnforced({}, "push") === false, "AC1 resolver: no approvals block → off");
    ok(approvalsEnforced({ approvals: {} }, "push") === false, "AC1 resolver: no enforce list → off");
    ok(approvalsEnforced({ approvals: { enforce: [] } }, "push") === false, "AC1 resolver: empty list → off");
    ok(approvalsEnforced({ approvals: { enforce: ["reopen"] } }, "push") === false, "AC1 resolver: a DIFFERENT class enabled → push still off (per-class, not global)");
    ok(approvalsEnforced({ approvals: { enforce: ["reopen", "push"] } }, "push") === true, "AC1 resolver: push listed → on");
  }

  // ── AC2 — default-off is byte-identical to today's behaviour ────────────────────────────────────
  //
  // The claim is "no behaviour change", so it is asserted as an EQUALITY between the two calls on the
  // same repo/db, not as "the approvals array happens to be empty". A future change that made the
  // guard behave differently while leaving approvals[] empty would pass the weaker form.
  {
    requestApproval(conn, { projectId: "p", actionKey: key, requestedBy: "senior-dev", ticketId: "AP-1" });

    const off = pushGuard(work, "dev-loop/AP-1", dbPath, "main");                     // no opts at all
    const offExplicit = pushGuard(work, "dev-loop/AP-1", dbPath, "main", { enforcePush: false });
    const { approvals: offApprovals, ...offRest } = off;
    const { approvals: offExplicitApprovals, ...offExplicitRest } = offExplicit;

    ok(offApprovals.length === 0 && offExplicitApprovals.length === 0,
      "AC2 enforcement off → no approval findings, even with an UNGRANTED request on the ticket");
    ok(JSON.stringify(offRest) === JSON.stringify(offExplicitRest),
      "AC2 omitted opts and enforcePush:false agree on every other field");
    ok(off.ahead === 1 && off.findings.length === 0 && off.passengers.length === 0 && off.governance.length === 0,
      "AC2 the pre-existing checks still report exactly what they did before (1 ahead, no findings)");
  }

  // ── AC3 — with "push" enabled: ungranted ⇒ hard finding; granted+matching ⇒ passes ──────────────
  {
    const gated = pushGuard(work, "dev-loop/AP-1", dbPath, "main", { enforcePush: true, actor: "senior-dev" });
    ok(gated.approvals.length === 1, "AC3 enforcement on + an ungranted request → exactly one approval finding");
    ok(gated.approvals[0]?.key === key, "AC3 the finding carries the exact key an operator must approve");
    ok(gated.approvals[0]?.ticketId === "AP-1", "AC3 the finding names the ticket that put the commit under the gate");
    ok(gated.approvals[0]?.state === "requested" && /requested but not granted/.test(gated.approvals[0]?.reason ?? ""),
      "AC3 the finding carries the verdict's own reason, not a generic refusal");

    // A ticket with NO push: row is outside the feature — the gate is request-driven, so an ordinary
    // branch is untouched even with enforcement on. (Without this, `push` enforcement would be a
    // blanket "every push needs a grant", which is the capability shape design §4 forbids.)
    git(work, ["checkout", "-qb", "dev-loop/AP-2"]);
    git(work, ["push", "-qu", "origin", "dev-loop/AP-2"]);
    writeFileSync(join(work, "b.txt"), "b\n");
    git(work, ["add", "b.txt"]);
    git(work, ["commit", "-qm", "feat: ungated work (AP-2)"]);
    const ungated = pushGuard(work, "dev-loop/AP-2", dbPath, "main", { enforcePush: true, actor: "senior-dev" });
    ok(ungated.ahead === 1 && ungated.approvals.length === 0,
      "AC3 a ticket with no push: approval row is NOT gated (request-driven, not blanket)");
    git(work, ["checkout", "-q", "dev-loop/AP-1"]);

    // Now grant the matching end state: the same push passes.
    grantApproval(conn, { projectId: "p", actionKey: key, grantor: "operator", ticketId: "AP-1", expires: "24h" });
    const granted = pushGuard(work, "dev-loop/AP-1", dbPath, "main", { enforcePush: true, actor: "senior-dev" });
    ok(granted.approvals.length === 0, "AC3 a granted, unexpired, MATCHING approval → the push passes");
  }

  // ── AC4 — the key names an END STATE: a grant for a different sha does not authorise ────────────
  //
  // This is the assertion the whole design turns on. The grant above is live and unexpired; adding
  // one more commit moves the end state, and the SAME ticket + SAME branch must refuse again.
  {
    writeFileSync(join(work, "c.txt"), "c\n");
    git(work, ["add", "c.txt"]);
    git(work, ["commit", "-qm", "feat: one more commit (AP-1)"]);
    const sha2 = git(work, ["rev-parse", "HEAD"]);
    ok(sha2 !== sha, "AC4 fixture: the second commit really is a different sha");

    const moved = pushGuard(work, "dev-loop/AP-1", dbPath, "main", { enforcePush: true, actor: "senior-dev" });
    ok(moved.ahead === 2, "AC4 fixture: both commits are in the unpushed range");
    ok(moved.approvals.length === 1 && moved.approvals[0]?.sha === sha2.slice(0, 7),
      "AC4 the NEW sha is refused while the granted one passes — the grant did not become a capability");
    ok(moved.approvals[0]?.key === pushApprovalKey("dev-loop/AP-1", sha2) && moved.approvals[0]?.state === null &&
       /no approval exists/.test(moved.approvals[0]?.reason ?? ""),
      "AC4 the refusal is 'no approval exists for <this sha>', keyed on the commit under the push");

    // The same property on the other axis: the branch component. A grant naming another branch for
    // the SAME sha must not carry over either.
    git(work, ["branch", "-f", "dev-loop/AP-1-alt"]);
    const altKey = pushApprovalKey("dev-loop/AP-1-alt", sha2);
    grantApproval(conn, { projectId: "p", actionKey: altKey, grantor: "operator", ticketId: "AP-1", expires: "24h" });
    const still = pushGuard(work, "dev-loop/AP-1", dbPath, "main", { enforcePush: true, actor: "senior-dev" });
    ok(still.approvals.length === 1 && still.approvals[0]?.key === pushApprovalKey("dev-loop/AP-1", sha2),
      "AC4 a grant for the same sha on ANOTHER branch does not authorise this branch's push");
  }

  // ── AC5 — the refusal names the approval path and NO bypass ─────────────────────────────────────
  //
  // Asserted on the RENDERED line the CLI prints (approvalRefusalLine is the single copy the CLI
  // calls), not on the struct: AC5 is about what a blocked agent READS, and a message can carry every
  // right field and still offer a way around them.
  {
    const blocked = pushGuard(work, "dev-loop/AP-1", dbPath, "main", { enforcePush: true, actor: "senior-dev" });
    const line = approvalRefusalLine(blocked.approvals[0]!);

    ok(line.includes(`dev-loop approve ${blocked.approvals[0]!.key}`),
      "AC5 the refusal names the approval path, with the exact key filled in");
    ok(line.includes("AP-1"), "AC5 the refusal names the ticket");
    // No bypass. Scanned as words the message could plausibly offer, so a future edit that adds an
    // escape hatch to this line fails here rather than shipping quietly.
    const BYPASS = /--force|--no-verify|--skip|--allow|bypass|override|ignore this|disable the guard|SKIP_/i;
    ok(!BYPASS.test(line), "AC5 the refusal names NO bypass (there is no per-push waiver, by design §2)");
    // AC5's own precondition: C2 made `approve` fire-refused. The message is only safe to print
    // because of that, so this test states the dependency instead of assuming it silently.
    const approvalsCliSrc = readFileSync(join(hubRoot, "src", "approvals-cli.ts"), "utf8");
    ok(/activeFireMarker/.test(approvalsCliSrc),
      "AC5 precondition still holds: approvals-cli consults activeFireMarker (a fire cannot grant its own approval)");
  }

  // ── AC6(c) — the two W-codes are registered, and doctor's helper is not inline in doctorWorkspace ─
  {
    ok(DOCTOR_CODE_SET.has("W40") && DOCTOR_CODE_SET.has("W41"), "AC6c W40 and W41 are registered in the code namespace");
    const row = DOCTOR_CHECKS.find((c) => c.id === "w40-approvals-health");
    ok(!!row && row.codes.includes("W40") && row.codes.includes("W41"),
      "AC7 the new checks are a DOCTOR_CHECKS registry row, not an inline branch in doctorWorkspace");
    ok(row?.bestEffort === true, "AC7 the row is best-effort — a health read never fails the workspace");
    const doctorSrc = readFileSync(join(hubRoot, "src", "doctor.ts"), "utf8");
    const driver = doctorSrc.slice(doctorSrc.indexOf("export async function doctorWorkspace"));
    ok(!/W4[01]/.test(driver.slice(0, driver.indexOf("\n}\n"))),
      "AC7 doctorWorkspace's own body names neither new code (it is the driver; it names no check)");
  }

  // ── AC6(a)/(b) — the discovery path: the schema table and the two --help surfaces ───────────────
  //
  // §9 is the increment, not documentation appended to it (LOOP-335 shipped inert for 60 commits
  // because no surface put its switch in front of a reader), so each part is asserted like code.
  {
    const schema = readFileSync(join(hubRoot, "..", "references", "config-schema.md"), "utf8");
    ok(/\|\s*`approvals\.enforce`\s*\|/.test(schema), "AC6a approvals.enforce has a row in the config-schema table");
    ok(/`team\.approvals\.enforce`/.test(schema), "AC6a the table row names the settable path");

    // Two halves, and both are needed: a WRITER the path resolves to, and a line the operator READS.
    // The summary groups by prefix (`team.{mode,…,approvals.enforce,…}`), so the rendered form is
    // where it must be looked for — the fully-qualified string never appears there for any field.
    ok(SETTABLE.some((s) => s.re.test("team.approvals.enforce")),
      "AC6b team.approvals.enforce resolves to a SETTABLE writer (the mutator, never a hand-edit)");
    const teamEditSrc = readFileSync(join(hubRoot, "src", "team-edit.ts"), "utf8");
    const summary = teamEditSrc.slice(teamEditSrc.indexOf("const SETTABLE_SUMMARY"), teamEditSrc.indexOf("const PLAIN_DECIMAL_RE"));
    ok(/approvals\.enforce/.test(summary) && /^\s*"team\.\{[^"]*approvals\.enforce/m.test(summary),
      "AC6b the mutator's usage summary lists approvals.enforce under its team.{…} group (the --help an operator reads)");

    const guardSrc = readFileSync(join(hubRoot, "src", "push-guard.ts"), "utf8");
    const help = guardSrc.slice(guardSrc.indexOf("dev-loop push-guard — enumerate"), guardSrc.indexOf("process.exit(0);"));
    ok(/team\.approvals\.enforce/.test(help) && /dev-loop approve push:/.test(help),
      "AC6b push-guard --help names the switch AND the approval path");
    ok(/dev-loop team set team\.approvals\.enforce/.test(help),
      "AC6b push-guard --help names the exact command that turns enforcement on");
  }
  // ── R1 (PR #283 review) — an UNAVAILABLE record is not an empty one: the gate fails CLOSED ──────
  //
  // The pre-fix code returned no approval findings when the db file was missing, so --strict exited 0
  // and the push went through: a moved or mis-resolved hub.db silently disabled the one gate that
  // exists to refuse. Both directions are asserted, because "fail closed" is only correct while
  // enforcement is ON — an unreadable record must not start refusing a workspace that never opted in.
  {
    const gone = join(ROOT, "moved-away-hub.db");
    const on = pushGuard(work, "dev-loop/AP-1", gone, "main", { enforcePush: true, actor: "senior-dev" });
    ok(on.approvals.length > 0, "R1 enforcement ON + unreadable record → the push is REFUSED, not waved through");
    ok(on.approvals.every((a) => a.state === APPROVALS_UNVERIFIABLE),
      "R1 the refusal is reported as UNVERIFIABLE — distinct from an evaluated 'not granted'");
    ok(on.approvals.every((a) => a.reason.includes(gone)),
      "R1 the reason names the path that could not be read, so the operator can fix the cause");
    ok(on.approvals.some((a) => a.key === pushApprovalKey("dev-loop/AP-1", git(work, ["rev-parse", "HEAD"]))),
      "R1 the entry carries this commit's real push key — nothing about it is fabricated");

    const off = pushGuard(work, "dev-loop/AP-1", gone, "main", { enforcePush: false });
    ok(off.approvals.length === 0,
      "R1 enforcement OFF + unreadable record → still silent (AC2's byte-identity survives the fix)");

    // The refusal an agent READS must not send it down the wrong road: approving a key cannot help
    // when the record itself is unreadable, and AC5's no-bypass rule binds this line too.
    const line = approvalRefusalLine(on.approvals[0]!);
    ok(!/dev-loop approve /.test(line), "R1 the unverifiable line does NOT tell the agent to approve a key that cannot be recorded");
    ok(/dev-loop doctor/.test(line), "R1 it names the diagnostic that finds the real cause instead");
    ok(!/--force|--no-verify|--skip|--allow|bypass|override|disable/i.test(line), "R1 and it still names NO bypass");
  }

  // ── R2 (PR #283 review) — the switch is a property of the WORKSPACE, not of the caller ──────────
  //
  // `enforcePush` was an optional argument that defaulted to OFF, so every programmatic caller was
  // outside the gate until it remembered to opt in — doc-land calls pushGuard and then ff-only pushes
  // to defaultBranch, and did exactly that. The default now resolves from config, so forgetting the
  // argument inherits the gate instead of escaping it. Asserted with NO opts, which is the caller
  // shape that was broken.
  {
    const mkWs = (enforce: string[]): string => {
      const root = join(ROOT, `ws-${enforce.join("-") || "none"}`);
      mkdirSync(root, { recursive: true });
      execFileSync("git", ["clone", "-q", origin, join(root, "repo")]);
      const r = join(root, "repo");
      git(r, ["checkout", "-qb", "dev-loop/AP-1", "origin/dev-loop/AP-1"]);
      writeFileSync(join(r, "w.txt"), "w\n");
      git(r, ["add", "w.txt"]);
      git(r, ["commit", "-qm", "feat: work needing approval (AP-1)"]);
      writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
        schemaVersion: 2,
        team: { key: "apx", backend: "service", ...(enforce.length ? { approvals: { enforce } } : {}) },
        repos: { repo: { path: "repo" } },
        projects: { ap: {} },
      }));
      return r;
    };

    const enforcedRepo = mkWs(["push"]);
    requestApproval(conn, {
      projectId: "p", actionKey: pushApprovalKey("dev-loop/AP-1", git(enforcedRepo, ["rev-parse", "HEAD"])),
      requestedBy: "senior-dev", ticketId: "AP-1",
    });
    const inherited = pushGuard(enforcedRepo, "dev-loop/AP-1", dbPath, "main");   // NO opts — the broken shape
    ok(inherited.approvals.length === 1,
      "R2 a caller that passes no opts INHERITS the configured gate (the doc-land bypass is closed)");
    ok(inherited.approvals[0]?.ticketId === "AP-1" && inherited.approvals[0]?.state === "requested",
      "R2 and it is the real evaluated refusal, not an unverifiable fallback");

    const plainRepo = mkWs([]);
    const notEnforced = pushGuard(plainRepo, "dev-loop/AP-1", dbPath, "main");    // same shape, switch off
    ok(notEnforced.approvals.length === 0,
      "R2 the same call in a workspace that did NOT opt in stays silent — config decides, not the call site");

    // An explicit argument still wins, or the CLI (which resolves the switch itself) and every test
    // above would be overridden by whatever workspace the repo happens to sit in.
    ok(pushGuard(enforcedRepo, "dev-loop/AP-1", dbPath, "main", { enforcePush: false }).approvals.length === 0,
      "R2 an explicit enforcePush:false still overrides the resolved default");

    // doc-land is the caller the finding named: it must treat the gate as a STOP, not a warning.
    const docLandSrc = readFileSync(join(hubRoot, "src", "doc-land.ts"), "utf8");
    const step3 = docLandSrc.slice(docLandSrc.indexOf("Step 3: push-guard"), docLandSrc.indexOf("Step 4: ff-only push"));
    ok(/guard\.approvals\.length/.test(step3) && /return \{ ok: false/.test(step3.slice(step3.indexOf("guard.approvals.length"))),
      "R2 doc-land returns a BLOCK on guard.approvals — it does not annotate and push anyway");
  }

  // ── R3 (PR #283 review) — W40 is per CLASS: enforcing one class does not silence the others ─────
  //
  // The check compared the enforce list against EMPTY, so a workspace enforcing `reopen` while holding
  // `push:` rows reported clean — the exact inert state the code exists to name, hidden by the only
  // configuration in which someone had already started using the feature.
  // Asserted by CALLING the shipped check and reading what it emits. An earlier draft of this block
  // re-modelled the class comparison locally and grepped doctor.ts for the word "uncovered"; both
  // survived reverting the fix, which is the whole failure mode a regression test exists to prevent.
  {
    // A `reopen:` row alongside the `push:` rows the fixture already created, so the two classes can
    // diverge — with only one class present, per-class and per-list are indistinguishable.
    requestApproval(conn, { projectId: "p", actionKey: "reopen:AP-2", requestedBy: "senior-dev", ticketId: "AP-2" });

    const w40For = (enforce: string[]): string[] => {
      const warns: string[] = [];
      checkApprovalsHealth({
        ws: { root: ROOT, file: { team: { key: "apx", backend: "service", ...(enforce.length ? { approvals: { enforce } } : {}) } } },
        opts: {}, boardDb: dbPath,
        out: { warn: (m: string) => warns.push(m) },
        openBoardDb: () => conn,
      } as unknown as Parameters<typeof checkApprovalsHealth>[0]);
      return warns.filter((w) => w.startsWith("[W40]"));
    };

    const none = w40For([]);
    ok(none.length === 1 && /push/.test(none[0]!) && /reopen/.test(none[0]!),
      "R3 nothing enforced → W40 names both classes (the pre-existing behaviour, preserved)");

    const partial = w40For(["reopen"]);
    ok(partial.length === 1, "R3 enforcing ONLY reopen still WARNS — the case the emptiness check reported clean");
    // Read the UNCOVERED-class segment specifically: the enforced class legitimately appears later in
    // the same sentence ("not in team.approvals.enforce (reopen)"), so a bare /reopen/ scan of the
    // whole line would pass however wrong the classification was.
    const uncoveredSegment = (m: string) => /class\(es\) (.+?) but /.exec(m)?.[1];
    ok(uncoveredSegment(partial[0]!) === "push",
      "R3 and it names push — and ONLY push — as the uncovered class, not the one already enforced");

    ok(w40For(["push", "reopen"]).length === 0, "R3 every class covered → W40 stays silent");
  }

} catch (e) {
  console.log("❌ harness error: " + (e as Error).message);
  fails++;
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nall approvals-enforce checks passed" : `\n${fails} approvals-enforce check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
