import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * Determinism harness for Excalibur snapshot tests.
 *
 * A running Excalibur game is driven by `requestAnimationFrame` wall-clock time, so a naive
 * `await page.click('#excalibur-play'); await expect(page).toHaveScreenshot()` captures
 * "whatever happened to be on screen when the browser got around to it". That is only stable
 * by accident (in this template, because the demo Player sits in an `actions.delay(2000)`
 * long enough for the capture to land while it is still parked). The moment anything on
 * screen actually animates, `toHaveScreenshot`'s "wait for two identical consecutive frames"
 * retry loop never converges and the test flakes or times out.
 *
 * This module replaces wall-clock time with *simulated* time so a snapshot is a pure function
 * of "how many milliseconds of game time have elapsed":
 *
 *  1. `Math.random` is replaced with a seeded PRNG. Several engine subsystems (particle
 *     emitters, camera shake) fall back to raw `Math.random()` for variance when no seeded
 *     `ex.Random` is supplied, which is otherwise genuinely nondeterministic run to run.
 *  2. The engine's `Clock` is frozen the instant the `Engine` constructor registers itself on
 *     `window.___EXCALIBUR_DEVTOOL`, and from then on only advances when the test asks it to.
 *
 * PORTABILITY: nothing in this file is specific to a bundler, a template, or a game. It is
 * meant to be copied verbatim into any Excalibur template; only `playwright.config.ts`'s
 * `webServer.command` needs to differ per template.
 *
 * ONE DELIBERATE ADDITION vs the copy in `template-ts-vite`: this template calls
 * `game.start()` with **no loader**, so no `#excalibur-play` button is ever created and the
 * original "poll until the play button appears" boot would simply time out. `Engine.start` is
 * therefore wrapped at freeze time to record whether a loader was passed, and
 * `bootGameWithFrozenClock` skips the play-button handshake when it was not. Templates that
 * do pass a loader keep the original hard `toBeHidden()` assertion.
 */

/** Simulated milliseconds handed to the engine per step. 16.6ms ~= 60fps, Excalibur's default. */
export const STEP_MS = 16.6;

/**
 * Real `requestAnimationFrame` yields are interleaved every N simulated steps. Stepping the
 * clock synchronously in a tight loop queues up WebGL draw calls faster than the compositor
 * drains them, which on GPU-heavy scenes backs up into an unresponsive tab. Yielding gives the
 * browser a chance to actually flush. Only the *simulated* elapsed time handed to the engine
 * is deterministic - the real-world pacing between steps is not, and does not need to be.
 */
const YIELD_EVERY = 3;

/**
 * Installed via `page.addInitScript` before any page script runs.
 *
 * Why hook the `___EXCALIBUR_DEVTOOL` property rather than poll for it: `Engine`'s constructor
 * assigns `window.___EXCALIBUR_DEVTOOL = this` as its last statement, and `clock.start()` only
 * happens later in `Engine.start()`. Defining a setter therefore lets us freeze the clock
 * synchronously, in the same task, *before* a single real frame can ever tick - so there is no
 * "few milliseconds of real time leaked in before the freeze" drift to tolerate.
 *
 * Why drive the existing `Clock` instance instead of swapping in a `TestClock`: swapping would
 * silently drop everything already registered through `clock.schedule()` on the original clock
 * - most importantly the `Loader`'s own 200ms "show the play button" delay - leaving the loader
 * permanently stuck. `Clock.update(overrideMs)` is `protected`, which is a compile-time
 * concern only; at runtime it is an ordinary method, and passing an override makes both the
 * `elapsed` handed to `tick()` and the clock's scheduled-callback bookkeeping exact.
 */
