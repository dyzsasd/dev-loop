// dev-loop hub daemon — the background notifier + WAL-maintenance timers (A3: extracted from daemon.ts).
// Pure, self-contained: each tick reads/writes the SoR through the passed writable connection and resolves
// its send target from the channel/notify config. daemon.ts's foreground boot starts these; it also
// re-exports them so the existing test imports (test/blocked.ts, no-progress.ts, wal-checkpoint.ts,
// daemon.ts) keep resolving `.../daemon.ts`.
import { DatabaseSync } from "node:sqlite";
import { statSync, readFileSync } from "node:fs";  // docs P3b: the repo-file strategy watch reads mtime + content hash (never the content into a message)
import { createHash } from "node:crypto";
import { openDb, logEvent } from "./db.ts";
import { getEnabledChannel, resolveCreds, resolveNotifyWebhook, scrubErr, cleanLine, sendVia, CHANNEL_DRYRUN, CHANNEL_SEND_CAP, type Provider, type Creds, type Transport, type FetchImpl } from "./channel.ts";
import { eventData } from "./views/activity.ts";

// ─── DL-59 send-target resolution, shared by every notifier tick ───────────────────────────────────
// ONE send target: the DB `channels` row (getEnabledChannel) takes PRECEDENCE so a project with a
// registered bot/webhook channel is byte-for-byte unchanged; the §9 `notify` webhook (projects.json /
// the team.comms bridge) is the FALLBACK that closed the L2 leak (a notify-only project previously got
// NO alert). Choosing exactly one target means a project configured with BOTH can never double-send
// the same alert. `null` ⇒ no channel AND no notify webhook ⇒ the caller is a true no-op.
interface SendTarget { provider: Provider; creds: Creds; channelRef: string; transport: Transport; label: string }
function resolveTarget(writeDb: DatabaseSync, projectId: string, notify: unknown): SendTarget | null {
  const dbCh = getEnabledChannel(writeDb, projectId);
  const nt = dbCh ? null : resolveNotifyWebhook(notify);
  if (!dbCh && !nt) return null;
  return dbCh
    ? { provider: dbCh.provider as Provider, creds: resolveCreds(dbCh), channelRef: dbCh.channel_ref, transport: (dbCh.transport as Transport) ?? "bot", label: `${dbCh.provider}/${dbCh.transport ?? "bot"}` }
    : { provider: nt!.provider, creds: nt!.creds, channelRef: "", transport: "webhook" as Transport, label: `${nt!.provider}/webhook (§9 notify)` };
}

// compact §16-safe duration for a notifier one-liner: "3d" / "26h" / "5m" (never raw ms)
const fmtDur = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
};

// ─── workflows P3: the Human-Blocked reminder DEFAULT ──────────────────────────────────────────────
// The parking state had a producer (PM parks, §9a) but the consumer side shipped default-OFF, so on a
// comms-configured workspace a parked ticket could sit silent forever. New default: once the team has
// an outward channel (team.comms — which toLegacyView also bridges into the §9 `notify` block the
// daemon reads), an ABSENT humanBlockedReminderHours means 24h. An EXPLICIT 0 (or any non-positive /
// non-numeric explicit value — the pre-change coercion) stays the opt-out, and without a comms channel
// the default remains 0 (there is nowhere to remind INTO; the send-target guard would no-op anyway).
// Read at daemon BOOT: an already-running daemon picks the new default up on restart only
// (references/config-schema.md documents the migration note).
export const DEFAULT_BLOCKED_REMINDER_HOURS = 24;
export function resolveBlockedReminderHours(settings: unknown, commsConfigured: boolean): number {
  const raw = (settings as { humanBlockedReminderHours?: unknown } | null | undefined)?.humanBlockedReminderHours;
  if (raw !== undefined && raw !== null) return Number(raw) > 0 ? Number(raw) : 0; // explicit value wins; 0/junk ⇒ off
  return commsConfigured ? DEFAULT_BLOCKED_REMINDER_HOURS : 0;
}

