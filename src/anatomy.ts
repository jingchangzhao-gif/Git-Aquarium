// The project's anatomy: features are the big bones, issues are the small bones and the scale surface,
// and a merged pull request that closed an issue is the connection between them.
// GitHub has no "feature" record, so a feature is a `feature:<slug>` label. Everything else falls back
// to one General bone, and an issue matching no feature or several is shown as unclassified, never guessed.
// Nothing here renders; every id is stable for a repository, so a reload cannot move an issue to another scale.

// Merged pull requests and the issues GitHub itself reports them as closing. One GraphQL call, so the
// relation is GitHub's, not something parsed from a description.
export const MERGED_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:MERGED,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url mergedAt closingIssuesReferences(first:10){nodes{number}}}}}}`

export const GENERAL_SLUG = 'general'
export const MAX_FEATURES = 6 // big bones in the overview; the rest of the features are listed in the side panel
export const MAX_ISSUES_PER_FEATURE = 2 // small bones in the overview; the rest are listed in the side panel

export interface Feature {
  id: string // `<repo>#feature:<slug>`
  slug: string
  name: string // the slug with words unfolded, e.g. "parser" -> "Parser", "web-ui" -> "Web Ui"
  label: string // the label the feature came from, or "" for the General bone
}

export interface AnatomyIssue {
  id: string // `<repo>#issue:<number>`
  number: number
  title: string
  open: boolean
  url: string
  at: string
  featureId: string
  conflict: boolean // the issue carries more than one `feature:` label
}

// Only a merged pull request that GitHub itself links to one or more issues reaches this list.
export interface PullLink {
  id: string // `<repo>#pull:<number>`
  number: number
  title: string
  url: string
  mergedAt: string
  issueIds: string[] // one connection per issue it closed
}

export interface Anatomy {
  features: Feature[]
  issues: AnatomyIssue[] // every loaded issue, open and closed
  links: PullLink[] // merged and linked; no link is invented from a mention in the description
  generalId: string
  conflicts: number // issues with more than one feature label
  unclassified: number // issues that fell back to General while the repository has feature labels
  hiddenFeatures: number // features past MAX_FEATURES, merged into Other in the overview
  hiddenIssues: number // open issues past the per-feature overview limit
}

const LABEL = /^feature:\s*(.+)$/i

// "feature: Web UI" -> "web-ui". Anything that cannot be a stable slug falls back to null, not a guess.
export function featureSlug(label: string): string | null {
  const match = LABEL.exec(label.trim())
  if (!match) return null
  const slug = match[1].toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')
  return slug || null
}

export const featureId = (repo: string, slug: string) => `${repo}#feature:${slug}`
export const scaleId = (repo: string, slug: string, slot: number) => `${repo}#scale:${slug}:${slot}`
export const issueId = (repo: string, number: number) => `${repo}#issue:${number}`
export const pullId = (repo: string, number: number) => `${repo}#pull:${number}`

export function displayName(slug: string): string {
  return slug.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}

