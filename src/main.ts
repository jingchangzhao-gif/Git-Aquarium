import '@fontsource-variable/fraunces'
import '@fontsource-variable/fraunces/wght-italic.css'
import '@fontsource-variable/martian-mono'
import './style.css'
import { importRepo, type Dataset } from './dataset'
import { demo } from './demo'
import { explain, key, parseAnswer, summarize, unknownEvidence, type Answer, type Claim, type Context, type Sample } from './explain'
import { P, RULES, TRAITS, hashState, lifespanTicks, maxEnergy, type EventKind, type Organism, type State } from './sim'
import { COLORS, createTank, silhouette, type ProjectDraw, type Swimmer } from './tank'
import { DEFAULT_REPOS, countIssues, countPulls, fetchProjects, type Project, type ProjectSet } from './projects'
import { drift, placeProjects, type Agent } from './fishschool'
import type { Command } from './worker'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
// Repository text is untrusted, so it only ever reaches the page as text content.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag)
  node.textContent = text
  node.className = className
  return node
}

const W = P.width
const H = P.height
const TAU = 2 * Math.PI
const TICK_MS = 1000 / P.ticksPerSecond
const LINK_TICKS = 200 // how long a pull request stays drawn
const KIND: Record<EventKind, string> = {
  COMMIT_OBSERVED: 'Commit observed', PR_OPENED: 'PR opened', PR_MERGED: 'PR merged',
  CI_FAILED: 'CI failed', CI_PASSED: 'CI passed',
}

// ---- Canvases ----------------------------------------------------------------------------------

const scene = $<HTMLCanvasElement>('#scene')
const overlay = $<HTMLCanvasElement>('#overlay') // pull request arcs, labels, and the selection ring, drawn over the 3D view
const tank = (() => {
  try {
    return createTank(scene)
  } catch { // no WebGL: the readouts and event log still work
    $('.view').replaceChildren(el('p', 'The aquarium view needs WebGL, which this browser did not provide. The measurements and event log below still work.'))
  }
})()
const dpr = Math.min(2, window.devicePixelRatio || 1)
overlay.width = W * dpr
overlay.height = H * dpr
const ctx = overlay.getContext('2d')!
ctx.scale(dpr, dpr)

// ---- Replay state -------------------------------------------------------------------------------

let data: Dataset = demo
let cur: State | undefined // latest snapshot from the worker
let from = new Map<number, Organism>() // the snapshot before it, for smooth motion between ticks
let arrived = 0
let running = true
let shown = -1 // event cursor the log currently reflects
const born = new Map<number, number>() // when each newborn first appeared, so it can grow in
let fading: { o: Organism; at: number }[] = [] // the recently dead, shrinking and sinking
let samples: Sample[] = [] // one reading a simulated second: the chart and the Ecologist both read this
let focus: number | null = null // lineage filter
let selected: { o: Organism; died: string } | null = null // the inspected organism, as last seen
let drawn: Swimmer[] = [] // the living fish as last drawn, for picking with a click

// ---- Projects mode ------------------------------------------------------------------------------

let mode: 'ecosystem' | 'projects' = 'ecosystem'
let projects: ProjectSet | null = null
let agents: Agent[] = []
let picked: Agent | null = null
let projectRev = 0 // bumped when the data changes, so the tank rebuilds its meshes once

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const send = (c: Command) => worker.postMessage(c)
worker.onerror = () => ($('#error').textContent = 'The simulation stopped unexpectedly. Reload the page to start again.')
worker.onmessage = (e: MessageEvent<State>) => {
  const next = e.data
  const now = performance.now()
  if (!cur || next.tick < cur.tick) { // a fresh replay: nothing to blend from
    from = new Map()
    born.clear()
    fading = []
    samples = []
  } else if (next.tick > cur.tick) {
    from = new Map(cur.organisms.map((o) => [o.id, o]))
    const alive = new Set(next.organisms.map((o) => o.id))
    for (const o of next.organisms) if (!from.has(o.id)) born.set(o.id, now)
    for (const o of cur.organisms) {
      if (alive.has(o.id)) continue
      born.delete(o.id)
      fading.push({ o, at: now })
    }
  }
  if (selected && !selected.died) {
    const seen = next.organisms.find((o) => o.id === selected!.o.id)
    if (seen) selected.o = seen
    else { // gone since the last snapshot: its last reading says which limit it hit
      const o = selected.o
      selected.died = `Died at tick ${next.tick} of ${o.age + next.tick - (cur?.tick ?? next.tick) >= lifespanTicks(o.genome) ? 'old age' : 'starvation'}`
    }
  }
  cur = next
  arrived = now
  report(next)
}

