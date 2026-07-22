/*
 * options.js
 * Loads settings, wires up the form, saves on change, and renders a live
 * preview using the same core logic the content script uses.
 */
(function () {
  "use strict";

  var FIELDS = ["enabled", "targetTimeZone", "convertUntagged",
    "untaggedSource", "hourFormat", "showZoneName", "wrap", "style"];

  var el = {};
  FIELDS.forEach(function (id) { el[id] = document.getElementById(id); });
  var statusEl = document.getElementById("status");
  var previewEl = document.getElementById("preview");

  var localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function zoneList() {
    if (typeof Intl.supportedValuesOf === "function") {
      try { return Intl.supportedValuesOf("timeZone"); } catch (e) { /* fall back */ }
    }
    return TZData.COMMON_ZONES;
  }

  function fillZoneSelects() {
    var zones = zoneList();

    // Target: first option is the browser-local default (empty value).
    var opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Browser local (" + localZone + ")";
    el.targetTimeZone.appendChild(opt);

    // Untagged source: "local" first.
    var lopt = document.createElement("option");
    lopt.value = "local";
    lopt.textContent = "Browser local (" + localZone + ")";
    el.untaggedSource.appendChild(lopt);

    zones.forEach(function (z) {
      var a = document.createElement("option");
      a.value = z; a.textContent = z.replace(/_/g, " ");
      el.targetTimeZone.appendChild(a);

      var b = document.createElement("option");
      b.value = z; b.textContent = z.replace(/_/g, " ");
      el.untaggedSource.appendChild(b);
    });
  }

  function readForm() {
    return {
      enabled: el.enabled.checked,
      targetTimeZone: el.targetTimeZone.value,
      convertUntagged: el.convertUntagged.checked,
      untaggedSource: el.untaggedSource.value,
      hourFormat: el.hourFormat.value,
      showZoneName: el.showZoneName.checked,
      wrap: el.wrap.value,
      style: el.style.value
    };
  }

  function writeForm(s) {
    el.enabled.checked = s.enabled;
    el.targetTimeZone.value = s.targetTimeZone;
    el.convertUntagged.checked = s.convertUntagged;
    el.untaggedSource.value = s.untaggedSource;
    el.hourFormat.value = s.hourFormat;
    el.showZoneName.checked = s.showZoneName;
    el.wrap.value = s.wrap;
    el.style.value = s.style;
  }

  function reflectDisabled() {
    el.untaggedSource.disabled = !el.convertUntagged.checked;
  }

  var saveTimer = null;
  function save() {
    var s = readForm();
    chrome.storage.sync.set({ settings: s }, function () {
      statusEl.textContent = "Saved";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { statusEl.textContent = ""; }, 1200);
    });
    renderPreview(s);
    reflectDisabled();
  }

  // --- Live preview --------------------------------------------------------

  var SAMPLES = [
    "The webinar starts at 3:00 PM EST and ends around 4:30 PM EST.",
    "Doors open at 9 PM — see you there!",
    "Deploy window: 14:00 UTC to 15:30 UTC.",
    "Standup is at 10:00 AM PST every weekday."
  ];

  function renderPreview(s) {
    var resolved = TZData.withDefaults(s);
    if (!resolved.targetTimeZone) resolved.targetTimeZone = localZone;
    var now = new Date();

    previewEl.textContent = "";
    if (!resolved.enabled) {
      var off = document.createElement("p");
      off.style.color = "var(--muted)";
      off.textContent = "(Extension is disabled — no annotations shown.)";
      previewEl.appendChild(off);
      return;
    }

    SAMPLES.forEach(function (text) {
      var p = document.createElement("p");
      var results = TZCore.scanText(text, resolved, now);
      var cursor = 0;
      results.forEach(function (r) {
        p.appendChild(document.createTextNode(text.slice(cursor, r.end)));
        var span = document.createElement("span");
        span.className = "tzc-annot" + (resolved.style === "muted" ? " tzc-muted" : "");
        span.textContent = r.annotation;
        p.appendChild(span);
        cursor = r.end;
      });
      p.appendChild(document.createTextNode(text.slice(cursor)));
      previewEl.appendChild(p);
    });
  }

  // --- Boot ----------------------------------------------------------------

  fillZoneSelects();

  chrome.storage.sync.get(["settings"], function (data) {
    var s = TZData.withDefaults(data && data.settings);
    writeForm(s);
    reflectDisabled();
    renderPreview(s);
  });

  FIELDS.forEach(function (id) {
    el[id].addEventListener("change", save);
  });
})();
