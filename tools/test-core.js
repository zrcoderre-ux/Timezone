/* Ad-hoc sanity checks for the timezone core (run: node tools/test-core.js). */
global.self = global;
require("../src/tz-data.js");
require("../src/tz-core.js");

var now = new Date("2026-07-22T12:00:00Z"); // fixed instant for reproducibility

function base(overrides) {
  return self.TZData.withDefaults(Object.assign({
    enabled: true, convertUntagged: true, showZoneName: true
  }, overrides));
}

function annotate(text, settings) {
  var res = self.TZCore.scanText(text, settings, now);
  var out = "", cursor = 0;
  res.forEach(function (r) {
    out += text.slice(cursor, r.end) + "«" + r.annotation.trim() + "»";
    cursor = r.end;
  });
  out += text.slice(cursor);
  return out;
}

var cases = [
  ["3:00 PM EST", { targetTimeZone: "America/Los_Angeles" }],
  ["ends around 4:30 PM EST.", { targetTimeZone: "America/Los_Angeles" }],
  ["Deploy window: 14:00 UTC to 15:30 UTC.", { targetTimeZone: "America/New_York" }],
  ["Standup at 10:00 AM PST", { targetTimeZone: "Asia/Tokyo" }],
  ["Doors open at 9 PM", { targetTimeZone: "Europe/London", untaggedSource: "America/New_York" }],
  ["already local: 3:00 PM PST", { targetTimeZone: "America/Los_Angeles" }], // PST names the reader's own zone -> nothing added, even though PST=-8 and PDT=-7 differ
  ["Meeting at 5 EST members only", { targetTimeZone: "America/Los_Angeles" }], // "5 EST" -> bare, rejected (no min/ampm)
  ["ratio 1:1 and price 3.30", { targetTimeZone: "America/Los_Angeles" }], // no times
  ["date 2026-12-30 not a time", { targetTimeZone: "America/Los_Angeles" }],
  ["9:30am PST and 12:00 PM PST", { targetTimeZone: "America/Los_Angeles" }],
  ["It's 12:00 GMT+2 now", { targetTimeZone: "UTC" }],
  ["untagged local no-op 3:00 PM", { targetTimeZone: "", untaggedSource: "local" }],
  ["two times 3 PM and 5 PM here", { targetTimeZone: "Europe/Paris", untaggedSource: "America/New_York" }],
  ["already shown 3:00 PM PDT skip", { targetTimeZone: "America/Los_Angeles" }],
  ["gmt spacing 14:00 GMT to 15:00 GMT", { targetTimeZone: "America/New_York" }]
];

cases.forEach(function (c) {
  console.log(JSON.stringify(c[0]));
  console.log("   ->", annotate(c[0], base(c[1])));
});

/*
 * Asserted checks for the zone-label rules, which are too easy to get subtly
 * wrong to leave to eyeballing.
 *
 * A generic label ("PT") carries no standard-vs-daylight marker, so it is taken
 * as accurate and resolved through its zone's own rules on the day. And a label
 * naming the reader's own zone earns no annotation at all, in any of its forms.
 */
console.log("\n--- zone labels ---");

var SUMMER = new Date("2026-07-22T12:00:00Z");
var WINTER = new Date("2026-01-15T12:00:00Z");
var failures = 0;

// [text, target zone, instant, expected annotation or null for "nothing added"]
var expectations = [
  // A generic label follows its zone into daylight time. Read as PST this
  // returned 8:00 AM all year — an hour out for eight months of it.
  ["3:00 PM PT", "Asia/Tokyo", SUMMER, "7:00 AM GMT+9"],
  ["3:00 PM PT", "Asia/Tokyo", WINTER, "8:00 AM GMT+9"],
  ["3:00 PM ET", "America/Los_Angeles", SUMMER, "12:00 PM PDT"],
  ["3:00 PM CT", "America/Los_Angeles", SUMMER, "1:00 PM PDT"],
  ["3:00 PM MT", "America/Los_Angeles", SUMMER, "2:00 PM PDT"],

  // The label names the reader's own zone: nothing to add, whichever form it
  // takes and whichever season. "3:00 PM PST (4:00 PM PDT)" was the bug.
  ["3:00 PM PT", "America/Los_Angeles", SUMMER, null],
  ["3:00 PM PST", "America/Los_Angeles", SUMMER, null],
  ["3:00 PM PDT", "America/Los_Angeles", SUMMER, null],
  ["3:00 PM PST", "America/Los_Angeles", WINTER, null],
  ["3:00 PM PDT", "America/Los_Angeles", WINTER, null],
  ["3:00 PM EDT", "America/New_York", WINTER, null],
  ["3:00 PM AEST", "Australia/Sydney", SUMMER, null],

  // UTC/GMT are absolute references, not a name for the reader's zone, so
  // offset equality alone decides them.
  ["14:00 GMT", "Europe/London", SUMMER, "15:00 GMT+1"],
  ["14:00 GMT", "Europe/London", WINTER, null],
  ["14:00 UTC", "America/Los_Angeles", SUMMER, "07:00 PDT"],

  // Unchanged: a specific label still means exactly what it says elsewhere.
  ["3:00 PM PST", "Asia/Tokyo", SUMMER, "8:00 AM GMT+9"]
];

expectations.forEach(function (e) {
  var settings = base({ targetTimeZone: e[1] });
  var res = self.TZCore.scanText(e[0], settings, e[2]);
  var got = res.length ? res[0].annotation.trim().replace(/^\(|\)$/g, "") : null;
  var ok = got === e[3];
  if (!ok) failures++;
  console.log((ok ? "ok   " : "FAIL ") + e[0] + "  [reader " + e[1] + ", " +
    e[2].toISOString().slice(0, 10) + "]  -> " +
    (got === null ? "(nothing added)" : got));
  if (!ok) {
    console.log("       expected " + (e[3] === null ? "(nothing added)" : e[3]));
  }
});

console.log(failures ? "\n" + failures + " failure(s)" : "\nall zone-label checks passed");
process.exit(failures ? 1 : 0);
