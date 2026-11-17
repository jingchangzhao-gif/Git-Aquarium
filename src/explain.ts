// The Ecologist: explains recorded changes from recorded evidence. Pure functions: no DOM, network, or storage.
import { P, RULES, type EventKind, type GitEvent } from './sim.ts' // with the extension: the dev server's config also loads this file, outside the bundler
import { repositoryStats } from './repostats.ts'

// One reading of the aquarium, taken about once a simulated second.
export interface Sample {
  tick: number
  pop: number[] // living organisms per lineage
  energy: number // mean energy across the tank
  stress: number[] // per lineage: 0..1 of the maximum CI penalty
  tally: { born: number; founded: number; starved: number; aged: number }[] // cumulative, per lineage
}

export interface Context {
  repo: string
  source: 'synthetic' | 'recorded'
  branches: string[]
  events: GitEvent[] // only the events already replayed
  records?: GitEvent[] // every frozen event in the import window, for repository statistics
  samples: Sample[]
  notices: string[]
  focus: number | null // the lineage the user is filtering on, if any
}

export interface Claim { text: string; evidence: string[] } // evidence: keys of replayed events
export interface Answer {
  facts: Claim[] // imported records and recorded observations
  rules: Claim[] // mapping rules that actually ran
  interpretation: string
  uncertainty: string[]
}

export const WINDOW = 1200 // ticks an explanation looks back: one minute at 1x
export const key = (e: GitEvent) => `${e.kind}:${e.id}`