// ─── DL-26: Human-Blocked periodic notifier (service backend, option b) ───────
// On `service` the daemon owns the ENTIRE Human-Blocked notification lifecycle: the FIRST ping the
// moment a ticket is detected in the state (no human_blocked.notified marker yet ⇒ due now) AND the
// periodic reminders thereafter (now − last marker ≥ cadence). Due-ness is computed STATELESS from
// the events ledger, so a daemon restart never double-sends and needs no counter. This is the daemon's
// ONE write to the SoR (the human_blocked.notified event), done via the writable `writeDb`, NEVER the
// query_only read connection. Absent a channel OR humanBlockedReminderHours≤0 ⇒ no timer (true no-op).
export async function blockedNotifyTick(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; baseUrl: string;
  cadenceMs: number; nowMs: number; fetchImpl?: FetchImpl; notify?: unknown;
}): Promise<number> {
  const { writeDb, projectId, projectKey, baseUrl, cadenceMs, nowMs } = opts;
  // DL-59: ONE send target (DB channel wins over the §9 notify webhook — see resolveTarget) or a true no-op.
  const target = resolveTarget(writeDb, projectId, opts.notify);
  if (!target) return 0;
  const rows = writeDb.prepare(
    "SELECT id,title FROM tickets WHERE project_id=? AND state='Human-Blocked' ORDER BY updated_at",
  ).all(projectId) as { id: string; title: string }[];
  // DL-33: PER-TICK loop-safety cap — `sent` resets every invocation, so a long-running daemon never
  // goes permanently silent (a per-PROCESS counter would become a lifetime ceiling on this persistent
  // process, unlike the MCP server's short-lived per-fire process).
  let sent = 0;
  for (const t of rows) {
    if (sent >= CHANNEL_SEND_CAP) break; // bound sends THIS tick only (resets next tick)
    // Stateless due-ness: the last REAL human_blocked.notified event. None ⇒ first ping (due now).
    const last = writeDb.prepare(
      "SELECT MAX(created_at) m FROM events WHERE ticket_id=? AND kind='human_blocked.notified'",
    ).get(t.id) as { m: string | null };
    const due = !last.m || (nowMs - Date.parse(last.m)) >= cadenceMs;
    if (!due) continue;
    // Age in the state (workflows P3: the reminder must say HOW LONG the loop has been parked on a human):
    // the newest issue.transition INTO Human-Blocked from the events ledger — stateless, like the due-ness
    // read. A ticket with no such event (seeded/imported directly into the state) just omits the age.
    const enteredIso = (writeDb.prepare(
      "SELECT data, created_at FROM events WHERE ticket_id=? AND kind='issue.transition' ORDER BY id DESC",
    ).all(t.id) as { data: string; created_at: string }[])
      .find((e) => eventData(e.data).to === "Human-Blocked")?.created_at;
    const enteredMs = enteredIso ? Date.parse(enteredIso) : NaN;
    const age = Number.isFinite(enteredMs) ? ` for ${fmtDur(nowMs - enteredMs)}` : "";
    // §16 allow-list line: id + truncated title + age + the FIXED resume action + localhost url ONLY.
    // No description/labels/PII/secrets. The resume action is the loop's consumer side (workflows P3):
    // the operator moves the ticket back to Todo (web move form, or the named CLI verb) and the loop resumes.
    const line = `[${projectKey}] human-blocked${age}: ${t.id} ${cleanLine(t.title, 80)} — resume: move it back to Todo (dev-loop ticket update ${t.id} --state Todo) · ${baseUrl}/ticket/${t.id}`;
    try {
      if (CHANNEL_DRYRUN) {
        // DL-34: dry-run is WRITE-FREE (the DL-11 invariant) — preview only, NO marker / NO ledger
        // event — so a later LIVE tick on the same DB still fires the first real ping, and the
        // events ledger never gains a phantom "notified" that never sent. DL-52: the preview names the
        // channel type (provider/transport) + the §16-safe message line — never the webhook URL/secret.
        console.error(`[daemon] [dry-run] would notify human-blocked ${t.id} via ${target.label}: ${line}`);
      } else {
        // DL-52/DL-59: pass the resolved target's transport — a 'webhook' target (a DB webhook channel OR the
        // §9 notify webhook) pings the incoming-webhook URL (no bot app); a 'bot' DB channel ⇒ the provider-API
        // send, unchanged. blockedNotifyTick's OWN logic (due-ness, the DL-33 per-tick cap, the marker) is
        // untouched — it just threads the chosen target through (one send + one marker per due ticket).
        await sendVia(target.provider, target.creds, target.channelRef, { kind: "notify", lines: [line] }, opts.fetchImpl ?? fetch, target.transport);
        logEvent(writeDb, { project_id: projectId, ticket_id: t.id, actor: "daemon", kind: "human_blocked.notified", data: { provider: target.provider } }); // marker ONLY on a real send
      }
      sent++;
    } catch (e) {
      // id-only log, NO marker written ⇒ retried next tick (never echo the secret/body)
      console.error(`[daemon] human-blocked notify failed for ${t.id}: ${scrubErr((e as Error).message)}`);
    }
  }
  return sent;
}

