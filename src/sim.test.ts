import { expect, test } from 'vitest'
import { fromGitHub } from './dataset'
import { demo } from './demo'
import { P, TRAITS, createState, hashState, lifespanTicks, maxEnergy, step, type GitEvent, type State } from './sim'

function run(seed: number, ticks: number, events: GitEvent[] = [], check?: (s: State) => void): State {
  const s = createState(seed)
  for (let i = 0; i < ticks; i++) {
    step(s, events)
    check?.(s)
  }
  return s
}

test('same seed and frozen dataset give the same state hash after 10,000 ticks', () => {
  const a = run(42, 10_000, demo.events)
  expect(a.cursor).toBe(demo.events.length)
  expect(hashState(a)).toBe(hashState(run(42, 10_000, demo.events)))
  expect(hashState(run(43, 100))).not.toBe(hashState(run(42, 100)))
})

test('a serialized snapshot resumes to the same state', () => {
  const a = run(5, 1500, demo.events)
  const b: State = JSON.parse(JSON.stringify(a))
  for (let i = 0; i < 1500; i++) {
    step(a, demo.events)
    step(b, demo.events)
  }
  expect(hashState(b)).toBe(hashState(a))
})

test('the ecosystem stays within its bounds and stays alive', () => {
  const s = run(7, 10_000, demo.events, (s) => {
    if (s.organisms.length > P.maxPopulation) throw new Error(`population ${s.organisms.length} at tick ${s.tick}`)
    if (s.food.length > P.maxFood) throw new Error(`food ${s.food.length} at tick ${s.tick}`)
    if (!s.penalty.every((p) => p >= 0 && p <= P.maxPenalty)) throw new Error(`penalty ${s.penalty} at tick ${s.tick}`)
    for (const o of s.organisms) {
      if (!(o.energy > 0 && o.energy <= maxEnergy(o.genome))) throw new Error(`energy ${o.energy} at tick ${s.tick}`)
      if (!(o.x >= 0 && o.x <= P.width && o.y >= 0 && o.y <= P.height && o.z >= 0 && o.z <= P.depth)) throw new Error(`escaped at tick ${s.tick}`)
      if (Math.abs(Math.hypot(o.ux, o.uy, o.uz) - 1) > 1e-9) throw new Error(`direction is not a unit vector at tick ${s.tick}`)
      for (const t of TRAITS) {
        if (!(o.genome[t] >= 0 && o.genome[t] <= 1)) throw new Error(`${t}=${o.genome[t]} at tick ${s.tick}`)
      }
    }
  })
  expect(s.organisms.length).toBeGreaterThan(0)
  expect(s.births).toBeGreaterThan(0)
  expect(s.deaths).toBeGreaterThan(0)
  expect(s.mutations).toBeGreaterThan(0)
  const sum = (key: 'born' | 'founded' | 'starved' | 'aged') => s.tally.reduce((n, t) => n + t[key], 0)
  expect(s.organisms.length).toBe(P.startPopulation + s.births + sum('founded') - s.deaths)
  expect(sum('born')).toBe(s.births) // the per-lineage record accounts for every birth and death
  expect(sum('starved') + sum('aged')).toBe(s.deaths)
  expect(sum('starved')).toBeGreaterThan(0)
  expect(sum('aged')).toBeGreaterThan(0)
})

test('only eligible pairs reproduce, and both parents pay', () => {
  let newest = P.startPopulation
  let checked = 0
  run(3, 4000, demo.events, (s) => {
    for (const child of s.organisms) {
      if (child.id <= newest || !child.parents) continue // founders of a re-founded lineage have no parents
      const parents = s.organisms.filter((o) => child.parents!.includes(o.id))
      expect(parents).toHaveLength(2) // two distinct parents, both still alive
      for (const p of parents) {
        expect(p.lineage).toBe(child.lineage)
        expect(p.age).toBeGreaterThanOrEqual(P.maturity * lifespanTicks(p.genome))
        expect(p.cooldown).toBe(P.cooldown) // so neither can breed again this tick
        // It had the breeding threshold and paid the breeding cost, so this much is left.
        expect(p.energy).toBeGreaterThanOrEqual((P.breedEnergy - P.breedCost) * maxEnergy(p.genome) - 1e-9)
      }
      expect(child.age).toBe(0)
      expect(child.energy).toBeLessThanOrEqual(maxEnergy(child.genome))
      checked++
    }
    newest = Math.max(newest, ...s.organisms.map((o) => o.id))
  })
  expect(checked).toBeGreaterThan(20)
})

