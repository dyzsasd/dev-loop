#!/usr/bin/env node
// `dev-loop bundle export` + the `dev-loop up --bundle` loader — the MOVE/BACKUP leg (one-click §4).
// A bundle is the ONE artifact a secret VALUE legitimately travels in (§16 stays code-enforced in
// config), so the payload is ENCRYPTED at rest — age recipient-key by default (operator decision Q3);
// an interactive passphrase is excluded (it would hang a headless load). The bundle MOVES or SNAPSHOTS
// the workspace home — it never synchronizes two live homes: hub.db restores onto an EMPTY target only
// (never overwrites a live board), repos never travel (git remotes are the code transport, re-cloned/
// resumed on load), and machine-local scheduler state never leaves the source machine.
//
// File layout (single file, streaming-friendly):
//   line 1  DEVLOOP-BUNDLE/1
//   line 2  <manifest JSON, plaintext — version/repos/env NAMES only, never a value>
//   rest    the payload: age ciphertext (or plaintext JSON under --insecure-plaintext, loudly marked)
// Payload JSON: { files: { "dev-loop.json": str, "opencode.json"?: str, "secrets.env": str,
//                          "hub.db"?: base64, "git/deploy_key"?: str } }
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tryResolveWorkspace, wsHubDb, wsLockPath } from "./workspace.ts";
import type { TeamFile, Workspace } from "./team-config.ts";
import { doctorWorkspace } from "./doctor.ts";
import { openDb } from "./db.ts";
import { ensureSeed } from "./seed.ts";
import { TEAM_INTAKE_PROJECT } from "./team-config.ts";
import { provisionClaudePermissions } from "./team-init.ts";
import { scaffoldOperatorBriefs } from "./operator-brief.ts";
import { syncOpencodeConfig } from "./opencode-sync.ts";
import { wsSecretsPath } from "./secrets.ts";

const MAGIC = "DEVLOOP-BUNDLE/1";
const here = dirname(fileURLToPath(import.meta.url));

function die(msg: string, code = 2): never { console.error(`dev-loop bundle: ${msg}`); process.exit(code); }

export interface BundleManifest {
  bundleSchema: 1;
  devLoopVersion: string;
  authoredAt: string;
  workspaceId: { value: string; disposition: "migrate" | "fork" };
  teamKey: string;
  backend: string;
  hubDb: { included: boolean; checkpointedAt?: string; mode?: "move" | "backup" };
  repos: Array<{ ref: string; path: string; remote?: string }>;
  secretEnvNames: string[];
  gitAuth: "none" | "https-token" | "ssh-key";
  gitCredentialEnvName?: string;
  secretsEncryption: "age" | "none";
  run: { agents: string };
}
interface Payload { files: Record<string, string>; hubDbB64?: string }