export interface AnatomyInput {
  labels?: unknown // GitHub labels, or just the names
  issues?: unknown // GitHub issues (pull requests are skipped)
  merged?: unknown // merged pull requests with their closing references: {number,title,url,mergedAt,closes:number[]}
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function items(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(record) : []
}

function string(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.split('\n')[0].slice(0, max).trim() : ''
}

function url(v: unknown): string {
  return typeof v === 'string' && v.startsWith('https://github.com/') ? v : ''
}

function labelNames(raw: unknown): string[] {
  return items(raw).map((l) => string(l.name, 60).toLowerCase()).filter(Boolean)
}

// Feature slugs present in the repository labels, in a stable order (the repository's own order is not one).
export function repositoryFeatures(labels: unknown): string[] {
  const slugs = new Set<string>()
  for (const raw of Array.isArray(labels) ? labels : []) {
    const name = typeof raw === 'string' ? raw : string(record(raw).name, 60)
    const slug = featureSlug(name)
    if (slug) slugs.add(slug)
  }
  return [...slugs].sort()
}

export function anatomyOf(repo: string, input: AnatomyInput): Anatomy {
  const slugs = repositoryFeatures(input.labels)
  const general = featureId(repo, GENERAL_SLUG)
  // General is always the first bone: it holds every issue the labels could not place, so no issue is dropped.
  const features: Feature[] = [{ id: general, slug: GENERAL_SLUG, name: 'General', label: '' }]
  for (const slug of slugs.slice(0, MAX_FEATURES)) {
    features.push({ id: featureId(repo, slug), slug, name: displayName(slug), label: `feature:${slug}` })
  }
  // Past the overview limit the extra features share one Other bone, and the panel still lists them by name.
  const hiddenFeatures = Math.max(0, slugs.length - MAX_FEATURES)
  if (hiddenFeatures) {
    const other = featureId(repo, 'other')
    features.push({ id: other, slug: 'other', name: 'Other', label: `feature: (${hiddenFeatures} more)` })
  }
  const known = new Set(features.map((f) => f.slug))
  const byId = new Map(features.map((f) => [f.id, f]))

  const issues: AnatomyIssue[] = []
  const seen = new Set<number>()
  for (const raw of items(input.issues)) {
    if (raw.pull_request) continue // the issues endpoint mixes pull requests in
    const number = Number(raw.number) || 0
    if (!number || seen.has(number)) continue
    seen.add(number)
    const names = labelNames(raw.labels)
    const matched = [...new Set(names.map(featureSlug).filter((s): s is string => s !== null))]
    let feature: Feature | undefined
    let conflict = false
    if (!slugs.length) {
      feature = byId.get(general)
    } else if (matched.length === 1) {
      feature = byId.get(featureId(repo, matched[0])) ?? byId.get(featureId(repo, 'other'))
    } else if (matched.length > 1) {
      conflict = true
      feature = byId.get(general) // a conflict is shown as unclassified, not duplicated on two bones
    } else {
      feature = byId.get(general)
    }
    if (!feature) continue
    issues.push({
      id: issueId(repo, number),
      number,
      title: string(raw.title, 120),
      open: raw.state === 'open',
      url: url(raw.html_url),
      at: string(raw.created_at, 32) || string(raw.updated_at, 32),
      featureId: feature.id,
      conflict,
    })
  }

  const knownIssues = new Map(issues.map((i) => [i.number, i]))
  const links: PullLink[] = []
  for (const raw of items(input.merged)) {
    const number = Number(raw.number) || 0
    const closes = Array.isArray(raw.closes) ? raw.closes : Array.isArray(raw.closingIssuesReferences) ? raw.closingIssuesReferences : []
    const issueIds = [...new Set(closes.map((c) => Number(record(c).number ?? c) || 0).filter((n) => n > 0 && knownIssues.has(n)))]
      .map((n) => issueId(repo, n))
    if (!number || !issueIds.length) continue // a pull request that closed nothing stays in the history list only
    links.push({
      id: pullId(repo, number),
      number,
      title: string(raw.title, 120),
      url: url(raw.url) || url(raw.html_url),
      mergedAt: string(raw.mergedAt ?? raw.merged_at, 32),
      issueIds,
    })
  }
  links.sort((a, b) => (Date.parse(b.mergedAt) || 0) - (Date.parse(a.mergedAt) || 0))

  const openByFeature = new Map<string, number>()
  for (const issue of issues) if (issue.open) openByFeature.set(issue.featureId, (openByFeature.get(issue.featureId) ?? 0) + 1)
  let hiddenIssues = 0
  for (const count of openByFeature.values()) hiddenIssues += Math.max(0, count - MAX_ISSUES_PER_FEATURE)
  const unclassified = issues.filter((i) => i.featureId === general && slugs.length > 0).length
  const conflicts = issues.filter((i) => i.conflict).length

  return { features, issues, links, generalId: general, conflicts, unclassified, hiddenFeatures, hiddenIssues }
}

// The open issues drawn as small bones: the newest of each feature, up to the overview limit.
export function visibleIssues(anatomy: Anatomy): AnatomyIssue[] {
  const shown = new Map<string, number>()
  const out: AnatomyIssue[] = []
  for (const issue of [...anatomy.issues].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))) {
    if (!issue.open) continue
    const count = shown.get(issue.featureId) ?? 0
    if (count >= MAX_ISSUES_PER_FEATURE) continue
    shown.set(issue.featureId, count + 1)
    out.push(issue)
  }
  return out
}

// How much an open issue count shifts a feature's scales: monotonic, capped, and zero when nothing is open.
export function scaleTint(openIssues: number): { mix: number; roughness: number } {
  const mix = Math.min(1, Math.max(0, openIssues) / 4)
  return { mix, roughness: 0.35 + 0.45 * mix }
}

export function issuesOf(anatomy: Anatomy, featureIdValue: string): AnatomyIssue[] {
  return anatomy.issues.filter((i) => i.featureId === featureIdValue)
}

export function linksOf(anatomy: Anatomy, issueIdValue: string): PullLink[] {
  return anatomy.links.filter((l) => l.issueIds.includes(issueIdValue))
}

export function featureById(anatomy: Anatomy, id: string): Feature | undefined {
  return anatomy.features.find((f) => f.id === id)
}
