// Turns repository records into one project fish per repository: pull requests become bones,
// issues become scales, and the repository's own description is the spine's theme.
// Nothing here renders; every function is deterministic given the records and a clock.

import { anatomyOf, type Anatomy } from './anatomy.ts'

export type Lifecycle = 'active' | 'slowing' | 'seaweed' | 'rock' | 'finished' | 'unknown'
export type Form = 'fish' | 'seaweed' | 'rock'
export type PullState = 'open' | 'merged' | 'closed'

// Finished is a setting its owner writes into the repository's topics, never a guess from inactivity.
export const FINISHED_TOPIC = 'aquarium-finished'
export function formTopic(form: Form): string {
  return `aquarium-form-${form}`
}

// The topic set after setting or clearing the finished mark; unrelated topics are always kept.
export function topicChange(current: string[], finished: boolean, form: Form): string[] {
  const keep = current.filter((t) => t !== FINISHED_TOPIC && !/^aquarium-form-/.test(t))
  return finished ? [...keep, FINISHED_TOPIC, formTopic(form)] : keep
}

const FORMS: Form[] = ['fish', 'seaweed', 'rock']

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
  labels: string[] // lowercased names; `feature:` labels place the issue on a bone
  comments: number
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
  size: number // 0.55..1.35, the fish's length, from the pull request total
  lifecycle: Lifecycle
  form: Form // what the project is drawn as: a finished project keeps the form its owner chose
  finished: boolean // set by the owner through the aquarium-finished topic
  own: boolean // true only for repositories the local account may write to
  speed: number // 0..1, how fast the body swims; upkeep slows it down
  quietDays: number | null // null when GitHub gave no push date; never treated as "today"
  // Features are the big bones, issues the small bones and the scale surface, and merged pull requests
  // that closed an issue the connections between them. Read from `feature:` labels; everything else is General.
  anatomy: Anatomy
}

export interface ProjectSet {
  source: 'synthetic' | 'recorded'
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
  return 0.55 + (0.8 * Math.log2(1 + capped)) / 15
}

// Upkeep is deterministic: the same push date and clock give the same stage and speed.
// A finished project keeps the form its owner picked, whatever its last push was.
export interface Upkeep {
  lifecycle: Lifecycle
  form: Form
  finished: boolean
  quietDays: number | null
  speed: number
}

export function lifecycleOf(
  meta: { archived: boolean; pushed_at?: string; topics?: string[] }, now: number,
): Upkeep {
  const topics = (meta.topics ?? []).filter((t): t is string => typeof t === 'string')
  const finished = topics.includes(FINISHED_TOPIC)
  const chosen = topics.map((t) => /^aquarium-form-(fish|seaweed|rock)$/.exec(t)?.[1]).find((f): f is Form => FORMS.includes(f as Form))
  const pushed = Date.parse(meta.pushed_at ?? '')
  const quietDays = Number.isFinite(pushed) ? Math.max(0, Math.floor((now - pushed) / DAY)) : null
  if (finished) {
    const form = chosen ?? 'fish'
    return { lifecycle: 'finished', form, finished: true, quietDays, speed: form === 'fish' ? 0.6 : 0 }
  }
  // Archived and a year silent are the same thing to a viewer: a rock.
  if (meta.archived || (quietDays !== null && quietDays > 365)) {
    return { lifecycle: 'rock', form: 'rock', finished: false, quietDays, speed: 0 }
  }
  if (quietDays === null) return { lifecycle: 'unknown', form: 'fish', finished: false, quietDays, speed: 0.4 }
  if (quietDays >= 180) return { lifecycle: 'seaweed', form: 'seaweed', finished: false, quietDays, speed: 0 }
  // Ninety days is still active; after that the fish slows, reaching a stop as seaweed time approaches.
  if (quietDays > 90) {
    return { lifecycle: 'slowing', form: 'fish', finished: false, quietDays, speed: 1 - 0.8 * (quietDays - 90) / 90 }
  }
  return { lifecycle: 'active', form: 'fish', finished: false, quietDays, speed: 1 }
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
    labels: labels.filter(Boolean),
    comments: Math.max(0, Number(raw.comments) || 0),
    at: text(raw.created_at, 32),
    url: link(raw.html_url),
  }
}

