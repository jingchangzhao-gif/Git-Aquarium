// Deterministic artificial-life engine.
// No DOM, network, or storage: same seed -> same state at the same tick.

export const TRAITS = [
  'bodyLength', 'finSize', 'hue', 'speed',
  'metabolism', 'perceptionRange', 'lifespan', 'mutationRate',
] as const
export type Trait = (typeof TRAITS)[number]
export type Genome = Record<Trait, number> // every trait normalized to [0, 1]

export interface Organism {
  id: number
  lineage: number
  genome: Genome
  parents: [number, number] | null // null for the founding population
  x: number // across the tank
  y: number // height above the floor
  z: number // depth, away from the viewer
  ux: number // unit vector: the direction it is swimming
  uy: number
  uz: number
  energy: number
  age: number // ticks
  cooldown: number // ticks until it may reproduce again
}

export interface State {
  tick: number
  rng: number // mulberry32 state, kept in the state so a snapshot resumes exactly
  nextId: number
  organisms: Organism[]
  food: { x: number; y: number; z: number; lineage: number }[] // lineage: who may eat it; -1 is anyone
  births: number
  deaths: number
  mutations: number
  tally: { born: number; founded: number; starved: number; aged: number }[] // arrivals and deaths per lineage; `founded` counts re-founding only
  cursor: number // index of the next repository event to apply
  failing: { group: string; lineage: number }[] // CI groups (workflow@branch) whose latest supported result is a failure
  penalty: number[] // per lineage: extra energy cost per organism per tick while its branch's CI is failing
}

export type EventKind = 'COMMIT_OBSERVED' | 'PR_OPENED' | 'PR_MERGED' | 'CI_FAILED' | 'CI_PASSED'

// One frozen repository record, already placed on the replay clock.
export interface GitEvent {
  tick: number
  at: string // ISO time used as the replay proxy (committer, created, merged, or completed time)
  kind: EventKind
  id: string // sha, PR number, or run id
  title: string
  url: string | null // GitHub source; null for synthetic events
  branches: string[] // [] unknown, [head, base] for PRs, [branch] for commits and CI
  lineage: number // the lineage this event acts on: its branch's (a merge: the base branch's), or -1 for the whole tank
  group: string // CI only: workflow@branch
}

// Designed simulation rules, not measurements of software quality.
export const RULES: Record<EventKind, { id: string; effect: string }> = {
  COMMIT_OBSERVED: { id: 'R-COMMIT-FOOD', effect: "adds a bounded amount of food for its branch's lineage" },
  PR_OPENED: { id: 'R-PR-OPEN', effect: 'shows an interaction between lineages; no ecological effect' },
  PR_MERGED: { id: 'R-PR-MERGE', effect: "adds a bounded food pulse for the base branch's lineage and a visual connection" },
  CI_FAILED: { id: 'R-CI-FAIL', effect: "raises the bounded energy cost of its branch's lineage for this workflow, and clouds its water so no fish of it sees far; keen eyes stop paying for themselves" },
  CI_PASSED: { id: 'R-CI-PASS', effect: "clears this workflow's cost on its branch's lineage; recovery is gradual" },
}