// Loading and resetting are the same thing: a fresh state from the same seed and frozen dataset.
function load() {
  select(null)
  send({ load: { seed: Number($<HTMLInputElement>('#seed').value), lineages: data.branches.length, events: data.events } })
}

function use(d: Dataset) {
  data = d
  focus = null
  const count = (...kinds: string[]) => String(d.events.filter((e) => kinds.includes(e.kind)).length)
  const stat = (label: string, value: string) => {
    const div = el('div')
    div.append(el('dt', label), el('dd', value))
    return div
  }
  const counts = el('dl')
  counts.append(
    stat('Commits', count('COMMIT_OBSERVED')), stat('PRs', count('PR_OPENED')),
    stat('Merged', count('PR_MERGED')), stat('CI runs', count('CI_FAILED', 'CI_PASSED')),
  )
  $('#dataset').replaceChildren(
    el('span', d.source, `badge ${d.source}`),
    el('strong', d.repo),
    el('p', (d.source === 'synthetic' ? 'Fictional events, not imported from GitHub. ' : 'Imported from GitHub and frozen. ') +
      (d.events.length ? `${d.events[0].at.slice(0, 10)} to ${d.events[d.events.length - 1].at.slice(0, 10)}.` : 'No events.')),
    counts,
  )
  const notices = $<HTMLDetailsElement>('#notices')
  notices.open = d.source === 'recorded' // real imports show their gaps without being asked
  notices.firstElementChild!.textContent = `Data boundaries (${d.notices.length})`
  notices.lastElementChild!.replaceChildren(...d.notices.map((n) => el('li', n)))

  $('#legend').replaceChildren(...d.branches.map((name, i) => {
    const li = el('li')
    const button = el('button')
    button.type = 'button'
    button.title = 'Show only this lineage'
    button.setAttribute('aria-pressed', 'false')
    button.style.setProperty('--c', COLORS[i % COLORS.length])
    button.append(silhouette(i), el('span', name), el('b'), el('u'))
    button.addEventListener('click', () => filter(focus === i ? null : i))
    li.append(button)
    return li
  }))
  $('#lines').replaceChildren(...d.branches.map((_, i) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    line.style.stroke = COLORS[i % COLORS.length]
    return line
  }))
  filter(null)
  const end = d.events[d.events.length - 1]?.tick ?? 1
  $('#marks').replaceChildren(...d.events.map((e) => {
    const mark = el('i', '', e.kind)
    mark.style.left = `${(100 * e.tick) / end}%`
    return mark
  }))
  load()
}

$('#source').addEventListener('submit', async (e) => {
  e.preventDefault()
  const button = $<HTMLButtonElement>('#import')
  button.disabled = true
  $('#error').textContent = 'Importing...'
  try {
    use(await importRepo($<HTMLInputElement>('#repo').value))
    $('#error').textContent = ''
  } catch (err) {
    $('#error').textContent = `Import failed: ${(err as Error).message} The previous dataset is still loaded.`
  } finally {
    button.disabled = false
  }
})
$('#demo').addEventListener('click', () => use(demo))
$('#controls').addEventListener('submit', (e) => {
  e.preventDefault()
  load()
})
$('#pause').addEventListener('click', (e) => {
  running = !running
  ;(e.target as HTMLElement).textContent = running ? 'Pause' : 'Play'
  send({ running })
})
$('#speed').addEventListener('change', (e) => send({ speed: Number((e.target as HTMLInputElement).value) }))

// ---- Readouts (once per snapshot) ---------------------------------------------------------------

