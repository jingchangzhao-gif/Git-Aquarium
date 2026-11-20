import { describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_LIMIT, loadAccount, parseAccountPayload, pickAccountRepos, publicRepo, saveFinished, upkeepWith, writeAllowed,
} from './account'
import { FINISHED_TOPIC, formTopic } from './projects'

const NOW = Date.UTC(2026, 0, 1)
const DAY = 86_400_000

const raw = (over: object = {}) => ({
  full_name: 'octocat/Hello-World',
  name: 'Hello-World',
  description: 'My first repo',
  html_url: 'https://github.com/octocat/Hello-World',
  created_at: '2020-01-01T00:00:00Z',
  pushed_at: new Date(NOW).toISOString(),
  archived: false,
  topics: ['docs'],
  fork: false,
  ...over,
})

describe('publicRepo', () => {
  it('keeps only the fields the tank draws and drops everything else', () => {
    const repo = publicRepo({ ...raw(), private: true, owner: { login: 'x' } })!
    expect(repo).toEqual({
      fullName: 'octocat/Hello-World',
      name: 'Hello-World',
      theme: 'My first repo',
      url: 'https://github.com/octocat/Hello-World',
      created: '2020-01-01T00:00:00Z',
      pushed: new Date(NOW).toISOString(),
      archived: false,
      topics: ['docs'],
      fork: false,
    })
    expect(publicRepo({ full_name: 'nope' })).toBeNull()
    expect(publicRepo({ full_name: 'a/b', html_url: 'javascript:alert(1)' })!.url).toBe('')
    expect('token' in publicRepo({ full_name: 'a/b', token: 'secret' })!).toBe(false)
  })

  it('reads a payload and keeps only public, non-fork repositories', () => {
    const account = parseAccountPayload({
      login: 'octocat',
      repos: [raw(), raw({ full_name: 'octocat/Cat', fork: true }), { full_name: 'bad' }],
    })
    expect(account.login).toBe('octocat')
    expect(account.repos.map((r) => r.fullName)).toEqual(['octocat/Hello-World'])
    expect(() => parseAccountPayload({ repos: [] })).toThrow(/did not name an account/)
  })
})

describe('pickAccountRepos', () => {
  it('keeps the most recently pushed and caps the tank', () => {
    const repos = Array.from({ length: ACCOUNT_LIMIT + 3 }, (_, i) =>
      publicRepo(raw({ full_name: `o/r${i}`, pushed_at: new Date(NOW - i * DAY).toISOString() }))!)
    const picked = pickAccountRepos(repos)
    expect(picked).toHaveLength(ACCOUNT_LIMIT)
    expect(picked[0].fullName).toBe('o/r0')
    expect(picked[1].fullName).toBe('o/r1')
  })
})

describe('upkeepWith', () => {
  it('lets an explicit finished setting override the quiet clock', () => {
    const project = {
      archived: false,
      pushed: new Date(NOW - 500 * DAY).toISOString(),
      lifecycle: 'rock',
      form: 'rock',
      finished: false,
      speed: 0,
      quietDays: 500,
    } as never
    expect(upkeepWith(project, [FINISHED_TOPIC, formTopic('seaweed')], NOW)).toMatchObject({ lifecycle: 'finished', form: 'seaweed' })
    expect(upkeepWith(project, [], NOW)).toMatchObject({ lifecycle: 'rock', form: 'rock' })
  })
})

describe('the local endpoint', () => {
  it('explains a missing GitHub CLI session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(loadAccount()).rejects.toThrow(/gh auth login/)
    vi.unstubAllGlobals()
  })

  it('posts a finished change and returns the topics the server now holds', async () => {
    const fetch = vi.fn(async () => Response.json({ topics: ['docs', FINISHED_TOPIC, 'aquarium-form-rock'] }, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(saveFinished('o/r', true, 'rock')).resolves.toEqual(['docs', FINISHED_TOPIC, 'aquarium-form-rock'])
    expect(String(fetch.mock.calls[0])).toContain('/api/finished')
    vi.unstubAllGlobals()
  })
})

describe('writeAllowed', () => {
  const ok = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
  it('lets only the page itself write topics', () => {
    expect(writeAllowed(ok)).toBe(true)
    expect(writeAllowed({ ...ok, 'content-type': 'application/json; charset=utf-8' })).toBe(true)
  })
  it('refuses what another website can send without a preflight', () => {
    expect(writeAllowed({ ...ok, 'content-type': 'text/plain;charset=UTF-8' })).toBe(false) // a no-cors fetch
    expect(writeAllowed({ ...ok, 'content-type': 'application/x-www-form-urlencoded' })).toBe(false) // a form post
    expect(writeAllowed({ ...ok, 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(writeAllowed({ ...ok, 'sec-fetch-site': 'same-site' })).toBe(false) // another port on localhost
    expect(writeAllowed({ 'content-type': 'application/json' })).toBe(false) // no browser fetch metadata
    expect(writeAllowed({})).toBe(false)
  })
})
