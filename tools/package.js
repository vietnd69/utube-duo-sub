// SPDX-FileCopyrightText: 2026 vietnd69
// SPDX-License-Identifier: MIT
'use strict';
/**
 * Builds dist/youtube-duo-sub-<version>.zip with only the files the
 * extension needs at runtime (ready for "Load unpacked" or the Web Store).
 *
 * Pure Node.js, so it runs the same on Windows, macOS and Linux. The archive
 * is reproducible: files are sorted, text is stored with LF line endings and
 * every entry carries the same fixed timestamp.
 *
 * Usage: npm run package
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_FILES = ['manifest.json', '_locales', 'icons', 'popup', 'src'];
const TEXT_EXTENSIONS = new Set(['.js', '.css', '.html', '.json']);
/** MS-DOS date for 1980-01-01, the earliest a zip entry can carry. */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;

/**
 * Lists files under the given repo-relative paths, sorted, with '/' separators.
 * @param {string[]} entries
 * @returns {string[]}
 */
function listFiles(entries) {
  /** @type {string[]} */
  const out = [];
  for (const entry of entries) {
    const full = path.join(ROOT, entry);
    if (fs.statSync(full).isDirectory()) {
      out.push(...listFiles(fs.readdirSync(full).map((name) => `${entry}/${name}`)));
    } else {
      out.push(entry);
    }
  }
  return out.sort();
}

/**
 * Reads a file for the archive, normalising text to LF line endings.
 * @param {string} name repo-relative path
 * @returns {Buffer}
 */
function readEntry(name) {
  const data = fs.readFileSync(path.join(ROOT, name));
  return TEXT_EXTENSIONS.has(path.extname(name))
    ? Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    : data;
}

/**
 * Encodes files as a zip archive (deflate, UTF-8 names, no zip64).
 * @param {Array<{name: string, data: Buffer}>} files
 * @returns {Buffer}
 */
function zip(files) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest.json ${manifest.version}, package.json ${pkg.version}`);
  process.exit(1);
}

const files = listFiles(RUNTIME_FILES).map((name) => ({ name, data: readEntry(name) }));
const output = path.join(ROOT, 'dist', `youtube-duo-sub-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, zip(files));
console.log(`Created ${path.relative(ROOT, output)} (${files.length} files)`);
