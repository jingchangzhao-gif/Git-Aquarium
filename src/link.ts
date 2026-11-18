import { parseRepos } from './projects'

export interface Link {
  repo: string | null
  seed: number
}

// A shared link is a convenience, not a saved dataset: it names a repository and a seed.
export function readLink(search: string, fallbackSeed = 1): Link {
  const params = new URLSearchParams(search)
  const seedText = params.get('seed') ?? ''
  return {
    repo: normalizeRepo(params.get('repo')),
    seed: /^\d+$/.test(seedText) ? Number(seedText) : fallbackSeed,
  }
}

// One repository, validated with the same rules the import form uses.
export function normalizeRepo(raw: string | null): string | null {
  if (!raw) return null
  try {
    const one = parseRepos(raw)
    return one.length === 1 ? one[0] : null
  } catch {
    return null
  }
}

// The address bar describes what is on screen; the caller decides when to apply it.
// `repo` has already passed parseRepos, so it only holds characters that need no escaping.
export function linkFor(repo: string | null, seed: number, path: string): string {
  if (!repo) return path
  return `${path}?repo=${repo}&seed=${seed}`
}
