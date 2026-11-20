// Browser tests for what unit tests cannot reach: the page, the 3D view, downloads, and GitHub failures.
// GitHub is never contacted. Every request to api.github.com is blocked and recorded unless a test serves it.
import { readFileSync } from 'node:fs'
import { test as base, expect, type Page, type Route } from '@playwright/test'

const test = base.extend<{ github: string[]; errors: string[] }>({
  github: [async ({ page }, use) => {
    const calls: string[] = []
    await page.route('https://api.github.com/**', (route) => {
      calls.push(route.request().url())
      return route.abort('internetdisconnected')
    })
    await use(calls)
  }, { auto: true }],
  errors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await use(errors)
    expect(errors, 'uncaught exceptions in the page').toEqual([])
  }, { auto: true }],
})

const tick = async (page: Page) => Number((await page.locator('#tick').textContent())?.match(/\d+/)?.[0] ?? -1)

// A small public repository, served from memory: two branches, three commits, one failed CI run.
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
async function serveRepo(page: Page, seen: { auth: (string | undefined)[] } = { auth: [] }) {
  await page.route('https://api.github.com/repos/test/repo**', (route: Route) => {
    seen.auth.push(route.request().headers().authorization)
    const path = new URL(route.request().url()).pathname.replace('/repos/test/repo', '')
    const body =
      path === '' ? { full_name: 'test/repo', default_branch: 'main' }
      : path === '/branches' ? [{ name: 'main' }, { name: 'dev' }]
      : path === '/pulls' ? []
      : path === '/actions/runs' ? { workflow_runs: [{ id: 7, name: 'ci', head_branch: 'dev', conclusion: 'failure', updated_at: ago(2) }] }
      : path === '/commits' ? [1, 3, 5].map((d) => ({ sha: `sha${d}`, html_url: `https://github.com/test/repo/commit/sha${d}`, commit: { message: `change ${d}`, committer: { date: ago(d) } } }))
      : null
    if (body === null) return route.fulfill({ status: 404, body: '{}' })
    return route.fulfill({ json: body, headers: { 'x-ratelimit-remaining': '57' } })
  })
  return seen
}

test.describe('ecosystem', () => {
  test('the demo boots without the network and replays', async ({ page, github }) => {
    await page.goto('./')
    await expect(page.locator('#dataset')).toContainText('synthetic/reef-demo')
    await expect(page.locator('#legend li')).toHaveCount(4)
    const start = await tick(page)
    await expect.poll(() => tick(page)).toBeGreaterThan(start + 20)
    await expect(page.locator('#s-pop')).not.toHaveText('0')
    await expect(page.locator('#error')).toBeEmpty()
    expect(github).toEqual([])
  })

  test('pausing stops the replay and shows the state hash', async ({ page }) => {
    await page.goto('./')
    await expect.poll(() => tick(page)).toBeGreaterThan(10)
    await page.locator('#pause').click()
    const held = await tick(page)
    await page.waitForTimeout(700)
    expect(await tick(page)).toBe(held)
    await expect(page.locator('#tick')).toContainText(/state [0-9a-f]{8}/)
  })

  test('clicking a fish follows it in the Organism panel', async ({ page }) => {
    await page.goto('./')
    await expect.poll(() => tick(page)).toBeGreaterThan(10)
    await page.locator('#pause').click() // still fish are easier to hit
    const box = (await page.locator('#scene').boundingBox())!
    for (let i = 0; i < 300 && (await page.locator('#organism .hint').count()) > 0; i++) {
      await page.mouse.click(box.x + box.width * (0.1 + 0.8 * ((i * 37) % 100) / 100), box.y + box.height * (0.1 + 0.6 * ((i * 61) % 97) / 97))
    }
    await expect(page.locator('#organism')).toContainText('Status')
    await expect(page.locator('#organism')).toContainText('Genome')
  })

  test('filtering a lineage narrows the Ecologist to it', async ({ page }) => {
    await page.goto('./')
    await page.locator('#speed input[value="4"]').check({ force: true }) // the radio itself is visually hidden
    await expect.poll(() => tick(page)).toBeGreaterThan(100)
    const main = page.locator('#legend button').first()
    await main.click()
    await expect(main).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#legend')).toHaveClass(/filtered/)
    await page.locator('#suggest button', { hasText: 'Why did the population change?' }).click()
    await expect(page.locator('#answers')).toContainText('Lineage main')
    await main.click()
    await expect(main).toHaveAttribute('aria-pressed', 'false')
  })

  test('the Ecologist answers in four labelled parts, by rule, and takes typed questions', async ({ page }) => {
    await page.goto('./')
    await page.locator('#speed input[value="4"]').check({ force: true }) // the radio itself is visually hidden
    await expect.poll(() => tick(page)).toBeGreaterThan(100)
    await page.locator('#suggest button', { hasText: 'Why did the population change?' }).click()
    const answer = page.locator('#answers > li').first()
    for (const part of [/rule-based explanation/i, /facts/i, /applied rules/i, /interpretation/i, /uncertainty/i]) await expect(answer).toContainText(part)
    await page.locator('#question').fill('Which workflow fails most?')
    await page.locator('#ask button').click()
    await expect(page.locator('#answers > li')).toHaveCount(2)
  })
})