// `pullPages` is the last page number GitHub reported for the pull request list, or 0 when it fitted on one page.
// `issueCount` is the exact number of issues from GitHub's search, when that request was allowed.
export function readProject(
  repo: string, meta: Json, pulls: Json[], issues: Json[], now: number, pullPages = 0, issueCount?: number, own = false,
  extra: { labels?: unknown; merged?: unknown } = {},
): Project {
  const upkeep = lifecycleOf({
    archived: meta.archived === true,
    pushed_at: text(meta.pushed_at, 32),
    // Topics are plain strings, not objects: `list` would drop them all.
    topics: Array.isArray(meta.topics) ? meta.topics.filter((t): t is string => typeof t === 'string').slice(0, 20) : [],
  }, now)
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
    ...upkeep,
    own,
    anatomy: anatomyOf(repo, { labels: extra.labels, issues: list(issues), merged: extra.merged }),
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
  notices.push('Features are bones, issues are small bones and the scale surface, and a merged pull request that closed an issue is a connection; a repository is not a living thing, so this mapping is a design choice, not a measurement of the code.')
  notices.push('Loading costs three GitHub requests per project, and one search request for its issue count; without a token GitHub allows 60 an hour and ten searches a minute.')
  return { source: 'recorded', projects, notices, at: new Date(now).toISOString() }
}

// The three things the panel answers about a fish: how old and how looked-after it is (age), how much work
// went through it (skeleton), and how many of its questions were dealt with (scales).
export interface Health {
  years: number
  lastUpdate: number | null // days since the last push; null when GitHub gave no date
  opened: { pulls: number; issues: number; atLeast: boolean } // in the last 90 days; atLeast when the latest 100 did not reach back that far
  merged: number | null // of the latest pull requests that were finished, the share merged rather than closed unmerged
  complete: number | null // of the latest issues, the share closed: how whole the scales are
  unanswered: number // open issues over 30 days old that nobody has commented on, among the latest 100
}

export function healthOf(p: Project, now: number): Health {
  const created = Date.parse(p.created)
  const cutoff = now - 90 * DAY
  const within = (list: { at: string }[]) => list.filter((x) => Date.parse(x.at) >= cutoff).length
  const reaches = (list: { at: string }[]) => list.length < PAGE || list.some((x) => Date.parse(x.at) < cutoff)
  const pulls = countPulls(p.prs.recent)
  const finished = pulls.merged + pulls.closed
  const issues = p.issues.recent
  return {
    years: Number.isFinite(created) ? Math.max(0, (now - created) / (365.25 * DAY)) : 0,
    lastUpdate: p.quietDays,
    opened: { pulls: within(p.prs.recent), issues: within(issues), atLeast: !reaches(p.prs.recent) || !reaches(issues) },
    merged: finished ? pulls.merged / finished : null,
    complete: issues.length ? issues.filter((i) => !i.open).length / issues.length : null,
    unanswered: issues.filter((i) => i.open && i.comments === 0 && Date.parse(i.at) < now - 30 * DAY).length,
  }
}

// A tank that opens without the network: fictional repositories, made into records the same way GitHub's would be
// read, so the demo goes through readProject like real data. Each one shows a different kind of upkeep.
interface DemoProject {
  name: string
  theme: string
  years: number
  quiet: number
  prs: number
  perMonth: number
  merge: number
  issues: number
  complete: number
  answered: number
  archived?: boolean
  topics?: string[]
  features?: string[] // feature:<slug> labels, so the demo shows bones rather than one General bone
  mixed?: boolean // some issues carry two feature labels, to show the conflict fallback
}

