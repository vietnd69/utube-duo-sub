'use strict';
/**
 * End-to-end check: loads the unpacked extension in Chromium, serves a mock
 * YouTube watch page plus a mock /api/timedtext endpoint, and verifies the
 * rendered dual subtitles and the controls added to YouTube's settings popup.
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
  'fr||': [[0, 3000, 'bonjour à tous'], [3000, 3000, 'bon retour']],
  'fr||vi': [[0, 3000, 'xin chào tất cả'], [3000, 3000, 'mừng bạn quay lại']]
};

/** @type {string[]} */
const requested = [];

/**
 * Settings popup item whose label is exactly `label`.
 * @param {import('playwright').Page} page
 * @param {string} label
 */
function menuItem(page, label) {
  return page.locator('.ytp-settings-menu .ytp-menuitem')
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

    // 4. Subtitles/CC panel: only a "Dual subtitles" switch is added, at the
    //    top, and it comes back when YouTube rebuilds the panel.
    await page.evaluate(() => window.showPanel('captions'));
    const firstItem = page.locator('.ytp-settings-menu .ytp-panel-menu .ytp-menuitem').first();
    await page.locator('.duosub-switch').waitFor();
    assert.equal(await firstItem.locator('.ytp-menuitem-label').textContent(), 'Phụ đề kép');
    assert.equal(await firstItem.getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('.duosub-switch .ytp-menuitem-toggle-checkbox').count(), 1);
    await page.evaluate(() => window.showPanel('captions'));
    await page.locator('.duosub-switch').waitFor();
    if (SHOT_DIR) {await page.locator('#movie_player').screenshot({ path: path.join(SHOT_DIR, 'duosub-menu.png') });}

    // The switch turns dual subtitles off (YouTube's captions come back) and on.
    await page.locator('.duosub-switch').click();
    await page.waitForFunction(() => !document.querySelector('#movie_player').classList.contains('duosub-active'));
    assert.equal(await page.locator('.duosub-switch').getAttribute('aria-checked'), 'false');
    await page.locator('.duosub-switch').click();
    await page.waitForFunction(() => document.querySelector('#movie_player').classList.contains('duosub-active'));

    // 5. The secondary is learned from track switches: the track the user
    //    switched away from becomes the secondary.
    await page.evaluate(() => { window.mockTrack = { languageCode: 'fr', kind: '', vss_id: '.fr' }; });
    await page.waitForFunction(() => document.querySelector('.duosub-primary')?.textContent === 'bon retour');
    await page.waitForFunction(() => document.querySelector('.duosub-secondary')?.textContent === 'mừng bạn quay lại');
    await page.evaluate(() => {
      window.mockTrack = { languageCode: 'en', kind: 'asr', vss_id: 'a.en', translationLanguage: { languageCode: 'ja', languageName: 'Japanese' } };
    });
    await page.waitForFunction(() => document.querySelector('.duosub-primary')?.textContent === 'おかえりなさい');
    await page.waitForFunction(() => document.querySelector('.duosub-secondary')?.textContent === 'bon retour');

    // Option sub-panels with a header button (e.g. Font size) get no switch.
    await page.evaluate(() => window.showPanel('fontsize'));
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.duosub-switch').count(), 0);

    // 6. Secondary size and position live in YouTube's caption Options panel,
    //    after YouTube's own options.
    await page.evaluate(() => window.showPanel('options'));
    await page.locator('.duosub-option').first().waitFor();
    const optionLabels = await page.locator('.ytp-settings-menu .ytp-panel-menu .ytp-menuitem-label').allTextContents();
    assert.deepEqual(optionLabels, ['Phông chữ', 'Màu phông chữ', 'Cỡ phông chữ', 'Cỡ chữ phụ đề phụ', 'Vị trí phụ đề phụ', 'Đặt lại']);
    await menuItem(page, 'Cỡ chữ phụ đề phụ').click();
    await page.locator('.duosub-panel').waitFor();
    assert.equal(await page.locator('.ytp-panel.duosub-covered').count(), 1);
    assert.equal(await page.locator('.duosub-panel .ytp-panel-title').textContent(), 'Cỡ chữ phụ đề phụ');
    if (SHOT_DIR) {await page.locator('#movie_player').screenshot({ path: path.join(SHOT_DIR, 'duosub-menu-size.png') });}
    await menuItem(page, '60%').click();
    await page.locator('.duosub-panel').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.ytp-panel.duosub-covered').count(), 0);
    assert.equal(await menuItem(page, 'Cỡ chữ phụ đề phụ').locator('.ytp-menuitem-content').textContent(), '60%');
    await menuItem(page, 'Vị trí phụ đề phụ').click();
    await menuItem(page, 'Bên trên').click();
    await page.locator('.duosub-panel').waitFor({ state: 'detached' });
    assert.equal(await menuItem(page, 'Vị trí phụ đề phụ').locator('.ytp-menuitem-content').textContent(), 'Bên trên');
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.duosub-secondary .duosub-segment')).fontSize) === 18);
    // Secondary rendered above the primary line.
    await page.waitForFunction(() => {
      const p = document.querySelector('.duosub-primary').getBoundingClientRect();
      const s = document.querySelector('.duosub-secondary').getBoundingClientRect();
      return s.bottom <= p.top;
    });

    // The picker's back button and closing the popup both drop the picker.
    await menuItem(page, 'Cỡ chữ phụ đề phụ').click();
    await page.locator('.duosub-panel .ytp-panel-back-button').click();
    await page.locator('.duosub-panel').waitFor({ state: 'detached' });
    await menuItem(page, 'Cỡ chữ phụ đề phụ').click();
    await page.evaluate(() => window.closeSettings());
    await page.waitForFunction(() => !document.querySelector('.duosub-panel') && !document.querySelector('.duosub-covered'));

    // 7. Settings persisted through the bridge into chrome.storage.
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
