import { expect, test } from 'vitest'
import { demo } from './demo'
import { explain, key, parseAnswer, repoAnswer, repoQuestion, summarize, unknownEvidence, type Context, type Sample } from './explain'
import { P, createState, step } from './sim'

// The demo replayed to a tick, read once a simulated second, exactly as the page does.
function replay(ticks: number): Context {
  const s = createState(1, demo.branches.length)
  const samples: Sample[] = []
  for (let i = 0; i <= ticks; i++) {
    if (i % P.ticksPerSecond === 0) {
      const pop = demo.branches.map((_, lineage) => s.organisms.filter((o) => o.lineage === lineage).length)
      const energy = s.organisms.reduce((sum, o) => sum + o.energy, 0) / (s.organisms.length || 1)
      samples.push({ tick: s.tick, pop, energy, stress: s.penalty.map((p) => p / P.maxPenalty), tally: structuredClone(s.tally) })
    }
    step(s, demo.events)
  }
  return { repo: demo.repo, source: demo.source, branches: demo.branches, notices: demo.notices, events: demo.events.slice(0, s.cursor), samples, focus: null }
}

test('the rule-based explanation ties the collapse to the CI failures it can cite', () => {
  const c = replay(2300) // well into the CI failure act of the demo
  const answer = explain('Why did the population change?', c)
  const cited = [...answer.facts, ...answer.rules].flatMap((claim) => claim.evidence)

  expect(answer.interpretation).toContain('CI penalty')
  expect(answer.interpretation).toContain('murky water') // the penalty also limits sight, not only energy
  for (const failure of c.events.filter((e) => e.kind === 'CI_FAILED')) expect(cited).toContain(key(failure))
  expect(unknownEvidence(answer, c.events.map(key))).toEqual([]) // it only cites what has been replayed
  expect(answer.facts[0].text).toMatch(/^The population went from \d+ to \d+ organisms/)
  expect(answer.uncertainty.join(' ')).toContain('fictional demo data')

  const named = explain(`Why did ${demo.branches[1]} decline?`, c) // naming a branch narrows the answer to its lineage
  expect(named.facts[0].text).toContain(`Lineage ${demo.branches[1]}`)
  expect(explain('anything', { ...c, samples: [] }).facts).toEqual([]) // nothing recorded yet: no invented facts
  expect(explain('Why?', replay(60)).interpretation).toContain('baseline supply') // before any event, growth is not credited to commits
})

test('a model answer is rejected when it is malformed or cites a record that does not exist', () => {
  const c = replay(600)
  const refs = summarize('Why?', c).events.map((e) => e.ref)
  const good = { facts: [{ text: 'A commit was replayed.', evidence: [refs[0]] }], rules: [], interpretation: 'Food arrived.', uncertainty: ['Small sample.'] }

  expect(parseAnswer(good)).toEqual(good)
  expect(unknownEvidence(good, refs)).toEqual([])
  expect(unknownEvidence({ ...good, rules: [{ text: 'Invented.', evidence: ['CI_FAILED:not-a-real-run'] }] }, refs)).toEqual(['CI_FAILED:not-a-real-run'])
  expect(unknownEvidence({ ...good, interpretationEvidence: ['CI_FAILED:not-a-real-run'] }, refs)).toEqual(['CI_FAILED:not-a-real-run'])
  expect(unknownEvidence(good, [])).toEqual([refs[0]]) // a real record that was not in the summary still does not count

  expect(parseAnswer(null)).toBeNull()
  expect(parseAnswer({ ...good, interpretation: 42 })).toBeNull()
  expect(parseAnswer({ ...good, interpretationEvidence: 'not a list' })).toBeNull()
  expect(parseAnswer({ ...good, facts: [{ text: 'No evidence list.' }] })).toBeNull()
  expect(parseAnswer({ ...good, facts: 'not a list' })).toBeNull()
  expect(summarize('x'.repeat(500), c).question).toHaveLength(200) // the summary sent to a model is bounded
  expect(summarize('Why?', replay(2300)).events.length).toBeLessThanOrEqual(40)
})

test('repository questions route away from the simulation and answer from the records', () => {
  const c: Context = { ...replay(600), records: demo.events }
  const refs = demo.events.map(key)

  expect(repoQuestion('What changed this week?')).toBe('week')
  expect(repoQuestion('Which pull requests are stuck?')).toBe('stuck')
  expect(repoQuestion('Which workflow fails most often?')).toBe('workflow')
  expect(repoQuestion('How long does a pull request take to merge?')).toBe('merge')
  expect(repoQuestion('Why did the population change?')).toBeNull() // still a simulation question
  expect(repoQuestion('Why did the fish die?')).toBeNull()

  const week = repoAnswer('week', c)
  expect(week.facts[0].text).toContain('imported window ends')
  expect(week.facts.length).toBeGreaterThan(2)
  expect(week.uncertainty.join(' ')).toContain('fictional demo data')
  expect(week.facts.slice(1).every((fact) => fact.evidence.length > 0)).toBe(true)
  expect(week.interpretationEvidence?.length).toBeGreaterThan(0)
  expect(unknownEvidence(week, refs)).toEqual([])

  const stuck = repoAnswer('stuck', c)
  expect(stuck.interpretation.length).toBeGreaterThan(0)
  expect(stuck.interpretationEvidence?.length).toBeGreaterThan(0)
  expect(unknownEvidence(stuck, refs)).toEqual([])

  const flow = repoAnswer('workflow', c)
  expect(flow.facts.some((f) => /failures/.test(f.text))).toBe(true)
  expect(flow.facts.every((fact) => fact.evidence.length > 0)).toBe(true)
  expect(flow.interpretationEvidence?.length).toBeGreaterThan(0)
  expect(unknownEvidence(flow, refs)).toEqual([])

  const merge = repoAnswer('merge', c)
  expect(merge.interpretation).toMatch(/days|no paired/)
  expect(merge.facts.every((fact) => fact.evidence.length > 0)).toBe(true)
  expect(merge.interpretationEvidence?.length).toBeGreaterThan(0)
  expect(unknownEvidence(merge, refs)).toEqual([])

  // An imported window with no records answers without inventing facts.
  const empty = repoAnswer('week', { ...c, records: [] })
  expect(empty.facts).toEqual([])
  expect(empty.interpretation).toContain('No repository records')
})
