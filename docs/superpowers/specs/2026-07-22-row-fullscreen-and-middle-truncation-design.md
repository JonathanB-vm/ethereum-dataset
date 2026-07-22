# Row fullscreen preview + middle truncation for long values

Date: 2026-07-22
Status: approved

## Problem

1. A row's 35-field detail panel can only be read inline under its table row; there is no
   way to give one record the whole screen the way the table itself has (`table-card--fullscreen`).
2. `RowDetail` renders every raw value in full. Long blobs (`input_tx` calldata,
   `access_list_tx`, signature components) wrap over many lines and blow the panel up.

## Decisions (user-confirmed)

- Per-row fullscreen button lives **next to the expand chevron** in every row (always
  visible, one click), not inside the expanded panel.
- Long values are **truncated everywhere** (inline panel and fullscreen alike); the copy
  button always copies the complete value.

## Design

### 1. Per-row fullscreen preview

- `DataTable.tsx` owns `fullscreenRow: EthRecord | null`. Nothing outside the table
  participates, so the state does not live in App.
- Each row's expander cell gets a second icon button (small corner-bracket expand glyph,
  same family as `FullscreenToggle`) beside the chevron. `aria-label`/`title`:
  "View row details full screen". Expander column widens to fit both.
- Clicking opens a fullscreen overlay: `position: fixed; inset: 0` on `--bg`,
  `role="dialog"` + `aria-modal="true"`, z-index above `table-card--fullscreen` (15).
  Header bar: title "Row details" + the row's truncated tx hash (mono), close ✕.
  Body: the existing `RowDetail` component — same one the inline expand renders.
- Overlay contract matches the app's other overlays: Esc closes (the overlay is a
  `role="dialog"`, so App's table-fullscreen Esc handler already defers to it), body
  scroll lock saves/restores the previous inline `overflow` value (so it never clobbers
  App's own lock when table fullscreen is active underneath), and focus returns to the
  button that opened it.

### 2. Middle truncation

- New `truncateMiddle(value, head = 24, tail = 12)` in `src/data/transform.ts`, beside
  `truncateHex` and sharing its `…` convention and its "don't truncate when nothing is
  saved" guard (`length <= head + tail + 1` returns the value unchanged).
- `RowDetail.tsx` applies it to every raw value — no per-field list to maintain. Full
  value remains available via the value's `title` attribute and `CopyButton` (which keeps
  receiving the untruncated raw string).

## Not changing

Table cells (already truncate), CSV export (always full values), filters, dictionary panel.

## Testing

- `transform.test.ts`: `truncateMiddle` unit tests (short passthrough, boundary length,
  long-value shape, `…` savings guard).
- Existing suite must stay green; production build must pass.
