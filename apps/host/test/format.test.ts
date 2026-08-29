import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatRemaining,
  formatSigned,
  leadTimeRemainingMs,
  offsetDeviations,
  readinessLabel,
  readinessWidths,
} from '../src/format.js';

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9_000)).toBe('0:09');
    expect(formatDuration(62_023)).toBe('1:02');
    expect(formatDuration(599_000)).toBe('9:59');
  });

  it('pads minutes only past an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });

  it('clamps rather than showing a negative time', () => {
    expect(formatDuration(-5_000)).toBe('0:00');
    expect(formatDuration(NaN)).toBe('0:00');
  });
});

describe('formatRemaining', () => {
  it('counts down', () => {
    expect(formatRemaining(30_000, 180_000)).toBe('2:30');
  });

  it('clamps at the end rather than flashing a negative', () => {
    // Auto-advance is a tick away at this point, and "-0:01" reads as a bug.
    expect(formatRemaining(180_500, 180_000)).toBe('0:00');
  });
});

describe('formatSigned', () => {
  it('keeps the sign, which is the information', () => {
    expect(formatSigned(12.34, 1)).toBe('+12.3');
    expect(formatSigned(-12.34, 1)).toBe('-12.3');
    expect(formatSigned(0)).toBe('0');
  });

  it('shows a dash for a missing reading rather than a fake zero', () => {
    // A client that has not reported is not a client reading zero drift.
    expect(formatSigned(undefined)).toBe('—');
    expect(formatSigned(NaN)).toBe('—');
  });
});

describe('leadTimeRemainingMs', () => {
  const NOW = 1_000_000;

  it('reports the wait while a track is too fresh to play', () => {
    expect(leadTimeRemainingMs(NOW - 60_000, 180_000, NOW)).toBe(120_000);
  });

  it('reports null once it is playable, so no badge is rendered', () => {
    expect(leadTimeRemainingMs(NOW - 180_000, 180_000, NOW)).toBeNull();
    expect(leadTimeRemainingMs(NOW - 999_999, 180_000, NOW)).toBeNull();
  });

  it('reports null for a track with no publication time', () => {
    expect(leadTimeRemainingMs(null, 180_000, NOW)).toBeNull();
  });
});

describe('offsetDeviations', () => {
  it('reports each client relative to the room, not in absolute terms', () => {
    // Absolute offsets are thirteen-digit numbers, and a delay every guest
    // shares is inaudible anyway. The spread is the whole story (v4 Part 0).
    const offsets = [1_787_988_854_512, 1_787_988_854_510, 1_787_988_854_514];
    expect(offsetDeviations(offsets)).toEqual([0, -2, 2]);
  });

  it('uses the median so one bad phone does not move the baseline', () => {
    // With a mean, a single client 900 ms out would shift everyone else's
    // reading and hide which one is actually wrong.
    const deviations = offsetDeviations([1000, 1000, 1000, 1900]);
    expect(deviations).toEqual([0, 0, 0, 900]);
  });

  it('leaves clients that have not reported as unknown', () => {
    expect(offsetDeviations([1000, undefined, 1010])).toEqual([-5, undefined, 5]);
  });

  it('handles an empty table and an all-unknown table', () => {
    expect(offsetDeviations([])).toEqual([]);
    expect(offsetDeviations([undefined, undefined])).toEqual([undefined, undefined]);
  });
});

describe('readiness', () => {
  const row = (ready: number, partial: number, listeners: number) => ({
    ready,
    partial,
    notReady: Math.max(0, listeners - ready - partial),
    listeners,
  });

  it('says how much of the room is there', () => {
    expect(readinessLabel(row(28, 0, 30))).toBe('28/30 ready');
    expect(readinessLabel(row(24, 4, 30))).toBe('24/30 ready · 4 partial');
  });

  it('says so plainly when nobody has arrived', () => {
    // "0/0 ready" reads as a failure. Nobody being there yet is not one.
    expect(readinessLabel(row(0, 0, 0))).toBe('nobody listening yet');
    expect(readinessWidths(row(0, 0, 0))).toEqual({ ready: 0, partial: 0 });
  });

  it('draws partial behind ready rather than adding to it', () => {
    // A track half the room can *start* is not a track the room is ready for.
    expect(readinessWidths(row(15, 9, 30))).toEqual({ ready: 0.5, partial: 0.8 });
  });

  it('never overflows the bar when a stale client reports twice', () => {
    expect(readinessWidths(row(31, 4, 30))).toEqual({ ready: 1, partial: 1 });
  });
});
