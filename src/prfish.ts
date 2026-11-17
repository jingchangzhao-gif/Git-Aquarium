// One open pull request is one small fish: its length is the diff, its colour is the check state,
// and one that nobody has touched for a week fades. Geometry only; the school decides where it swims.
import * as THREE from 'three'
import { waving } from './fish'
import { STALE_DAYS, type Check, type PullSummary } from './pulls'

export const PULL_COLORS: Record<Check, string> = {
  pass: '#6fd39a', // every check succeeded
  fail: '#e2705f', // at least one failure or timeout
  pending: '#f0b429', // queued or running
  unknown: '#8ecbdc', // no check runs, or they could not be read; never a pass
}
const EYE = '#0c1921'

const skin = (color: string) => waving(new THREE.MeshStandardMaterial({
  color, transparent: true, opacity: 0.72, roughness: 0.3, metalness: 0.06, side: THREE.DoubleSide, depthWrite: false,
}))
const skins: Record<Check, THREE.MeshStandardMaterial> = {
  pass: skin(PULL_COLORS.pass), fail: skin(PULL_COLORS.fail), pending: skin(PULL_COLORS.pending), unknown: skin(PULL_COLORS.unknown),
}
const eyeMaterial = new THREE.MeshStandardMaterial({ color: EYE, roughness: 0.2 })

// `size` comes from the number of lines changed; the stale fade is a per-fish copy of the shared skin.
export function buildPullFish(pull: PullSummary): THREE.Group {
  const size = pull.size * 1.25 // a little larger than the measurement, so eight fish read at a glance
  const half = 0.5 * size // nose at +half, tail at -half
  const height = 0.34 * size
  const width = 0.24 * size
  const group = new THREE.Group()

  const geometry = new THREE.SphereGeometry(1, 24, 16)
  const position = geometry.attributes.position
  for (let i = 0; i < position.count; i++) {
    const u = position.getX(i)
    const v = position.getY(i)
    const w = position.getZ(i)
    const taper = 0.55 + 0.45 * Math.max(0, 1 - Math.pow((u + 0.2) / 1.2, 2))
    position.setXYZ(i, u * half, v * height * taper, w * width * taper)
  }
  geometry.computeVertexNormals()

  const tail = new THREE.Shape()
  tail.moveTo(0, 0)
  tail.lineTo(-0.42 * size, 0.26 * size)
  tail.lineTo(-0.42 * size, -0.26 * size)
  tail.closePath()
  const fin = new THREE.ShapeGeometry(tail)
  fin.translate(-half * 0.92, 0, 0)

  const stale = pull.staleDays >= STALE_DAYS
  const material = stale ? skins[pull.checks].clone() : skins[pull.checks]
  if (stale) {
    material.opacity = 0.4
    material.color.multiplyScalar(0.72)
  }

  const body = new THREE.Mesh(geometry, material)
  const tailMesh = new THREE.Mesh(fin, material)
  body.castShadow = true
  tailMesh.castShadow = true
  group.add(body, tailMesh)

  const eye = new THREE.SphereGeometry(0.045 * size, 8, 6)
  for (const side of [-1, 1]) {
    const mesh = new THREE.Mesh(eye, eyeMaterial)
    mesh.position.set(half * 0.6, height * 0.16, side * width * 0.82)
    group.add(mesh)
  }
  return group
}