export function startBlockedNotifier(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; baseUrl: string;
  cadenceHours: number; tickMs?: number; notify?: unknown;
}): ReturnType<typeof setInterval> | null {
  if (!(opts.cadenceHours > 0)) return null;                          // disabled (0 = the explicit opt-out)
  // DL-59: start if EITHER a registered DB channel OR the §9 `notify` webhook is configured — a notify-only
  // project must no longer be a no-op. `notify` flows through `...opts` into each blockedNotifyTick run.
  if (!resolveTarget(opts.writeDb, opts.projectId, opts.notify)) return null; // neither ⇒ true no-op
  const cadenceMs = opts.cadenceHours * 3_600_000;
  const tickMs = opts.tickMs ?? (Number(process.env.DEVLOOP_BLOCKED_TICK_MS) || 60_000);
  // .catch, not void: a throw from the tick's DB reads (transient SQLITE_BUSY, disk error) was an
  // unhandled rejection that killed the WHOLE daemon; a failed tick must just retry next interval.
  const run = () => { blockedNotifyTick({ ...opts, cadenceMs, nowMs: Date.now() }).catch((e) => console.error(`[daemon] blocked-notifier tick failed (retrying next tick): ${scrubErr(String((e as Error)?.message ?? e))}`)); };
  const timer = setInterval(run, tickMs);
  timer.unref?.();  // never keep the process alive solely for the notifier
  run();            // immediate first tick — a fresh park is announced without waiting a full interval
  return timer;
}

// ─── DL-76: loop circuit-breaker — daemon no-progress / runaway detector ──────────────────────────
// The Ralph-Wiggum guard at the LOOP level: a stuck loop that keeps firing (and billing) but produces no
// ACCEPTED change should page the operator ONCE — not bill silently. "Accepted change" = a ticket reaching
// Done (the §3 owner-verify gate passed), the exact throughput signal the DL-17 activityPage already counts.
// A sibling of blockedNotifyTick: SAME channel/notify resolution (DL-26/DL-59), SAME dry-run-is-write-free
// invariant (DL-34), SAME id-only failure log (§16) — only the DUE condition differs.
//
// THRESHOLD = a ROLLING WINDOW of H hours (settings_json.noProgressWindowHours), NOT "N consecutive fires":
// the daemon observes TIME + the events ledger, never agent fires directly, and a window is STATELESS, so a
// daemon restart never mis-counts (the events table is the durable SoR — no in-memory counter to lose). DUE =
// a STALL: zero issue.transition→Done events in the trailing window. De-duped like the Human-Blocked reminder
// via a project-wide `no_progress.notified` marker — at most ONE alert per stall EPISODE: a fresh alert fires
// only after accepted change RESUMED (a Done logged AFTER the last marker) and then stalled again. A cold start
// (a loop younger than the window, no prior history) is NOT a stall — guarded so the detector never cries wolf
// on boot. Absent a channel AND a §9 notify ⇒ true no-op (DL-59). Returns 1 if it alerted this tick, else 0.
export async function noProgressNotifyTick(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; baseUrl: string;
  windowMs: number; nowMs: number; fetchImpl?: FetchImpl; notify?: unknown;
}): Promise<number> {
  const { writeDb, projectId, projectKey, baseUrl, windowMs, nowMs } = opts;
  // Resolve ONE send target FIRST (cheap) — DL-59 precedence via resolveTarget: a DB `channels` row wins;
  // else the §9 `notify` webhook; else true no-op (so a no-channel project does zero ledger work).
  const target = resolveTarget(writeDb, projectId, opts.notify);
  if (!target) return 0;

  // "net accepted change" over the rolling window = COUNT of issue.transition events whose `to` is Done within
  // [now − windowMs, now]. SAME done-count logic as activityPage (the `to` lives in JSON `data`, so the filter
  // is in-process; a malformed row is skipped, never throws — activityPage AC5).
  const sinceIso = new Date(nowMs - windowMs).toISOString();
  const windowTrans = writeDb.prepare(
    "SELECT data FROM events WHERE project_id=? AND kind='issue.transition' AND created_at>=? ORDER BY id",
  ).all(projectId, sinceIso) as { data: string }[];
  const accepted = windowTrans.reduce((n, e) => n + (eventData(e.data).to === "Done" ? 1 : 0), 0);
  if (accepted > 0) return 0; // progress within the window ⇒ healthy, nothing to do

  // Cold-start guard: a loop YOUNGER than the window has no history to judge — "0 Done" is just "not warmed up
  // yet", not a stall. Require ≥1 event BEFORE the window before we ever alert (cheap; LIMIT 1 short-circuits).
  const hasHistory = !!writeDb.prepare(
    "SELECT 1 FROM events WHERE project_id=? AND created_at<? LIMIT 1",
  ).get(projectId, sinceIso);
  if (!hasHistory) return 0;

  // STALLED. De-dup like the Human-Blocked reminder: one alert per stall EPISODE. Re-alert only if accepted
  // change RESUMED since the last alert — a Done transition logged strictly AFTER the last marker (which, since
  // we are stalled NOW, must itself predate the window ⇒ it resumed-then-stalled-again). Stateless from the
  // ledger ⇒ a daemon restart never double-sends and needs no counter.
  const lastNotified = (writeDb.prepare(
    "SELECT MAX(created_at) m FROM events WHERE project_id=? AND kind='no_progress.notified'",
  ).get(projectId) as { m: string | null }).m;
  if (lastNotified) {
    const sinceAlert = writeDb.prepare(
      "SELECT data FROM events WHERE project_id=? AND kind='issue.transition' AND created_at>? ORDER BY id",
    ).all(projectId, lastNotified) as { data: string }[];
    const resumed = sinceAlert.some((e) => eventData(e.data).to === "Done");
    if (!resumed) return 0; // still the same stall episode (no Done since the alert) ⇒ stay silent
  }

  // §16 closed-allow-list one-liner: projectKey + the window + the metric + the localhost /activity link ONLY.
  // No ticket text / PII / secret; cleanLine bounds length + strips control chars (defense in depth).
  const windowH = +(windowMs / 3_600_000).toFixed(2);
  const line = cleanLine(`[${projectKey}] no-progress: 0 accepted change (Done) in the last ${windowH}h — loop may be stuck · ${baseUrl}/activity`, 200);
  try {
    if (CHANNEL_DRYRUN) {
      // DL-34: dry-run is WRITE-FREE (the DL-11 invariant) — preview only, NO marker / NO send — so a later
      // LIVE tick still fires the first real ping and the ledger never gains a phantom "notified".
      console.error(`[daemon] [dry-run] would notify no-progress via ${target.label}: ${line}`);
    } else {
      await sendVia(target.provider, target.creds, target.channelRef, { kind: "notify", lines: [line] }, opts.fetchImpl ?? fetch, target.transport);
      logEvent(writeDb, { project_id: projectId, ticket_id: null, actor: "daemon", kind: "no_progress.notified", data: { windowMs } }); // marker ONLY on a real send
    }
    return 1;
  } catch (e) {
    // id-less log, NO marker ⇒ retried next tick (never echo the secret/body)
    console.error(`[daemon] no-progress notify failed: ${scrubErr((e as Error).message)}`);
    return 0;
  }
}

