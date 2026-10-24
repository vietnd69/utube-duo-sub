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
 *  4. Add a "Secondary subtitles" picker to YouTube's own Subtitles/CC
 *     settings panel. The primary subtitle is whatever track YouTube shows.
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
  /** Back-off after HTTP 429; retrying sooner only keeps YouTube's limit in place. */
  const RATE_LIMIT_DELAY_MS = 30000;
  const RATE_LIMIT_MAX_DELAY_MS = 10 * 60 * 1000;
  const CUE_CACHE_LIMIT = 40;
  const SIZE_STEPS = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

  /** The page's fetch, captured before any hook so our own requests are not observed. */
  const nativeFetch = window.fetch.bind(window);

  // ---------------------------------------------------------------------------
  // Localisation
  // ---------------------------------------------------------------------------

  const STRINGS = Object.freeze({
    en: {
      duo: 'Dual subtitles',
      size: 'Secondary font size',
      position: 'Secondary position',
      below: 'Below',
      above: 'Above',
      back: 'Back to previous menu'
    },
    vi: {
      duo: 'Phụ đề kép',
      size: 'Cỡ chữ phụ đề phụ',
      position: 'Vị trí phụ đề phụ',
      below: 'Bên dưới',
      above: 'Bên trên',
      back: 'Quay lại trình đơn trước'
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
   * @property {number} failures Consecutive failed loads.
   * @property {boolean} limited Last failure was YouTube's rate limit (HTTP 429).
   */

  /** @returns {TrackState} */
  const emptyTrack = () => ({ key: '', ref: null, cues: null, retryAt: 0, failures: 0, limited: false });

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
    syncQueued: false,
    /** Last primary track seen, used to learn the secondary from track switches. @type {any} */
    lastPrimary: null,
    lastPrimaryVideo: ''
  };

  const ui = {
    /** @type {HTMLElement | null} */ player: null,
    /** @type {HTMLElement | null} */ overlay: null,
    /** @type {HTMLElement | null} */ primaryEl: null,
    /** @type {HTMLElement | null} */ secondaryEl: null,
    /** YouTube's settings popup being observed. @type {HTMLElement | null} */ observedMenu: null,
    /** @type {MutationObserver | null} */ observer: null,
    /** Choice list shown over a YouTube panel, while open. @type {HTMLElement | null} */ picker: null,
    /** YouTube panel hidden behind the picker. @type {HTMLElement | null} */ covered: null,
    /** data-duosub-option of the entry that opened the picker. */ pickerOrigin: ''
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
      // New session parameters: allow failed tracks to be retried right away,
      // unless YouTube is rate limiting them.
      for (const slot of [state.primary, state.secondary]) {
        if (!slot.limited) {
          slot.retryAt = 0;
        }
      }
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
          throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
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
   * An auto-translation of an auto-generated track comes as whole sentences;
   * reveal it with the rhythm of the source speech. The source track is
   * usually the secondary already (same cache key), so this rarely costs a
   * request. Without it the sentences show whole, as before.
   * @param {string} videoId
   * @param {any} ref
   * @param {import('./core.js').CaptionTrack[]} tracks
   * @param {import('./core.js').Cue[]} cues
   * @returns {Promise<import('./core.js').Cue[]>}
   */
  function paceTranslation(videoId, ref, tracks, cues) {
    if (!ref.tlang || ref.kind !== 'asr') {
      return Promise.resolve(cues);
    }
    const source = { lang: ref.lang, kind: 'asr', vssId: ref.vssId || '' };
    return loadCues(videoId, source, tracks).then((sourceCues) => Core.paceCues(cues, sourceCues), () => cues);
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
      state[slot] = { ...emptyTrack(), key, ref };
    }
    if (!ref) {
      state[slot].cues = [];
      return;
    }
    state[slot].retryAt = -1; // loading
    loadCues(videoId, ref, tracks).then((cues) => paceTranslation(videoId, ref, tracks, cues)).then(
      (cues) => {
        if (state[slot].key === key) {
          Object.assign(state[slot], { cues, retryAt: 0, failures: 0, limited: false });
          queueSync();
        }
      },
      (err) => {
        if (state[slot].key === key) {
          const track = state[slot];
          track.failures += 1;
          track.limited = Boolean(err && err.status === 429);
          const delay = track.limited
            ? Math.min(RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_DELAY_MS * 2 ** (track.failures - 1))
            : RETRY_DELAY_MS;
          track.retryAt = Date.now() + delay;
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

  /**
   * When the user switches YouTube's subtitle track within a video, the track
   * they switched away from becomes the secondary. The first track of each
   * video is only a baseline: YouTube may have picked it on its own.
   * @param {string} videoId
   * @param {any} primaryRef
   */
  function learnSecondary(videoId, primaryRef) {
    const choice = state.lastPrimaryVideo === videoId ? Core.inferSecondary(state.lastPrimary, primaryRef) : null;
    state.lastPrimary = primaryRef;
    state.lastPrimaryVideo = videoId;
    if (choice && choice !== state.settings.secondary) {
      saveSettings({ secondary: choice });
    }
  }

  /** Reconciles state with the player; runs periodically and on events. */
  function sync() {
    const player = getPlayer();
    if (!player || !state.settings) {
      return;
    }
    if (ui.player && ui.player !== player) {
      ui.player.classList.remove('duosub-active');
    }
    ui.player = player;
    ensureOverlay(player);
    ensureSettingsObserver(player);
    state.video = player.querySelector('video');

    const videoId = getVideoId(player);
    if (videoId !== state.videoId) {
      state.videoId = videoId;
      state.primary = emptyTrack();
      state.secondary = emptyTrack();
      closePicker(false);
    }

    updateStyle(player);
    updateLayout(player);
    refreshSettingsPanels(player);

    if (!state.settings.enabled || state.settings.secondary === 'off' || !videoId ||
        player.classList.contains('ad-showing') || !captionsOn(player)) {
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

    learnSecondary(videoId, primaryRef);
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

    // Without a secondary line YouTube's own captions are shown instead, as
    // they keep YouTube's positioning; the same applies while one is loading.
    const ready = Boolean(secondaryRef && state.primary.cues && state.primary.cues.length &&
      state.secondary.cues && state.secondary.cues.length);
    setActive(player, ready);
  }

  // ---------------------------------------------------------------------------
  // Controls inside YouTube's own settings popup
  //
  // The Subtitles/CC panel gets a "Dual subtitles" switch; the caption Options
  // panel gets the secondary font size and position. Everything reuses
  // YouTube's ytp-panel / ytp-menuitem markup, so YouTube's CSS draws the
  // switch, chevrons and check marks for both the classic and the newer UI.
  // ---------------------------------------------------------------------------

  /**
   * YouTube's Subtitles/CC panel: a settings panel with a header button
   * ("Options") that lists this video's caption tracks. The header button
   * alone is not enough: caption option sub-panels such as "Font size" have
   * one too ("Video Override"). Track names come from the player in the UI
   * language, so this works in every language.
   * @param {HTMLElement} player
   * @returns {HTMLElement | null}
   */
  function findCaptionsPanel(player) {
    const panels = [...player.querySelectorAll('.ytp-settings-menu .ytp-panel:not(.duosub-panel)')]
      .filter((panel) => panel.querySelector('.ytp-panel-options'));
    if (!panels.length) {
      return null;
    }
    const names = new Set(getCaptionData(player, getVideoId(player)).tracks.map((t) => t.name));
    const list = safeOption(player, 'tracklist', { includeAsr: true });
    for (const track of Array.isArray(list) ? list : []) {
      if (track && track.displayName) {
        names.add(String(track.displayName));
      }
    }
    const found = panels.find((panel) => [...panel.querySelectorAll('.ytp-menuitem-label')]
      .some((label) => names.has((label.textContent || '').trim())));
    return /** @type {HTMLElement | undefined} */ (found) || null;
  }

  /**
   * YouTube's caption Options panel (font family, colour, size...).
   * @param {HTMLElement} player
   * @returns {HTMLElement | null}
   */
  function findOptionsPanel(player) {
    const item = player.querySelector('.ytp-settings-menu .ytp-panel .ytp-subtitles-options-menu-item');
    return item ? /** @type {HTMLElement | null} */ (item.closest('.ytp-panel')) : null;
  }

  /**
   * Watches YouTube's settings popup, which rebuilds its panels whenever it is
   * opened or navigated, so our entries can be put back right away.
   * @param {HTMLElement} player
   */
  function ensureSettingsObserver(player) {
    const menu = player.querySelector('.ytp-settings-menu');
    if (!menu || menu === ui.observedMenu) {
      return;
    }
    if (ui.observer) {
      ui.observer.disconnect();
    }
    closePicker(false);
    ui.observedMenu = menu;
    ui.observer = new MutationObserver(() => refreshSettingsPanels(player));
    ui.observer.observe(menu, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  }

  /**
   * Adds or updates our entries in whichever settings panel is shown, and
   * drops the picker once YouTube has moved on. Only touches the DOM when
   * something changed, so the observer that calls it does not feed itself.
   * @param {HTMLElement} player
   */
  function refreshSettingsPanels(player) {
    if (!state.settings) {
      return;
    }
    const menu = /** @type {HTMLElement | null} */ (player.querySelector('.ytp-settings-menu'));
    const popupOpen = Boolean(menu && menu.style.display !== 'none');
    if (ui.picker && (!popupOpen || !ui.covered || !ui.covered.isConnected)) {
      closePicker(false);
    }
    const captions = findCaptionsPanel(player);
    if (captions) {
      refreshDuoSwitch(player, captions);
    }
    const options = findOptionsPanel(player);
    if (options) {
      refreshOptionItems(player, options);
    }
  }

  /**
   * The "Dual subtitles" switch at the top of the Subtitles/CC panel.
   * @param {HTMLElement} player
   * @param {HTMLElement} panel
   */
  function refreshDuoSwitch(player, panel) {
    const list = panel.querySelector('.ytp-panel-menu');
    if (!list) {
      return;
    }
    let item = /** @type {HTMLElement | null} */ (list.querySelector('.duosub-switch'));
    if (!item) {
      item = menuItem({
        label: L.duo,
        role: 'menuitemcheckbox',
        onSelect: () => {
          const enabled = !state.settings.enabled;
          // Switching on with the secondary set to 'off' (popup) would show nothing.
          saveSettings(enabled && state.settings.secondary === 'off' ? { enabled, secondary: 'auto' } : { enabled });
          if (enabled) {
            ensureCaptionsOn(player);
          }
          refreshSettingsPanels(player);
        }
      });
      item.classList.add('duosub-switch');
      // YouTube's rows here are a single label cell. A second (content) cell
      // would add a table column that every native row leaves empty, so the
      // switch goes inside the label cell.
      const content = /** @type {HTMLElement} */ (item.querySelector('.ytp-menuitem-content'));
      content.remove();
      const label = /** @type {HTMLElement} */ (item.querySelector('.ytp-menuitem-label'));
      const row = el('div', 'duosub-switch-row');
      row.append(el('span', '', L.duo), el('div', 'ytp-menuitem-toggle-checkbox'));
      label.replaceChildren(row);
      list.prepend(item);
    }
    const checked = String(state.settings.enabled);
    if (item.getAttribute('aria-checked') !== checked) {
      item.setAttribute('aria-checked', checked);
    }
    fitPanel(player, panel, item);
  }

  /**
   * YouTube sizes its popup to fit its own rows, so an added row would push
   * the last one (usually "Auto-translate") out of view. Grows the popup by
   * that overflow, unless YouTube had already capped the popup and scrolls it.
   * Reads YouTube's inline sizes, which are the targets of its resize
   * transition, rather than the sizes mid-animation.
   * @param {HTMLElement} player
   * @param {HTMLElement} panel
   * @param {HTMLElement} row The row we added.
   */
  function fitPanel(player, panel, row) {
    const popup = /** @type {HTMLElement | null} */ (panel.closest('.ytp-settings-menu'));
    const popupHeight = popup ? parseFloat(popup.style.height) : NaN;
    if (!popup || !Number.isFinite(popupHeight)) {
      return;
    }
    // YouTube may reset the popup's height alone after the panel was grown;
    // the popup then clips the panel with no way to scroll. Match the panel to
    // the popup first, so that at worst the panel scrolls.
    if (parseFloat(panel.style.height) !== popupHeight) {
      panel.style.height = `${popupHeight}px`;
    }
    const overflow = panel.scrollHeight - popupHeight;
    if (overflow <= 0 || overflow > row.offsetHeight + 1) {
      return;
    }
    // The popup is anchored at its bottom; keep a margin below the player top.
    const room = popup.getBoundingClientRect().bottom - player.getBoundingClientRect().top - 12;
    const height = popupHeight + Math.min(overflow, room - popupHeight);
    if (height < popupHeight + 1) {
      return;
    }
    // YouTube gives the popup and its panel the same height.
    popup.style.height = `${height}px`;
    panel.style.height = `${height}px`;
  }

  /**
   * Secondary font size and position, after YouTube's own caption options
   * (before "Reset").
   * @param {HTMLElement} player
   * @param {HTMLElement} panel
   */
  function refreshOptionItems(player, panel) {
    const list = panel.querySelector('.ytp-panel-menu');
    if (!list || ui.covered === panel) {
      return;
    }
    if (!list.querySelector('.duosub-option')) {
      const own = [...list.querySelectorAll('.ytp-subtitles-options-menu-item')];
      const anchor = own[own.length - 1];
      const items = [
        optionItem(player, panel, 'size', L.size, sizeItems),
        optionItem(player, panel, 'position', L.position, positionItems)
      ];
      if (anchor) {
        anchor.after(...items);
      } else {
        list.append(...items);
      }
    }
    setOptionValue(list, 'size', `${Math.round(state.settings.sizeRatio * 100)}%`);
    setOptionValue(list, 'position', state.settings.position === 'above' ? L.above : L.below);
  }

  /**
   * @param {HTMLElement} player
   * @param {HTMLElement} panel  Options panel the picker covers.
   * @param {string} name
   * @param {string} label
   * @param {(player: HTMLElement) => HTMLElement[]} build Picker items.
   * @returns {HTMLElement}
   */
  function optionItem(player, panel, name, label, build) {
    const item = menuItem({
      label,
      submenu: true,
      onSelect: () => openPicker(player, panel, label, build, name)
    });
    item.classList.add('duosub-option');
    item.dataset.duosubOption = name;
    // Same columns as YouTube's option rows, which start with an icon cell.
    item.prepend(el('div', 'ytp-menuitem-icon'));
    return item;
  }

  /**
   * @param {Element} list
   * @param {string} name
   * @param {string} value
   */
  function setOptionValue(list, name, value) {
    const content = list.querySelector(`.duosub-option[data-duosub-option="${name}"] .ytp-menuitem-content`);
    if (content && content.textContent !== value) {
      content.textContent = value;
    }
  }

  /**
   * Builds a YouTube-style menu item.
   * @param {Object} opts
   * @param {string} opts.label
   * @param {'menuitem' | 'menuitemradio' | 'menuitemcheckbox'} [opts.role]
   * @param {boolean} [opts.checked]
   * @param {boolean} [opts.submenu]  Opens another panel.
   * @param {() => void} opts.onSelect
   * @returns {HTMLElement}
   */
  function menuItem(opts) {
    const role = opts.role || 'menuitem';
    const item = el('div', 'ytp-menuitem');
    item.setAttribute('role', role);
    item.tabIndex = 0;
    if (role !== 'menuitem') {
      item.setAttribute('aria-checked', String(Boolean(opts.checked)));
    }
    if (opts.submenu) {
      // YouTube's CSS draws the chevron for aria-haspopup items.
      item.setAttribute('aria-haspopup', 'true');
    }
    item.append(el('div', 'ytp-menuitem-label', opts.label));
    if (role !== 'menuitemradio') {
      item.append(el('div', 'ytp-menuitem-content'));
    }
    item.addEventListener('click', opts.onSelect);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        opts.onSelect();
      }
    });
    return item;
  }

  /**
   * Shows a list of choices in place of a YouTube panel, with YouTube's panel
   * header markup so it looks like one of its own sub-panels.
   * @param {HTMLElement} player
   * @param {HTMLElement} native Panel to cover; shown again on close.
   * @param {string} title
   * @param {(player: HTMLElement) => HTMLElement[]} build
   * @param {string} origin data-duosub-option of the entry to refocus on close.
   */
  function openPicker(player, native, title, build, origin) {
    const host = native.parentElement;
    if (!host) {
      return;
    }
    closePicker(false);
    const picker = el('div', 'ytp-panel duosub-panel');
    picker.style.width = `${native.offsetWidth}px`;
    picker.style.height = `${native.offsetHeight}px`;

    const header = el('div', 'ytp-panel-header');
    const backBox = el('div', 'ytp-panel-back-button-container');
    const back = /** @type {HTMLButtonElement} */ (el('button', 'ytp-button ytp-panel-back-button'));
    back.type = 'button';
    back.setAttribute('aria-label', L.back);
    back.addEventListener('click', () => closePickerSoon());
    backBox.append(back);
    const heading = el('span', 'ytp-panel-title', title);
    heading.setAttribute('role', 'heading');
    heading.setAttribute('aria-level', '2');
    header.append(backBox, heading);

    const list = el('div', 'ytp-panel-menu');
    list.setAttribute('role', 'menu');
    list.append(...build(player));
    picker.append(header, list);

    native.classList.add('duosub-covered');
    host.append(picker);
    ui.picker = picker;
    ui.covered = native;
    ui.pickerOrigin = origin;
    const focus = /** @type {HTMLElement | null} */ (list.querySelector('[aria-checked="true"]') || list.firstElementChild);
    if (focus) {
      focus.focus({ preventScroll: true });
      focus.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Removes the picker and uncovers the YouTube panel behind it.
   * @param {boolean} refocus Move focus back to the entry that opened it.
   */
  function closePicker(refocus) {
    const covered = ui.covered;
    if (ui.picker) {
      ui.picker.remove();
    }
    ui.picker = null;
    ui.covered = null;
    if (covered) {
      covered.classList.remove('duosub-covered');
      const item = /** @type {HTMLElement | null} */ (covered.querySelector(`[data-duosub-option="${ui.pickerOrigin}"]`));
      if (refocus && item) {
        item.focus({ preventScroll: true });
      }
      if (ui.player) {
        refreshSettingsPanels(ui.player);
      }
    }
  }

  /**
   * Closes the picker once the current click has finished dispatching.
   * YouTube closes its popup on clicks whose target is outside it, and a
   * target already removed from the DOM counts as outside.
   */
  function closePickerSoon() {
    setTimeout(() => closePicker(true), 0);
  }

  /**
   * Saves a picker choice and returns to the panel behind the picker.
   * @param {Partial<import('./settings.js').DuoSubSettings>} patch
   */
  function choose(patch) {
    saveSettings(patch);
    closePickerSoon();
  }

  /** @returns {HTMLElement[]} */
  function sizeItems() {
    return SIZE_STEPS.map((ratio) => menuItem({
      label: `${Math.round(ratio * 100)}%`,
      role: 'menuitemradio',
      checked: Math.abs(state.settings.sizeRatio - ratio) < 0.001,
      onSelect: () => choose({ sizeRatio: ratio })
    }));
  }

  /** @returns {HTMLElement[]} */
  function positionItems() {
    return /** @type {const} */ (['below', 'above']).map((position) => menuItem({
      label: position === 'above' ? L.above : L.below,
      role: 'menuitemradio',
      checked: state.settings.position === position,
      onSelect: () => choose({ position })
    }));
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
