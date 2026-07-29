/*
 * content.js
 * Walks the page, finds times, and inserts a sibling <span> with the same
 * time expressed in the user's chosen zone. Nothing in the original DOM text
 * is altered — annotations are separate, removable nodes.
 *
 * Scanning happens over an *inline run*, not over one text node: a rendered
 * time is frequently split across inline elements, e.g. Statuspage writes
 *
 *   Jul <var data-var='date'>29</var>, <var data-var='year'>2026</var>
 *     - <var data-var='time'>20:33</var> UTC
 *
 * so the digits and their "UTC" label live in different text nodes. Scanning
 * them separately doesn't merely miss the match — it reads "20:33" as an
 * *untagged* time and converts it from the wrong source zone.
 */
(function () {
  "use strict";

  var ANNOT_CLASS = "tzc-annot";
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1,
    SVG: 1, MATH: 1, CODE: 1
  };

  /*
   * Elements that flow inline with the surrounding text. Their text is joined
   * with their neighbours' into one scanning run, so a time may straddle them.
   * Anything not listed here is treated as a block boundary, which ends the
   * run — text on either side of a block boundary isn't one phrase.
   */
  var INLINE_TAGS = {
    A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BIG: 1, BUTTON: 1, CITE: 1, DATA: 1,
    DEL: 1, DFN: 1, EM: 1, FONT: 1, I: 1, INS: 1, KBD: 1, LABEL: 1, MARK: 1,
    NOBR: 1, OUTPUT: 1, Q: 1, RP: 1, RT: 1, RUBY: 1, S: 1, SAMP: 1, SLOT: 1,
    SMALL: 1, SPAN: 1, STRIKE: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, TT: 1,
    U: 1, VAR: 1, WBR: 1
  };

  var HAS_DIGIT = /\d/;

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

  function isAnnotation(node) {
    return !!(node && node.nodeType === 1 && node.classList &&
      node.classList.contains(ANNOT_CLASS));
  }

  // Nothing above this node forbids annotating inside it?
  function ancestorsAllow(node) {
    var el = node.parentElement;
    while (el) {
      if (SKIP_TAGS[el.tagName]) return false;
      if (isAnnotation(el)) return false;
      if (el.isContentEditable) return false;
      el = el.parentElement;
    }
    return true;
  }

  // --- Inline runs ---------------------------------------------------------

  /*
   * Collect the inline runs under `root`. A run is { text, items }: the joined
   * text of a maximal sequence of text nodes uninterrupted by a block
   * boundary, plus the items it was built from. An item is either
   *   { type: "text", node, start, end }   — its slice of `text`, or
   *   { type: "annot" }                    — one of our own annotation spans.
   * Annotation spans contribute no text (theirs holds a time of its own) but
   * are recorded so a re-scan can see that the time before one is done.
   */
  function buildRuns(root) {
    var runs = [];
    var current = null;

    function flush() {
      if (!current) return;
      if (current.text) runs.push(current);
      current = null;
    }

    function pushText(node) {
      var value = node.nodeValue || "";
      // An empty text node contributes no text and cannot host an annotation.
      // Frameworks leave plenty of them around; skipping them keeps every item
      // a real, non-degenerate slice of `text`.
      if (!value) return;
      if (!current) current = { text: "", items: [] };
      current.items.push({
        type: "text",
        node: node,
        start: current.text.length,
        end: current.text.length + value.length
      });
      current.text += value;
    }

    function visit(node) {
      var type = node.nodeType;
      if (type === 3) { pushText(node); return; }
      if (type !== 1 && type !== 11) return;

      if (type === 1) {
        if (isAnnotation(node)) {
          if (current) current.items.push({ type: "annot" });
          return;
        }
        if (SKIP_TAGS[node.tagName] || node.isContentEditable) { flush(); return; }
        if (node.tagName === "BR") { flush(); return; }
      }

      var inline = type === 1 && INLINE_TAGS[node.tagName] === 1;
      if (!inline) flush();
      for (var child = node.firstChild; child; child = child.nextSibling) {
        visit(child);
      }
      if (!inline) flush();
    }

    visit(root);
    flush();
    return runs;
  }

  // The next text-bearing thing after item `i` is one of our annotations?
  function annotatedAfter(items, i) {
    for (var j = i + 1; j < items.length; j++) {
      if (items[j].type === "annot") return true;
      if (items[j].type === "text") return false;
    }
    return false;
  }

  /*
   * Put `annotation` at run-text offset `offset` (the end of a matched time),
   * splitting the containing text node when the time ends mid-node.
   */
  function insertAt(run, offset, annotation) {
    var items = run.items;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.type !== "text") continue;
      if (offset > item.end) continue;
      if (offset <= item.start) return; // fell in a gap; nothing to anchor to

      var node = item.node;
      var parent = node.parentNode;
      if (!parent) return;
      var local = offset - item.start;

      if (local < (node.nodeValue || "").length) {
        // Ends mid-node: split so the annotation lands right after the time.
        node.splitText(local);
      } else if (annotatedAfter(items, i)) {
        return; // already annotated on an earlier pass
      }
      parent.insertBefore(makeAnnotation(annotation), node.nextSibling);
      return;
    }
  }

  function processRun(run) {
    if (!HAS_DIGIT.test(run.text)) return;
    var results = self.TZCore.scanText(run.text, settings, now);
    // Insert back-to-front so the offsets we haven't used yet stay valid
    // across the text-node splits.
    for (var i = results.length - 1; i >= 0; i--) {
      insertAt(run, results[i].end, results[i].annotation);
    }
  }

  function processRoot(root) {
    if (!settings || !settings.enabled || !root) return;
    if (!ancestorsAllow(root)) return;
    // Snapshot every run first, then mutate: splitting a text node must not
    // disturb a walk still in progress.
    var runs = buildRuns(root);
    for (var i = 0; i < runs.length; i++) processRun(runs[i]);
  }

  // --- Dynamic content -----------------------------------------------------

  /*
   * The element to re-scan for a changed node. A time can straddle inline
   * elements, so scanning a changed <var> alone would see the same fragment
   * the old per-node scanner did — climb to the enclosing block instead.
   */
  function scanRootFor(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return null;
    while (el.parentElement && (INLINE_TAGS[el.tagName] === 1 || isAnnotation(el))) {
      el = el.parentElement;
    }
    return el;
  }

  function flush() {
    flushScheduled = false;
    if (!settings || !settings.enabled) { pending.clear(); return; }
    var nodes = Array.from(pending);
    pending.clear();
    if (observer) observer.disconnect();
    var seen = new Set();
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].isConnected) continue;
      var root = scanRootFor(nodes[i]);
      if (!root || seen.has(root)) continue;
      seen.add(root);
      processRoot(root);
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
        if (mu.target) pending.add(mu.target);
      } else {
        for (var j = 0; j < mu.addedNodes.length; j++) {
          var an = mu.addedNodes[j];
          // Ignore nodes we inserted ourselves.
          if (isAnnotation(an)) continue;
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

  // Exposed for tools/test-content.js; harmless on a real page.
  self.TZContent = {
    _processRoot: processRoot,
    _buildRuns: buildRuns,
    _setSettings: function (s) { settings = resolvedSettings(s); },
    _setNow: function (d) { now = d; }
  };

  start();
})();