const INSTALL_DETERMINISM_HOOKS = `
(function () {
  // 1. Deterministic Math.random (xorshift-ish, fixed seed).
  var seed = 0x2f6e2b1;
  Math.random = function () {
    seed |= 0;
    seed = (seed + 0x9e3779b9) | 0;
    var t = Math.imul(seed ^ (seed >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };

  // 2. Freeze the engine clock as soon as the engine exists.
  var engine;
  function freeze(e) {
    if (!e || !e.clock || e.clock.__exFrozen) return;
    if (e.clock.isRunning) {
      e.clock.stop();
    }
    e.clock.__exFrozen = true;
    // Belt and braces: Engine.start() and the "window regained focus" handler both call
    // clock.start(), which would resume the real rAF loop and undo the freeze.
    e.clock.start = function () {};

    // Record whether the game boots with a loader. Engine.start(loader?) only builds the
    // #excalibur-play button when one is supplied; this template calls a bare game.start(),
    // so the test harness must not wait for a button that will never exist. The engine
    // constructor assigns ___EXCALIBUR_DEVTOOL as its *last* statement, before any user code
    // can call start(), so wrapping here always lands first.
    if (!e.__exStartWrapped) {
      e.__exStartWrapped = true;
      var originalStart = e.start;
      e.start = function () {
        window.__exStartArgCount = arguments.length;
        return originalStart.apply(this, arguments);
      };
    }
  }
  Object.defineProperty(window, '___EXCALIBUR_DEVTOOL', {
    configurable: true,
    get: function () { return engine; },
    set: function (e) { engine = e; freeze(e); }
  });

  // Advance the frozen clock by \`steps\` simulated frames. Resolves false if no engine has
  // been constructed yet, so callers can poll during boot.
  window.__exStep = async function (steps, stepMs) {
    if (!engine || !engine.clock) return false;
    freeze(engine);
    for (var i = 0; i < steps; i++) {
      engine.clock.update(stepMs || ${STEP_MS});
      if ((i + 1) % ${YIELD_EVERY} === 0 || i === steps - 1) {
        await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      }
    }
    return true;
  };
})();
`;

/**
 * Arms the determinism hooks for this page. MUST be awaited before `page.goto` - init scripts
 * only apply to navigations that happen after they are registered.
 */
export async function installDeterminismHooks(page: Page): Promise<void> {
  await page.addInitScript(INSTALL_DETERMINISM_HOOKS);
}

/** Advance the frozen clock by a number of simulated frames. */
async function step(page: Page, steps: number): Promise<boolean> {
  return page.evaluate((s) => (window as any).__exStep?.(s) ?? false, steps);
}

/**
 * Advance the frozen clock by `ms` of simulated game time.
 *
 * Rounded up to a whole number of {@link STEP_MS} frames, so express test timings in
 * milliseconds of game time and let this do the arithmetic.
 */
export async function advanceGameTime(page: Page, ms: number): Promise<void> {
  const advanced = await step(page, Math.ceil(ms / STEP_MS));
  if (!advanced) {
    throw new Error('Cannot advance game time: no Excalibur engine found on window.___EXCALIBUR_DEVTOOL');
  }
}

/**
 * Boot the game with a frozen clock and dismiss the loader, leaving the page parked on the
 * first frame of the start scene with zero simulated time elapsed beyond the boot itself.
 *
 * Resolves to the game canvas locator.
 *
 * Loader detection deliberately reads the play button's *inline* `style.display`
 * (`Loader.showPlayButton()` sets it to `flex`, `hidePlayButton()` back to `none`) rather
 * than its computed style: the loader's stylesheet ships two competing `button#excalibur-play`
 * rules and the later one is `display: flex`, so the computed value reads `flex` from the very
 * first frame and is useless as a readiness signal. (`#excalibur-play-root[aria-busy]`, which
 * would be the tidier signal, does not exist in published Excalibur builds.)
 */
