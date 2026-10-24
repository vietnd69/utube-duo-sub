// SPDX-FileCopyrightText: 2026 vietnd69
// SPDX-License-Identifier: MIT
/**
 * @file Isolated-world content script: relays settings between
 * chrome.storage (only reachable here) and the page-world script.
 *
 * Every value is passed through sanitizeSettings in both directions, so a
 * message forged by another script on the page cannot store invalid data.
 */
(function () {
  'use strict';

  const Settings = /** @type {any} */ (globalThis).DuoSubSettings;
  const MSG_FROM_PAGE = 'duosub-page';
  const MSG_FROM_BRIDGE = 'duosub-bridge';

  /** Sends the current settings to the page script. */
  function publish() {
    chrome.storage.sync.get(Settings.DEFAULT_SETTINGS, (stored) => {
      if (chrome.runtime.lastError) {
        return;
      }
      window.postMessage(
        { source: MSG_FROM_BRIDGE, type: 'settings', settings: Settings.sanitizeSettings(stored) },
        location.origin
      );
    });
  }

  /**
   * Stores the validated keys of a partial update.
   * @param {unknown} patch
   */
  function save(patch) {
    const clean = Settings.sanitizePatch(patch);
    if (Object.keys(clean).length) {
      chrome.storage.sync.set(clean);
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.source !== MSG_FROM_PAGE) {
      return;
    }
    if (data.type === 'get') {
      publish();
    } else if (data.type === 'save') {
      save(data.patch);
    }
  });

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') {
      publish();
    }
  });

  publish();
})();