const DEMO: DemoProject[] = [
  { name: 'harbor', theme: 'A busy web framework with a large team', years: 8, quiet: 0, prs: 12_000, perMonth: 300, merge: 0.8, issues: 5200, complete: 0.86, answered: 0.95, features: ['web-ui', 'router', 'cache'] },
  { name: 'lantern', theme: 'A small, tidy command-line tool', years: 3, quiet: 2, prs: 240, perMonth: 8, merge: 0.92, issues: 70, complete: 0.96, answered: 1, features: ['cli', 'config'] },
  { name: 'driftwood', theme: 'Popular, but its questions pile up', years: 6, quiet: 4, prs: 3100, perMonth: 40, merge: 0.45, issues: 2600, complete: 0.42, answered: 0.35, features: ['api'], mixed: true },
  { name: 'tidepool', theme: 'Nobody has pushed since the spring', years: 5, quiet: 150, prs: 640, perMonth: 2, merge: 0.75, issues: 300, complete: 0.7, answered: 0.6, features: ['sync'] },
  { name: 'garden', theme: 'Left alone for more than six months', years: 4, quiet: 250, prs: 150, perMonth: 1, merge: 0.8, issues: 90, complete: 0.75, answered: 0.7, features: ['tools'] },
  { name: 'kelp', theme: 'Untouched for more than a year', years: 9, quiet: 520, prs: 410, perMonth: 1, merge: 0.7, issues: 220, complete: 0.6, answered: 0.5, features: ['legacy'] },
  { name: 'anchor', theme: 'Finished and archived by its owners', years: 11, quiet: 900, prs: 1800, perMonth: 1, merge: 0.85, issues: 900, complete: 0.97, answered: 0.9, archived: true, features: ['core'] },
  { name: 'ledger', theme: 'Declared finished, though it was quiet long before', years: 7, quiet: 300, prs: 950, perMonth: 1, merge: 0.9, issues: 400, complete: 0.88, answered: 0.8, topics: ['aquarium-finished', 'aquarium-form-fish'], features: ['core', 'export'] },
]

export function demoProjects(now = Date.now()): ProjectSet {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646 // a fixed sequence, so the demo is the same every time
  const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString()
  const projects = DEMO.map((d) => {
    const repo = `demo/${d.name}`
    const gap = 30 / d.perMonth // days between two pull requests; issues arrive at the same pace
    const items = (total: number, make: (n: number, daysAgo: number) => Json) =>
      Array.from({ length: Math.min(PAGE, total) }, (_, i) => make(total - i, d.quiet + i * gap * (0.5 + rand())))
    const pulls = items(d.prs, (number, daysAgo) => ({
      number, title: `Change ${number}`, created_at: iso(daysAgo),
      state: daysAgo - d.quiet < Math.max(3 * gap, 4) && rand() < 0.5 ? 'open' : 'closed', // the newest few are still open
      merged_at: rand() < d.merge ? iso(daysAgo - 1) : null,
    }))
    const issues = items(d.issues, (number, daysAgo) => {
      const open = rand() > d.complete
      const features = d.features ?? []
      const labels: { name: string }[] = []
      if (features.length) {
        const pick = features[number % features.length]
        if (d.mixed && number % 23 === 0 && features.length > 1) labels.push({ name: `feature:${features[0]}` }, { name: `feature:${features[1]}` })
        else if (number % 7 !== 0) labels.push({ name: `feature:${pick}` })
      }
      if (rand() < 0.1) labels.push({ name: 'question' })
      return { number, title: `Issue ${number}`, created_at: iso(daysAgo), state: open ? 'open' : 'closed',
        comments: open && rand() > d.answered ? 0 : 1 + Math.floor(rand() * 4), labels }
    })
    const meta = {
      name: d.name, description: d.theme, created_at: iso(d.years * 365.25), pushed_at: iso(d.quiet), archived: d.archived === true,
      topics: d.topics ?? [], labels: (d.features ?? []).map((f) => ({ name: `feature:${f}` })),
    }
    // A merged pull request that closed an issue is the only connection drawn; one PR may close several.
    const closed = issues.filter((i) => i.state === 'closed').map((i) => i.number)
    const merged = pulls.filter((p) => p.merged_at && p.state !== 'open').slice(0, 6).map((p, i) => ({
      number: p.number, title: p.title, merged_at: p.merged_at, url: `https://github.com/${repo}/pull/${p.number}`,
      closes: i === 0 ? closed.slice(0, 2) : closed[i] ? [closed[i]] : [],
    }))
    return readProject(repo, meta, pulls.map((p) => (p.state === 'open' ? { ...p, merged_at: null } : p)), issues, now,
      d.prs > PAGE ? Math.ceil(d.prs / PAGE) : 0, d.issues, false, { labels: meta.labels, merged })
  })
  return {
    source: 'synthetic', projects, at: new Date(now).toISOString(),
    notices: [
      'These projects are fictional, made up so the tank opens without the network. Load projects or your account to read real ones from GitHub.',
      'Features are bones, issues are small bones and the scale surface, and a merged pull request that closed an issue is a connection; a repository is not a living thing, so this mapping is a design choice, not a measurement of the code.',
    ],
  }
}
