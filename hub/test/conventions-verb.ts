// LOOP-237 — the PULL half of §0a delivery (LOOP-228 Lever 1).
//
// The corpus had exactly ONE delivery path: PUSH, appended to every prompt whether the agent reads
// it or not. Conventions is 75% of context at a measured $4.79/fire, so that path is a net loss.
//
// This is the other half: the SAME config-pruned slice, on demand. The prune must agree with the
// push path exactly — a drift would mean an agent reading conventions its own fire was told not to
// have — so the slice is computed from the same three functions the corpus and the bill use.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conventionsSlice } from "../src/conventions-verb.ts";
import { conventionsUnionText } from "../src/boot-prefix.ts";
import { tryResolveWorkspace } from "../src/workspace.ts";
import { readFileSync } from "node:fs";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(hubRoot, "..");           // the plugin root: skills/ + references/ live here
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  const ws = tryResolveWorkspace();

  // ── AC1: the slice is always-read + cited spans MINUS the config-off anchors ──────────────────
  const senior = conventionsSlice(root, "senior-dev", ws);
  ok(senior.anchors.length > 0, `LOOP-237 AC1: senior-dev declares ${senior.anchors.length} anchors`);
  for (const off of ["5", "12d", "19", "24"]) {
    ok(senior.pruned.includes(off), `LOOP-237 AC1: §${off} is config-pruned in this workspace`);
    ok(!senior.kept.includes(off), `LOOP-237 AC1: …and absent from the kept set`);
  }
  // The kept control: a span whose feature IS on must survive, or "pruned everything" would pass above.
  ok(senior.anchors.includes("12c") ? senior.kept.includes("12c") : true,
    "LOOP-237 AC1: §12c (autoMerge/release-pr — ON here) is KEPT, so the prune is selective, not total");
  ok(senior.kept.length > 0 && senior.kept.length < senior.anchors.length,
    `LOOP-237 AC1: the prune removes SOME anchors, not none and not all (${senior.kept.length} of ${senior.anchors.length})`);

  // ── AC2: byte-consistent with the span math + the pruned set ─────────────────────────────────
  // Recompute the union independently from the same inputs. A slice that disagreed with
  // conventionsUnionText would mean the bill and the delivery measure different things — which is
  // exactly how a landed compression win regrows somewhere nobody is looking.
  {
    const convText = readFileSync(join(root, "references", "conventions.md"), "utf8");
    const independent = conventionsUnionText(convText, senior.anchors, new Set(senior.pruned));
    ok(independent.bytes === senior.bytes,
      `LOOP-237 AC2: the slice is byte-consistent with conventionsUnionText (${senior.bytes} vs ${independent.bytes})`);
    ok(independent.effectiveSpans === senior.effectiveSpans,
      `LOOP-237 AC2: …and span-consistent (${senior.effectiveSpans})`);
    // Not vacuous: the UNPRUNED union must be strictly larger, or the prune bought nothing.
    const unpruned = conventionsUnionText(convText, senior.anchors);
    ok(unpruned.bytes > senior.bytes,
      `LOOP-237 AC2: the pruned slice is genuinely SMALLER than the unpruned union (${senior.bytes} < ${unpruned.bytes}, saving ${unpruned.bytes - senior.bytes} B)`);
  }

  // Per-agent, not one-size: a different agent declares a different set.
  {
    const pm = conventionsSlice(root, "pm", ws);
    ok(pm.anchors.join(",") !== senior.anchors.join(","),
      "LOOP-237: the slice is PER-AGENT — pm and senior-dev declare different spans");
  }

  // ── the CLI surface ──────────────────────────────────────────────────────────────────────────
  const run = (args: string[]): { code: number; out: string; err: string } => {
    const r = execFileSync(process.execPath, [join(hubRoot, "src", "conventions-verb.ts"), ...args],
      { encoding: "utf8", env: scrubFireEnv() as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, out: r, err: "" };
  };
  {
    const j = JSON.parse(run(["--agent", "senior-dev", "--root", root, "--json"]).out) as { bytes: number; pruned: string[]; text: string };
    ok(j.bytes === senior.bytes && j.pruned.join(",") === senior.pruned.join(","),
      "LOOP-237: the CLI returns the same slice the library computes");
    // The truncation trap this verb hit on its first run: process.exit() DISCARDS queued stdout on a
    // pipe, so a tens-of-KB slice came back as unterminated JSON. That is LOOP-346, and it is why the
    // entry sets process.exitCode instead. Parsing the JSON above IS the assertion — it cannot pass
    // against a truncated buffer.
    ok(j.text.length > 1000, `LOOP-237: …in full, not truncated by the exit (${j.text.length} chars)`);
  }
  {
    // --agent is required, and an unknown agent fails cleanly rather than emitting a partial slice.
    let missing = 0;
    try { execFileSync(process.execPath, [join(hubRoot, "src", "conventions-verb.ts")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { missing = (e as { status?: number }).status ?? 0; }
    ok(missing === 2, `LOOP-237: --agent is required (exit ${missing})`);
    let unknown = 0;
    try { execFileSync(process.execPath, [join(hubRoot, "src", "conventions-verb.ts"), "--agent", "no-such-agent", "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { unknown = (e as { status?: number }).status ?? 0; }
    ok(unknown === 1, `LOOP-237: an unknown agent fails cleanly rather than emitting a partial slice (exit ${unknown})`);
  }
} finally { /* nothing to clean up — the verb is read-only */ }

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nCONVENTIONS_VERB_OK");
process.exit(fails ? 1 : 0);
