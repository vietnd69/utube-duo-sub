# Contributing

Thanks for helping improve YouTube Duo Sub. Bug reports, fixes and translations are all welcome.

## Reporting bugs

Open an issue with the **Bug report** template. YouTube changes its player often, so the most useful details are:

- Chrome version and extension version (`chrome://extensions`)
- A link to a public video that shows the problem
- The primary and secondary tracks (for example "English (auto-generated) → Vietnamese, auto-translated")
- Whether it happens on `youtube.com`, `m.youtube.com` or an embedded player
- Any errors in DevTools → Console that mention `duosub`

## Development setup

Requirements: Node.js 22 or later, Chrome 111 or later.

```bash
npm install
npm run check        # lint + unit tests, same as CI
```

Load the repo root as an unpacked extension (see [README](README.md#install-developer-mode)) and reload it in `chrome://extensions` after each change.

The e2e test needs Playwright, which is not a dev dependency so that `npm install` stays small:

```bash
npm install --no-save playwright
npx playwright install chromium
npm run test:e2e
```

## Pull requests

- Keep each PR to one change and describe how you tested it on a real YouTube video.
- `npm run check` must pass.
- Put DOM-free logic in `src/core.js` or `src/settings.js` and cover it with a unit test in `test/core.test.js`.
- Follow the existing style: strict mode, JSDoc on every function, no `innerHTML` (YouTube enforces Trusted Types), and route any settings data through `sanitizeSettings`/`sanitizePatch`.
- Do not add permissions to `manifest.json` unless the change cannot work without them, and explain why in the PR.
- New UI strings go in every file under `_locales/`.

## Adding a language

1. Copy `_locales/en/messages.json` to `_locales/<code>/messages.json`, using a [Chrome locale code](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales).
2. Translate every `message` value; leave the keys unchanged.
3. Mention the language in the README features list.

## Releasing (maintainers)

1. Bump `version` in both `manifest.json` and `package.json`.
2. Move the `Unreleased` entries in `CHANGELOG.md` under the new version with today's date (`YYYY-MM-DD`).
3. Run `npm run test:e2e` (CI does not run it).
4. Commit, then tag and push: `git tag v1.2.3 && git push origin v1.2.3`.
5. The **Release** workflow builds `youtube-duo-sub-<version>.zip` and attaches it to a GitHub release.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