function report(s: State) {
  const n = s.organisms.length
  const counts = data.branches.map(() => 0)
  let energy = 0
  for (const o of s.organisms) {
    energy += o.energy
    counts[o.lineage]++
  }
  const levels = s.penalty.map((p) => p / P.maxPenalty) // each lineage's CI penalty, 0..1
  const stress = Math.round((100 * levels.reduce((a, b) => a + b, 0)) / levels.length) // the water shows their average
  const second = (tick: number) => Math.floor(tick / P.ticksPerSecond)
  if (!samples.length || second(s.tick) > second(samples[samples.length - 1].tick)) {
    samples.push({ tick: s.tick, pop: counts, energy: n ? energy / n : 0, stress: levels, tally: s.tally })
    if (samples.length > 900) samples.shift() // ponytail: the chart and explanations keep the last 15 simulated minutes; thin old readings instead if longer runs matter
    chart()
  }
  vitals()
  $('#s-pop').textContent = String(n)
  $('#s-energy').textContent = n ? (energy / n).toFixed(1) : '0'
  $('#s-births').textContent = String(s.births)
  $('#s-deaths').textContent = String(s.deaths)
  $('#s-mutations').textContent = String(s.mutations)
  $('#s-stress').textContent = `${stress}%`
  // While paused, show the state hash: the reproducibility contract made checkable by eye.
  $('#tick').textContent = `tick ${s.tick}${running ? '' : ` · state ${hashState(s)}`}`
  const legend = $('#legend').children
  counts.forEach((c, i) => {
    if (!legend[i]) return
    legend[i].firstElementChild!.classList.toggle('stressed', levels[i] > 0)
    const row = legend[i].firstElementChild!.children
    row[2].textContent = String(c)
    ;(row[3] as HTMLElement).style.width = `${n ? (100 * c) / n : 0}%`
  })
  const end = data.events[data.events.length - 1]?.tick ?? 1
  const progress = Math.min(100, (100 * s.tick) / end)
  $('#fill').style.width = `${progress}%`
  $('#timeline').setAttribute('aria-valuenow', String(Math.round(progress)))
  const alarm = $('#alarm')
  alarm.hidden = stress === 0
  alarm.textContent = s.failing.length
    ? `Murky water · ${s.failing.length} CI ${s.failing.length === 1 ? 'group' : 'groups'} failing`
    : `Water clearing · stress ${stress}%`

  if (s.cursor === shown) return
  const fresh = s.cursor > shown && shown >= 0 ? s.cursor - shown : 0 // how many entries just arrived
  shown = s.cursor
  const last = data.events[s.cursor - 1]
  $('#date').textContent =
    !data.events.length ? 'No repository events · baseline supply only'
    : s.cursor === data.events.length ? 'Replay complete · baseline supply continues'
    : last ? `Replaying ${last.at.slice(0, 10)} · event ${s.cursor} of ${data.events.length}`
    : `Awaiting the first of ${data.events.length} events`
  $('#log').replaceChildren(...data.events.slice(Math.max(0, s.cursor - 7), s.cursor).reverse().map((e, i) => {
    const li = el('li', '', e.kind + (i < fresh ? ' new' : ''))
    const rule = el('small')
    rule.append(el('b', RULES[e.kind].id), ` ${RULES[e.kind].effect}`)
    if (e.kind !== 'PR_OPENED') rule.append(el('i', e.lineage < 0 ? ' · the whole tank' : ` · ${data.branches[e.lineage]}`))
    li.append(el('span', e.at.slice(0, 10), 'when'), el('span', KIND[e.kind], 'kind'), el('p', e.title), rule)
    if (e.url) {
      const a = el('a', 'GitHub source')
      a.href = e.url
      a.target = '_blank'
      a.rel = 'noopener'
      li.append(a)
    } else {
      li.append(el('small', 'Synthetic event · no GitHub source'))
    }
    return li
  }))
}

// ---- Inspection: one organism, one lineage ------------------------------------------------------

function filter(lineage: number | null) {
  focus = lineage
  const rows = $('#legend').children
  $('#legend').classList.toggle('filtered', lineage !== null)
  for (let i = 0; i < rows.length; i++) {
    rows[i].firstElementChild!.setAttribute('aria-pressed', String(i === lineage))
    $('#lines').children[i]?.classList.toggle('off', lineage !== null && i !== lineage)
  }
  chart() // the shaded periods follow the filter
}

