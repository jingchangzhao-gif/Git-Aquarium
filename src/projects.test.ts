import { describe, expect, it, vi } from 'vitest'
import {
  FINISHED_TOPIC, countIssues, countPulls, demoProjects, fetchProjects, formTopic, healthOf, lifecycleOf, parseLastPage,
  parseRepos, readProject, sizeOf, topicChange, type Issue, type Pull,
} from './projects'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 0, 1)

describe('parseRepos', () => {
  it('accepts short names, URLs, and a mix', () => {
    expect(parseRepos('vitejs/vite\nhttps://github.com/sveltejs/svelte')).toEqual(['vitejs/vite', 'sveltejs/svelte'])
    expect(parseRepos('https://github.com/denoland/deno.git, vuejs/core')).toEqual(['denoland/deno', 'vuejs/core'])
  })

  it('collapses duplicates and keeps the first spelling', () => {
    expect(parseRepos('vitejs/vite, ViteJS/Vite')).toEqual(['vitejs/vite'])
  })

  it('rejects empty, malformed, and oversized input', () => {
    expect(() => parseRepos('  ')).toThrow(/at least one/)
    expect(() => parseRepos('not a repo')).toThrow(/not a public repository/)
    expect(() => parseRepos(Array.from({ length: 13 }, (_, i) => `owner/repo${i}`).join(' '))).toThrow(/Up to 12/)
  })
})

describe('parseLastPage', () => {
  it('reads the last page and ignores other links', () => {
    const link = '<https://api.github.com/repos/a/b/pulls?page=2>; rel="next", <https://api.github.com/repos/a/b/pulls?page=13>; rel="last"'
    expect(parseLastPage(link)).toBe(13)
    expect(parseLastPage(null)).toBe(0)
    expect(parseLastPage('<https://api.github.com/x?page=2>; rel="next"')).toBe(0)
  })
})

describe('sizeOf', () => {
  it('grows with size and stops at the cap', () => {
    expect(sizeOf(0)).toBeCloseTo(0.55)
    expect(sizeOf(32_767)).toBeCloseTo(1.35)
    expect(sizeOf(1_000_000)).toBeCloseTo(1.35)
    expect(sizeOf(10)).toBeGreaterThan(0.55)
    expect(sizeOf(20_500) - sizeOf(300)).toBeGreaterThan(0.3) // a small and a very large project still look different
  })
})

describe('lifecycleOf', () => {
  const at = (days: number) => new Date(NOW - days * DAY).toISOString()
  it('turns quiet months into slowing, seaweed, and rock', () => {
    expect(lifecycleOf({ archived: false, pushed_at: at(10) }, NOW)).toMatchObject({ lifecycle: 'active', speed: 1 })
    expect(lifecycleOf({ archived: false, pushed_at: at(90) }, NOW)).toMatchObject({ lifecycle: 'active', speed: 1 })
    expect(lifecycleOf({ archived: false, pushed_at: at(91) }, NOW)).toMatchObject({ lifecycle: 'slowing', quietDays: 91 })
    expect(lifecycleOf({ archived: false, pushed_at: at(180) }, NOW)).toMatchObject({ lifecycle: 'seaweed', form: 'seaweed', speed: 0 })
    expect(lifecycleOf({ archived: false, pushed_at: at(365) }, NOW)).toMatchObject({ lifecycle: 'seaweed', quietDays: 365 })
    expect(lifecycleOf({ archived: false, pushed_at: at(366) }, NOW)).toMatchObject({ lifecycle: 'rock', form: 'rock' })
    expect(lifecycleOf({ archived: true, pushed_at: at(1) }, NOW)).toMatchObject({ lifecycle: 'rock', form: 'rock' })
    expect(lifecycleOf({ archived: false }, NOW)).toMatchObject({ lifecycle: 'unknown', quietDays: null, speed: 0.4 })
  })

  it('lets an explicit finished setting win over quiet months', () => {
    const finished = lifecycleOf({ archived: false, pushed_at: at(500), topics: [FINISHED_TOPIC, formTopic('seaweed')] }, NOW)
    expect(finished).toMatchObject({ lifecycle: 'finished', form: 'seaweed', speed: 0, finished: true })
    expect(lifecycleOf({ archived: false, pushed_at: at(500), topics: [FINISHED_TOPIC] }, NOW)).toMatchObject({ lifecycle: 'finished', form: 'fish' })
    expect(lifecycleOf({ archived: false, pushed_at: at(500), topics: ['unrelated'] }, NOW).lifecycle).toBe('rock')
  })

  it('changes topics without disturbing the others', () => {
    const set = topicChange(['docs', 'aquarium-finished', 'aquarium-form-rock'], true, 'seaweed')
    expect(set).toEqual(['docs', FINISHED_TOPIC, 'aquarium-form-seaweed'])
    expect(topicChange(set, false, 'fish')).toEqual(['docs'])
  })
})