// Starting parameters from the README; tuning knobs, not measurements.
export const P = {
  width: 800,
  height: 500,
  depth: 260,
  ticksPerSecond: 20,
  startPopulation: 64,
  maxPopulation: 200,
  maxFood: 500,
  startFood: 120,
  foodPerTick: 0.4, // baseline supply (R-BASELINE): chance of one new particle per tick, with or without Git activity
  commitFood: 12, // particles per deduplicated commit
  mergeFood: 40, // particles per confirmed merge
  founders: 4, // a commit or merge on a branch tops its lineage back up to this many organisms
  penaltyPerGroup: 0.015, // energy per tick for each failing CI group
  maxPenalty: 0.045,
  penaltyRecovery: 0.0003, // how fast the penalty falls per tick once a group passes
  foodEnergy: 12,
  baseCost: 0.03,
  moveCost: 0.008,
  senseCost: 0.0001,
  // Selection by the repository (issue #10): the environment, not only the supply, decides which genes pay.
  murkSight: 90, // while a lineage's CI fails, none of its fish sees further than this, however good its eyes
  // Swimming: fish turn gradually, cruise level, and school with their own lineage.
  turnRate: 0.08, // max change of direction per tick (radians) while cruising
  chaseTurnRate: 0.18, // ...and while heading for food
  minTurnSpeed: 0.35, // fraction of speed kept through a sharp turn
  wander: 0.25, // sideways meander while cruising
  level: 0.6, // below 1, cruising fish favour horizontal travel
  schoolRange: 90,
  cohesion: 0.4, // pull toward nearby lineage-mates
  alignment: 0.8, // tendency to match their direction
  personalSpace: 18,
  separation: 1.5, // push away from anyone closer than personalSpace
  wallMargin: 50,
  wallPush: 1.2, // steer away from the glass before reaching it
  maturity: 0.15, // fraction of lifespan before breeding
  breedEnergy: 0.6, // fraction of max energy needed to breed
  breedCost: 0.25, // fraction of max energy each parent gives the child
  cooldown: 200,
  mateRange: 170,
  mutationStep: 0.1,
}

export const maxEnergy = (g: Genome) => 60 + 80 * g.bodyLength
export const lifespanTicks = (g: Genome) => 1200 + 3600 * g.lifespan
export const sightRange = (g: Genome) => 40 + 155 * g.perceptionRange
export const swimSpeed = (g: Genome) => 0.8 + 2.2 * g.speed
const eatRange = (g: Genome) => 6 + 6 * g.bodyLength
const mutationChance = (g: Genome) => 0.02 + 0.18 * g.mutationRate