function pkgVersion(): string {
  try { return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
}

// Every env NAME the config references (§16's name-side) — the value set the payload must carry.
export function referencedEnvNames(file: TeamFile): string[] {
  const names = new Set<string>();
  const comms = file.team.comms as { webhookEnv?: string } | undefined;
  if (comms?.webhookEnv) names.add(comms.webhookEnv);
  for (const p of Object.values(file.team.providers ?? {})) if (p.authTokenEnv) names.add(p.authTokenEnv);
  for (const proj of Object.values(file.projects)) {
    const n = proj.notify as { webhookEnv?: string; secretEnv?: string } | undefined;
    if (n?.webhookEnv) names.add(n.webhookEnv);
    if (n?.secretEnv) names.add(n.secretEnv);
  }
  return [...names].sort();
}

// age shell-outs (the binary is the shipped default — the container image installs it; local: brew/apt).
function ageEncrypt(data: Buffer, recipients: string[], recipientFiles: string[]): Buffer {
  const args = ["-e", ...recipients.flatMap((r) => ["-r", r]), ...recipientFiles.flatMap((f) => ["-R", f])];
  const r = spawnSync("age", args, { input: data, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) die(`age encrypt failed (${r.stderr?.toString().trim() || `exit ${r.status}`}) — is age installed? (brew install age / apk add age)`, 1);
  return r.stdout;
}
function ageDecrypt(data: Buffer): Buffer {
  // Headless identity resolution (§4.2 — never an interactive passphrase): AGE_IDENTITY_FILE (a mounted
  // secret) or DEVLOOP_BUNDLE_KEY (the identity text itself, e.g. from an orchestrator secret env).
  let identityFile = process.env.AGE_IDENTITY_FILE?.trim();
  let tmp: string | null = null;
  if (!identityFile && process.env.DEVLOOP_BUNDLE_KEY?.trim()) {
    tmp = join(tmpdir(), `dl-age-${process.pid}-${randomUUID().slice(0, 8)}`);
    writeFileSync(tmp, process.env.DEVLOOP_BUNDLE_KEY.trim() + "\n", { mode: 0o600 });
    identityFile = tmp;
  }
  if (!identityFile) die("bundle is age-encrypted — set AGE_IDENTITY_FILE=<path> (mounted secret) or DEVLOOP_BUNDLE_KEY=<identity text>; interactive passphrases are not supported headless (§4.2)", 1);
  try {
    const r = spawnSync("age", ["-d", "-i", identityFile], { input: data, maxBuffer: 1024 * 1024 * 1024 });
    if (r.status !== 0) die(`age decrypt failed (${r.stderr?.toString().trim() || `exit ${r.status}`}) — wrong identity for this bundle's recipients?`, 1);
    return r.stdout;
  } finally { if (tmp) { try { rmSync(tmp); } catch { /* best-effort */ } } }
}

const movedMarkerPath = (root: string): string => join(root, ".dev-loop", "moved.json");

// ── export ──────────────────────────────────────────────────────────────────
type ExportOpts = {
  out: string; recipients: string[]; recipientFiles: string[]; plaintext: boolean;
  noHubDb: boolean; backup: boolean; move: boolean; disposition: "migrate" | "fork";
  gitTokenEnv: string | undefined; sshKey: string | undefined;
  includeEnv: string[]; runAgents: string; force: boolean; dir: string;
};
// bundle-export arg surface (1.8.1 quality-gauntlet drain: bundleExport CC 61 → phases).
function parseExportArgs(rest: string[]): ExportOpts {
  const o = {
    out: "", recipients: [] as string[], recipientFiles: [] as string[], plaintext: false,
    noHubDb: false, backup: false, move: false, disposition: "migrate" as "migrate" | "fork",
    gitTokenEnv: undefined as string | undefined, sshKey: undefined as string | undefined,
    includeEnv: [] as string[], runAgents: "core", force: false, dir: process.cwd(),
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; const next = () => rest[++i] ?? die(`${a} requires a value`);
    if (a === "--out") o.out = resolve(next());
    else if (a === "--recipients") o.recipients.push(next());
    else if (a === "--recipients-file") o.recipientFiles.push(resolve(next()));
    else if (a === "--insecure-plaintext") o.plaintext = true;
    else if (a === "--no-hub-db") o.noHubDb = true;
    else if (a === "--backup") o.backup = true;
    else if (a === "--move") o.move = true;
    else if (a === "--workspace-id") { const v = next(); if (v !== "migrate" && v !== "fork") die("--workspace-id must be migrate or fork"); o.disposition = v; }
    else if (a === "--git-token-env") o.gitTokenEnv = next();
    else if (a === "--ssh-key") o.sshKey = resolve(next());
    else if (a === "--include-env") o.includeEnv.push(next());
    else if (a === "--run-agents") o.runAgents = next();
    else if (a === "--force") o.force = true;
    else if (a === "--dir") o.dir = resolve(next());
    else die(`unknown option '${a}'`);
  }
  if (!o.out) die("--out <file> is required");
  if (!o.plaintext && !o.recipients.length && !o.recipientFiles.length)
    die("no encryption target: pass --recipients <age-pubkey> (repeatable) / --recipients-file <path>, or --insecure-plaintext (dev/test ONLY)");
  if (o.move && o.backup) die("--move and --backup are exclusive (a backup never retires the source)");
  return o;
}

// Assemble the bundle payload: hub.db bytes (checkpointed), config files, every referenced secret
// VALUE, and the optional git credential (§16: config carries NAMES; the payload IS the value carrier).
function buildExportPayload(ws: Workspace, o: ExportOpts): { payload: Payload; hubDb: BundleManifest["hubDb"]; envNames: Set<string>; gitAuth: BundleManifest["gitAuth"] } {
  // hub.db (Q6: default ON when present) — WAL-checkpoint into the main file, then copy the bytes.
  const payload: Payload = { files: {} };
  const hubDbPath = wsHubDb(ws);
  let hubDb: BundleManifest["hubDb"] = { included: false };
  if (!o.noHubDb && existsSync(hubDbPath)) {
    try {
      const db = openDb(hubDbPath);
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
    } catch (e) { if (!o.backup) die(`hub.db checkpoint failed (${(e as Error).message}) — is something still writing?`, 1); console.warn(`backup: checkpoint failed (${(e as Error).message}); copying crash-consistent bytes`); }
    payload.hubDbB64 = readFileSync(hubDbPath).toString("base64");
    hubDb = { included: true, checkpointedAt: new Date().toISOString(), mode: o.backup ? "backup" : "move" };
  }

  // Config + secrets (§16: config carries NAMES; the payload carries the VALUES — that is the artifact).
  payload.files["dev-loop.json"] = readFileSync(ws.filePath, "utf8");
  const ocPath = join(ws.root, "opencode.json");
  if (existsSync(ocPath)) payload.files["opencode.json"] = readFileSync(ocPath, "utf8");
  const envNames = new Set([...referencedEnvNames(ws.file), ...o.includeEnv]);
  if (o.gitTokenEnv) envNames.add(o.gitTokenEnv);
  const secretLines: string[] = [];
  const missing: string[] = [];
  for (const n of [...envNames].sort()) {
    const v = process.env[n]; // secrets.env is already hydrated by workspace resolution (env-wins)
    if (v === undefined) { missing.push(n); continue; }
    secretLines.push(`${n}=${v}`);
  }
  if (missing.length) console.warn(`⚠️  no value resolvable for: ${missing.join(", ")} — the remote will fail W12/W13 on these (dev-loop secret set <NAME> before exporting to fix)`);
  payload.files["secrets.env"] = secretLines.join("\n") + (secretLines.length ? "\n" : "");
  let gitAuth: BundleManifest["gitAuth"] = "none";
  if (o.sshKey) {
    if (!existsSync(o.sshKey)) die(`--ssh-key ${o.sshKey} does not exist`);
    payload.files["git/deploy_key"] = readFileSync(o.sshKey, "utf8");
    gitAuth = "ssh-key";
  } else if (o.gitTokenEnv) gitAuth = "https-token";
  const privateRemotes = Object.values(ws.file.repos).some((r) => !!r.remote);
  if (privateRemotes && gitAuth === "none")
    console.warn("⚠️  repos carry git remotes but the bundle has NO git credential (--git-token-env / --ssh-key) — a headless load of private repos will fail its clone probe");
  return { payload, hubDb, envNames, gitAuth };
}

export async function bundleExport(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { exportUsage(); return 0; }
  if (sub !== "export") { console.error(`dev-loop bundle: unknown subcommand '${sub}' (only: export)`); return 2; }
  const o = parseExportArgs(rest);

  const ws = tryResolveWorkspace(o.dir) ?? die(`no workspace at ${o.dir}`);
  console.log(`bundle export — workspace '${ws.file.team.key}' @ ${ws.root}${o.backup ? " (backup: live checkpoint)" : ""}`);

  // Doctor refusal (design §4.4 step 1): a workspace that fails its own health gate does not ship.
  if (!doctorWorkspace(ws) && !o.force) die("doctor reports hard failures — fix them (or pass --force) before exporting", 1);

  // Consistency gate: a MOVE exports a stopped home. Live run-lock / daemon runfiles refuse (not for --backup).
  if (!o.backup) {
    const liveHolders: string[] = [];
    const runLock = wsLockPath(ws, "run");
    if (existsSync(runLock)) {
      try { const pid = (JSON.parse(readFileSync(runLock, "utf8")) as { pid?: number }).pid; if (pid) { process.kill(pid, 0); liveHolders.push(`run lock (pid ${pid})`); } } catch { /* dead/garbled = not live */ }
    }
    if (liveHolders.length) die(`the loop is LIVE (${liveHolders.join(", ")}) — stop it before a move export, or use --backup for a live snapshot`, 1);
  }

  const { payload, hubDb, envNames, gitAuth } = buildExportPayload(ws, o);

  const manifest: BundleManifest = {
    bundleSchema: 1, devLoopVersion: pkgVersion(), authoredAt: new Date().toISOString(),
    workspaceId: { value: ws.file.workspaceId ?? "unset", disposition: o.disposition },
    teamKey: ws.file.team.key, backend: ws.file.team.backend, hubDb,
    repos: Object.entries(ws.file.repos).map(([ref, r]) => ({ ref, path: r.path, ...(r.remote ? { remote: r.remote } : {}) })),
    secretEnvNames: [...envNames].sort(), gitAuth,
    ...(o.gitTokenEnv ? { gitCredentialEnvName: o.gitTokenEnv } : {}),
    secretsEncryption: o.plaintext ? "none" : "age",
    run: { agents: o.runAgents },
  };

  const payloadRaw = Buffer.from(JSON.stringify(payload));
  const payloadOut = o.plaintext ? payloadRaw : ageEncrypt(payloadRaw, o.recipients, o.recipientFiles);
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, Buffer.concat([Buffer.from(`${MAGIC}\n${JSON.stringify(manifest)}\n`), payloadOut]), { mode: 0o600 });
  chmodSync(o.out, 0o600);
  console.log(`✅ bundle written: ${o.out} (${(payloadOut.length / 1024).toFixed(0)}KB payload, ${o.plaintext ? "PLAINTEXT — protect this file" : "age-encrypted"}; hub.db ${hubDb.included ? "included" : "NOT included"})`);

  if (o.move) {
    // Q4 (operator decision): marker + refusal is the retirement mechanism — run/doctor refuse a
    // moved-away source; the marker is the operator's to delete if they truly want the home back.
    writeFileSync(movedMarkerPath(ws.root), JSON.stringify({ movedAt: new Date().toISOString(), bundle: basename(o.out) }, null, 2) + "\n");
    console.log(`🏠 source marked MOVED (.dev-loop/moved.json): \`dev-loop run\` here now refuses — this workspace's remaining roles are \`dev-loop up --attach\` and reading files. Delete the marker to un-retire.`);
  }
  return 0;
}

function exportUsage(): void {
  console.log(`dev-loop bundle export — author the encrypted move/backup artifact (one-click §4)

Usage:
  dev-loop bundle export --out <file> --recipients <age-pubkey> [--recipients <k2>…]
                         [--no-hub-db] [--backup] [--move] [--workspace-id migrate|fork]
                         [--git-token-env NAME | --ssh-key <path>] [--include-env NAME]…
                         [--run-agents core] [--force] [--insecure-plaintext]

Carries: dev-loop.json + every referenced secret VALUE + hub.db (the board — default ON) + an optional
git credential. Never: repo clones (git remotes are the transport), scheduler state, locks.
--backup  live snapshot (checkpoint without stopping the loop; never retires the source)
--move    stamp the source retired (.dev-loop/moved.json) — run/doctor refuse there afterwards
Load with: dev-loop up --bundle <file>   (identity via AGE_IDENTITY_FILE or DEVLOOP_BUNDLE_KEY)`);
}

// ── load (`dev-loop up --bundle`) ───────────────────────────────────────────
// Read + verify a bundle: MAGIC header, schema-1 manifest, (age-)decrypted payload
// (1.8.1 quality-gauntlet drain: bundleLoad CC 50 → read/materialize phases).
function readBundle(file: string): { manifest: BundleManifest; payload: Payload } {
  if (!existsSync(file)) die(`no bundle at ${file}`);
  const raw = readFileSync(file);
  const nl1 = raw.indexOf(0x0a);
  const nl2 = raw.indexOf(0x0a, nl1 + 1);
  if (nl1 < 0 || nl2 < 0 || raw.subarray(0, nl1).toString() !== MAGIC) die(`${file} is not a dev-loop bundle (missing ${MAGIC} header)`);
  let manifest: BundleManifest;
  try { manifest = JSON.parse(raw.subarray(nl1 + 1, nl2).toString()) as BundleManifest; } catch { die("garbled bundle manifest"); }
  if (manifest.bundleSchema !== 1) die(`unsupported bundleSchema ${manifest.bundleSchema} (this dev-loop speaks 1)`);
  console.log(`bundle load — team '${manifest.teamKey}' (authored ${manifest.authoredAt} by dev-loop ${manifest.devLoopVersion}; hub.db ${manifest.hubDb.included ? "included" : "absent"})`);
  if (manifest.devLoopVersion !== pkgVersion()) console.warn(`note: bundle authored by dev-loop ${manifest.devLoopVersion}, this is ${pkgVersion()} — doctor is the compatibility gate`);

  const payloadRaw = raw.subarray(nl2 + 1);
  const payload = JSON.parse((manifest.secretsEncryption === "age" ? ageDecrypt(Buffer.from(payloadRaw)) : Buffer.from(payloadRaw)).toString()) as Payload;
  return { manifest, payload };
}

export async function bundleLoad(file: string, dir: string, opts: { forceReseed: boolean; noRun?: boolean }): Promise<number> {
  const { manifest, payload } = readBundle(file);

  const root = resolve(dir);
  mkdirSync(join(root, ".dev-loop"), { recursive: true });
  const cfgPath = join(root, "dev-loop.json");

  // Authoritative-once config (§4.5 step 2): first materialization writes; a populated workspace is
  // LIVE state — diff-and-warn, never clobber (except the explicit --force-reseed, which still never
  // touches hub.db).
  const incomingCfg = manifest.workspaceId.disposition === "fork"
    ? JSON.stringify({ ...JSON.parse(payload.files["dev-loop.json"]), workspaceId: randomUUID() }, null, 2) + "\n"
    : payload.files["dev-loop.json"];
  if (!existsSync(cfgPath) || opts.forceReseed) {
    writeFileSync(cfgPath, incomingCfg);
    writeFileSync(join(root, ".dev-loop", "secrets.env"), payload.files["secrets.env"] ?? "", { mode: 0o600 });
    chmodSync(join(root, ".dev-loop", "secrets.env"), 0o600);
    if (payload.files["opencode.json"]) writeFileSync(join(root, "opencode.json"), payload.files["opencode.json"]);
    console.log(`materialized dev-loop.json + secrets.env${payload.files["opencode.json"] ? " + opencode.json" : ""}${manifest.workspaceId.disposition === "fork" ? " (workspaceId FORKED — a new logical workspace)" : ""}`);
  } else {
    const live = readFileSync(cfgPath, "utf8");
    if (live !== incomingCfg) console.warn("⚠️  live dev-loop.json differs from the bundle — keeping the LIVE config (bundle is authoritative-once; --force-reseed to overwrite config+secrets)");
    else console.log("config unchanged (restart over a populated workspace)");
  }

  // hub.db: restore-onto-empty, NEVER overwrite live (Q6).
  const dbPath = join(root, ".dev-loop", "hub.db");
  if (manifest.hubDb.included && payload.hubDbB64) {
    if (!existsSync(dbPath)) { writeFileSync(dbPath, Buffer.from(payload.hubDbB64, "base64")); console.log(`restored hub.db (the board: tickets/docs/history travel with the home)`); }
    else console.log("hub.db already exists — the LIVE board wins; bundle copy ignored (a bundle moves a home, it never merges boards)");
  } else if (manifest.backend === "service" && !existsSync(dbPath)) {
    // A --no-hub-db service bundle = the explicit CLEAN-board choice: seed the _team intake row (the
    // team-init shape); per-project rows need their PREFIX, which lives only in the board that was
    // deliberately left behind — doctor's W08 names each one and the seed command to run (documented
    // loss, never hidden).
    const db = openDb(dbPath);
    try { ensureSeed(db, TEAM_INTAKE_PROJECT, "Team Intake", "TEAM"); } finally { db.close(); }
    console.log("clean-board load (--no-hub-db bundle): seeded '_team'; per-project rows need `dev-loop seed <key> \"<name>\" <PREFIX>` (W08 lists them)");
  }

  // Re-derive machine-local wiring idempotently (never trust a stale bundle copy of these).
  const ws = tryResolveWorkspace(root) ?? die("bundle laid down but the workspace does not resolve — check the manifest/config", 1);
  provisionClaudePermissions(ws.root);
  scaffoldOperatorBriefs(ws.root);
  try { syncOpencodeConfig(ws.root, ws.file.team.providers ?? {}); } catch { /* registry-less teams have nothing to sync */ }

  // Git credential materialization (§4.1a) — BEFORE any clone; never an interactive prompt.
  const env: NodeJS.ProcessEnv = { ...process.env, DEVLOOP_WORKSPACE: ws.root, GIT_TERMINAL_PROMPT: "0" };
  if (manifest.gitAuth === "ssh-key" && payload.files["git/deploy_key"]) {
    const keyPath = join(root, ".dev-loop", "git_deploy_key");
    writeFileSync(keyPath, payload.files["git/deploy_key"], { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`;
    console.log("git auth: deploy key materialized (StrictHostKeyChecking=accept-new — no host-key prompt can hang the load)");
  } else if (manifest.gitAuth === "https-token" && manifest.gitCredentialEnvName) {
    // The askpass helper reads the token from secrets.env AT USE TIME — the value never rides an env
    // var into every child (the Q9 posture), and the helper survives restarts.
    const helper = join(root, ".dev-loop", "git_askpass.sh");
    writeFileSync(helper, `#!/bin/sh\n# dev-loop bundle: git credential helper — token from secrets.env, never from argv/env\nsed -n 's/^${manifest.gitCredentialEnvName}=//p' "${wsSecretsPath(root)}"\n`, { mode: 0o700 });
    chmodSync(helper, 0o700);
    env.GIT_ASKPASS = helper;
    console.log(`git auth: HTTPS-token askpass helper (reads ${manifest.gitCredentialEnvName} from secrets.env at use time)`);
  }

  // Re-materialize repos: fail-fast probe, fresh clone on absent, RESUME (fetch) on present (§4.5 step 3).
  // SECURITY (review finding): clone targets come from the VALIDATED config (ws.file.repos — E03 pins
  // every path inside the workspace root), NEVER from the plaintext manifest — the manifest is
  // unauthenticated and tamperable, and age recipients are public keys, so a crafted bundle could
  // otherwise name a traversal path and write outside the workspace. The manifest's repo list is
  // display/preflight metadata only.
  const repoEntries = Object.entries(ws.file.repos).map(([ref, r]) => ({ ref, path: r.path, remote: r.remote }));
  for (const r of repoEntries) {
    const abs = join(root, r.path);
    if (!r.remote) { if (!existsSync(abs)) console.warn(`⚠️  repo '${r.ref}' has no remote and no local clone at ${r.path} — register a remote or copy it manually`); continue; }
    const probe = spawnSync("git", ["ls-remote", "--heads", r.remote], { env, encoding: "utf8", timeout: 60_000 });
    if (probe.status !== 0) die(`repo '${r.ref}': ${r.remote} unreachable/unauthorized (${(probe.stderr ?? "").split("\n")[0] || `exit ${probe.status}`}) — fix the git credential (§4.1a) and re-run; refusing to half-materialize`, 1);
    if (!existsSync(abs)) {
      console.log(`cloning ${r.ref} ← ${r.remote}`);
      mkdirSync(dirname(abs), { recursive: true });
      const c = spawnSync("git", ["clone", r.remote, abs], { env, stdio: "inherit" });
      if (c.status !== 0) die(`git clone failed for '${r.ref}' (exit ${c.status})`, 1);
    } else {
      const f = spawnSync("git", ["-C", abs, "fetch", "--all", "--prune"], { env, stdio: "ignore" });
      console.log(`repo '${r.ref}' present — ${f.status === 0 ? "fetched (resume)" : "fetch failed (continuing with local state)"}`);
    }
  }

  // Op-API gate for the remote board/attach surface (§4.5 step 3): seed hub.transport="daemon" on
  // every project row — idempotent JSON merge; the daemon reads it fresh per request.
  if (ws.file.team.backend === "service" && existsSync(dbPath)) {
    try {
      const db = openDb(dbPath);
      try {
        for (const row of db.prepare("SELECT id, settings_json FROM projects").all() as Array<{ id: string; settings_json?: string }>) {
          let s: Record<string, unknown>; try { s = JSON.parse(row.settings_json ?? "{}"); } catch { s = {}; }
          const hub = (s.hub ?? {}) as Record<string, unknown>;
          if (hub.transport === "daemon") continue;
          s.hub = { ...hub, transport: "daemon" };
          db.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify(s), row.id);
        }
      } finally { db.close(); }
      console.log("op-API gate seeded (settings_json.hub.transport='daemon') — the token-authed board/attach write surface is live");
    } catch (e) { console.warn(`op-API gate seeding failed (${(e as Error).message}) — attach writes stay dormant until seeded`); }
  }

  // Boot reclamation + preflight (§4.5 steps 4-5): repair stale locks/worktrees, then doctor fail-fast.
  const cliEntry = join(here, "cli.ts").replace(/\.ts$/, existsSync(join(here, "cli.ts")) ? ".ts" : ".js");
  const runCli = (args: string[], io: "inherit" | "pipe" = "inherit") => spawnSync(process.execPath, [cliEntry, ...args], { cwd: ws.root, env, stdio: io });
  runCli(["team", "repair"]);
  const doc = runCli(["doctor"]);
  if (doc.status !== 0) die("doctor preflight FAILED — a headless loop on a broken workspace burns tokens blind; fix the ❌ items and re-run `dev-loop up --bundle`", 1);

  if (opts.noRun) { console.log("✅ bundle loaded (--no-run) — start the loop with: dev-loop run --agents " + manifest.run.agents); return 0; }

  // Chain into the loop — `run` OWNS the daemon (Q5: its auto-ensure via the lifecycle path). Signals
  // forward so a container stop reaches the scheduler's own SIGTERM drain.
  console.log(`starting the loop: dev-loop run --agents ${manifest.run.agents} (run owns the board daemon — Q5)`);
  return await new Promise<number>((resolveExit) => {
    const child = spawn(process.execPath, [cliEntry, "run", "--agents", manifest.run.agents], { cwd: ws.root, env, stdio: "inherit" });
    const fwd = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* gone */ } };
    process.on("SIGTERM", () => fwd("SIGTERM"));
    process.on("SIGINT", () => fwd("SIGINT"));
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
}

// Moved-source guard (Q4: marker + refuse): shared check for run/doctor.
export function movedMarker(root: string): { movedAt?: string; bundle?: string } | null {
  try { return JSON.parse(readFileSync(movedMarkerPath(root), "utf8")) as { movedAt?: string; bundle?: string }; }
  catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await bundleExport(process.argv.slice(2)));
}
