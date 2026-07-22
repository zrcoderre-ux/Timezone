/*
 * popup.js
 * Minimal toolbar popup: an enable/disable switch plus a shortcut to the full
 * options page.
 */
(function () {
  "use strict";

  var enabledEl = document.getElementById("enabled");
  var zoneEl = document.getElementById("zone");
  var localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  chrome.storage.sync.get(["settings"], function (data) {
    var s = self.TZData.withDefaults(data && data.settings);
    enabledEl.checked = s.enabled;
    var target = s.targetTimeZone || localZone;
    zoneEl.textContent = "Showing times in: " + target.replace(/_/g, " ");
  });

  enabledEl.addEventListener("change", function () {
    chrome.storage.sync.get(["settings"], function (data) {
      var s = self.TZData.withDefaults(data && data.settings);
      s.enabled = enabledEl.checked;
      chrome.storage.sync.set({ settings: s });
    });
  });

  document.getElementById("openOptions").addEventListener("click", function () {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("src/options.html"));
  });
})();