export function startNoProgressNotifier(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; baseUrl: string;
  windowHours: number; tickMs?: number; notify?: unknown;
}): ReturnType<typeof setInterval> | null {
  if (!(opts.windowHours > 0)) return null;                            // disabled (absent / ≤0 ⇒ true no-op)
  // Start only if a send target exists (DL-59): a registered DB channel OR the §9 notify webhook — else no-op.
  if (!resolveTarget(opts.writeDb, opts.projectId, opts.notify)) return null;
  const windowMs = opts.windowHours * 3_600_000;
  // Re-check ≈ hourly by default (the stall window is measured in hours; a tighter poll just re-scans the
  // ledger for nothing, and the marker de-dup makes any extra tick harmless). Env-overridable for tests.
  const tickMs = opts.tickMs ?? (Number(process.env.DEVLOOP_NOPROGRESS_TICK_MS) || 3_600_000);
  const run = () => { noProgressNotifyTick({ ...opts, windowMs, nowMs: Date.now() }).catch((e) => console.error(`[daemon] no-progress tick failed (retrying next tick): ${scrubErr(String((e as Error)?.message ?? e))}`)); };
  const timer = setInterval(run, tickMs);
  timer.unref?.();  // never keep the process alive solely for this detector
  run();            // immediate first tick — a stall already in progress at boot is caught without waiting
  return timer;
}

