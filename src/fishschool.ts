// Where the project fish swim. Positions are in scene units, not simulation ticks:
// projects mode has no clock, only a school holding its distance.
import type { Project } from './projects'

export type Kind = 'fish' | 'rock' | 'seaweed'

export interface Agent {
  id: string
  project: Project
  kind: Kind
  x: number
  y: number
  z: number
  yaw: number
  speed: number // 0..1, from how much landed recently
  phase: number
  still: boolean // rocks and seaweed do not swim
}

// The open water in front of the scenery: fish stay clear of the rocks and plants behind it.
const TANK = { x: 3.3, yMin: 1.2, yMax: 3.5, zMin: -1.9, zMax: 0.5 }
const FLOOR = -0.15

// A deterministic layout: the same projects always start in the same places.
export function placeProjects(projects: Project[]): Agent[] {
  return projects.map((project, i) => {
    // The form is the project's own: a finished project keeps the shape its owner chose.
    const kind: Kind = project.form
    const angle = (i / Math.max(1, projects.length)) * Math.PI * 2
    return {
      id: project.repo,
      project,
      kind,
      x: kind === 'fish' ? Math.sin(angle) * 2.2 : Math.sin(angle + 0.6) * 3.1,
      y: kind === 'fish' ? TANK.yMin + (TANK.yMax - TANK.yMin) * ((i * 13) % 7) / 6 : FLOOR,
      // rocks and seaweed sit on the open sand at the front, where they cannot be mistaken for scenery
      z: kind === 'fish' ? TANK.zMin + (TANK.zMax - TANK.zMin) * ((i * 7) % 5) / 4 : 1.1 + 0.5 * ((i * 3) % 3),
      yaw: kind === 'fish' ? (i % 2 ? 0.12 : Math.PI - 0.12) : angle,
      // Upkeep decides the speed stage; a finished fish still swims at a steady pace.
      speed: project.speed,
      phase: i * 1.7,
      still: kind !== 'fish',
    }
  })
}

// Swim, drift apart, and stay in the tank. Rocks and seaweed only settle in place.
export function drift(agents: Agent[], dt: number, time: number) {
  for (const a of agents) {
    if (a.still) {
      a.y = FLOOR
      a.yaw += dt * 0.05 * Math.sin(time * 0.2 + a.phase)
      continue
    }
    const wiggle = Math.sin(time * 0.9 + a.phase)
    // wander, lean back toward the middle, and ease back to side-on: a body seen end-on shows none of its bones
    a.yaw += (0.35 * wiggle - 0.2 * (a.x / TANK.x) - 0.6 * Math.sin(2 * a.yaw)) * dt * (0.6 + 0.6 * a.speed)
    const speed = 0.22 + 0.55 * a.speed
    a.x += Math.cos(a.yaw) * speed * dt
    a.z += Math.sin(a.yaw) * speed * 0.55 * dt
    a.y += Math.sin(time * 0.7 + a.phase * 1.3) * 0.06 * dt
    // keep the body out of the glass; reflect the heading so fish stay side-on to the camera
    if (a.x < -TANK.x) { a.x = -TANK.x; a.yaw = Math.PI - a.yaw }
    if (a.x > TANK.x) { a.x = TANK.x; a.yaw = Math.PI - a.yaw }
    if (a.z < TANK.zMin) { a.z = TANK.zMin; a.yaw = -a.yaw }
    if (a.z > TANK.zMax) { a.z = TANK.zMax; a.yaw = -a.yaw }
    a.y = Math.min(TANK.yMax, Math.max(TANK.yMin, a.y))
  }
  // separation, after moving so no agent gets an unfair extra step
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]
    if (a.still) continue
    for (let j = i + 1; j < agents.length; j++) {
      const b = agents[j]
      if (b.still) continue
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
      const d = Math.hypot(dx, dy, dz)
      const least = 0.85 * (a.project.size + b.project.size) // a body is about 1.7 sizes long, tail included
      if (d > 0 && d < least) {
        const push = (least - d) / d / 2
        a.x -= dx * push
        a.y -= dy * push
        a.z -= dz * push
        b.x += dx * push
        b.y += dy * push
        b.z += dz * push
      }
    }
  }
}
