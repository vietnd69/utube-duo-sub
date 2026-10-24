# Changelog

All notable changes to this project are recorded here. Versions follow [Semantic Versioning](https://semver.org/) and dates use ISO 8601 (`YYYY-MM-DD`).

## [Unreleased]

### Added

- English README, license, contributing guide, security and privacy policies, issue and PR templates.
- CI workflow (lint, unit tests, package) and a release workflow that attaches the zip to a GitHub release.
- SPDX license headers on every source file.
- ESLint rule that requires JSDoc on every function in shipped code.
- Automatic GitHub release with the extension zip whenever `main` gets a new version.

### Changed

- `npm run package` no longer needs the `zip` command: it is pure Node.js, works on Windows, and builds a reproducible archive.

### Removed

- README screenshots.

## [1.0.0] - 2026-10-24

### Added

- Dual subtitles on YouTube with the secondary track inferred from the user's own track switches.
- Dual subtitles switch, secondary font size and secondary position inside YouTube's own Settings menu.
- Word-by-word display of auto-generated captions.
- English and Vietnamese UI.

[Unreleased]: https://github.com/vietnd69/utube-duo-sub/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/vietnd69/utube-duo-sub/releases/tag/v1.0.0