// ─── docs P3: passive-intake foreign-doc-edit notifier ─────────────────────────────────────────────
// Under `intake.mode:"passive"` PM's doc-watch is OFF (§5a) — an operator/web edit to a hub doc would
// otherwise vanish (nothing reads the doc hunting for direction, and nothing tells the operator so).
// This tick is the daemon-side consumer: a doc version authored by a NON-AGENT actor (the web editor
// and CLI/MCP operator writes land as `operator`, actors.kind='human'; an unknown author fails FOREIGN
// — fail-notify) that has sat unconsumed past a settle window emits ONE comms line, deduped per
// version, so a burst of saves in an editing session collapses to the final version's line. The
// predicate is actor-KIND based, not a single-handle exclusion: ANY agent's draft (pm, qa, senior-dev)
// is loop-internal work that must never self-trigger this human-intake channel (the self-trigger
// exclusion of the PM doc-watch, docstore.latestForeignVersion, generalized to the whole agent team).
// `design` docs are excluded: latest-is-live, watched by the Design: pointer flow, not PM intake.
// Same envelope as blockedNotifyTick: DL-59 target, DL-34 write-free dry-run, §16 one-liner, DL-33 cap.
export async function docForeignEditNotifyTick(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; baseUrl: string;
  settleMs: number; nowMs: number; fetchImpl?: FetchImpl; notify?: unknown;
}): Promise<number> {
  const { writeDb, projectId, projectKey, baseUrl, settleMs, nowMs } = opts;
  const target = resolveTarget(writeDb, projectId, opts.notify);
  if (!target) return 0;
  // D6: archived docs are retired — no intake nag. (docArchive is design-only, which kind!='design'
  // already excludes; archived=0 is the structural belt against any other archival path.)
  const docs = writeDb.prepare(
    "SELECT id, slug FROM documents WHERE project_id=? AND kind!='design' AND archived=0 ORDER BY slug",
  ).all(projectId) as { id: string; slug: string }[];
  // one markers read for the whole tick (the ledger is append-only; parse-in-process like activityPage)
  const markers = (writeDb.prepare(
    "SELECT data FROM events WHERE project_id=? AND kind='doc_foreign_edit.notified'",
  ).all(projectId) as { data: string }[]).map((e) => eventData(e.data));
  let sent = 0;
  for (const d of docs) {
    if (sent >= CHANNEL_SEND_CAP) break;
    const v = writeDb.prepare(
      `SELECT version, author, created_at FROM document_versions
        WHERE doc_id=? AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.handle=author AND a.kind='agent')
        ORDER BY version DESC LIMIT 1`,
    ).get(d.id) as { version: number; author: string; created_at: string } | undefined;
    if (!v) continue;                                              // no human-authored version ⇒ nothing foreign
    if (nowMs - Date.parse(v.created_at) < settleMs) continue;     // still settling (mid-edit burst) ⇒ next tick
    if (markers.some((m) => m.slug === d.slug && Number(m.version) >= v.version)) continue; // deduped per version
    // §16 allow-list: slug + version + author HANDLE + the canonical /p/<key>/ doc url ONLY (no body text).
    const line = cleanLine(`[${projectKey}] doc edit: '${d.slug}' v${v.version} by ${v.author} awaits PM intake (passive mode) — review at ${baseUrl}/p/${projectKey}/doc/${d.slug}`, 240);
    try {
      if (CHANNEL_DRYRUN) {
        console.error(`[daemon] [dry-run] would notify doc edit '${d.slug}' v${v.version} via ${target.label}: ${line}`); // DL-34: write-free
      } else {
        await sendVia(target.provider, target.creds, target.channelRef, { kind: "notify", lines: [line] }, opts.fetchImpl ?? fetch, target.transport);
        logEvent(writeDb, { project_id: projectId, ticket_id: null, actor: "daemon", kind: "doc_foreign_edit.notified", data: { slug: d.slug, version: v.version } }); // marker ONLY on a real send
      }
      sent++;
    } catch (e) {
      console.error(`[daemon] doc-edit notify failed for '${d.slug}': ${scrubErr((e as Error).message)}`); // no marker ⇒ retried next tick
    }
  }
  return sent;
}

export function startDocForeignEditNotifier(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; baseUrl: string;
  intakeMode?: string; settleMs?: number; tickMs?: number; notify?: unknown;
}): ReturnType<typeof setInterval> | null {
  // Autonomous mode ⇒ no timer: PM's own doc-watch (latest FOREIGN version, pm-agent SKILL) owns the
  // propagation there, and a comms line on top would just be duplicate noise. Passive is the gap (§5a).
  if (opts.intakeMode !== "passive") return null;
  if (!resolveTarget(opts.writeDb, opts.projectId, opts.notify)) return null; // no send target ⇒ true no-op
  const settleMs = opts.settleMs ?? (Number(process.env.DEVLOOP_DOC_FOREIGN_SETTLE_MS) || 15 * 60_000);
  const tickMs = opts.tickMs ?? (Number(process.env.DEVLOOP_DOC_NOTIFY_TICK_MS) || 10 * 60_000);
  const run = () => { docForeignEditNotifyTick({ ...opts, settleMs, nowMs: Date.now() }).catch((e) => console.error(`[daemon] doc-edit notifier tick failed (retrying next tick): ${scrubErr(String((e as Error)?.message ?? e))}`)); };
  const timer = setInterval(run, tickMs);
  timer.unref?.();
  run(); // immediate first tick — an edit already sitting unconsumed at boot is surfaced without waiting
  return timer;
}

