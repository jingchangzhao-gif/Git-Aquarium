import { describe, expect, it, vi } from 'vitest'
import { checkOf, PULL_CAP, readPulls, reviewOf, sizeOfLines } from './pulls'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 0, 10)

describe('sizeOfLines', () => {
  it('grows on a log scale and stops at the cap', () => {
    expect(sizeOfLines(0)).toBeCloseTo(0.6)
    expect(sizeOfLines(2000)).toBeCloseTo(1.1)
    expect(sizeOfLines(50_000)).toBeCloseTo(1.1)
    expect(sizeOfLines(100)).toBeGreaterThan(0.6)
    expect(sizeOfLines(100)).toBeLessThan(1.1)
  })
})

describe('checkOf', () => {
  it('lets a failure outrank a run still in progress', () => {
    expect(checkOf([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'failure' }])).toBe('fail')
  })

  it('reads pending, passing, and empty sets', () => {
    expect(checkOf([{ status: 'queued', conclusion: null }])).toBe('pending')
    expect(checkOf([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }])).toBe('pass')
    expect(checkOf([])).toBe('none')
    expect(checkOf(null)).toBe('none')
    // Unknown conclusions are not a pass.
    expect(checkOf([{ status: 'completed', conclusion: 'stale' }])).toBe('none')
  })
})

describe('reviewOf', () => {
  it('puts a requested review first', () => {
    expect(reviewOf([{ state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' }], true)).toBe('requested')
  })

  it('reads the latest decisive review', () => {
    expect(reviewOf([
      { state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' },
      { state: 'CHANGES_REQUESTED', submitted_at: '2026-01-02T00:00:00Z' },
    ], false)).toBe('changes')
    expect(reviewOf([{ state: 'APPROVED', submitted_at: '2026-01-02T00:00:00Z' }], false)).toBe('approved')
    expect(reviewOf([{ state: 'COMMENTED', submitted_at: '2026-01-02T00:00:00Z' }], false)).toBe('none')
    expect(reviewOf(null, false)).toBe('none')
  })
})

describe('readPulls', () => {
  const json = (body: unknown, link?: string) =>
    new Response(JSON.stringify(body), { status: 200, headers: link ? { link } : {} })

  it('measures each drawn pull request and closes the set with notices', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/pulls?state=open')) {
        return json([
          { number: 12, title: 'Fix the pump', user: { login: 'ada' }, html_url: 'https://github.com/o/r/pull/12', created_at: '2025-12-01T00:00:00Z', updated_at: new Date(NOW - 9 * DAY).toISOString(), head: { sha: 'abc' }, requested_reviewers: [] },
          { number: 11, title: 'Coral cache', user: { login: 'bo' }, html_url: 'https://github.com/o/r/pull/11', created_at: '2025-12-02T00:00:00Z', updated_at: new Date(NOW - 1 * DAY).toISOString(), head: { sha: 'def' }, requested_reviewers: [{ login: 'cy' }] },
        ], '<https://api.github.com/repositories/1/pulls?page=2>; rel="last"')
      }
      if (url.includes('/pulls/12/reviews')) return json([{ state: 'APPROVED', submitted_at: '2026-01-05T00:00:00Z' }])
      if (url.includes('/pulls/11/reviews')) return json([])
      if (url.includes('/pulls/12')) return json({ additions: 120, deletions: 30 })
      if (url.includes('/pulls/11')) return json({ additions: 2, deletions: 1 })
      if (url.includes('/commits/abc/check-runs')) return json({ check_runs: [{ status: 'completed', conclusion: 'success' }] })
      if (url.includes('/commits/def/check-runs')) return json({ check_runs: [{ status: 'completed', conclusion: 'failure' }] })
      return json({})
    }))
    try {
      const set = await readPulls('o/r', NOW)
      expect(set.pulls).toHaveLength(2)
      expect(set.total).toBe(200) // page 2 at 100 per page: a lower bound
      const [newest, older] = set.pulls
      expect(newest).toMatchObject({ number: 12, author: 'ada', lines: 150, checks: 'pass', review: 'approved', staleDays: 9 })
      expect(older).toMatchObject({ number: 11, checks: 'fail', review: 'requested', staleDays: 1 })
      expect(older.size).toBeLessThan(newest.size)
      expect(set.notices.some((n) => n.includes('most recently updated'))).toBe(true)
      expect(set.notices.some((n) => n.includes('unknown'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('says unknown, not passing, when a check request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/pulls?state=open')) {
        return json([{ number: 3, title: 'One', user: { login: 'a' }, html_url: 'https://github.com/o/r/pull/3', created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-02T00:00:00Z', head: { sha: 'x' } }])
      }
      if (url.includes('/check-runs')) return new Response('{}', { status: 403 })
      if (url.includes('/reviews')) return new Response('{}', { status: 403 })
      if (url.includes('/pulls/3')) return json({ additions: 1, deletions: 0 })
      return json({})
    }))
    try {
      const set = await readPulls('o/r', NOW)
      expect(set.pulls[0].checks).toBe('none')
      expect(set.notices.some((n) => n.includes('unknown, not passing'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it(`draws at most ${PULL_CAP} pull requests`, async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      number: i + 1, title: `PR ${i + 1}`, user: { login: 'a' }, html_url: 'https://github.com/o/r/pull/1',
      created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-02T00:00:00Z', head: { sha: 'x' },
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/pulls?state=open')) return json(many)
      if (url.includes('/check-runs')) return json({ check_runs: [] })
      if (url.includes('/reviews')) return json([])
      return json({ additions: 0, deletions: 0 })
    }))
    try {
      const set = await readPulls('o/r', NOW)
      expect(set.pulls).toHaveLength(PULL_CAP)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('throws when the repository is not readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    try {
      await expect(readPulls('o/r', NOW)).rejects.toThrow(/rate limit/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
