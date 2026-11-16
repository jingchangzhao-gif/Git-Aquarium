import { describe, expect, it, vi } from 'vitest'
import {
  countIssues, countPulls, fetchProjects, lifecycleOf, parseLastPage, parseRepos, readProject, sizeOf,
  type Issue, type Pull,
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
    expect(sizeOf(0)).toBeCloseTo(0.65)
    expect(sizeOf(256)).toBeCloseTo(1.2)
    expect(sizeOf(1000)).toBeCloseTo(1.2)
    expect(sizeOf(10)).toBeGreaterThan(0.65)
  })
})

describe('lifecycleOf', () => {
  const at = (days: number) => new Date(NOW - days * DAY).toISOString()
  it('separates active, quiet, and abandoned work', () => {
    expect(lifecycleOf({ archived: false, pushed_at: at(10) }, NOW).lifecycle).toBe('active')
    expect(lifecycleOf({ archived: false, pushed_at: at(91) }, NOW)).toMatchObject({ lifecycle: 'quiet', quietDays: 91 })
    expect(lifecycleOf({ archived: false, pushed_at: at(366) }, NOW).lifecycle).toBe('abandoned')
    expect(lifecycleOf({ archived: true, pushed_at: at(1) }, NOW).lifecycle).toBe('abandoned')
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
      { number: 1, title: '', open: true, question: true, at: '', url: '' },
      { number: 2, title: '', open: true, question: false, at: '', url: '' },
      { number: 3, title: '', open: false, question: false, at: '', url: '' },
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
    expect(p.prs.total).toBe(0)
    expect(p.size).toBeCloseTo(0.65)
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
      return json({
        name: 'repo', description: 'A repo', html_url: 'https://github.com/good/repo',
        created_at: '2020-01-01T00:00:00Z', pushed_at: new Date(NOW - 2 * DAY).toISOString(), archived: false,
      })
    }))
    try {
      const set = await fetchProjects('good/repo missing/repo', NOW)
      expect(set.projects).toHaveLength(1)
      expect(set.projects[0].prs.total).toBe(300) // page 3 at 100 per page: a lower bound
      expect(set.projects[0].issues.total).toBe(0)
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
