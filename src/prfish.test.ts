import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildPullFish, PULL_COLORS } from './prfish'
import { sizeOfLines, type PullSummary } from './pulls'

const pull = (over: Partial<PullSummary> = {}): PullSummary => ({
  number: 1, title: 'Fix', author: 'ada', url: 'https://github.com/o/r/pull/1',
  created: '2025-12-01T00:00:00Z', updated: '2025-12-02T00:00:00Z',
  draft: false, lines: 10, checks: 'pass', review: 'none', staleDays: 0, size: sizeOfLines(10),
  ...over,
})

const extent = (group: THREE.Group) => {
  const box = new THREE.Box3().setFromObject(group)
  const size = new THREE.Vector3()
  box.getSize(size)
  return size
}

describe('buildPullFish', () => {
  it('draws a body, a tail, and two eyes', () => {
    const group = buildPullFish(pull())
    expect(group.children.length).toBe(4)
    expect(group.children.every((child) => child instanceof THREE.Mesh)).toBe(true)
  })

  it('gets bigger with the number of lines changed', () => {
    const small = buildPullFish(pull({ lines: 5, size: sizeOfLines(5) }))
    const large = buildPullFish(pull({ lines: 900, size: sizeOfLines(900) }))
    expect(extent(large).x).toBeGreaterThan(extent(small).x * 1.3)
  })

  it('paints the body by check state', () => {
    const colour = (checks: PullSummary['checks']) => {
      const mesh = buildPullFish(pull({ checks })).children[0] as THREE.Mesh
      return (mesh.material as THREE.MeshStandardMaterial).color.getHexString()
    }
    expect(colour('pass')).toBe(PULL_COLORS.pass.replace('#', ''))
    expect(colour('fail')).toBe(PULL_COLORS.fail.replace('#', ''))
    expect(colour('pending')).toBe(PULL_COLORS.pending.replace('#', ''))
    expect(colour('none')).toBe(PULL_COLORS.none.replace('#', ''))
  })

  it('fades a stale pull request without touching the shared skins', () => {
    const fresh = buildPullFish(pull({ staleDays: 1 })) as unknown as THREE.Group
    const stale = buildPullFish(pull({ staleDays: 30 })) as unknown as THREE.Group
    const freshMesh = fresh.children[0] as THREE.Mesh
    const staleMesh = stale.children[0] as THREE.Mesh
    expect((freshMesh.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.72)
    expect((staleMesh.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.4)
    expect(staleMesh.material).not.toBe(freshMesh.material) // the fade is a per-fish copy
  })
})
