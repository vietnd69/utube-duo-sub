// SPDX-FileCopyrightText: 2026 vietnd69
// SPDX-License-Identifier: MIT
/**
 * @file Shared settings schema for YouTube Duo Sub.
 *
 * Loaded by the isolated content script (bridge), the popup and the unit
 * tests. It has no dependency on browser APIs so it can run anywhere.
 */
(function (root) {
  'use strict';

  /**
   * Secondary subtitle choices that are not a language code.
   * @enum {string}
   */
  const SecondaryMode = Object.freeze({
    /** Original language when YouTube auto-translates, otherwise the preferred language. */
    AUTO: 'auto',
    /** No secondary subtitle. */
    OFF: 'off'
  });

  /**
   * @typedef {Object} DuoSubSettings
   * @property {boolean} enabled        Whether dual subtitles are shown.
   * @property {string}  secondary      'auto', 'off', an ISO 639 / BCP 47 code
   *                                    (e.g. 'en', 'pt-BR') or '<code>:asr'
   *                                    for an auto-generated track.
   * @property {string}  preferredLang  Language used by 'auto' when the primary
   *                                    subtitle is not auto-translated. Empty
   *                                    string means the browser UI language.
   * @property {number}  sizeRatio      Secondary font size relative to the
   *                                    primary one, in (0, 1).
   * @property {('below'|'above')} position Secondary line placement.
   */

  /** @type {Readonly<DuoSubSettings>} */
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    secondary: SecondaryMode.AUTO,
    preferredLang: '',
    sizeRatio: 0.75,
    position: 'below'
  });

  /** Allowed range for {@link DuoSubSettings.sizeRatio}. */
  const SIZE_RATIO_MIN = 0.4;
  const SIZE_RATIO_MAX = 0.95;

  /** Language code with an optional ':asr' suffix (BCP 47 subset used by YouTube). */
  const LANG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*(?::asr)?$/;

  /**
   * Returns a complete, validated settings object. Unknown keys are dropped
   * and invalid values fall back to their defaults, so data coming from
   * storage or from page messages can never put the extension in a bad state.
   *
   * @param {unknown} input Raw settings (possibly partial or malformed).
   * @returns {DuoSubSettings}
   */
  function sanitizeSettings(input) {
    const raw = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
    const out = { ...DEFAULT_SETTINGS };

    if (typeof raw.enabled === 'boolean') {
      out.enabled = raw.enabled;
    }
    if (typeof raw.secondary === 'string' &&
        (raw.secondary === SecondaryMode.AUTO || raw.secondary === SecondaryMode.OFF ||
         LANG_PATTERN.test(raw.secondary))) {
      out.secondary = raw.secondary;
    }
    if (typeof raw.preferredLang === 'string' &&
        (raw.preferredLang === '' || LANG_PATTERN.test(raw.preferredLang)) &&
        !raw.preferredLang.endsWith(':asr')) {
      out.preferredLang = raw.preferredLang;
    }
    const ratio = Number(raw.sizeRatio);
    if (Number.isFinite(ratio)) {
      out.sizeRatio = Math.min(SIZE_RATIO_MAX, Math.max(SIZE_RATIO_MIN, ratio));
    }
    if (raw.position === 'below' || raw.position === 'above') {
      out.position = raw.position;
    }
    return out;
  }

  /**
   * Validates a partial update and returns only the keys it contains, so
   * concurrent updates of different keys never overwrite each other.
   *
   * @param {unknown} patch
   * @returns {Partial<DuoSubSettings>}
   */
  function sanitizePatch(patch) {
    if (!patch || typeof patch !== 'object') {
      return {};
    }
    const clean = sanitizeSettings(patch);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        out[key] = clean[/** @type {keyof DuoSubSettings} */ (key)];
      }
    }
    return /** @type {Partial<DuoSubSettings>} */ (out);
  }

  const api = Object.freeze({
    SecondaryMode,
    DEFAULT_SETTINGS,
    SIZE_RATIO_MIN,
    SIZE_RATIO_MAX,
    sanitizeSettings,
    sanitizePatch
  });

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DuoSubSettings = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
