/*
 * content.js
 * Walks the page, finds times, and inserts a sibling <span> with the same
 * time expressed in the user's chosen zone. Nothing in the original DOM text
 * is altered — annotations are separate, removable nodes.
 */
(function () {
  "use strict";

  var ANNOT_CLASS = "tzc-annot";
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1,
    SVG: 1, MATH: 1, CODE: 1
  };

  var settings = null;
  var now = new Date();
  var observer = null;
  var pending = new Set();
  var flushScheduled = false;

  function resolvedSettings(raw) {
    var s = self.TZData.withDefaults(raw);
    if (!s.targetTimeZone) {
      s.targetTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    return s;
  }

  function styleEl() {
    if (document.getElementById("tzc-style")) return;
    var st = document.createElement("style");
    st.id = "tzc-style";
    st.textContent =
      "." + ANNOT_CLASS + "{white-space:nowrap;}" +
      "." + ANNOT_CLASS + ".tzc-muted{opacity:.72;}";
    (document.head || document.documentElement).appendChild(st);
  }

  function makeAnnotation(text) {
    var span = document.createElement("span");
    span.className = ANNOT_CLASS + (settings.style === "muted" ? " tzc-muted" : "");
    span.textContent = text;
    span.setAttribute("title", "Added by Timezone Companion");
    span.setAttribute("data-tzc", "1");
    return span;
  }

  // Should this text node be considered at all?
  function isEligible(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    var el = node.parentElement;
    while (el) {
      if (SKIP_TAGS[el.tagName]) return false;
      if (el.classList && el.classList.contains(ANNOT_CLASS)) return false;
      if (el.isContentEditable) return false;
      el = el.parentElement;
    }
    return true;
  }

  // True when this text node already has our annotation right after it.
  function alreadyAnnotated(node, matchEnd) {
    if (matchEnd !== node.nodeValue.length) return false;
    var next = node.nextSibling;
    return !!(next && next.nodeType === 1 &&
      next.classList && next.classList.contains(ANNOT_CLASS));
  }

  function processTextNode(node) {
    if (!isEligible(node)) return;
    var text = node.nodeValue;
    var results = self.TZCore.scanText(text, settings, now);
    if (!results.length) return;

    // Drop matches that are already annotated (idempotency on re-scan).
    results = results.filter(function (r) {
      return !alreadyAnnotated(node, r.end);
    });
    if (!results.length) return;

    var frag = document.createDocumentFragment();
    var cursor = 0;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      frag.appendChild(document.createTextNode(text.slice(cursor, r.end)));
      frag.appendChild(makeAnnotation(r.annotation));
      cursor = r.end;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(frag, node);
  }

  function collectTextNodes(root) {
    var nodes = [];
    if (root.nodeType === 3) { nodes.push(root); return nodes; }
    if (root.nodeType !== 1 && root.nodeType !== 11) return nodes;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function processRoot(root) {
    if (!settings || !settings.enabled) return;
    var nodes = collectTextNodes(root);
    // Snapshot first, then mutate, so the walker isn't disturbed mid-flight.
    for (var i = 0; i < nodes.length; i++) processTextNode(nodes[i]);
  }

  // --- Dynamic content -----------------------------------------------------

  function flush() {
    flushScheduled = false;
    if (!settings || !settings.enabled) { pending.clear(); return; }
    var roots = Array.from(pending);
    pending.clear();
    if (observer) observer.disconnect();
    for (var i = 0; i < roots.length; i++) {
      if (roots[i].isConnected) processRoot(roots[i]);
    }
    if (observer) startObserving();
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    var run = function () { flush(); };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 150);
    }
  }

  function onMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var mu = mutations[i];
      if (mu.type === "characterData") {
        if (mu.target && isEligible(mu.target)) pending.add(mu.target);
      } else {
        for (var j = 0; j < mu.addedNodes.length; j++) {
          var an = mu.addedNodes[j];
          // Ignore nodes we inserted ourselves.
          if (an.nodeType === 1 && an.classList &&
              an.classList.contains(ANNOT_CLASS)) continue;
          if (an.nodeType === 3 || an.nodeType === 1) pending.add(an);
        }
      }
    }
    if (pending.size) scheduleFlush();
  }

  function startObserving() {
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true
    });
  }

  // --- Lifecycle -----------------------------------------------------------

  function removeAllAnnotations() {
    var spans = document.querySelectorAll("." + ANNOT_CLASS);
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.parentNode) s.parentNode.removeChild(s);
    }
  }

  function run() {
    styleEl();
    processRoot(document.body || document.documentElement);
    if (!observer) observer = new MutationObserver(onMutations);
    startObserving();
  }

  function start() {
    chrome.storage.sync.get(["settings"], function (data) {
      settings = resolvedSettings(data && data.settings);
      if (!settings.enabled) return;
      if (document.body) run();
      else document.addEventListener("DOMContentLoaded", run, { once: true });
    });
  }

  // React to settings changes without needing a reload.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync" || !changes.settings) return;
    settings = resolvedSettings(changes.settings.newValue);
    now = new Date();
    if (observer) observer.disconnect();
    removeAllAnnotations();
    if (settings.enabled) {
      pending.clear();
      if (document.body) processRoot(document.body);
      if (!observer) observer = new MutationObserver(onMutations);
      startObserving();
    }
  });

  start();
})();