function select(o: Organism | null) {
  selected = o && { o, died: '' }
  const box = $('#organism')
  if (!o) return box.replaceChildren(el('p', 'Click a fish in the aquarium to follow it and read its genome.', 'hint'))
  const who = el('p', '', 'who')
  who.style.setProperty('--c', COLORS[o.lineage % COLORS.length])
  who.append(silhouette(o.lineage), el('strong', `#${o.id}`), el('span', data.branches[o.lineage]))
  const facts = el('dl')
  for (const [label, id] of [['Status', 'o-status'], ['Age', 'o-age'], ['Energy', 'o-energy']]) {
    const dd = el('dd')
    dd.id = id
    facts.append(el('dt', label), dd)
  }
  const parents = el('dd')
  if (!o.parents) parents.textContent = 'Founding population, no recorded parents'
  for (const id of o.parents ?? []) {
    const button = el('button', `#${id}`, 'ghost')
    button.type = 'button'
    button.addEventListener('click', () => {
      const parent = cur?.organisms.find((p) => p.id === id)
      if (parent) return select(parent)
      button.disabled = true
      button.textContent = `#${id} is no longer alive`
    })
    parents.append(button)
  }
  facts.append(el('dt', 'Parents'), parents)
  const genome = el('ul', '', 'genome')
  for (const trait of TRAITS) {
    const li = el('li')
    const bar = el('i')
    bar.style.width = `${100 * o.genome[trait]}%`
    li.append(el('span', trait), bar, el('b', o.genome[trait].toFixed(2)))
    genome.append(li)
  }
  box.replaceChildren(who, facts, el('h3', 'Genome · each trait from 0 to 1'), genome)
  vitals()
}

// The parts of the organism panel that change from tick to tick.
function vitals() {
  if (!selected) return
  const { o, died } = selected
  const life = lifespanTicks(o.genome)
  $('#o-status').textContent = died || (o.cooldown ? `Alive · can breed again in ${o.cooldown} ticks` : 'Alive')
  $('#o-age').textContent = `${o.age} ticks · ${Math.round((100 * o.age) / life)}% of a ${Math.round(life)}-tick lifespan`
  $('#o-energy').textContent = `${Math.max(0, o.energy).toFixed(0)} of ${maxEnergy(o.genome).toFixed(0)}`
}

scene.addEventListener('click', (e) => {
  if (!tank) return
  const px = (e.offsetX / scene.clientWidth) * W
  const py = (e.offsetY / scene.clientHeight) * H
  if (mode === 'projects') { // a project body is larger than a fish, so its hit area is wider
    let best: Agent | undefined
    let near = 40
    for (const a of agents) {
      const [x, y] = tank.projectScene(a.x, a.y, a.z)
      const d = Math.hypot(x - px, y - py)
      if (d < near) { near = d; best = a }
    }
    selectProject(best ?? null)
    return
  }
  if (!cur) return
  let best: Swimmer | undefined
  let near = 30 // how close, in canvas units, a click must land
  for (const s of drawn) {
    const [x, y] = tank.project(s.x, s.y, s.z)
    const d = Math.hypot(x - px, y - py)
    if (d < near) { near = d; best = s }
  }
  select(cur.organisms.find((o) => o.id === best?.id) ?? null) // a click on open water clears the selection
})

// ---- Population chart ---------------------------------------------------------------------------