// ─── docs P3b: passive-intake REPO-FILE strategy-doc watch ─────────────────────────────────────────
// docForeignEditNotifyTick covers HUB docs only, but the default config keeps the strategy doc as a
// repo FILE (config-schema: strategyDoc {path} / a plain string) — under intake.mode:"passive" PM's
// doc-watch is off (§5a), so an operator edit to that file vanished exactly like a hub-doc edit did.
// This is the file-side twin: watch the file's CONTENT HASH (resolved once at boot via
// resolve-project.repoFileStrategyPath — the same doc-home rule PM boots with) and, on a SETTLED change
// (mtime older than the settle window — the burst-collapse twin of the hub tick's version created_at),
// emit ONE §16 comms line naming the PATH ONLY (never a byte of file content — the doc body never
// crosses the channel, §16). Ledger-dedupe BY HASH: the first observation records a silent
// `strategy_file.baseline` marker (a file has no authorship column, so "unchanged since boot" and
// "operator edit" are indistinguishable on first sight — never cry wolf at every daemon start); after
// that, a hash differing from the LAST recorded one (baseline or notified) fires once, and the
// `strategy_file_edit.notified` marker (written ONLY on a real send — the DL-26 invariant, so a failed
// send retries next tick) makes the same content never re-fire. DL-34: dry-run is fully write-free
// (no baseline either — a cold dry-run tick just observes). Same envelope otherwise: DL-59 target,
// per-tick resolution, id-only failure log.
export async function strategyFileEditNotifyTick(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string;
  filePath: string; displayPath?: string; settleMs: number; nowMs: number; fetchImpl?: FetchImpl; notify?: unknown;
}): Promise<number> {
  const { writeDb, projectId, projectKey, filePath, settleMs, nowMs } = opts;
  const displayPath = opts.displayPath ?? filePath;
  const target = resolveTarget(writeDb, projectId, opts.notify);
  if (!target) return 0;
  let mtimeMs: number, hash: string;
  try {
    hash = createHash("sha256").update(readFileSync(filePath)).digest("hex"); // hash stays in-process; NEVER the content into a line/event
    // stat AFTER the read (Codex review 2026-07-12): the mtime must describe a write AT-OR-AFTER the
    // content we just hashed — stat-then-read could hash a mid-save write while judging settledness by
    // the PREVIOUS write's age (a premature line + a second one for the final content). If a save lands
    // between read and stat, the newer mtime fails the settle check and the next tick re-reads cleanly.
    mtimeMs = statSync(filePath).mtimeMs;
  } catch { return 0; } // missing/unreadable file ⇒ nothing to watch this tick (a broken strategyDoc path is doctor's beat)
  // The last recorded hash for THIS path (baseline or notified, whichever is newest) — stateless from
  // the ledger, so a daemon restart keeps the watch exactly where it was (an edit made while the daemon
  // was down still fires: the persisted hash predates it).
  const last = (writeDb.prepare(
    "SELECT data FROM events WHERE project_id=? AND kind IN ('strategy_file.baseline','strategy_file_edit.notified') ORDER BY id DESC",
  ).all(projectId) as { data: string }[]).map((e) => eventData(e.data)).find((m) => m.path === displayPath);
  if (!last) {
    // first observation = the baseline, recorded SILENTLY (no send): the daemon cannot attribute the
    // current bytes to anyone. Dry-run stays write-free (DL-34) — it just observes and waits for live.
    if (!CHANNEL_DRYRUN) logEvent(writeDb, { project_id: projectId, ticket_id: null, actor: "daemon", kind: "strategy_file.baseline", data: { path: displayPath, hash } });
    return 0;
  }
  if (last.hash === hash) return 0;                 // unchanged, or this exact content already announced (hash dedupe)
  if (nowMs - mtimeMs < settleMs) return 0;         // still settling (mid-edit burst collapses to the final content's line)
  // §16 closed allow-list: projectKey + the CONFIG path + the fixed passive-mode action. No file content.
  const line = cleanLine(`[${projectKey}] operator edited ${displayPath} — PM is passive; file a needs-pm ticket to act`, 240);
  try {
    if (CHANNEL_DRYRUN) {
      console.error(`[daemon] [dry-run] would notify strategy-file edit '${displayPath}' via ${target.label}: ${line}`); // DL-34: write-free
    } else {
      await sendVia(target.provider, target.creds, target.channelRef, { kind: "notify", lines: [line] }, opts.fetchImpl ?? fetch, target.transport);
      logEvent(writeDb, { project_id: projectId, ticket_id: null, actor: "daemon", kind: "strategy_file_edit.notified", data: { path: displayPath, hash } }); // marker ONLY on a real send
    }
    return 1;
  } catch (e) {
    console.error(`[daemon] strategy-file notify failed for '${displayPath}': ${scrubErr((e as Error).message)}`); // no marker ⇒ retried next tick
    return 0;
  }
}

