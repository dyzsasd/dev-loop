// dev-loop hub daemon — the background notifier + WAL-maintenance timers (A3: extracted from daemon.ts).
// Pure, self-contained: each tick reads/writes the SoR through the passed writable connection and resolves
// its send target from the channel/notify config. daemon.ts's foreground boot starts these; it also
// re-exports them so the existing test imports (test/blocked.ts, no-progress.ts, wal-checkpoint.ts,
// daemon.ts) keep resolving `.../daemon.ts`.
import { DatabaseSync } from "node:sqlite";
import { openDb, logEvent } from "./db.ts";
import { getEnabledChannel, resolveCreds, resolveNotifyWebhook, scrubErr, cleanLine, sendVia, CHANNEL_DRYRUN, CHANNEL_SEND_CAP, type Provider, type Transport, type FetchImpl } from "./channel.ts";
import { eventData } from "./daemonviews.ts";

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
  // DL-59: resolve ONE send target. The DB `channels` row (getEnabledChannel) takes PRECEDENCE so a project
  // with a registered bot/webhook channel is byte-for-byte unchanged; the §9 `notify` webhook (projects.json,
  // resolveNotifyWebhook) is the FALLBACK that closes the L2 leak (a notify-only project previously got NO
  // alert — a true no-op here). Choosing exactly one target means a project configured with BOTH can never
  // double-send the same park (the AC's no-double-send), at no extra marker/state cost.
  const dbCh = getEnabledChannel(writeDb, projectId);
  const nt = dbCh ? null : resolveNotifyWebhook(opts.notify);
  if (!dbCh && !nt) return 0; // no DB channel AND no §9 notify webhook ⇒ nothing to do (true no-op)
  const target = dbCh
    ? { provider: dbCh.provider as Provider, creds: resolveCreds(dbCh), channelRef: dbCh.channel_ref, transport: (dbCh.transport as Transport) ?? "bot", label: `${dbCh.provider}/${dbCh.transport ?? "bot"}` }
    : { provider: nt!.provider, creds: nt!.creds, channelRef: "", transport: "webhook" as Transport, label: `${nt!.provider}/webhook (§9 notify)` };
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
    // §16 allow-list line: id + truncated title + localhost url ONLY. No description/labels/PII/secrets.
    const line = `[${projectKey}] human-blocked: ${t.id} ${cleanLine(t.title, 80)} · ${baseUrl}/ticket/${t.id}`;
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
  if (!(opts.cadenceHours > 0)) return null;                          // disabled
  // DL-59: start if EITHER a registered DB channel OR the §9 `notify` webhook is configured — a notify-only
  // project must no longer be a no-op. `notify` flows through `...opts` into each blockedNotifyTick run.
  if (!getEnabledChannel(opts.writeDb, opts.projectId) && !resolveNotifyWebhook(opts.notify)) return null; // neither ⇒ true no-op
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
  // Resolve ONE send target FIRST (cheap) — identical precedence to blockedNotifyTick (DL-59): a DB `channels`
  // row wins; else the §9 `notify` webhook; else true no-op (so a no-channel project does zero ledger work).
  const dbCh = getEnabledChannel(writeDb, projectId);
  const nt = dbCh ? null : resolveNotifyWebhook(opts.notify);
  if (!dbCh && !nt) return 0;
  const target = dbCh
    ? { provider: dbCh.provider as Provider, creds: resolveCreds(dbCh), channelRef: dbCh.channel_ref, transport: (dbCh.transport as Transport) ?? "bot", label: `${dbCh.provider}/${dbCh.transport ?? "bot"}` }
    : { provider: nt!.provider, creds: nt!.creds, channelRef: "", transport: "webhook" as Transport, label: `${nt!.provider}/webhook (§9 notify)` };

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
  if (!getEnabledChannel(opts.writeDb, opts.projectId) && !resolveNotifyWebhook(opts.notify)) return null;
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

