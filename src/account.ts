// The account tank: every public repository the local GitHub CLI account owns becomes a project.
// The server reads `gh`; the browser only receives public project fields and never a token.
import { lifecycleOf, readProject, type Form, type Project, type ProjectSet } from './projects.ts'

export const ACCOUNT_LIMIT = 12 // the same cap a typed tank has; the rest are listed but not loaded

export interface AccountRepo {
  fullName: string
  name: string
  theme: string
  url: string
  created: string
  pushed: string
  archived: boolean
  topics: string[]
  fork: boolean
}

export interface Account {
  login: string
  repos: AccountRepo[]
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

// Whitelisted fields only: a token or a private field must never reach the page. Accepts a raw GitHub
// repository and the alread-whitelisted shape the local endpoint sends back.
export function publicRepo(raw: unknown): AccountRepo | null {
  const r = asRecord(raw)
  const pick = (a: string, b: string) => (typeof r[a] === 'string' ? (r[a] as string) : typeof r[b] === 'string' ? (r[b] as string) : '')
  const fullName = pick('full_name', 'fullName')
  if (!REPO.test(fullName)) return null
  const description = pick('description', 'theme')
  const url = pick('html_url', 'url')
  return {
    fullName,
    name: typeof r.name === 'string' ? r.name : fullName.split('/')[1],
    theme: description.split('\n')[0].slice(0, 120),
    url: url.startsWith('https://github.com/') ? url : '',
    created: pick('created_at', 'created'),
    pushed: pick('pushed_at', 'pushed'),
    archived: r.archived === true,
    topics: Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === 'string').slice(0, 20) : [],
    fork: r.fork === true,
  }
}

export function parseAccountPayload(body: unknown): Account {
  const b = asRecord(body)
  const login = typeof b.login === 'string' && b.login ? b.login : ''
  if (!login) throw new Error('The account endpoint did not name an account.')
  const repos = (Array.isArray(b.repos) ? b.repos : [])
    .map(publicRepo)
    .filter((r): r is AccountRepo => r !== null && r.fork === false)
  return { login, repos }
}

// The browser talks to the local dev server only; its response already holds just public fields.
export async function loadAccount(): Promise<Account> {
  const res = await fetch('/api/account')
  if (res.status === 503) throw new Error('The GitHub CLI is not signed in. Run gh auth login in a terminal, then reload the page.')
  if (!res.ok) throw new Error(`The local account endpoint returned ${res.status}.`)
  return parseAccountPayload(await res.json())
}

async function readAccountRepo(repo: AccountRepo, now: number): Promise<Project> {
  // The dev server reads through `gh`, so the token's 5,000-an-hour allowance is used, not the page's 60.
  const res = await fetch(`/api/account/repo?name=${encodeURIComponent(repo.fullName)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(typeof body.reason === 'string' ? body.reason : `The local endpoint returned ${res.status}.`)
  }
  const data = (await res.json()) as {
    pulls: { body: Record<string, unknown>[]; pages: number }; issues: Record<string, unknown>[]
    total: number | null; labels?: unknown; merged?: unknown
  }
  return readProject(repo.fullName, {
    name: repo.name, description: repo.theme, html_url: repo.url, created_at: repo.created,
    pushed_at: repo.pushed, archived: repo.archived, topics: repo.topics,
  }, data.pulls?.body ?? [], data.issues ?? [], now, data.pulls?.pages ?? 0, data.total ?? undefined, true,
  { labels: data.labels, merged: data.merged })
}

// Newest first, so a tank of twelve shows the projects that are actually being worked on.
export function pickAccountRepos(repos: AccountRepo[], limit = ACCOUNT_LIMIT): AccountRepo[] {
  return [...repos]
    .sort((a, b) => (Date.parse(b.pushed) || 0) - (Date.parse(a.pushed) || 0))
    .slice(0, limit)
}

// One worker pool, three at a time: a social GitHub account costs three requests per project.
export async function fetchAccountProjects(
  account: Account, onProgress: (done: number, total: number) => void = () => {}, now = Date.now(),
): Promise<ProjectSet> {
  const chosen = pickAccountRepos(account.repos)
  const notices: string[] = []
  const slots: (Project | string)[] = []
  let next = 0
  let done = 0
  const worker = async () => {
    for (let i = next++; i < chosen.length; i = next++) {
      try {
        slots[i] = await readAccountRepo(chosen[i], now)
      } catch (err) {
        slots[i] = `${chosen[i].fullName}: ${(err as Error).message}`
      }
      onProgress(++done, chosen.length)
    }
  }
  await Promise.all([worker(), worker(), worker()])
  const projects = slots.filter((s): s is Project => typeof s !== 'string')
  const failed = slots.filter((s): s is string => typeof s === 'string')
  if (!projects.length) throw new Error(failed[0] ?? 'No repositories were read.')
  notices.push(...failed)
  notices.push(
    `These are the public repositories owned by @${account.login}${account.repos.length > chosen.length
      ? `; the ${chosen.length} most recently pushed of ${account.repos.length} are shown`
      : ''}. Each costs three GitHub requests, read through the local GitHub CLI and its token allowance.`,
  )
  notices.push('Loading one project does not stop the others: a failure above leaves that project out and the rest in place.')
  notices.push('Features are bones, issues are small bones and the scale surface, and a merged pull request that closed an issue is a connection; a repository is not a living thing, so this mapping is a design choice, not a measurement of the code.')
  if (projects.some((p) => !p.prs.exact || !p.issues.exact)) {
    notices.push('Only the latest 100 pull requests and issues of each project are drawn; totals marked "about" or "up to" are not exact counts.')
  }
  return { source: 'recorded', projects, notices, at: new Date(now).toISOString() }
}

// Finished is a repository topic; writing it changes GitHub metadata, so it is a separate, explicit call.
export async function saveFinished(repo: string, finished: boolean, form: Form): Promise<string[]> {
  const res = await fetch('/api/finished', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, finished, form }),
  })
  const body = asRecord(await res.json().catch(() => ({})))
  if (!res.ok) throw new Error(typeof body.reason === 'string' ? body.reason : `The local endpoint returned ${res.status}.`)
  return Array.isArray(body.topics) ? body.topics.filter((t): t is string => typeof t === 'string') : []
}

// Where a project's upkeep would land with a different topic set: used by the panel and by the endpoint's reply.
export function upkeepWith(project: Project, topics: string[], now = Date.now()): Pick<Project, 'lifecycle' | 'form' | 'finished' | 'speed' | 'quietDays'> {
  return lifecycleOf({ archived: project.archived, pushed_at: project.pushed, topics }, now)
}


// Only the page itself may write topics. Another website can POST to localhost too, but only as text/plain or a
// form (anything else needs a CORS preflight, which Vite refuses for other origins), and its browser marks the
// request cross-site. Requests without fetch metadata (curl, old browsers) are refused as well.
export function writeAllowed(headers: Record<string, string | string[] | undefined>): boolean {
  const type = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  return type === 'application/json' && headers['sec-fetch-site'] === 'same-origin'
}
