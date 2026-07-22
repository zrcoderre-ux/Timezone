/*
 * tz-core.js
 * Pure time-zone logic: find times in text, work out the source offset,
 * convert, and format the result. No DOM access here so the same code can be
 * unit-reasoned about in isolation. Exposes a single global, `TZCore`.
 */
(function (root) {
  "use strict";

  var ABBREV = root.TZData.ABBREV;

  /*
   * One master regex. It matches an hour, an optional ":minutes", an optional
   * am/pm marker, and an optional trailing zone token (either UTC/GMT with an
   * optional signed offset, or a 2–5 letter abbreviation).
   *
   * Groups:
   *   1 hour   2 minute   3 am/pm letter
   *   4 "UTC"/"GMT"/"Z"   5 signed offset after it (e.g. +5, -08:00)
   *   6 bare abbreviation (validated against the table)
   *
   * The leading lookbehind rejects times that are part of a longer number
   * (dates, decimals, ratios). We require either minutes or an am/pm marker so
   * a bare integer never matches.
   */
  var TIME_RE = new RegExp(
    "(?<![\\d.:/-])" +
    "(\\d{1,2})(?::([0-5]\\d))?" +
    "(?:\\s*([ap])\\.?m\\.?)?" +
    "(?:" +
      "\\s*\\b(UTC|GMT|Z)\\b(?:\\s*([+-]\\d{1,2}(?::?\\d{2})?))?" +
      "|\\s+([A-Za-z]{2,5})\\b" +
    ")?",
    "gi"
  );

  // Parse a "+5", "-08:00", "+0530" style offset into minutes east of UTC.
  function parseSignedOffset(str) {
    if (!str) return 0;
    var m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(str.trim());
    if (!m) return 0;
    var sign = m[1] === "-" ? -1 : 1;
    var h = parseInt(m[2], 10);
    var mi = m[3] ? parseInt(m[3], 10) : 0;
    return sign * (h * 60 + mi);
  }

  // Offset (minutes east of UTC) of an IANA zone at a given instant.
  function ianaOffsetMinutes(timeZone, date) {
    var dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    var parts = dtf.formatToParts(date);
    var m = {};
    for (var i = 0; i < parts.length; i++) m[parts[i].type] = parts[i].value;
    var hour = parseInt(m.hour, 10);
    if (hour === 24) hour = 0; // some engines emit 24 for midnight
    var asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  }

  // UTC instant (ms) for a wall-clock time interpreted in an IANA zone.
  function wallToInstantIana(y, mo, d, h, mi, zone) {
    var guess = Date.UTC(y, mo, d, h, mi);
    var off = ianaOffsetMinutes(zone, new Date(guess));
    var inst = guess - off * 60000;
    // Refine once to settle DST transitions near the boundary.
    off = ianaOffsetMinutes(zone, new Date(inst));
    return guess - off * 60000;
  }

  // Short zone name (e.g. "PST", "GMT+2") for an instant in an IANA zone.
  function shortZoneName(instant, zone) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hour: "numeric", timeZoneName: "short"
    }).formatToParts(new Date(instant));
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "timeZoneName") return parts[i].value;
    }
    return "";
  }

  /*
   * Inspect a single regex match and decide whether it is a real, convertible
   * time. Returns a descriptor or null.
   */
  function interpretMatch(match, opts) {
    var hourStr = match[1];
    var minStr = match[2];
    var ap = match[3];
    var utcTok = match[4];
    var utcOff = match[5];
    var abbrevTok = match[6];

    var hasMinutes = minStr !== undefined;
    var hasAmPm = ap !== undefined;
    // Reject bare integers with no ":mm" and no am/pm (avoids "3 EST" etc.).
    if (!hasMinutes && !hasAmPm) return null;

    var hour = parseInt(hourStr, 10);
    var minute = hasMinutes ? parseInt(minStr, 10) : 0;
    var origHour12 = hasAmPm;

    if (hasAmPm) {
      if (hour < 1 || hour > 12) return null;
      var pm = ap.toLowerCase() === "p";
      if (pm && hour !== 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    } else {
      if (hour > 23) return null;
    }
    if (minute > 59) return null;

    // Work out the displayed source zone, if any.
    var srcOffset = null;      // fixed offset in minutes, when known from text
    var displayedName = null;  // the zone token as written on the page
    if (utcTok) {
      displayedName = (match[0].match(/\b(?:UTC|GMT|Z)\b\s*[+-]?\d*(?::?\d{2})?/i) || [utcTok])[0].trim();
      srcOffset = parseSignedOffset(utcOff);
    } else if (abbrevTok) {
      var key = abbrevTok.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(ABBREV, key)) {
        srcOffset = ABBREV[key];
        displayedName = abbrevTok;
      } else {
        // Trailing letters weren't a zone; treat the time as untagged and
        // trim the token back off the match so we don't consume it.
        var trimmed = match[0].replace(/\s+[A-Za-z]{2,5}$/, "");
        match[0] = trimmed;
      }
    }

    return {
      matchText: match[0],
      index: match.index,
      hour: hour,
      minute: minute,
      origHour12: origHour12,
      srcOffset: srcOffset,      // null => untagged
      displayedName: displayedName
    };
  }

  /*
   * Given a descriptor and settings, produce the annotation string to add,
   * or null if nothing should be added (same zone, or already displayed).
   */
  function buildAnnotation(desc, settings, now) {
    var target = settings.targetTimeZone;
    if (!target) return null;

    var y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate();
    // Anchor bare times to "today" in the target zone so the date used for
    // DST/offset lookups is sensible for the reader.
    var todayParts = new Intl.DateTimeFormat("en-US", {
      timeZone: target, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now);
    var tp = {};
    for (var i = 0; i < todayParts.length; i++) tp[todayParts[i].type] = todayParts[i].value;
    y = +tp.year; mo = +tp.month - 1; d = +tp.day;

    var instant, srcOffset;
    if (desc.srcOffset !== null) {
      srcOffset = desc.srcOffset;
      instant = Date.UTC(y, mo, d, desc.hour, desc.minute) - srcOffset * 60000;
    } else {
      if (!settings.convertUntagged) return null;
      var srcZone = settings.untaggedSource === "local"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : settings.untaggedSource;
      instant = wallToInstantIana(y, mo, d, desc.hour, desc.minute, srcZone);
      srcOffset = ianaOffsetMinutes(srcZone, new Date(instant));
    }

    var targetOffset = ianaOffsetMinutes(target, new Date(instant));
    // Same wall-clock time in both zones -> nothing to add.
    if (targetOffset === srcOffset) return null;

    var targetShort = shortZoneName(instant, target);
    // The target zone is already shown right here -> nothing to add.
    if (desc.displayedName &&
        desc.displayedName.replace(/\s+/g, "").toUpperCase() ===
          targetShort.replace(/\s+/g, "").toUpperCase()) {
      return null;
    }

    var use12;
    if (settings.hourFormat === "12") use12 = true;
    else if (settings.hourFormat === "24") use12 = false;
    else use12 = desc.origHour12; // auto: mirror the original

    var fmtOpts = { timeZone: target, hour: "numeric", minute: "2-digit", hour12: use12 };
    if (settings.showZoneName) fmtOpts.timeZoneName = "short";
    var text = new Intl.DateTimeFormat(undefined, fmtOpts).format(new Date(instant));

    if (settings.wrap === "bracket") return " [" + text + "]";
    if (settings.wrap === "space") return " " + text;
    return " (" + text + ")"; // paren (default)
  }

  /*
   * Scan a string and return an array of { start, end, annotation } for every
   * time that should be annotated. Non-overlapping, left to right.
   */
  function scanText(text, settings, now) {
    var results = [];
    TIME_RE.lastIndex = 0;
    var m;
    while ((m = TIME_RE.exec(text)) !== null) {
      if (m[0].length === 0) { TIME_RE.lastIndex++; continue; }
      var desc = interpretMatch(m, settings);
      if (!desc) continue;
      // interpretMatch may have trimmed a trailing non-zone token; recompute
      // the real end from the (possibly shortened) match text.
      var start = desc.index;
      var end = start + desc.matchText.length;
      var annotation = buildAnnotation(desc, settings, now);
      if (annotation) {
        results.push({ start: start, end: end, annotation: annotation });
        // Continue scanning from the true end of the consumed time.
        TIME_RE.lastIndex = end;
      }
    }
    return results;
  }

  root.TZCore = {
    scanText: scanText,
    // Exposed for the options page live preview / debugging.
    _interpretMatch: interpretMatch,
    _buildAnnotation: buildAnnotation,
    _ianaOffsetMinutes: ianaOffsetMinutes,
    TIME_RE: TIME_RE
  };
})(typeof self !== "undefined" ? self : this);