export async function bootGameWithFrozenClock(page: Page, url = '/'): Promise<Locator> {
  await installDeterminismHooks(page);
  await page.goto(url);

  const canvas = page.locator('canvas').first();
  await canvas.waitFor({ state: 'visible' });

  const MAX_BOOT_POLLS = 300;

  // Wait for the engine to exist and for user code to have called `start()`, pumping the frozen
  // clock as we go. `__exStartArgCount` is set by the wrapper installed in the init script.
  let startArgCount: number | undefined;
  for (let i = 0; i < MAX_BOOT_POLLS && startArgCount === undefined; i++) {
    startArgCount = await page.evaluate(() => (window as any).__exStartArgCount);
    if (startArgCount === undefined) {
      await step(page, 2);
    }
  }
  if (startArgCount === undefined) {
    throw new Error(
      `Engine.start() was never called after ${MAX_BOOT_POLLS} polls - the game failed to boot.`
    );
  }

  // No loader argument means no `#excalibur-play` button will ever be created: the engine goes
  // straight into the start scene. Pump a couple of frames so the first frame is drawn, then
  // hand back the canvas.
  if (startArgCount === 0) {
    await expect(
      page.locator('#excalibur-play'),
      'a loader-less game.start() should not produce a play button'
    ).toHaveCount(0);
    await step(page, 2);
    return canvas;
  }

  // The play button only appears once resources have loaded AND the loader's scheduled 200ms
  // "aesthetic delay" has been ticked off the frozen clock - so pump the clock while polling.
  // Resource fetches resolve on their own; the rAF yields inside __exStep give them room to.
  const playButton = page.locator('#excalibur-play');
  let shown = false;
  for (let i = 0; i < MAX_BOOT_POLLS && !shown; i++) {
    shown = await page.evaluate(
      () => (document.getElementById('excalibur-play') as HTMLElement | null)?.style.display === 'flex'
    );
    if (!shown) {
      await step(page, 2);
    }
  }
  if (!shown) {
    throw new Error(
      `Loader play button never appeared after ${MAX_BOOT_POLLS} polls - the game failed to load its resources.`
    );
  }

  await playButton.click();
  // Never screenshot the boot screen (Excalibur logo / loading bar / play button) by accident -
  // fail loudly instead. hidePlayButton() runs synchronously on click, so no stepping needed.
  await expect(playButton, 'loader play button should be dismissed before capturing').toBeHidden();

  return canvas;
}

/**
 * Capture and compare a single frame.
 *
 * Uses `page.screenshot()` + `toMatchSnapshot` rather than `toHaveScreenshot`: the latter
 * retries until two consecutive frames are identical, which by design never converges on a
 * scene that is animating - and animating scenes are exactly what these tests exist to guard.
 * With the clock frozen there is nothing to wait for; the frame on screen is the frame we asked
 * for. The small tolerance absorbs GPU/driver-level antialiasing noise between machines.
 *
 * Mind what a *ratio* tolerance can and cannot catch on a sparse scene: 1% of a 1280x720
 * viewport is ~9200 pixels, which is enough to swallow a small sprite moving a short distance,
 * or (in this template) an entire line of 50px text changing. The default here is therefore
 * 0.0005 (~460px), not Playwright's habitual 0.01.
 *
 * Measured on this template (1280x720, chromium/linux):
 *   - run-to-run drift with the clock frozen: **0 pixels** over three consecutive runs at
 *     `maxDiffPixelRatio: 0`, so the tolerance exists only to absorb cross-machine GPU/font
 *     differences, not local flake;
 *   - dropping `hello.text = textFromRust` (the negative control for the greet case):
 *     **14396 px** different, ~31x the 0.0005 budget;
 *   - the same frames rendered by Excalibur 0.32 instead of v1: **6616 px** on the wrapped
 *     greet frame, but only **343 px** on the single-line at-rest frame - i.e. the at-rest
 *     capture is NOT sensitive enough to tell 0.32 text rendering from v1's. Do not read a
 *     green at-rest case as "text rendering is unchanged". Pixel comparison is still only the backstop
 * for "the scene renders at all"; assert game *logic* (actor positions, label text, scene
 * state) directly in the spec rather than trusting pixels to notice.
 *
 * NOTE when re-recording: `--update-snapshots` defaults to `changed` mode, which only rewrites
 * baselines whose comparison actually failed - so a deliberately retimed capture that still
 * passes the tolerance will keep the *old* image. `npm run test:integration-update` passes
 * `--update-snapshots=all` to avoid that trap.
 */
export async function expectFrameToMatch(page: Page, name: string, maxDiffPixelRatio = 0.0005): Promise<void> {
  const screenshot = await page.screenshot();
  expect(screenshot).toMatchSnapshot(name, { maxDiffPixelRatio });
}
