// inbound-channel.ts — a claimed ticket has no inbound channel, and the conventions say so.
//
// Measured 2026-08-28T22:52Z→23:23Z, 7 concurrent fires:
//
//   JBU-28 — junior-dev claimed at 22:57:33Z. pm-groom then wrote `blocked`, two `Blocked-by:` edges
//   (JBU-18, JBU-25) and the instruction "Park rather than attempt … Do not open docs/api/vectors/ in
//   this fire" at 23:00:37Z and 23:01:30Z. The holding fire ran until 23:15:10Z, implemented 32
//   vectors plus a contract test, landed 51a0369, and handed off at 23:14:33Z. pm verify-failed and
//   canceled it at 23:17:44Z. That fire was the window's most expensive — $5.70 / 1157s / 110 turns
//   against $28.64 for the whole window — and 13 minutes separated the last park comment from the
//   hand-off. One re-read before the hand-off turns a canceled ticket into a correct park.
//
//   JBU-44 — the same pm-groom fire declined to set `--state`/`--labels` because that would have
//   "raced a live fire on a replace-style field" (§10: labels are REPLACE). The ticket went a whole
//   cycle unpromoted, carried forward by comment instead.
//
// So the hazard either wastes an implementation cycle or suppresses a write, and it scales linearly
// with concurrency. Both remedies live inside the existing model: re-read before the hand-off (the
// §10 verify-after-write action, already in every agent's vocabulary), and write park instructions
// for the VERIFIER, because that is who a comment on a claimed ticket actually reaches.
//
// This suite is a prose ratchet, the same shape as the doc scans in legacy-home.ts and skill-refs.ts:
// the rule's only enforcement surface is the text a fire reads, so the text is what is asserted.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

/** The body of one `## <n>. …` section of conventions.md, so an assertion cannot match another §. */
function section(text: string, n: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${n}. `));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## \d+[a-z]?\. /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const conventions = read("references/conventions.md");
const s3 = section(conventions, "3");
const s7 = section(conventions, "7");
ok(s3.length > 500 && s7.length > 500, `the § slicer found both sections (§3 ${s3.length}B, §7 ${s7.length}B)`);

// ── §3: the hand-off re-reads the ticket first ────────────────────────────────────────────────────
ok(/re-?read|re-?fetch/i.test(s3) && /In Review/.test(s3),
  "§3: the In Progress → In Review transition requires a re-read of the ticket before the hand-off");
ok(/Blocked-by:/.test(s3) && /`blocked`/.test(s3),
  "§3: …and names what the re-read looks for — a `blocked` label or a `Blocked-by:` edge added since the claim");
ok(/park/i.test(s3) && /Bail-shape:/.test(s3),
  "§3: …and what to do instead of handing off — park with the §9 bail shape, not In Review");

// ── §7: a claimed ticket has no inbound channel ───────────────────────────────────────────────────
ok(/inbound/i.test(s7),
  "§7: the isolation section states that a claimed ticket has no inbound channel");
ok(/verifier/i.test(s7),
  "§7: …and that a comment written after the claim reaches the VERIFIER, not the holding fire");
ok(/In Review/.test(s7) && /(what to check|check at)/i.test(s7),
  "§7: …so an agent writing a park/stop instruction is told to address the verifier's In-Review check");

// ── The two playbooks that perform those actions ───────────────────────────────────────────────────
const ship = read("skills/playbooks/ship.md");
const shipStep7 = ship.slice(ship.indexOf("## Step 7"), ship.indexOf("## Exit criteria"));
ok(shipStep7.length > 200, `the ship playbook's Step 7 was located (${shipStep7.length}B)`);
ok(/re-?read|re-?fetch/i.test(shipStep7) && /Blocked-by:/.test(shipStep7),
  "ship playbook Step 7: the hand-off re-reads the ticket and checks for a block added since the claim");
ok(/park/i.test(shipStep7),
  "ship playbook Step 7: …and parks instead of handing off when it finds one");

const claimGroom = read("skills/playbooks/claim-groom.md");
ok(/inbound|holding fire|verifier/i.test(claimGroom),
  "claim-groom playbook: writing to a ticket someone else holds is addressed to the verifier");

console.log(fails === 0 ? "\nINBOUND_CHANNEL_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
