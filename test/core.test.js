'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');
const { sanitizeSettings, sanitizePatch, DEFAULT_SETTINGS } = require('../src/settings.js');

/** @returns {import('../src/core.js').CaptionTrack} */
function track(languageCode, kind = '', extra = {}) {
  return {
    languageCode,
    kind,
    name: languageCode,
    vssId: `${kind === 'asr' ? 'a' : ''}.${languageCode}`,
    baseUrl: `https://www.youtube.com/api/timedtext?v=vid&lang=${languageCode}${kind ? '&kind=' + kind : ''}&signature=sig`,
    isTranslatable: true,
    ...extra
  };
}

const TRANSLATIONS = [
  { languageCode: 'en', name: 'English' },
  { languageCode: 'vi', name: 'Vietnamese' },
  { languageCode: 'ja', name: 'Japanese' },
  { languageCode: 'pt-BR', name: 'Portuguese (Brazil)' }
];

test('parseJson3 skips window events and whitespace-only segments', () => {
  const cues = core.parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 99999, id: 1, wpWinPosId: 1 },
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world', tOffsetMs: 300 }] },
      { tStartMs: 2000, dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 500, dDurationMs: 400, segs: [{ utf8: '\nFirst\n' }] },
      { tStartMs: 4000, segs: [{ utf8: 'no duration' }] }
    ]
  });
  assert.deepEqual(cues, [
    { start: 500, end: 900, text: 'First' },
    { start: 1000, end: 3000, text: 'Hello world' }
  ]);
});

test('parseJson3 tolerates malformed input', () => {
  assert.deepEqual(core.parseJson3(null), []);
  assert.deepEqual(core.parseJson3({ events: 'x' }), []);
  assert.deepEqual(core.parseJson3({ events: [null, { segs: [null] }] }), []);
});

test('textAt finds active cues and stacks overlapping ones', () => {
  const cues = core.parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'line one' }] },
      { tStartMs: 2500, dDurationMs: 5000, segs: [{ utf8: 'line two' }] },
      { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: 'later' }] }
    ]
  });
  assert.equal(core.textAt(cues, -1), '');
  assert.equal(core.textAt(cues, 1000), 'line one');
  assert.equal(core.textAt(cues, 3000), 'line one\nline two');
  assert.equal(core.textAt(cues, 5000), 'line two');
  assert.equal(core.textAt(cues, 8000), '');
  assert.equal(core.textAt(cues, 9500), 'later');
  assert.equal(core.textAt([], 0), '');
});

test('parseTimedtextUrl reads track identity', () => {
  assert.deepEqual(
    core.parseTimedtextUrl('/api/timedtext?v=abc&lang=en&kind=asr&tlang=vi&pot=x'),
    { videoId: 'abc', lang: 'en', kind: 'asr', tlang: 'vi' }
  );
  assert.equal(core.parseTimedtextUrl('/watch?v=abc'), null);
  assert.equal(core.parseTimedtextUrl('http://[bad'), null);
});

test('buildTrackUrl borrows session params but keeps the track signature', () => {
  const captured = 'https://www.youtube.com/api/timedtext?v=vid&lang=en&kind=asr&tlang=vi&fmt=srv3&name=x&pot=TOKEN&c=WEB&signature=other';
  const url = new URL(core.buildTrackUrl(captured, { lang: 'ja', kind: '', tlang: 'en' }, track('ja').baseUrl));
  assert.equal(url.searchParams.get('lang'), 'ja');
  assert.equal(url.searchParams.get('signature'), 'sig');
  assert.equal(url.searchParams.get('pot'), 'TOKEN');
  assert.equal(url.searchParams.get('c'), 'WEB');
  assert.equal(url.searchParams.get('tlang'), 'en');
  assert.equal(url.searchParams.get('fmt'), 'json3');
  assert.equal(url.searchParams.has('name'), false);
  assert.equal(url.searchParams.has('kind'), false);
});

test('buildTrackUrl rewrites the captured URL when no base URL is known', () => {
  const captured = '/api/timedtext?v=vid&lang=en&kind=asr&tlang=vi&name=x&pot=TOKEN';
  const url = new URL(core.buildTrackUrl(captured, { lang: 'en', kind: 'asr' }));
  assert.equal(url.searchParams.get('lang'), 'en');
  assert.equal(url.searchParams.get('kind'), 'asr');
  assert.equal(url.searchParams.has('tlang'), false);
  assert.equal(url.searchParams.has('name'), false);
  assert.equal(url.searchParams.get('pot'), 'TOKEN');
  assert.equal(url.searchParams.get('fmt'), 'json3');
});

test('auto secondary is the original language when the primary is auto-translated', () => {
  const tracks = [track('en'), track('en', 'asr'), track('fr')];
  const ref = core.resolveSecondary({
    tracks,
    translationLanguages: TRANSLATIONS,
    primary: { lang: 'en', kind: 'asr', vssId: 'a.en', tlang: 'vi' },
    choice: 'auto',
    preferredLang: 'vi'
  });
  assert.deepEqual(ref, { lang: 'en', kind: 'asr', vssId: 'a.en' });
});

