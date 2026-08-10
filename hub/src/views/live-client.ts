// The page's live-update client — a real function rather than a string in a template literal.
//
// `ui.ts` embeds it into every served page via `liveClient.toString()`, so the bytes the browser runs
// ARE the bytes `hub/test/stale-banner.ts` drives; there is no second copy to drift from. That
// extraction is what makes the client testable at all: LOOP-386's banner defect shipped underneath
// four `text.includes('ok===false')` assertions, which mirror source and cannot see behaviour, and
// the repo's source-integrity gate forbids evaluating a served script in the test
// (`security/source_integrity.py`, rule `function-constructor`). Extraction, not evaluation.
//
// TWO CONSTRAINTS, both load-bearing, because `.toString()` carries the function body and nothing
// else:
//   1. SELF-CONTAINED — it may not reference ANY module-scope binding at runtime (no imports, no
//      shared constants, no helper defined outside it). Type annotations are fine: they are erased
//      before the browser sees them.
//   2. Every ambient browser global arrives as a PARAMETER, so a test drives it by calling it with
//      stubs instead of reconstructing an environment around free variables.
//
// LOOP-532 — the banner has TWO independent fault sources (a lost stream, an unhealthy daemon) and
// exactly ONE element. LOOP-386 shipped them as two direct writers, so the 15s poll's `else` arm
// cleared a banner it did not own: the stream dies while the daemon stays healthy ⇒ the banner is
// raised, then silently removed within 15s while the page keeps rendering its last HTML — LOOP-386's
// own failure mode. It is not a flicker: EventSource retries a transport failure, but a 401 closes
// the stream for good (and `/api/health` is the one path `enforceBearer` exempts, so it keeps
// answering ok:true). So both sources are STATE here, and `renderBanner()` is the single writer that
// derives the element from them. A health fault outranks a lost stream (it is the more specific,
// more actionable message); the banner clears only when BOTH are clear. The remedy is appended only
// when the server's error does not already end with it — the `dbFileReplaced` and `projectRowGone`
// arms both do.

/** The subset of `Element` the client touches (structural, so a test can pass a plain object). */
export interface LiveEl {
  innerHTML: string;
  classList: { add(c: string): void; remove(c: string): void };
}
/** The subset of `document` the client touches. */
export interface LiveDocument {
  getElementById(id: string): LiveEl | null;
  activeElement: { tagName?: string } | null;
  addEventListener(type: string, fn: () => void): void;
}
/** The subset of `EventSource` the client touches. */
export interface LiveEventSource {
  onmessage?: ((e: { data: string }) => void) | null;
  onerror?: (() => void) | null;
}
export type LiveEventSourceCtor = new (url: string) => LiveEventSource;
export type LiveFetch = (url: string) => Promise<{ json(): Promise<unknown> }>;

/**
 * Progressive-enhancement live updates (the page degrades to static HTML when this never runs).
 * Subscribes to the SSE stream at `streamPath`, flips the live dot on new activity, reloads the page
 * — but NEVER while a form field is focused — and owns the stale-daemon banner.
 */
export function liveClient(
  doc: LiveDocument,
  EventSourceCtor: LiveEventSourceCtor,
  fetchFn: LiveFetch,
  setIntervalFn: (fn: () => void, ms: number) => unknown,
  loc: { reload(): void },
  streamPath: string,
): void {
  var dot = doc.getElementById('live'), banner = doc.getElementById('stale-banner');
  var base: string | null = null, pending = false, streamLost = false, healthErr: string | null = null;
  var REMEDY = 'Restart it: dev-loop daemon up';
  var es = new EventSourceCtor(streamPath);
  function esc(s: string): string {
    return String(s).replace(/[&<>"']/g, function (c: string) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }
  function typing(): boolean {
    var a = doc.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  }
  function showBanner(msg: string, remedy: string): void {
    if (banner) {
      banner.innerHTML = esc(msg) + (remedy ? '<span class="sb-remedy">' + esc(remedy) + '</span>' : '');
      banner.classList.add('show');
    }
  }
  function hideBanner(): void {
    if (banner) { banner.classList.remove('show'); banner.innerHTML = ''; }
  }
  // The ONE writer of the banner element. Both fault sources are read here and nowhere else, so
  // neither can clear a banner the other raised.
  function renderBanner(): void {
    if (healthErr !== null) showBanner(healthErr, healthErr.slice(-REMEDY.length) === REMEDY ? '' : REMEDY);
    else if (streamLost) showBanner('Connection to daemon lost — this view may be stale', 'The page will reload automatically when the connection returns.');
    else hideBanner();
  }
  es.onmessage = function (e: { data: string }): void {
    var id = e.data;
    if (base === null) { base = id; return; }
    if (id !== base) { if (dot) dot.classList.add('on'); pending = true; if (!typing()) loc.reload(); }
    if (streamLost) { streamLost = false; if (!pending) renderBanner(); }
  };
  es.onerror = function (): void { streamLost = true; renderBanner(); };
  doc.addEventListener('focusout', function (): void { if (pending && !typing()) loc.reload(); });
  setIntervalFn(function (): void {
    try {
      fetchFn('/api/health').then(function (r) { return r.json(); }).then(function (h) {
        var body = h as { ok?: boolean; error?: string } | null;
        healthErr = body && body.ok === false ? body.error || 'Daemon unhealthy' : null;
        renderBanner();
      }).catch(function () { /* a failed probe is not a verdict — the SSE arm owns transport loss */ });
    } catch (_) { /* no fetch ⇒ no health signal; the SSE arm still works */ }
  }, 15000);
}
