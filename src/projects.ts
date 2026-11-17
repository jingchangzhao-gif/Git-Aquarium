// Turns repository records into one project fish per repository: pull requests become bones,
// issues become scales, and the repository's own description is the spine's theme.
// Nothing here renders; every function is deterministic given the records and a clock.

export type Lifecycle = 'active' | 'quiet' | 'abandoned'
export type PullState = 'open' | 'merged' | 'closed'

export interface Pull {
  number: number
  title: string
  state: PullState
  at: string
  url: string
}

export interface Issue {
  number: number
  title: string
  open: boolean
  question: boolean
  at: string
  url: string
}

export interface Project {
  repo: string
  name: string
  theme: string // the description, or the repository name when there is none
  url: string
  created: string
  pushed: string
  archived: boolean
  // `recent` is the latest 100. When `exact` is false the total is not a count: for pull requests it is
  // rounded up to a whole page ("about"), and for issues it is an upper limit ("up to").
  prs: { total: number; exact: boolean; recent: Pull[] }
  issues: { total: number; exact: boolean; recent: Issue[] }
  activity: number // 0..1, how much landed in the last 90 days
  size: number // 0.65..1.2, the fish's length, from the pull request total
  lifecycle: Lifecycle
  quietDays: number
}

export interface ProjectSet {
  projects: Project[]
  notices: string[]
  at: string
}

export const MAX_PROJECTS = 12
const PAGE = 100
const DAY = 86_400_000
const API = 'https://api.github.com'

// Each loading costs three requests, so the default tank stays under GitHub's 60 an hour.
export const DEFAULT_REPOS = [
  'vitejs/vite', 'sveltejs/svelte', 'denoland/deno', 'vuejs/core',
  'chalk/chalk', 'moment/moment', 'request/request',
]

const REPO = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
const SHORT = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

// Accepts owner/repo lines, github.com URLs, or a mix. Duplicates collapse; order is kept.
export function parseRepos(input: string): string[] {
  const items = input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const match = REPO.exec(item) ?? SHORT.exec(item)
    if (!match) throw new Error(`"${item}" is not a public repository. Use owner/repo or a github.com URL.`)
    const repo = `${match[1]}/${match[2]}`
    const key = repo.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(repo)
  }
  if (!out.length) throw new Error('Enter at least one public repository.')
  if (out.length > MAX_PROJECTS) throw new Error(`Up to ${MAX_PROJECTS} repositories fit in one tank; ${out.length} were given.`)
  return out
}

// GitHub's Link header names the last page, not the item count, so a total read from it is the count
// rounded up to a whole page: right to within one page.
export function parseLastPage(link: string | null): number {
  const match = link ? /[?&]page=(\d+)>;\s*rel="last"/.exec(link) : null
  return match ? Number(match[1]) : 0
}

// Log scale up to 32,767 pull requests, so that 300 and 20,000 are both visible and still look different.
export function sizeOf(total: number): number {
  const capped = Math.max(0, Math.min(32_767, total))
  return 0.65 + (0.55 * Math.log2(1 + capped)) / 15
}

export function lifecycleOf(meta: { archived: boolean; pushed_at: string }, now: number): { lifecycle: Lifecycle; quietDays: number } {
  const pushed = Date.parse(meta.pushed_at)
  const quietDays = Number.isFinite(pushed) ? Math.max(0, Math.floor((now - pushed) / DAY)) : 0
  if (meta.archived || quietDays > 365) return { lifecycle: 'abandoned', quietDays }
  if (quietDays > 90) return { lifecycle: 'quiet', quietDays }
  return { lifecycle: 'active', quietDays }
}

export function countPulls(list: Pull[]): { open: number; merged: number; closed: number } {
  const counts = { open: 0, merged: 0, closed: 0 }
  for (const p of list) counts[p.state]++
  return counts
}

export function countIssues(list: Issue[]): { open: number; question: number } {
  const counts = { open: 0, question: 0 }
  for (const i of list) {
    if (i.open) counts.open++
    if (i.question) counts.question++
  }
  return counts
}

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.split('\n')[0].slice(0, max).trim() : ''
}

function link(value: unknown): string {
  return typeof value === 'string' && value.startsWith('https://github.com/') ? value : ''
}

interface Json { [key: string]: unknown }
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])

function toPull(raw: Json): Pull {
  const state = raw.state === 'open' ? 'open' : raw.merged_at ? 'merged' : 'closed'
  return {
    number: Number(raw.number) || 0,
    title: text(raw.title),
    state,
    at: text(raw.created_at, 32),
    url: link(raw.html_url),
  }
}

function toIssue(raw: Json): Issue | null {
  if (raw.pull_request) return null // the issues endpoint mixes pull requests in
  const labels = list(raw.labels).map((l) => text(l.name, 40).toLowerCase())
  return {
    number: Number(raw.number) || 0,
    title: text(raw.title),
    open: raw.state === 'open',
    question: labels.includes('question'),
    at: text(raw.created_at, 32),
    url: link(raw.html_url),
  }
}