let span = [0, 1] // ticks at the chart's left and right edges
function chart() {
  const last = samples[samples.length - 1]
  if (!last) return
  const start = samples[0].tick
  const end = Math.max(last.tick, data.events[data.events.length - 1]?.tick ?? 0, start + 1)
  span = [start, end]
  const top = Math.max(20, 10 * Math.ceil(Math.max(...samples.flatMap((s) => s.pop)) / 10))
  const x = (tick: number) => ((1000 * (tick - start)) / (end - start)).toFixed(1)
  const lines = $('#lines').children
  for (let i = 0; i < lines.length; i++) {
    lines[i].setAttribute('points', samples.map((s) => `${x(s.tick)},${(100 - (100 * s.pop[i]) / top).toFixed(1)}`).join(' '))
  }
  // One rectangle for each run of readings with a CI penalty: on any lineage, or on the filtered one.
  const on = (s: Sample) => (focus === null ? s.stress.some((v) => v > 0) : s.stress[focus] > 0)
  let band = ''
  for (let i = 0; i < samples.length; i++) {
    if (!on(samples[i]) || (i && on(samples[i - 1]))) continue
    let j = i
    while (j + 1 < samples.length && on(samples[j + 1])) j++
    band += `M${x(samples[i].tick)} 0H${x(samples[j].tick)}V100H${x(samples[i].tick)}Z`
  }
  $('#band').setAttribute('d', band)
  $('#y-top').textContent = String(top)
  $('#y-mid').textContent = String(top / 2)
  $('#x-end').textContent = `tick ${end}`
}

const plot = $('#plot')
plot.addEventListener('pointermove', (e) => {
  if (!samples.length) return
  const part = Math.min(1, Math.max(0, (e.clientX - plot.getBoundingClientRect().left) / plot.clientWidth))
  const tick = span[0] + part * (span[1] - span[0])
  const s = samples.reduce((a, b) => (Math.abs(b.tick - tick) < Math.abs(a.tick - tick) ? b : a))
  const at = (s.tick - span[0]) / (span[1] - span[0])
  const date = data.events.filter((ev) => ev.tick <= s.tick).pop()?.at.slice(0, 10)
  const rows = el('dl')
  data.branches.forEach((name, i) => {
    const dt = el('dt', name)
    dt.style.setProperty('--c', COLORS[i % COLORS.length])
    rows.append(dt, el('dd', String(s.pop[i])))
  })
  rows.append(el('dt', 'All lineages', 'sum'), el('dd', String(s.pop.reduce((a, b) => a + b, 0))))
  const tip = $('#tip')
  tip.replaceChildren(el('strong', `Tick ${s.tick}${date ? ` · ${date}` : ''}`), rows, el('small', s.stress.some((v) => v > 0) ? `CI penalty on ${data.branches.filter((_, i) => s.stress[i] > 0).join(', ')}` : 'No CI penalty'))
  tip.hidden = false
  tip.style.left = at < 0.6 ? `${100 * at}%` : ''
  tip.style.right = at < 0.6 ? '' : `${100 * (1 - at)}%`
  $('#cross').setAttribute('x1', String(1000 * at))
  $('#cross').setAttribute('x2', String(1000 * at))
  $('#cross').style.visibility = 'visible'
})
plot.addEventListener('pointerleave', () => {
  $('#tip').hidden = true
  $('#cross').style.visibility = 'hidden'
})

// ---- Ecologist ----------------------------------------------------------------------------------

function claims(title: string, list: Claim[]) {
  const ul = el('ul')
  for (const c of list) {
    const li = el('li', c.text)
    const refs = el('span', '', 'refs')
    for (const ref of c.evidence.slice(0, 4)) { // each reference is a replayed record, linked to GitHub when it has a source
      const e = data.events.find((ev) => key(ev) === ref)
      if (!e) continue
      const chip = e.url ? el('a') : el('span')
      chip.textContent = `${KIND[e.kind]} ${e.id.slice(0, 7)}`
      chip.title = e.title
      if (chip instanceof HTMLAnchorElement) Object.assign(chip, { href: e.url, target: '_blank', rel: 'noopener' })
      refs.append(chip)
    }
    if (c.evidence.length > 4) refs.append(el('span', `+${c.evidence.length - 4} more`))
    if (refs.childElementCount) li.append(refs)
    ul.append(li)
  }
  return [el('h3', title), ul]
}

