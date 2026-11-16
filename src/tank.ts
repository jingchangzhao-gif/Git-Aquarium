// The 3D aquarium. It draws whatever it is handed and never changes the simulation.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { P, type Genome } from './sim'
import { buildProject, disposeProject, updateWave } from './fish'
import type { Project } from './projects'

export const COLORS = ['#f08a2c', '#3f7fe0', '#f2cf3a', '#58b9a5', '#d9534f', '#8a63c9', '#9fc94f', '#e9a3b8'] // one per lineage
const SHARED_FOOD = '#efe9da' // baseline food, which any lineage may eat

export interface Swimmer {
  id: number
  lineage: number
  genome: Genome
  x: number; y: number; z: number // simulation coordinates
  ux: number; uy: number; uz: number
  energy: number // 0..1 of its capacity
  grown: number // 0..1, for growing in at birth and shrinking away at death
  dim: boolean // faded into the water while another lineage is being filtered on
}

// One repository drawn as a fish, a rock, or a clump of seaweed, placed in scene units.
export interface ProjectDraw {
  id: string
  project: Project
  x: number; y: number; z: number
  yaw: number
}

const CLEAR = { top: '#7cc6dc', fog: '#1f6c8e', density: 0.066 }
const MURKY = { top: '#8a9456', fog: '#4f5d35', density: 0.115 } // while CI groups are failing
const SCALE = 0.01 // simulation units to scene units
const noise = (i: number) => { // fixed pseudo-random numbers, so the decor is the same on every load
  const v = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return v - Math.floor(v)
}

// Light rippling through the surface: the borders of a tiling cell pattern, sampled twice in the shader.
function rippleTexture() {
  const size = 256
  const points = Array.from({ length: 22 }, (_, i) => [noise(i), noise(i + 50)])
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let near = 9, next = 9
      for (const [px, py] of points) {
        let dx = Math.abs(x / size - px)
        let dy = Math.abs(y / size - py)
        dx = Math.min(dx, 1 - dx) // wrap around so the pattern tiles
        dy = Math.min(dy, 1 - dy)
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < near) { next = near; near = d } else if (d < next) next = d
      }
      const edge = Math.max(0, 1 - (next - near) / 0.085)
      data.fill(255 * edge * edge, (y * size + x) * 4, (y * size + x) * 4 + 4)
    }
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

