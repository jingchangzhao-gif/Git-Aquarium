// Turns repository records into a frozen dataset for replay. Nothing here changes once a replay starts.
import type { EventKind, GitEvent } from './sim'

export interface Dataset {
  source: 'synthetic' | 'recorded'
  repo: string
  branches: string[] // observed snapshot; each becomes a lineage
  events: GitEvent[] // deduplicated, in replay order
  notices: string[] // data boundaries, truncation, and missing records, shown to the user
}

export type RawEvent = Omit<GitEvent, 'tick' | 'lineage'>

export const REPLAY_TICKS = 3600 // the imported window plays in three minutes at 1x
const WARMUP_TICKS = 100
export const MAX_LINEAGES = 8
const PAGE = 100 // one page per request

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0) // not localeCompare: must not vary by locale

export function freeze(
  source: Dataset['source'], repo: string, branches: string[], raw: RawEvent[], notices: string[] = [],
): Dataset {
  const seen = new Set<string>()
  const valid = raw
    .filter((e) => {
      const key = `${e.kind}:${e.id}` // one effect per unique commit SHA, PR, or workflow run
      if (!e.id || Number.isNaN(Date.parse(e.at)) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || order(a.kind, b.kind) || order(a.id, b.id))
  const first = valid.length ? Date.parse(valid[0].at) : 0
  const span = valid.length ? Date.parse(valid[valid.length - 1].at) - first : 0
  if (branches.length > MAX_LINEAGES) {
    notices.push(`Showing the first ${MAX_LINEAGES} of ${branches.length} observed branches as lineages.`)
  }
  const lineages = branches.length ? branches.slice(0, MAX_LINEAGES) : ['unknown']
  const events = valid.map((e) => ({
    ...e,
    tick: WARMUP_TICKS + (span ? Math.floor(((Date.parse(e.at) - first) / span) * REPLAY_TICKS) : 0),
    // An event acts on the lineage of its own branch; a merge acts on the branch it merged into.
    lineage: lineages.indexOf(e.branches[e.kind === 'PR_MERGED' ? 1 : 0]),
  }))
  return { source, repo, branches: lineages, events, notices }
}

// GitHub responses are untrusted: read only the fields we need and check their types.
const text = (v: unknown) => (typeof v === 'string' ? v : '')
const title = (v: unknown) => text(v).split('\n')[0].slice(0, 120)
const link = (v: unknown) => (typeof v === 'string' && v.startsWith('https://github.com/') ? v : null)
const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])

export interface GitHubData {
  repo: unknown // repository metadata, for the default branch
  branches: unknown
  pulls: unknown
  runs: unknown
  commits: Record<string, unknown> // one commit list per lineage branch
}

// Which branches become lineages: the default branch, then those with the most pull request and CI activity.
export function pickLineages(api: Pick<GitHubData, 'repo' | 'branches' | 'pulls' | 'runs'>): string[] {
  const main = text((api.repo as any)?.default_branch)
  const names = list(api.branches).map((b) => text(b?.name)).filter((name) => name && name !== main)
  const activity = (name: string) =>
    list(api.pulls).filter((p) => p?.head?.ref === name || p?.base?.ref === name).length +
    list(api.runs).filter((r) => r?.head_branch === name).length
  const score = new Map(names.map((name) => [name, activity(name)]))
  names.sort((a, b) => score.get(b)! - score.get(a)!) // stable: ties keep GitHub's order
  return [...(main ? [main] : []), ...names].slice(0, MAX_LINEAGES)
}

