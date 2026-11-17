import { describe, expect, it } from 'vitest'
import { linkFor, normalizeRepo, readLink } from './link'

describe('readLink', () => {
  it('reads a repository and a seed from a shared link', () => {
    expect(readLink('?repo=vitejs/vite&seed=3')).toEqual({ repo: 'vitejs/vite', seed: 3 })
  })

  it('accepts a github.com URL and a seed of zero', () => {
    expect(readLink('?repo=https://github.com/denoland/deno&seed=0')).toEqual({ repo: 'denoland/deno', seed: 0 })
  })

  it('ignores an invalid repository and a malformed seed', () => {
    expect(readLink('?repo=not a repo&seed=-2')).toEqual({ repo: null, seed: 1 })
    expect(readLink('?repo=vitejs/vite,denoland/deno&seed=1.5')).toEqual({ repo: null, seed: 1 })
  })

  it('falls back when a parameter is missing', () => {
    expect(readLink('')).toEqual({ repo: null, seed: 1 })
    expect(readLink('?seed=7')).toEqual({ repo: null, seed: 7 })
  })
})

describe('normalizeRepo', () => {
  it('keeps one repository and refuses anything else', () => {
    expect(normalizeRepo('vitejs/vite')).toBe('vitejs/vite')
    expect(normalizeRepo('vitejs/vite, denoland/deno')).toBeNull()
    expect(normalizeRepo('')).toBeNull()
    expect(normalizeRepo(null)).toBeNull()
  })
})

describe('linkFor', () => {
  it('writes the address bar for a recorded dataset', () => {
    expect(linkFor('vitejs/vite', 4, '/Git-Aquarium/')).toBe('/Git-Aquarium/?repo=vitejs/vite&seed=4')
  })

  it('leaves the path alone for the synthetic demo', () => {
    expect(linkFor(null, 9, '/')).toBe('/')
  })
})
