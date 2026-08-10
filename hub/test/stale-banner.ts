// LOOP-532 — the stale-daemon banner, asserted by BEHAVIOUR rather than by source text.
//
// LOOP-386 shipped the banner with four `board.text.includes('ok===false')`-style assertions. Those
// mirror the source: they pass unchanged if the poll never fires, if the banner element is null, or
// if the fetch 404s, and they break on a whitespace edit. They assert the code was typed, not that
// it behaves — and the defect they missed (the health poll clearing a banner raised by a lost
// stream) is invisible to every one of them.
//
// So this suite does two things no substring check can:
//   1. It CALLS the shipped client (`src/views/live-client.ts`) with DOM/EventSource/fetch/
//      setInterval stubs and drives its transitions. There is no second copy of the client logic to
//      drift from: ui.ts inlines that same function into the page via `liveClient.toString()`, and
//      the first assertion below pins the served bytes to the function driven here. (The client
//      cannot be evaluated from the served string instead — the repo's source-integrity gate forbids
//      dynamic Function construction — so byte identity is what links shipped to tested.)
//   2. It drives a REAL ok:false /api/health by swapping the db file's inode under a live daemon
//      (the LOOP-367 `dbFileReplaced` arm), and feeds the server's own error string into the client
//      render — so the two halves of the banner contract are linked end to end.
import { rmSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startTestDaemon } from "./daemon-harness.ts";
import { liveClient } from "../src/views/live-client.ts";
import type { LiveDocument, LiveEl, LiveEventSource } from "../src/views/live-client.ts";

const DIR = "/tmp/hub-stale-banner";
const DB = join(DIR, "hub.db");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

execFileSync("node", ["src/seed.ts", "sb", "Stale Banner", "SB", DB], { encoding: "utf8" });

const daemon = await startTestDaemon({
  DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "sb", DEVLOOP_ACTOR: "operator",
  DEVLOOP_WORKSPACE: DIR, DEVLOOP_TEAM: "", DEVLOOP_DAEMON_PORT: "0",
});
const base = daemon.url.replace(/\/$/, "");

// ── the page serves THIS function, and hands it the real browser globals ───────────────────────
const html = await fetch(base + "/").then((r) => r.text());
const scripts = html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
ok(scripts.length === 1, `page serves exactly ONE <script> block (got ${scripts.length}) — the checks below are unambiguous`);
const scriptBody = (scripts[0] ?? "").replace(/^<script>/, "").replace(/<\/script>$/, "");
ok(scriptBody.includes(liveClient.toString()),
  "the served page inlines liveClient's OWN source — the client driven below is the client shipped");
// The one thing a Node test cannot drive: which browser globals the page hands in. So assert the
// call site's argument list (not its formatting) — a page that dropped `fetch` would still serve a
// byte-identical function and never poll.
// (anchored to the invocation STATEMENT — an unanchored `liveClient(` would match the inlined
// function's own declaration and assert its parameter names instead of the page's arguments)
const callArgs = (/^\s*liveClient\((.*)\);\s*$/m.exec(scriptBody)?.[1] ?? "").split(",").map((s) => s.trim());
ok(callArgs.slice(0, 5).join(",") === "document,EventSource,fetch,setInterval,location",
  `the page calls it with the real browser globals in order (got [${callArgs.slice(0, 5).join(", ")}])`);
ok((callArgs[5] ?? "").startsWith('"') && (callArgs[5] ?? "").includes("/api/stream"),
  `the stream path is passed as a JSON-quoted string (got ${callArgs[5]})`);

// AC4 — the page shell: banner element present, hidden by default (server-rendered HTML, so a
// substring check IS the right instrument here; it asserts markup, not logic).
ok(html.includes('id="stale-banner"') && html.includes('class="stale-banner"'),
  "AC4: served board carries the stale-banner element");
ok(!html.includes('class="stale-banner show"'),
  "AC4: banner is NOT visible in server-rendered HTML (JS-activated only)");

// ── DOM / EventSource / fetch / setInterval stubs ──────────────────────────────────────────────
function mkEl(): LiveEl & { classList: { contains(c: string): boolean } } {
  const classes = new Set<string>();
  return {
    innerHTML: "",
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      contains: (c: string) => classes.has(c),
    },
  };
}
const bannerEl = mkEl(), dotEl = mkEl();
const doc: LiveDocument = {
  getElementById: (id: string) => (id === "stale-banner" ? bannerEl : id === "live" ? dotEl : null),
  activeElement: null,
  addEventListener: () => { /* focusout — not exercised here */ },
};
// Captured through a sink object: a `let` assigned inside the constructor loses its narrowing at
// every intervening call, and `stream!.onerror!()` everywhere would hide a real null from the reader.
const sink: { es: LiveEventSource | null; poll: (() => void) | null; pollMs: number } = { es: null, poll: null, pollMs: 0 };
class EventSourceStub implements LiveEventSource {
  onmessage?: ((e: { data: string }) => void) | null;
  onerror?: (() => void) | null;
  url: string;
  constructor(url: string) { this.url = url; sink.es = this; }
}
let healthPayload: unknown = { ok: true };
let healthFetches = 0;
const fetchStub = (url: string) => {
  if (url === "/api/health") healthFetches++;
  return Promise.resolve({ json: () => Promise.resolve(healthPayload) });
};
const setIntervalStub = (fn: () => void, ms: number) => { sink.poll = fn; sink.pollMs = ms; return 1; };
let reloads = 0;
const locationStub = { reload: () => { reloads++; } };