const total = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// What the rules alone can say, without a language model.
export function explain(question: string, c: Context): Answer {
  const now = c.samples[c.samples.length - 1]
  const caveats = [
    'The simulation does not record which rule fed or killed an individual. This links changes and events from the same period; it does not prove one caused the other.',
    c.source === 'synthetic'
      ? 'This dataset is fictional demo data, not a real repository.'
      : c.notices.length
        ? `The import reported ${plural(c.notices.length, 'data boundary', 'data boundaries')} (listed under Dataset); missing records could change this picture.`
        : 'Only the most recent records of this repository were imported.',
    'Population changes follow designed simulation rules. They say nothing about code quality or anyone\'s performance.',
  ]
  if (!now) return { facts: [], rules: [], interpretation: 'Nothing has been recorded yet. Let the replay run for a few seconds and ask again.', uncertainty: caveats }

  // Who is being asked about: a branch named in the question, else the filtered lineage, else everyone.
  const asked = question.toLowerCase()
  const named = c.branches.findIndex((b) => asked.includes(b.toLowerCase()))
  const lineage = named >= 0 ? named : c.focus
  const pick = <T>(perLineage: T[]) => (lineage === null ? perLineage : [perLineage[lineage]])
  const size = (s: Sample) => total(pick(s.pop))
  const who = lineage === null ? 'The population' : `Lineage ${c.branches[lineage]}`

  // The period: back to the reading that differs most from now, so a fall is measured from its peak.
  const recent = c.samples.filter((s) => s.tick >= now.tick - WINDOW)
  let then = recent[0]
  for (const s of recent) if (Math.abs(size(s) - size(now)) > Math.abs(size(then) - size(now))) then = s
  const count = (cause: 'born' | 'founded' | 'starved' | 'aged') => total(pick(now.tally).map((t) => t[cause])) - total(pick(then.tally).map((t) => t[cause]))
  const born = count('born')
  const starved = count('starved')
  const aged = count('aged')
  const founded = count('founded')
  const inside = recent.filter((s) => s.tick >= then.tick)
  const stress = (s: Sample) => total(pick(s.stress)) / pick(s.stress).length // its own penalty, or the average over lineages
  const peak = Math.max(...inside.map(stress))
  const worst = Math.max(...inside.flatMap((s) => pick(s.stress))) // the hardest-hit lineage in the period
  const percent = (level: number) => `${Math.round(100 * level)}%`

  // Events act on the lineage of their branch, so a question about one lineage only counts its own (and any on an unknown branch).
  const mine = c.events.filter((e) => lineage === null || e.lineage === lineage || e.lineage < 0)
  const during = mine.filter((e) => e.tick > then.tick && e.tick <= now.tick)
  const of = (kind: EventKind, events = during) => events.filter((e) => e.kind === kind)
  const before = mine.filter((e) => e.tick > then.tick - (now.tick - then.tick) && e.tick <= then.tick)
  // CI failures that were still unanswered at some point in the period, even if they happened before it.
  const failures = of('CI_FAILED', mine).filter((f) =>
    !mine.some((e) => e.kind === 'CI_PASSED' && e.group === f.group && e.tick >= f.tick && e.tick <= then.tick))
  const whose = lineage === null ? 'averaged over the lineages' : 'on this lineage'
  const fed = lineage === null ? '' : ' for this lineage'
  const date = (tick: number) => c.events.filter((e) => e.tick <= tick).pop()?.at.slice(0, 10)
  const dates = date(then.tick) && date(now.tick) ? ` (replay dates ${date(then.tick)} to ${date(now.tick)})` : ''

  const facts: Claim[] = [
    { text: `${who} went from ${size(then)} to ${size(now)} organisms between tick ${then.tick} and tick ${now.tick}${dates}.`, evidence: [] },
    { text: `In that time it recorded ${plural(born, 'birth')}, ${plural(starved, 'death')} from starvation, and ${aged} from old age.` + (founded ? ` ${plural(founded, 'founder')} also arrived when a branch with almost no organisms left became active again.` : ''), evidence: [] },
    { text: `Mean energy across the tank went from ${then.energy.toFixed(1)} to ${now.energy.toFixed(1)}.`, evidence: [] },
    {
      text: peak > 0
        ? `The CI penalty ${whose} was ${percent(stress(then))} of its maximum at the start, peaked at ${percent(peak)}, and is ${percent(stress(now))} now.`
        : `No CI penalty was active ${lineage === null ? '' : 'on this lineage '}in that time.`,
      evidence: peak > 0 ? failures.map(key) : [],
    },
    {
      text: `${plural(of('COMMIT_OBSERVED').length, 'commit')} and ${plural(of('PR_MERGED').length, 'merge')} were replayed${fed} in that time; the same length of time before it had ${plural(of('COMMIT_OBSERVED', before).length, 'commit')}.`,
      evidence: [...of('COMMIT_OBSERVED'), ...of('PR_MERGED')].map(key),
    },
  ]

  const ran = (kind: EventKind, events: GitEvent[]): Claim[] =>
    events.length ? [{ text: `${RULES[kind].id} ${RULES[kind].effect}: applied ${plural(events.length, 'time')}.`, evidence: events.map(key) }] : []
  const rules: Claim[] = [
    ...ran('COMMIT_OBSERVED', of('COMMIT_OBSERVED')), ...ran('PR_MERGED', of('PR_MERGED')), ...ran('PR_OPENED', of('PR_OPENED')),
    ...ran('CI_FAILED', peak > 0 ? failures : []), ...ran('CI_PASSED', of('CI_PASSED')),
    { text: 'R-BASELINE keeps a small food supply arriving at every tick, with or without Git activity.', evidence: [] },
  ]

  const change = size(now) - size(then)
  const commits = of('COMMIT_OBSERVED').length
  const earlier = of('COMMIT_OBSERVED', before).length
  const dead = starved + aged
  let interpretation: string
  if (Math.abs(change) < Math.max(3, 0.1 * size(then))) {
    interpretation = `${who} was roughly stable: ${plural(born, 'birth')} against ${plural(dead, 'death')}.`
  } else if (change < 0 && peak > 0) {
    interpretation = `The fall coincides with the CI penalty. While ${plural(new Set(failures.map((f) => f.group)).size, 'workflow-and-branch group')} had an unanswered failure, ${lineage === null ? 'the organisms of the affected lineages' : 'each of its organisms'} paid up to ${(worst * P.maxPenalty).toFixed(3)} extra energy per tick, and starvation accounts for ${starved} of the ${plural(dead, 'death')}.` +
      (commits < earlier ? ` Commits also slowed (${commits} against ${earlier} in the period before), so less food arrived${fed}.` : '')
  } else if (change < 0 && starved >= aged) {
    interpretation = `No CI penalty was active, and most deaths were starvation: ${plural(commits, 'commit')} added food in this period against ${earlier} before it, which did not feed a population of this size.`
  } else if (change < 0) {
    interpretation = `Most deaths were old age (${aged} of ${dead}) and births did not replace them, which is generational turnover rather than an effect of a repository event.`
  } else {
    const merges = of('PR_MERGED').length
    interpretation = (commits + merges
      ? `Growth followed the food supply: ${plural(commits, 'commit')} and ${plural(merges, 'merge')} added food, and births outnumbered deaths ${born} to ${dead}.`
      : `No commit or merge was replayed in this period, so the growth came from food already in the tank and the baseline supply: births outnumbered deaths ${born} to ${dead}.`) +
      (stress(then) > stress(now) ? ' Its CI penalty was also easing after a workflow passed, which lowered the energy cost.' : '')
  }
  return { facts, rules, interpretation, uncertainty: caveats }
}

// ---- Repository questions ----------------------------------------------------------------------

// The four questions decided in docs/ecologist-repository-answers.md, answered from the records.
export type RepoQuestion = 'week' | 'stuck' | 'workflow' | 'merge'

