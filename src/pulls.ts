// Turns open pull requests into fish-sized measurements. No DOM, no three, no storage.
import { get } from './projects'

export type Check = 'pass' | 'fail' | 'pending' | 'none'
export type Review = 'requested' | 'approved' | 'changes' | 'none'

export interface PullSummary {
  number: number
  title: string
  author: string
  url: string
  created: string
  updated: string
  draft: boolean
  lines: number // additions + deletions, 0 when the detail request failed
  checks: Check
  review: Review
  staleDays: number
  size: number // 0.6..1.1 scene scale
}

export interface PullSet {
  repo: string
  pulls: PullSummary[] // the drawn set, most recently updated first
  total: number // open pull requests, a lower bound when the list was cut off
  notices: string[]
  at: number
}

export const PULL_CAP = 8
export const STALE_DAYS = 7
const MAX_LINES = 2000
const DAY = 86_400_000

type Json = { [key: string]: unknown }
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === 'object') : [])
const text = (v: unknown, max = 120): string => (typeof v === 'string' ? v.split('\n')[0].slice(0, max) : '')
const link = (v: unknown): string => (typeof v === 'string' && v.startsWith('https://github.com/') ? v : '')
const date = (v: unknown): string => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// Bigger diffs are longer fish, on a log scale so one huge pull request cannot fill the tank.
export function sizeOfLines(lines: number): number {
  const clamped = Math.min(MAX_LINES, Math.max(0, lines))
  return 0.6 + 0.5 * (Math.log2(1 + clamped) / Math.log2(1 + MAX_LINES))
}

// A failure anywhere outranks a run still in progress; an empty set is not success.
export function checkOf(runs: Json[] | null): Check {
  if (!runs || runs.length === 0) return 'none'
  const failed = runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(text(r.conclusion, 40)))
  if (failed) return 'fail'
  const pending = runs.some((r) => ['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(text(r.status, 40)))
  if (pending) return 'pending'
  const passed = runs.every((r) => ['success', 'neutral', 'skipped'].includes(text(r.conclusion, 40)))
  return passed ? 'pass' : 'none'
}

// Who is waiting: a pending request wins; otherwise the latest decisive review.
export function reviewOf(reviews: Json[] | null, requested: boolean): Review {
  if (requested) return 'requested'
  if (!reviews || reviews.length === 0) return 'none'
  const decisive = reviews
    .filter((r) => ['APPROVED', 'CHANGES_REQUESTED'].includes(text(r.state, 30)))
    .sort((a, b) => Date.parse(date(b.submitted_at)) - Date.parse(date(a.submitted_at)))[0]
  if (!decisive) return 'none'
  return text(decisive.state, 30) === 'APPROVED' ? 'approved' : 'changes'
}

// One repository's open pull requests, newest activity first, enriched for the drawn set only.
export async function readPulls(repo: string, now = Date.now()): Promise<PullSet> {
  const opening = await get(`/repos/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`)
  const raw = list(opening.body).slice(0, PULL_CAP)
  const notices: string[] = []
  let unknown = 0

  const pulls = await Promise.all(raw.map(async (p) => {
    const number = num(p.number)
    const requested = list(p.requested_reviewers).length > 0
    const head = obj(p.head)
    const sha = text(head.sha, 100)
    const [detail, reviews, runs] = await Promise.all([
      get(`/repos/${repo}/pulls/${number}`).catch(() => null),
      get(`/repos/${repo}/pulls/${number}/reviews?per_page=30`).catch(() => null),
      sha ? get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`).catch(() => null) : null,
    ])
    if (!detail || !reviews) unknown++
    const updated = date(p.updated_at)
    const staleDays = updated ? Math.max(0, Math.floor((now - Date.parse(updated)) / DAY)) : 0
    const lines = num(obj(detail?.body).additions) + num(obj(detail?.body).deletions)
    return {
      number,
      title: text(p.title),
      author: text(obj(p.user).login, 60),
      url: link(p.html_url),
      created: date(p.created_at),
      updated,
      draft: p.draft === true,
      lines,
      checks: runs ? checkOf(list(obj(runs.body).check_runs)) : 'none',
      review: reviewOf(reviews ? list(reviews.body) : null, requested),
      staleDays,
      size: sizeOfLines(lines),
    } satisfies PullSummary
  }))

  const total = opening.pages ? opening.pages * 100 : raw.length
  notices.push('Only the most recently updated open pull requests were inspected; the counts cover those.')
  if (unknown > 0) notices.push(`Check runs or reviews were unavailable for ${unknown} pull requests; they show as unknown, not passing.`)
  notices.push('Open pull requests only: merged and closed ones are not drawn.')
  return { repo, pulls, total, notices, at: now }
}
