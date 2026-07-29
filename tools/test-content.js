/*
 * test-content.js
 * Checks for the DOM half of the extension: that a time split across inline
 * elements is still recognised (the shape Statuspage and friends emit), that a
 * block boundary is not silently joined, and that a re-scan is idempotent.
 *
 * Runs on a hand-rolled DOM shim rather than a dependency, matching the rest
 * of tools/. Only the handful of APIs content.js touches are implemented.
 *
 *   node tools/test-content.js
 */
"use strict";

// --- Minimal DOM ----------------------------------------------------------

function TextNode(value) {
  this.nodeType = 3;
  this.nodeValue = value;
  this.parentNode = null;
  this.childNodes = [];
}

TextNode.prototype.splitText = function (offset) {
  var tail = new TextNode(this.nodeValue.slice(offset));
  this.nodeValue = this.nodeValue.slice(0, offset);
  if (this.parentNode) this.parentNode.insertBefore(tail, this.nextSibling);
  return tail;
};

function Element(tag) {
  var el = this;
  this.nodeType = 1;
  this.tagName = String(tag).toUpperCase();
  this.childNodes = [];
  this.parentNode = null;
  this.className = "";
  this.id = "";
  this.isContentEditable = false;
  this.attributes = {};
  this.classList = {
    contains: function (name) {
      return el.className.split(/\s+/).indexOf(name) >= 0;
    }
  };
}

Element.prototype.setAttribute = function (name, value) {
  this.attributes[name] = value;
};

Element.prototype.insertBefore = function (node, ref) {
  if (node.parentNode) node.parentNode.removeChild(node);
  var at = ref ? this.childNodes.indexOf(ref) : -1;
  if (at < 0) this.childNodes.push(node);
  else this.childNodes.splice(at, 0, node);
  node.parentNode = this;
  return node;
};

Element.prototype.appendChild = function (node) {
  return this.insertBefore(node, null);
};

Element.prototype.removeChild = function (node) {
  var at = this.childNodes.indexOf(node);
  if (at >= 0) this.childNodes.splice(at, 1);
  node.parentNode = null;
  return node;
};

// Shared computed properties.
[TextNode, Element].forEach(function (Ctor) {
  Object.defineProperty(Ctor.prototype, "firstChild", {
    get: function () { return this.childNodes[0] || null; }
  });
  Object.defineProperty(Ctor.prototype, "nextSibling", {
    get: function () {
      if (!this.parentNode) return null;
      var sibs = this.parentNode.childNodes;
      return sibs[sibs.indexOf(this) + 1] || null;
    }
  });
  Object.defineProperty(Ctor.prototype, "parentElement", {
    get: function () {
      var p = this.parentNode;
      return p && p.nodeType === 1 ? p : null;
    }
  });
  Object.defineProperty(Ctor.prototype, "isConnected", {
    get: function () {
      var n = this;
      while (n.parentNode) n = n.parentNode;
      return n === document.documentElement;
    }
  });
});

Object.defineProperty(Element.prototype, "textContent", {
  get: function () {
    return this.childNodes.map(function (c) {
      return c.nodeType === 3 ? c.nodeValue : c.textContent;
    }).join("");
  },
  set: function (value) {
    this.childNodes.slice().forEach(this.removeChild, this);
    this.appendChild(new TextNode(String(value)));
  }
});

function walkAll(node, out) {
  for (var i = 0; i < node.childNodes.length; i++) {
    var c = node.childNodes[i];
    if (c.nodeType === 1) { out.push(c); walkAll(c, out); }
  }
  return out;
}

var document = {
  createElement: function (tag) { return new Element(tag); },
  createTextNode: function (value) { return new TextNode(String(value)); },
  getElementById: function (id) {
    return walkAll(document.documentElement, []).filter(function (el) {
      return el.id === id;
    })[0] || null;
  },
  querySelectorAll: function (sel) {
    var cls = sel.replace(/^\./, "");
    return walkAll(document.documentElement, []).filter(function (el) {
      return el.classList.contains(cls);
    });
  },
  addEventListener: function () {}
};
document.documentElement = new Element("html");
document.head = document.documentElement.appendChild(new Element("head"));
document.body = document.documentElement.appendChild(new Element("body"));

// --- Extension globals ----------------------------------------------------

global.document = document;
global.self = global;
global.MutationObserver = function () {
  this.observe = function () {};
  this.disconnect = function () {};
};
global.chrome = {
  storage: {
    sync: { get: function (keys, cb) { cb({}); } },
    onChanged: { addListener: function () {} }
  }
};

require("../src/tz-data.js");
require("../src/tz-core.js");
require("../src/content.js");

// --- Test helpers ---------------------------------------------------------

// el("small", "Jul ", el("var", "29"), " UTC")
function el(tag) {
  var node = new Element(tag);
  for (var i = 1; i < arguments.length; i++) {
    var c = arguments[i];
    node.appendChild(typeof c === "string" ? new TextNode(c) : c);
  }
  return node;
}

// Serialise, marking our annotations with «».
function render(node) {
  if (node.nodeType === 3) return node.nodeValue;
  var inner = node.childNodes.map(render).join("");
  return node.classList.contains("tzc-annot") ? "«" + inner + "»" : inner;
}

