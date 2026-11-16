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

const TANK = { x: 3.1, yMin: 0.75, yMax: 3.4, zMin: -4.9, zMax: -1.3 }
const FLOOR = -0.15

// A deterministic layout: the same projects always start in the same places.
export function placeProjects(projects: Project[]): Agent[] {
  return projects.map((project, i) => {
    const kind: Kind = project.lifecycle === 'abandoned' ? (project.archived ? 'rock' : 'seaweed') : 'fish'
    const angle = (i / Math.max(1, projects.length)) * Math.PI * 2
    return {
      id: project.repo,
      project,
      kind,
      x: kind === 'fish' ? Math.sin(angle) * 2.2 : Math.sin(angle) * 2.9,
      y: kind === 'fish' ? 1.0 + 1.9 * ((i * 13) % 7) / 6 : FLOOR,
      z: kind === 'fish' ? -2.2 - 0.5 * ((i * 7) % 5) : -4.2 + 0.6 * ((i * 3) % 5),
      yaw: kind === 'fish' ? angle + Math.PI / 2 : angle,
      speed: project.activity,
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
    a.yaw += (0.35 * wiggle - 0.2 * (a.x / TANK.x)) * dt * (0.6 + 0.6 * a.speed)
    const speed = 0.22 + 0.55 * a.speed
    a.x += Math.cos(a.yaw) * speed * dt
    a.z += Math.sin(a.yaw) * speed * 0.55 * dt
    a.y += Math.sin(time * 0.7 + a.phase * 1.3) * 0.06 * dt
    // keep the body out of the glass
    if (a.x < -TANK.x) { a.x = -TANK.x; a.yaw += Math.PI }
    if (a.x > TANK.x) { a.x = TANK.x; a.yaw += Math.PI }
    if (a.z < TANK.zMin) { a.z = TANK.zMin; a.yaw += Math.PI }
    if (a.z > TANK.zMax) { a.z = TANK.zMax; a.yaw += Math.PI }
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
      const least = 1.4 * (a.project.size + b.project.size)
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
