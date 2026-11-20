// One project is one fish: its description is the spine, its features are the big bones, its issues
// are the small bones and the scale surface, and a merged pull request that closed an issue is the
// connection between them. This file only builds geometry; fishschool.ts decides where it swims.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { scaleId, scaleTint, visibleIssues } from './anatomy.ts'
import type { Project } from './projects'

export type Shape = 'fish' | 'rock' | 'seaweed'

export interface ProjectShape {
  id: string
  shape: Shape
  group: THREE.Group
}

const wave = { value: 0 } // one clock for every tail and blade, so the tank moves together

const SPINE = '#e7ddc5'
const FEATURE = '#f7f2e2'
const ISSUE = '#f0b429'
const LINK = '#8ecbdc'
const SCALE = '#d9e4e6'
const ROUGH = '#e0a04a'
const EYE = '#0c1921'

export function waving<T extends THREE.Material>(material: T, sway = false) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWave = wave
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWave;')
      .replace('#include <begin_vertex>', sway
        ? `#include <begin_vertex>
          transformed.x += sin(uWave * 1.2 + position.y * 2.4) * 0.22 * position.y * position.y;`
        : `#include <begin_vertex>
          float tail = smoothstep(1.0, -1.2, position.x);
          transformed.z += sin(uWave * 1.7 + position.x * 2.4) * 0.06 * tail * tail;
          transformed.y += sin(uWave * 1.3 + position.x * 1.7) * 0.02 * tail;`)
  }
  return material
}

const skin = (color: string, roughness: number) => waving(new THREE.MeshStandardMaterial({
  color, transparent: true, opacity: 0.68, roughness, metalness: 0.08, side: THREE.DoubleSide, depthWrite: false,
}))
const skinMaterial = skin('#6fb6c9', 0.22)
const quietSkin = skin('#87969a', 0.8) // a project nobody has pushed to for 90 days: grey and dull
const spineMaterial = waving(new THREE.MeshStandardMaterial({ color: SPINE, roughness: 0.5, metalness: 0.1 }))
const featureMaterial = waving(new THREE.MeshStandardMaterial({ color: FEATURE, roughness: 0.45, metalness: 0.2 }))
const issueMaterial = waving(new THREE.MeshStandardMaterial({ color: ISSUE, roughness: 0.4, metalness: 0.2 }))
const linkMaterial = waving(new THREE.MeshStandardMaterial({
  color: LINK, transparent: true, opacity: 0.7, roughness: 0.3, metalness: 0.3,
}))
const eyeMaterial = new THREE.MeshStandardMaterial({ color: EYE, roughness: 0.2 })
const rockMaterial = new THREE.MeshStandardMaterial({ color: '#7c7568', roughness: 0.95 })
const weedMaterial = waving(new THREE.MeshStandardMaterial({ color: '#3f7d5a', roughness: 0.9, side: THREE.DoubleSide }), true)

const ROWS = 4 // scale rows per feature band; the slabs run nose to tail

// Half-height of the body at a normalized position along it, from nose (+1) to tail (-1).
function girth(u: number) {
  // Widest a quarter of the way back from the nose, tapering to a thin tail stock.
  return 0.16 + 0.9 * Math.max(0, 1 - Math.pow((u + 0.25) / 1.35, 2))
}

function merged(parts: THREE.BufferGeometry[], material: THREE.Material, shadow = true) {
  if (!parts.length) return null // mergeGeometries reads geometries[0] and throws on an empty list
  const geometry = mergeGeometries(parts)
  if (!geometry) return null
  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = shadow
  return mesh
}

