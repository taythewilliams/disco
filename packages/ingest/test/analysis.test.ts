import { describe, expect, it } from 'vitest';
import { bpmFromBeats, parseTempoBpm } from '../src/analysis.js';

/** A perfect grid at `bpm`, for `count` beats, starting at `offsetMs`. */
function grid(bpm: number, count: number, offsetMs = 0): number[] {
  const period = 60_000 / bpm;
  return Array.from({ length: count }, (_, i) => offsetMs + i * period);
}

describe('bpmFromBeats', () => {
  it('reads a clean grid', () => {
    expect(bpmFromBeats(grid(128, 64))).toBe(128);
    expect(bpmFromBeats(grid(174, 64))).toBe(174);
  });

  it('is unmoved by a missed beat', () => {
    // A dropped detection doubles one interval. The mean would report ~126 for
    // a 128 BPM track; the median does not notice.
    const beats = grid(128, 64);
    beats.splice(30, 1);
    expect(bpmFromBeats(beats)).toBe(128);
  });

  it('survives jitter in the detected positions', () => {
    // Onset detection lands a few milliseconds either side of the true beat.
    // Symmetric jitter cancels in the median: intervals alternate 506 and 494,
    // and the middle of those is 500.
    const beats = grid(120, 65).map((t, i) => t + (i % 2 === 0 ? -3 : 3));
    expect(bpmFromBeats(beats)).toBe(120);
  });

  it('gives up rather than guessing from too little', () => {
    expect(bpmFromBeats([])).toBeNull();
    expect(bpmFromBeats([0, 500])).toBeNull();
  });

  it('discards intervals outside any plausible tempo', () => {
    // Long silences between sections produce huge intervals; they must not be
    // averaged in as if they were beats.
    expect(bpmFromBeats([0, 468, 936, 1404, 40_000, 80_000])).toBeCloseTo(128, 0);
  });

  it('returns null when nothing plausible is left', () => {
    expect(bpmFromBeats([0, 30_000, 60_000, 90_000])).toBeNull();
  });
});

describe('parseTempoBpm', () => {
  it('reads the line aubio actually prints', () => {
    expect(parseTempoBpm('128.10 bpm\n')).toBe(128.1);
    expect(parseTempoBpm('120.12 bpm')).toBe(120.1);
  });

  it('rejects an out-of-range reading so the grid median takes over', () => {
    // The 22.05 kHz analysis bug produced exactly this shape of answer.
    expect(parseTempoBpm('23.4 bpm')).toBeNull();
    expect(parseTempoBpm('400 bpm')).toBeNull();
  });

  it('returns null for missing or unparseable output', () => {
    expect(parseTempoBpm(undefined)).toBeNull();
    expect(parseTempoBpm('')).toBeNull();
    expect(parseTempoBpm('no tempo found')).toBeNull();
  });
});