async function ask(question: string) {
  const context: Context = {
    repo: data.repo, source: data.source, branches: data.branches, notices: data.notices,
    events: data.events.slice(0, cur?.cursor ?? 0), samples: [...samples], focus,
  }
  let answer: Answer = explain(question, context)
  let label = 'Rule-based explanation'
  let note = 'No language model is configured, so fixed rules wrote this from the recorded readings.'
  const summary = summarize(question, context)
  try { // the optional model endpoint; without it, or on any failure, the rule-based answer stands
    const res = await fetch('/api/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(summary) })
    const body = await res.json()
    const parsed = res.ok ? parseAnswer(body.answer) : null
    if (parsed && !unknownEvidence(parsed, summary.events.map((e) => e.ref)).length) {
      answer = parsed
      label = 'Model explanation'
      note = `Written by ${String(body.model).slice(0, 60)} from a summary of the recorded readings. Every record it cites was checked against the dataset.`
    } else if (parsed || res.status === 422) {
      note = 'The model cited records that are not in this dataset, so its answer was discarded. Fixed rules wrote this instead.'
    } else if (res.status !== 503) {
      note = 'The model could not be reached, so fixed rules wrote this from the recorded readings.'
    }
  } catch { /* no endpoint here (static hosting or offline) */ }
  const li = el('li', '', 'new')
  const head = el('p', '', 'asked')
  head.append(el('span', label, `badge ${label === 'Model explanation' ? 'model' : 'rules'}`), el('strong', question))
  li.append(
    head, el('small', note),
    ...claims('Facts', answer.facts), ...claims('Applied rules', answer.rules),
    el('h3', 'Interpretation'), el('p', answer.interpretation),
    el('h3', 'Uncertainty'), (() => { const ul = el('ul'); ul.append(...answer.uncertainty.map((u) => el('li', u))); return ul })(),
  )
  $('#answers').prepend(li)
  while ($('#answers').childElementCount > 5) $('#answers').lastElementChild!.remove()
}

$('#ask').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $<HTMLInputElement>('#question')
  const button = $<HTMLButtonElement>('#ask button')
  button.disabled = true
  await ask(input.value.trim() || input.placeholder)
  button.disabled = false
})
$('#suggest').addEventListener('click', (e) => {
  if (e.target instanceof HTMLButtonElement) ask(e.target.textContent ?? '')
})

// ---- Projects mode: one repository per body -----------------------------------------------------

function readout() {
  if (!projects) return
  const by = (k: string) => projects!.projects.filter((p) => p.lifecycle === k).length
  const prs = projects.projects.reduce((n, p) => n + p.prs.total, 0)
  const issues = projects.projects.reduce((n, p) => n + p.issues.total, 0)
  $('#preadout').textContent =
    `${projects.projects.length} projects · ${by('active')} active · ${by('quiet')} quiet · ${by('abandoned')} abandoned · ` +
    `${prs.toLocaleString('en-US')} PRs · ${issues.toLocaleString('en-US')} issues`
  const notices = $<HTMLDetailsElement>('#pnotices')
  notices.open = true
  notices.firstElementChild!.textContent = `Data boundaries (${projects.notices.length})`
  notices.lastElementChild!.replaceChildren(...projects.notices.map((n) => el('li', n)))
}

function projectLegend() {
  if (!projects) return
  $('#plegend').replaceChildren(...projects.projects.map((p) => {
    const li = el('li')
    const button = el('button')
    button.type = 'button'
    button.dataset.repo = p.repo
    button.title = 'Inspect this project'
    button.setAttribute('aria-pressed', String(picked?.id === p.repo))
    button.append(el('span', p.repo), el('b', `${p.prs.total} PR`), el('u', p.lifecycle))
    button.addEventListener('click', () => selectProject(agents.find((a) => a.id === p.repo) ?? null))
    li.append(button)
    return li
  }))
}

