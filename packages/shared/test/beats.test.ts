import { describe, expect, it } from 'vitest';
import {
  beatPhaseAt,
  beatPulse,
  parseBeatGrid,
  projectorPositionMs,
  type BeatGrid,
} from '../src/beats.js';

/** 120 bpm from 1 s in: a beat every 500 ms. */
const grid: BeatGrid = {
  bpm: 120,
  beatsMs: [1_000, 1_500, 2_000, 2_500, 3_000],
};

describe('parseBeatGrid', () => {
  it('reads the file ingest writes', () => {
    const parsed = parseBeatGrid({ version: 1, bpm: 128, offsetMs: 12, beatsMs: [12, 480] });
    expect(parsed).toEqual({ bpm: 128, beatsMs: [12, 480] });
  });

  it('keeps a track whose beat detection failed', () => {
    // Detection returning nothing is normal for spoken word or ambient
    // material; the projector falls back rather than the track being unplayable.
    expect(parseBeatGrid({ version: 1, bpm: null, offsetMs: null, beatsMs: [] })).toEqual({
      bpm: null,
      beatsMs: [],
    });
  });

  it('sorts an out-of-order grid rather than trusting it', () => {
    expect(parseBeatGrid({ version: 1, bpm: null, offsetMs: null, beatsMs: [900, 100, 500] })).toEqual(
      { bpm: null, beatsMs: [100, 500, 900] },
    );
  });

  it('rejects anything that is not a beat grid', () => {
    expect(parseBeatGrid({ beats: [1, 2] })).toBeNull();
    expect(parseBeatGrid('null')).toBeNull();
    expect(parseBeatGrid({ version: 1, bpm: 120, offsetMs: 0, beatsMs: ['x'] })).toBeNull();
  });
});

describe('beatPhaseAt', () => {
  it('locates the beat under a position', () => {
    expect(beatPhaseAt(grid, 2_120)).toEqual({ index: 2, sinceMs: 120, intervalMs: 500 });
  });

  it('lands exactly on a beat with no elapsed time', () => {
    expect(beatPhaseAt(grid, 2_000)?.sinceMs).toBe(0);
  });

  it('returns nothing before the first beat', () => {
    // Guessing a pulse for a beat that was never detected is worse than waiting.
    expect(beatPhaseAt(grid, 400)).toBeNull();
  });

  it('keeps the pulse going past the last detected beat', () => {
    // Detection often stops before the outro does. A visualiser that dies
    // thirty seconds early reads as a crash.
    expect(beatPhaseAt(grid, 3_800)).toEqual({ index: 4, sinceMs: 800, intervalMs: 500 });
  });

  it('falls back to bpm for a single-beat grid', () => {
    expect(beatPhaseAt({ bpm: 100, beatsMs: [0] }, 100)?.intervalMs).toBe(600);
  });

  it('returns nothing when there is no grid at all', () => {
    expect(beatPhaseAt({ bpm: null, beatsMs: [] }, 1_000)).toBeNull();
  });
});

describe('beatPulse', () => {
  it('peaks on the beat and decays to nothing before the next', () => {
    const onBeat = beatPulse({ index: 0, sinceMs: 0, intervalMs: 500 });
    const midway = beatPulse({ index: 0, sinceMs: 140, intervalMs: 500 });
    expect(onBeat).toBe(1);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(onBeat);
    expect(beatPulse({ index: 0, sinceMs: 400, intervalMs: 500 })).toBe(0);
  });

  it('is dark with no phase', () => {
    expect(beatPulse(null)).toBe(0);
  });
});

describe('projectorPositionMs', () => {
  it('draws ahead of the room by the projector offset', () => {
    // Positive offset means "draw earlier", which is what corrects a projector
    // that looks late (D8).
    expect(projectorPositionMs(10_000, 8_000, 0)).toBe(2_000);
    expect(projectorPositionMs(10_000, 8_000, 40)).toBe(2_040);
    expect(projectorPositionMs(10_000, 8_000, -40)).toBe(1_960);
  });
});
