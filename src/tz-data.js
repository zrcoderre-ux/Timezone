/*
 * tz-data.js
 * Shared constants used by the content script, options page, popup and
 * service worker. Loaded as a plain script (no modules) so everything is
 * attached to a single global object, `TZData`, to avoid polluting the page.
 */
(function (root) {
  "use strict";

  // Default settings, also the single source of truth for storage defaults.
  var DEFAULTS = {
    enabled: true,
    // IANA name of the zone to add next to times. Empty string means
    // "use the browser's local zone", resolved at run time.
    targetTimeZone: "",
    // Convert times that carry no explicit zone label, assuming they are in
    // the source zone below.
    convertUntagged: true,
    // Source zone for untagged times. "local" = the browser's zone, or an
    // IANA name to assume a fixed source.
    untaggedSource: "local",
    // Output hour format: "auto" mirrors the original time, else "12"/"24".
    hourFormat: "auto",
    // Show the short zone name (e.g. "PST") in the added time.
    showZoneName: true,
    // How the added time is wrapped: "paren" -> (…), "bracket" -> […],
    // "space" -> a plain leading space.
    wrap: "paren",
    // Visual treatment of the added text: "muted" (subtle, discoverable) or
    // "plain" (identical to surrounding text).
    style: "muted"
  };

  /*
   * Fixed UTC offsets, in minutes east of UTC, for common zone abbreviations.
   * A zone abbreviation already encodes standard-vs-daylight (EST vs EDT), so
   * a fixed offset is the correct interpretation of a labelled time — no DST
   * guessing is needed for the source. Ambiguous abbreviations (CST, IST, …)
   * use the most common meaning; users relying on those can also lean on the
   * explicit GMT/UTC±hh forms which are always unambiguous.
   */
  var ABBREV = {
    UTC: 0, GMT: 0, Z: 0, ZULU: 0, WET: 0, UT: 0,
    // North America
    EST: -300, EDT: -240,
    CST: -360, CDT: -300,
    MST: -420, MDT: -360,
    PST: -480, PDT: -420,
    AKST: -540, AKDT: -480,
    HST: -600, HAST: -600, HADT: -540,
    AST: -240, ADT: -180, NST: -210, NDT: -150,
    // South America
    ART: -180, BRT: -180, BRST: -120, CLT: -240, CLST: -180,
    // Europe / Africa
    BST: 60, IST: 330, WEST: 60,
    CET: 60, CEST: 120, EET: 120, EEST: 180,
    MSK: 180, WAT: 60, CAT: 120, EAT: 180, SAST: 120,
    // Asia
    GST: 240, PKT: 300, BDT: 360, ICT: 420,
    WIB: 420, HKT: 480, SGT: 480,
    JST: 540, KST: 540,
    // Oceania
    AWST: 480, ACST: 570, ACDT: 630,
    AEST: 600, AEDT: 660, NZST: 720, NZDT: 780
  };

  /*
   * Generic regional abbreviations, mapped to an IANA zone rather than a fixed
   * offset. Unlike PST/PDT these carry no standard-vs-daylight marker, so "PT"
   * means whatever Pacific time actually is on the day in question — treat the
   * label as accurate and let the zone's own rules decide the offset. Reading
   * "PT" as PST put every summer conversion an hour out.
   *
   * "MT" resolves through Denver, not Phoenix: Arizona keeps standard time all
   * year, but Denver is what "Mountain Time" ordinarily means, in keeping with
   * the most-common-meaning rule above.
   *
   * Only forms already recognised are listed. Notably absent is "AT": upper-
   * cased it collides with the English word, and the matcher case-folds, so
   * "meeting 3:00 at the office" would read "at" as a zone.
   */
  var ABBREV_ZONE = {
    ET: "America/New_York",
    CT: "America/Chicago",
    MT: "America/Denver",
    PT: "America/Los_Angeles"
  };

  // A curated fallback list of IANA zones, used only when the runtime does
  // not expose Intl.supportedValuesOf("timeZone").
  var COMMON_ZONES = [
    "UTC",
    "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles",
    "America/Denver", "America/Phoenix", "America/Chicago",
    "America/New_York", "America/Toronto", "America/Sao_Paulo",
    "Europe/London", "Europe/Lisbon", "Europe/Madrid", "Europe/Paris",
    "Europe/Berlin", "Europe/Rome", "Europe/Athens", "Europe/Moscow",
    "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos",
    "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka",
    "Asia/Bangkok", "Asia/Shanghai", "Asia/Singapore", "Asia/Hong_Kong",
    "Asia/Tokyo", "Asia/Seoul",
    "Australia/Perth", "Australia/Sydney", "Pacific/Auckland"
  ];

  root.TZData = {
    DEFAULTS: DEFAULTS,
    ABBREV: ABBREV,
    ABBREV_ZONE: ABBREV_ZONE,
    COMMON_ZONES: COMMON_ZONES,
    // Merge stored values over defaults, ignoring unknown keys.
    withDefaults: function (stored) {
      var out = {};
      for (var k in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
          out[k] = (stored && stored[k] !== undefined) ? stored[k] : DEFAULTS[k];
        }
      }
      return out;
    }
  };
})(typeof self !== "undefined" ? self : this);