const REPO_WEEK = 7 * 86_400_000

// A question is a repository question only when it names one of the four subjects plainly;
// "Why did the population change?" stays with the simulation explanation.
export function repoQuestion(question: string): RepoQuestion | null {
  const q = question.toLowerCase()
  if (/\bstuck\b|\bblocked\b|\bwaiting on\b/.test(q)) return 'stuck'
  if (/\bflaky\b|\bworkflow\b|\bfailing\b/.test(q)) return 'workflow'
  if (/\btake to merge\b|merge.{0,40}(time|long|days)|(time|long|days).{0,40}merge/.test(q)) return 'merge'
  if (/what changed|this week|last week/.test(q)) return 'week'
  return null
}

export function repoAnswer(kind: RepoQuestion, c: Context): Answer {
  const records = c.records ?? c.events
  const stats = repositoryStats(records)
  const day = (iso: string) => iso.slice(0, 10)
  const caveats = [
    'These numbers describe the imported window only; older records were not imported.',
    c.source === 'synthetic' ? 'This dataset is fictional demo data, not a real repository.' : 'The window is a snapshot: records outside it are missing, not zero.',
    'The numbers count records; they are not a measurement of code quality.',
  ]
  const rules: Claim[] = [{
    text: 'Repository answers read the frozen import window and cite the records behind each number; the simulation rules do not take part.',
    evidence: [],
  }]
  if (!stats.from) {
    return { facts: [], rules, interpretation: 'No repository records are loaded yet. Import a repository or load the demo first.', uncertainty: caveats }
  }

  const window = records.filter((e) => Number.isFinite(Date.parse(e.at)))
  const refs = (list: GitEvent[]) => list.map(key)
  const between = (from: number, to: number) => window.filter((e) => { const t = Date.parse(e.at); return t > from && t <= to })
  const ci = (e: GitEvent) => e.kind === 'CI_FAILED' || e.kind === 'CI_PASSED'
  const move = (a: number, b: number) => (a === b ? `unchanged from ${b}` : `${a > b ? 'up' : 'down'} from ${b}`)
  const week = stats.week
  const since = Date.parse(week.from)
  const until = Date.parse(week.to)

  if (kind === 'week') {
    const recent = between(since, until)
    const facts: Claim[] = [
      { text: `The imported window ends on ${day(stats.to)}, so this week means ${day(week.from)} to ${day(week.to)}.`, evidence: [] },
      { text: `Commits: ${week.recent.commits}, ${move(week.recent.commits, week.previous.commits)} in the seven days before.`, evidence: refs(recent.filter((e) => e.kind === 'COMMIT_OBSERVED')) },
      { text: `Pull requests opened: ${week.recent.opened} (${week.previous.opened} before); merged: ${week.recent.merged} (${week.previous.merged} before).`, evidence: refs(recent.filter((e) => e.kind === 'PR_OPENED' || e.kind === 'PR_MERGED')) },
      { text: `CI recorded ${week.recent.failed} failures and ${week.recent.passed} passes (${week.previous.failed} failures and ${week.previous.passed} passes before).`, evidence: refs(recent.filter(ci)) },
    ]
    const busiest = week.recent.commits >= week.recent.merged && week.recent.commits >= week.recent.failed
      ? 'commits'
      : week.recent.merged >= week.recent.failed ? 'merges' : 'CI failures'
    return {
      facts,
      rules,
      interpretation: recent.length
        ? `Activity this week is ${move(week.recent.commits, week.previous.commits)} the week before; the strongest signal is ${busiest}.`
        : 'No record landed in the window\'s last seven days.',
      uncertainty: [...caveats, `"This week" is the last seven days of the window, ending ${day(stats.to)}, not today; for an old repository those are different weeks.`],
    }
  }

  if (kind === 'stuck') {
    const stuck = stats.stuck
    const facts: Claim[] = stuck.length
      ? stuck.slice(0, 8).map((p) => ({ text: `#${p.number} "${p.title}" on ${p.branch} opened ${day(p.opened)} and has been open ${p.days} days.`, evidence: [p.ref] }))
      : [{ text: 'Every pull request opened inside the window has a merge record inside it.', evidence: [] }]
    if (stuck.length > 8) facts.push({ text: `…and ${stuck.length - 8} more pull requests, ordered by age.`, evidence: stuck.slice(8).map((p) => p.ref) })
    return {
      facts,
      rules,
      interpretation: stuck.length
        ? `${stuck.length} of ${plural(stats.counts.opened, 'pull request')} opened in the window ${stuck.length === 1 ? 'has' : 'have'} no merge record inside it; the oldest has been open ${stuck[0].days} days.`
        : 'No pull request opened inside the window is still without a merge record.',
      uncertainty: [...caveats, 'A pull request that merged before the window opened looks stuck here: its merge record is missing, not absent from history.'],
    }
  }

  if (kind === 'workflow') {
    const groups = stats.workflows
    const flaky = stats.flaky
    const facts: Claim[] = groups.slice(0, 5).map((g) => ({
      text: `${g.name} on ${g.branch}: ${g.failed} failures, ${g.passed} passes (${Math.round(g.rate * 100)}% of runs failed).`,
      evidence: [...g.refs, ...refs(window.filter((e) => e.kind === 'CI_PASSED' && e.group === g.group).slice(-6))],
    }))
    if (flaky.length) {
      facts.push({ text: `Flaky groups: ${flaky.map((g) => `${g.name} on ${g.branch} ${plural(g.times, 'time')}`).join('; ')}.`, evidence: flaky.flatMap((g) => g.refs) })
    } else {
      facts.push({ text: 'No workflow failed and later passed with no commit on its branch in between.', evidence: [] })
    }
    if (!groups.length) facts.unshift({ text: 'No supported GitHub Actions result is in the window.', evidence: [] })
    return {
      facts,
      rules,
      interpretation: groups.length
        ? `${groups[0].name} on ${groups[0].branch} fails most often (${groups[0].failed} of ${groups[0].failed + groups[0].passed} runs).` +
          (flaky.length ? ` ${plural(flaky.length, 'group')} ${flaky.length === 1 ? 'looks' : 'look'} flaky rather than broken: ${flaky.length === 1 ? 'it passes' : 'they pass'} again without a new commit.` : ' No group failed and then passed without a commit, so the failures look tied to the code rather than the runner.')
        : 'The window has no CI failures to rank.',
      uncertainty: [...caveats, 'Flaky here means one failure followed by a pass with no commit on that branch between them: evidence of instability, not proof.'],
    }
  }

  const m = stats.merges
  const mergeRefs = refs(window.filter((e) => e.kind === 'PR_MERGED'))
  const facts: Claim[] = [
    { text: `${m.merged} pull requests have both an open and a merge record inside the window; ${m.unpaired} merges had no open record.`, evidence: mergeRefs },
    { text: m.median === null ? 'No pull request has both records inside the window.' : `Median time to merge: ${m.median} days.`, evidence: [] },
  ]
  if (m.early !== null && m.late !== null) facts.push({ text: `The earlier half of merged pull requests took ${m.early} days; the later half took ${m.late} days.`, evidence: [] })
  const trend = m.early === null || m.late === null
    ? ''
    : m.late > m.early * 1.2 ? ' Merges are getting slower.'
      : m.late < m.early * 0.8 ? ' Merges are getting faster.' : ' Merge time is steady.'
  return {
    facts,
    rules,
    interpretation: m.median === null ? 'The window has no paired pull request to measure.' : `A merged pull request takes about ${m.median} days here.${trend}`,
    uncertainty: [...caveats, 'Pull requests opened before the window are counted as unpaired merges and left out of the median.'],
  }
}