function rand(s: State): number {
  s.rng = (s.rng + 0x6d2b79f5) | 0
  let t = s.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const spot = (s: State) => ({ x: rand(s) * P.width, y: rand(s) * P.height, z: rand(s) * P.depth })
// No trigonometry in the engine: Math.cos and Math.sin may differ in the last bit between JavaScript engines,
// while + - * / and Math.sqrt are exact by the standard. So the same replay gives the same hash in every browser.
// The turn rates as fixed constants: cos and sin of P.turnRate and P.chaseTurnRate (a test checks they match).
export const TURN = {
  cruise: { cos: 0.9968017063026194, sin: 0.0799146939691727 },
  chase: { cos: 0.9838436927881214, sin: 0.17902957342582418 },
}

// A random level direction: fish start out, and are born, swimming horizontally.
// A point picked evenly inside the unit circle, scaled out to its edge, gives every heading the same chance.
function level(s: State) {
  for (;;) {
    const x = rand(s) * 2 - 1
    const z = rand(s) * 2 - 1
    const r = x * x + z * z
    if (r > 1e-6 && r <= 1) {
      const n = Math.sqrt(r)
      return { ux: x / n, uy: 0, uz: z / n }
    }
  }
}

// One lineage per observed branch (R-BRANCH-LINEAGE); the starting population is shared between them.
export function createState(seed: number, lineages = 4): State {
  const s: State = {
    tick: 0, rng: seed | 0, nextId: 1,
    organisms: [], food: [], births: 0, deaths: 0, mutations: 0,
    tally: Array.from({ length: lineages }, () => ({ born: 0, founded: 0, starved: 0, aged: 0 })),
    cursor: 0, failing: [], penalty: Array.from({ length: lineages }, () => 0),
  }
  for (let i = 0; i < P.startPopulation; i++) found(s, i % lineages)
  addFood(s, P.startFood, -1)
  return s
}

// A founder: random genes, no parents.
function found(s: State, lineage: number) {
  const genome = {} as Genome
  for (const t of TRAITS) genome[t] = rand(s)
  s.organisms.push({
    id: s.nextId++, lineage, genome, parents: null,
    ...spot(s), ...level(s),
    energy: maxEnergy(genome) * 0.6,
    age: Math.floor(rand(s) * lifespanTicks(genome) * 0.5), // mixed ages so founders don't die together
    cooldown: 0,
  })
}

// Food for one lineage, or for anyone when the lineage is -1. Activity on a branch whose lineage has
// all but died out also re-founds it (R-BRANCH-FOUND): a branch is never deleted by its organisms dying.
function addFood(s: State, particles: number, lineage: number) {
  for (let i = 0; i < particles && s.food.length < P.maxFood; i++) s.food.push({ ...spot(s), lineage })
  if (lineage < 0) return
  const alive = s.organisms.filter((o) => o.lineage === lineage).length
  for (let i = alive; i < P.founders && s.organisms.length < P.maxPopulation; i++) {
    found(s, lineage)
    s.tally[lineage].founded++
  }
}

// `events` is the frozen dataset in replay order; the state only remembers how far it has read.
export function step(s: State, events: readonly GitEvent[] = []): void {
  s.tick++
  // 1. Scheduled repository events.
  for (; s.cursor < events.length && events[s.cursor].tick <= s.tick; s.cursor++) {
    const e = events[s.cursor]
    if (e.kind === 'COMMIT_OBSERVED') addFood(s, P.commitFood, e.lineage)
    else if (e.kind === 'PR_MERGED') addFood(s, P.mergeFood, e.lineage)
    else if (e.kind === 'CI_FAILED') { if (!s.failing.some((f) => f.group === e.group)) s.failing.push({ group: e.group, lineage: e.lineage }) }
    else if (e.kind === 'CI_PASSED') s.failing = s.failing.filter((f) => f.group !== e.group)
  }
  // Each lineage pays for the failing groups on its own branch (and for any on an unknown branch).
  // Failures bite at once; recovery is gradual.
  for (let l = 0; l < s.penalty.length; l++) {
    const groups = s.failing.filter((f) => f.lineage === l || f.lineage < 0).length
    const target = Math.min(P.maxPenalty, groups * P.penaltyPerGroup)
    s.penalty[l] = s.penalty[l] < target ? target : Math.max(target, s.penalty[l] - P.penaltyRecovery)
  }

  // 2. Baseline resources, shared by every lineage.
  if (rand(s) < P.foodPerTick) addFood(s, 1, -1)

  // 3-5. Perception, movement, eating, energy, age.
  // Directions as they were when the tick began, so schooling does not depend on update order.
  const hx = s.organisms.map((o) => o.ux)
  const hy = s.organisms.map((o) => o.uy)
  const hz = s.organisms.map((o) => o.uz)
  for (let k = 0; k < s.organisms.length; k++) {
    const o = s.organisms[k]
    const g = o.genome
    const eyes = sightRange(g) // what it pays for
    const sight = s.penalty[o.lineage] > 0 ? Math.min(eyes, P.murkSight) : eyes // what it can use (R-CI-FAIL murk)
    const speed = swimSpeed(g)
    // ponytail: O(organisms x food) scan, ~100k checks at the caps; spatial grid if the caps grow
    let target = -1
    let best = sight * sight
    for (let i = 0; i < s.food.length; i++) {
      if (s.food[i].lineage >= 0 && s.food[i].lineage !== o.lineage) continue // another lineage's food
      const dx = s.food[i].x - o.x
      const dy = s.food[i].y - o.y
      const dz = s.food[i].z - o.z
      const d = dx * dx + dy * dy + dz * dz
      if (d < best) { best = d; target = i }
    }

    // Where it wants to go: toward food if it sees any, otherwise straight ahead.
    const chasing = target >= 0
    let dx = hx[k]
    let dy = hy[k]
    let dz = hz[k]
    if (chasing) {
      const gap = Math.sqrt(best) || 1
      dx = (s.food[target].x - o.x) / gap
      dy = (s.food[target].y - o.y) / gap
      dz = (s.food[target].z - o.z) / gap
    }
    // ponytail: O(organisms^2) neighbour scan, 40k checks at the cap; share a grid with the food scan if the cap grows
    let cx = 0, cy = 0, cz = 0, ax = 0, ay = 0, az = 0, mates = 0
    for (let j = 0; j < s.organisms.length; j++) {
      if (j === k) continue
      const m = s.organisms[j]
      const mx = m.x - o.x
      const my = m.y - o.y
      const mz = m.z - o.z
      const d2 = mx * mx + my * my + mz * mz
      if (d2 > 0 && d2 < P.personalSpace * P.personalSpace) {
        const d = Math.sqrt(d2)
        const push = (P.separation * (1 - d / P.personalSpace)) / d
        dx -= mx * push
        dy -= my * push
        dz -= mz * push
      }
      if (!chasing && m.lineage === o.lineage && d2 < P.schoolRange * P.schoolRange) {
        cx += mx; cy += my; cz += mz; ax += hx[j]; ay += hy[j]; az += hz[j]; mates++
      }
    }
    if (!chasing) {
      if (mates) {
        dx += (P.cohesion * cx) / mates / P.schoolRange + (P.alignment * ax) / mates
        dy += (P.cohesion * cy) / mates / P.schoolRange + (P.alignment * ay) / mates
        dz += (P.cohesion * cz) / mates / P.schoolRange + (P.alignment * az) / mates
      }
      dx += (rand(s) - 0.5) * 2 * P.wander
      dy += (rand(s) - 0.5) * P.wander
      dz += (rand(s) - 0.5) * 2 * P.wander
      dy *= P.level
      if (o.x < P.wallMargin) dx += P.wallPush * (1 - o.x / P.wallMargin)
      if (o.x > P.width - P.wallMargin) dx -= P.wallPush * (1 - (P.width - o.x) / P.wallMargin)
      if (o.y < P.wallMargin) dy += P.wallPush * (1 - o.y / P.wallMargin)
      if (o.y > P.height - P.wallMargin) dy -= P.wallPush * (1 - (P.height - o.y) / P.wallMargin)
      if (o.z < P.wallMargin) dz += P.wallPush * (1 - o.z / P.wallMargin)
      if (o.z > P.depth - P.wallMargin) dz -= P.wallPush * (1 - (P.depth - o.z) / P.wallMargin)
    }

    // Swing the swimming direction toward the wanted one by at most the turn rate.
    const want = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
    dx /= want; dy /= want; dz /= want
    const along = o.ux * dx + o.uy * dy + o.uz * dz // cosine of the angle still to turn
    let wx = dx - along * o.ux // the part of the wanted direction that is sideways to the current one
    let wy = dy - along * o.uy
    let wz = dz - along * o.uz
    let side = Math.sqrt(wx * wx + wy * wy + wz * wz)
    if (side < 1e-9 && along < 0) { // exactly behind: any sideways direction will do, so turn level
      wx = -o.uz; wy = 0; wz = o.ux
      side = Math.sqrt(wx * wx + wz * wz)
      if (side < 1e-9) { wx = 1; side = 1 }
    }
    if (side >= 1e-9) {
      const rate = chasing ? TURN.chase : TURN.cruise
      if (along >= rate.cos) { // less than one turn step away: face it
        o.ux = dx; o.uy = dy; o.uz = dz
      } else { // rotate one turn step toward it, in the plane of the two directions
        const t = rate.sin / side
        o.ux = o.ux * rate.cos + wx * t
        o.uy = o.uy * rate.cos + wy * t
        o.uz = o.uz * rate.cos + wz * t
      }
      const len = Math.sqrt(o.ux * o.ux + o.uy * o.uy + o.uz * o.uz) // stop rounding error building up
      o.ux /= len; o.uy /= len; o.uz /= len
    }
    const move = speed * Math.max(P.minTurnSpeed, along) // slow through sharp turns
    o.x += o.ux * move
    o.y += o.uy * move
    o.z += o.uz * move
    if (o.x < 0 || o.x > P.width) { // the glass itself, if steering was not enough
      o.x = Math.min(P.width, Math.max(0, o.x))
      o.ux = -o.ux
    }
    if (o.y < 0 || o.y > P.height) {
      o.y = Math.min(P.height, Math.max(0, o.y))
      o.uy = -o.uy
    }
    if (o.z < 0 || o.z > P.depth) {
      o.z = Math.min(P.depth, Math.max(0, o.z))
      o.uz = -o.uz
    }

    if (chasing) {
      const fx = s.food[target].x - o.x
      const fy = s.food[target].y - o.y
      const fz = s.food[target].z - o.z
      const reach = eatRange(g)
      if (fx * fx + fy * fy + fz * fz <= reach * reach) {
        o.energy = Math.min(maxEnergy(g), o.energy + P.foodEnergy * (0.6 + 0.8 * g.metabolism))
        s.food[target] = s.food[s.food.length - 1]
        s.food.pop()
      }
    }
    o.energy -=
      P.baseCost * (0.5 + g.metabolism) * (0.5 + g.bodyLength) +
      P.moveCost * speed * speed +
      P.senseCost * eyes +
      s.penalty[o.lineage]
    o.age++
    if (o.cooldown > 0) o.cooldown--
  }

  // 6. Deaths: starvation or old age.
  const alive = s.organisms.filter((o) => {
    if (o.energy > 0 && o.age < lifespanTicks(o.genome)) return true
    s.tally[o.lineage][o.energy > 0 ? 'aged' : 'starved']++ // out of energy counts as starvation even at the end of a lifespan
    return false
  })
  s.deaths += s.organisms.length - alive.length
  s.organisms = alive

  // 7. Reproduction: two ready organisms of the same lineage within mating range.
  const ready = (o: Organism) =>
    o.cooldown === 0 &&
    o.age >= P.maturity * lifespanTicks(o.genome) &&
    o.energy >= P.breedEnergy * maxEnergy(o.genome)
  const n = alive.length // newborns appended below are never scanned this tick
  for (let i = 0; i < n && alive.length < P.maxPopulation; i++) {
    const a = alive[i]
    if (!ready(a)) continue
    for (let j = i + 1; j < n; j++) {
      const b = alive[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      if (b.lineage !== a.lineage || !ready(b) || dx * dx + dy * dy + dz * dz > P.mateRange * P.mateRange) continue
      alive.push(breed(s, a, b))
      break
    }
  }
}

function breed(s: State, a: Organism, b: Organism): Organism {
  const chance = (mutationChance(a.genome) + mutationChance(b.genome)) / 2
  const genome = {} as Genome
  for (const t of TRAITS) {
    let v = rand(s) < 0.5 ? a.genome[t] : b.genome[t]
    if (rand(s) < chance) {
      v = Math.min(1, Math.max(0, v + (rand(s) - 0.5) * 2 * P.mutationStep))
      s.mutations++
    }
    genome[t] = v
  }
  // Parents pay; the child starts with what they paid (anything above its capacity is lost).
  const paidA = P.breedCost * maxEnergy(a.genome)
  const paidB = P.breedCost * maxEnergy(b.genome)
  a.energy -= paidA
  b.energy -= paidB
  a.cooldown = b.cooldown = P.cooldown
  s.births++
  s.tally[a.lineage].born++
  return {
    id: s.nextId++, lineage: a.lineage, genome, parents: [a.id, b.id],
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2, ...level(s),
    energy: Math.min(maxEnergy(genome), paidA + paidB), age: 0, cooldown: 0,
  }
}

// FNV-1a over the JSON form; JSON round-trips doubles exactly, so equal hash <=> equal state.
export function hashState(s: State): string {
  const json = JSON.stringify(s)
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
