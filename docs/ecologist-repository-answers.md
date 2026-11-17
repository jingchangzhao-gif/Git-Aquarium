# The Ecologist answers about the repository

Status: accepted for the first cut. No model, no network: the answers are computed from the records
already frozen for replay.

## Problem

The Ecologist explains why simulated fish died. The deaths follow rules this project wrote, so the
answer mostly restates the rule. That explains our own mechanism, not the repository. The useful part
is the discipline: four separate sections, every statement tied to cited records, and answers that
cite records which do not exist are rejected.

## The four questions and the statistic behind each

All four read the same frozen `GitEvent[]` the replay uses. Every number carries `kind:id` references
to the records it came from.

1. **What changed this week?**
   Counts of commits, pull requests opened, pull requests merged, CI failures, and CI passes in the
   last seven days of the imported window, against the seven days before it.

2. **Which pull requests are stuck, and on what?**
   Pull requests opened inside the window with no merge inside it. The answer lists them with their
   age in days, branch, and a link when GitHub supplied one. It reports how long they have been open,
   not why: the import does not record reviews, labels, or check state for pulls in this mode.

3. **Which workflow fails most? Is it flaky?**
   CI runs are grouped by `workflow@branch`. For each group the answer gives failures, passes, and the
   failure rate. Flaky means the same group failed and later passed **with no commit on that branch
   between the two runs**; the answer names the groups where that happened.

4. **How long does a pull request take to merge?**
   Open and merge records are paired by pull request number. The answer gives the median time to
   merge in days, and the median of the first half of the merged pull requests against the second
   half, so a worsening trend is visible instead of asserted.

## Evidence rule

Every statistic lists the records it used, keyed `kind:id` (commit SHA, pull request number, workflow
run id). The rule-based answer and any model answer are held to the same rule: a claim citing a
record that was not imported is rejected (`unknownEvidence`).

## Boundaries

- **Window only.** The import keeps one page per source; statistics describe that window, not the
  project's history. Deeper import is a separate issue (#8).
- **"Stuck" is a window artefact.** A pull request that merged before the window opens looks stuck.
  The answer says this in its uncertainty section.
- **"This week" means the last seven days of the window**, relative to the newest record, not today.
  For a replayed repository those can be months apart.
- **Flaky is narrow.** One failure followed by one pass with no commit in between. A workflow that
  only ever fails is not flaky; a pass on a different branch does not count.
- **No simulation content.** These answers contain no fish, no populations, and no rules. The
  simulation explanations remain available for the other questions.

## Not in this cut

- A real model call: the endpoint and key live only as a dev-server option, and the model path has
  never run against the real API (issue #7, "Also needed").
- Review and check state per pull request in this mode; that is the Projects drill-down (issue #6).
- Deeper import (#8).

## Acceptance

- The four questions work with no model configured and cite records for every number.
- Each statistic is a pure function over `GitEvent[]` and a clock, covered by unit tests.
- Asking a simulation question keeps the existing behaviour unchanged.