test.describe('import', () => {
  test('a working import loads the repository, says so quietly, and updates the link', async ({ page }) => {
    const seen = await serveRepo(page)
    await page.goto('./')
    await page.locator('#repo').fill('test/repo')
    await page.locator('#import').click()
    await expect(page.locator('#error')).toHaveText(/Imported with \d+ of 40 requests/)
    await expect(page.locator('#error')).toHaveClass(/note/) // a success is not shown in red
    await expect(page.locator('#dataset')).toContainText('test/repo')
    await expect(page.locator('#legend li')).toHaveCount(2)
    await expect(page).toHaveURL(/\?repo=test\/repo&seed=1$/)
    expect(seen.auth.every((a) => a === undefined)).toBe(true) // no token, no Authorization header
  })

  test('a token goes only to GitHub as a header, never into the address bar', async ({ page }) => {
    const seen = await serveRepo(page)
    await page.goto('./')
    await page.locator('#repo').fill('test/repo')
    await page.locator('#token').fill('ghp_secret123')
    await page.locator('#import').click()
    await expect(page.locator('#dataset')).toContainText('test/repo')
    expect(seen.auth.length).toBeGreaterThan(0)
    expect(seen.auth.every((a) => a === 'Bearer ghp_secret123')).toBe(true)
    expect(page.url()).not.toContain('ghp_secret123')
  })

  test('when GitHub cannot be reached, the error is red and the demo stays', async ({ page }) => {
    await page.goto('./')
    await page.locator('#repo').fill('vitejs/vite')
    await page.locator('#import').click()
    await expect(page.locator('#error')).toHaveText(/Import failed: .* The previous dataset is still loaded\./)
    await expect(page.locator('#error')).not.toHaveClass(/note/)
    await expect(page.locator('#dataset')).toContainText('synthetic/reef-demo')
  })

  test('a rate limit says what happened and how to get more requests', async ({ page }) => {
    await page.route('https://api.github.com/**', (route) => route.fulfill({ status: 403, body: '{}', headers: { 'x-ratelimit-remaining': '0' } }))
    await page.goto('./')
    await page.locator('#repo').fill('vitejs/vite')
    await page.locator('#import').click()
    await expect(page.locator('#error')).toContainText('rate limit reached (0 requests left this hour)')
    await expect(page.locator('#error')).toContainText('Add a token')
  })

  test('input that is not a repository is refused without a request', async ({ page, github }) => {
    await page.goto('./')
    await page.locator('#repo').fill('not a repo')
    await page.locator('#import').click()
    await expect(page.locator('#error')).toContainText('Enter a public repository')
    expect(github).toEqual([])
  })

  test('a shared link imports its repository with its seed; a bad one opens the demo', async ({ page, github }) => {
    await page.goto('./?repo=bogus&seed=2')
    await expect(page.locator('#seed')).toHaveValue('2')
    await expect(page.locator('#dataset')).toContainText('synthetic/reef-demo')
    await page.waitForTimeout(500)
    expect(github).toEqual([])

    await serveRepo(page)
    await page.goto('./?repo=test/repo&seed=3')
    await expect(page.locator('#seed')).toHaveValue('3')
    await expect(page.locator('#dataset')).toContainText('test/repo')
  })

  test('a saved dataset reopens without the network; a foreign file is refused', async ({ page }, info) => {
    await serveRepo(page)
    await page.goto('./')
    await page.locator('#repo').fill('test/repo')
    await page.locator('#import').click()
    await expect(page.locator('#dataset')).toContainText('test/repo')

    const download = page.waitForEvent('download')
    await page.locator('#save').click()
    const file = info.outputPath('saved.json')
    await (await download).saveAs(file)
    expect((await download).suggestedFilename()).toBe('test_repo-seed-1.json')

    await page.unroute('https://api.github.com/repos/test/repo**') // from here on GitHub is unreachable
    await page.locator('#demo').click()
    await expect(page.locator('#dataset')).toContainText('synthetic/reef-demo')
    await page.locator('#file').setInputFiles(file)
    await expect(page.locator('#dataset')).toContainText('test/repo')
    await expect(page.locator('#legend li')).toHaveCount(2)

    await page.locator('#file').setInputFiles({ name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('{"not":"a dataset"}') })
    await expect(page.locator('#error')).toContainText('Could not open that dataset')
    await expect(page.locator('#dataset')).toContainText('test/repo')
  })
})

