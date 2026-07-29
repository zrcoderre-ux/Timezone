# Project workflow

## Merge policy (standing instruction from the repo owner)

**Always merge after completing a code edit.** Finishing the edit is not
finishing the task — close the loop automatically, without waiting to be asked:

1. Commit the work with a descriptive message.
2. Push the branch.
3. Open a pull request into `main`.
4. **Squash merge** it, so `main` stays linear with one commit per task.

Apply this on every task going forward, not just when explicitly requested. Run
the checks below before merging — a red test suite is the one reason to stop and
report back instead of merging.

## Tests

No dependencies; both are plain `node`:

```
node tools/test-core.js      # time parsing, offset math, formatting
node tools/test-content.js   # DOM scanning, on a small hand-rolled DOM shim
```

`test-content.js` exits non-zero on failure. `test-core.js` prints its
conversions for eyeballing, so compare its output against the previous run
rather than trusting the exit code alone.

# Architecture overview

A Chrome MV3 extension that annotates times on a page with the reader's own
zone. Four scripts, loaded as plain globals (no modules):

- `src/tz-data.js` — `TZData`: defaults, and the zone-abbreviation → fixed
  offset table. An abbreviation already encodes standard-vs-daylight (`EST` vs
  `EDT`), so a labelled time needs no DST guessing.
- `src/tz-core.js` — `TZCore`: one master regex, offset math, formatting. No DOM
  access, so it can be reasoned about and tested in isolation. `scanText`
  returns `{ start, end, annotation }` for a string.
- `src/content.js` — the DOM half: finds the text to scan and inserts the
  annotation spans. The original page text is never altered; annotations are
  separate, removable nodes.
- `src/options.js` / `src/popup.js` — settings UI; the options page's live
  preview calls `TZCore.scanText` directly on a string.

## Scanning is per inline RUN, not per text node

The bug this cost us: a rendered time is frequently split across inline
elements. Statuspage (`status.claude.com`) writes

```html
Jul <var data-var='date'>29</var>, <var data-var='year'>2026</var>
  - <var data-var='time'>20:33</var> UTC
```

so the digits and their `UTC` label land in **different text nodes**. Scanning
one text node at a time didn't merely miss the match — it read a bare `20:33` as
an *untagged* time and converted it from the reader's local zone. For a reader
in the target zone that yields nothing at all (the reported symptom); for anyone
else it yields a confidently **wrong** conversion of a UTC timestamp.

`buildRuns` therefore joins each maximal sequence of text nodes uninterrupted by
a block boundary into one string, keeping a slice map back to the nodes. A
match's end offset maps back to a node and the annotation is inserted there,
splitting the node when the time ends mid-node.

Invariants that keep this correct — breaking any of them reintroduces a bug the
tests already cover:

- **A block boundary and `<br>` still end a run.** Otherwise a zone label
  opening the next paragraph is read as the label of the time closing this one.
  `INLINE_TAGS` is the whitelist; anything absent is a boundary.
- **Matches are applied back-to-front.** Inserting splits text nodes, so
  applying low offsets first invalidates the offsets not yet used.
- **Our own annotation spans are opaque markers, never joined in.** Their text
  holds a time of its own, which would re-match. Recording them as markers is
  also what tells a re-scan that the time before one is already done — that is
  the whole idempotency mechanism, and the `MutationObserver` re-scans
  constantly.
- **Runs are all snapshotted before any mutation.** Splitting a node mid-walk
  would disturb a walk still in progress.

## Notes

- Zone abbreviations are inherently ambiguous (`CST`, `IST`); the table picks
  the most common meaning. Explicit `GMT±hh` is always unambiguous.
- The annotation opens with a **non-breaking space** (` `) so the added
  time can never wrap away from the original. Test expectations must use it.
- Bare times with neither minutes nor an am/pm marker (a lone `5`) are ignored
  on purpose — prices, scores, and version numbers.
- Icons are generated: `node tools/gen-icons.js`. Don't hand-edit the PNGs.
