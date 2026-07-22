# Timezone Companion

A Chrome extension (Manifest V3) that shows **your** time zone next to any time
displayed on a web page — but only when that zone isn't already shown. The
converted time is inserted right next to the original, inheriting the page's
font, so it reads naturally:

> The webinar starts at **3:00 PM EST (12:00 PM PST)**.

The original page text is never modified. Each converted time is a separate,
removable annotation.

## What it does

- Scans page text for times such as `3:00 PM`, `15:00`, `9:30am PST`,
  `14:00 UTC`, and `12:00 GMT+2`.
- Works out the source zone:
  - **Labelled times** (e.g. `EST`, `PST`, `UTC`, `GMT+2`) are read at the
    offset that label denotes.
  - **Unlabelled times** are assumed to be in a source zone you choose
    (your browser's local zone by default). This can be turned off.
- Converts to your chosen target zone and inserts it beside the original.
- Skips the annotation when there's nothing to add — the two zones share the
  same offset, or the target zone is already displayed on that time.
- Handles dynamically-loaded content via a `MutationObserver`, and re-renders
  instantly when you change settings.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the extension's **Details → Extension options** (or the toolbar icon →
   *Settings & time zone…*) to pick your zone.

## Options

| Setting | Description |
| --- | --- |
| **Your time zone** | The zone times are converted into. Defaults to your browser's local zone. |
| **Convert times without a zone label** | Whether to also convert bare times like `3:00 PM`. |
| **Assume unlabelled times are in** | The source zone used for those bare times. |
| **Hour format** | Match the original, or force 12-/24-hour. |
| **Show zone name** | Include the short zone name (e.g. `PST`). |
| **Wrap style** | `(parens)`, `[brackets]`, or a plain space. |
| **Appearance** | Slightly dimmed (easy to spot) or identical to page text. |

Settings are stored with `chrome.storage.sync`, so they follow your Chrome
profile.

## Project layout

```
manifest.json        MV3 manifest
src/tz-data.js        Defaults + zone-abbreviation offset table (shared)
src/tz-core.js        Time parsing, offset math, formatting (no DOM)
src/content.js        DOM scanning + annotation + mutation handling
src/options.html/.css/.js   Options page with a live preview
src/popup.html/.js    Toolbar popup (quick enable/disable)
src/background.js     Service worker (seeds default settings)
icons/                Generated PNG icons
tools/gen-icons.js    Regenerates the icons (no dependencies)
tools/test-core.js    Ad-hoc checks for the conversion core
```

Run `node tools/test-core.js` to sanity-check the conversion logic, or
`node tools/gen-icons.js` to regenerate the icons.

## Notes & limitations

- Zone abbreviations are inherently ambiguous (e.g. `CST`, `IST`). The table in
  `src/tz-data.js` uses the most common meaning; explicit `GMT±hh` forms are
  always unambiguous.
- Bare times without minutes or an am/pm marker (e.g. a lone `5`) are ignored to
  avoid false positives on prices, scores, and version numbers.
- Times are anchored to "today" in the target zone for daylight-saving lookups.
