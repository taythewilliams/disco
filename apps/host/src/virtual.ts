/**
 * Row windowing for the library list (D10).
 *
 * The library is thousands of tracks, and rendering thousands of rows is what
 * makes a dashboard unusable at 2 000 of them. Only the rows on screen exist in
 * the DOM; the rest is a spacer of the right height, so the scrollbar still
 * tells the truth.
 *
 * Pure, and separate from the component, because the awkward parts are all
 * arithmetic: an empty list, a viewport taller than the content, a scroll
 * position past the end after a search narrows the results.
 */

export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  /** Rows rendered beyond each edge, so a fast scroll does not show blanks. */
  overscan?: number;
}

export interface WindowRange {
  /** First row to render, inclusive. */
  start: number;
  /** Last row to render, exclusive. */
  end: number;
  /** Pixels of spacer above the first rendered row. */
  offsetY: number;
  /** Height of the whole list, so the scrollbar matches the row count. */
  totalHeight: number;
}

export function visibleRange({
  scrollTop,
  viewportHeight,
  rowHeight,
  count,
  overscan = 6,
}: WindowInput): WindowRange {
  const totalHeight = Math.max(0, count) * rowHeight;
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, offsetY: 0, totalHeight };

  // Clamped rather than trusted: a search that narrows 2 000 rows to 3 leaves
  // the container scrolled past the end for one frame, and an unclamped start
  // would render nothing at all.
  const safeTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight)));
  const first = Math.floor(safeTop / rowHeight);
  const visible = Math.ceil(viewportHeight / rowHeight);

  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, offsetY: start * rowHeight, totalHeight };
}