describe('counts', () => {
  it('counts pull request states', () => {
    const pulls: Pull[] = [
      { number: 1, title: '', state: 'merged', at: '', url: '' },
      { number: 2, title: '', state: 'open', at: '', url: '' },
      { number: 3, title: '', state: 'closed', at: '', url: '' },
    ]
    expect(countPulls(pulls)).toEqual({ open: 1, merged: 1, closed: 1 })
  })

  it('counts open and question issues', () => {
    const issues: Issue[] = [
      { number: 1, title: '', open: true, question: true, labels: [], comments: 0, at: '', url: '' },
      { number: 2, title: '', open: true, question: false, labels: [], comments: 0, at: '', url: '' },
      { number: 3, title: '', open: false, question: false, labels: [], comments: 0, at: '', url: '' },
    ]
    expect(countIssues(issues)).toEqual({ open: 2, question: 1 })
  })
})

describe('readProject', () => {
  const meta = {
    name: 'vite', description: 'Next generation frontend tooling', html_url: 'https://github.com/vitejs/vite',
    created_at: '2020-01-01T00:00:00Z', pushed_at: new Date(NOW - 5 * DAY).toISOString(),
    archived: false,
  }

  it('maps pull requests to bones, issues to scales, and keeps only GitHub links', () => {
    const p = readProject('vitejs/vite', meta, [
      { number: 1, title: 'feat: add server', state: 'open', created_at: '2025-12-01T00:00:00Z', html_url: 'https://github.com/vitejs/vite/pull/1' },
      { number: 2, title: 'fix: merge', state: 'closed', merged_at: '2025-12-02T00:00:00Z', created_at: '2025-12-01T00:00:00Z', html_url: 'javascript:alert(1)' },
    ], [
      { number: 3, title: 'Bug report', state: 'open', created_at: '2025-12-01T00:00:00Z', html_url: 'https://github.com/vitejs/vite/issues/3' },
      { number: 4, title: 'Question', state: 'open', labels: [{ name: 'question' }], created_at: '2025-12-01T00:00:00Z', html_url: 'https://github.com/vitejs/vite/issues/4' },
      { number: 5, title: 'A pull request in the issues list', state: 'open', pull_request: {}, created_at: '2025-12-01T00:00:00Z' },
    ], NOW)
    expect(p.prs.recent.map((x) => x.state)).toEqual(['open', 'merged'])
    expect(p.prs.recent[1].url).toBe('')
    expect(p.issues.recent.map((x) => x.question)).toEqual([false, true])
    expect(p.theme).toBe('Next generation frontend tooling')
    expect(p.lifecycle).toBe('active')
  })

  it('falls back to the repository name when there is no description', () => {
    const p = readProject('vitejs/vite', { ...meta, description: null }, [], [], NOW)
    expect(p.theme).toBe('vite')
    expect(p.prs).toMatchObject({ total: 0, exact: true })
    expect(p.size).toBeCloseTo(0.55)
  })

  it('estimates totals when the lists were cut off, and says they are estimates', () => {
    // 96 pages of pull requests, and a full page of the issues list whose newest entry is number 21000.
    const pulls = Array.from({ length: 100 }, (_, i) => ({ number: 20_990 - 2 * i, state: 'open', created_at: '2025-12-01T00:00:00Z' }))
    const items = Array.from({ length: 100 }, (_, i) => ({ number: 21_000 - i, state: 'open', created_at: '2025-12-01T00:00:00Z', ...(i % 2 ? { pull_request: {} } : {}) }))
    const p = readProject('vitejs/vite', meta, pulls, items, NOW, 96)
    expect(p.prs).toMatchObject({ total: 9600, exact: false }) // 96 pages of 100: right to within a page
    expect(p.issues.recent).toHaveLength(50) // the pull requests mixed into the list are not issues
    expect(p.issues).toMatchObject({ total: 11_500, exact: false }) // a limit: 21000 numbers less about 9600 pull requests
    expect(p.size).toBeCloseTo(sizeOf(9600))
    // With the exact count from search, that is the total, however the numbering looks.
    expect(readProject('vitejs/vite', meta, pulls, items, NOW, 96, 8935).issues).toMatchObject({ total: 8935, exact: true })

    const small = readProject('vitejs/vite', meta, pulls.slice(0, 3), items.slice(0, 10), NOW)
    expect(small.prs).toMatchObject({ total: 3, exact: true })
    expect(small.issues).toMatchObject({ total: 5, exact: true })
  })
})