export function fromGitHub(repo: string, api: GitHubData, windowStart = -Infinity, extra: string[] = []): Dataset {
  const lineages = pickLineages(api)
  const observed = list(api.branches).length
  const notices = [
    ...extra,
    'Commits replay at their committer timestamp, a proxy rather than a verified push time.',
    'Branches are a current snapshot. A commit counts for the default branch if it is there, otherwise for the first lineage branch it was found on.',
  ]
  if (observed > lineages.length) {
    notices.push(`Showing ${lineages.length} of ${observed} branches as lineages: the default branch and those with the most pull request and CI activity.`)
  }

  // The default branch is read first, so shared history is credited to it and each other branch keeps only its own commits.
  const seen = new Set<string>()
  const commits: RawEvent[] = lineages.flatMap((branch) => list(api.commits[branch]).flatMap((c): RawEvent[] => {
    const sha = text(c?.sha)
    if (!sha || seen.has(sha)) return []
    seen.add(sha)
    return [{
      kind: 'COMMIT_OBSERVED', at: text(c?.commit?.committer?.date), id: sha,
      title: title(c?.commit?.message), url: link(c?.html_url), branches: [branch], group: '',
    }]
  }))

  // Events on a branch that is not a lineage have nobody to act on, so they are left out and counted.
  let elsewhere = 0
  const pulls: RawEvent[] = list(api.pulls).flatMap((p) => {
    const pr = {
      id: String(p?.number ?? ''), title: title(p?.title), url: link(p?.html_url),
      branches: [text(p?.head?.ref), text(p?.base?.ref)], group: '',
    }
    if (!lineages.includes(pr.branches[1])) { elsewhere++; return [] }
    const opened: RawEvent = { ...pr, kind: 'PR_OPENED', at: text(p?.created_at) }
    return p?.merged_at ? [opened, { ...pr, kind: 'PR_MERGED' as EventKind, at: text(p.merged_at) }] : [opened]
  })
  let ignored = 0
  const runs: RawEvent[] = list(api.runs).flatMap((r) => {
    const kind: EventKind | null =
      r?.conclusion === 'success' ? 'CI_PASSED'
      : r?.conclusion === 'failure' || r?.conclusion === 'timed_out' ? 'CI_FAILED'
      : null
    if (!kind) { ignored++; return [] }
    const branch = text(r?.head_branch)
    if (!lineages.includes(branch)) { elsewhere++; return [] }
    return [{
      kind, at: text(r?.updated_at), id: String(r?.id ?? ''), title: title(`${text(r?.name)}: ${r.conclusion}`),
      url: link(r?.html_url), branches: [branch], group: `${r?.workflow_id}@${branch}`,
    }]
  })
  if (api.runs === null) notices.push('GitHub Actions data was unavailable; CI effects are missing, not passing.')
  else if (!runs.length) notices.push('No supported GitHub Actions results on the lineage branches; CI effects are missing, not passing.')
  if (ignored) notices.push(`${ignored} workflow runs with other conclusions (cancelled, skipped, ...) were ignored.`)
  if (elsewhere) notices.push(`${elsewhere} pull requests and workflow runs were on branches that are not shown as lineages; they were left out.`)

  // The fetch chooses a window; anything older than it is dropped here so the replay starts at its edge.
  const all = [...commits, ...pulls, ...runs].filter((e) => Date.parse(e.at) >= windowStart)
  return freeze('recorded', repo, lineages, all, notices)
}

// ---- Frozen datasets ----------------------------------------------------------------------------
// A dataset can be saved as one JSON file and reopened without network access, so a replay is
// reproducible by someone else: same file, same seed, same state at the same tick.

export const DATASET_FORMAT = 'git-aquarium-dataset'
export const DATASET_VERSION = 1

const EVENT_KINDS = ['COMMIT_OBSERVED', 'PR_OPENED', 'PR_MERGED', 'CI_FAILED', 'CI_PASSED']

export function saveDataset(d: Dataset): string {
  return JSON.stringify({ format: DATASET_FORMAT, version: DATASET_VERSION, saved: new Date().toISOString(), dataset: d })
}

// A file from anywhere is untrusted: reject anything that is not exactly one frozen dataset.
export function loadDataset(text: string): Dataset {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('That file is not JSON.')
  }
  const v = value as { format?: unknown; version?: unknown; dataset?: unknown }
  if (!v || v.format !== DATASET_FORMAT) throw new Error('That file is not a Git Aquarium dataset.')
  if (v.version !== DATASET_VERSION) {
    throw new Error(`That dataset was saved by a different version (${String(v.version)}); this build reads version ${DATASET_VERSION}.`)
  }
  const d = v.dataset as Dataset
  if (!d || typeof d !== 'object') throw new Error('The dataset is missing.')
  if (d.source !== 'synthetic' && d.source !== 'recorded') throw new Error('The dataset has an unknown source.')
  if (typeof d.repo !== 'string' || !d.repo) throw new Error('The dataset has no repository name.')
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string')
  if (!strings(d.branches)) throw new Error('The dataset has no branch list.')
  if (!strings(d.notices)) throw new Error('The dataset has no notice list.')
  if (!Array.isArray(d.events) || !d.events.length) throw new Error('The dataset has no events.')
  for (const e of d.events) {
    if (!e || typeof e !== 'object') throw new Error('The dataset has a malformed event.')
    if (!EVENT_KINDS.includes(e.kind)) throw new Error(`The dataset has an unknown event kind: ${String(e.kind)}.`)
    if (typeof e.id !== 'string' || !e.id) throw new Error('The dataset has an event without an id.')
    if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) throw new Error('The dataset has an event without a usable date.')
    if (!Number.isFinite(e.tick) || !Number.isInteger(e.tick)) throw new Error('The dataset has an event without a tick.')
    if (!Number.isInteger(e.lineage) || e.lineage < 0) throw new Error('The dataset has an event without a lineage.')
    if (!strings(e.branches)) throw new Error('The dataset has an event without branches.')
    if (e.lineage >= d.branches.length) throw new Error('The dataset has an event on a lineage that does not exist.')
    if (typeof e.title !== 'string') throw new Error('The dataset has an event without a title.')
    if (e.url !== null && (typeof e.url !== 'string' || link(e.url) !== e.url)) {
      throw new Error('The dataset has an event with a malformed url.')
    }
  }
  return d
}

