import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { buildProject } from './fish'
import { demoProjects, type Project } from './projects'
import { FLOOR_Y, ease, fitDistance, orbitLimits, pickScale, stillLife } from './zoom'

const NOW = Date.UTC(2026, 10, 20)
const set = demoProjects(NOW)
const fish = set.projects.find((p) => p.form === 'fish' && p.anatomy.features.length > 1)!

// A ray along z through one point of a scale plate, from in front of the given side.
function rayAt(x: number, y: number, side: 1 | -1) {
  return new THREE.Raycaster(new THREE.Vector3(x, y, side * 20), new THREE.Vector3(0, 0, -side))
}

// A point that lies on a scale plate of the band: the centroid of its first triangle on the +z side.
function onPlate(mesh: THREE.Mesh): THREE.Vector3 {
  const pos = mesh.geometry.getAttribute('position')
  const index = mesh.geometry.getIndex()
  for (let t = 0; t + 2 < (index ? index.count : pos.count); t += 3) {
    const v = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, index ? index.getX(t + k) : t + k))
    const c = v[0].add(v[1]).add(v[2]).divideScalar(3)
    if (c.z > 0) return c
  }
  throw new Error('no plate on the +z side')
}

describe('ease', () => {
  it('starts and ends where it should, never overshoots, and clamps', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(-1)).toBe(0)
    expect(ease(2)).toBe(1)
    let last = 0
    for (let t = 0.05; t <= 1; t += 0.05) {
      expect(ease(t)).toBeGreaterThanOrEqual(last)
      last = ease(t)
    }
    expect(ease(0.5)).toBeCloseTo(0.5)
  })
})

describe('fitDistance', () => {
  // A body seen side-on: its length runs across the view and its height up it.
  const fits = (d: number, halfLength: number, halfHeight: number, aspect: number) => {
    const v = Math.tan(THREE.MathUtils.degToRad(38) / 2)
    return d * v >= halfHeight && d * v * aspect >= halfLength
  }
  it('stands just far enough back for the whole body, on a wide and a tall view', () => {
    for (const aspect of [1.6, 0.5]) {
      const d = fitDistance(1.2, 0.47, 38, aspect)
      expect(fits(d, 1.2, 0.47, aspect)).toBe(true)
      expect(fits(d * 0.75, 1.2, 0.47, aspect)).toBe(false) // and not much further: the body fills the view
    }
    expect(fitDistance(2.4, 0.94, 38, 1.6)).toBeCloseTo(2 * fitDistance(1.2, 0.47, 38, 1.6)) // twice the size, twice the distance
    expect(fitDistance(1.2, 0.47, 38, 0.5)).toBeGreaterThan(fitDistance(1.2, 0.47, 38, 1.6)) // a phone needs more room
    expect(fitDistance(0.3, 1.5, 38, 1.6)).toBeGreaterThan(fitDistance(0.3, 0.3, 38, 1.6)) // tall seaweed fits by its height
  })
})

describe('orbitLimits', () => {
  // Where the camera sits for a polar angle (from straight up) and a distance around a target at height y.
  const cameraY = (y: number, polar: number, distance: number) => y + distance * Math.cos(polar)

  it('keeps the camera outside the body and inside the water', () => {
    const l = orbitLimits({ distance: 3, radius: 1.3, centerY: 2.2 })
    expect(l.minDistance).toBeGreaterThan(1.3) // scrolling in stops before the camera is inside the fish
    expect(l.maxDistance).toBeGreaterThanOrEqual(3 * 1.5) // room to step back
    expect(l.maxDistance).toBeLessThanOrEqual(3 * 3) // but not out past the fog into the dark
    expect(l.minDistance).toBeLessThan(3) // the arrival distance is allowed
  })

  it('never lets the camera below the sand, for a fish up high or a rock on the floor', () => {
    for (const body of [{ distance: 3, radius: 1.3, centerY: 2.2 }, { distance: 2.5, radius: 0.8, centerY: 0.4 }, { distance: 2.2, radius: 0.6, centerY: 0.35 }]) {
      const l = orbitLimits(body)
      expect(l.minPolarAngle).toBeLessThan(l.maxPolarAngle)
      for (const d of [l.minDistance, l.maxDistance]) {
        expect(cameraY(body.centerY, l.maxPolarAngle, d)).toBeGreaterThanOrEqual(FLOOR_Y + 0.3 - 1e-9)
      }
      // The pose the camera arrives at (level with the body, a little above) is inside the limits, so nothing snaps.
      expect(l.maxPolarAngle).toBeGreaterThan(Math.PI / 2 - 0.2)
    }
    const high = orbitLimits({ distance: 3, radius: 1, centerY: 50 })
    expect(high.maxPolarAngle).toBeLessThanOrEqual(0.8 * Math.PI) // far above the sand it still stops short of straight below
  })
})

