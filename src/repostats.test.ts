import { describe, expect, it } from 'vitest'
import { repositoryStats } from './repostats'
import type { GitEvent } from './sim'

const DAY = 86_400_000
const start = Date.UTC(2026, 0, 1) // 2026-01-01T00:00:00Z
const day = (n: number) => new Date(start + n * DAY).toISOString()

const ev = (over: Partial<GitEvent>): GitEvent => ({
  tick: 0, at: day(0), kind: 'COMMIT_OBSERVED', id: 'a1', title: '', url: null, branches: ['main'], lineage: 0, group: '', ...over,
})

const commit = (id: string, n: number, branch = 'main') => ev({ id, at: day(n), branches: [branch] })
const opened = (id: string, n: number, branch = 'feature') => ev({ id, at: day(n), kind: 'PR_OPENED', title: `PR ${id}`, branches: [branch, 'main'], group: '' })
const merged = (id: string, n: number, branch = 'feature') => ev({ id, at: day(n), kind: 'PR_MERGED', title: `PR ${id}`, branches: [branch, 'main'], group: '' })
const failed = (id: string, n: number, group = 'ci@main', title = 'ci: failure') => ev({ id, at: day(n), kind: 'CI_FAILED', title, branches: [group.split('@')[1] ?? 'main'], group })
const passed = (id: string, n: number, group = 'ci@main', title = 'ci: success') => ev({ id, at: day(n), kind: 'CI_PASSED', title, branches: [group.split('@')[1] ?? 'main'], group })

describe('repositoryStats', () => {
  it('returns empty statistics for an empty window', () => {
    const stats = repositoryStats([])
    expect(stats.from).toBe('')
    expect(stats.to).toBe('')
    expect(stats.counts.commits).toBe(0)
    expect(stats.stuck).toEqual([])
    expect(stats.workflows).toEqual([])
    expect(stats.flaky).toEqual([])
    expect(stats.merges.median).toBeNull()
  })

  it('compares the last seven days of the window with the seven before them', () => {
    const stats = repositoryStats([
      commit('a', 8), // previous week
      commit('b', 9),
      commit('c', 13), // recent week
      commit('d', 18),
      commit('e', 19),
    ])
    expect(stats.to).toBe(day(19))
    expect(stats.week.recent.commits).toBe(3)
    expect(stats.week.previous.commits).toBe(2)
    expect(stats.counts.commits).toBe(5)
  })

  it('lists pull requests that opened inside the window and never merged', () => {
    const stats = repositoryStats([commit('a', 1), opened('7', 2), opened('8', 3), merged('8', 9)])
    expect(stats.stuck.map((p) => p.number)).toEqual(['7'])
    expect(stats.stuck[0].branch).toBe('feature')
    expect(stats.stuck[0].days).toBe(7) // the newest record is the merge on day 9
    expect(stats.merges.merged).toBe(1)
  })

  it('groups CI runs by workflow and branch and reports the failure rate', () => {
    const stats = repositoryStats([
      failed('10', 1), failed('11', 3), passed('12', 4), passed('13', 5, 'ci@dev', 'ci: success'),
    ])
    const ci = stats.workflows.find((w) => w.group === 'ci@main')!
    expect(ci.name).toBe('ci')
    expect(ci.failed).toBe(2)
    expect(ci.passed).toBe(1)
    expect(ci.rate).toBeCloseTo(2 / 3)
    expect(ci.lastFailure).toBe(day(3))
    expect(ci.refs[0]).toBe('CI_FAILED:11') // newest failure first
  })

  it('calls a workflow flaky only when a pass follows a failure with no commit in between', () => {
    const flaky = repositoryStats([failed('20', 1), passed('21', 2)])
    expect(flaky.flaky[0].times).toBe(1)
    expect(flaky.flaky[0].refs).toEqual(['CI_FAILED:20', 'CI_PASSED:21'])

    const fixed = repositoryStats([failed('20', 1), commit('x', 2), passed('21', 3)])
    expect(fixed.flaky).toEqual([])

    const otherBranch = repositoryStats([failed('20', 1), passed('21', 2, 'ci@dev')])
    expect(otherBranch.flaky).toEqual([]) // a pass on another branch is not the same group
  })

  it('gives the median time to merge and splits it into an early and a late half', () => {
    const stats = repositoryStats([
      opened('1', 0), merged('1', 2),
      opened('2', 0), merged('2', 6),
      opened('3', 1), merged('3', 3),
      merged('4', 5), // no open record: opened before the window
    ])
    expect(stats.merges.merged).toBe(3)
    expect(stats.merges.unpaired).toBe(1)
    expect(stats.merges.median).toBe(2) // 2, 6, 2
    expect(stats.merges.early).toBe(4) // the two opened first: 2 and 6
    expect(stats.merges.late).toBe(2)
  })

  it('ignores records without a usable date', () => {
    const stats = repositoryStats([commit('a', 1), { ...commit('b', 2), at: 'not a date' }])
    expect(stats.counts.commits).toBe(1)
  })
})
