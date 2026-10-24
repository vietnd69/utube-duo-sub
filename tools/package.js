// SPDX-FileCopyrightText: 2026 vietnd69
// SPDX-License-Identifier: MIT
'use strict';
/**
 * Builds dist/youtube-duo-sub-<version>.zip with only the files the
 * extension needs at runtime (ready for "Load unpacked" or the Web Store).
 *
 * Usage: npm run package   (requires the `zip` command)
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_FILES = ['manifest.json', '_locales', 'icons', 'popup', 'src'];

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const distDir = path.join(ROOT, 'dist');
const output = path.join(distDir, `youtube-duo-sub-${version}.zip`);

fs.mkdirSync(distDir, { recursive: true });
fs.rmSync(output, { force: true });
execFileSync('zip', ['-r', '-X', '-q', output, ...RUNTIME_FILES], { cwd: ROOT, stdio: 'inherit' });
console.log(`Created ${path.relative(ROOT, output)}`);
