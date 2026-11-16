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
  prs: { total: number; recent: Pull[] } // total is at least this many; recent is the latest 100
  issues: { total: number; recent: Issue[] }
  activity: number // 0..1, how much landed in the last 90 days
  size: number // 0.65..1.2, the fish's length
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

// GitHub's Link header names the last page, not the item count: the total is a lower bound.
export function parseLastPage(link: string | null): number {
  const match = link ? /[?&]page=(\d+)>;\s*rel="last"/.exec(link) : null
  return match ? Number(match[1]) : 0
}

export function sizeOf(total: number): number {
  const capped = Math.max(0, Math.min(256, total))
  return 0.65 + (0.55 * Math.log2(1 + capped)) / Math.log2(257)
}

export function lifecycleOf(meta: { archived: boolean; pushed_at: string }, now: number): { lifecycle: Lifecycle; quietDays: number } {
  const quietDays = Math.max(0, Math.floor((now - Date.parse(meta.pushed_at)) / DAY))
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

export function readProject(repo: string, meta: Json, pulls: Json[], issues: Json[], now: number): Project {
  const { lifecycle, quietDays } = lifecycleOf({ archived: meta.archived === true, pushed_at: text(meta.pushed_at, 32) }, now)
  const recentPulls = list(pulls).map(toPull)
  const recentIssues = list(issues).map(toIssue).filter((i): i is Issue => i !== null)
  const cutoff = now - 90 * DAY
  const fresh = recentPulls.filter((p) => Date.parse(p.at) >= cutoff).length + recentIssues.filter((i) => Date.parse(i.at) >= cutoff).length
  return {
    repo,
    name: text(meta.name, 60) || repo.split('/')[1],
    theme: text(meta.description, 200) || repo.split('/')[1],
    url: link(meta.html_url),
    created: text(meta.created_at, 32),
    pushed: text(meta.pushed_at, 32),
    archived: meta.archived === true,
    prs: { total: recentPulls.length, recent: recentPulls },
    issues: { total: recentIssues.length, recent: recentIssues },
    activity: Math.max(0.2, Math.min(1, 0.2 + 0.8 * Math.min(1, fresh / 30))),
    size: sizeOf(recentPulls.length),
    lifecycle,
    quietDays,
  }
}

interface Reply {
  body: unknown
  total: number
}

async function get(path: string): Promise<Reply> {
  const res = await fetch(API + path, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (res.status === 404) throw new Error('not found, or it is private')
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached (60 requests per hour without a token)')
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`)
  const body: unknown = await res.json()
  const last = parseLastPage(res.headers.get('link'))
  const total = last ? last * PAGE : Array.isArray(body) ? body.length : 0
  return { body, total }
}

async function read(repo: string, now: number): Promise<Project> {
  const [meta, pulls, issues] = await Promise.all([
    get(`/repos/${repo}`),
    get(`/repos/${repo}/pulls?state=all&per_page=${PAGE}&sort=created&direction=desc`),
    get(`/repos/${repo}/issues?state=all&per_page=${PAGE}&sort=created&direction=desc`),
  ])
  const project = readProject(repo, obj(meta.body), list(pulls.body), list(issues.body), now)
  project.prs.total = Math.max(project.prs.recent.length, pulls.total)
  project.issues.total = Math.max(project.issues.recent.length, issues.total)
  project.size = sizeOf(project.prs.total)
  return project
}

// At most three repositories are in flight at once: unauthenticated GitHub allows 60 requests an hour.
export async function fetchProjects(input: string, now = Date.now()): Promise<ProjectSet> {
  const repos = parseRepos(input)
  const projects: Project[] = []
  const notices: string[] = []
  const queue = [...repos]
  const failed: string[] = []
  const worker = async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      try {
        projects.push(await read(repo, now))
      } catch (err) {
        failed.push(`${repo}: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  for (const f of failed) notices.push(f)
  if (!projects.length) throw new Error(failed[0] ?? 'No repositories were read.')
  if (projects.some((p) => p.prs.total > PAGE || p.issues.total > PAGE || p.prs.recent.length === PAGE || p.issues.recent.length === PAGE)) {
    notices.push('Only the latest 100 pull requests and issues per project were read. Counts marked + are at least that large.')
  }
  notices.push('Bones are pull requests, scales are issues, and a repository is not a living thing: this mapping is a design choice, not a measurement of the code.')
  notices.push('Loading costs three GitHub requests per project; without a token GitHub allows 60 an hour.')
  notices.push('Merged, open, and closed splits cover the latest 100 pull requests; the total is a lower bound from GitHub\'s page count.')
  return { projects, notices, at: new Date(now).toISOString() }
}
