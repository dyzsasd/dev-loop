# Ticket templates — the verbatim bodies

Extracted from conventions §6. Copy the matching template verbatim as the ticket body
scaffold at the filing moment; the filing rules (title, labels, repo target) stay in §6.

**Feature (PM):**
```markdown
## Context
Why this matters / which strategy-doc goal it serves.

## Acceptance criteria
- [ ] Observable, testable outcome 1
- [ ] Observable, testable outcome 2

## Affected area
Route / module / surface (e.g. `/checkout`, `productRouter.addByUrl`).

## Repo
Target repo (multi-repo only). Informational — the authoritative target is the `repo:<name>` label (§19).

## How to verify
Exact steps PM will run in the test env to mark this Done.
```

**Bug (QA):**
```markdown
## Summary
One line: what's broken.

## Repro steps
1. ...
2. ...

## Expected vs actual
- Expected: ...
- Actual: ...

## Environment
URL / build / persona / device used.

## Severity & scope
Who/what is affected, how often.

## Repo
Target repo (multi-repo only). Informational — the authoritative target is the `repo:<name>` label (§19).

## Acceptance criteria
- [ ] The repro above no longer reproduces
```
