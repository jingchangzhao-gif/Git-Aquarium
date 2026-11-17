// Pure statistics over the frozen replay records. No DOM, network, storage, or model:
// the same `GitEvent[]` the tank replays, plus the newest record as "now".
import type { GitEvent } from './sim.ts' // with the extension: the dev server's config also loads this file, outside the bundler

const DAY = 86_400_000
const WEEK = 7 * DAY

export interface Counts {
  commits: number
  opened: number
  merged: number
  failed: number
  passed: number
}

export interface WeekChange {
  recent: Counts // the last seven days of the window
  previous: Counts // the seven days before that
  from: string // ISO, start of the recent week
  to: string // ISO, newest record
}

export interface StuckPull {
  number: string
  title: string
  url: string | null
  branch: string
  opened: string // ISO
  days: number
  ref: string // PR_OPENED:id
}

export interface WorkflowGroup {
  group: string // workflow@branch
  name: string
  branch: string
  failed: number
  passed: number
  rate: number // failures / (failures + passes), 0 when nothing ran
  lastFailure: string | null // ISO
  refs: string[] // failing run refs, newest first, at most 20
}

export interface FlakyGroup {
  group: string
  name: string
  branch: string
  times: number // failures that passed later with no commit on that branch in between
  refs: string[] // the failure and subsequent pass refs
}

export interface MergeTime {
  merged: number // pull requests with both records inside the window
  unpaired: number // merge records with no open record (opened before the window)
  median: number | null // days
  early: number | null // days, first half by open time
  late: number | null // days, second half by open time
}

export interface RepositoryStats {
  from: string // ISO of the oldest record, '' when there are none
  to: string // ISO of the newest record
  counts: Counts // the whole window
  week: WeekChange
  stuck: StuckPull[]
  workflows: WorkflowGroup[]
  flaky: FlakyGroup[]
  merges: MergeTime
}

const at = (e: GitEvent) => Date.parse(e.at)
const ref = (e: GitEvent) => `${e.kind}:${e.id}`
const iso = (ms: number) => new Date(ms).toISOString()
const days = (ms: number) => Math.round((ms / DAY) * 10) / 10

// A record with no usable date cannot be placed on a timeline, so it is left out of every statistic.
const dated = (events: GitEvent[]) => events.filter((e) => Number.isFinite(at(e))).sort((a, b) => at(a) - at(b))

