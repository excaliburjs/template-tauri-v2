# Tauri 2.0 + Excalibur.js

This template should help get you started developing with Tauri in vanilla HTML, CSS and Typescript.

![tauri example](./tauri.png)

## Running Locally

Install Rust
* https://www.rust-lang.org/learn/get-started#installing-rust

Install Node
* https://nodejs.org/en/download

Run
* `npm install`
* `npm run tauri android init`
* `npm run dev`

For desktop development, run 
* `npm run tauri:dev`

For Android development, run
* `npm run tauri:android-dev`


## Testing

```
npm test                      # build, then run the Playwright suite
npm run test:integration      # run the suite against an already-built dist/
npm run test:integration-update  # re-record snapshot baselines (--update-snapshots=all)
```

The suite previews the production build (`vite preview`) and drives it with headless Chromium.
Set `EX_E2E_PORT` to move it off the default preview port (4173) - useful when several
checkouts run side by side. The dev-server port stays pinned at **1420** in `vite.config.ts`
because `src-tauri/tauri.conf.json`'s `devUrl` hardcodes it; do not change that.

### What the tests cover - and what they do not

These tests exercise the **web layer only**: the same `index.html` + `src/` that Tauri loads
into its webview. They are a good proxy for the game code and will catch Excalibur API and
rendering regressions.

They do **not** test the shipped desktop app. Playwright cannot drive a Tauri v2 window - on
Linux that window is WebKitGTK via WRY, with no CDP endpoint and no Playwright driver. So the
Rust side, the IPC bridge (`invoke` is stubbed in the tests, not exercised), window chrome,
bundling, and WebKit-specific rendering are all unverified. A rendering regression that only
appears in WebKitGTK will not show up against a Chromium baseline.

Driving the real window is possible with
[`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/) + WebdriverIO, which needs a
Rust toolchain, a built Tauri binary, and `webkit2gtk-driver` on the runner.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
