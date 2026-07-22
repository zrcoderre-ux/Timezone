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
  ["already local: 3:00 PM PST", { targetTimeZone: "America/Los_Angeles" }], // PST shown, target LA (PDT) -> offsets differ, should annotate? PST=-8, PDT=-7 differ
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
