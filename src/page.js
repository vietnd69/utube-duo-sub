/**
 * @file Page-world (MAIN) script of YouTube Duo Sub.
 *
 * Responsibilities:
 *  1. Observe the timed-text requests made by YouTube's player so the
 *     session parameters (proof-of-origin token, client info) can be reused.
 *  2. Download the primary and secondary subtitle tracks as json3.
 *  3. Render both lines in an overlay that copies the computed style of
 *     YouTube's own captions, so the user's caption settings (font, colour,
 *     background, edge, size) apply to both lines.
 *  4. Offer an in-player menu built from YouTube's own menu classes.
 *
 * Settings are validated and persisted by the isolated-world bridge
 * (src/bridge.js); the two worlds talk through window.postMessage. Nothing
 * is shown until the bridge has delivered the settings.
 *
 * Note: Chrome injects a given file only once per page, even when two
 * content_scripts entries list it for different worlds, so this world does
 * not load src/settings.js.
 */
(function () {
  'use strict';

  const LOADED_FLAG = Symbol.for('duosub.page.loaded');
  if (/** @type {any} */ (window)[LOADED_FLAG]) {
    return;
  }
  Object.defineProperty(window, LOADED_FLAG, { value: true });

  const Core = /** @type {any} */ (globalThis).DuoSubCore;
  if (!Core) {
    return;
  }

  const MSG_FROM_PAGE = 'duosub-page';
  const MSG_FROM_BRIDGE = 'duosub-bridge';
  const SYNC_INTERVAL_MS = 300;
  const RETRY_DELAY_MS = 5000;
  const CUE_CACHE_LIMIT = 40;
  const SIZE_STEPS = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** The page's fetch, captured before any hook so our own requests are not observed. */
  const nativeFetch = window.fetch.bind(window);

  // ---------------------------------------------------------------------------
  // Localisation
  // ---------------------------------------------------------------------------

  const STRINGS = Object.freeze({
    en: {
      button: 'Dual subtitles',
      duo: 'Dual subtitles',
      primary: 'Primary subtitles',
      secondary: 'Secondary subtitles',
      size: 'Secondary font size',
      position: 'Secondary position',
      below: 'Below',
      above: 'Above',
      auto: 'Auto',
      off: 'Off',
      autoTranslate: 'Auto-translate',
      none: 'None',
      back: 'Back',
      ccOff: 'Turn on subtitles (CC) to choose tracks',
      noTracks: 'This video has no subtitles'
    },
    vi: {
      button: 'Phụ đề kép',
      duo: 'Phụ đề kép',
      primary: 'Phụ đề chính',
      secondary: 'Phụ đề phụ',
      size: 'Cỡ chữ phụ đề phụ',
      position: 'Vị trí phụ đề phụ',
      below: 'Bên dưới',
      above: 'Bên trên',
      auto: 'Tự động',
      off: 'Tắt',
      autoTranslate: 'Tự động dịch',
      none: 'Không có',
      back: 'Quay lại',
      ccOff: 'Bật phụ đề (CC) để chọn phụ đề',
      noTracks: 'Video này không có phụ đề'
    }
  });

  const uiLang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
  const L = uiLang.startsWith('vi') ? STRINGS.vi : STRINGS.en;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /**
   * @typedef {Object} TrackState
   * @property {string} key      Core.trackKey of the requested track ('' if none).
   * @property {any}    ref      TrackRef or null.
   * @property {import('./core.js').Cue[] | null} cues Loaded cues, null while loading.
   * @property {number} retryAt  Earliest time a failed load may be retried.
   */

  /** @returns {TrackState} */
  const emptyTrack = () => ({ key: '', ref: null, cues: null, retryAt: 0 });

  const state = {
    /** Sanitised settings from the bridge; null until they arrive. @type {import('./settings.js').DuoSubSettings | null} */
    settings: null,
    videoId: '',
    /** Latest player-made timed-text URL per video id. @type {Map<string, string>} */
    captures: new Map(),
    /** @type {Map<string, Promise<import('./core.js').Cue[]>>} */
    cueCache: new Map(),
    primary: emptyTrack(),
    secondary: emptyTrack(),
    /** Style copied from a native caption, or null. @type {any} */
    nativeStyle: null,
    styleKey: '',
    active: false,
    /** @type {HTMLVideoElement | null} */
    video: null,
    syncQueued: false
  };

  const ui = {
    /** @type {HTMLElement | null} */ player: null,
    /** @type {HTMLElement | null} */ overlay: null,
    /** @type {HTMLElement | null} */ primaryEl: null,
    /** @type {HTMLElement | null} */ secondaryEl: null,
    /** @type {HTMLButtonElement | null} */ button: null,
    /** @type {HTMLElement | null} */ menu: null,
    /** Stack of panel builders for back navigation. @type {Array<() => HTMLElement>} */
    panels: []
  };

  // ---------------------------------------------------------------------------
  // Timed-text request capture
  // ---------------------------------------------------------------------------

  /**
   * Remembers a timed-text URL requested by the player.
   * @param {unknown} rawUrl
   */
  function observeRequest(rawUrl) {
    if (!rawUrl) {
      return;
    }
    const url = String(rawUrl);
    if (!url.includes('/api/timedtext')) {
      return;
    }
    const info = Core.parseTimedtextUrl(url, location.href);
    if (!info || !info.videoId) {
      return;
    }
    const absolute = new URL(url, location.href).toString();
    if (state.captures.get(info.videoId) !== absolute) {
      state.captures.set(info.videoId, absolute);
      // New session parameters: allow failed tracks to be retried right away.
      state.primary.retryAt = 0;
      state.secondary.retryAt = 0;
      queueSync();
    }
  }

  window.fetch = function duoSubFetch(input, init) {
    try {
      observeRequest(typeof input === 'string' || input instanceof URL ? input : input && input.url);
    } catch (_err) {
      // Observation must never break the page.
    }
    return nativeFetch(input, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function duoSubOpen(/** @type {any[]} */ ...args) {
    try {
      observeRequest(args[1]);
    } catch (_err) {
      // Observation must never break the page.
    }
    return nativeOpen.apply(this, /** @type {any} */ (args));
  };

  /**
   * Recovers a timed-text URL from Resource Timing when the request happened
   * before our hooks were installed.
   * @param {string} videoId
   */
  function recoverCapture(videoId) {
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name;
        if (name.includes('/api/timedtext') && name.includes(`v=${videoId}`) && name.includes('pot=')) {
          observeRequest(name);
          return;
        }
      }
    } catch (_err) {
      // Resource Timing unavailable.
    }
  }

  // ---------------------------------------------------------------------------
  // Player access
  // ---------------------------------------------------------------------------

  /** @returns {any} YouTube's player element (with its API methods), or null. */
  function getPlayer() {
    const player = document.getElementById('movie_player');
    return player && typeof (/** @type {any} */ (player)).getVideoData === 'function' ? player : null;
  }

  /**
   * @param {any} player
   * @returns {string}
   */
  function getVideoId(player) {
    try {
      const data = player.getVideoData();
      return (data && data.video_id) || '';
    } catch (_err) {
      return '';
    }
  }

  /**
   * Whether YouTube's captions are switched on.
   * @param {any} player
   * @returns {boolean}
   */
  function captionsOn(player) {
    const button = player.querySelector('.ytp-subtitles-button');
    if (button && button.hasAttribute('aria-pressed')) {
      return button.getAttribute('aria-pressed') === 'true';
    }
    const track = safeOption(player, 'track');
    return Boolean(track && track.languageCode);
  }

  /**
   * Reads a captions option from the player API.
   * @param {any} player
   * @param {string} name
   * @param {any} [arg]
   * @returns {any}
   */
  function safeOption(player, name, arg) {
    try {
      return arg === undefined ? player.getOption('captions', name) : player.getOption('captions', name, arg);
    } catch (_err) {
      return null;
    }
  }

  /**
   * Text of a YouTube "formatted string" ({simpleText} or {runs}).
   * @param {any} value
   * @returns {string}
   */
  function formattedText(value) {
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value.simpleText === 'string') {
      return value.simpleText;
    }
    if (Array.isArray(value.runs)) {
      return value.runs.map((/** @type {any} */ r) => r.text || '').join('');
    }
    return '';
  }

  /**
   * Caption tracks and translation languages of the current video.
   * @param {any} player
   * @param {string} videoId
   * @returns {{tracks: import('./core.js').CaptionTrack[], translationLanguages: import('./core.js').TranslationLanguage[]}}
   */
  function getCaptionData(player, videoId) {
    let response;
    try {
      response = player.getPlayerResponse();
    } catch (_err) {
      response = null;
    }
    if (!response || (response.videoDetails && response.videoDetails.videoId !== videoId)) {
      const initial = /** @type {any} */ (window).ytInitialPlayerResponse;
      response = initial && initial.videoDetails && initial.videoDetails.videoId === videoId ? initial : null;
    }
    const renderer = response && response.captions && response.captions.playerCaptionsTracklistRenderer;
    const tracks = (renderer && Array.isArray(renderer.captionTracks) ? renderer.captionTracks : []).map((/** @type {any} */ t) => ({
      languageCode: String(t.languageCode || ''),
      kind: t.kind === 'asr' ? 'asr' : '',
      name: formattedText(t.name) || String(t.languageCode || ''),
      vssId: String(t.vssId || ''),
      baseUrl: String(t.baseUrl || ''),
      isTranslatable: t.isTranslatable !== false
    })).filter((/** @type {any} */ t) => t.languageCode);
    const translationLanguages = (renderer && Array.isArray(renderer.translationLanguages) ? renderer.translationLanguages : [])
      .map((/** @type {any} */ l) => ({
        languageCode: String(l.languageCode || ''),
        name: formattedText(l.languageName) || String(l.languageCode || '')
      }))
      .filter((/** @type {any} */ l) => l.languageCode);
    return { tracks, translationLanguages };
  }

  /**
   * The subtitle YouTube is currently displaying.
   * @param {any} player
   * @param {string} videoId
   * @returns {any} TrackRef or null.
   */
  function getCurrentPrimary(player, videoId) {
    const track = safeOption(player, 'track');
    if (track && track.languageCode) {
      /** @type {any} */
      const ref = {
        lang: String(track.languageCode),
        kind: track.kind === 'asr' ? 'asr' : '',
        vssId: String(track.vss_id || track.vssId || '')
      };
      const tl = track.translationLanguage;
      if (tl && tl.languageCode) {
        ref.tlang = String(tl.languageCode);
      }
      return ref;
    }
    const captured = state.captures.get(videoId);
    const info = captured ? Core.parseTimedtextUrl(captured) : null;
    if (!info || !info.lang) {
      return null;
    }
    return info.tlang ? { lang: info.lang, kind: info.kind, tlang: info.tlang } : { lang: info.lang, kind: info.kind };
  }

  /**
   * Switches YouTube's own (primary) subtitle track.
   * @param {any} player
   * @param {{languageCode: string, kind: string, vssId: string}} track
   * @param {import('./core.js').TranslationLanguage | null} translation
   */
  function setPrimaryTrack(player, track, translation) {
    try {
      let list = safeOption(player, 'tracklist', { includeAsr: true });
      if (!Array.isArray(list) || !list.length) {
        player.loadModule('captions');
        list = safeOption(player, 'tracklist', { includeAsr: true }) || [];
      }
      const match = list.find((/** @type {any} */ t) => t.vss_id === track.vssId) ||
        list.find((/** @type {any} */ t) => t.languageCode === track.languageCode && (t.kind || '') === track.kind);
      const value = { ...(match || { languageCode: track.languageCode, kind: track.kind, vss_id: track.vssId }) };
      if (translation) {
        value.translationLanguage = { languageCode: translation.languageCode, languageName: translation.name };
      } else {
        delete value.translationLanguage;
      }
      player.setOption('captions', 'track', value);
    } catch (err) {
      console.warn('[Duo Sub] Could not change the primary subtitle:', err);
    }
  }

  /**
   * Turns YouTube's captions on through its own button.
   * @param {any} player
   */
  function ensureCaptionsOn(player) {
    if (captionsOn(player)) {
      return;
    }
    const button = /** @type {HTMLElement | null} */ (player.querySelector('.ytp-subtitles-button'));
    if (button && button.style.display !== 'none') {
      button.click();
    }
  }

  // ---------------------------------------------------------------------------
  // Track loading
  // ---------------------------------------------------------------------------

  /**
   * Downloads (or returns the cached) cues of a track.
   * @param {string} videoId
   * @param {any} ref TrackRef.
   * @param {import('./core.js').CaptionTrack[]} tracks
   * @returns {Promise<import('./core.js').Cue[]>}
   */
  function loadCues(videoId, ref, tracks) {
    const key = Core.trackKey(videoId, ref);
    const cached = state.cueCache.get(key);
    if (cached) {
      return cached;
    }
    const captured = state.captures.get(videoId);
    if (!captured) {
      return Promise.reject(new Error('No timed-text session for this video yet'));
    }
    const track = tracks.find((t) => ref.vssId && t.vssId === ref.vssId) ||
      tracks.find((t) => t.languageCode === ref.lang && t.kind === (ref.kind || ''));
    const url = Core.buildTrackUrl(captured, ref, track && track.baseUrl);
    const promise = nativeFetch(url, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.text();
      })
      .then((body) => {
        const cues = body ? Core.parseJson3(JSON.parse(body)) : [];
        if (!cues.length) {
          // An empty body usually means the session token was rejected.
          throw new Error('Empty subtitle response');
        }
        return cues;
      });
    promise.catch(() => state.cueCache.delete(key));
    state.cueCache.set(key, promise);
    if (state.cueCache.size > CUE_CACHE_LIMIT) {
      state.cueCache.delete(state.cueCache.keys().next().value);
    }
    return promise;
  }

  /**
   * Makes a track slot point at `ref`, loading its cues when it changes.
   * @param {'primary' | 'secondary'} slot
   * @param {string} videoId
   * @param {any} ref
   * @param {import('./core.js').CaptionTrack[]} tracks
   */
  function applyTrack(slot, videoId, ref, tracks) {
    const current = state[slot];
    const key = Core.trackKey(videoId, ref);
    const now = Date.now();
    if (key === current.key && (current.cues || current.retryAt === -1 || now < current.retryAt)) {
      return;
    }
    if (key !== current.key) {
      state[slot] = { key, ref, cues: null, retryAt: 0 };
    }
    if (!ref) {
      state[slot].cues = [];
      return;
    }
    state[slot].retryAt = -1; // loading
    loadCues(videoId, ref, tracks).then(
      (cues) => {
        if (state[slot].key === key) {
          state[slot].cues = cues;
          state[slot].retryAt = 0;
          queueSync();
        }
      },
      (err) => {
        if (state[slot].key === key) {
          state[slot].retryAt = Date.now() + RETRY_DELAY_MS;
          console.debug(`[Duo Sub] ${slot} subtitle not loaded:`, err && err.message);
        }
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Caption style (shared with YouTube's own caption settings)
  // ---------------------------------------------------------------------------

  /**
   * Copies the computed style of a native caption segment, which already
   * reflects every caption option the user picked in YouTube's settings.
   * @param {HTMLElement} player
   */
  function captureNativeStyle(player) {
    const segment = player.querySelector('.ytp-caption-window-container .ytp-caption-segment');
    if (!segment) {
      return;
    }
    const height = player.clientHeight;
    const cs = getComputedStyle(segment);
    const fontSize = parseFloat(cs.fontSize);
    if (!height || !fontSize) {
      return;
    }
    const win = segment.closest('.caption-window');
    state.nativeStyle = {
      fontSizeRatio: fontSize / height,
      fontFamily: cs.fontFamily,
      fontVariant: cs.fontVariant,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      windowColor: win ? getComputedStyle(win).backgroundColor : 'transparent',
      textShadow: cs.textShadow,
      padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`
    };
  }

  /**
   * YouTube's caption settings, used before any native caption is rendered.
   * @param {any} player
   * @returns {Record<string, unknown> | null}
   */
  function readUserCaptionSettings(player) {
    try {
      if (typeof player.getSubtitlesUserSettings === 'function') {
        const s = player.getSubtitlesUserSettings();
        if (s && typeof s === 'object') {
          return s;
        }
      }
    } catch (_err) {
      // Fall through to storage.
    }
    try {
      const raw = localStorage.getItem('yt-player-caption-display-settings');
      if (raw) {
        const outer = JSON.parse(raw);
        return typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data || null;
      }
    } catch (_err) {
      // Not available.
    }
    return null;
  }

  /**
   * Applies the shared caption style to the overlay when it changes.
   * @param {any} player
   */
  function updateStyle(player) {
    if (!state.settings) {
      return;
    }
    captureNativeStyle(player);
    const style = state.nativeStyle || Core.styleFromUserSettings(readUserCaptionSettings(player));
    const height = player.clientHeight || 360;
    const primarySize = Math.max(10, style.fontSizeRatio * height);
    const secondarySize = Math.max(8, primarySize * state.settings.sizeRatio);
    const key = JSON.stringify([style, primarySize, secondarySize]);
    if (key === state.styleKey || !ui.overlay) {
      return;
    }
    state.styleKey = key;
    const s = ui.overlay.style;
    s.setProperty('--duosub-primary-size', `${primarySize.toFixed(2)}px`);
    s.setProperty('--duosub-secondary-size', `${secondarySize.toFixed(2)}px`);
    s.setProperty('--duosub-font-family', style.fontFamily);
    s.setProperty('--duosub-font-variant', style.fontVariant);
    s.setProperty('--duosub-font-weight', style.fontWeight);
    s.setProperty('--duosub-font-style', style.fontStyle);
    s.setProperty('--duosub-color', style.color);
    s.setProperty('--duosub-background', style.backgroundColor);
    s.setProperty('--duosub-window', style.windowColor);
    s.setProperty('--duosub-text-shadow', style.textShadow);
    s.setProperty('--duosub-padding', style.padding);
  }

  /**
   * Keeps the overlay above the control bar, as YouTube does for captions.
   * @param {HTMLElement} player
   */
  function updateLayout(player) {
    if (!ui.overlay) {
      return;
    }
    let bottom = Math.max(8, player.clientHeight * 0.02);
    const chrome = player.querySelector('.ytp-chrome-bottom');
    const controlsShown = !player.classList.contains('ytp-autohide') && !player.classList.contains('ytp-hide-controls');
    if (chrome && controlsShown) {
      const playerRect = player.getBoundingClientRect();
      const chromeRect = chrome.getBoundingClientRect();
      if (chromeRect.height > 0) {
        bottom = Math.max(bottom, playerRect.bottom - chromeRect.top + 8);
      }
    }
    const value = `${Math.round(bottom)}px`;
    if (ui.overlay.style.bottom !== value) {
      ui.overlay.style.bottom = value;
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay rendering
  // ---------------------------------------------------------------------------

  /**
   * Creates an element with a class name.
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElementTagNameMap[K]}
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  /**
   * Ensures the overlay exists inside the player.
   * @param {HTMLElement} player
   */
  function ensureOverlay(player) {
    if (ui.overlay && ui.overlay.parentNode === player) {
      return;
    }
    if (!ui.overlay) {
      const overlay = el('div', 'duosub-overlay');
      overlay.setAttribute('aria-live', 'off');
      const box = el('div', 'duosub-window');
      ui.primaryEl = el('div', 'duosub-track duosub-primary');
      ui.secondaryEl = el('div', 'duosub-track duosub-secondary');
      box.append(ui.primaryEl, ui.secondaryEl);
      overlay.append(box);
      ui.overlay = overlay;
      state.styleKey = '';
    }
    player.appendChild(ui.overlay);
  }

  /**
   * Updates a track element only when its text changes.
   * @param {HTMLElement | null} node
   * @param {string} text
   */
  function renderText(node, text) {
    if (!node || node.dataset.text === text) {
      return;
    }
    node.dataset.text = text;
    node.replaceChildren(...text.split('\n').map((line) => {
      const row = el('div', 'duosub-line');
      row.append(el('span', 'duosub-segment', line));
      return row;
    }));
    node.hidden = text === '';
  }

  /** Per-frame text update; cheap thanks to binary search in Core.textAt. */
  function frame() {
    requestAnimationFrame(frame);
    if (!state.active || !state.video || !ui.overlay) {
      return;
    }
    const t = state.video.currentTime * 1000;
    const primary = Core.textAt(state.primary.cues || [], t);
    const secondary = Core.textAt(state.secondary.cues || [], t);
    renderText(ui.primaryEl, primary);
    renderText(ui.secondaryEl, secondary);
    ui.overlay.hidden = !primary && !secondary;
  }

  /**
   * Shows our overlay and hides YouTube's captions, or the reverse.
   * @param {HTMLElement | null} player
   * @param {boolean} active
   */
  function setActive(player, active) {
    state.active = active;
    if (player) {
      player.classList.toggle('duosub-active', active);
    }
    if (ui.overlay && state.settings) {
      ui.overlay.dataset.position = state.settings.position;
      if (!active) {
        ui.overlay.hidden = true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Main synchronisation loop
  // ---------------------------------------------------------------------------

  function queueSync() {
    if (state.syncQueued) {
      return;
    }
    state.syncQueued = true;
    setTimeout(() => {
      state.syncQueued = false;
      sync();
    }, 0);
  }

  /** Reconciles state with the player; runs periodically and on events. */
  function sync() {
    const player = getPlayer();
    if (!player || !state.settings) {
      return;
    }
    if (ui.player && ui.player !== player) {
      ui.player.classList.remove('duosub-active');
      closeMenu();
    }
    ui.player = player;
    ensureOverlay(player);
    ensureButton(player);
    state.video = player.querySelector('video');

    const videoId = getVideoId(player);
    if (videoId !== state.videoId) {
      state.videoId = videoId;
      state.primary = emptyTrack();
      state.secondary = emptyTrack();
      closeMenu();
    }

    updateStyle(player);
    updateLayout(player);
    if (ui.button) {
      ui.button.setAttribute('aria-pressed', String(state.settings.enabled));
    }

    if (!state.settings.enabled || !videoId || player.classList.contains('ad-showing') || !captionsOn(player)) {
      setActive(player, false);
      return;
    }
    if (!state.captures.has(videoId)) {
      recoverCapture(videoId);
    }
    const primaryRef = state.captures.has(videoId) ? getCurrentPrimary(player, videoId) : null;
    if (!primaryRef) {
      setActive(player, false);
      return;
    }

    const data = getCaptionData(player, videoId);
    applyTrack('primary', videoId, primaryRef, data.tracks);
    let secondaryRef = Core.resolveSecondary({
      tracks: data.tracks,
      translationLanguages: data.translationLanguages,
      primary: primaryRef,
      choice: state.settings.secondary,
      preferredLang: state.settings.preferredLang || navigator.language || 'en'
    });
    if (secondaryRef && Core.trackKey(videoId, secondaryRef) === Core.trackKey(videoId, primaryRef)) {
      secondaryRef = null;
    }
    applyTrack('secondary', videoId, secondaryRef, data.tracks);

    const ready = Boolean(state.primary.cues && state.primary.cues.length);
    setActive(player, ready);
  }

  // ---------------------------------------------------------------------------
  // In-player button and menu (YouTube's own menu markup and classes)
  // ---------------------------------------------------------------------------

  /** @returns {SVGSVGElement} Dual-caption icon in YouTube's 36x36 icon grid. */
  function createIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'ytp-svg-fill');
    path.setAttribute('fill', '#fff');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d',
      'M11 9h14a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V13a4 4 0 0 1 4-4zm0 2a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V13a2 2 0 0 0-2-2z' +
      'M11 14h14v3H11z' +
      'M13.5 20h9v2h-9z');
    svg.appendChild(path);
    return svg;
  }

  /**
   * Adds the Duo Sub button next to YouTube's subtitles button.
   * @param {HTMLElement} player
   */
  function ensureButton(player) {
    if (ui.button && player.contains(ui.button)) {
      return;
    }
    const controls = player.querySelector('.ytp-right-controls');
    if (!controls) {
      return;
    }
    const button = /** @type {HTMLButtonElement} */ (el('button', 'ytp-button duosub-button'));
    button.type = 'button';
    button.setAttribute('aria-label', L.button);
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-pressed', String(state.settings.enabled));
    button.title = L.button;
    button.appendChild(createIcon());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (ui.menu) {
        closeMenu();
      } else {
        openMenu(player);
      }
    });
    const subtitles = controls.querySelector('.ytp-subtitles-button');
    if (subtitles && subtitles.parentNode) {
      subtitles.parentNode.insertBefore(button, subtitles.nextSibling);
    } else {
      controls.insertBefore(button, controls.firstChild);
    }
    ui.button = button;
  }

  /**
   * Builds a YouTube-style menu item.
   * @param {Object} opts
   * @param {string} opts.label
   * @param {string} [opts.content]   Right-hand text (current value).
   * @param {'menuitem' | 'menuitemradio' | 'menuitemcheckbox'} [opts.role]
   * @param {boolean} [opts.checked]
   * @param {boolean} [opts.toggle]   Render a toggle switch.
   * @param {boolean} [opts.submenu]  Opens another panel.
   * @param {boolean} [opts.disabled]
   * @param {() => void} [opts.onSelect]
   * @returns {HTMLElement}
   */
  function menuItem(opts) {
    const role = opts.role || 'menuitem';
    const item = el('div', 'ytp-menuitem');
    item.setAttribute('role', role);
    item.tabIndex = opts.disabled ? -1 : 0;
    if (opts.submenu) {
      item.setAttribute('aria-haspopup', 'true');
    }
    if (role !== 'menuitem') {
      item.setAttribute('aria-checked', String(Boolean(opts.checked)));
    }
    if (opts.disabled) {
      item.setAttribute('aria-disabled', 'true');
      item.classList.add('duosub-disabled');
    }
    if (role === 'menuitemradio') {
      item.append(el('div', 'ytp-menuitem-icon duosub-check'));
    }
    item.append(el('div', 'ytp-menuitem-label', opts.label));
    const content = el('div', 'ytp-menuitem-content');
    if (opts.toggle) {
      content.append(el('div', 'ytp-menuitem-toggle-checkbox'));
    } else if (opts.content !== undefined) {
      content.textContent = opts.content;
    }
    item.append(content);
    if (opts.submenu) {
      item.classList.add('duosub-has-submenu');
    }
    const select = () => {
      if (!opts.disabled && opts.onSelect) {
        opts.onSelect();
      }
    };
    item.addEventListener('click', select);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
    return item;
  }

  /**
   * Builds a panel, optionally with a back header.
   * @param {string | null} title
   * @param {HTMLElement[]} items
   * @returns {HTMLElement}
   */
  function panel(title, items) {
    const root = el('div', 'ytp-panel duosub-panel');
    if (title !== null) {
      const header = el('div', 'duosub-header');
      const back = /** @type {HTMLButtonElement} */ (el('button', 'duosub-back'));
      back.type = 'button';
      back.setAttribute('aria-label', L.back);
      back.append(el('span', 'duosub-back-arrow'), el('span', 'duosub-title', title));
      back.addEventListener('click', popPanel);
      header.append(back);
      root.append(header);
    }
    const list = el('div', 'ytp-panel-menu');
    list.setAttribute('role', 'menu');
    list.append(...items);
    root.append(list);
    return root;
  }

  /** @param {() => HTMLElement} builder */
  function pushPanel(builder) {
    ui.panels.push(builder);
    renderPanel();
  }

  function popPanel() {
    if (ui.panels.length > 1) {
      ui.panels.pop();
    }
    renderPanel();
  }

  function renderPanel() {
    if (!ui.menu || !ui.panels.length) {
      return;
    }
    const build = ui.panels[ui.panels.length - 1];
    ui.menu.replaceChildren(build());
    const first = /** @type {HTMLElement | null} */ (ui.menu.querySelector('.duosub-back, .ytp-menuitem[aria-checked="true"], .ytp-menuitem'));
    if (first) {
      first.focus({ preventScroll: true });
    }
  }

  /**
   * Persists a settings change through the bridge, which validates it and
   * echoes the stored result back; the change is applied locally right away.
   * @param {Partial<import('./settings.js').DuoSubSettings>} patch
   */
  function saveSettings(patch) {
    state.settings = /** @type {import('./settings.js').DuoSubSettings} */ ({ ...state.settings, ...patch });
    window.postMessage({ source: MSG_FROM_PAGE, type: 'save', patch }, location.origin);
    state.styleKey = '';
    queueSync();
  }

  /**
   * Readable label of a track reference.
   * @param {any} ref
   * @param {ReturnType<typeof getCaptionData>} data
   * @returns {string}
   */
  function describeRef(ref, data) {
    if (!ref) {
      return L.none;
    }
    const track = data.tracks.find((t) => ref.vssId && t.vssId === ref.vssId) ||
      data.tracks.find((t) => t.languageCode === ref.lang && t.kind === (ref.kind || ''));
    const name = track ? track.name : ref.lang;
    if (!ref.tlang) {
      return name;
    }
    const target = data.translationLanguages.find((l) => l.languageCode === ref.tlang);
    return `${name} >> ${target ? target.name : ref.tlang}`;
  }

  /** @param {HTMLElement} player */
  function mainPanel(player) {
    const videoId = getVideoId(player);
    const data = getCaptionData(player, videoId);
    const on = captionsOn(player);
    const primaryRef = on ? getCurrentPrimary(player, videoId) : null;
    const choice = state.settings.secondary;
    const secondaryLabel = choice === 'auto'
      ? `${L.auto}${state.secondary.ref && on ? ` (${describeRef(state.secondary.ref, data)})` : ''}`
      : choice === 'off' ? L.off : secondaryChoiceLabel(choice, data);
    const items = [
      menuItem({
        label: L.duo,
        role: 'menuitemcheckbox',
        toggle: true,
        checked: state.settings.enabled,
        onSelect: () => {
          const enabled = !state.settings.enabled;
          saveSettings({ enabled });
          if (enabled) {
            ensureCaptionsOn(player);
          }
          renderPanel();
        }
      }),
      menuItem({
        label: L.primary,
        content: !data.tracks.length ? L.none : on ? describeRef(primaryRef, data) : L.off,
        submenu: true,
        disabled: !data.tracks.length,
        onSelect: () => pushPanel(() => primaryPanel(player))
      }),
      menuItem({
        label: L.secondary,
        content: secondaryLabel,
        submenu: true,
        onSelect: () => pushPanel(() => secondaryPanel(player))
      }),
      menuItem({
        label: L.size,
        content: `${Math.round(state.settings.sizeRatio * 100)}%`,
        submenu: true,
        onSelect: () => pushPanel(sizePanel)
      }),
      menuItem({
        label: L.position,
        content: state.settings.position === 'above' ? L.above : L.below,
        submenu: true,
        onSelect: () => pushPanel(positionPanel)
      })
    ];
    if (!data.tracks.length) {
      items.push(el('div', 'duosub-note', L.noTracks));
    } else if (!on) {
      items.push(el('div', 'duosub-note', L.ccOff));
    }
    return panel(null, items);
  }

  /**
   * Label of an explicit secondary choice ('en', 'en:asr').
   * @param {string} choice
   * @param {ReturnType<typeof getCaptionData>} data
   */
  function secondaryChoiceLabel(choice, data) {
    const asr = choice.endsWith(':asr');
    const code = asr ? choice.slice(0, -4) : choice;
    const track = data.tracks.find((t) => t.languageCode === code && (t.kind === 'asr') === asr);
    if (track) {
      return track.name;
    }
    const lang = data.translationLanguages.find((l) => l.languageCode === code);
    return lang ? lang.name : code;
  }

  /** @param {HTMLElement} player */
  function primaryPanel(player) {
    const videoId = getVideoId(player);
    const data = getCaptionData(player, videoId);
    const current = captionsOn(player) ? getCurrentPrimary(player, videoId) : null;
    const items = data.tracks.map((track) => menuItem({
      label: track.name,
      role: 'menuitemradio',
      checked: Boolean(current && !current.tlang &&
        (current.vssId ? current.vssId === track.vssId : current.lang === track.languageCode && current.kind === track.kind)),
      onSelect: () => {
        setPrimaryTrack(player, track, null);
        popPanel();
      }
    }));
    if (data.translationLanguages.length) {
      const target = current && current.tlang
        ? data.translationLanguages.find((l) => l.languageCode === current.tlang)
        : null;
      items.push(menuItem({
        label: L.autoTranslate,
        content: target ? target.name : current && current.tlang ? current.tlang : '',
        submenu: true,
        onSelect: () => pushPanel(() => primaryTranslatePanel(player))
      }));
    }
    return panel(L.primary, items);
  }

  /** @param {HTMLElement} player */
  function primaryTranslatePanel(player) {
    const videoId = getVideoId(player);
    const data = getCaptionData(player, videoId);
    const current = captionsOn(player) ? getCurrentPrimary(player, videoId) : null;
    const source = (current && data.tracks.find((t) => current.vssId ? t.vssId === current.vssId : t.languageCode === current.lang)) ||
      data.tracks.find((t) => t.isTranslatable) || data.tracks[0];
    const items = data.translationLanguages.map((lang) => menuItem({
      label: lang.name,
      role: 'menuitemradio',
      checked: Boolean(current && current.tlang === lang.languageCode),
      onSelect: () => {
        if (source) {
          setPrimaryTrack(player, source, lang);
        }
        ui.panels.splice(1);
        renderPanel();
      }
    }));
    return panel(L.autoTranslate, items);
  }

  /** @param {HTMLElement} player */
  function secondaryPanel(player) {
    const data = getCaptionData(player, getVideoId(player));
    const choice = state.settings.secondary;
    const choose = (/** @type {string} */ value) => {
      saveSettings({ secondary: value });
      popPanel();
    };
    const items = [
      menuItem({ label: L.auto, role: 'menuitemradio', checked: choice === 'auto', onSelect: () => choose('auto') }),
      menuItem({ label: L.off, role: 'menuitemradio', checked: choice === 'off', onSelect: () => choose('off') }),
      ...data.tracks.map((track) => {
        const value = track.kind === 'asr' ? `${track.languageCode}:asr` : track.languageCode;
        return menuItem({ label: track.name, role: 'menuitemradio', checked: choice === value, onSelect: () => choose(value) });
      })
    ];
    if (data.translationLanguages.length) {
      const translated = data.translationLanguages.find((l) => l.languageCode === choice);
      items.push(menuItem({
        label: L.autoTranslate,
        content: translated && !data.tracks.some((t) => t.languageCode === choice) ? translated.name : '',
        submenu: true,
        onSelect: () => pushPanel(() => secondaryTranslatePanel(player))
      }));
    }
    return panel(L.secondary, items);
  }

  /** @param {HTMLElement} player */
  function secondaryTranslatePanel(player) {
    const data = getCaptionData(player, getVideoId(player));
    const items = data.translationLanguages.map((lang) => menuItem({
      label: lang.name,
      role: 'menuitemradio',
      checked: state.settings.secondary === lang.languageCode,
      onSelect: () => {
        saveSettings({ secondary: lang.languageCode });
        ui.panels.splice(1);
        renderPanel();
      }
    }));
    return panel(L.autoTranslate, items);
  }

  function sizePanel() {
    return panel(L.size, SIZE_STEPS.map((ratio) => menuItem({
      label: `${Math.round(ratio * 100)}%`,
      role: 'menuitemradio',
      checked: Math.abs(state.settings.sizeRatio - ratio) < 0.001,
      onSelect: () => {
        saveSettings({ sizeRatio: ratio });
        popPanel();
      }
    })));
  }

  function positionPanel() {
    return panel(L.position, /** @type {const} */ (['below', 'above']).map((position) => menuItem({
      label: position === 'above' ? L.above : L.below,
      role: 'menuitemradio',
      checked: state.settings.position === position,
      onSelect: () => {
        saveSettings({ position });
        popPanel();
      }
    })));
  }

  /** @param {MouseEvent} event */
  function onDocumentClick(event) {
    const target = /** @type {Node} */ (event.target);
    if (ui.menu && !ui.menu.contains(target) && !(ui.button && ui.button.contains(target))) {
      closeMenu();
    }
  }

  /** @param {KeyboardEvent} event */
  function onMenuKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeMenu();
      if (ui.button) {
        ui.button.focus();
      }
    }
  }

  /** @param {HTMLElement} player */
  function openMenu(player) {
    closeMenu();
    const menu = el('div', 'ytp-popup ytp-settings-menu duosub-menu');
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', L.button);
    // Keep clicks and keys inside the menu from reaching the player
    // (play/pause, keyboard shortcuts).
    for (const type of ['click', 'dblclick', 'mousedown', 'keydown']) {
      menu.addEventListener(type, (event) => event.stopPropagation());
    }
    menu.addEventListener('keydown', onMenuKey, true);
    player.appendChild(menu);
    ui.menu = menu;
    ui.panels = [() => mainPanel(player)];
    renderPanel();
    if (ui.button) {
      ui.button.setAttribute('aria-expanded', 'true');
    }
    document.addEventListener('click', onDocumentClick, true);
  }

  function closeMenu() {
    if (ui.menu) {
      ui.menu.remove();
      ui.menu = null;
    }
    ui.panels = [];
    if (ui.button) {
      ui.button.setAttribute('aria-expanded', 'false');
    }
    document.removeEventListener('click', onDocumentClick, true);
  }

  // ---------------------------------------------------------------------------
  // Settings bridge
  // ---------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.source !== MSG_FROM_BRIDGE || data.type !== 'settings') {
      return;
    }
    if (!data.settings || typeof data.settings !== 'object') {
      return;
    }
    state.settings = data.settings;
    state.styleKey = '';
    if (ui.menu) {
      renderPanel();
    }
    queueSync();
  });

  window.postMessage({ source: MSG_FROM_PAGE, type: 'get' }, location.origin);

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  document.addEventListener('yt-navigate-finish', queueSync);
  document.addEventListener('fullscreenchange', queueSync);
  window.addEventListener('resize', queueSync);
  setInterval(sync, SYNC_INTERVAL_MS);
  requestAnimationFrame(frame);
})();