function selectProject(a: Agent | null) {
  picked = a
  for (const button of $('#plegend').querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.repo === a?.id))
  }
  const box = $('#project')
  if (!a) return box.replaceChildren(el('p', 'Click a fish, rock, or seaweed to read the repository behind it.', 'hint'))
  const p = a.project
  const pulls = countPulls(p.prs.recent)
  const issues = countIssues(p.issues.recent)
  const who = el('p', '', 'who')
  who.append(el('strong', p.name), el('span', `${p.repo} · ${a.kind}`))
  const facts = el('dl')
  const row = (label: string, value: string | Node) => {
    const dd = el('dd')
    if (typeof value === 'string') dd.textContent = value
    else dd.append(value)
    facts.append(el('dt', label), dd)
  }
  const since = Date.parse(p.created)
  const years = Number.isFinite(since) ? (Date.now() - since) / 31_557_600_000 : 0
  const projectLink = document.createElement('a')
  projectLink.href = p.url
  projectLink.target = '_blank'
  projectLink.rel = 'noopener'
  projectLink.textContent = p.repo
  row('Project', projectLink)
  row('Theme', p.theme)
  row('Age', `${p.created.slice(0, 10)} · ${years.toFixed(1)} years old`)
  row('Upkeep', `last push ${p.pushed.slice(0, 10)} · ${p.quietDays} days quiet · ${Math.round(p.activity * 100)}% recent activity`)
  row('Lifecycle', p.lifecycle)
  row('Bones', `${p.prs.total} pull requests · ${pulls.merged} merged · ${pulls.open} open · ${pulls.closed} closed in the latest ${p.prs.recent.length}`)
  row('Scales', `${p.issues.total} issues · ${issues.open} open · ${issues.question} marked question in the latest ${p.issues.recent.length}`)
  const recent = el('ol', '', 'recent')
  for (const pr of p.prs.recent.slice(0, 5)) {
    const li = el('li')
    const label = pr.url ? document.createElement('a') : document.createElement('span')
    if (pr.url) {
      const link = label as HTMLAnchorElement
      link.href = pr.url
      link.target = '_blank'
      link.rel = 'noopener'
    }
    label.textContent = `#${pr.number} ${pr.title}`
    li.append(label, el('small', ` · ${pr.state}`))
    recent.append(li)
  }
  box.replaceChildren(who, facts, el('h3', 'Latest pull requests'), recent)
}

async function loadProjects(input: string) {
  const button = $<HTMLButtonElement>('#pload')
  button.disabled = true
  $('#error').textContent = 'Loading projects...'
  try {
    const set = await fetchProjects(input.trim() || DEFAULT_REPOS.join(' '))
    projects = set
    agents = placeProjects(set.projects)
    picked = null
    projectRev++
    readout()
    projectLegend()
    selectProject(null)
    $('#error').textContent = ''
  } catch (err) {
    $('#error').textContent = `Could not load projects: ${(err as Error).message}${projects ? ' The previous tank is still shown.' : ''}`
    if (!projects) $('#preadout').textContent = 'No projects loaded. Each project costs three GitHub requests; without a token GitHub allows 60 an hour.'
  } finally {
    button.disabled = false
  }
}

function showMode(next: 'ecosystem' | 'projects') {
  mode = next
  document.body.dataset.mode = next
  $('#tab-eco').setAttribute('aria-pressed', String(next === 'ecosystem'))
  $('#tab-projects').setAttribute('aria-pressed', String(next === 'projects'))
  if (next === 'projects' && !projects) void loadProjects('')
}

// ---- The tank (every animation frame) -----------------------------------------------------------

let anim = 0 // seconds of animation; stands still while paused
let lastFrame = 0
let murk = 0 // displayed water stress, eased toward the simulated value

