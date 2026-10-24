/**
 * @file Extension popup: edits the settings stored in chrome.storage.sync.
 * Open YouTube tabs pick the change up through the bridge immediately.
 */
(function () {
  'use strict';

  const Settings = /** @type {any} */ (globalThis).DuoSubSettings;

  /** Languages offered in the popup (ISO 639-1 / BCP 47), YouTube's most common. */
  const LANGUAGES = Object.freeze([
    'vi', 'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'th', 'id', 'ms', 'fil', 'hi',
    'fr', 'de', 'es', 'pt', 'it', 'ru', 'uk', 'pl', 'nl', 'sv', 'tr', 'ar'
  ]);

  const uiLanguage = chrome.i18n.getUILanguage();
  const displayNames = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames([uiLanguage], { type: 'language' })
    : null;

  /**
   * @param {string} key
   * @returns {string}
   */
  function msg(key) {
    return chrome.i18n.getMessage(key) || key;
  }

  /**
   * Human readable language name, e.g. 'vi' -> 'Tiếng Việt'.
   * @param {string} code
   * @returns {string}
   */
  function languageName(code) {
    try {
      const name = displayNames && displayNames.of(code);
      return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : code;
    } catch (_err) {
      return code;
    }
  }

  /**
   * @param {HTMLSelectElement} select
   * @param {Array<[string, string]>} options value/label pairs
   */
  function fillSelect(select, options) {
    select.replaceChildren(...options.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
  }

  /**
   * Ensures the select contains `value` (e.g. a language picked in the
   * player menu that is not in the popup list) and selects it.
   * @param {HTMLSelectElement} select
   * @param {string} value
   */
  function selectValue(select, value) {
    if (![...select.options].some((o) => o.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      const asr = value.endsWith(':asr');
      option.textContent = asr ? `${languageName(value.slice(0, -4))} (ASR)` : languageName(value);
      select.append(option);
    }
    select.value = value;
  }

  function localize() {
    document.documentElement.lang = uiLanguage;
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = msg(/** @type {HTMLElement} */ (node).dataset.i18n || '');
    }
  }

  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const enabled = /** @type {HTMLInputElement} */ ($('enabled'));
  const secondary = /** @type {HTMLSelectElement} */ ($('secondary'));
  const preferredLang = /** @type {HTMLSelectElement} */ ($('preferredLang'));
  const sizeRatio = /** @type {HTMLInputElement} */ ($('sizeRatio'));
  const sizeValue = /** @type {HTMLOutputElement} */ ($('sizeValue'));
  const position = /** @type {HTMLSelectElement} */ ($('position'));

  const languageOptions = /** @type {Array<[string, string]>} */ (
    LANGUAGES.map((code) => [code, languageName(code)])
  );
  fillSelect(secondary, [['auto', msg('popupAuto')], ['off', msg('popupOff')], ...languageOptions]);
  fillSelect(preferredLang, [['', `${msg('popupBrowserLang')} (${languageName(uiLanguage)})`], ...languageOptions]);
  sizeRatio.min = String(Settings.SIZE_RATIO_MIN);
  sizeRatio.max = String(Settings.SIZE_RATIO_MAX);

  /** @param {import('../src/settings.js').DuoSubSettings} s */
  function render(s) {
    enabled.checked = s.enabled;
    selectValue(secondary, s.secondary);
    selectValue(preferredLang, s.preferredLang);
    sizeRatio.value = String(s.sizeRatio);
    sizeValue.value = `${Math.round(s.sizeRatio * 100)}%`;
    position.value = s.position;
    preferredLang.disabled = s.secondary !== 'auto';
  }

  /** @param {Partial<import('../src/settings.js').DuoSubSettings>} patch */
  function save(patch) {
    chrome.storage.sync.set(Settings.sanitizePatch(patch));
  }

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') {
      chrome.storage.sync.get(Settings.DEFAULT_SETTINGS, (stored) => render(Settings.sanitizeSettings(stored)));
    }
  });

  enabled.addEventListener('change', () => save({ enabled: enabled.checked }));
  secondary.addEventListener('change', () => save({ secondary: secondary.value }));
  preferredLang.addEventListener('change', () => save({ preferredLang: preferredLang.value }));
  sizeRatio.addEventListener('input', () => {
    sizeValue.value = `${Math.round(Number(sizeRatio.value) * 100)}%`;
  });
  sizeRatio.addEventListener('change', () => save({ sizeRatio: Number(sizeRatio.value) }));
  position.addEventListener('change', () => save({ position: /** @type {any} */ (position.value) }));

  localize();
  chrome.storage.sync.get(Settings.DEFAULT_SETTINGS, (stored) => render(Settings.sanitizeSettings(stored)));
})();
