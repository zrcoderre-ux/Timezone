/*
 * background.js (service worker)
 * Seeds default settings the first time the extension is installed so the
 * content script and options page always have a complete settings object.
 */
importScripts("tz-data.js");

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.sync.get(["settings"], function (data) {
    var merged = self.TZData.withDefaults(data && data.settings);
    chrome.storage.sync.set({ settings: merged });
  });
});