function frame(now: number) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - lastFrame) / 1000)
  lastFrame = now
  if (!tank) return
  if (mode === 'projects') {
    if (projects && running) anim += dt
    if (projects) drift(agents, dt, anim)
    const items: ProjectDraw[] = agents.map((a) => ({ id: a.id, project: a.project, x: a.x, y: a.y, z: a.z, yaw: a.yaw }))
    tank.drawProjects(items, anim, projectRev)
    ctx.clearRect(0, 0, W, H)
    ctx.font = '500 10px "Martian Mono Variable", ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (picked) {
      const [x, y] = tank.projectScene(picked.x, picked.y, picked.z)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, y, 26, 0, TAU)
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.fillText(picked.project.name, x, y - 34)
    }
    return
  }
  if (!cur) return
  const s = cur
  if (running) anim += dt
  const blend = Math.min(1, (now - arrived) / TICK_MS)
  murk += (s.penalty.reduce((a, b) => a + b, 0) / s.penalty.length / P.maxPenalty - murk) * 0.03

  // Blend each fish between the last two snapshots so it glides rather than steps.
  const swimmers: Swimmer[] = s.organisms.map((o) => {
    const p = from.get(o.id) ?? o
    const ux = p.ux + (o.ux - p.ux) * blend
    const uy = p.uy + (o.uy - p.uy) * blend
    const uz = p.uz + (o.uz - p.uz) * blend
    const len = Math.hypot(ux, uy, uz) || 1
    const age = born.has(o.id) ? (now - born.get(o.id)!) / 700 : 1
    return {
      id: o.id, lineage: o.lineage, genome: o.genome,
      x: p.x + (o.x - p.x) * blend, y: p.y + (o.y - p.y) * blend, z: p.z + (o.z - p.z) * blend,
      ux: ux / len, uy: uy / len, uz: uz / len,
      energy: o.energy / maxEnergy(o.genome),
      grown: Math.min(1, age),
      dim: focus !== null && o.lineage !== focus,
    }
  })
  const living = swimmers.length
  drawn = swimmers.slice()
  fading = fading.filter((f) => now - f.at < 900)
  for (const { o, at } of fading) { // the dead lose their colour, shrink, and sink
    const k = (now - at) / 900
    swimmers.push({ ...o, y: o.y - 45 * k, energy: 0, grown: 1 - k, dim: false })
  }
  tank.draw(swimmers, s.food, murk, anim)

  // Recent pull requests: an arc between the eldest fish of the two lineages, or a ring if only one branch is in the snapshot.
  ctx.clearRect(0, 0, W, H)
  ctx.font = '500 10px "Martian Mono Variable", ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const followed = selected && !selected.died && drawn.find((f) => f.id === selected!.o.id)
  if (followed) { // a ring that follows the inspected fish
    const [x, y] = tank.project(followed.x, followed.y, followed.z)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(x, y, 20, 0, TAU)
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.fillText(`#${followed.id}`, x, y - 30)
  }
  for (let i = s.cursor - 1; i >= 0 && s.tick - data.events[i].tick < LINK_TICKS; i--) {
    const e = data.events[i]
    if (e.kind !== 'PR_OPENED' && e.kind !== 'PR_MERGED') continue
    const [head, base] = e.branches.map((b) => {
      const lineage = data.branches.indexOf(b)
      for (let j = 0; lineage >= 0 && j < living; j++) {
        if (swimmers[j].lineage === lineage) return tank.project(swimmers[j].x, swimmers[j].y, swimmers[j].z)
      }
    })
    const anchor = base ?? head
    if (!anchor) continue
    const age = (s.tick - e.tick) / LINK_TICKS
    const merged = e.kind === 'PR_MERGED'
    let [lx, ly] = anchor
    ly -= 34
    ctx.save()
    ctx.globalAlpha = Math.min(1, 3 * (1 - age))
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = merged ? 2 : 1.25
    ctx.setLineDash(merged ? [] : [4, 6])
    ctx.beginPath()
    if (head && base) {
      const mx = (head[0] + base[0]) / 2
      const my = (head[1] + base[1]) / 2 - Math.max(40, 0.3 * Math.hypot(head[0] - base[0], head[1] - base[1]))
      ctx.moveTo(head[0], head[1])
      ctx.quadraticCurveTo(mx, my, base[0], base[1])
      lx = 0.25 * head[0] + 0.5 * mx + 0.25 * base[0] // the top of the arc
      ly = 0.25 * head[1] + 0.5 * my + 0.25 * base[1] - 16
    } else {
      ctx.arc(anchor[0], anchor[1], 18 + 46 * age, 0, TAU)
    }
    ctx.stroke()
    ctx.setLineDash([])
    const label = `PR #${e.id} ${merged ? 'MERGED' : 'OPENED'}`
    const width = ctx.measureText(label).width + 16
    ctx.fillStyle = 'rgba(6, 22, 34, 0.8)'
    ctx.beginPath()
    ctx.roundRect(lx - width / 2, ly - 9, width, 18, 9)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.fillText(label, lx, ly + 0.5)
    ctx.restore()
  }
}

$('#tab-eco').addEventListener('click', () => showMode('ecosystem'))
$('#tab-projects').addEventListener('click', () => showMode('projects'))
$<HTMLFormElement>('#psource').addEventListener('submit', (e) => {
  e.preventDefault()
  void loadProjects($<HTMLInputElement>('#prepos').value)
})

use(demo)
requestAnimationFrame(frame)
