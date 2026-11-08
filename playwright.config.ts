import { defineConfig, devices } from '@playwright/test';

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * SCOPE OF THIS SUITE - read before trusting a green run:
 *
 * These tests drive the **web layer only** - the very same `index.html` + `src/` that Tauri
 * loads into its webview, served here by `vite preview` and rendered by headless Chromium.
 * They do NOT exercise the shipped desktop artifact. Playwright cannot drive a Tauri v2
 * window: on Linux the webview is WebKitGTK via WRY, there is no CDP endpoint, and Playwright
 * ships no driver for it. The supported route for the real window is `tauri-driver` +
 * WebdriverIO, which needs a Rust toolchain and a built Tauri binary.
 *
 * So: the Rust side, IPC/`invoke` command dispatch, window chrome, bundling, and any
 * WebKit-vs-Chromium rendering difference are all UNVERIFIED here. A regression that only
 * shows up in WebKitGTK will not be caught by a Chromium baseline.
 */

/**
 * Port the built game is previewed on.
 *
 * Env-driven so several checkouts (or several templates) can run their suites side by side.
 * With a hardcoded port, `reuseExistingServer` will happily attach to whatever is already
 * listening and screenshot somebody else's app. `--strictPort` makes a clash fail loudly
 * instead of silently sliding to the next free port.
 *
 * NOTE: this is the *preview* port and is intentionally separate from the dev-server port.
 * `vite.config.ts` pins the dev server to 1420 with `strictPort` because `src-tauri/
 * tauri.conf.json`'s `devUrl` hardcodes `http://localhost:1420`; that pin must stay exactly as
 * it is or `tauri dev` breaks. Vite's preview server has its own port (default 4173) and does
 * not inherit `server.port`, so nothing here touches the Tauri-facing config.
 *
 * CI leaves EX_E2E_PORT unset and gets Vite's default preview port.
 */
const port = Number(process.env.EX_E2E_PORT ?? 4173);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests',
  webServer: {
    // Deliberately previewing the *built* output rather than running a dev server: verifying
    // that the production build pipeline still produces a working page is the whole point of a
    // template, and `dist/` is exactly what `tauri build` embeds (`frontendDist: "../dist"`).
    // `npm test` runs the build first.
    command: `npm run serve -- --port ${port} --strictPort`,
    timeout: 240 * 1000, // linux takes a long time
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--no-sandbox', '--disable-web-security', '--use-angle=gl'],
        },
      },
    },

    // Snapshot baselines are committed for chromium/linux only (that is what CI runs).
    // Enabling another browser or platform means regenerating baselines for it.
    //
    // In particular, do NOT be tempted to enable the `webkit` project as a stand-in for Tauri's
    // WebKitGTK webview: Playwright's WebKit is its own patched build with its own font stack
    // and is not the runtime Tauri ships. It would produce a third set of baselines that
    // matches neither what CI runs nor what users see.
  ],
});