function paint(width: number, height: number, draw: (c: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  draw(canvas.getContext('2d')!)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// One body plan per lineage, so branches differ by shape as well as colour. A fish is about two units long,
// nose toward +X. With more than four lineages the plans repeat in new colours.
const SPECIES = [
  { h: 0.4, w: 0.19, tail: 0.73, spread: 0.5, fork: 0.34, dorsal: 0.35, anal: 0.3, sweep: 0 }, // reef fish: the all-rounder
  { h: 0.25, w: 0.16, tail: 0.6, spread: 0.42, fork: 0.6, dorsal: 0.16, anal: 0.12, sweep: 0.1 }, // dart: slim, forked tail, low fins
  { h: 0.6, w: 0.13, tail: 0.5, spread: 0.36, fork: 0.12, dorsal: 0.45, anal: 0.42, sweep: 0.35 }, // disc: tall and flat, trailing fins
  { h: 0.5, w: 0.3, tail: 1, spread: 0.72, fork: 0.22, dorsal: 0.3, anal: 0.2, sweep: 0.05 }, // fantail: round, flowing tail
]
type Species = (typeof SPECIES)[number]
type Outline = [number, number][]

// The side view of a body plan: the body's upper edge and the three fin outlines.
function plan(s: Species) {
  const top = (x: number) => s.h * (0.78 + 0.3 * x) * Math.sqrt(1 - x * x) // fuller toward the head
  const end = -0.82 - s.tail
  const fins: Outline[] = [
    [[-0.82, 0.05], [end, s.spread], [end + s.tail * s.fork, 0], [end, -s.spread], [-0.82, -0.05]], // tail
    [[0.35, top(0.35)], [-0.05 - s.sweep, top(-0.05) + s.dorsal], [-0.55 - 0.6 * s.sweep, top(-0.55) + 0.6 * s.dorsal], [-0.5, top(-0.5)], [0.3, 0.84 * top(0.3)]], // dorsal
    [[-0.2, -top(-0.2)], [-0.5 - s.sweep, -top(-0.5) - s.anal], [-0.7, -top(-0.7)]], // anal
  ]
  return { top, fins }
}

// The same plan as a flat picture, for the legend.
export function silhouette(lineage: number) {
  const { top, fins } = plan(SPECIES[lineage % SPECIES.length])
  const xs = Array.from({ length: 21 }, (_, i) => 1 - i / 10)
  const body: Outline = [...xs.map((x): [number, number] => [x, top(x)]), ...xs.reverse().map((x): [number, number] => [x, -top(x)])]
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '-1.9 -1 3 2')
  svg.setAttribute('aria-hidden', 'true')
  for (const part of [body, ...fins]) {
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
    polygon.setAttribute('points', part.map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`).join(' '))
    svg.append(polygon)
  }
  return svg
}

// The plan in 3D: a squashed sphere, three flat fins, and two eyes.
function fishGeometry(s: Species) {
  const shaded = (g: THREE.BufferGeometry, shade: (y: number) => number) => {
    const p = g.attributes.position
    const colors = new Float32Array(p.count * 3)
    for (let i = 0; i < p.count; i++) colors.fill(shade(p.getY(i)), i * 3, i * 3 + 3)
    return g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }
  const body = new THREE.SphereGeometry(1, 28, 18).rotateZ(Math.PI / 2)
  const p = body.attributes.position
  const n = body.attributes.normal
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    const bulk = 0.78 + 0.3 * p.getX(i) // matches `top` in the plan
    p.setY(i, p.getY(i) * s.h * bulk)
    p.setZ(i, p.getZ(i) * s.w * bulk)
    v.set(n.getX(i), n.getY(i) / s.h, n.getZ(i) / s.w).normalize()
    n.setXYZ(i, v.x, v.y, v.z)
  }
  const fin = (points: Outline) =>
    shaded(new THREE.ShapeGeometry(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))), () => 0.72)
  const eye = (side: number) => shaded(new THREE.SphereGeometry(0.06, 10, 8).translate(0.66, 0.225 * s.h, (0.7 * s.w - 0.018) * side), () => 0.02)
  return mergeGeometries([
    shaded(body, (y) => 1 - 0.42 * THREE.MathUtils.smoothstep(y, -0.12 * s.h, 0.75 * s.h)), // darker back, lighter belly
    ...plan(s).fins.map(fin),
    eye(1), eye(-1),
  ])
}

export function createTank(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.shadowMap.enabled = true
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15

  const scene = new THREE.Scene()
  const fog = new THREE.FogExp2(CLEAR.fog, CLEAR.density)
  scene.fog = fog
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture // soft reflections on scales
  scene.environmentIntensity = 0.3
  const camera = new THREE.PerspectiveCamera(38, P.width / P.height, 0.1, 90)

  // Every lit surface shares the rippling light and a clock.
  const shared = { uTime: { value: 0 }, uRipple: { value: rippleTexture() }, uRipplePower: { value: 1 } }
  function lit<M extends THREE.Material>(material: M, attributes = '', vertex = '') {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nvarying vec3 vWorldNormal;\nuniform float uTime;\n${attributes}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertex}`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 wp = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            wn = mat3(instanceMatrix) * wn;
          #endif
          vWorld = (modelMatrix * wp).xyz;
          vWorldNormal = normalize(mat3(modelMatrix) * wn);`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWorld;
          varying vec3 vWorldNormal;
          uniform float uTime;
          uniform sampler2D uRipple;
          uniform float uRipplePower;`)
        .replace('#include <opaque_fragment>', `
          float ripple = min(
            texture2D(uRipple, vWorld.xz * 0.21 + uTime * vec2(0.021, 0.013)).r,
            texture2D(uRipple, vWorld.xz * 0.27 - uTime * vec2(0.017, 0.024)).r);
          outgoingLight += diffuseColor.rgb * ripple * smoothstep(-0.1, 0.7, vWorldNormal.y) * uRipplePower * vec3(1.0, 0.96, 0.84);
          #include <opaque_fragment>`)
    }
    return material
  }

  // Water colour behind everything: lighter toward the surface.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(60, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(CLEAR.top) }, horizon: { value: fog.color } }, // meets the fog, so there is no horizon line
      vertexShader: 'varying float h; void main() { h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying float h; void main() { gl_FragColor = vec4(mix(horizon, top, smoothstep(0.0, 0.6, h)), 1.0); }',
    }),
  )
  scene.add(sky)

  const hemisphere = new THREE.HemisphereLight('#a9dcf5', '#5a5038', 1)
  const sun = new THREE.DirectionalLight('#fff3d9', 2.4)
  sun.position.set(2.5, 11, 2)
  sun.target.position.set(0, 0, -1.3)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.radius = 4
  sun.shadow.bias = -0.0004
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 5, bottom: -5, near: 1, far: 24 })
  scene.add(hemisphere, sun, sun.target)

  // Sand, with gentle dunes.
  const sand = new THREE.PlaneGeometry(70, 40, 140, 80).rotateX(-Math.PI / 2)
  for (let i = 0, p = sand.attributes.position; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i)
    p.setY(i, 0.12 * Math.sin(x * 0.9) * Math.cos(z * 0.7) + 0.05 * Math.sin(x * 2.3 + z * 1.7))
  }
  sand.computeVertexNormals()
  const grain = paint(256, 256, (c) => {
    c.fillStyle = '#cdb98f'
    c.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 5000; i++) {
      c.fillStyle = noise(i) > 0.5 ? 'rgba(255, 244, 214, 0.25)' : 'rgba(96, 78, 48, 0.22)'
      c.fillRect(noise(i + 1000) * 256, noise(i + 2000) * 256, 1.6, 1.6)
    }
  })
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping
  grain.repeat.set(34, 20)
  const floor = new THREE.Mesh(sand, lit(new THREE.MeshStandardMaterial({ map: grain, roughness: 1 })))
  floor.position.set(0, -0.2, -6)
  floor.receiveShadow = true
  scene.add(floor)

  // Rocks around the edges and plants behind and beside the open water.
  const rock = new THREE.SphereGeometry(1, 32, 22)
  for (let i = 0, p = rock.attributes.position; i < p.count; i++) { // a lumpy boulder rather than a ball
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
    const k = 1 + 0.16 * Math.sin(x * 3.1 + 0.5) * Math.sin(y * 2.7 + 1.3) + 0.12 * Math.sin(z * 4.2 + x * 1.7) + 0.04 * Math.sin(x * 9 + y * 7 + z * 8)
    p.setXYZ(i, x * k, y * k, z * k)
  }
  rock.computeVertexNormals()
  const rockMaterial = lit(new THREE.MeshStandardMaterial({ color: '#7d7566', roughness: 0.95 }))
  const stones: [number, number, number, number][] = [ // x, z, size, squash
    [-4.9, -2.9, 1.3, 0.7], [-3.4, -3.6, 0.8, 0.6], [4.6, -3.1, 1.5, 0.75], [3.1, -3.7, 0.7, 0.55], [0.4, -4.1, 1.1, 0.5],
    [-5.6, -0.9, 0.9, 0.6], [5.5, -1.2, 0.8, 0.65], [-2.2, -2.5, 0.35, 0.5], [2.4, -0.5, 0.3, 0.45], [-3.6, -0.3, 0.25, 0.5],
  ]
  stones.forEach(([x, z, size, squash], i) => {
    const stone = new THREE.Mesh(rock, rockMaterial)
    stone.position.set(x, size * squash * 0.35 - 0.2, z)
    stone.scale.set(size, size * squash, size * (0.8 + 0.4 * noise(i)))
    stone.rotation.y = noise(i + 9) * 6
    stone.castShadow = stone.receiveShadow = true
    scene.add(stone)
  })

  const blade = new THREE.PlaneGeometry(0.2, 1, 1, 10).translate(0, 0.5, 0)
  for (let i = 0, p = blade.attributes.position; i < p.count; i++) p.setX(i, p.getX(i) * (1 - 0.85 * p.getY(i)))
  const plants = new THREE.InstancedMesh(
    blade,
    lit(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.75 }), '',
      'transformed.x += sin(uTime * 1.1 + instanceMatrix[3].x * 3.0 + position.y * 2.5) * 0.2 * position.y * position.y;'),
    84,
  )
  const dummy = new THREE.Object3D()
  const tint = new THREE.Color()
  const clumps: [number, number][] = [[-4.6, -2.3], [-3.0, -3.0], [-1.2, -3.4], [1.5, -3.3], [3.6, -2.6], [4.9, -1.9], [-5.4, -0.2], [5.3, -0.1], [-2.0, -2.2], [2.6, -2.9], [0.2, -3.6]]
  for (let i = 0; i < plants.count; i++) {
    const [cx, cz] = clumps[i % clumps.length]
    dummy.position.set(cx + (noise(i) - 0.5) * 0.9, -0.2, cz + (noise(i + 300) - 0.5) * 0.7)
    dummy.rotation.set(0, noise(i + 600) * Math.PI, 0)
    dummy.scale.set(0.6 + 0.8 * noise(i + 900), 0.5 + 1.2 * noise(i + 1200), 1)
    dummy.updateMatrix()
    plants.setMatrixAt(i, dummy.matrix)
    plants.setColorAt(i, tint.setHSL(0.27 + 0.1 * noise(i + 1500), 0.6, 0.07 + 0.08 * noise(i + 1800)))
  }
  plants.castShadow = true
  scene.add(plants)

  // Shafts of sunlight, bubbles, and drifting specks.
  const shaft = paint(64, 256, (c) => {
    const across = c.createLinearGradient(0, 0, 64, 0)
    across.addColorStop(0, 'rgba(255, 255, 255, 0)')
    across.addColorStop(0.5, 'rgba(255, 255, 255, 1)')
    across.addColorStop(1, 'rgba(255, 255, 255, 0)')
    c.fillStyle = across
    c.fillRect(0, 0, 64, 256)
    const down = c.createLinearGradient(0, 0, 0, 256)
    down.addColorStop(0, 'rgba(0, 0, 0, 0)')
    down.addColorStop(1, 'rgba(0, 0, 0, 1)')
    c.globalCompositeOperation = 'destination-out'
    c.fillStyle = down
    c.fillRect(0, 0, 64, 256)
  })
  const shafts = [-4.2, -2.3, -0.4, 1.6, 3.5].map((x, i) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1 + noise(i + 40), 9),
      new THREE.MeshBasicMaterial({ map: shaft, color: '#d8f3ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    )
    mesh.position.set(x, 3.2, -0.6 - 2.4 * noise(i + 60))
    mesh.rotation.z = 0.2
    scene.add(mesh)
    return mesh
  })
  const bubbles = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshStandardMaterial({ color: '#eefcff', transparent: true, opacity: 0.4, roughness: 0.05 }),
    28,
  )
  scene.add(bubbles)
  const specks = new Float32Array(420 * 3)
  for (let i = 0; i < 420; i++) specks.set([(noise(i) - 0.5) * 13, noise(i + 500) * 5.6, 1.5 - noise(i + 1000) * 6.5], i * 3)
  const snow = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(specks, 3)),
    new THREE.PointsMaterial({ size: 0.03, color: '#dcf1f4', transparent: true, opacity: 0.5, depthWrite: false }),
  )
  scene.add(snow)

  // Fish and food are instanced: one draw call per species and one for food, however many there are.
  const limit = P.maxPopulation + 60 // living fish plus any still fading out
  const scales = lit(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.42, metalness: 0.2 }),
    'attribute vec3 aSwim;', `
    float reach = smoothstep(0.5, -1.4, position.x); // the wave grows toward the tail
    transformed.z += sin(aSwim.x + uTime * aSwim.y + position.x * 2.6) * 0.34 * reach * reach;
    if (position.x < -0.8) transformed.y *= mix(0.75, 1.45, aSwim.z);`)
  const shoals = SPECIES.map((species) => {
    const swim = new THREE.InstancedBufferAttribute(new Float32Array(limit * 3), 3) // phase, tail-beat rate, fin size
    const mesh = new THREE.InstancedMesh(fishGeometry(species).setAttribute('aSwim', swim), scales, limit)
    mesh.setColorAt(0, tint.set('#fff'))
    mesh.castShadow = true
    mesh.frustumCulled = false
    scene.add(mesh)
    return { mesh, swim }
  })
  const pellets = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.032, 8, 6),
    new THREE.MeshBasicMaterial(), // unlit, so a pellet's colour always reads as its lineage's
    P.maxFood,
  )
  pellets.setColorAt(0, tint.set('#fff'))
  pellets.frustumCulled = false
  scene.add(pellets)

  new ResizeObserver(() => renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)).observe(canvas)
  const pointer = new THREE.Vector2()
  const look = new THREE.Vector2() // eased pointer, so the view drifts rather than snaps
  canvas.addEventListener('pointermove', (e) => pointer.set(e.offsetX / canvas.clientWidth - 0.5, 0.5 - e.offsetY / canvas.clientHeight))
  canvas.addEventListener('pointerleave', () => pointer.set(0, 0))

  const place = (v: THREE.Vector3, x: number, y: number, z: number) => v.set((x - P.width / 2) * SCALE, y * SCALE, -z * SCALE)
  const pale = new THREE.Color('#8d979b')
  const spot = new THREE.Vector3()

  // Projects mode: one fish per repository, rebuilt only when the data behind the tank changes.
  const projectsRoot = new THREE.Group()
  projectsRoot.visible = false
  scene.add(projectsRoot)
  const projectCache = new Map<string, { rev: number; group: THREE.Group }>()

  return {
    // `time` is animation seconds (it stands still while paused); `stress` is 0..1 water stress.
    draw(swimmers: Swimmer[], food: { x: number; y: number; z: number; lineage: number }[], stress: number, time: number) {
      shared.uTime.value = time
      updateWave(time)
      projectsRoot.visible = false
      for (const { mesh } of shoals) mesh.visible = true
      pellets.visible = true
      shared.uRipplePower.value = THREE.MathUtils.lerp(0.9, 0.12, stress)
      sky.material.uniforms.top.value.set(CLEAR.top).lerp(tint.set(MURKY.top), stress)
      fog.color.set(CLEAR.fog).lerp(tint.set(MURKY.fog), stress)
      fog.density = THREE.MathUtils.lerp(CLEAR.density, MURKY.density, stress)
      sun.intensity = THREE.MathUtils.lerp(2.4, 1.0, stress)
      hemisphere.intensity = THREE.MathUtils.lerp(1, 0.75, stress)
      shafts.forEach((mesh, i) => (mesh.material.opacity = (0.17 + 0.07 * Math.sin(time * 0.4 + i * 2)) * (1 - 0.85 * stress)))

      for (const { mesh } of shoals) mesh.count = 0
      for (const s of swimmers) {
        const { mesh, swim } = shoals[s.lineage % shoals.length]
        const i = mesh.count
        if (i >= limit) continue
        mesh.count = i + 1
        place(dummy.position, s.x, s.y, s.z)
        const flat = Math.hypot(s.ux, s.uz) || 1e-6
        // Yaw toward where it is going; show only part of the climb or dive so fish never stand on end.
        dummy.rotation.set(0, Math.atan2(s.uz, s.ux), THREE.MathUtils.clamp(Math.atan2(s.uy, flat) * 0.6, -0.6, 0.6), 'YZX')
        const size = (0.12 + 0.15 * s.genome.bodyLength) * s.grown
        const girth = size * (1.16 - 0.32 * s.genome.speed) // genes show: fast swimmers are slimmer
        dummy.scale.set(size, girth, girth)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        tint.set(COLORS[s.lineage % COLORS.length]).offsetHSL((s.genome.hue - 0.5) * 0.07, 0, 0)
        tint.lerp(pale, 0.6 * (1 - s.energy) ** 2) // paler = hungrier
        mesh.setColorAt(i, s.dim ? tint.lerp(fog.color, 0.8) : tint)
        swim.setXYZ(i, s.id * 1.7, 5 + 7 * s.genome.speed, s.genome.finSize)
      }
      for (const { mesh, swim } of shoals) {
        mesh.instanceMatrix.needsUpdate = true
        mesh.instanceColor!.needsUpdate = true
        swim.needsUpdate = true
      }

      dummy.rotation.set(0, 0, 0)
      dummy.scale.setScalar(1)
      const pieces = Math.min(food.length, P.maxFood)
      for (let i = 0; i < pieces; i++) {
        place(dummy.position, food[i].x, food[i].y, food[i].z)
        dummy.updateMatrix()
        pellets.setMatrixAt(i, dummy.matrix)
        // Food for one lineage wears its colour; shared food is pale.
        pellets.setColorAt(i, tint.set(food[i].lineage < 0 ? SHARED_FOOD : COLORS[food[i].lineage % COLORS.length]))
      }
      pellets.count = pieces
      pellets.instanceMatrix.needsUpdate = true
      pellets.instanceColor!.needsUpdate = true

      for (let i = 0; i < bubbles.count; i++) { // three columns rising from the rocks
        const column = i % 3
        const rise = (time * (0.35 + 0.2 * noise(i)) + noise(i + 70) * 5) % 5.4
        dummy.position.set([-3.4, 3.0, 0.5][column] + Math.sin(time * 2 + i) * 0.06, rise - 0.1, [-2.6, -2.4, -3.0][column] + Math.cos(time * 1.7 + i) * 0.06)
        dummy.scale.setScalar(0.02 + 0.035 * noise(i + 90))
        dummy.updateMatrix()
        bubbles.setMatrixAt(i, dummy.matrix)
      }
      bubbles.instanceMatrix.needsUpdate = true
      snow.position.set(Math.sin(time * 0.05) * 0.4, Math.sin(time * 0.07) * 0.2, 0)

      look.lerp(pointer, 0.04)
      camera.position.set(Math.sin(time * 0.12) * 0.45 + look.x * 1.2, 1.7 + Math.sin(time * 0.085) * 0.1 + look.y * 0.5, 7.6)
      camera.lookAt(0, 2.5, -1.3)
      renderer.render(scene, camera)
    },
    // Where a simulation point lands on the canvas, in the canvas's own 0..width, 0..height units.
    project(x: number, y: number, z: number): [number, number] {
      place(spot, x, y, z).project(camera)
      return [(spot.x * 0.5 + 0.5) * P.width, (0.5 - spot.y * 0.5) * P.height]
    },
    // Projects mode: one repository per shape. `rev` changes only when the data changes.
    drawProjects(items: ProjectDraw[], time: number, rev: number) {
      updateWave(time)
      projectsRoot.visible = true
      for (const { mesh } of shoals) mesh.visible = false
      pellets.visible = false
      sky.material.uniforms.top.value.set(CLEAR.top)
      fog.color.set(CLEAR.fog)
      fog.density = CLEAR.density
      sun.intensity = 2.4
      hemisphere.intensity = 1
      shafts.forEach((mesh, i) => (mesh.material.opacity = 0.17 + 0.07 * Math.sin(time * 0.4 + i * 2)))

      const keep = new Set(items.map((item) => item.id))
      for (const [id, entry] of projectCache) {
        if (keep.has(id)) continue
        projectsRoot.remove(entry.group)
        disposeProject(entry.group)
        projectCache.delete(id)
      }
      for (const item of items) {
        let entry = projectCache.get(item.id)
        if (!entry || entry.rev !== rev) {
          if (entry) {
            projectsRoot.remove(entry.group)
            disposeProject(entry.group)
          }
          entry = { rev, group: buildProject(item.project).group }
          projectsRoot.add(entry.group)
          projectCache.set(item.id, entry)
        }
        entry.group.position.set(item.x, item.y, item.z)
        // The meshes face +x; `yaw` is measured toward +z, so the sign flips.
        entry.group.rotation.set(0, -item.yaw, Math.sin(time * 0.8 + item.x) * 0.04)
      }

      look.lerp(pointer, 0.04)
      camera.position.set(look.x * 0.9, 2.9 + look.y * 0.35, 8.8)
      camera.lookAt(0, 2.0, -1.8)
      renderer.render(scene, camera)
    },
    // Where a project fish's body centre lands on the overlay canvas.
    projectScene(x: number, y: number, z: number): [number, number] {
      spot.set(x, y, z).project(camera)
      return [(spot.x * 0.5 + 0.5) * P.width, (0.5 - spot.y * 0.5) * P.height]
    },
  }
}
