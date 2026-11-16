// One project is one fish: its description is the spine, its pull requests are the ribs,
// and its issues are the scales. This file only builds geometry; fishschool.ts decides where it swims.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Project } from './projects'

export type Shape = 'fish' | 'rock' | 'seaweed'

export interface ProjectShape {
  id: string
  shape: Shape
  group: THREE.Group
}

const wave = { value: 0 } // one clock for every tail and blade, so the tank moves together

const SPINE = '#e7ddc5'
const MERGED = '#f7f2e2'
const OPEN = '#f0b429'
const CLOSED = '#6d7d80'
const SCALE = '#d9e4e6'
const GAP = '#2b393d'
const QUESTION = '#f2cf3a'
const EYE = '#0c1921'

function waving<T extends THREE.Material>(material: T, sway = false) {
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

const skinMaterial = waving(new THREE.MeshStandardMaterial({
  color: '#6fb6c9', transparent: true, opacity: 0.68, roughness: 0.22, metalness: 0.08,
  side: THREE.DoubleSide, depthWrite: false,
}))
const spineMaterial = waving(new THREE.MeshStandardMaterial({ color: SPINE, roughness: 0.5, metalness: 0.1 }))
const ribsMaterial = (color: string) => waving(new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.2 }))
const ribs = { merged: ribsMaterial(MERGED), open: ribsMaterial(OPEN), closed: ribsMaterial(CLOSED) }
const scalesMaterial = (color: string) => waving(new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.35, side: THREE.DoubleSide }))
const scales = { closed: scalesMaterial(SCALE), open: scalesMaterial(GAP), question: scalesMaterial(QUESTION) }
const eyeMaterial = new THREE.MeshStandardMaterial({ color: EYE, roughness: 0.2 })
const rockMaterial = new THREE.MeshStandardMaterial({ color: '#7c7568', roughness: 0.95 })
const weedMaterial = waving(new THREE.MeshStandardMaterial({ color: '#3f7d5a', roughness: 0.9, side: THREE.DoubleSide }), true)

// Half-height of the body at a normalized position along it, from nose (+1) to tail (-1).
function girth(u: number) {
  // Widest a quarter of the way back from the nose, tapering to a thin tail stock.
  return 0.16 + 0.9 * Math.max(0, 1 - Math.pow((u + 0.25) / 1.35, 2))
}

function merged(parts: THREE.BufferGeometry[], material: THREE.Material, shadow = true) {
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
  const skin = merged([body, tail], skinMaterial)
  if (skin) group.add(skin)

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

  const bones: Record<'merged' | 'open' | 'closed', THREE.BufferGeometry[]> = { merged: [], open: [], closed: [] }
  // Every pull request gets a rib, but a dense list would close into a solid screen: at most 60 are drawn.
  const recent = p.prs.recent.slice(0, 60)
  for (let i = 0; i < recent.length; i++) {
    const t = 0.06 + 0.88 * (recent.length === 1 ? 0.5 : i / (recent.length - 1))
    const point = spine.getPointAt(t)
    const reach = (height / 2) * (0.5 + 0.5 * Math.sin(Math.PI * t))
    for (const side of [-1, 1]) {
      const rib = new THREE.CylinderGeometry(0.008 * size, 0.008 * size, reach, 4, 1)
      rib.translate(point.x, point.y + side * (reach / 2), point.z)
      bones[recent[i].state].push(rib)
    }
  }
  for (const state of ['merged', 'open', 'closed'] as const) {
    const mesh = bones[state].length ? merged(bones[state], ribs[state], true) : null
    if (mesh) group.add(mesh)
  }

  const plates: Record<'closed' | 'open' | 'question', THREE.BufferGeometry[]> = { closed: [], open: [], question: [] }
  const issues = p.issues.recent
  for (let i = 0; i < issues.length; i++) {
    const u = issues.length === 1 ? 0 : -0.86 + 1.72 * (i / (issues.length - 1))
    const k = girth(u)
    const theta = (i % 2 ? 1 : -1) * (0.5 + 0.3 * Math.sin(i * 1.7))
    const plate = new THREE.CircleGeometry((issues[i].question ? 0.05 : 0.044) * size, 5)
    plate.rotateX(-theta)
    plate.translate(u * half, Math.sin(theta) * (height / 2) * k * 0.64, Math.cos(theta) * (width / 2) * k * 0.96)
    plates[issues[i].question ? 'question' : issues[i].open ? 'open' : 'closed'].push(plate)
  }
  for (const state of ['closed', 'open', 'question'] as const) {
    const mesh = plates[state].length ? merged(plates[state], scales[state], false) : null
    if (mesh) group.add(mesh)
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

// Archived repositories become rocks, long-silent ones become seaweed; everything else is a fish.
export function buildProject(p: Project): ProjectShape {
  const shape: Shape = p.lifecycle === 'abandoned' ? (p.archived ? 'rock' : 'seaweed') : 'fish'
  const group = shape === 'fish' ? buildFish(p) : shape === 'rock' ? buildRock(p) : buildSeaweed(p)
  return { id: p.repo, shape, group }
}

export function disposeProject(group: THREE.Group) {
  group.traverse((node) => {
    if (node instanceof THREE.Mesh) node.geometry.dispose()
  })
}

export function updateWave(time: number) {
  wave.value = time
}
