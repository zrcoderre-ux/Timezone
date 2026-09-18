/*
 * tz-core.js
 * Pure time-zone logic: find times in text, work out the source offset,
 * convert, and format the result. No DOM access here so the same code can be
 * unit-reasoned about in isolation. Exposes a single global, `TZCore`.
 */
(function (root) {
  "use strict";

  var ABBREV = root.TZData.ABBREV;
  var ABBREV_ZONE = root.TZData.ABBREV_ZONE;

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
   * The leading lookbehinds reject times that are part of a longer number:
   * a preceding digit, dot, colon or slash (decimals, ratios, ISO dates), a
   * hyphen that itself follows a digit ("2026-12-30"), and a signed UTC/GMT
   * offset ("GMT-08:00", whose "08:00" is not a second time). A hyphen after a
   * *letter* is left alone so the closing half of "9AM-5PM CST" can match —
   * the range pass below is what gives it its zone. We require either minutes
   * or an am/pm marker so a bare integer never matches on its own.
   */
  var TIME_RE = new RegExp(
    "(?<![\\d.:/])(?<!\\d-)(?<!\\b(?:UTC|GMT|Z)\\s*[+-])" +
    "(\\d{1,2})(?::([0-5]\\d))?" +
    "(?:\\s*([ap])\\.?m\\.?)?" +
    "(?:" +
      "\\s*\\b(UTC|GMT|Z)\\b(?:\\s*([+-]\\d{1,2}(?::?\\d{2})?))?" +
      "|\\s+([A-Za-z]{2,5})\\b" +
    ")?",
    "gi"
  );

  /*
   * Text that can sit between the two ends of one range and nothing more: a
   * dash, "to", "until", "and". Extra words mean two separate times ("we open
   * at 8 am and close at 5 pm CST"), so only a bare connector counts.
   *
   * \u2010-\u2015 are the hyphen, non-breaking hyphen, figure dash, en dash,
   * em dash and horizontal bar.
   */
  var RANGE_GAP_RE =
    /^\s*(?:[-\u2010-\u2015]|to|until|till|thru|through|and|or|&)\s*$/i;

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

  function normalizeZoneName(name) {
    return String(name || "").replace(/\s+/g, "").toUpperCase();
  }

  var HALF_YEAR_MS = 182 * 24 * 60 * 60000;

  /*
   * Every label the target zone answers to: its standard name, its daylight
   * name, and the generic form beside them ("PT" for PST/PDT). Sampling half a
   * year either side of the instant picks up both seasons.
   *
   * This is what decides whether a label names *the reader's own zone*, which
   * is a different question from whether the offsets happen to coincide. A
   * Pacific reader gains nothing from "3:00 PM PST (4:00 PM PDT)" — the page
   * means local time and the annotation just shifts it an hour.
   */
  function zoneAliases(zone, instant) {
    var out = {};
    var samples = [instant - HALF_YEAR_MS, instant, instant + HALF_YEAR_MS];
    for (var i = 0; i < samples.length; i++) {
      var name = normalizeZoneName(shortZoneName(samples[i], zone));
      if (!name) continue;
      out[name] = true;
      // PST/PDT -> PT, EST/EDT -> ET, AKST/AKDT -> AKT, AEST/AEDT -> AET.
      var generic = /^([A-Z]{1,3})[SD]T$/.exec(name);
      if (generic) out[generic[1] + "T"] = true;
    }
    return out;
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
    var rawHour = parseInt(hourStr, 10);
    var minute = hasMinutes ? parseInt(minStr, 10) : 0;

    if (hasAmPm) {
      if (rawHour < 1 || rawHour > 12) return null;
    } else if (rawHour > 23) {
      return null;
    }
    if (minute > 59) return null;

    // Work out the displayed source zone, if any.
    var srcOffset = null;      // fixed offset in minutes, when known from text
    var srcZone = null;        // IANA zone, when the label is a generic one
    var srcAbbrev = null;      // the regional abbreviation, uppercased
    var displayedName = null;  // the zone token as written on the page
    if (utcTok) {
      displayedName = (match[0].match(/\b(?:UTC|GMT|Z)\b\s*[+-]?\d*(?::?\d{2})?/i) || [utcTok])[0].trim();
      srcOffset = parseSignedOffset(utcOff);
    } else if (abbrevTok) {
      var key = abbrevTok.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(ABBREV_ZONE, key)) {
        // A generic label: accurate as written, so let the zone's own DST
        // rules pick the offset rather than assuming standard time.
        srcZone = ABBREV_ZONE[key];
        srcAbbrev = key;
        displayedName = abbrevTok;
      } else if (Object.prototype.hasOwnProperty.call(ABBREV, key)) {
        srcOffset = ABBREV[key];
        srcAbbrev = key;
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
      rawHour: rawHour,          // as written, before am/pm is applied
      minute: minute,
      meridiem: hasAmPm ? ap.toLowerCase() : null, // "a", "p", or null
      /*
       * A bare integer with neither minutes nor an am/pm marker is not a time
       * on its own — prices, scores and version numbers all look like one. It
       * is kept as a *candidate* rather than dropped here only so the range
       * pass can revive it when a trailing marker qualifies it ("7 to 9 PM");
       * scanText discards whatever is still bare afterwards.
       */
      bare: !hasMinutes && !hasAmPm,
      srcOffset: srcOffset,      // null => not a fixed-offset label
      srcZone: srcZone,          // set for a generic label ("PT")
      srcAbbrev: srcAbbrev,      // set for any regional label, not UTC/GMT/Z
      displayedName: displayedName
    };
  }

  // --- Ranges --------------------------------------------------------------

  // Hour of the day, once an am/pm marker (if any) is applied.
  function hour24(rawHour, meridiem) {
    if (!meridiem) return rawHour;
    var h = rawHour % 12; // 12 am -> 0, 12 pm -> 12
    return meridiem === "p" ? h + 12 : h;
  }

  function hasZoneLabel(desc) {
    return desc.srcOffset !== null || desc.srcZone !== null;
  }

  function copyZoneLabel(from, to) {
    to.srcOffset = from.srcOffset;
    to.srcZone = from.srcZone;
    to.srcAbbrev = from.srcAbbrev;
    to.displayedName = from.displayedName;
  }

  // Nothing but a range connector between the two matches?
  function isRangeGap(text, left, right) {
    var gap = text.slice(left.index + left.matchText.length, right.index);
    return RANGE_GAP_RE.test(gap);
  }

  /*
   * Which half of the day the opening end of a range belongs to, given the
   * marker written on the closing end. A range runs forwards, so the marker
   * ordinarily carries straight over ("7:00 to 9:00 PM" opens at 7 PM); when
   * that would put the opening time *after* the closing one the range crosses
   * over instead, and the opening time takes the other half ("11:00 to 1:00 PM"
   * opens at 11 AM). Returns null if the hour cannot be read on a 12-hour
   * clock at all, in which case no marker is inherited.
   */
  function inheritedMeridiem(left, right) {
    if (left.rawHour < 1 || left.rawHour > 12) return null;
    var endMinutes = hour24(right.rawHour, right.meridiem) * 60 + right.minute;
    var sameHalf = hour24(left.rawHour, right.meridiem) * 60 + left.minute;
    if (sameHalf <= endMinutes) return right.meridiem;
    return right.meridiem === "p" ? "a" : "p";
  }

  /*
   * "We are open Monday-Friday 7 AM to 9 PM CST": the label closing a range
   * qualifies both of its ends, but the regex only ever sees it attached to the
   * time it follows. Read alone, "7 AM" is an *untagged* time — the Statuspage
   * bug in another costume. For a reader whose own zone is the target that
   * yields nothing (the reported symptom: email opening hours picked up a
   * conversion on one end of the range and not the other); for anyone else it
   * yields a confidently wrong conversion of a Central time.
   *
   * So where two matched times are joined by nothing but a range connector,
   * each lends the other the qualifiers it lacks:
   *
   *   - backwards, the am/pm marker and the zone label, which is how an
   *     English range is written ("7 to 9 PM CST" labels only its close);
   *   - forwards, the zone label alone ("from 9 AM CST to 5 PM"). A marker is
   *     not carried forwards: "9 AM to 5" is not how a range is written, and
   *     guessing one would invent the half of the day it names.
   *
   * A marker inherited backwards is also what revives a bare integer end: "7"
   * alone is a price or a score, but "7 to 9 PM" is a time. With no minutes and
   * no marker to inherit it stays ignored, so "9 to 5 CST" still annotates
   * neither end.
   */
  function shareRangeQualifiers(descs, text) {
    var i, left, right;
    // Backwards first, so a closing marker carries down a chain of ranges.
    for (i = descs.length - 2; i >= 0; i--) {
      left = descs[i];
      right = descs[i + 1];
      // A bare end has nothing to lend and cannot be read as a time itself.
      if (right.bare || !isRangeGap(text, left, right)) continue;
      if (left.meridiem === null && right.meridiem !== null) {
        var meridiem = inheritedMeridiem(left, right);
        if (meridiem) {
          left.meridiem = meridiem;
          left.bare = false;
        }
      }
      if (!left.bare && !hasZoneLabel(left) && hasZoneLabel(right)) {
        copyZoneLabel(right, left);
      }
    }
    // Then forwards, for the zone label only.
    for (i = 1; i < descs.length; i++) {
      left = descs[i - 1];
      right = descs[i];
      if (left.bare || right.bare || !isRangeGap(text, left, right)) continue;
      if (!hasZoneLabel(right) && hasZoneLabel(left)) copyZoneLabel(left, right);
    }
  }

  /*
   * Given a descriptor and settings, produce the annotation string to add,
   * or null if nothing should be added (same zone, or already displayed).
   */
  function buildAnnotation(desc, settings, now) {
    var target = settings.targetTimeZone;
    if (!target) return null;

    // Resolved here rather than at match time: a range can lend its opening
    // end the am/pm marker written on its close, which moves the hour.
    var hour = hour24(desc.rawHour, desc.meridiem);
    var origHour12 = desc.meridiem !== null;

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
      instant = Date.UTC(y, mo, d, hour, desc.minute) - srcOffset * 60000;
    } else if (desc.srcZone) {
      // A generic label ("PT") — taken as accurate, so its offset comes from
      // the zone's rules on the day, not from an assumed standard time. This is
      // a labelled time, so `convertUntagged` doesn't gate it.
      instant = wallToInstantIana(y, mo, d, hour, desc.minute, desc.srcZone);
      srcOffset = ianaOffsetMinutes(desc.srcZone, new Date(instant));
    } else {
      if (!settings.convertUntagged) return null;
      var untagged = settings.untaggedSource === "local"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : settings.untaggedSource;
      instant = wallToInstantIana(y, mo, d, hour, desc.minute, untagged);
      srcOffset = ianaOffsetMinutes(untagged, new Date(instant));
    }

    var targetOffset = ianaOffsetMinutes(target, new Date(instant));
    // Same wall-clock time in both zones -> nothing to add.
    if (targetOffset === srcOffset) return null;

    /*
     * The label already names the reader's own zone -> nothing to add, even
     * though the offsets differ. "3:00 PM PST" read in Pacific means local
     * time; annotating it "(4:00 PM PDT)" shifts a local time by an hour and
     * reads as a second, contradictory time. Any of the zone's own labels
     * count — standard, daylight, or generic.
     *
     * Scoped to regional abbreviations. UTC/GMT/Z are absolute references
     * rather than a name for somewhere, so "14:00 GMT" still earns its
     * "(15:00 BST)" for a London reader; offset equality alone decides those.
     */
    if (desc.srcAbbrev && zoneAliases(target, instant)[desc.srcAbbrev]) {
      return null;
    }

    var targetShort = shortZoneName(instant, target);
    // The target zone is already shown right here -> nothing to add.
    if (desc.displayedName &&
        normalizeZoneName(desc.displayedName) === normalizeZoneName(targetShort)) {
      return null;
    }

    var use12;
    if (settings.hourFormat === "12") use12 = true;
    else if (settings.hourFormat === "24") use12 = false;
    else use12 = origHour12; // auto: mirror the original

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
    // Collect every candidate first: whether one end of a range is a time at
    // all, and which time, can depend on the end that follows it.
    var descs = [];
    TIME_RE.lastIndex = 0;
    var m;
    while ((m = TIME_RE.exec(text)) !== null) {
      if (m[0].length === 0) { TIME_RE.lastIndex++; continue; }
      var desc = interpretMatch(m, settings);
      if (!desc) continue;
      // interpretMatch may have trimmed a trailing non-zone token off the
      // match; resume from the real end of the time so the trimmed text — a
      // range connector, as often as not — is still there to be read.
      TIME_RE.lastIndex = desc.index + desc.matchText.length;
      descs.push(desc);
    }

    shareRangeQualifiers(descs, text);

    var results = [];
    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      if (d.bare) continue; // a lone integer: price, score, version number
      var annotation = buildAnnotation(d, settings, now);
      if (annotation) {
        results.push({
          start: d.index,
          end: d.index + d.matchText.length,
          annotation: annotation
        });
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
