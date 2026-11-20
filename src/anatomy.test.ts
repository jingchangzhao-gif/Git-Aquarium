import { describe, expect, it } from 'vitest'
import {
  MERGED_QUERY, anatomyOf, displayName, featureId, featureSlug, issueId, pullId, repositoryFeatures, scaleId,
  scaleTint, visibleIssues,
} from './anatomy'

const label = (name: string) => ({ name })

function issue(number: number, state: 'open' | 'closed', labels: string[], at = '2026-01-0' + (number % 9 + 1)) {
  return { number, state, title: `Issue ${number}`, html_url: `https://github.com/o/r/issues/${number}`, created_at: at, labels: labels.map(label) }
}

function merged(number: number, closes: number[], at = '2026-02-01') {
  return { number, title: `Pull ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt: at, closes }
}

describe('feature slugs', () => {
  it('reads only feature: labels, normalized to a stable slug', () => {
    expect(featureSlug('feature: Web UI')).toBe('web-ui')
    expect(featureSlug('  FEATURE:parser ')).toBe('parser')
    expect(featureSlug('area: parser')).toBeNull()
    expect(featureSlug('feature:   ')).toBeNull()
    expect(displayName('web-ui')).toBe('Web Ui')
  })

  it('deduplicates and sorts labels so a repository order cannot change the bones', () => {
    expect(repositoryFeatures(['feature:b', 'Bug', label('feature: A'), 'feature:a'])).toEqual(['a', 'b'])
    expect(repositoryFeatures(undefined)).toEqual([])
  })
})

describe('anatomy', () => {
  it('gives a repository without feature labels one General bone and no conflict', () => {
    const a = anatomyOf('o/r', { labels: ['bug'], issues: [issue(1, 'open', ['bug']), issue(2, 'closed', [])], merged: [] })
    expect(a.features.map((f) => f.slug)).toEqual(['general'])
    expect(a.issues.every((i) => i.featureId === a.generalId)).toBe(true)
    expect(a.conflicts).toBe(0)
    expect(a.unclassified).toBe(0)
  })

  it('puts an issue on the feature its label names', () => {
    const a = anatomyOf('o/r', {
      labels: ['feature:parser', 'feature:web-ui'],
      issues: [issue(1, 'open', ['feature:parser']), issue(2, 'open', ['feature:web-ui', 'bug'])],
      merged: [],
    })
    expect(a.features.map((f) => f.slug)).toEqual(['general', 'parser', 'web-ui'])
    expect(a.issues[0].featureId).toBe(featureId('o/r', 'parser'))
    expect(a.issues[1].featureId).toBe(featureId('o/r', 'web-ui'))
    expect(a.issues[0].id).toBe(issueId('o/r', 1))
    expect(a.conflicts).toBe(0)
  })

  it('falls back to General, visibly, when an issue has no label or several feature labels', () => {
    const a = anatomyOf('o/r', {
      labels: ['feature:a', 'feature:b'],
      issues: [issue(1, 'open', []), issue(2, 'open', ['feature:a', 'feature:b'])],
      merged: [],
    })
    expect(a.issues[0].featureId).toBe(a.generalId)
    expect(a.issues[1].featureId).toBe(a.generalId)
    expect(a.issues[1].conflict).toBe(true)
    expect(a.unclassified).toBe(2)
    expect(a.conflicts).toBe(1)
  })

  it('keeps the overview within its feature and open-issue limits while counting what is hidden', () => {
    const labels = ['feature:a', 'feature:b', 'feature:c', 'feature:d', 'feature:e', 'feature:f', 'feature:g', 'feature:h']
    const issues = [1, 2, 3, 4, 5].map((n) => issue(n, 'open', ['feature:a']))
    const a = anatomyOf('o/r', { labels, issues, merged: [] })
    expect(a.features.filter((f) => f.slug === 'other')).toHaveLength(1)
    expect(a.hiddenFeatures).toBe(2) // g and h share the Other bone
    expect(a.features).toHaveLength(8) // General, six named features, Other
    expect(visibleIssues(a)).toHaveLength(2) // per-feature overview limit
    expect(a.hiddenIssues).toBe(3)
    expect(a.issues).toHaveLength(5) // nothing is dropped from the data
  })

  it('links only merged pull requests that GitHub reports as closing an issue', () => {
    const a = anatomyOf('o/r', {
      labels: ['feature:a'],
      issues: [issue(1, 'open', ['feature:a']), issue(2, 'closed', ['feature:a'])],
      merged: [merged(10, [1, 2]), merged(11, [99]), merged(12, [])],
    })
    expect(a.links.map((l) => l.number)).toEqual([10])
    expect(a.links[0].id).toBe(pullId('o/r', 10))
    expect(a.links[0].issueIds).toEqual([issueId('o/r', 1), issueId('o/r', 2)])
  })

  it('reads the GraphQL closing reference shape too', () => {
    const a = anatomyOf('o/r', {
      labels: ['feature:a'],
      issues: [issue(7, 'closed', ['feature:a'])],
      merged: [{ number: 20, title: 'Fix', url: 'https://github.com/o/r/pull/20', mergedAt: '2026-03-01', closingIssuesReferences: [{ number: 7 }] }],
    })
    expect(a.links[0].issueIds).toEqual([issueId('o/r', 7)])
  })

  it('keeps ids stable when the input order or time changes', () => {
    const one = anatomyOf('o/r', { labels: ['feature:b', 'feature:a'], issues: [issue(2, 'open', ['feature:b']), issue(1, 'open', ['feature:a'])], merged: [] })
    const two = anatomyOf('o/r', { labels: ['feature:a', 'feature:b'], issues: [issue(1, 'open', ['feature:a']), issue(2, 'open', ['feature:b'])], merged: [] })
    expect(one.features).toEqual(two.features)
    expect(one.issues.map((i) => i.id).sort()).toEqual(two.issues.map((i) => i.id).sort())
    expect(scaleId('o/r', 'a', 2)).toBe('o/r#scale:a:2')
  })

  it('moves no issue when only the updated time changes', () => {
    const before = anatomyOf('o/r', { labels: ['feature:a'], issues: [issue(3, 'open', ['feature:a'], '2026-01-01')], merged: [] })
    const after = anatomyOf('o/r', { labels: ['feature:a'], issues: [issue(3, 'open', ['feature:a'], '2026-05-01')], merged: [] })
    expect(after.issues[0].featureId).toBe(before.issues[0].featureId)
    expect(after.issues[0].id).toBe(before.issues[0].id)
  })
})

describe('scale surface', () => {
  it('tints scales monotonically and returns to the base surface with no open issue', () => {
    expect(scaleTint(0)).toEqual({ mix: 0, roughness: 0.35 })
    expect(scaleTint(2).mix).toBeGreaterThan(scaleTint(1).mix)
    expect(scaleTint(10).mix).toBe(1)
    expect(scaleTint(-3).mix).toBe(0)
    expect(scaleTint(4).roughness).toBeGreaterThan(scaleTint(1).roughness)
  })
})

it('the merged pull request query asks for the newest page, not the oldest', () => {
  const args = /pullRequests\(([^)]*\{[^}]*\}[^)]*)\)/.exec(MERGED_QUERY)?.[1] ?? ''
  const newest = /first:100/.test(args) && /direction:DESC/.test(args) || /last:100/.test(args) && /direction:ASC/.test(args)
  expect(args).toContain('states:MERGED')
  expect(newest).toBe(true) // last:100 with DESC returned vitejs/vite merges from 2020, not 2026
})
