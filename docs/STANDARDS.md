# Standards conformance

How this project lines up with the ISO and related standards that apply to a small browser extension, and where the evidence lives. This is a self-assessment, not a certification.

## Product quality: ISO/IEC 25010

| Characteristic | How it is met | Evidence |
| --- | --- | --- |
| Functional suitability | Each feature in the README is covered by a unit or e2e test | `test/core.test.js`, `test/e2e/run.js` |
| Performance efficiency | One `requestAnimationFrame` loop and a coalesced `queueSync`; caption tracks are fetched once per video and cached | `src/page.js` |
| Compatibility | Runs beside YouTube's own player without replacing it; reuses YouTube's markup and CSS for menu items | `src/page.js` |
| Interaction capability (usability) | Controls live in YouTube's own Settings menu; UI in English and Vietnamese | `_locales/`, `src/page.js` |
| Reliability | Every call into YouTube's internal APIs is guarded; on any failure the native captions stay visible | `src/page.js` |
| Security | Only the `storage` permission; no `innerHTML`; `postMessage` limited to `location.origin` and checked with `event.source === window`; the isolated-world bridge passes every value read from or written to `chrome.storage` through `sanitizeSettings` / `sanitizePatch`, so nothing the page posts is stored unchecked (the MAIN-world script shares the page's trust level, so the bridge is the validation boundary) | `manifest.json`, `src/settings.js`, `src/bridge.js`, `src/page.js` |
| Maintainability | DOM-free logic kept in `core.js` and `settings.js`; JSDoc required on every function by ESLint; `.editorconfig` | `eslint.config.js` |
| Flexibility (portability) | Manifest V3, no build step, Chrome 111+ | `manifest.json` |

## Language and data formats

| Standard | Use in this project |
| --- | --- |
| ISO/IEC 22275 (ECMAScript, ECMA-262) | All code is ECMAScript 2022 in strict mode, enforced by ESLint `ecmaVersion: 2022` and `strict` |
| ISO/IEC 10646 (Unicode), UTF-8 | All text files are UTF-8 with LF line endings (`.editorconfig`, `.gitattributes`) |
| ISO 639 / BCP 47 | Language codes (`en`, `vi`, `pt-BR`, `zh-Hans`) are validated by `LANG_PATTERN` in `src/settings.js` and compared case-insensitively by primary subtag in `src/core.js` |
| ISO 8601 | Dates in `CHANGELOG.md` and copyright notices use `YYYY-MM-DD` or `YYYY` |

## Accessibility: ISO/IEC 40500 (WCAG 2.0)

- The popup declares its language (`<html lang>`, updated to the UI language at runtime), labels every control, uses `role="switch"` for the on/off toggle, and shows a visible focus outline.
- Text colours in the popup meet the 4.5:1 contrast ratio on the dark background (`#f1f1f1` and `#aaa` on `#0f0f0f`).
- Items added to YouTube's menu use `role="menuitemcheckbox"` / `menuitemradio` with `aria-checked`, and the sub-panel has a labelled back button and `role="heading"`, so screen readers announce them like YouTube's own items.

## Open source and security process

| Standard | Use in this project |
| --- | --- |
| ISO/IEC 5962 (SPDX) | Every source file starts with `SPDX-License-Identifier: MIT` and `SPDX-FileCopyrightText`; `package.json` uses the SPDX ID `MIT` |
| ISO/IEC 5230 (OpenChain license compliance) | One license (`LICENSE`), declared in `package.json` and README; contributions are licensed under it (`CONTRIBUTING.md`); runtime code has no third-party dependencies |
| ISO/IEC 29147 (vulnerability disclosure) | Private reporting channel and coordinated disclosure in `SECURITY.md` |
| ISO/IEC 30111 (vulnerability handling) | Acknowledge, triage, fix and advisory steps with target times in `SECURITY.md` |
| ISO/IEC/IEEE 12207 (life cycle processes) | Version control on GitHub, CI on every push and PR, tagged releases built by `release.yml`, changes recorded in `CHANGELOG.md` |
| ISO/IEC/IEEE 29119 (software testing) | Unit tests for pure logic and an e2e test against a mock YouTube page; CI runs lint and unit tests on every change |

## Known gaps

- The e2e test needs Playwright and Chromium, so CI does not run it yet; run `npm run test:e2e` before a release.
- Binary files (`icons/*.png`, `docs/*.png`) and JSON files cannot carry SPDX comments; they are covered by the repository `LICENSE`.
