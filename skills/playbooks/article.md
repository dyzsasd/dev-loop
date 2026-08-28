---
slug: CM-article
kind: judgment-scaffold
pulls: references/conventions/strategy-doc.md (§20a strategyDoc form detection — read at Step 1.1), references/conventions/team-digest.md (§22a digest contract — read at the team-scope digest step), references/config-schema.md (the communication config defaults)
---

# CM-article — draft the product article + the team daily digest (Communication's one job)

Communication's single job, the executable expansion of the `job:article` span. Per cadence you gather
public-safe, verifiable product facts and write ONE article DRAFT — and at team scope compose + push
the §22a daily director digest. The ANGLE and the PROSE are the judgment; this playbook fixes the
ENVELOPE (dedup/cadence, the source set, the output path, the hard safety lines) and FRAMES the "what
one thing is worth saying, from a real shipped fact" call. §21 Communication contract: **no external
publish** (no social/email/CMS/webhook API), no code/ticket mutations, **no invented facts** — thin
evidence means a narrower article, or a no-op with the missing facts listed.

## Hard rules (never violated)
- **Never publish externally** — the one outward push is `dev-loop notify` at team scope. Never commit,
  push, deploy, email, or post. Drafts are files left for operator review.
- **No PII / no secrets** (§16): treat drafts as public by default (they get copied outward). Never
  paste raw PII, secrets, private customer quotes, credentials, logs, or support-inbox text — summarize
  around sensitive material or omit it.
- **No unsourced claims** — every concrete claim traces to a listed source.

## Step 0 — cadence + duplicate check
Compute today's key with a shell call (`TODAY=$(date -u +%F)`), never by reasoning about the date
(`-u` matters — every artifact this key files against is stamped in UTC, §22). Resolve the intended
output file for TODAY; if it already exists and the user did not explicitly ask for a rewrite ⇒ no-op
and report the existing path (a daily agent never generates competing articles for one date). Output
paths (§21): `output:"data"` ⇒
`${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/communications/YYYY-MM-DD.md`; `output:"repo"` ⇒ the
doc-home repo under `repoOutputDir`, left for operator review. Retention (§22, D6): prune `data` drafts
past the 90-day tail at fire start; `repo` drafts are operator-reviewed — never delete, note an
over-retention tail in your report. In `dry-run`: print the title, outline, source list, and target
path — write nothing.

## Step 1 — gather source material (public-safe, verifiable only)
1. **Strategy / positioning:** read `strategyDoc` (detect its form ONCE per §20a — see
   `references/conventions/strategy-doc.md` for the per-form read verbs: `get_document` for a Linear
   document, `doc.get({kind})` incl. the `unpublished:true` latest-DRAFT case for a hub document, or a
   repo-file read); on `backend:"service"` with hub docs also the published `strategy` doc if available.
2. **Roadmap / direction:** the published `roadmap` doc when one exists; drafts stay internal unless
   the operator explicitly asks to use them.
3. **Recent shipped work:** `Done` tickets + events from the configured backend, bounded by
   `sourceWindowDays` — prefer owner-verified tickets / clear acceptance criteria; backend tools
   unavailable ⇒ fall back to `git log --since="<N days ago>" --oneline` + changelog entries.
4. **Public product surface:** if `testEnv.baseUrl` is set, inspect it lightly (homepage copy, a simple
   curl/browser read) — never log in with real user accounts unless the config clearly provides a safe
   demo account.
5. **Existing drafts:** read the last few from the output dir so today's article doesn't repeat
   yesterday's angle.
Not enough verified material ⇒ a short "no article drafted" report listing the missing inputs; never
fill the gap with generic claims.

## The judgment step — Step 2: choose ONE angle (framed, not scripted)
Pick ONE concrete angle: a shipped user benefit; a product workflow through a real use case; a
public-safe behind-the-scenes engineering/design decision; a practical lesson the product embodies; a
customer problem now handled better. *Avoid* broad launch hype with no shipped fact; claims like "best"
/ "industry-leading" / "secure" / "trusted" / "AI-powered" unless the sources support them; competitor
claims; unreleased roadmap promises unless `includeUnreleased:true` AND the article clearly frames them
as upcoming (§21).

## The judgment step — Step 3: draft the article (framed, not scripted)
Markdown with frontmatter (`date`, `project`, `audience`, `status: draft`, and `sources:` —
ticket/doc/commit/url references), then: a specific human title, a one-paragraph hook, body sections, a
"What this changes" section, and closing "Source notes" (short references, no secrets/PII). *Good looks
like* prose that sounds like a person on the team wrote it — specific product nouns from the
strategy/product, not generic SaaS filler; short paragraphs; concrete examples; natural and confident,
not salesy; matching `communication.language`; within `maxWords`. It is a DRAFT — no
"published"/"announced"/"sent" language unless it actually happened.

## Step 4 — write the draft
`mode:"live"`: create the output directory if needed and write to the resolved path; if the file
appeared between Step 0's check and the write, STOP and report the race — never overwrite; never commit,
push, deploy, publish, email, or post externally. `dry-run`: print the preview + path — no filesystem,
board, or hub writes. **Optional trace:** on `backend:"service"` you MAY add a short comment/event
through existing safe tools when the project already has a suitable communication topic/ticket — never
create tickets just to say an article was drafted; the filesystem draft + your report are the canonical
trace.

## Team scope — the daily digest (§27, §22a)
Under `DEVLOOP_TEAM_SCOPE=1` (cwd = workspace root) you speak for the whole team: compose the digest
across the enabled projects **per the §22a contract**. Read `references/conventions/team-digest.md` at
this step for the full contract — the five named sections, the ~25-line cap, and the exact
`dev-loop metrics --window 24h --json` and `dev-loop notify --title "Daily <team> <date>"` forms.
Numbers come from that `dev-loop metrics --window 24h --json` read or explicit board reads — never from
memory; where a digest line needs a board read metrics doesn't provide (the QA-quality Bug slices,
oldest In Review age, W5 trackers), query that project via the D1 steward `project` override (§18),
read-only. The outward push is `dev-loop notify` reading `team.comms` — the webhook URL lives in the env
var named by `webhookEnv`; you never see or handle the URL/secret (§16). Without `team.comms`, skip the
push and surface the missing channel in your report. The §22a digest keys on `team.comms` presence
alone — a missing per-project `communication` block never suppresses it.

## Exit criteria
Today's article drafted to the resolved path (or a coherent no-op with the missing inputs listed, or
the existing-draft no-op); at team scope the digest pushed (or the missing channel surfaced). `dry-run`
⇒ no writes — preview + path only.

## When blocked
Thin evidence ⇒ a narrower article or a listed-gaps no-op — never generic filler. Second-CLI identity
(§26): under Codex the launcher injects `DEVLOOP_ACTOR="communication"`; if `whoami` does not return
`communication`, fail closed before writing.