function counts(list: GitEvent[]): Counts {
  return {
    commits: list.filter((e) => e.kind === 'COMMIT_OBSERVED').length,
    opened: list.filter((e) => e.kind === 'PR_OPENED').length,
    merged: list.filter((e) => e.kind === 'PR_MERGED').length,
    failed: list.filter((e) => e.kind === 'CI_FAILED').length,
    passed: list.filter((e) => e.kind === 'CI_PASSED').length,
  }
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// The workflow name is the run title without its conclusion, e.g. "ci: failure" -> "ci".
function nameOf(e: GitEvent): string {
  const colon = e.title.lastIndexOf(': ')
  return (colon > 0 ? e.title.slice(0, colon) : e.title) || e.group.split('@')[0]
}

function branchOf(e: GitEvent): string {
  return e.branches[0] ?? (e.group.includes('@') ? e.group.slice(e.group.indexOf('@') + 1) : '')
}

function weekOf(events: GitEvent[], to: number): WeekChange {
  const within = (start: number, end: number) => events.filter((e) => at(e) > start && at(e) <= end)
  return {
    recent: counts(within(to - WEEK, to)),
    previous: counts(within(to - 2 * WEEK, to - WEEK)),
    from: iso(to - WEEK),
    to: iso(to),
  }
}

function stuckOf(events: GitEvent[], to: number): StuckPull[] {
  const merged = new Set(events.filter((e) => e.kind === 'PR_MERGED').map((e) => e.id))
  return events
    .filter((e) => e.kind === 'PR_OPENED' && !merged.has(e.id))
    .map((e) => ({
      number: e.id,
      title: e.title,
      url: e.url,
      branch: branchOf(e),
      opened: iso(at(e)),
      days: days(to - at(e)),
      ref: ref(e),
    }))
    .sort((a, b) => b.days - a.days)
}

function workflowsOf(events: GitEvent[]): WorkflowGroup[] {
  const by = new Map<string, WorkflowGroup>()
  for (const e of events) {
    if (e.kind !== 'CI_FAILED' && e.kind !== 'CI_PASSED') continue
    const key = e.group || nameOf(e)
    let group = by.get(key)
    if (!group) {
      group = { group: key, name: nameOf(e), branch: branchOf(e), failed: 0, passed: 0, rate: 0, lastFailure: null, refs: [] }
      by.set(key, group)
    }
    if (e.kind === 'CI_FAILED') {
      group.failed++
      group.lastFailure = iso(at(e))
      if (group.refs.length < 20) group.refs.unshift(ref(e))
    } else {
      group.passed++
    }
  }
  for (const group of by.values()) group.rate = group.failed / (group.failed + group.passed)
  return [...by.values()].sort((a, b) => b.failed - a.failed || b.rate - a.rate)
}

// Flaky: a failure in one workflow-and-branch group, then a pass, with no commit on that branch
// between the two runs. A workflow that only ever fails is not flaky.
function flakyOf(events: GitEvent[]): FlakyGroup[] {
  const by = new Map<string, FlakyGroup>()
  const commitsOn: Record<string, number[]> = {}
  for (const e of events) {
    if (e.kind !== 'COMMIT_OBSERVED') continue
    const branch = branchOf(e)
    ;(commitsOn[branch] ??= []).push(at(e))
  }
  const pending = new Map<string, GitEvent>()
  for (const e of events) {
    if (e.kind === 'CI_FAILED') {
      pending.set(e.group || nameOf(e), e)
      continue
    }
    if (e.kind !== 'CI_PASSED') continue
    const key = e.group || nameOf(e)
    const fail = pending.get(key)
    if (!fail) continue
    pending.delete(key)
    const branch = branchOf(fail)
    const between = (commitsOn[branch] ?? []).some((t) => t > at(fail) && t < at(e))
    if (between) continue
    let group = by.get(key)
    if (!group) {
      group = { group: key, name: nameOf(fail), branch, times: 0, refs: [] }
      by.set(key, group)
    }
    group.times++
    group.refs.push(ref(fail), ref(e))
  }
  return [...by.values()].sort((a, b) => b.times - a.times)
}

function mergesOf(events: GitEvent[]): MergeTime {
  const opens = new Map<string, GitEvent>()
  const pairs: { days: number; opened: number }[] = []
  let unpaired = 0
  for (const e of events) {
    if (e.kind === 'PR_OPENED') opens.set(e.id, e)
    if (e.kind !== 'PR_MERGED') continue
    const open = opens.get(e.id)
    if (!open) {
      unpaired++
      continue
    }
    pairs.push({ days: days(at(e) - at(open)), opened: at(open) })
  }
  pairs.sort((a, b) => a.opened - b.opened)
  const half = Math.ceil(pairs.length / 2)
  const values = pairs.map((p) => p.days)
  return {
    merged: pairs.length,
    unpaired,
    median: median(values),
    early: median(values.slice(0, half)),
    late: median(values.slice(half)),
  }
}

// Everything the repository questions need, in one pass over the records the replay already holds.
export function repositoryStats(events: GitEvent[]): RepositoryStats {
  const list = dated(events)
  if (!list.length) {
    return {
      from: '',
      to: '',
      counts: { commits: 0, opened: 0, merged: 0, failed: 0, passed: 0 },
      week: { recent: { commits: 0, opened: 0, merged: 0, failed: 0, passed: 0 }, previous: { commits: 0, opened: 0, merged: 0, failed: 0, passed: 0 }, from: '', to: '' },
      stuck: [],
      workflows: [],
      flaky: [],
      merges: { merged: 0, unpaired: 0, median: null, early: null, late: null },
    }
  }
  const to = at(list[list.length - 1])
  return {
    from: iso(at(list[0])),
    to: iso(to),
    counts: counts(list),
    week: weekOf(list, to),
    stuck: stuckOf(list, to),
    workflows: workflowsOf(list),
    flaky: flakyOf(list),
    merges: mergesOf(list),
  }
}
