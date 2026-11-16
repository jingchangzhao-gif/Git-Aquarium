# Pull request view: decisions

Issue #6 asks for a view where every organism is one real thing, starting with open pull requests, and a maintainer can read four numbers in ten seconds: how many are open, how many are stale, how many are failing, and who is waiting for review.

The Projects view already maps one repository to one body. This document adds a second layer inside it rather than a fourth top-level mode.

## D1. One layer deeper, not a new tab

`Projects` stays the top level: one repository, one body. Clicking a repository body opens its **open pull requests** as a school of smaller fish in the same tank. A `Back to projects` button returns to the repository school.

Why: the repository view answers "what does this project look like"; the pull request view answers "what needs a human now". Both readings belong to the same tank, and the drill-down keeps the tab bar, the input, and the data boundaries in one place. A separate top-level mode would duplicate the load path.

## D2. Open pull requests only, ten drawn

The view reads `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`.

- The total comes from the `Link` header (`rel="last"`) when present, otherwise from the list length; it is a lower bound and the panel says so.
- At most **8** pull requests are drawn and enriched. Each one needs three more requests (the detail for lines changed, reviews, and check runs), so one repository costs `1 + 3 × 8 = 25` GitHub requests. Unauthenticated GitHub allows 60 an hour, so this layer is only opened on demand.
- Merged and closed pull requests are not drawn. The panel links to the repository's `pulls` page for those.

## D3. Every visible property is a measurement

| What you see | What it is |
| --- | --- |
| One small fish | One open pull request |
| Body size | `additions + deletions`, log scale, clamped at 2,000 lines |
| Colour | Check state: green all successful, red any failure or timeout, amber in progress or queued, slate no check runs |
| Pale and slow | No update for 7 days (stale) |
| Pale label under the fish | `#number` plus the title, so a screenshot stays readable |

There is no designed rule between the repository and the fish: every property above is read from the GitHub response.

## D4. Review state, from fields already returned

- `requested_reviewers` non-empty → `requested` (someone is waiting).
- Otherwise the latest review among the enriched pull requests: `approved` if the last decisive review is `APPROVED`, `changes` if it is `CHANGES_REQUESTED`, `none` if there is no review.

The panel names the state in words and links to the pull request.

## D5. The ten-second line

The readout under the tank switches to:

`18 open · 12 stale · 3 failing · 5 waiting for review`

- open: total open pull requests in the repository (lower bound from page count).
- stale / failing / waiting: counts over the drawn eight, and the line says `of 8` when the drawn set is smaller than the total.

## D6. Data boundaries stay visible

The drill-down reuses the Projects notice list and adds:

- `Only the 10 most recently updated open pull requests were inspected; counts cover those.`
- `Check runs and reviews were unavailable for N pull requests; they show as unknown, not passing.`

An empty repository shows `No open pull requests.` inside the tank area, with the panel still readable.

## Stages

- Q0 (this document): the decisions above.
- Q1: `src/pulls.ts`, the data layer and its tests.
- Q2: `src/prfish.ts` and a body-draw seam in `src/tank.ts`, so the same cache draws repositories and pull requests.
- Q3: the drill-down wiring, readout, panel, and back button in `src/main.ts`, `index.html`, and `src/style.css`.

Each stage ships as a stacked pull request; nothing merges into `main` from this chain until reviewed.
