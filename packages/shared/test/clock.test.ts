import { describe, expect, it } from 'vitest';
import {
  ClockEstimator,
  estimateOffset,
  median,
  offsetOf,
  quantile,
  rttOf,
  type ClockSample,
} from '../src/clock.js';

/**
 * Build a sample for a known ground truth. Splitting the round trip into an
 * up-leg and a down-leg is the point: NTP-style estimation is exact when they
 * match and wrong by half their difference when they don't, and that is the
 * only error term worth testing.
 */
function sample(trueOffset: number, t0: number, upMs: number, downMs: number): ClockSample {
  return { t0, t1: t0 + upMs + trueOffset, t2: t0 + upMs + downMs };
}

describe('rttOf / offsetOf', () => {
  it('recovers the offset exactly on a symmetric path', () => {
    const s = sample(1000, 500, 6, 6);
    expect(rttOf(s)).toBe(12);
    expect(offsetOf(s)).toBe(1000);
  });

  it('is wrong by half the asymmetry, and no more', () => {
    expect(offsetOf(sample(1000, 500, 20, 4))).toBe(1008);
    expect(offsetOf(sample(1000, 500, 4, 20))).toBe(992);
  });
});

describe('quantile', () => {
  it('interpolates between neighbours', () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 20, 30, 40, 50], 0.25)).toBe(20);
  });

  it('refuses to invent a value for an empty set', () => {
    expect(() => quantile([], 0.5)).toThrow(RangeError);
    expect(median([7])).toBe(7);
  });
});

describe('estimateOffset', () => {
  it('returns null rather than a fabricated zero', () => {
    expect(estimateOffset([])).toBeNull();
  });

  it('rejects the delayed samples that carry the asymmetry', () => {
    const truth = 1_000;
    const good = Array.from({ length: 12 }, (_, i) => sample(truth, i * 50, 5, 5));
    // Four samples stuck behind a queued frame: high RTT, badly asymmetric.
    const bad = Array.from({ length: 4 }, (_, i) => sample(truth, 600 + i * 50, 180, 20));

    const estimate = estimateOffset([...good, ...bad])!;
    expect(estimate.offsetMs).toBe(truth);
    expect(estimate.rttMs).toBe(10);
    expect(estimate.survivors).toBe(12);
  });

  it('still finds the truth when the delayed samples are the majority', () => {
    // The case that matters: a congested AP with thirty clients on it, where
    // most pings queue. A plain median goes with the crowd; the RTT filter does
    // not, because the crowd is exactly what is wrong.
    const truth = 1_000;
    const good = Array.from({ length: 5 }, (_, i) => sample(truth, i * 50, 5, 5));
    const bad = Array.from({ length: 11 }, (_, i) => sample(truth, 300 + i * 50, 180, 20));

    expect(median([...good, ...bad].map(offsetOf))).toBe(1080);
    expect(estimateOffset([...good, ...bad])!.offsetMs).toBe(truth);
  });

  it('keeps at least two survivors when every RTT is identical', () => {
    const samples = Array.from({ length: 8 }, (_, i) => sample(42, i * 10, 5, 5));
    const estimate = estimateOffset(samples)!;
    expect(estimate.survivors).toBeGreaterThanOrEqual(2);
    expect(estimate.offsetMs).toBe(42);
  });

  it('handles a single sample', () => {
    const estimate = estimateOffset([sample(300, 0, 4, 4)])!;
    expect(estimate.offsetMs).toBe(300);
    expect(estimate.survivors).toBe(1);
  });
});

describe('ClockEstimator', () => {
  const round = (offset: number) => Array.from({ length: 8 }, (_, i) => sample(offset, i * 10, 5, 5));

  it('is visibly unsynchronised before the first round', () => {
    const c = new ClockEstimator();
    expect(c.locked).toBe(false);
    expect(() => c.offsetMs).toThrow(/not yet synchronised/);
  });

  it('locks directly on the first round', () => {
    const c = new ClockEstimator();
    c.update(round(1000));
    expect(c.locked).toBe(true);
    expect(c.offsetMs).toBe(1000);
  });

  it('smooths later rounds instead of stepping to them', () => {
    const c = new ClockEstimator(0.15);
    c.update(round(1000));
    c.update(round(1100));
    // A step would land on 1100 and reschedule the room; 15 % of the way is 1015.
    expect(c.offsetMs).toBeCloseTo(1015, 6);
  });

  it('converges on a sustained change without ever jumping', () => {
    const c = new ClockEstimator(0.15);
    c.update(round(1000));
    const steps: number[] = [];
    for (let i = 0; i < 60; i++) {
      c.update(round(1100));
      steps.push(c.offsetMs);
    }
    expect(c.offsetMs).toBeCloseTo(1100, 1);
    const jumps = steps.map((v, i) => Math.abs(v - (steps[i - 1] ?? 1000)));
    expect(Math.max(...jumps)).toBeLessThan(20);
  });

  it('leaves the estimate standing when a round yields nothing', () => {
    const c = new ClockEstimator();
    c.update(round(1000));
    expect(c.update([])).toBeNull();
    expect(c.offsetMs).toBe(1000);
  });

  it('converts both directions consistently', () => {
    const c = new ClockEstimator();
    c.update(round(1000));
    expect(c.toServerTime(500)).toBe(1500);
    expect(c.toClientTime(1500)).toBe(500);
  });
});