function buildFish(p: Project): THREE.Group {
  const size = p.size
  const half = 0.75 * size // nose at +half, tail at -half
  const height = 0.55 * size
  const width = 0.28 * size
  const group = new THREE.Group()

  const body = new THREE.SphereGeometry(1, 40, 24)
  const position = body.attributes.position
  for (let i = 0; i < position.count; i++) {
    const u = position.getX(i)
    const k = girth(u)
    position.setX(i, u * half)
    position.setY(i, position.getY(i) * (height / 2) * k)
    position.setZ(i, position.getZ(i) * (width / 2) * k)
  }
  body.computeVertexNormals()

  const tail = new THREE.ShapeGeometry(new THREE.Shape([
    new THREE.Vector2(-0.92, 0.16), new THREE.Vector2(-1.32, 0.4), new THREE.Vector2(-1.18, 0),
    new THREE.Vector2(-1.32, -0.4), new THREE.Vector2(-0.92, -0.16),
  ]))
  tail.scale(size, size, size)
  const coat = merged([body, tail], p.lifecycle === 'slowing' ? quietSkin : skinMaterial)
  if (coat) group.add(coat)

  const spine = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-1.04 * half, 0.03 * height, 0),
    new THREE.Vector3(-0.5 * half, -0.02 * height, 0),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.55 * half, 0.02 * height, 0),
    new THREE.Vector3(half, 0.04 * height, 0),
  ])
  const bone = new THREE.Mesh(new THREE.TubeGeometry(spine, 40, 0.022 * size, 6, false), spineMaterial)
  bone.castShadow = true
  group.add(bone)

  const anatomy = p.anatomy
  const finished = p.lifecycle === 'finished'
  const features = anatomy.features
  const count = features.length

  // Feature bones: one big bone per feature, in the stable order the anatomy gives.
  // The pull request total no longer decides the bones; it only sets the body's length (p.size).
  const spots: { t: number; point: THREE.Vector3 }[] = []
  features.forEach((feature, i) => {
    const t = count <= 1 ? 0.5 : 0.12 + 0.76 * (i / (count - 1))
    const point = spine.getPointAt(t)
    spots.push({ t, point })
    const reach = (height / 2) * 0.72
    const parts: THREE.BufferGeometry[] = []
    for (const side of [-1, 1]) {
      const bar = new THREE.CylinderGeometry(0.011 * size, 0.011 * size, reach, 4, 1)
      bar.translate(point.x, point.y + (side * reach) / 2, point.z)
      parts.push(bar)
    }
    const mesh = merged(parts, featureMaterial, true)
    if (mesh) {
      mesh.userData.part = { kind: 'feature', id: feature.id, slug: feature.slug }
      group.add(mesh)
    }
  })

  // Scales: one band per feature. Open issues tint the band warmer and roughen it; a finished fish
  // keeps one even colour whatever its history held.
  features.forEach((feature, i) => {
    const open = anatomy.issues.filter((issue) => issue.open && issue.featureId === feature.id).length
    const tint = finished ? { mix: 0, roughness: 0.35 } : scaleTint(open)
    const material = waving(new THREE.MeshStandardMaterial({
      color: new THREE.Color(SCALE).lerp(new THREE.Color(ROUGH), tint.mix),
      roughness: tint.roughness, metalness: 0.35, side: THREE.DoubleSide,
    }))
    material.userData.own = true
    const u0 = -0.68 + (1.2 * i) / Math.max(1, count)
    const u1 = -0.68 + (1.2 * (i + 1)) / Math.max(1, count)
    const parts: THREE.BufferGeometry[] = []
    const COLUMNS = 2
    for (let col = 0; col < COLUMNS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const u = u0 + ((col + 0.5 + (row % 2) * 0.5) / COLUMNS) * (u1 - u0)
        const k = girth(u)
        const theta = -0.95 + (1.9 * row) / (ROWS - 1)
        for (const side of [1, -1]) {
          const plate = new THREE.CircleGeometry(0.075 * size, 6)
          plate.rotateX(-theta)
          plate.translate(u * half, Math.sin(theta) * (height / 2) * k * 0.82, Math.cos(theta) * (width / 2) * k * 1.02)
          if (side < 0) plate.scale(1, 1, -1)
          parts.push(plate)
        }
      }
    }
    const mesh = merged(parts, material, false)
    if (mesh) {
      mesh.userData.part = { kind: 'scale', id: scaleId(p.repo, feature.slug, 0), featureId: feature.id }
      group.add(mesh)
    }
  })

  // Open issues are small bones; a merged pull request that closed one is the link between its
  // small bone and its feature's big bone. A finished project keeps no open-problem overlays.
  if (!finished) {
    const shown = visibleIssues(anatomy)
    const spikes: THREE.BufferGeometry[] = []
    const points: Record<string, [number, number, number]> = {}
    for (const issue of shown) {
      const spot = spots[Math.max(0, features.findIndex((f) => f.id === issue.featureId))]
      if (!spot) continue
      const reach = (height / 2) * 0.55
      for (const side of [-1, 1]) {
        const spike = new THREE.CylinderGeometry(0.006 * size, 0.006 * size, reach, 3, 1)
        spike.translate(spot.point.x, spot.point.y + (side * reach) / 2, spot.point.z)
        spikes.push(spike)
      }
      points[issue.id] = [spot.point.x, spot.point.y, spot.point.z]
    }
    const small = merged(spikes, issueMaterial, false)
    if (small) {
      small.userData.parts = shown.map((issue) => ({ kind: 'issue', id: issue.id, number: issue.number, featureId: issue.featureId }))
      small.userData.points = points
      group.add(small)
    }

    const bars: THREE.BufferGeometry[] = []
    const pulls: { kind: string; id: string; issueId: string; number: number }[] = []
    // A link is evidence that a resolved issue was answered, so it hangs off the feature bone at the
    // scale band rather than at an open-issue spike, which would already have left the overview.
    for (const link of anatomy.links) {
      for (const issueIdValue of link.issueIds) {
        const issue = anatomy.issues.find((i) => i.id === issueIdValue)
        if (!issue || issue.open) continue
        const spot = spots[Math.max(0, features.findIndex((f) => f.id === issue.featureId))]
        if (!spot) continue
        const span = (width / 2) * 0.95
        for (const side of [-1, 1]) {
          const bar = new THREE.CylinderGeometry(0.004 * size, 0.004 * size, span, 3, 1)
          bar.rotateX(Math.PI / 2)
          bar.translate(spot.point.x, spot.point.y, (side * span) / 2)
          bars.push(bar)
        }
        pulls.push({ kind: 'pull', id: link.id, issueId: issueIdValue, number: link.number })
      }
    }
    const links = merged(bars, linkMaterial, false)
    if (links) {
      links.userData.parts = pulls
      group.add(links)
    }
  }

  const eyes = [-1, 1].map((side) =>
    new THREE.SphereGeometry(0.05 * size, 10, 8).translate(0.74 * half, 0.15 * height, side * (width / 2) * 0.62))
  const face = merged(eyes, eyeMaterial, false)
  if (face) group.add(face)

  return group
}

