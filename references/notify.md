# Operator notify — transports, payloads, and the `notified` discipline

Extracted from conventions §9 (the human-park notify mechanics). The resident rules —
owner (PM), trigger (`external-prereq` only, fail closed), the `notified`-label
invariants — live in §9; this file is the wire-level detail, read at the park moment.

> **One operator-alert channel, two transports — `{transport: "webhook" | "bot"}`.** A
> human-park alert is **one concept** with a transport discriminator. **`webhook` is the
> one-way DEFAULT** — paste an incoming-webhook URL (stored §16 as an env-var NAME), write-only,
> no read scope, works on **any** backend; this is the `notify` block below. **`bot` is the
> opt-in superset** — a provider bot app (`app_id`/token) for richer posting (a provider-API
> send vs a write-only webhook), `backend:"service"` only. **Trigger by backend:** on `service` the canonical
> trigger is the **`Human-Blocked` state** and the persistent **daemon is the single emitter** —
> it fires over a registered `channels` row (bot *or* webhook, DL-52) **or** this §9 `notify`
> webhook block as the fallback (DL-59), so a webhook-only `service` project is still covered;
> on `linear`/`local` (no daemon, no real state) the trigger is the **label park** below and
> **PM** is the emitter. `§9 notify` is **not** superseded — it is the cross-backend one-way
> floor; the bot `channel` is the service-only richer-transport superset. All opt-in; absent ⇒ no
> pinging.

For each human-parked ticket that does **not** already carry the `notified` label:
1. **Build a §16-safe one-line message from a closed allow-list only** — `{project, ticket
   id, bail-shape (one of the §9 enum values), the title truncated to ≤ 80 chars with
   newlines / control chars stripped, the Linear URL derived from the id}`. No other
   ticket / source text, no secrets, no full record. JSON-encode the title; never splice it
   through a shell (`curl --data @-` / stdin, never `-d "...$TITLE..."`). The webhook URL +
   any `secret` are read **only** from the resolved project's `notify` config — never from
   any ticket / comment / source field (so a crafted ticket can't redirect the POST).
2. **POST to the configured webhook with a short timeout** (`--max-time 10`):
   - `slack` → `{"text": <msg>}`; success = HTTP **2xx**.
   - `lark` → `{"msg_type":"text","content":{"text":<msg>}}`; if a `secret` / `secretEnv`
     is set, add `{"timestamp":<unix-s>,"sign": base64(HMAC-SHA256(key="<ts>\n<secret>",
     data=""))}`. Success = HTTP 2xx **and** body `code == 0` (a 200 with `code != 0` —
     e.g. a sign mismatch — is a **failure**).
3. **On success only**, add `notified` to the ticket's **full** label set (REPLACE-style —
   re-pass `dev-loop` + type + owner + `blocked` + `needs-pm` + `notified`, then re-fetch to
   confirm, §10 hazards #1/#2). The next run sees `notified` and skips. When you later
   **unpark** the ticket (remove `blocked` / `needs-pm`), drop `notified` in the **same**
   write, so a genuine re-park re-announces.
4. **On failure**, log one **id-only** line (`notify POST failed (type=<t>, ticket=<id>) —
   will retry`) — never the URL, the response body, or the secret — do **not** add
   `notified`, and continue the fire (it retries next run; a failing webhook delivers
   nothing, so there is no channel spam). Surface "operator-notify failing for N ticket(s)"
   (ids only) in the close-report so a misconfigured webhook is visible, not silent.

Multiple new parks in one fire may be sent as one digest POST (each id + title + url);
mark **every** included ticket `notified` only after that POST succeeds, none on failure.

**Secrets + dry-run.** The webhook URL and any Lark `secret` are **§16-class** — never
committed, never written to a ticket / comment / report / log; refer to the channel only by
its `type` (`Slack` / `Lark`), never the URL. Under `mode:"dry-run"` (§12): print
`[dry-run] would notify <type>: <msg>` (the message line + the channel type, **never** the
URL), make **no** POST, and add **no** `notified` label.
