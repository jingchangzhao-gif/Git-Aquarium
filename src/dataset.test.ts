import { expect, test } from 'vitest'
import { DATASET_FORMAT, DATASET_VERSION, fromGitHub, loadDataset, saveDataset } from './dataset'
import { demo } from './demo'

const wrap = (dataset: unknown) => JSON.stringify({ format: DATASET_FORMAT, version: DATASET_VERSION, dataset })

test('a saved dataset reopens into the same frozen records', () => {
  const back = loadDataset(saveDataset(demo))
  expect(back).toEqual(demo)
  expect(loadDataset(saveDataset(back))).toEqual(back) // saving again is stable
})

test('fromGitHub keeps only records inside the chosen window', () => {
  const commit = (sha: string, date: string) => ({
    sha, commit: { committer: { date }, message: sha }, html_url: null,
  })
  const api = {
    repo: { default_branch: 'main' },
    branches: [{ name: 'main' }],
    pulls: [],
    runs: [],
    commits: { main: [commit('old', '2026-01-01T00:00:00Z'), commit('new', '2026-03-01T00:00:00Z')] },
  }
  const window = Date.parse('2026-02-01T00:00:00Z')
  const d = fromGitHub('a/b', api, window, ['window note'])
  expect(d.events.map((e) => e.id)).toEqual(['new'])
  expect(d.notices[0]).toBe('window note')
  expect(d.events[0].tick).toBe(100) // one event still starts after the warmup
})

test('a file that is not a dataset is rejected with a readable reason', () => {
  expect(() => loadDataset('not json')).toThrow(/not JSON/)
  expect(() => loadDataset(JSON.stringify({ format: 'other', version: DATASET_VERSION, dataset: demo }))).toThrow(/not a Git Aquarium dataset/)
  expect(() => loadDataset(JSON.stringify({ dataset: demo }))).toThrow(/not a Git Aquarium dataset/)
  expect(() => loadDataset(JSON.stringify({ format: DATASET_FORMAT, version: 99, dataset: demo }))).toThrow(/version/)
})

test('a malformed dataset is rejected instead of half-loading', () => {
  const withEvents = (events: unknown) => wrap({ ...demo, events })
  expect(() => loadDataset(wrap({ ...demo, events: [] }))).toThrow(/no events/)
  expect(() => loadDataset(wrap({ ...demo, source: 'x' }))).toThrow(/source/)
  expect(() => loadDataset(wrap({ ...demo, repo: 7 }))).toThrow(/repository name/)
  expect(() => loadDataset(wrap({ ...demo, branches: 'main' }))).toThrow(/branch list/)
  expect(() => loadDataset(withEvents([{ ...demo.events[0], kind: 'NOT_A_KIND' }]))).toThrow(/unknown event kind/)
  expect(() => loadDataset(withEvents([{ ...demo.events[0], tick: 'x' }]))).toThrow(/tick/)
  expect(() => loadDataset(withEvents([{ ...demo.events[0], at: 'never' }]))).toThrow(/date/)
  expect(() => loadDataset(withEvents([{ ...demo.events[0], lineage: 99 }]))).toThrow(/lineage/)
  expect(() => loadDataset(withEvents([{ ...demo.events[0], lineage: -1 }]))).toThrow(/lineage/)
  expect(() => loadDataset(withEvents([{ ...demo.events[0], branches: 'main' }]))).toThrow(/branches/)
  expect(() => loadDataset(withEvents([{ ...demo.events[0], url: 42 }]))).toThrow(/url/)
  expect(() => loadDataset(withEvents([{ ...demo.events[0], url: 'javascript:alert(1)' }]))).toThrow(/url/)
})
