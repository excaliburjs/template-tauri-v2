import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { advanceGameTime, bootGameWithFrozenClock, expectFrameToMatch } from './determinism';

/**
 * Golden-master + state assertions for the template's demo scene.
 *
 * ===========================================================================================
 * WHAT THIS SUITE COVERS - AND, IMPORTANTLY, WHAT IT DOES NOT
 * ===========================================================================================
 * Everything here runs against the **web layer**: `index.html` + `src/`, built by Vite,
 * served by `vite preview`, rendered by headless **Chromium**. That is the same code Tauri
 * loads into its webview (`frontendDist: "../dist"`), so it is a genuine proxy for the game
 * code and does catch Excalibur API/rendering regressions.
 *
 * It is NOT a test of the shipped desktop application. Playwright has no driver for a Tauri v2
 * window - on Linux that window is WebKitGTK via WRY with no CDP endpoint. Consequently the
 * following are entirely unverified by this suite:
 *
 *   - the Rust side (`src-tauri/`), including the real `greet` command;
 *   - the Tauri IPC bridge - `invoke()` is *stubbed* below, not exercised;
 *   - window chrome, sizing, menus, the bundler, updater, permissions/capabilities;
 *   - WebKitGTK rendering. A regression that only manifests in WebKit - different text
 *     metrics, a different WebGL/ANGLE path, a canvas quirk - will NOT be caught by a
 *     Chromium baseline.
 *
 * Driving the real window would mean `tauri-driver` + WebdriverIO, a Rust toolchain and a
 * built binary. See README/CI notes.
 * ===========================================================================================
 *
 * Both cases run against a frozen engine clock (see ./determinism.ts), so what is captured is
 * decided entirely by how much *simulated* game time we ask for - not by how fast the machine
 * happened to be. This template's demo scene is static (a single `ex.Label`, no Actions, no
 * transitions, no loader), so there is no "mid-patrol" moment to catch the way there is in the
 * sprite-based templates; the moving part here is the label's **text**, which the greet flow
 * rewrites. That is the case that guards `Label.text` / `Text.maxWidth` / font rendering.
 */

/** `src/main.ts`: the label sits 100px above screen centre. */
const LABEL_OFFSET_FROM_CENTER_Y = -100;

/** `src/main.ts`: the label's initial text. */
const INITIAL_TEXT = 'Hello Tauri 2.0! 🦀💖🎉';

/**
 * Verbatim from `src-tauri/src/lib.rs`:
 *
 *     #[tauri::command]
 *     fn greet(name: &str) -> String {
 *         format!("Hello, {}! You've been greeted from Rust!", name)
 *     }
 *
 * Kept in sync by hand - the stub below stands in for the Rust command, so if the real one
 * changes shape this constant is the thing that has to move with it.
 */
const greetReply = (name: string) => `Hello, ${name}! You've been greeted from Rust!`;

/**
 * A few frames past boot. Nothing in this scene animates, so this only needs to be enough for
 * the first frame to be drawn and the text glyphs rasterised.
 */
const SETTLE_MS = 500;

/** Read the demo Label's live state straight out of the running engine. */
async function labelState(page: Page): Promise<{ text: string; x: number; y: number; centerY: number } | null> {
  return page.evaluate(() => {
    const engine = (window as any).___EXCALIBUR_DEVTOOL;
    const actors = engine?.currentScene?.actors ?? [];
    // `src/main.ts` names the label 'Hello'; fall back to a structural match (the only actor in
    // this scene carrying a string `text`) so the test still works if the name is dropped.
    const label =
      actors.find((actor: any) => actor.name === 'Hello') ??
      actors.find((actor: any) => typeof actor.text === 'string');
    if (!label) {
      return null;
    }
    return {
      text: label.text as string,
      x: label.pos.x as number,
      y: label.pos.y as number,
      centerY: engine.screen.center.y as number
    };
  });
}

/**
 * Stand in for the Tauri IPC bridge.
 *
 * `@tauri-apps/api`'s `invoke()` is a one-liner over `window.__TAURI_INTERNALS__.invoke`, which
 * only exists inside a real Tauri webview. Installing a stub lets the *frontend half* of the
 * greet flow be tested in a browser: form submit -> invoke -> DOM update -> Excalibur label
 * update. The Rust half is not run; see the scope note at the top of this file.
 */
async function stubTauriIpc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any) => {
        if (cmd !== 'greet') {
          throw new Error(`Unstubbed Tauri command: ${cmd}`);
        }
        return `Hello, ${args?.name}! You've been greeted from Rust!`;
      },
      transformCallback: (cb: any) => cb,
      convertFileSrc: (p: string) => p
    };
  });
}

test('demo scene renders at rest', async ({ page }) => {
  await bootGameWithFrozenClock(page);
  await advanceGameTime(page, SETTLE_MS);

  // Assert engine state directly, not only via pixels: a tolerance on a mostly-empty frame can
  // absorb a surprising amount, and this is what actually pins the label down.
  const label = await labelState(page);
  expect(label, 'the demo ex.Label should exist in the start scene').not.toBeNull();
  expect(label!.text).toBe(INITIAL_TEXT);
  expect(label!.y, 'label should sit 100px above screen centre (src/main.ts)').toBeCloseTo(
    label!.centerY + LABEL_OFFSET_FROM_CENTER_Y,
    5
  );

  await expectFrameToMatch(page, 'demo-scene-at-rest.png', 0.0005);
});

test('greeting rewrites the label and re-renders it', async ({ page }) => {
  await stubTauriIpc(page);
  await bootGameWithFrozenClock(page);
  await advanceGameTime(page, SETTLE_MS);

  const before = await labelState(page);
  expect(before!.text).toBe(INITIAL_TEXT);

  await page.fill('#greet-input', 'Excalibur');
  await page.click('#greet-form button[type="submit"]');

  // The DOM half of the round trip.
  await expect(page.locator('#greet-msg')).toHaveText(greetReply('Excalibur'));

  // The Excalibur half: `hello.text = textFromRust` must reach the Label, and the Label must
  // re-rasterise. This is the case that would go red on a `Label.text` / `Text` regression.
  await advanceGameTime(page, SETTLE_MS);
  const after = await labelState(page);
  expect(after!.text, 'greet() should push the Rust reply into the ex.Label').toBe(
    greetReply('Excalibur')
  );

  // Tight ratio deliberately: at 0.01 (~9200px of a 1280x720 frame) a text change of this size
  // can still slip through on a sparse scene, and a mis-positioned or unrendered label
  // certainly would. See ./determinism.ts for the measured numbers.
  //
  // HEADS UP when eyeballing this baseline: the greet reply is long enough to wrap against
  // `maxWidth = 600`, and in Excalibur v1 the two wrapped lines *overlap* - 0.32 rendered them
  // with a ~15px gap (white-text row bands 200-241 / 256-309), v1 renders one merged band
  // 200-288. The baseline captures v1's behaviour as-is; the overlap is an upstream Text
  // line-spacing change, not a fault in this test.
  await expectFrameToMatch(page, 'demo-scene-after-greet.png', 0.0005);
});
