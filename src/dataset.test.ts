import { afterEach, expect, test, vi } from 'vitest'
import { DATASET_FORMAT, DATASET_VERSION, fromGitHub, importRepo, loadDataset, saveDataset } from './dataset'
import { demo } from './demo'

afterEach(() => vi.unstubAllGlobals())

const canned = (remaining?: string) => () =>
  Promise.resolve(new Response(JSON.stringify({ default_branch: 'main' }), {
    status: 200,
    headers: remaining ? { 'x-ratelimit-remaining': remaining } : {},
  }))

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

test('a pull request merged inside the window is fetched even when it was opened earlier', async () => {
  const pull = {
    number: 42, title: 'Older PR', html_url: 'https://github.com/o/r/pull/42',
    created_at: '2025-01-01T00:00:00Z', updated_at: '2026-11-17T00:00:00Z', merged_at: '2026-11-17T00:00:00Z',
    head: { ref: 'feature' }, base: { ref: 'main' },
  }
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    let body: unknown
    if (url.endsWith('/repos/o/r')) body = { default_branch: 'main' }
    else if (url.includes('/branches?')) body = [{ name: 'main' }, { name: 'feature' }]
    else if (url.includes('/pulls?')) {
      expect(url).toContain('sort=updated')
      body = [pull]
    } else if (url.includes('/actions/runs?')) body = { workflow_runs: [] }
    else if (url.includes('/commits?')) body = []
    else throw new Error(`Unexpected GitHub URL: ${url}`)
    return new Response(JSON.stringify(body), { status: 200 })
  })
  const result = await importRepo('o/r', { days: 365 })
  expect(result.dataset.events.filter((event) => event.id === '42').map((event) => event.kind)).toEqual(['PR_MERGED'])
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

test('a token is sent only as an Authorization header and raises the default budget', async () => {
  const headers: Headers[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    headers.push(new Headers(init.headers))
    return canned('4999')()
  })
  const result = await importRepo('o/r', { token: 'secret', days: 30 })
  expect(result.budget).toBe(200)
  expect(result.limit).toBe(4999)
  expect(headers.length).toBeGreaterThan(2)
  expect(headers.every((h) => h.get('authorization') === 'Bearer secret')).toBe(true)
  expect(JSON.stringify(result.dataset)).not.toContain('secret') // a token never lands in the dataset
  expect(result.dataset.notices.join(' ')).toMatch(/30 days/)
})

test('without a token the default budget stays 40 and no Authorization header is sent', async () => {
  const headers: Headers[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    headers.push(new Headers(init.headers))
    return canned()()
  })
  const result = await importRepo('o/r')
  expect(result.budget).toBe(40)
  expect(headers.every((h) => h.get('authorization') === null)).toBe(true)
})