const DAY = 86_400_000
export const DEFAULT_DAYS = 90
export const DEFAULT_BUDGET = 40
const MAX_PAGES = 20 // a window can ask for a lot of pages; the budget is the real limit

export interface ImportOptions {
  days?: number // window ending at import time
  budget?: number // requests this import may spend
}

export interface ImportResult {
  dataset: Dataset
  requests: number
  budget: number
  limit: number | null // requests left in GitHub's hourly limit, when the API said
}

// Reads one public repository straight from the browser: GitHub's REST API allows it, so no server is needed.
// The window is a period, not a page: each source is read newest first until it passes the window start or
// the budget is spent, and the notice says which one stopped it.
// ponytail: unauthenticated = 60 requests/hour per IP. A token raises this (issue #8 I4).
export async function importRepo(input: string, options: ImportOptions = {}): Promise<ImportResult> {
  const repo = input.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1]
  if (!repo) throw new Error('Enter a public repository as owner/repo or a github.com URL.')
  const days = options.days ?? DEFAULT_DAYS
  const budget = options.budget ?? DEFAULT_BUDGET
  const start = Date.now() - days * DAY
  let used = 0
  let limit: number | null = null

  // Returns null once the budget is spent, so paging stops instead of failing the whole import.
  const get = async (path: string): Promise<unknown | null> => {
    if (used >= budget) return null
    used++
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    const left = Number(res.headers.get('x-ratelimit-remaining'))
    if (Number.isFinite(left)) limit = left
    if (res.status === 404) throw new Error('Repository not found, or it is private.')
    if (res.status === 403 || res.status === 429) {
      throw new Error(`GitHub rate limit reached (${limit ?? '?'} requests left this hour). Try again later.`)
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}.`)
    return res.json()
  }

  const must = async (path: string) => {
    const body = await get(path)
    if (body === null) throw new Error(`The request budget of ${budget} ran out before the repository was read.`)
    return body
  }

  // Pages newest first; `at` is the date used to stop once a page reaches before the window.
  const pages = async (path: string, read: (body: unknown) => unknown[], at: (item: any) => number) => {
    const items: unknown[] = []
    let cut = false
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`)
      if (body === null) { cut = true; break }
      const records = read(body)
      items.push(...records)
      if (records.length < PAGE || records.some((r) => at(r) < start)) break
    }
    return { items, cut }
  }

  const meta = await must('')
  const branches = await must(`/branches?per_page=${PAGE}`)
  const pulls = await pages('/pulls?state=all&sort=created&direction=desc', (b) => list(b), (p) => Date.parse(text(p?.created_at)))
  let runs: unknown = null
  try {
    runs = (await pages('/actions/runs?status=completed', (b) => list((b as any)?.workflow_runs), (r) => Date.parse(text(r?.updated_at)))).items
  } catch {
    runs = null // missing CI is reported as missing, not as passing
  }
  const api = { repo: meta, branches, pulls: pulls.items, runs }
  const commits: Record<string, unknown> = {}
  let commitCut = false
  for (const branch of pickLineages(api)) {
    const result = await pages(`/commits?sha=${encodeURIComponent(branch)}`, (b) => list(b), (c) => Date.parse(text(c?.commit?.committer?.date)))
    commits[branch] = result.items
    if (result.cut) commitCut = true
  }

  const notices = [
    `The window is the ${days} days before import time; records older than ${new Date(start).toISOString().slice(0, 10)} are missing.`,
  ]
  if (pulls.cut || commitCut) {
    notices.push(`The request budget of ${budget} ran out before the window was fully covered; the oldest records are missing.`)
  }
  if (limit !== null) notices.push(`GitHub reported ${limit} requests left in its hourly limit when the last request finished.`)
  notices.push(`This import used ${used} of ${budget} requests.`)

  const dataset = fromGitHub(repo, { ...api, commits }, start, notices)
  return { dataset, requests: used, budget, limit }
}