// ---- Language model support ---------------------------------------------------------------------

// The bounded, structured summary a model is given: observations and event records, never source code.
export function summarize(question: string, c: Context) {
  const base = explain(question, c)
  return {
    question: question.slice(0, 200),
    repository: { name: c.repo, source: c.source, branches: c.branches, dataBoundaries: c.notices.slice(0, 5) },
    observations: base.facts.map((f) => f.text),
    rules: Object.values(RULES).map((r) => `${r.id} ${r.effect}`),
    events: c.events.slice(-40).map((e) => ({ ref: key(e), tick: e.tick, date: e.at.slice(0, 10), title: e.title.slice(0, 80), branches: e.branches })),
  }
}

// A model's reply is untrusted: accept it only in exactly the expected shape.
export function parseAnswer(value: unknown): Answer | null {
  const v = value as Answer
  const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length < 2000
  const claims = (x: unknown): x is Claim[] =>
    Array.isArray(x) && x.length <= 12 && x.every((c) => c && text(c.text) && Array.isArray(c.evidence) && c.evidence.every(text))
  if (!v || !claims(v.facts) || !claims(v.rules) || !text(v.interpretation) || !Array.isArray(v.uncertainty) || !v.uncertainty.every(text)) return null
  return { facts: v.facts, rules: v.rules, interpretation: v.interpretation, uncertainty: v.uncertainty.slice(0, 8) }
}

// References that are not among the given records. A model answer with any of these is rejected.
export function unknownEvidence(a: Answer, refs: Iterable<string>): string[] {
  const known = new Set(refs)
  return [...a.facts, ...a.rules].flatMap((c) => c.evidence).filter((ref) => !known.has(ref))
}
