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

/*
 * Asserted checks for the range rules. The reported case was an email's
 * opening hours: "We are open Monday-Friday 7 AM to 9 PM CST". The label
 * closes the range, so "7 AM" was read as an untagged time — nothing at all
 * for a reader in the target zone, and a wrong conversion of a Central time
 * for everyone else.
 *
 * `untaggedSource` is pinned to UTC here so the cases that deliberately leave
 * a time untagged don't depend on the machine's own zone.
 */
console.log("\n--- ranges ---");

function annotateAt(text, settings, instant) {
  var res = self.TZCore.scanText(text, settings, instant);
  var out = "", cursor = 0;
  res.forEach(function (r) {
    out += text.slice(cursor, r.end) + "«" + r.annotation.trim() + "»";
    cursor = r.end;
  });
  return out + text.slice(cursor);
}

// [text, reader zone, instant, expected annotated text]
var rangeCases = [
  // The report itself, in both seasons. 7 AM CST is 13:00 UTC either way; the
  // reader's own zone is what moves.
  ["We are open Monday-Friday 7 AM to 9 PM CST, Saturday and Sunday 8 am to 4:30 pm CST.",
   "America/Los_Angeles", SUMMER,
   "We are open Monday-Friday 7 AM«(6:00 AM PDT)» to 9 PM CST«(8:00 PM PDT)», " +
   "Saturday and Sunday 8 am«(7:00 AM PDT)» to 4:30 pm CST«(3:30 PM PDT)»."],
  ["We are open Monday-Friday 7 AM to 9 PM CST.", "America/Los_Angeles", WINTER,
   "We are open Monday-Friday 7 AM«(5:00 AM PST)» to 9 PM CST«(7:00 PM PST)»."],

  // The other connectors, including the closed-up form business hours are
  // usually written in.
  ["Office hours 9 AM - 5 PM EST", "America/Los_Angeles", SUMMER,
   "Office hours 9 AM«(7:00 AM PDT)» - 5 PM EST«(3:00 PM PDT)»"],
  ["Hours: 9AM-5PM CST", "America/Los_Angeles", SUMMER,
   "Hours: 9AM«(8:00 AM PDT)»-5PM CST«(4:00 PM PDT)»"],
  ["Hours: 9 AM \u2013 5 PM CST", "America/Los_Angeles", SUMMER,
   "Hours: 9 AM«(8:00 AM PDT)» \u2013 5 PM CST«(4:00 PM PDT)»"],
  ["shift 7 to 8 to 9 PM CST", "America/Los_Angeles", SUMMER,
   "shift 7«(6:00 PM PDT)» to 8«(7:00 PM PDT)» to 9 PM CST«(8:00 PM PDT)»"],

  // A closing am/pm marker carries back over the range...
  ["Call between 7:00 and 9:00 PM EST", "America/Los_Angeles", SUMMER,
   "Call between 7:00«(5:00 PM PDT)» and 9:00 PM EST«(7:00 PM PDT)»"],
  // ...unless that would open the range after it closes, when the range
  // crosses noon instead.
  ["Open 11:00 to 1:00 PM EST", "America/Los_Angeles", SUMMER,
   "Open 11:00«(9:00 AM PDT)» to 1:00 PM EST«(11:00 AM PDT)»"],
  // 12:30 pm is 12:30, not 00:30, so this range does not cross.
  ["Open 12:30 to 2:00 PM EST", "America/Los_Angeles", SUMMER,
   "Open 12:30«(10:30 AM PDT)» to 2:00 PM EST«(12:00 PM PDT)»"],
  // 24-hour ends have no marker to share; the label still carries.
  ["Deploy 14:00 to 16:00 CST", "America/Los_Angeles", SUMMER,
   "Deploy 14:00«(13:00 PDT)» to 16:00 CST«(15:00 PDT)»"],

  // A marker is what revives a bare end: "7 to 9 PM ET" is a time, "9 to 5"
  // on its own is not, and a bare closing end lends nothing.
  ["Webinar 7 to 9 PM ET", "America/Los_Angeles", SUMMER,
   "Webinar 7«(4:00 PM PDT)» to 9 PM ET«(6:00 PM PDT)»"],
  ["We are open 9 to 5 CST", "America/Los_Angeles", SUMMER,
   "We are open 9 to 5 CST"],

  // Forwards, the zone label alone: "from 9 AM CST to 5 PM".
  ["from 9 AM CST to 5 PM", "America/Los_Angeles", SUMMER,
   "from 9 AM CST«(8:00 AM PDT)» to 5 PM«(4:00 PM PDT)»"],

  // A label naming the reader's own zone still earns no annotation, at either
  // end of the range.
  ["Webinar 7 to 9 PM PT", "America/Los_Angeles", SUMMER,
   "Webinar 7 to 9 PM PT"],

  // Two times joined by more than a connector are two times: the label on the
  // closing one says nothing about the opening one, which stays untagged.
  ["we open at 8 am and close at 5 pm CST", "America/Los_Angeles", SUMMER,
   "we open at 8 am«(1:00 AM PDT)» and close at 5 pm CST«(4:00 PM PDT)»"],

  // Still not times. The hyphen rule now admits "5PM" in "9AM-5PM", so the
  // numeric shapes it used to reject wholesale are worth re-asserting.
  ["date 2026-12-30 not a time", "America/Los_Angeles", SUMMER,
   "date 2026-12-30 not a time"],
  ["ratio 1:1 and price 3.30", "America/Los_Angeles", SUMMER,
   "ratio 1:1 and price 3.30"],
  ["scores 5-4 and 3-2 last night", "America/Los_Angeles", SUMMER,
   "scores 5-4 and 3-2 last night"],
  ["server zone is GMT-08:00 today", "America/Los_Angeles", SUMMER,
   "server zone is GMT-08:00 today"],
  ["call 1-800-555-1212 at 3 PM CST", "America/Los_Angeles", SUMMER,
   "call 1-800-555-1212 at 3 PM CST«(2:00 PM PDT)»"]
];

rangeCases.forEach(function (c) {
  var settings = base({ targetTimeZone: c[1], untaggedSource: "UTC" });
  var got = annotateAt(c[0], settings, c[2]);
  var ok = got === c[3];
  if (!ok) failures++;
  console.log((ok ? "ok   " : "FAIL ") + JSON.stringify(c[0]) +
    "  [reader " + c[1] + ", " + c[2].toISOString().slice(0, 10) + "]");
  if (!ok) {
    console.log("       expected: " + JSON.stringify(c[3]));
    console.log("       got:      " + JSON.stringify(got));
  }
});

console.log(failures ? "\n" + failures + " failure(s)" : "\nall asserted checks passed");
process.exit(failures ? 1 : 0);
