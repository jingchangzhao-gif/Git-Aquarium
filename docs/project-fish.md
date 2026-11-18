# Project fish: one repository, one body

The Projects view is a second reading of the tank. A repository becomes one animal; its visible properties stand for
things that were measured, never for guesses. This note fixes the decisions before the code that depends on them.

## The decisions

| # | Question | Decision | Why it matters |
| --- | --- | --- | --- |
| D1 | Replace the ecosystem or add a mode? | A **second mode**, with the ecosystem replay kept as `Ecosystem` | The new view is a snapshot of a repository; the old one is a deterministic replay. They cannot share a data contract |
| D2 | Which pull requests count? | **All observed PRs**: merged, open, and closed; the latest 100 fetched, the total from the pagination header (rounded up to a whole page) | The history is what a skeleton should show. Open-only would make a dead project look boneless |
| D3 | What is a "question"? | **All issues** as scales; **open issues** as missing scales; the `question` label gets a distinct colour | The label is optional and many repositories never use it; counting it alone would leave most bodies bare |
| D4 | What counts as "no longer maintained"? | `archived` → a rock; `pushed_at` older than **365 days** → seaweed; older than **90 days** → a quiet fish | It is a product decision shown as fact, so the panel always prints the last push date beside it |
| D5 | How many per tank? | **8 by default, 12 maximum**, editable | 8 × 3 requests = 24, so two loads fit inside GitHub's unauthenticated 60 an hour. One search request per project (ten a minute) gives the exact issue count |
| D6 | How big is a body? | `size = 0.55 + 0.8 × log2(1 + prs) / 15`, capped at 32,767 PRs; the rib count also grows with the total, `4 × log2(1 + prs)`, at most 60 | Keeps a 10,000-PR project from filling the tank. The first cap, 256, made every established project the same size, so the scale runs to 32,767; the range was widened from 0.65–1.2 because a 300-PR and a 12,000-PR fish looked alike |
| D7 | Can a rib be clicked? | **Not in v1.** The panel lists the five most recent PRs instead | Per-rib picking needs per-rib geometry ids; the panel gives the same information for less work |

## The mapping

| Repository record | Body part |
| --- | --- |
| Description (or repository name) | Spine, the theme every rib hangs from |
| Pull request count | Body length and height, and the number of ribs (4 per doubling, at most 60) |
| One of the latest pull requests | One rib: bone-coloured when merged, amber when open, slate when closed unmerged |
| Share of the latest issues closed | Share of the 24 scales a side left whole; the rest are dark gaps, gold for closed `question` issues |
| Pull requests and issues opened in the last 90 days | Swim speed |
| No push for 90 days | Grey, dull skin |
| Creation date, last push, 90-day activity, unanswered issues | The panel's health card only |

## Data boundaries that must stay visible

- Each project costs three unauthenticated requests (repository, latest 100 pull requests, latest 100 issues).
- `open_issues_count` counts issues **and** pull requests; it is never printed as an issue count.
- The issues endpoint returns pull requests too; items carrying `pull_request` are filtered out.
- The pull request total comes from the `Link: <...>; rel="last"` page number, so it is rounded up to a whole page and shown as "about"; without that header the list length is exact.
- The issues list has no last page (it is paged by cursor), so the exact issue count comes from one search request per project. When search refuses, the total is shown as "up to": the highest issue number less the pull requests, which also counts discussions.
- Every body is labelled with its repository's name, so a rock or seaweed cannot be mistaken for scenery.
- The mapping from a repository to a living thing is a design choice, not a measurement of the code.

## Acceptance for the phases that follow

- **P1** — data layer: lifecycle boundaries, PR/issue filtering, totals from the Link header, one failing repository
  does not break the rest, rate-limit error path.
- **P2** — one body, fake data: spine, ribs, and scales read as planned; 0, 1, and 100 ribs and scales stay
  distinguishable at tank distance; at most five draw calls per body.
- **P3** — one body, real data: size, rib count, and scale completeness match the panel; clicking shows the correct
  title, dates, and links; unknown size is labelled, never guessed.
- **P4** — a tank: eight repositories load in at most 24 requests; the readout matches the panels; bodies avoid
  overlap; labels stay readable at 1440×1000 and at 430 px.
- **P5** — abandoned states: an archived repository becomes a rock, a year-stale one becomes seaweed, a 90-day-stale
  one stays a dim fish; all remain clickable with the correct last push date.