export function startStrategyFileEditNotifier(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string;
  filePath?: string | null; displayPath?: string; intakeMode?: string; settleMs?: number; tickMs?: number; notify?: unknown;
}): ReturnType<typeof setInterval> | null {
  // Same gate as the hub-doc tick: passive intake ONLY (autonomous mode ⇒ PM's own strategy-doc read
  // owns propagation), plus a resolved repo-file path and a send target — else a true no-op.
  if (opts.intakeMode !== "passive") return null;
  if (!opts.filePath) return null;                                             // no repo-file strategy doc (hub/Linear form, or zero-repo)
  if (!resolveTarget(opts.writeDb, opts.projectId, opts.notify)) return null;  // no send target ⇒ true no-op
  const filePath = opts.filePath;
  const settleMs = opts.settleMs ?? (Number(process.env.DEVLOOP_STRATEGY_FILE_SETTLE_MS) || 15 * 60_000); // the hub-doc settle window's twin
  const tickMs = opts.tickMs ?? (Number(process.env.DEVLOOP_STRATEGY_FILE_TICK_MS) || 10 * 60_000);
  const run = () => { strategyFileEditNotifyTick({ ...opts, filePath, settleMs, nowMs: Date.now() }).catch((e) => console.error(`[daemon] strategy-file notifier tick failed (retrying next tick): ${scrubErr(String((e as Error)?.message ?? e))}`)); };
  const timer = setInterval(run, tickMs);
  timer.unref?.();
  run(); // immediate first tick — seeds the baseline at boot (or surfaces an edit already settled past a prior baseline)
  return timer;
}

// ─── docs P6b: drafts-pending notifier ─────────────────────────────────────────────────────────────
// PM records direction as a DRAFT; only the operator may publish (docstore's single gate). Absent a
// nudge, agents keep executing the stale published version while the draft silently stalls — the web
// header chip (views/docs.ts draftsPendingCount) covers an operator who LOOKS, this line covers one who
// doesn't. Due = a gated doc (kind != 'design') whose drafts have trailed the published current for
// longer than `pendingMs` (measured from the FIRST unpublished version — a fresh draft on top does not
// reset the clock). Cadence = one line per `remindMs` (daily) while pending, deduped per version: the
// SAME latest version is never re-announced within a remind period, and a NEW draft version past the
// settle re-announces immediately (the marker names {slug, version}). Same envelope as the ticks above.
export async function docDraftsPendingNotifyTick(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; baseUrl: string;
  pendingMs: number; remindMs: number; nowMs: number; fetchImpl?: FetchImpl; notify?: unknown;
}): Promise<number> {
  const { writeDb, projectId, projectKey, baseUrl, pendingMs, remindMs, nowMs } = opts;
  const target = resolveTarget(writeDb, projectId, opts.notify);
  if (!target) return 0;
  const docs = (writeDb.prepare(
    `SELECT d.id, d.slug, d.current_version,
            (SELECT COALESCE(MAX(v.version),0) FROM document_versions v WHERE v.doc_id=d.id) AS latest
       FROM documents d WHERE d.project_id=? AND d.kind!='design' AND d.archived=0 ORDER BY d.slug`,
  ).all(projectId) as { id: string; slug: string; current_version: number; latest: number }[]) // D6: archived docs never nag (kind filter + the archived=0 structural belt)
    .filter((d) => d.latest > d.current_version); // the header-chip predicate (views/docs.ts), server-side
  const markers = (writeDb.prepare(
    "SELECT data, created_at FROM events WHERE project_id=? AND kind='doc_drafts.notified' ORDER BY id DESC",
  ).all(projectId) as { data: string; created_at: string }[])
    .map((e) => { const m = eventData(e.data); return { slug: m.slug as unknown, version: m.version as unknown, at: e.created_at }; });
  let sent = 0;
  for (const d of docs) {
    if (sent >= CHANNEL_SEND_CAP) break;
    // trailing-since = the FIRST version past the published current (append-only ⇒ always version+1)
    const since = (writeDb.prepare(
      "SELECT created_at FROM document_versions WHERE doc_id=? AND version=?",
    ).get(d.id, d.current_version + 1) as { created_at: string } | undefined)?.created_at;
    if (!since || !(nowMs - Date.parse(since) >= pendingMs)) continue; // not yet trailing long enough
    const last = markers.find((m) => m.slug === d.slug);              // newest marker for this doc (DESC scan)
    if (last && Number(last.version) === d.latest && nowMs - Date.parse(last.at) < remindMs) continue; // deduped
    // §16 allow-list: slug + version numbers + the canonical /p/<key>/ doc url ONLY (no body/title text).
    const over = d.current_version > 0 ? `over published v${d.current_version}` : "(never published)";
    const line = cleanLine(`[${projectKey}] ${d.slug}: draft v${d.latest} pending ${over} — review at ${baseUrl}/p/${projectKey}/doc/${d.slug}`, 240);
    try {
      if (CHANNEL_DRYRUN) {
        console.error(`[daemon] [dry-run] would notify drafts-pending '${d.slug}' v${d.latest} via ${target.label}: ${line}`); // DL-34: write-free
      } else {
        await sendVia(target.provider, target.creds, target.channelRef, { kind: "notify", lines: [line] }, opts.fetchImpl ?? fetch, target.transport);
        logEvent(writeDb, { project_id: projectId, ticket_id: null, actor: "daemon", kind: "doc_drafts.notified", data: { slug: d.slug, version: d.latest } }); // marker ONLY on a real send
      }
      sent++;
    } catch (e) {
      console.error(`[daemon] drafts-pending notify failed for '${d.slug}': ${scrubErr((e as Error).message)}`); // no marker ⇒ retried next tick
    }
  }
  return sent;
}