describe('pickScale', () => {
  const group = buildProject(fish).group
  group.updateMatrixWorld(true)
  const bands = group.children.filter((m): m is THREE.Mesh => m.userData.part?.kind === 'scale')

  it('opens the same feature whichever side of the fish a scale is clicked on', () => {
    expect(bands.length).toBe(fish.anatomy.features.length)
    for (const band of bands) {
      const p = onPlate(band)
      const front = pickScale(group, rayAt(p.x, p.y, 1))
      const back = pickScale(group, rayAt(p.x, p.y, -1))
      expect(front).toEqual({ kind: 'scale', featureId: band.userData.part.featureId })
      expect(back).toEqual(front) // the fish is exactly symmetric
    }
  })

  it('never returns a bone, and a miss is a miss', () => {
    const box = new THREE.Box3().setFromObject(group)
    expect(pickScale(group, rayAt(box.max.x + 5, 0, 1))).toBeNull() // open water beside the fish
    const bone = group.children.find((m) => m.userData.part?.kind === 'feature') as THREE.Mesh
    bone.geometry.computeBoundingBox()
    const c = bone.geometry.boundingBox!.getCenter(new THREE.Vector3())
    // Straight down the bone from above: it may hit the body, but bones are chosen from the list only.
    const down = pickScale(group, new THREE.Raycaster(new THREE.Vector3(c.x, 20, c.z), new THREE.Vector3(0, -1, 0)))
    expect(down?.kind).not.toBe('feature')
  })

  it('reports the body, not open water, when the click lands on the fish between scales', () => {
    const body = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3())
    const hit = pickScale(group, rayAt(body.x, body.y, 1))
    expect(hit).not.toBeNull() // the middle of the body is never open water
  })

  it('finds no scales on seaweed or rock, only the body', () => {
    for (const p of set.projects.filter((x) => x.form !== 'fish')) {
      const g = buildProject(p).group
      g.updateMatrixWorld(true)
      const c = new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3())
      const hit = pickScale(g, rayAt(c.x, c.y, 1))
      expect(hit === null || hit.kind === 'body').toBe(true)
    }
  })
})

describe('stillLife', () => {
  const real: Project = { ...set.projects.find((p) => p.form !== 'fish')!, url: 'https://github.com/octo/reef', repo: 'octo/reef' }

  it('gives seaweed and rocks only features, upkeep, and how to download', () => {
    const facts = stillLife(real, NOW)
    expect(Object.keys(facts).sort()).toEqual(['clone', 'features', 'maintained', 'releases', 'zip'])
    expect(facts.features).toEqual(real.anatomy.features.map((f) => f.name))
    expect(facts.clone).toBe('git clone https://github.com/octo/reef.git')
    expect(facts.zip).toBe('https://github.com/octo/reef/archive/HEAD.zip')
    expect(facts.releases).toBe('https://github.com/octo/reef/releases')
    expect(facts.maintained).toMatch(/^last update .+ · /)
    expect(JSON.stringify(facts)).not.toMatch(/pull request|issue|commit/i)
  })

  it('offers no download for a project with no github.com address', () => {
    for (const url of ['', 'https://evil.example/octo/reef', 'javascript:alert(1)']) {
      const facts = stillLife({ ...real, url }, NOW)
      expect([facts.clone, facts.zip, facts.releases]).toEqual([null, null, null])
    }
  })

  it('says when GitHub gave no push date instead of calling it today', () => {
    expect(stillLife({ ...real, quietDays: null }, NOW).maintained).toContain('unknown')
  })
})
