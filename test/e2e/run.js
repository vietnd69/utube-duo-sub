'use strict';
/**
 * End-to-end check: loads the unpacked extension in Chromium, serves a mock
 * YouTube watch page plus a mock /api/timedtext endpoint, and verifies the
 * rendered dual subtitles and the in-player menu.
 *
 * Usage: node test/e2e/run.js [screenshotDir]
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const MOCK_PAGE = fs.readFileSync(path.join(__dirname, 'mock-watch.html'), 'utf8');
const SHOT_DIR = process.argv[2] || '';

const CUES = {
  'en|asr|': [[0, 3000, 'hello everyone'], [3000, 3000, 'welcome back']],
  'en|asr|vi': [[0, 3000, 'xin chào mọi người'], [3000, 3000, 'chào mừng trở lại']],
  'en|asr|ja': [[0, 3000, 'みなさんこんにちは'], [3000, 3000, 'おかえりなさい']],
  'fr||': [[0, 3000, 'bonjour à tous'], [3000, 3000, 'bon retour']]
};

/** @type {string[]} */
const requested = [];

/**
 * Menu item whose label is exactly `label`.
 * @param {import('playwright').Page} page
 * @param {string} label
 */
function menuItem(page, label) {
  return page.locator('.duosub-menu .ytp-menuitem')
    .filter({ has: page.locator('.ytp-menuitem-label').getByText(label, { exact: true }) });
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duosub-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium', // New headless mode; the headless shell cannot load extensions.
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    viewport: { width: 1000, height: 600 }
  });
  try {
    await context.route('https://www.youtube.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/watch') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_PAGE });
      }
      if (url.pathname === '/api/timedtext') {
        requested.push(url.search);
        const p = url.searchParams;
        const cues = p.get('pot') === 'POT_TOKEN' ? CUES[`${p.get('lang')}|${p.get('kind') || ''}|${p.get('tlang') || ''}`] : null;
        const body = cues ? JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 999999, wpWinPosId: 1 },
          ...cues.map(([tStartMs, dDurationMs, utf8]) => ({ tStartMs, dDurationMs, segs: [{ utf8 }] }))] }) : '';
        return route.fulfill({ status: 200, contentType: 'application/json', body });
      }
      return route.fulfill({ status: 404, body: '' });
    });

    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') {console.log('[page error]', m.text());} });
    page.on('pageerror', (e) => console.log('[page exception]', e.message));
    await page.goto('https://www.youtube.com/watch?v=test123');

    const overlay = page.locator('.duosub-overlay');
    await page.waitForFunction(() => document.querySelector('.duosub-primary')?.textContent === 'xin chào mọi người', null, { timeout: 5000 });

    // 1. Auto-translated primary (vi) => secondary defaults to the original (en).
    assert.equal(await page.locator('.duosub-primary').textContent(), 'xin chào mọi người');
    assert.equal(await page.locator('.duosub-secondary').textContent(), 'hello everyone');
    assert.ok(await page.locator('#movie_player.duosub-active').count(), 'native captions hidden');
    assert.equal(await page.locator('.ytp-caption-window-container').evaluate((n) => getComputedStyle(n).visibility), 'hidden');

    // 2. Both lines reuse YouTube's caption style; the secondary is smaller.
    const style = await page.evaluate(() => {
      const seg = (sel) => getComputedStyle(document.querySelector(`${sel} .duosub-segment`));
      const p = seg('.duosub-primary');
      const s = seg('.duosub-secondary');
      return { pSize: parseFloat(p.fontSize), sSize: parseFloat(s.fontSize), color: p.color, sColor: s.color,
        family: p.fontFamily, bg: p.backgroundColor, shadow: p.textShadow };
    });
    assert.equal(style.pSize, 30);
    assert.equal(style.sSize, 22.5);
    assert.equal(style.color, 'rgb(255, 255, 0)');
    assert.equal(style.sColor, 'rgb(255, 255, 0)');
    assert.match(style.family, /Courier New/);
    assert.equal(style.bg, 'rgba(8, 8, 8, 0.75)');
    assert.match(style.shadow, /rgb\(34, 34, 34\)/);
    assert.ok(requested.every((q) => q.includes('pot=POT_TOKEN') && q.includes('fmt=json3')));
    if (SHOT_DIR) {await page.locator('#movie_player').screenshot({ path: path.join(SHOT_DIR, 'duosub-overlay.png') });}

    // 3. Time advances.
    await page.evaluate(() => { window.mockTime = 4; });
    await page.waitForFunction(() => document.querySelector('.duosub-secondary')?.textContent === 'welcome back');
    assert.equal(await page.locator('.duosub-primary').textContent(), 'chào mừng trở lại');

    // 4. In-player menu: choose French as secondary.
    await page.locator('.duosub-button').click();
    await page.locator('.duosub-menu').waitFor();
    const mainLabels = await page.locator('.duosub-menu .ytp-menuitem-label').allTextContents();
    assert.deepEqual(mainLabels, ['Phụ đề kép', 'Phụ đề chính', 'Phụ đề phụ', 'Cỡ chữ phụ đề phụ', 'Vị trí phụ đề phụ']);
    assert.equal(await page.locator('.duosub-menu .ytp-menuitem').nth(1).locator('.ytp-menuitem-content').textContent(),
      'English (auto-generated) >> Vietnamese');
    if (SHOT_DIR) {await page.locator('#movie_player').screenshot({ path: path.join(SHOT_DIR, 'duosub-menu.png') });}
    await menuItem(page, 'Phụ đề phụ').click();
    if (SHOT_DIR) {await page.locator('#movie_player').screenshot({ path: path.join(SHOT_DIR, 'duosub-menu-secondary.png') });}
    await menuItem(page, 'French').click();
    await page.waitForFunction(() => document.querySelector('.duosub-secondary')?.textContent === 'bon retour');

    // 5. Primary switched through the menu uses YouTube's own API.
    await menuItem(page, 'Phụ đề chính').click();
    await menuItem(page, 'Tự động dịch').click();
    await menuItem(page, 'Japanese').click();
    const call = await page.evaluate(() => window.setOptionCalls.at(-1));
    assert.equal(call.vss_id, 'a.en');
    assert.equal(call.translationLanguage.languageCode, 'ja');
    await page.waitForFunction(() => document.querySelector('.duosub-primary')?.textContent === 'おかえりなさい');

    // 6. Secondary size and position.
    await menuItem(page, 'Cỡ chữ phụ đề phụ').click();
    await menuItem(page, '60%').click();
    await menuItem(page, 'Vị trí phụ đề phụ').click();
    await menuItem(page, 'Bên trên').click();
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.duosub-secondary .duosub-segment')).fontSize) === 18);
    // Secondary rendered above the primary line.
    await page.waitForFunction(() => {
      const p = document.querySelector('.duosub-primary').getBoundingClientRect();
      const s = document.querySelector('.duosub-secondary').getBoundingClientRect();
      return s.bottom <= p.top;
    });

    // 7. Settings persisted through the bridge into chrome.storage.
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.duosub-menu').count(), 0);
    const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [null];
    const extPage = await context.newPage();
    const extId = await (async () => {
      await extPage.goto('chrome://extensions');
      return extPage.evaluate(() => new Promise((resolve) => chrome.management.getAll((all) =>
        resolve(all.find((e) => e.name === 'YouTube Duo Sub').id))));
    })();
    void worker;
    await extPage.goto(`chrome-extension://${extId}/popup/popup.html`);
    const stored = await extPage.evaluate(() => new Promise((r) => chrome.storage.sync.get(null, r)));
    assert.equal(stored.secondary, 'fr');
    assert.equal(stored.sizeRatio, 0.6);
    assert.equal(stored.position, 'above');
    assert.equal(await extPage.locator('#secondary').inputValue(), 'fr');
    if (SHOT_DIR) {await extPage.screenshot({ path: path.join(SHOT_DIR, 'duosub-popup.png') });}

    // 8. Turning the feature off from the popup restores YouTube's captions.
    await extPage.locator('#enabled').uncheck();
    await page.bringToFront();
    await page.waitForFunction(() => !document.querySelector('#movie_player').classList.contains('duosub-active'));
    assert.equal(await overlay.isHidden(), true);

    // 9. Captions turned off in YouTube: nothing is shown.
    await extPage.locator('#enabled').check();
    await page.waitForFunction(() => document.querySelector('#movie_player').classList.contains('duosub-active'));
    await page.evaluate(() => document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'false'));
    await page.waitForFunction(() => !document.querySelector('#movie_player').classList.contains('duosub-active'));

    console.log(`e2e ok (${requested.length} timed-text requests)`);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