// `pullPages` is the last page number GitHub reported for the pull request list, or 0 when it fitted on one page.
// `issueCount` is the exact number of issues from GitHub's search, when that request was allowed.
export function readProject(
  repo: string, meta: Json, pulls: Json[], issues: Json[], now: number, pullPages = 0, issueCount?: number,
): Project {
  const { lifecycle, quietDays } = lifecycleOf({ archived: meta.archived === true, pushed_at: text(meta.pushed_at, 32) }, now)
  const recentPulls = list(pulls).map(toPull)
  const recentIssues = list(issues).map(toIssue).filter((i): i is Issue => i !== null)
  const cutoff = now - 90 * DAY
  const fresh = recentPulls.filter((p) => Date.parse(p.at) >= cutoff).length + recentIssues.filter((i) => Date.parse(i.at) >= cutoff).length
  // Pull requests: an exact count if they fitted on one page, otherwise the page count times the page size.
  const prTotal = pullPages > 1 ? pullPages * PAGE : recentPulls.length
  // Issues: GitHub gives no page count for this list, so the exact count comes from search. Without it, and
  // when the list was cut off, only a limit is known: issues, pull requests, and discussions share one number
  // sequence, so there cannot be more issues than the highest number seen less the pull requests.
  const counted = issueCount !== undefined && Number.isFinite(issueCount)
  const cutOff = list(issues).length >= PAGE
  const highest = Math.max(0, ...list(issues).map((i) => Number(i.number) || 0), ...recentPulls.map((p) => p.number))
  const limit = Math.max(recentIssues.length, Math.ceil((highest - prTotal + PAGE) / PAGE) * PAGE) // the pull requests were rounded up
  const issueTotal = counted ? issueCount : cutOff ? limit : recentIssues.length
  return {
    repo,
    name: text(meta.name, 60) || repo.split('/')[1],
    theme: text(meta.description, 200) || repo.split('/')[1],
    url: link(meta.html_url),
    created: text(meta.created_at, 32),
    pushed: text(meta.pushed_at, 32),
    archived: meta.archived === true,
    prs: { total: prTotal, exact: pullPages <= 1, recent: recentPulls },
    issues: { total: issueTotal, exact: counted || !cutOff, recent: recentIssues },
    activity: Math.max(0.2, Math.min(1, 0.2 + 0.8 * Math.min(1, fresh / 30))),
    size: sizeOf(prTotal),
    lifecycle,
    quietDays,
  }
}

export interface Reply {
  body: unknown
  pages: number // the last page GitHub named, or 0 when there is only one
}

export async function get(path: string): Promise<Reply> {
  const res = await fetch(API + path, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (res.status === 404) throw new Error('not found, or it is private')
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached (60 requests per hour without a token)')
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`)
  return { body: await res.json(), pages: parseLastPage(res.headers.get('link')) }
}

async function read(repo: string, now: number): Promise<Project> {
  const [meta, pulls, issues, counted] = await Promise.all([
    get(`/repos/${repo}`),
    get(`/repos/${repo}/pulls?state=all&per_page=${PAGE}&sort=created&direction=desc`),
    get(`/repos/${repo}/issues?state=all&per_page=${PAGE}&sort=created&direction=desc`),
    // Search has its own, smaller allowance (ten a minute without a token), so a refusal here is not an error.
    get(`/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue`)}&per_page=1`).catch(() => null),
  ])
  const total = obj(counted?.body).total_count
  return readProject(repo, obj(meta.body), list(pulls.body), list(issues.body), now, pulls.pages,
    typeof total === 'number' ? total : undefined)
}

// At most three repositories are in flight at once: unauthenticated GitHub allows 60 requests an hour.
export async function fetchProjects(input: string, now = Date.now()): Promise<ProjectSet> {
  const repos = parseRepos(input)
  const notices: string[] = []
  const slots: (Project | string)[] = [] // by input position, so the tank's order does not depend on which reply came first
  let next = 0
  const worker = async () => {
    for (let i = next++; i < repos.length; i = next++) {
      try {
        slots[i] = await read(repos[i], now)
      } catch (err) {
        slots[i] = `${repos[i]}: ${(err as Error).message}`
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  const projects = slots.filter((s): s is Project => typeof s !== 'string')
  const failed = slots.filter((s): s is string => typeof s === 'string')
  notices.push(...failed)
  if (!projects.length) throw new Error(failed[0] ?? 'No repositories were read.')
  if (projects.some((p) => !p.prs.exact || !p.issues.exact)) {
    notices.push('Only the latest 100 pull requests and issues of each project are drawn, and the merged, open, and closed splits cover those only.')
  }
  if (projects.some((p) => !p.prs.exact)) {
    notices.push('Pull request totals marked "about" come from GitHub\'s page count, so they are rounded up to the next hundred.')
  }
  if (projects.some((p) => !p.issues.exact)) {
    notices.push('Issue totals marked "up to" are a limit, not a count: GitHub\'s search, which gives the exact number, allows ten requests a minute and refused. The limit is the highest issue number less the pull requests; discussions share that numbering, so the true count can be much lower.')
  }
  notices.push('Bones are pull requests, scales are issues, and a repository is not a living thing: this mapping is a design choice, not a measurement of the code.')
  notices.push('Loading costs three GitHub requests per project, and one search request for its issue count; without a token GitHub allows 60 an hour and ten searches a minute.')
  return { projects, notices, at: new Date(now).toISOString() }
}