test('auto secondary falls back to the preferred language, then English', () => {
  const tracks = [track('ja'), track('en')];
  const ctx = { tracks, translationLanguages: TRANSLATIONS, primary: { lang: 'ja', kind: '', vssId: '.ja' } };

  // Preferred language has no track: auto-translate the primary into it.
  assert.deepEqual(core.resolveSecondary({ ...ctx, choice: 'auto', preferredLang: 'vi' }),
    { lang: 'ja', kind: '', vssId: '.ja', tlang: 'vi' });

  // Preferred language equals the primary: use English (native track exists).
  assert.deepEqual(core.resolveSecondary({ ...ctx, choice: 'auto', preferredLang: 'ja-JP' }),
    { lang: 'en', kind: '', vssId: '.en' });

  // English primary and English preference: nothing sensible to add.
  assert.equal(core.resolveSecondary({
    tracks: [track('en')], translationLanguages: TRANSLATIONS,
    primary: { lang: 'en', kind: '' }, choice: 'auto', preferredLang: 'en-US'
  }), null);
});

test('explicit secondary prefers native tracks, honours :asr and translates otherwise', () => {
  const tracks = [track('en', 'asr'), track('en'), track('vi')];
  const ctx = { tracks, translationLanguages: TRANSLATIONS, primary: { lang: 'vi', kind: '', vssId: '.vi' }, preferredLang: '' };
  assert.deepEqual(core.resolveSecondary({ ...ctx, choice: 'en' }), { lang: 'en', kind: '', vssId: '.en' });
  assert.deepEqual(core.resolveSecondary({ ...ctx, choice: 'en:asr' }), { lang: 'en', kind: 'asr', vssId: 'a.en' });
  assert.deepEqual(core.resolveSecondary({ ...ctx, choice: 'pt' }), { lang: 'vi', kind: '', vssId: '.vi', tlang: 'pt-BR' });
  assert.equal(core.resolveSecondary({ ...ctx, choice: 'xx' }), null);
  assert.equal(core.resolveSecondary({ ...ctx, choice: 'off' }), null);
});

test('translation uses a translatable track when the primary source is not', () => {
  const tracks = [track('ko', '', { isTranslatable: false }), track('en')];
  const ref = core.resolveSecondary({
    tracks, translationLanguages: TRANSLATIONS,
    primary: { lang: 'ko', kind: '' }, choice: 'ja', preferredLang: ''
  });
  assert.deepEqual(ref, { lang: 'en', kind: '', vssId: '.en', tlang: 'ja' });
});

test('findTrack matches base language when the exact code is missing', () => {
  assert.equal(core.findTrack([track('pt-BR')], 'pt').languageCode, 'pt-BR');
  assert.equal(core.findTrack([track('en')], 'fr'), null);
});

test('styleFromUserSettings maps YouTube caption settings', () => {
  const def = core.styleFromUserSettings(undefined);
  assert.equal(def.color, 'rgba(255, 255, 255, 1)');
  assert.equal(def.backgroundColor, 'rgba(8, 8, 8, 0.75)');
  assert.equal(def.windowColor, 'rgba(8, 8, 8, 0)');
  assert.equal(def.textShadow, 'none');

  const custom = core.styleFromUserSettings({
    color: '#ff0', textOpacity: 0.5, fontFamily: 7, fontSizeIncrement: 2, charEdgeStyle: 3,
    background: '#000000', backgroundOpacity: 0, windowColor: '#00f', windowOpacity: 1
  });
  assert.equal(custom.color, 'rgba(255, 255, 0, 0.5)');
  assert.equal(custom.fontVariant, 'small-caps');
  assert.ok(Math.abs(custom.fontSizeRatio - def.fontSizeRatio * 2) < 1e-9);
  assert.match(custom.textShadow, /#222/);
  assert.equal(custom.backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(custom.windowColor, 'rgba(0, 0, 255, 1)');
});

test('trackKey is stable and empty for no track', () => {
  assert.equal(core.trackKey('v', null), '');
  assert.equal(core.trackKey('v', { lang: 'en', kind: 'asr', tlang: 'vi' }), 'v||en|asr|vi');
});

test('sanitizeSettings validates every field', () => {
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(sanitizeSettings({
    enabled: false, secondary: 'pt-BR', preferredLang: 'vi', sizeRatio: 0.6, position: 'above', extra: 1
  }), { enabled: false, secondary: 'pt-BR', preferredLang: 'vi', sizeRatio: 0.6, position: 'above' });
  assert.equal(sanitizeSettings({ secondary: 'en:asr' }).secondary, 'en:asr');
  assert.equal(sanitizeSettings({ secondary: '<script>' }).secondary, 'auto');
  assert.equal(sanitizeSettings({ preferredLang: 'en:asr' }).preferredLang, '');
  assert.equal(sanitizeSettings({ sizeRatio: 5 }).sizeRatio, 0.95);
  assert.equal(sanitizeSettings({ sizeRatio: 'x' }).sizeRatio, 0.75);
  assert.equal(sanitizeSettings({ position: 'left' }).position, 'below');
});

test('sanitizePatch keeps only the provided keys', () => {
  assert.deepEqual(sanitizePatch({ position: 'above' }), { position: 'above' });
  assert.deepEqual(sanitizePatch({ sizeRatio: 2, junk: true }), { sizeRatio: 0.95 });
  assert.deepEqual(sanitizePatch({ secondary: 'javascript:' }), { secondary: 'auto' });
  assert.deepEqual(sanitizePatch(null), {});
});
