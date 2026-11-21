// Zooming into one project: the camera flight's easing and framing, picking a scale on the body, and the
// short panel seaweed and rocks get. No rendering here, so all of it runs (and is tested) without WebGL.
import * as THREE from 'three'
import type { Project } from './projects'

export const ease = (t: number) => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

// How far back a camera with this vertical field of view (degrees) must stand to fit a body seen side-on:
// its length across the view and its height up it, with a little water around it.
export function fitDistance(halfLength: number, halfHeight: number, fov: number, aspect: number): number {
  const v = Math.tan(THREE.MathUtils.degToRad(fov) / 2)
  return 1.2 * Math.max(halfHeight / v, halfLength / (v * aspect))
}

export const FLOOR_Y = 0 // the top of the sand, with its ripples, in world units

// How far the zoomed camera may be turned and moved: close, but outside the body; back, but not into the
// dark past the fog; and never below the sand. The camera's height is centerY + distance * cos(polar), so
// the lowest allowed angle is checked at both the nearest and the farthest distance.
export function orbitLimits(body: { distance: number; radius: number; centerY: number }) {
  const minDistance = Math.min(body.radius * 1.15, body.distance * 0.9)
  const maxDistance = body.distance * 2.2
  const clearance = FLOOR_Y + 0.3 - body.centerY
  const lowest = (d: number) => Math.acos(Math.min(1, Math.max(-1, clearance / d)))
  return {
    minDistance,
    maxDistance,
    minPolarAngle: 0.08 * Math.PI, // not straight down from above, where the controls spin
    maxPolarAngle: Math.min(0.8 * Math.PI, lowest(minDistance), lowest(maxDistance)),
  }
}

export type Pick = { kind: 'scale'; featureId: string } | { kind: 'body' }

// What a click on a zoomed project hits. Scales are the only parts on the outside; bones sit inside the
// body and are chosen from the side list, so a ray reports the nearest scale it crosses, else the body.
// Each band's plates on both sides are one mesh with one feature, so both sides open the same thing.
export function pickScale(group: THREE.Object3D, ray: THREE.Raycaster): Pick | null {
  const hits = ray.intersectObject(group, true)
  const scale = hits.find((h) => h.object.userData.part?.kind === 'scale')
  if (scale) return { kind: 'scale', featureId: scale.object.userData.part.featureId }
  return hits.length ? { kind: 'body' } : null
}

const GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/

// Seaweed and rocks are projects at rest: their panel says what they hold, when they were last kept,
// and how to take a copy. No pull requests, commits, or issues.
export function stillLife(p: Project, _now: number) {
  const days = p.quietDays
  const ago = days === null ? 'unknown (GitHub gave no push date)' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days.toLocaleString('en')} days ago`
  const url = GITHUB.test(p.url) ? p.url : null
  return {
    features: p.anatomy.features.map((f) => f.name),
    maintained: `last update ${ago} · ${p.lifecycle}`,
    clone: url && `git clone ${url}.git`,
    zip: url && `${url}/archive/HEAD.zip`,
    releases: url && `${url}/releases`,
  }
}
