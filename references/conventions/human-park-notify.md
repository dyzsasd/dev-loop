# Notifying the operator on a human-park — conventions §9 pointer file

> Moved out of `references/conventions.md` §9 (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §9's contract: read it at the trigger moment the §9 stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

> **One operator-alert channel, two transports — `{transport: "webhook" | "bot"}`.**
> `webhook` is the one-way DEFAULT (write-only incoming-webhook URL, any backend); `bot` is the
> opt-in `service`-only superset (provider bot app, richer posting). Emitter by backend: on
> `service` the daemon is the single emitter (trigger = the `Human-Blocked` state); on
> `linear` PM emits on the label park. All opt-in; absent ⇒ no pinging.

When a ticket is **left human-parked for the operator** — `blocked` + `needs-pm` with
`Bail-shape: external-prereq` (a real credential / money / legal / security prerequisite,
or a capability this run lacks; this also covers a `[reflect-proposal]`, §17, and any
genuine human-only escalation the owner leaves blocked) — the loop should **actively ping
the operator out-of-band**. It must be out-of-band (a Slack / Lark webhook), **not** a
Linear @mention: the agents and the operator share one Linear identity, so a self-mention is
suppressed and can't be the channel. The owner is **PM** (Job B is where the human-park
decision is made); no other agent notifies, and Reflect (read-only on tickets, §17) never
POSTs — PM announces a Reflect-filed parked proposal on its next observe. The trigger is
**`external-prereq` only** — `decision-needed` / `scope-design` are PM's to resolve
(§12a), not to page you for; if the bail-shape tag is missing/unparseable, **fail closed**
(do not notify). Absent a channel (`team.comms` / its bridged `notify` view) ⇒ skip entirely (no POST, no extra work — true
no-op).

With `notify`/`team.comms` configured, read **`references/notify.md` at the moment you park
(or first refresh) a human-parked ticket**: it carries the §16-safe message allow-list, the
per-type POST formats + HMAC signing, digest batching, failure logging, and the dry-run
behavior. Two invariants stay resident here: add `notified` only after a successful POST
(full REPLACE-style label re-pass + re-fetch, §10 hazards #1/#2), and when you **unpark** a
ticket, drop `notified` in the same write so a genuine re-park re-announces.