describe('fetchProjects', () => {
  const json = (body: unknown, link?: string) =>
    new Response(JSON.stringify(body), { status: 200, headers: link ? { link } : {} })

  it('reads each repository and reports the ones that failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/repos/missing/repo')) return new Response('{}', { status: 404 })
      if (url.includes('/repos/good/repo/pulls')) {
        return json([{ number: 1, title: 'PR', state: 'open', created_at: '2025-12-01T00:00:00Z', html_url: 'https://github.com/good/repo/pull/1' }],
          '<https://api.github.com/repositories/1/pulls?page=3>; rel="last"')
      }
      if (url.includes('/repos/good/repo/issues')) return json([])
      if (url.includes('/search/issues')) return url.includes('good') ? json({ total_count: 42 }) : new Response('{}', { status: 403 })
      return json({
        name: 'repo', description: 'A repo', html_url: 'https://github.com/good/repo',
        created_at: '2020-01-01T00:00:00Z', pushed_at: new Date(NOW - 2 * DAY).toISOString(), archived: false,
      })
    }))
    try {
      const set = await fetchProjects('missing/repo good/repo', NOW)
      expect(set.projects).toHaveLength(1)
      expect(set.projects[0].prs).toMatchObject({ total: 300, exact: false }) // page 3 at 100 per page: 201 to 300
      expect(set.projects[0].issues).toMatchObject({ total: 42, exact: true }) // the exact count from search
      expect(set.notices.some((n) => n.includes('missing/repo') && n.includes('not found'))).toBe(true)
      expect(set.notices.some((n) => n.includes('design choice'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('throws when every repository fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    try {
      await expect(fetchProjects('vitejs/vite', NOW)).rejects.toThrow(/rate limit/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the health card', () => {
  const iso = (days: number) => new Date(NOW - days * DAY).toISOString()
  it('reads age, upkeep, skeleton, and scales from the records', () => {
    const p = readProject('o/r', { created_at: iso(730), pushed_at: iso(3) }, [
      { number: 4, state: 'open', created_at: iso(5) },
      { number: 3, state: 'closed', merged_at: iso(9), created_at: iso(10) },
      { number: 2, state: 'closed', merged_at: iso(99), created_at: iso(100) },
      { number: 1, state: 'closed', merged_at: null, created_at: iso(200) },
    ], [
      { number: 8, state: 'open', comments: 0, created_at: iso(40) }, // over 30 days, nobody answered
      { number: 7, state: 'open', comments: 0, created_at: iso(10) }, // too new to count as unanswered
      { number: 6, state: 'open', comments: 2, created_at: iso(60) },
      { number: 5, state: 'closed', comments: 1, created_at: iso(70) },
    ], NOW)
    const h = healthOf(p, NOW)
    expect(h.years).toBeCloseTo(2, 1)
    expect(h.lastUpdate).toBe(3)
    expect(h.opened).toEqual({ pulls: 2, issues: 4, atLeast: false })
    expect(h.merged).toBeCloseTo(2 / 3)
    expect(h.complete).toBe(0.25)
    expect(h.unanswered).toBe(1)
  })

  it('says "at least" when the latest 100 do not reach back 90 days, and has no ratio without records', () => {
    const busy = readProject('o/r', {}, Array.from({ length: 100 }, (_, i) => ({ number: i, state: 'open', created_at: iso(i / 10) })), [], NOW)
    expect(healthOf(busy, NOW).opened).toEqual({ pulls: 100, issues: 0, atLeast: true })
    expect(healthOf(busy, NOW).merged).toBeNull()
    expect(healthOf(busy, NOW).complete).toBeNull()
  })
})

describe('the offline demo tank', () => {
  it('needs no network and shows every kind of upkeep', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const set = demoProjects(NOW)
    vi.unstubAllGlobals()
    expect(fetch).not.toHaveBeenCalled()
    expect(set.source).toBe('synthetic')
    expect(set.projects.map((p) => p.lifecycle)).toEqual(['active', 'active', 'active', 'slowing', 'seaweed', 'rock', 'rock', 'finished'])
    expect(set.projects.find((p) => p.repo === 'demo/anchor')).toMatchObject({ archived: true, lifecycle: 'rock' })
    expect(set.projects.find((p) => p.repo === 'demo/ledger')).toMatchObject({ lifecycle: 'finished', form: 'fish', finished: true })
    const tidy = healthOf(set.projects[1], NOW), piling = healthOf(set.projects[2], NOW)
    expect(tidy.complete!).toBeGreaterThan(0.85) // the tidy tool's scales are nearly whole...
    expect(piling.complete!).toBeLessThan(0.6) // ...the popular one's are not,
    expect(piling.unanswered).toBeGreaterThan(tidy.unanswered) // and its questions wait unanswered
    expect(demoProjects(NOW)).toEqual(set) // the same every time
  })
})