function buildRock(p: Project): THREE.Group {
  const size = 0.45 + 0.35 * p.size
  const rock = new THREE.SphereGeometry(1, 20, 14)
  const position = rock.attributes.position
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i)
    const k = 1 + 0.16 * Math.sin(x * 3.1) * Math.sin(y * 2.7) + 0.1 * Math.sin(z * 4.2 + x * 1.7)
    position.setXYZ(i, x * k, y * k, z * k)
  }
  rock.computeVertexNormals()
  rock.scale(size, size * 0.62, size * 0.9)
  rock.translate(0, size * 0.3, 0)
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(rock, rockMaterial)
  mesh.castShadow = mesh.receiveShadow = true
  group.add(mesh)
  return group
}

function buildSeaweed(p: Project): THREE.Group {
  const blades: THREE.BufferGeometry[] = []
  for (let i = 0; i < 5; i++) {
    const blade = new THREE.PlaneGeometry(0.14 + 0.06 * p.size, 1.3, 1, 8)
    const position = blade.attributes.position
    for (let j = 0; j < position.count; j++) {
      const y = position.getY(j) + 0.65 // base at zero, tips up
      position.setX(j, position.getX(j) * (1 - 0.8 * y / 1.3))
      position.setY(j, y)
    }
    blade.rotateY(i * 1.27)
    blade.rotateZ((i - 2) * 0.1)
    blade.translate(Math.sin(i * 2.1) * 0.18, 0, Math.cos(i * 2.1) * 0.18)
    blades.push(blade)
  }
  const group = new THREE.Group()
  const mesh = merged(blades, weedMaterial, true)
  if (mesh) group.add(mesh)
  return group
}

// The form comes from the project: archived and long-silent repositories are seaweed or rock,
// and a finished project keeps whatever shape its owner set.
export function buildProject(p: Project): ProjectShape {
  const shape = p.form
  const group = shape === 'fish' ? buildFish(p) : shape === 'rock' ? buildRock(p) : buildSeaweed(p)
  return { id: p.repo, shape, group }
}

export function disposeProject(group: THREE.Group) {
  group.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose()
      // Only the per-feature scale materials are owned by this group; the shared ones live for the page.
      if (node.material.userData?.own) node.material.dispose()
    }
  })
}

export function updateWave(time: number) {
  wave.value = time
}