test.describe('pictures', () => {
  // A PNG's width and height sit at fixed offsets in its header.
  const png = (path: string) => {
    const b = readFileSync(path)
    return { png: b.subarray(1, 4).toString() === 'PNG', width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length }
  }

  for (const mode of ['ecosystem', 'projects'] as const) {
    test(`Save picture downloads what the ${mode} tank shows`, async ({ page }, info) => {
      await page.goto('./')
      if (mode === 'projects') await page.locator('#tab-projects').click()
      await page.waitForTimeout(1000)
      const download = page.waitForEvent('download')
      await page.locator('#snap').click()
      const file = info.outputPath('tank.png')
      await (await download).saveAs(file)
      expect((await download).suggestedFilename()).toBe(mode === 'projects' ? 'projects.png' : 'synthetic_reef-demo-seed-1.png')
      const image = png(file)
      expect(image.png).toBe(true)
      const view = (await page.locator('#scene').boundingBox())!
      expect(image.width).toBeGreaterThanOrEqual(Math.floor(view.width)) // the full drawing buffer, not a thumbnail
      expect(Math.abs(image.width / image.height - 8 / 5)).toBeLessThan(0.02)
      expect(image.bytes).toBeGreaterThan(50_000) // a blank or black canvas compresses to a few kilobytes
    })
  }
})

test.describe('projects', () => {
  test('the Projects tab opens on the demo tank without the network', async ({ page, github }) => {
    await page.goto('./')
    await page.locator('#tab-projects').click()
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'projects')
    await expect(page.locator('#plegend li')).toHaveCount(8)
    await expect(page.locator('#preadout')).toContainText('Fictional demo')
    await page.locator('#plegend button[data-repo="demo/driftwood"]').click()
    const card = page.locator('#project')
    for (const row of ['Age', 'Upkeep', 'Skeleton', 'Scales', 'unanswered for over 30 days']) await expect(card).toContainText(row)
    await expect(page.getByRole('button', { name: 'Show open pull requests' })).toHaveCount(0) // demo repositories do not exist
    expect(github).toEqual([])
  })

  test('when real projects cannot be loaded, the error is red and the demo tank stays', async ({ page }) => {
    await page.goto('./')
    await page.locator('#tab-projects').click()
    await page.locator('#pload').click() // blank loads seven well-known repositories, all unreachable here
    await expect(page.locator('#error')).toContainText('Could not load projects')
    await expect(page.locator('#error')).not.toHaveClass(/note/)
    await expect(page.locator('#plegend li')).toHaveCount(8)
  })
})

test.describe('layout and fallbacks', () => {
  test('a phone-width screen never scrolls sideways, in either mode', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('./')
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(await sideways()).toBe(0)
    await page.locator('#tab-projects').click()
    await page.locator('#plegend button').first().click()
    expect(await sideways()).toBe(0)
  })

  test('without WebGL the page explains why and the readouts still work', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return /webgl/.test(kind) ? null : (original as any).call(this, kind, ...rest)
      } as typeof original
    })
    await page.goto('./')
    await expect(page.locator('.view p')).toContainText('needs WebGL')
    await expect(page.locator('#snap')).toHaveCount(0)
    await expect(page.locator('#s-pop')).not.toHaveText('0')
    await page.locator('#tab-projects').click()
    await expect(page.locator('#plegend li')).toHaveCount(8)
  })
})
