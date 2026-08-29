import { describe, expect, it } from 'vitest';
import { visibleRange } from '../src/virtual.js';

const base = { rowHeight: 44, viewportHeight: 352, count: 2_000, overscan: 6 };

describe('visibleRange', () => {
  it('renders a screenful plus overscan, not two thousand rows', () => {
    // The whole reason this exists: 2 000 rows in the DOM is what makes a
    // dashboard unusable at 2 000 tracks (D10).
    const range = visibleRange({ ...base, scrollTop: 0 });
    expect(range.start).toBe(0);
    expect(range.end).toBe(14);
    expect(range.totalHeight).toBe(88_000);
  });

  it('follows the scroll position', () => {
    const range = visibleRange({ ...base, scrollTop: 4_400 });
    expect(range.start).toBe(94);
    expect(range.offsetY).toBe(94 * 44);
    expect(range.end).toBe(114);
  });

  it('stops at the end of the list', () => {
    const range = visibleRange({ ...base, count: 20, scrollTop: 10_000 });
    expect(range.end).toBe(20);
    expect(range.start).toBeLessThan(20);
  });

  it('handles a viewport taller than the content', () => {
    const range = visibleRange({ ...base, count: 3, scrollTop: 0 });
    expect(range).toEqual({ start: 0, end: 3, offsetY: 0, totalHeight: 132 });
  });

  it('recovers when a search narrows the list under a scrolled viewport', () => {
    // For one frame the container is scrolled past the new end. An unclamped
    // start would render nothing at all, which reads as "the search broke".
    const range = visibleRange({ ...base, count: 3, scrollTop: 8_000 });
    expect(range.start).toBe(0);
    expect(range.end).toBe(3);
  });

  it('renders nothing for an empty list', () => {
    expect(visibleRange({ ...base, count: 0, scrollTop: 0 })).toEqual({
      start: 0,
      end: 0,
      offsetY: 0,
      totalHeight: 0,
    });
  });
});
