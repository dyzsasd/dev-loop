# Report roll-ups — weekly/monthly mechanics

Extracted from conventions §22. Read at the moment a roll-up is DUE (a new ISO week or a
new month per the §22 markers) — the due-check itself stays resident in §22.

At run-start, after computing the markers — and **after** finalizing any just-completed
daily (so the last day's summary header exists before a parent reads it):
- **Weekly** — due iff `weekly/$PREV_WEEK.md` is ABSENT: write it for **`$PREV_WEEK`, the
  just-completed week**, by rolling up **that week's** daily summary headers.
- **Monthly** — due iff `monthly/$PREV_MONTH.md` is ABSENT: write it for **`$PREV_MONTH`, the
  just-completed month**, by rolling up **that month's** daily summary headers — from dailies,
  not weeklies.
  Both periods are the COMPLETED ones, never `$WEEK`/`$MONTH`: writing the current period's file
  mid-period makes the file exist, which silences the check for the rest of that period and
  freezes a partial roll-up into the forever tier. Derive them with
  `date -u -d 'last week'` / `'last month'` (GNU) or `date -u -v-1w` / `-v-1m` (BSD) — never by
  reasoning about the date, for the same ISO-boundary reason `-u` and `%G-W%V` are mandated
  (`2026-12-31` is `2027-W01`). (ISO weeks do **not**
  partition calendar months — `2026-W27` straddles June/July — so a weekly→monthly roll-up
  would be lossy or double-count. Dailies *do* partition months cleanly.) Weeklies remain a
  parallel ISO artifact.

Because **both** roll-ups read the dailies (which survive idle gaps as files / "idle"
notes), a missing intermediate period can never blank a parent. **Catch-up across many
elapsed periods:** roll up only the just-completed period(s) and note any idle span inside
(`idle — no activity`); do **not** backfill one stub file per skipped period, and **never
fabricate** activity. The new file *is* the new marker — write it **atomically** (temp in
the same dir + rename, §11) so an interrupted roll-up never leaves a half-written report or
a phantom marker. **Retention (D6):** at roll-up, prune the tail — keep ≈ **90 days of dailies**,
**52 weeks of weeklies**, and **monthlies forever**; communications article drafts follow the
same **90-day** tail (the communication agent prunes its own output dir at fire start). A
parent's summary already preserves a pruned daily.
