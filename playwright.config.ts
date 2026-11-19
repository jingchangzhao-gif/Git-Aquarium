// Browser tests: the production build, served the way GitHub Pages serves it, in the installed Chrome.
// Run with `pnpm test:e2e`. GitHub is never contacted: each test serves or blocks api.github.com itself.
import { defineConfig } from '@playwright/test'

const PORT = 4174

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.e2e\.ts/, // not *.test.ts, so Vitest leaves these alone
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/Git-Aquarium/`,
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      // WebGL in headless Chrome: the real GPU on a Mac, software rendering on a Linux runner.
      args: process.platform === 'darwin'
        ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: `pnpm build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/Git-Aquarium/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
