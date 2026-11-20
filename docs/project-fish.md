# Project fish: one repository, one body

The Projects view is a second reading of the tank. A repository becomes one animal; its visible properties stand for
things that were measured, never for guesses. This note fixes the anatomy decisions before the code that depends on
them. Issue #39 replaced the old reading (ribs = pull requests, scales = share of issues closed).

## The decisions

| # | Question | Decision | Why it matters |
| --- | --- | --- | --- |
| D1 | Replace the ecosystem or add a mode? | A **second mode**, with the ecosystem replay kept as `Ecosystem` | The snapshot and the replay cannot share a data contract |
| D2 | How much history is read? | The latest 100 pull requests and 100 issues per repository; the pull request total from the pagination header (rounded up to a whole page) | The history is what the body should show; a busy repository must not be described by one page |
| D3 | What is a "feature"? | A `feature:<slug>` label. No feature label → one **General** bone. Two or more feature labels on one issue → **General**, marked as a conflict. Never inferred from folder names or README prose | GitHub has no feature record. A label is the only explicit one, and an invented feature would be a guess shown as fact |
| D4 | When is a project no longer maintained? | `archived` → a rock; `pushed_at` older than **365 days** → seaweed; older than **180 days** → seaweed; older than **90 days** → a slowing fish; no push date → unknown; **finished** is a topic the owner sets, never inferred | The panel always prints the last push date beside the stage |
| D5 | How many per tank? | **8 by default, 12 maximum**, editable | The account path costs five `gh` requests per project; a typed tank still uses unauthenticated requests |
| D6 | How big is a body? | `size = 0.55 + 0.8 × log2(1 + prs) / 15`, capped at 32,767 pull requests. The pull request total sets length only; **features set the bones** | Keeps a 10,000-PR project from filling the tank without turning the skeleton into a busy score |
| D7 | Can a bone be clicked? | **Not yet.** The panel lists features, open issues, resolved issues, and linked pull requests, each with its GitHub link. Every mesh carries a stable part id for #40's picking | #40 owns the zoom, rotate, and ray-picked scale; #39 delivers the identity to pick |
| D8 | How much fits in the overview? | At most **6 feature bones** (the rest share one Other bone), at most **2 open-issue small bones per feature**; the panel lists everything past the limits | Busy projects have thousands of issues; the overview must stay readable, not silently hide them |
| D9 | What does a finished fish look like? | One spine, its feature bones, one even scale colour, no open-issue bones or links; past issues and pull requests stay in the panel. A finished seaweed or rock keeps the form its owner chose | Finished means the work is declared done; the history is still readable |

## The mapping

| Repository record | Body part |
| --- | --- |
| Description (or repository name) | Spine, the theme every bone hangs from |
| A `feature:<slug>` label | A big bone branching from the spine, in a stable slug order; `Other` when more than six features exist |
| An issue carrying that label (or none / several) | A small bone on the feature's bone; none or several land on General |
| The number of open issues on a feature | The tint and roughness of that feature's scale band; zero returns it to the base colour |
| A merged pull request that GitHub reports as closing an issue | A thin link between that issue's small bone and the feature's big bone |
| Pull request total | Body length and height only |
| Pull requests and issues opened in the last 90 days | Swim speed |
| No push for 90 days | Grey, dull skin |
| Creation date, last push, 90-day activity | The panel's update row only |

## Data boundaries that must stay visible

- The account tank reads five requests per project through the local GitHub CLI: repository lists, issues, search
  count, labels, and one GraphQL call for merged pull requests with their **closing issue references**. The token
  stays in the server process and never reaches the page, a URL, storage, or a log.
- Closing references are GitHub's own (`closingIssuesReferences`), not parsed from a pull request description, so a
  hand-closed issue has no link drawn.
- Only the latest 100 issues and the latest 100 merged pull requests are related; older links are not guessed. A
  pull request that closed nothing appears in the history list only.
- Features come from labels named `feature:<slug>`; the page never writes, creates, or edits labels.
- An issue with no feature label, two feature labels, or a feature past the six-bone limit is shown on General or
  Other and counted in the panel. Nothing is duplicated onto two bones.
- `open_issues_count` counts issues **and** pull requests; it is never printed as an issue count. The issues endpoint
  also returns pull requests, which are filtered out.
- The mapping from a repository to a living thing is a design choice, not a measurement of the code.

## Acceptance for the phases that follow

- **#39 (this stage)** — feature parsing, General fallback, conflict handling, stable ids, closing-reference links,
  overview limits, finished-fish simplification, and the panel lists all have unit coverage; a manual pass checks
  that both flanks carry the same feature/issue/scale ids and that the links reach the correct bone.
- **#40 (next)** — zoom, rotate, ray picking on scales, and mirrored selection: the part ids from #39 are the
  contract, and clicking either flank must open the same issue or feature.
