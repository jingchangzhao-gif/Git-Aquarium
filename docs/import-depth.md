# How deep an import goes

Status: accepted for the next cut. Issue #8. No server and no stored credentials: everything here runs
in the tab.

## Problem

One page of 100 records per source, clipped to the period all sources cover, makes an active
repository nearly unreadable: importing `vitejs/vite` brought 76 workflow runs and exactly one commit,
because the most recent 100 runs span a few hours. The unauthenticated limit of 60 requests an hour
also caps imports at roughly fifteen an hour behind one address.

## Decisions

1. **A period, not a record count.** The import reads a window of 30, 90, or 365 days, ending at import
   time. Each source is read newest first until it passes the window start or the request budget is
   spent, whichever comes first. Pagination is per source and per branch.

2. **A visible request budget.** Every import has a budget, default 40 requests. The counter is shown
   before and after the import, and a notice states which limit stopped pagination: the period or the
   budget.

3. **Per-branch commits, still inside the budget.** Each lineage branch gets its own commit pages, read
   default branch first so shared history is credited once and other branches keep only their own
   commits. When the budget ends part-way through the branches, the notice names how many branches got
   fewer pages.

4. **Optional token, memory only.** A token raises the ceiling (5,000 requests an hour on a fine-grained
   read-only token) and is typed into the page. It lives in that tab's memory, is never written to
   storage or a URL, and is sent only to `api.github.com` as an `Authorization` header. A token pasted
   into a page is visible to any script running in that page; the interface says so next to the field.
   Without a token everything works as before.

5. **Save and reopen frozen datasets.** The dataset a replay uses can be downloaded as one JSON file
   and reopened without network access. The file carries a format id and a version, so an older or
   foreign file is rejected with a clear message instead of a half-loaded tank. A saved dataset makes
   "same seed + same dataset -> same state" checkable by someone else.

6. **No GraphQL in this cut.** One request for pull requests, reviews, and checks is attractive, but it
   needs a token on every import and a second response shape. It is a follow-up, not a prerequisite.

## Budget arithmetic

A 40-request import spends at most:

| Source | Requests |
| --- | --- |
| Repository metadata | 1 |
| Branches (one page) | 1 |
| Pull requests | pages until the window start |
| Workflow runs | pages until the window start |
| Commits, per lineage branch | pages until the window start, in lineage order |

The first two are always paid; the rest stop when the budget is gone. The page reports
`X of Y requests used` and keeps the previous dataset loaded when an import fails.

## Boundaries stated in the app

- The window is a period ending at import time, not the repository's whole history. A record older than
  the window is missing, not zero.
- Pagination stops at the budget, so a busy repository may still get less than the chosen period; the
  notice says so.
- A token raises the request ceiling, not the number of records GitHub keeps or the shape of the API.
- A saved dataset replays exactly what it contains, whatever the repository does afterwards.
- Statistics in the Ecologist describe the window that was imported; a longer import makes them wider,
  not exact.

## Not in this cut

- GraphQL.
- Server-side proxying of a token (there is no server in a static build).
- Publishing or sharing datasets through the app itself; the file can already be chosen by any file
  host, which is the point of a frozen dataset.
- Automatic re-import or live updates.

## Acceptance

- Importing a busy repository with a 90-day window fetches more than one page per source when the
  budget allows, and says what it cut off.
- A token is never written outside the tab's memory; the request counter and rate limit are visible.
- A saved dataset reopens byte-for-byte into the same replay state at the same tick.
- Without a token, a failure is reported without discarding the dataset already loaded.