liveClient(doc, EventSourceStub, fetchStub, setIntervalStub, locationStub, "/p/sb/api/stream");

const es = sink.es, pollFn = sink.poll;
// Non-vacuity preconditions: without them a harness that wired nothing up still reads as green.
ok(es !== null && typeof es.onerror === "function" && typeof es.onmessage === "function",
  "precondition: the client registered both SSE handlers");
ok(pollFn !== null && sink.pollMs === 15000,
  `precondition: the client registered the 15s health poll (got ${sink.pollMs}ms)`);
ok(es instanceof EventSourceStub && es.url === "/p/sb/api/stream",
  "the client subscribes to the stream path it was handed, not a hard-coded one");
if (es === null || pollFn === null || es.onmessage == null || es.onerror == null) {
  console.log("❌ harness could not drive the client — remaining assertions would be vacuous");
  process.exit(1);
}
const onMessage = es.onmessage, onError = es.onerror;

const visible = () => bannerEl.classList.contains("show");
const shown = () => bannerEl.innerHTML;
const poll = async (payload: unknown) => { healthPayload = payload; pollFn(); await new Promise((r) => setTimeout(r, 0)); };
const reset = () => { onMessage({ data: "a" }); };   // first message only sets the baseline id

ok(!visible(), "AC4: banner starts hidden");

// ── AC4 — the shipped transitions still hold ───────────────────────────────────────────────────
reset();
onError();
ok(visible() && shown().includes("Connection to daemon lost"),
  "AC4: es.onerror raises the lost-connection banner");
onMessage({ data: "a" });
ok(!visible(), "AC4: es.onmessage (stream recovered) clears it");

await poll({ ok: false, error: "wedged" });
ok(visible() && shown().includes("wedged"), "AC4: health ok:false raises the banner with the error verbatim");
await poll({ ok: true });
ok(!visible(), "AC4: a healthy poll clears a banner the poll itself raised");
ok(healthFetches === 2, `the poll fetches /api/health each tick (got ${healthFetches})`);

// ── AC1 — the regression: an ok:true poll must NOT clear a stream-loss banner ──────────────────
reset();
onError();
ok(visible(), "AC1 setup: stream lost ⇒ banner up");
await poll({ ok: true });
ok(visible() && shown().includes("Connection to daemon lost"),
  "AC1: an ok:true health poll leaves the stream-loss banner UP (the LOOP-386 regression)");
await poll({ ok: true });
ok(visible(), "AC1: still up after a second healthy poll — it is not a one-tick reprieve");
onMessage({ data: "a" });
ok(!visible(), "AC1: the banner clears only when the STREAM itself recovers");

// A health fault outranks a lost stream, and clearing one leaves the other standing.
reset();
onError();
await poll({ ok: false, error: "db is gone" });
ok(shown().includes("db is gone"), "precedence: a health fault outranks a lost stream");
await poll({ ok: true });
ok(visible() && shown().includes("Connection to daemon lost"),
  "precedence: health recovering falls back to the still-unresolved stream loss, not to hidden");

// ── AC2 — a REAL ok:false /api/health, driven by swapping the db inode under the live daemon ───
const healthy = await fetch(base + "/api/health");
const healthyBody = await healthy.json() as { ok: boolean };
ok(healthy.status === 200 && healthyBody.ok === true, `AC2 setup: live daemon reports healthy (got ${healthy.status})`);

copyFileSync(DB, DB + ".swap");
renameSync(DB + ".swap", DB);           // same path, new inode — the daemon's open fd is now orphaned

const sick = await fetch(base + "/api/health");
const sickBody = await sick.json() as { ok: boolean; error?: string };
ok(sick.status === 503, `AC2: a replaced db file makes /api/health answer 503 (got ${sick.status})`);
ok(sickBody.ok === false && typeof sickBody.error === "string" && /REPLACED/.test(sickBody.error ?? ""),
  "AC2: the 503 body carries ok:false and names the replacement — the shape the client branches on");
ok((sickBody.error ?? "").endsWith("Restart it: dev-loop daemon up"),
  "AC2: the real error already ENDS with the remedy (the premise AC3 depends on)");

// ── AC3 — the remedy is not rendered twice ─────────────────────────────────────────────────────
// Driven by the daemon's OWN error string, so this cannot pass against a hand-written fixture that
// has drifted from what the server sends.
await poll({ ok: false, error: sickBody.error });
ok(shown().includes("has been REPLACED"), "AC3: the real health error reaches the banner");
ok(!shown().includes("sb-remedy"),
  "AC3: no remedy span when the error already ends with the remedy (it would render twice)");
await poll({ ok: false, error: "database disk image is malformed" });
ok(shown().includes("sb-remedy") && shown().includes("Restart it: dev-loop daemon up"),
  "AC3: the wedged-SoR arm (no embedded remedy) still gets the fallback remedy");
await poll({ ok: false });
ok(shown().includes("Daemon unhealthy") && shown().includes("sb-remedy"),
  "AC3: an ok:false with no error at all falls back to both the generic message and the remedy");

ok(reloads === 0, `no spurious location.reload() across the run (got ${reloads})`);

daemon.stop();
rmSync(DIR, { recursive: true, force: true });
console.log(fails === 0 ? "\n✅ stale-banner: all assertions passed" : `\n❌ stale-banner: ${fails} failed`);
process.exit(fails > 0 ? 1 : 0);
