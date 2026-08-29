import { describe, expect, it } from 'vitest';
import {
  driftCorrection,
  emitTimeForStart,
  positionAtServerTime,
  segmentIndexAt,
  segmentStartMs,
  serverTimeForPosition,
  startTimeForSeek,
  type TimelineState,
} from '../src/position.js';

const playing = (startAtServerTime: number): TimelineState => ({
  startAtServerTime,
  paused: false,
  pausedAtPosition: null,
});

describe('positionAtServerTime', () => {
  it('is the difference from the start, and nothing else', () => {
    expect(positionAtServerTime(playing(1_000), 4_000)).toBe(3_000);
  });

  it('returns the lead time as a negative position before the track starts', () => {
    // A joiner needs this value: it is exactly how long there is left to fetch
    // and decode before position 0 has to be audible.
    expect(positionAtServerTime(playing(10_000), 7_500)).toBe(-2_500);
  });

  it('freezes at the paused position regardless of elapsed time', () => {
    const paused: TimelineState = {
      startAtServerTime: 1_000,
      paused: true,
      pausedAtPosition: 42_000,
    };
    expect(positionAtServerTime(paused, 5_000)).toBe(42_000);
    expect(positionAtServerTime(paused, 900_000)).toBe(42_000);
  });

  it('treats a paused state with no recorded position as the top of the track', () => {
    expect(
      positionAtServerTime({ startAtServerTime: 0, paused: true, pausedAtPosition: null }, 9_999),
    ).toBe(0);
  });

  it('round-trips against serverTimeForPosition', () => {
    const state = playing(123_456);
    const t = serverTimeForPosition(state, 30_000);
    expect(positionAtServerTime(state, t)).toBe(30_000);
  });
});

describe('startTimeForSeek', () => {
  it('moves the origin so the timeline keeps one meaning', () => {
    const at = 500_000;
    const start = startTimeForSeek(90_000, at);
    expect(positionAtServerTime(playing(start), at)).toBe(90_000);
  });
});

describe('emitTimeForStart', () => {
  it('pulls emission earlier by the clock offset and the output latency', () => {
    // Server time 10_000, client running 1_000 ms behind server time, 180 ms of
    // Bluetooth latency: emit at client time 8_820 so the ear hears it at 10_000.
    expect(emitTimeForStart(10_000, 1_000, 180)).toBe(8_820);
  });

  it('is the same shape for a wired guest, only with a smaller correction', () => {
    expect(emitTimeForStart(10_000, 1_000, 0)).toBe(9_000);
  });

  it('keeps two guests aligned in the ear despite different latencies', () => {
    // Per Part 0 only the spread matters. Both hear position 0 at server 10_000.
    const heardAt = (offset: number, calibration: number) =>
      emitTimeForStart(10_000, offset, calibration) + offset + calibration;
    expect(heardAt(1_000, 180)).toBe(heardAt(-4_200, 20));
  });
});

describe('driftCorrection', () => {
  it('does nothing inside the deadband', () => {
    expect(driftCorrection(0)).toEqual({ action: 'none', playbackRate: 1 });
    expect(driftCorrection(4.9).action).toBe('none');
    expect(driftCorrection(-4.9).action).toBe('none');
  });

  it('slows down when playback has run ahead', () => {
    const c = driftCorrection(20);
    expect(c.action).toBe('rate');
    expect(c.playbackRate).toBeLessThan(1);
  });

  it('speeds up when playback has fallen behind', () => {
    const c = driftCorrection(-20);
    expect(c.action).toBe('rate');
    expect(c.playbackRate).toBeGreaterThan(1);
  });

  it('spreads the correction over the window', () => {
    // 20 ms over 20 s is a rate of 0.999 — one part in a thousand.
    expect(driftCorrection(20).playbackRate).toBeCloseTo(0.999, 6);
  });

  it('never exceeds 0.1 %, which is where the pitch shift becomes audible', () => {
    for (const err of [10, 30, 59, -10, -30, -59]) {
      const { playbackRate } = driftCorrection(err);
      expect(Math.abs(playbackRate - 1)).toBeLessThanOrEqual(0.001 + 1e-12);
    }
  });

  it('hard-reschedules past the threshold rather than trying to nudge', () => {
    expect(driftCorrection(60).action).toBe('reschedule');
    expect(driftCorrection(-60).action).toBe('reschedule');
    expect(driftCorrection(5_000)).toEqual({ action: 'reschedule', playbackRate: 1 });
  });

  it('treats a non-finite reading as no information, not as a huge error', () => {
    // A missing measurement must never trigger a room-wide reschedule.
    expect(driftCorrection(NaN).action).toBe('none');
    expect(driftCorrection(Infinity).action).toBe('none');
  });

  it('honours overridden thresholds from remote config', () => {
    expect(driftCorrection(30, { rescheduleThresholdMs: 25 }).action).toBe('reschedule');
    expect(driftCorrection(30, { deadbandMs: 50 }).action).toBe('none');
  });
});

describe('segment math', () => {
  // Deliberately uneven: real segment durations are whole numbers of frames,
  // not the 25 s target.
  const durations = [25_012, 24_987, 25_001, 12_400];

  it('finds the segment holding a position', () => {
    expect(segmentIndexAt(durations, 0)).toBe(0);
    expect(segmentIndexAt(durations, 25_011)).toBe(0);
    expect(segmentIndexAt(durations, 25_012)).toBe(1);
    expect(segmentIndexAt(durations, 49_998)).toBe(1);
    // Segment 1 ends at 49_999, not at a round 50_000 — the durations are
    // whole numbers of frames, and assuming otherwise is how a boundary bug
    // gets in.
    expect(segmentIndexAt(durations, 49_999)).toBe(2);
    expect(segmentIndexAt(durations, 75_000)).toBe(3);
  });

  it('clamps outside the track instead of returning a hole', () => {
    expect(segmentIndexAt(durations, -5_000)).toBe(0);
    expect(segmentIndexAt(durations, 10_000_000)).toBe(3);
  });

  it('reports the accumulated start of each segment', () => {
    expect(segmentStartMs(durations, 0)).toBe(0);
    expect(segmentStartMs(durations, 1)).toBe(25_012);
    expect(segmentStartMs(durations, 3)).toBe(75_000);
  });

  it('agrees with segmentIndexAt at every boundary', () => {
    for (let i = 0; i < durations.length; i++) {
      expect(segmentIndexAt(durations, segmentStartMs(durations, i))).toBe(i);
    }
  });
});