test('mapping rules: each event acts on the lineage of its own branch', () => {
  const event = (tick: number, kind: GitEvent['kind'], lineage: number, group = ''): GitEvent =>
    ({ tick, kind, group, lineage, at: '', id: `${tick}`, title: '', url: null, branches: [] })
  const s = createState(1) // four lineages
  s.organisms = [] // nothing eats, so food counts are exact
  s.food = []
  const events = [
    event(1, 'COMMIT_OBSERVED', 0), event(2, 'PR_OPENED', 1), event(3, 'PR_MERGED', 1),
    event(4, 'CI_FAILED', 0, 'build@main'), event(4, 'CI_FAILED', 1, 'test@dev'), event(5, 'CI_FAILED', 0, 'build@main'),
    event(6, 'CI_PASSED', 0, 'test@main'), event(7, 'CI_PASSED', 0, 'build@main'),
    event(1010, 'CI_FAILED', -1, 'lint@unknown'),
    ...Array.from({ length: 60 }, (_, i) => event(1100 + i, 'PR_MERGED', 2)),
  ]
  const food = (lineage: number) => s.food.filter((f) => f.lineage === lineage).length
  step(s, events)
  expect(food(0)).toBe(P.commitFood) // the commit fed its own lineage...
  expect(s.organisms.map((o) => o.lineage)).toEqual(Array(P.founders).fill(0)) // ...and re-founded it, since it had died out
  s.organisms = []
  step(s, events)
  step(s, events)
  expect(food(1)).toBe(P.mergeFood) // the merge fed the base branch's lineage; the opened PR added nothing
  expect(food(0)).toBe(P.commitFood)
  expect(food(-1)).toBeLessThanOrEqual(s.tick) // baseline supply: at most one shared particle per tick
  s.organisms = []
  step(s, events)
  step(s, events)
  expect(s.penalty).toEqual([P.penaltyPerGroup, P.penaltyPerGroup, 0, 0]) // a repeated failure in one group counts once
  step(s, events)
  expect(s.failing.map((f) => f.group)).toEqual(['build@main', 'test@dev']) // success in another group clears nothing
  step(s, events)
  expect(s.failing.map((f) => f.group)).toEqual(['test@dev'])
  expect(s.penalty[0]).toBeLessThan(P.penaltyPerGroup) // recovery has started...
  expect(s.penalty[0]).toBeGreaterThan(0) // ...but is gradual
  expect(s.penalty[1]).toBe(P.penaltyPerGroup) // the other branch is still failing
  for (let i = 0; i < 1000; i++) step(s, events)
  expect(s.penalty).toEqual([0, P.penaltyPerGroup, 0, 0])
  for (let i = 0; i < 10; i++) step(s, events)
  expect(s.penalty).toEqual([P.penaltyPerGroup, 2 * P.penaltyPerGroup, P.penaltyPerGroup, P.penaltyPerGroup]) // a failure on an unknown branch costs everyone
  for (let i = 0; i < 200; i++) step(s, events)
  expect(s.food.length).toBe(P.maxFood) // a burst of merges cannot exceed the food cap
})

test('an organism eats shared food and its own lineage\'s food, never another lineage\'s', () => {
  const s = createState(2)
  const fish = s.organisms.find((o) => o.lineage === 0)!
  s.organisms = [fish]
  fish.energy = 10
  const here = (lineage: number) => ({ x: fish.x, y: fish.y, z: fish.z, lineage })
  s.food = [here(1)]
  step(s)
  expect(s.food.some((f) => f.lineage === 1)).toBe(true) // sitting on it, and it is not eaten
  expect(fish.energy).toBeLessThan(10)
  s.food = [here(0)]
  step(s)
  expect(s.food.some((f) => f.lineage === 0)).toBe(false)
  expect(fish.energy).toBeGreaterThan(10)
  s.food = [here(-1)]
  const before = fish.energy
  step(s)
  expect(s.food.some((f) => f.x === fish.x && f.lineage === -1)).toBe(false)
  expect(fish.energy).toBeGreaterThan(before)
})

