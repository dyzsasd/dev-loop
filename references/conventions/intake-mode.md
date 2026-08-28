# Intake mode — autonomous vs passive — conventions §5a pointer file

> Moved out of `references/conventions.md` §5a (WS-A prompt economy, 2026-08-27) so the per-fire boot
> slice stays small. This file is PART OF §5a's contract: read it at the trigger moment the §5a stub
> names (a stub read is cited material, never a `Sections:` gap — conventions §0a). The text below is
> verbatim from conventions.md; every §-anchor it cites is a conventions.md anchor.

**Intake mode — `intake.mode: "autonomous" (default) | "passive"`.** Set per project, or as a
team-wide default (`team.intake`, seeded by `team init --intake-mode` / per project by
`team add-project --intake-mode`); a project overrides the team default **field-wise** (mode
and todoDepthCap resolve independently, nearest wins). The knob
governs **origination**, not the pipeline. `autonomous` is everything above **plus** PM's
proactive review (pm-agent Job C: strategy-doc direction, lens rotation, doc-watch,
unprompted `Feature`/`Improvement` filings). Under **`passive`** PM originates nothing:
no Job C, no doc-watch trigger, no unprompted filings — the ONLY source of new product
work is explicit intake directed at PM (§9a `needs-pm`). On `backend:"service"` the hub
daemon BACKSTOPS passive mode so an operator edit is never silently lost: a settled
non-agent edit to a hub doc, AND a settled edit to a repo-FILE `strategyDoc` (the default
config shape — a plain string or `{ "path": … }`; the daemon watches the file's content
hash, the path resolved once at boot by the §19 doc-home rule), each emit ONE deduped
comms line — the file line reads `operator edited <path> — PM is passive; file a needs-pm
ticket to act` — naming the slug/path only, never doc/file content (§16). The line is a
nudge, not intake: acting on it still requires an explicit §9a `needs-pm` ticket.
(Settings: `config-schema.md` "Hub daemon notifier settings"; mechanism: `docs/DAEMON.md`
"Background notifiers".) Responding to an explicit ask is
NOT origination: a direction/build intake still gets its full §9a treatment, including
scoped ideation on that ask (expanding the operator's request into concrete child
tickets). Everything else is IDENTICAL in both modes — Job A verification, Job B
unblocking, Job B2 grooming/promotion, and the other agents' discovery filings (QA bugs,
Architect tech-debt, ops incidents) still flow through the Backlog funnel; quiet *those*
with their own switches (project `enabled`/`weight`, `run --agents`), never via
intake.mode. A passive project may run without a `strategyDoc` — the doc becomes grooming
context, not a work trigger; when none is configured, a §9a direction ask's durable record
is the intake ticket itself (the closing comment carries the decision + the filed child
IDs — PM does not scaffold a doc unprompted). Backend-agnostic by construction: the
directed-ticket carrier is the same §9a label contract (`Backlog` +
`dev-loop`+`pm`+`needs-pm`) on linear and service alike.

**The board is the funnel; PM is the gate.** Every newly-discovered ticket — PM's own ideas,
QA bugs, Architect tech-debt, human intake (§9a) — is filed `state:"Backlog"`, NEVER `Todo`.
`Todo` is the *commitment* queue: what the team is actually going to build next, and only PM
puts work there (the verify-fail follow-up, the un-block re-queue, and a confirmed ops
incident are the sole carve-outs, §3). This kills the flood failure mode — a 30-finding
audit night deepens the Backlog instead of flooding Todo, and PM meters it in.

**PM's grooming & promotion pass (pm-agent Job B2), every fire:**
1. Query `project` + `dev-loop` + `state:"Backlog"`, EXCLUDING staged design children
   (tickets with a `Design:` pointer / relatedTo a non-Done design parent — the §21a gate
   owns those).
2. Groom: dedupe/merge (§8), `Cancel` stale or obsolete ideas (with a comment why), refine
   vague ones into §6-conformant tickets (real ACs, type, owner, tier per §21b, repo target).
3. Promote the top of the §5 pick order Backlog→Todo **only while** the Todo depth is below
   the cap: `count(state:"Todo", not blocked)` < `intake.todoDepthCap` (config, default
   **10**; per-tier counts in a split-dev project). Re-pass the full label set (§10).
4. At/over the cap → promote nothing this fire (grooming still happens). A drained Todo is
   refilled next PM fire — the loop's throughput, not the discovery rate, sets the pace.

An ordinary Backlog ticket awaiting promotion is **normal**, not stranded — Sweep's
stranded-child rule (§21a) applies only to design children whose parent is Done.
