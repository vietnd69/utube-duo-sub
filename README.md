# YouTube Duo Sub

[![CI](https://github.com/vietnd69/utube-duo-sub/actions/workflows/ci.yml/badge.svg)](https://github.com/vietnd69/utube-duo-sub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Chrome extension that shows **dual subtitles** on YouTube: a primary line and a secondary line at the same time.

## Features

- **No extra buttons or menus: everything lives in YouTube's own Settings menu.**
  - *Settings → Subtitles/CC*: the first row is a **Dual subtitles** switch (on/off).
  - *Settings → Subtitles/CC → Options*: adds **Secondary font size** and **Secondary position**, right after YouTube's own options.
- **Primary and secondary tracks are inferred from what you do.**
  - The primary track is whatever YouTube is showing. Pick it as usual from YouTube's subtitle list (including *Auto-translate*).
  - When you switch tracks within a video, the track you just left becomes the secondary. For example, watching English and then picking Vietnamese makes English the secondary. This choice is remembered for later videos. Tracks YouTube picks on its own when a video opens do not count.
  - If the remembered secondary is in the same language as the primary, the extension falls back to *Auto* mode (below). The extension popup still lets you choose by hand: *Auto*, *Off*, or a specific language.
- **Auto-translate → the secondary defaults to the original language.** When the primary is a YouTube auto-translation (for example English → Vietnamese), *Auto* mode shows the original track (English) as the secondary. When the primary is not a translation, the secondary is your preferred language (the browser language by default, or English if that matches the primary).
- **The secondary line is smaller than the primary.** 75% of the primary font size by default, adjustable from 40% to 95%. It can sit below or above the primary.
- **Reuses YouTube's own caption styling.** Font family, size, colour, opacity, background colour, window colour and edge style are copied from the captions YouTube renders, so any change in YouTube's *Settings → Subtitles/CC → Options* applies to both lines. The items added to the Settings menu use YouTube's own markup (`ytp-panel`, `ytp-panel-header`, `ytp-menuitem`…), so YouTube's CSS draws them exactly like the built-in items, in both the old and new player UI.
- **Auto-generated captions appear word by word as they are spoken**, using YouTube's per-word timing (`tOffsetMs`) and the same two-line roll-up as the native captions, instead of showing a whole sentence early and jumping by phrase. Auto-translations of auto-generated captions only have sentence-level timing, so their words are spread across the speech rhythm of the source track and also appear gradually (languages written without spaces, such as Chinese, Japanese and Thai, still show the whole sentence).
- Works with YouTube's SPA navigation, fullscreen and theater mode, and embedded players (`youtube-nocookie.com`). When there is no secondary (turned off, still loading, or failed to load), during ads, or when CC is off, the extension leaves YouTube's native captions untouched.
- English and Vietnamese UI.

## Install (developer mode)

1. Get the source: `git clone` this repo, or unzip the archive built with `npm run package` (also attached to each [GitHub release](https://github.com/vietnd69/utube-duo-sub/releases)).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repo root (the folder that contains `manifest.json`).
4. Open a YouTube video that has subtitles and turn on **CC**. Dual subtitles appear. Toggle them in *Settings → Subtitles/CC*. Change the secondary by picking two tracks in turn from YouTube's list.

Requires Chrome 111 or later (the content script runs in `world: "MAIN"`).

## How it works

```
YouTube player ──(request /api/timedtext + pot token)──► src/page.js (MAIN world)
                                                           │  records the session URL
                                                           │  fetches json3 for primary + secondary
                                                           │  renders the overlay, copies native caption style
                                                           ▼
chrome.storage.sync ◄──► src/bridge.js (isolated world) ◄──postMessage──► page.js
        ▲
        └── popup/popup.html (settings)
```

- YouTube protects its caption API with a *proof-of-origin* (`pot`) token that only the player can create. The extension never creates tokens itself. It watches the caption requests the player sends (hooking `fetch`/`XMLHttpRequest`, with Resource Timing as a fallback) and reuses that session's parameters to fetch other tracks of the same video. That is why **CC must be on** for the extension to work.
- YouTube's native captions are still rendered but hidden (`visibility: hidden`). This lets the extension read their computed style (`getComputedStyle`). Before native captions first appear, the style is derived from `player.getSubtitlesUserSettings()`.
- If captions fail to load (for example, an expired token), the extension leaves YouTube's native captions in place and retries later.

## Project layout

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 |
| `src/core.js` | Pure, DOM-free logic: json3 parsing, cue lookup by time, secondary track selection, URL building, style mapping |
| `src/settings.js` | Settings schema and validation (`sanitizeSettings`, `sanitizePatch`) |
| `src/page.js` | MAIN-world script: request tracking, caption fetching, overlay, items added to YouTube's Settings menu |
| `src/bridge.js` | Isolated-world script: syncs settings between `chrome.storage` and the page |
| `src/duosub.css` | Overlay styles |
| `popup/` | Settings popup |
| `_locales/` | UI strings (en, vi) |
| `test/core.test.js` | Unit tests (`node:test`) |
| `test/e2e/` | End-to-end test: loads the extension into Chromium against a mock YouTube page |
| `tools/` | Icon generation, zip packaging |

## Code standards

The code aims at the quality characteristics of **ISO/IEC 25010**:

- **Maintainability:** pure logic (`core.js`, `settings.js`) kept apart from the DOM, JSDoc on every function, ESLint (`eslint:recommended`, `strict`, `eqeqeq`, `curly`, `no-var`…), `.editorconfig`.
- **Reliability:** unit and e2e tests; every error from YouTube's internal APIs is caught, and the fallback is always the native captions.
- **Security:** minimal permissions (`storage` only); no `innerHTML` (compatible with YouTube's Trusted Types); every settings value read from or written to storage goes through `sanitizeSettings`/`sanitizePatch`; `postMessage` is restricted to `location.origin`.
- ECMAScript 2022 (ECMA-262, equivalent to ISO/IEC 22275), strict mode. Language codes follow ISO 639 / BCP 47 (`en`, `vi`, `pt-BR`…).
- **Accessibility:** popup and menu items follow ISO/IEC 40500 (WCAG 2.0): labelled controls, ARIA roles and states, visible focus, sufficient contrast.
- **Open source:** SPDX headers on every source file (ISO/IEC 5962); vulnerability disclosure and handling per ISO/IEC 29147 / 30111 ([SECURITY.md](SECURITY.md)).

The full mapping, with evidence and known gaps, is in [docs/STANDARDS.md](docs/STANDARDS.md).

## Development

```bash
npm install          # ESLint
npm run lint         # lint
npm test             # unit tests
npm run test:e2e     # e2e (needs Playwright + Chromium)
npm run package      # build dist/youtube-duo-sub-<version>.zip
npm run icons        # regenerate icons (Python + Pillow)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Privacy

The extension collects nothing and sends nothing anywhere. It only talks to YouTube, reusing the caption requests the player already makes, and stores its settings in `chrome.storage.sync`. See [PRIVACY.md](PRIVACY.md).

## Limitations

- YouTube's draggable caption window position and specially positioned captions (srv3) are not preserved; the overlay is always centred at the bottom.
- The extension relies on internal YouTube player APIs (`getOption('captions', …)`, `getPlayerResponse()`) and on the DOM structure of the Settings menu (`.ytp-panel-options`, `.ytp-subtitles-options-menu-item`), which may change when YouTube updates.

## License

[MIT](LICENSE). Not affiliated with or endorsed by YouTube or Google.