test('GitHub import: attributes events to branches, dedupes, and reports what is missing', () => {
  const commit = (sha: string, date: string, html_url = `https://github.com/o/r/commit/${sha}`) =>
    ({ sha, html_url, commit: { message: `Change ${sha}\n\nbody`, committer: { date } } })
  const shared = [commit('aaa', '2026-01-02T00:00:00Z'), commit('bbb', '2026-01-01T00:00:00Z', 'javascript:alert(1)')]
  const d = fromGitHub('o/r', {
    repo: { default_branch: 'main' },
    branches: [{ name: 'dev' }, { name: 'main' }, { name: 'idle' }],
    commits: {
      main: [...shared, commit('aaa', '2026-01-02T00:00:00Z'), commit('ccc', 'not a date')],
      dev: [commit('ddd', '2026-01-02T12:00:00Z'), ...shared], // dev also contains main's history
      idle: shared,
    },
    pulls: [
      { number: 7, title: 'Add thing', html_url: 'https://github.com/o/r/pull/7', created_at: '2026-01-03T00:00:00Z', merged_at: '2026-01-04T00:00:00Z', head: { ref: 'dev' }, base: { ref: 'main' } },
      { number: 8, title: 'Elsewhere', created_at: '2026-01-03T00:00:00Z', head: { ref: 'x' }, base: { ref: 'release' } },
    ],
    runs: [
      { id: 1, name: 'ci', workflow_id: 9, head_branch: 'dev', conclusion: 'timed_out', updated_at: '2026-01-03T12:00:00Z' },
      { id: 2, name: 'ci', workflow_id: 9, head_branch: 'dev', conclusion: 'cancelled', updated_at: '2026-01-03T13:00:00Z' },
      { id: 3, name: 'ci', workflow_id: 9, head_branch: 'someone/fork-branch', conclusion: 'failure', updated_at: '2026-01-03T14:00:00Z' },
    ],
  })
  expect(d.branches).toEqual(['main', 'dev', 'idle']) // the default branch first, then by activity
  expect(d.events.map((e) => `${e.kind} ${e.id} -> ${d.branches[e.lineage]}`)).toEqual([
    'COMMIT_OBSERVED bbb -> main', 'COMMIT_OBSERVED aaa -> main', // shared history counts once, for the default branch
    'COMMIT_OBSERVED ddd -> dev', // dev keeps only its own commit
    'PR_OPENED 7 -> dev', 'CI_FAILED 1 -> dev',
    'PR_MERGED 7 -> main', // a merge acts on the branch it merged into
  ])
  expect(d.events[0].url).toBeNull() // only github.com links survive
  expect(d.events[0].title).toBe('Change bbb')
  expect(d.events[4].group).toBe('9@dev')
  expect(d.events.map((e) => e.tick)).toEqual([...d.events.map((e) => e.tick)].sort((a, b) => a - b))
  expect(d.notices.join(' ')).toMatch(/1 workflow runs with other conclusions/)
  expect(d.notices.join(' ')).toMatch(/2 pull requests and workflow runs were on branches that are not shown as lineages/)

  const many = Array.from({ length: 100 }, (_, i) => commit(`s${i}`, new Date(Date.UTC(2026, 1, 1 + i)).toISOString()))
  const window = Date.parse('2026-02-01T00:00:00Z')
  const cut = fromGitHub('o/r', {
    repo: { default_branch: 'main' }, branches: [{ name: 'main' }], commits: { main: many }, runs: null,
    pulls: [{ number: 1, created_at: '2025-01-01T00:00:00Z', head: { ref: 'old' }, base: { ref: 'main' } }],
  }, window, ['window note'])
  expect(cut.events).toHaveLength(100) // every commit is inside the window; the pull request predates it
  expect(cut.notices[0]).toBe('window note')
  expect(cut.notices.join(' ')).toMatch(/Actions data was unavailable/)

  const busy = fromGitHub('o/r', { // more branches than lineages: the busiest are kept
    repo: { default_branch: 'trunk' }, commits: {}, runs: [],
    branches: [...Array.from({ length: 12 }, (_, i) => ({ name: `b${i}` })), { name: 'trunk' }],
    pulls: [{ number: 1, created_at: '2026-01-01T00:00:00Z', head: { ref: 'b11' }, base: { ref: 'trunk' } }],
  })
  expect(busy.branches.slice(0, 2)).toEqual(['trunk', 'b11'])
  expect(busy.branches).toHaveLength(8)
  expect(busy.notices.join(' ')).toMatch(/Showing 8 of 13 branches/)
})