export function startDocDraftsPendingNotifier(opts: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; baseUrl: string;
  pendingMs?: number; remindMs?: number; tickMs?: number; notify?: unknown;
}): ReturnType<typeof setInterval> | null {
  if (!resolveTarget(opts.writeDb, opts.projectId, opts.notify)) return null; // no send target ⇒ true no-op
  const pendingMs = opts.pendingMs ?? 24 * 3_600_000;   // "trailing for > 24h" (docs P6b)
  const remindMs = opts.remindMs ?? 24 * 3_600_000;     // one DAILY line while pending
  // Re-check ≈ hourly by default: the thresholds are day-scale and the per-version dedupe makes any
  // extra tick harmless (the no-progress precedent). Env-overridable for tests.
  const tickMs = opts.tickMs ?? (Number(process.env.DEVLOOP_DOC_DRAFTS_TICK_MS) || 3_600_000);
  const run = () => { docDraftsPendingNotifyTick({ ...opts, pendingMs, remindMs, nowMs: Date.now() }).catch((e) => console.error(`[daemon] drafts-pending tick failed (retrying next tick): ${scrubErr(String((e as Error)?.message ?? e))}`)); };
  const timer = setInterval(run, tickMs);
  timer.unref?.();
  run(); // immediate first tick — a draft already stalled at boot is surfaced without waiting
  return timer;
}

// ─── P3b (design daemon-multicli §P3): bound the single-writer connection's WAL ───────────────────
// The daemon is the canonical single writer for an opted-in (`hub.transport:"daemon"`) project — every
// agent op-API write + human web-write flows through the ONE persistent `writeDb`. A long-lived writable
// handle is never auto-checkpointed by a closing connection, so the `-wal` file grows unbounded; a periodic
// `PRAGMA wal_checkpoint(TRUNCATE)` checkpoints the log into the main DB and truncates it back to zero.
//
// CRITICAL (Codex review 2026-06-27): node:sqlite is SYNCHRONOUS and the daemon is single-threaded, so a
// checkpoint runs ON the event loop. On the normal `writeDb` (busy_timeout=5000, db.ts) a TRUNCATE blocked
// by a concurrent reader would STALL the whole daemon up to 5s, then leave the WAL non-truncated. So the
// checkpoint runs on a DEDICATED maintenance connection with `busy_timeout=0`: under contention it returns
// BUSY *immediately* (a clean no-op retried next interval) and never blocks request handling; when the WAL
// is free it truncates to zero as intended. The direct-db stdio `server.ts` fallback is unaffected.
export function walCheckpointTick(ckDb: DatabaseSync): void {
  try { ckDb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* BUSY / locked ⇒ immediate no-op, retried next interval */ }
}

export function startWalCheckpoint(
  dbPath: string,
  intervalMs = Number(process.env.DEVLOOP_WAL_CHECKPOINT_MS) || 300_000, // 5 min default; env-overridable for tests
): ReturnType<typeof setInterval> {
  const ckDb = openDb(dbPath);
  try { ckDb.exec("PRAGMA busy_timeout=0"); } catch { /* if it can't be lowered, a BUSY still just throws → caught no-op */ }
  const timer = setInterval(() => walCheckpointTick(ckDb), intervalMs);
  timer.unref?.(); // never keep the process alive solely for the checkpoint
  return timer;
}

