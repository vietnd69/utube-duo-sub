/**
 * @file Pure logic for YouTube Duo Sub: timed-text parsing, track
 * resolution, URL building and caption style mapping.
 *
 * Nothing in this file touches the DOM, so it is fully unit-tested in
 * Node (see test/core.test.js) and reused unchanged by the page script.
 */
(function (root) {
  'use strict';

  /**
   * A single subtitle cue.
   * @typedef {Object} Cue
   * @property {number} start Start time in milliseconds.
   * @property {number} end   End time in milliseconds (exclusive).
   * @property {string} text  Text, lines separated by '\n'.
   */

  /**
   * A caption track as described by YouTube's player response.
   * @typedef {Object} CaptionTrack
   * @property {string}  languageCode ISO 639 / BCP 47 code, e.g. 'en', 'pt-BR'.
   * @property {string}  kind         'asr' for auto-generated tracks, '' otherwise.
   * @property {string}  name         Human readable name.
   * @property {string}  vssId        YouTube id, e.g. '.en' or 'a.en'.
   * @property {string}  baseUrl      Signed timed-text URL for this track.
   * @property {boolean} isTranslatable Whether YouTube can auto-translate it.
   */

  /**
   * A translation target offered by YouTube.
   * @typedef {Object} TranslationLanguage
   * @property {string} languageCode
   * @property {string} name
   */

  /**
   * Identifies what to download: a track, optionally auto-translated.
   * @typedef {Object} TrackRef
   * @property {string} lang       Source track language code.
   * @property {string} kind       'asr' or ''.
   * @property {string} [vssId]    YouTube track id when known.
   * @property {string} [tlang]    Auto-translation target, if any.
   */

  /** Maximum number of simultaneously visible lines (matches YouTube's ASR roll-up). */
  const MAX_ACTIVE_CUES = 3;

  /**
   * Parses YouTube's "json3" timed-text format into sorted cues.
   *
   * Events without segments are window/style definitions and are skipped,
   * as are events that only contain whitespace (ASR line-break markers).
   *
   * @param {unknown} data Parsed JSON body of a fmt=json3 response.
   * @returns {Cue[]}
   */
  function parseJson3(data) {
    const events = data && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).events)
      ? /** @type {any[]} */ (/** @type {any} */ (data).events)
      : [];
    /** @type {Cue[]} */
    const cues = [];
    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs)) {
        continue;
      }
      const text = ev.segs.map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : '')).join('');
      const clean = text.replace(/\r/g, '').replace(/^\n+|\n+$/g, '');
      if (!clean.trim()) {
        continue;
      }
      const start = Number(ev.tStartMs) || 0;
      const duration = Number(ev.dDurationMs) || 0;
      if (duration <= 0) {
        continue;
      }
      cues.push({ start, end: start + duration, text: clean });
    }
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    return cues;
  }

  /**
   * Returns the text visible at time `t`, joining overlapping cues the same
   * way YouTube stacks roll-up (auto-generated) captions.
   *
   * @param {Cue[]} cues Sorted cues.
   * @param {number} t   Current time in milliseconds.
   * @returns {string}   Visible text, or '' when nothing is shown.
   */
  function textAt(cues, t) {
    if (!cues.length) {
      return '';
    }
    // Binary search for the last cue whose start <= t.
    let lo = 0;
    let hi = cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    /** @type {string[]} */
    const active = [];
    // Overlaps are short-lived, so scanning a small window backwards is enough.
    for (let i = idx; i >= 0 && i > idx - 16 && active.length < MAX_ACTIVE_CUES; i--) {
      if (cues[i].end > t) {
        active.unshift(cues[i].text);
      }
    }
    return active.join('\n');
  }

  /**
   * Extracts the track identity from a timed-text request URL.
   *
   * @param {string} url  Absolute or relative /api/timedtext URL.
   * @param {string} [base] Base URL used to resolve relative URLs.
   * @returns {{videoId: string, lang: string, kind: string, tlang: string} | null}
   */
  function parseTimedtextUrl(url, base) {
    let u;
    try {
      u = new URL(url, base || 'https://www.youtube.com');
    } catch (_err) {
      return null;
    }
    if (!u.pathname.endsWith('/api/timedtext')) {
      return null;
    }
    const p = u.searchParams;
    return {
      videoId: p.get('v') || '',
      lang: p.get('lang') || '',
      kind: p.get('kind') || '',
      tlang: p.get('tlang') || ''
    };
  }

  /** Query parameters that describe the track itself and must not be copied between tracks. */
  const TRACK_PARAMS = new Set(['lang', 'kind', 'name', 'tlang', 'fmt']);

  /**
   * Builds the json3 URL for a track. YouTube protects timed-text with a
   * proof-of-origin token (`pot`) that only the player can mint, so all
   * session parameters are borrowed from a URL the player itself requested.
   *
   * @param {string} capturedUrl A timed-text URL requested by the player.
   * @param {TrackRef} ref       Track to download.
   * @param {string} [trackBaseUrl] The track's own signed `baseUrl`, if known.
   * @returns {string}
   */
  function buildTrackUrl(capturedUrl, ref, trackBaseUrl) {
    const captured = new URL(capturedUrl, 'https://www.youtube.com');
    let u;
    if (trackBaseUrl) {
      u = new URL(trackBaseUrl, captured.origin);
      for (const [key, value] of captured.searchParams) {
        if (!TRACK_PARAMS.has(key) && !u.searchParams.has(key)) {
          u.searchParams.set(key, value);
        }
      }
    } else {
      u = new URL(captured.toString());
      u.searchParams.delete('name');
      u.searchParams.set('lang', ref.lang);
      if (ref.kind) {
        u.searchParams.set('kind', ref.kind);
      } else {
        u.searchParams.delete('kind');
      }
    }
    if (ref.tlang) {
      u.searchParams.set('tlang', ref.tlang);
    } else {
      u.searchParams.delete('tlang');
    }
    u.searchParams.set('fmt', 'json3');
    return u.toString();
  }

  /**
   * Stable cache key for a track reference.
   * @param {string} videoId
   * @param {TrackRef | null} ref
   * @returns {string}
   */
  function trackKey(videoId, ref) {
    if (!ref) {
      return '';
    }
    return [videoId, ref.vssId || '', ref.lang, ref.kind || '', ref.tlang || ''].join('|');
  }

  /**
   * Primary language subtag of a BCP 47 code ('pt-BR' -> 'pt').
   * @param {string} code
   * @returns {string}
   */
  function baseLang(code) {
    return String(code || '').toLowerCase().split(/[-_]/)[0];
  }

  /**
   * Finds the best track for a language: exact code first, then the same
   * base language; manual tracks win over auto-generated ones unless
   * `preferAsr` is set.
   *
   * @param {CaptionTrack[]} tracks
   * @param {string} lang
   * @param {boolean} [preferAsr]
   * @returns {CaptionTrack | null}
   */
  function findTrack(tracks, lang, preferAsr) {
    const want = String(lang).toLowerCase();
    const rank = (/** @type {CaptionTrack} */ t) => {
      const code = t.languageCode.toLowerCase();
      const langScore = code === want ? 0 : baseLang(code) === baseLang(want) ? 2 : -1;
      if (langScore < 0) {
        return -1;
      }
      const isAsr = t.kind === 'asr';
      return langScore + (isAsr === Boolean(preferAsr) ? 0 : 1);
    };
    let best = null;
    let bestRank = Infinity;
    for (const t of tracks) {
      const r = rank(t);
      if (r >= 0 && r < bestRank) {
        best = t;
        bestRank = r;
      }
    }
    return best;
  }

  /**
   * Looks up the source track of the primary subtitle.
   * @param {CaptionTrack[]} tracks
   * @param {TrackRef} primary
   * @returns {CaptionTrack | null}
   */
  function findPrimarySource(tracks, primary) {
    if (primary.vssId) {
      const byId = tracks.find((t) => t.vssId === primary.vssId);
      if (byId) {
        return byId;
      }
    }
    return tracks.find((t) => t.languageCode === primary.lang && (t.kind || '') === (primary.kind || '')) ||
      findTrack(tracks, primary.lang, primary.kind === 'asr');
  }

  /**
   * Converts a track to a reference.
   * @param {CaptionTrack} track
   * @param {string} [tlang]
   * @returns {TrackRef}
   */
  function refFromTrack(track, tlang) {
    /** @type {TrackRef} */
    const ref = { lang: track.languageCode, kind: track.kind || '', vssId: track.vssId };
    if (tlang) {
      ref.tlang = tlang;
    }
    return ref;
  }

  /**
   * Resolves a target language to a downloadable reference: a native track
   * in that language if the video has one, otherwise an auto-translation of
   * the primary's source track.
   *
   * @param {Object} ctx
   * @param {CaptionTrack[]} ctx.tracks
   * @param {TranslationLanguage[]} ctx.translationLanguages
   * @param {TrackRef} ctx.primary
   * @param {string} target Language code, optionally suffixed with ':asr'.
   * @returns {TrackRef | null}
   */
  function resolveLanguage(ctx, target) {
    const wantsAsr = target.endsWith(':asr');
    const lang = wantsAsr ? target.slice(0, -4) : target;
    const track = findTrack(ctx.tracks, lang, wantsAsr);
    if (track) {
      return refFromTrack(track);
    }
    const source = findPrimarySource(ctx.tracks, ctx.primary);
    const translatable = source && source.isTranslatable !== false
      ? source
      : ctx.tracks.find((t) => t.isTranslatable !== false) || null;
    if (!translatable) {
      return null;
    }
    const exact = ctx.translationLanguages.find((l) => l.languageCode.toLowerCase() === lang.toLowerCase());
    const loose = exact || ctx.translationLanguages.find((l) => baseLang(l.languageCode) === baseLang(lang));
    // An empty list means we could not read it; let YouTube decide.
    const tlang = loose ? loose.languageCode : ctx.translationLanguages.length ? '' : lang;
    return tlang ? refFromTrack(translatable, tlang) : null;
  }

  /**
   * Decides which secondary subtitle to show.
   *
   * - 'off': none.
   * - 'auto': when the primary is auto-translated, the original (source)
   *   language; otherwise the preferred language, or English if the
   *   preferred language is already the primary one.
   * - '<code>' / '<code>:asr': that language (native track or translation).
   *
   * @param {Object} ctx
   * @param {CaptionTrack[]} ctx.tracks
   * @param {TranslationLanguage[]} ctx.translationLanguages
   * @param {TrackRef} ctx.primary   Currently displayed primary subtitle.
   * @param {string} ctx.choice      Setting value ('auto', 'off', code).
   * @param {string} ctx.preferredLang Fallback language for 'auto'.
   * @returns {TrackRef | null}
   */
  function resolveSecondary(ctx) {
    const { primary, choice } = ctx;
    if (!primary || choice === 'off') {
      return null;
    }
    if (choice !== 'auto') {
      return resolveLanguage(ctx, choice);
    }
    if (primary.tlang) {
      const source = findPrimarySource(ctx.tracks, primary);
      return source ? refFromTrack(source) : { lang: primary.lang, kind: primary.kind || '' };
    }
    const shown = baseLang(primary.lang);
    const candidates = [ctx.preferredLang, 'en'].filter((c) => c && baseLang(c) !== shown);
    for (const candidate of candidates) {
      const ref = resolveLanguage(ctx, candidate);
      if (ref) {
        return ref;
      }
    }
    return null;
  }

  /**
   * Font family stacks used by YouTube for each caption font setting.
   * @type {Readonly<Record<number, string>>}
   */
  const FONT_FAMILIES = Object.freeze({
    1: '"Courier New", Courier, "Nimbus Mono L", "Cutive Mono", monospace',
    2: '"Times New Roman", Times, Georgia, Cambria, "PT Serif Caption", serif',
    3: '"Deja Vu Sans Mono", "Lucida Console", Monaco, Consolas, "PT Mono", monospace',
    4: '"YouTube Noto", Roboto, Arial, Helvetica, Verdana, "PT Sans Caption", sans-serif',
    5: '"Comic Sans MS", Impact, Handlee, fantasy',
    6: '"Monotype Corsiva", "URW Chancery L", "Apple Chancery", "Dancing Script", cursive',
    7: 'Arial, Helvetica, Verdana, "Marcellus SC", sans-serif'
  });

  /** Font scale for YouTube's fontSizeIncrement (-2 = 50% ... 4 = 400%). */
  const FONT_SCALE = Object.freeze({ '-2': 0.5, '-1': 0.75, 0: 1, 1: 1.5, 2: 2, 3: 3, 4: 4 });

  /** Text shadows for YouTube's charEdgeStyle values. */
  const EDGE_SHADOWS = Object.freeze({
    0: 'none',
    1: '0.05em 0.05em 0 rgba(34,34,34,0.75), 0.1em 0.1em 0 rgba(34,34,34,0.75)',
    2: '0.05em 0.05em 0 rgba(204,204,204,0.5), -0.05em -0.05em 0 rgba(34,34,34,0.75)',
    3: '0 0 0.06em #222, 0 0 0.06em #222, 0 0 0.06em #222, 0 0 0.06em #222',
    4: '0.08em 0.08em 0.12em rgba(34,34,34,0.8)'
  });

  /**
   * Converts '#rgb' / '#rrggbb' plus opacity to an rgba() string.
   * @param {unknown} hex
   * @param {unknown} opacity 0..1
   * @param {string} fallback
   * @returns {string}
   */
  function toRgba(hex, opacity, fallback) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) {
      return fallback;
    }
    let h = m[1];
    if (h.length === 3) {
      h = h.split('').map((c) => c + c).join('');
    }
    const n = parseInt(h, 16);
    const a = Number.isFinite(Number(opacity)) ? Math.min(1, Math.max(0, Number(opacity))) : 1;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  /**
   * Caption style shared by both subtitle lines.
   * @typedef {Object} CaptionStyle
   * @property {number} fontSizeRatio Primary font size divided by player height.
   * @property {string} fontFamily
   * @property {string} fontVariant
   * @property {string} fontWeight
   * @property {string} fontStyle
   * @property {string} color
   * @property {string} backgroundColor  Behind each text run.
   * @property {string} windowColor      Behind the whole caption block.
   * @property {string} textShadow
   * @property {string} padding
   */

  /**
   * Maps YouTube's caption user settings (player.getSubtitlesUserSettings()
   * or the 'yt-player-caption-display-settings' storage entry) to a style.
   * Used only until a native caption has been rendered, after which its
   * computed style is copied verbatim.
   *
   * @param {Record<string, unknown> | null | undefined} us
   * @returns {CaptionStyle}
   */
  function styleFromUserSettings(us) {
    const s = us || {};
    const family = Number(s.fontFamily) || 4;
    const increment = String(Number(s.fontSizeIncrement) || 0);
    const scale = FONT_SCALE[/** @type {keyof typeof FONT_SCALE} */ (increment)] || 1;
    const edge = Number(s.charEdgeStyle) || 0;
    return {
      // Approximation of YouTube's sizing: ~20px on a 480px tall player at 100%.
      fontSizeRatio: 0.0417 * scale,
      fontFamily: FONT_FAMILIES[family] || FONT_FAMILIES[4],
      fontVariant: family === 7 ? 'small-caps' : 'normal',
      fontWeight: 'normal',
      fontStyle: 'normal',
      color: toRgba(s.color || '#fff', s.textOpacity ?? 1, 'rgb(255, 255, 255)'),
      backgroundColor: toRgba(s.background || '#080808', s.backgroundOpacity ?? 0.75, 'rgba(8, 8, 8, 0.75)'),
      windowColor: toRgba(s.windowColor || '#080808', s.windowOpacity ?? 0, 'rgba(8, 8, 8, 0)'),
      textShadow: EDGE_SHADOWS[/** @type {keyof typeof EDGE_SHADOWS} */ (edge)] || 'none',
      padding: '0 0.25em'
    };
  }

  const api = Object.freeze({
    parseJson3,
    textAt,
    parseTimedtextUrl,
    buildTrackUrl,
    trackKey,
    baseLang,
    findTrack,
    resolveSecondary,
    styleFromUserSettings,
    toRgba
  });

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DuoSubCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