// An expected annotation. tz-core.js deliberately opens with a non-breaking
// space so the added time can never wrap away from the original.
function an(text) {
  return "«\u00a0(" + text + ")»";
}

var SETTINGS = {
  targetTimeZone: "America/Los_Angeles",
  convertUntagged: true,
  untaggedSource: "UTC",
  hourFormat: "24",
  showZoneName: true,
  wrap: "paren"
};
var NOW = new Date(Date.UTC(2026, 6, 29, 20, 40));

var failures = 0;

function check(name, tree, expected, opts) {
  document.body.appendChild(tree);
  self.TZContent._setSettings(Object.assign({}, SETTINGS, opts || {}));
  self.TZContent._setNow(NOW);
  var passes = (opts && opts.passes) || 1;
  for (var i = 0; i < passes; i++) self.TZContent._processRoot(tree);
  var got = render(tree);
  document.body.removeChild(tree);
  var ok = got === expected;
  if (!ok) failures++;
  console.log((ok ? "ok   " : "FAIL ") + name);
  if (!ok) {
    console.log("       expected: " + JSON.stringify(expected));
    console.log("       got:      " + JSON.stringify(got));
  }
}

// --- Cases ---------------------------------------------------------------

/*
 * The reported bug: status.claude.com (Statuspage) splits its incident
 * timestamps across <var> elements, so the digits and the "UTC" label land in
 * different text nodes. Scanned per-node, "20:33" read as untagged and — for a
 * reader whose local zone is the target — produced nothing at all.
 */
check("statuspage-style split timestamp",
  el("div",
    el("small",
      "Jul ", el("var", "29"), ", ", el("var", "2026"),
      " - ", el("var", "20:33"), " UTC")),
  "Jul 29, 2026 - 20:33 UTC" + an("13:33 PDT"));

check("split timestamp, re-scanned",
  el("div",
    el("small",
      "Jul ", el("var", "29"), ", ", el("var", "2026"),
      " - ", el("var", "20:33"), " UTC")),
  "Jul 29, 2026 - 20:33 UTC" + an("13:33 PDT"),
  { passes: 3 });

check("unsplit timestamp still works",
  el("div", el("small", "Jul 29, 2026 - 20:33 UTC")),
  "Jul 29, 2026 - 20:33 UTC" + an("13:33 PDT"));

// Ends mid-node, so the node is split. A re-scan then finds the offset at the
// end of the head, with the annotation right after it.
check("annotation lands before trailing punctuation",
  el("div", "Updated 20:33 UTC."),
  "Updated 20:33 UTC" + an("13:33 PDT") + ".",
  { passes: 3 });

check("zone label in a sibling element",
  el("p", "starts at ", el("b", "3:00 PM"), " EST", " sharp"),
  "starts at 3:00 PM EST" + an("13:00 PDT") + " sharp");

check("two split times in one run",
  el("p",
    el("span", "10:00"), " UTC and ", el("span", "11:00"), " UTC done"),
  "10:00 UTC" + an("03:00 PDT") + " and 11:00 UTC" + an("04:00 PDT") + " done");

// A block boundary must not be joined, or "14:00" in one paragraph would take
// its zone from the word starting the next one.
check("block boundary is not joined",
  el("div", el("p", "meeting 14:00"), el("p", "PST is the venue zone")),
  "meeting 14:00" + an("07:00 PDT") + "PST is the venue zone");

check("<br> ends a run",
  el("div", "meeting 14:00", el("br"), "PST is the venue zone"),
  "meeting 14:00" + an("07:00 PDT") + "PST is the venue zone");

// Two matches inside one text node: the later insertion splits the node, and
// the earlier one then has to split the head that's left behind.
check("two times in a single text node",
  el("p", "from 10:00 UTC to 11:00 UTC daily"),
  "from 10:00 UTC" + an("03:00 PDT") + " to 11:00 UTC" + an("04:00 PDT") + " daily");

check("empty text node on the boundary",
  el("p", "at 20:33 UTC", "", " sharp"),
  "at 20:33 UTC" + an("13:33 PDT") + " sharp");

check("skipped tags stay untouched",
  el("div", el("code", "20:33 UTC"), el("script", "at 20:33 UTC")),
  "20:33 UTCat 20:33 UTC");

check("nothing added when the target zone is already shown",
  el("div", el("span", "20:33"), " PDT"),
  "20:33 PDT");

// buildRuns should keep inline text together and split at blocks.
(function () {
  var tree = el("div", el("p", "a ", el("var", "1"), "b"), el("p", "c"));
  var runs = self.TZContent._buildRuns(tree).map(function (r) { return r.text; });
  var got = JSON.stringify(runs);
  var expected = JSON.stringify(["a 1b", "c"]);
  var ok = got === expected;
  if (!ok) failures++;
  console.log((ok ? "ok   " : "FAIL ") + "buildRuns groups inline, splits blocks");
  if (!ok) console.log("       expected " + expected + " got " + got);
})();

console.log(failures ? "\n" + failures + " failure(s)" : "\nall passed");
process.exit(failures ? 1 : 0);
