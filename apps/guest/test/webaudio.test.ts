import { beforeEach, describe, expect, it } from 'vitest';
import { WebAudioEngine, type SegmentSource } from '../src/engine/webaudio.js';
import { gainFromDb, type DecodedSegment, type TrackRef } from '../src/engine/types.js';
import { FakeAudioContext, FakeClock, fakeAudioBuffer } from './fakes.js';

const SEGMENT_MS = 25_000;
const SEGMENTS = 8;

const track: TrackRef = {
  trackId: 'aaa',
  segmentDurationsMs: Array.from({ length: SEGMENTS }, () => SEGMENT_MS),
  gainDb: -3,
};

/** A source holding every segment, unless a test narrows it. */
class Resident implements SegmentSource {
  constructor(public available = new Set<number>(Array.from({ length: SEGMENTS }, (_, i) => i))) {}
  get(trackId: string, index: number): DecodedSegment | null {
    if (trackId !== track.trackId || !this.available.has(index)) return null;
    return {
      trackId,
      index,
      startMs: index * SEGMENT_MS,
      durationMs: SEGMENT_MS,
      buffer: fakeAudioBuffer(SEGMENT_MS),
    };
  }
}

let context: FakeAudioContext;
let clock: FakeClock;
let source: Resident;
let engine: WebAudioEngine;

const build = (available?: Set<number>) => {
  context = new FakeAudioContext();
  // Client time 1 000, server time 501 000: a 500 s offset, so a test that
  // confuses the two fails loudly instead of coincidentally passing.
  clock = new FakeClock(1_000, 500_000);
  source = new Resident(available);
  engine = new WebAudioEngine(
    context as unknown as AudioContext,
    source,
    clock,
  );
};

beforeEach(() => build());

describe('scheduling', () => {
  it('anchors position zero at the server time it was given', () => {
    engine.schedule(track, clock.serverNow(), 0);
    expect(engine.getCurrentPositionMs()).toBeCloseTo(0, 6);
    expect(engine.expectedPositionMs()).toBeCloseTo(0, 6);
  });

  it('starts a mid-track join at the room’s playhead, not at zero', () => {
    // A guest arriving 70 s into a track has to land 70 s in, inside segment
    // two, with the right offset within it (D5).
    engine.schedule(track, clock.serverNow(), 70_000);
    expect(engine.getCurrentPositionMs()).toBeCloseTo(70_000, 6);

    const started = context.sources.filter((s) => s.startedAt !== null);
    expect(started[0]?.offsetSec).toBeCloseTo(20, 6);
  });

  it('does not wire segments already behind the playhead', () => {
    engine.schedule(track, clock.serverNow(), 70_000);
    // Segments 0 and 1 end before 70 s, so the window is 2–5: the segment
    // holding the playhead plus the 60 s lookahead. Four sources, and none of
    // them audio the room has already heard.
    expect(context.sources).toHaveLength(4);
    expect(context.sources[0]?.offsetSec).toBeCloseTo(20, 6);
    expect(context.sources.slice(1).every((s) => s.offsetSec === 0)).toBe(true);
  });

  it('skips a segment that is not resident and takes it up later', () => {
    build(new Set([0, 2]));
    engine.schedule(track, clock.serverNow(), 0);
    const before = context.sources.length;

    source.available.add(1);
    engine.ensureScheduled();
    expect(context.sources.length).toBeGreaterThan(before);
  });

  it('never wires the same segment twice', () => {
    engine.schedule(track, clock.serverNow(), 0);
    const count = context.sources.length;
    engine.ensureScheduled();
    engine.ensureScheduled();
    expect(context.sources).toHaveLength(count);
  });

  it('applies loudness normalisation as a gain, not as volume', () => {
    // Track gain and user volume are separate stages, so changing one never
    // clobbers the other (D10).
    engine.schedule(track, clock.serverNow(), 0);
    engine.setVolume(0.5);
    expect(gainFromDb(-3)).toBeCloseTo(0.7079, 4);
  });

  it('drops sources when rescheduled', () => {
    engine.schedule(track, clock.serverNow(), 0);
    const first = context.sources.filter((s) => s.startedAt !== null);
    engine.schedule(track, clock.serverNow(), 100_000);
    expect(first.every((s) => s.stoppedAt !== null)).toBe(true);
  });
});

describe('position tracking', () => {
  it('advances with audio-context time', () => {
    engine.schedule(track, clock.serverNow(), 0);
    context.advance(12);
    expect(engine.getCurrentPositionMs()).toBeCloseTo(12_000, 6);
  });

  it('advances more slowly while a fine correction is steering', () => {
    // The bug this guards: computing position as elapsed-context-time would
    // over-report by exactly the error being corrected, hiding it from the very
    // measurement that drives the correction.
    engine.schedule(track, clock.serverNow(), 0);
    context.advance(10);
    expect(engine.getCurrentPositionMs()).toBeCloseTo(10_000, 6);

    engine.correctDrift(20); // ahead by 20 ms → rate 0.999
    context.advance(20);
    // 20 s at 0.999 is 19.98 s of track audio: the 20 ms is gone.
    expect(engine.getCurrentPositionMs()).toBeCloseTo(29_980, 6);
  });

  it('speeds up symmetrically when behind', () => {
    engine.schedule(track, clock.serverNow(), 0);
    engine.correctDrift(-20);
    context.advance(20);
    expect(engine.getCurrentPositionMs()).toBeCloseTo(20_020, 6);
  });

  it('reports zero with no track scheduled', () => {
    expect(engine.getCurrentPositionMs()).toBe(0);
  });
});

describe('drift correction', () => {
  it('does nothing inside the deadband', () => {
    engine.schedule(track, clock.serverNow(), 0);
    expect(engine.correctDrift(3)).toBe(true);
    context.advance(10);
    expect(engine.getCurrentPositionMs()).toBeCloseTo(10_000, 6);
  });

  it('steers with playbackRate under the threshold', () => {
    engine.schedule(track, clock.serverNow(), 0);
    expect(engine.correctDrift(30)).toBe(true);
    const playing = context.sources.filter((s) => s.startedAt !== null);
    // 30 ms over the 20 s window would want 0.9985, but the ±0.1 % clamp caps
    // it at 0.999 — so a 30 ms error takes 30 s to bleed off rather than
    // arriving as an audible pitch step.
    expect(playing[0]?.playbackRate.value).toBeCloseTo(0.999, 9);
  });

  it('steers a small error at less than the clamp', () => {
    engine.schedule(track, clock.serverNow(), 0);
    engine.correctDrift(10);
    const playing = context.sources.filter((s) => s.startedAt !== null);
    expect(playing[0]?.playbackRate.value).toBeCloseTo(0.9995, 9);
  });

  it('hands a coarse correction back to the caller', () => {
    // Web Audio cannot move a source that is already playing, so past the
    // threshold the answer is a reschedule, not a nudge (D9).
    engine.schedule(track, clock.serverNow(), 0);
    expect(engine.correctDrift(400)).toBe(false);
  });

  it('never exceeds 0.1 %, where the pitch shift becomes audible', () => {
    engine.schedule(track, clock.serverNow(), 0);
    for (const error of [10, 59, -10, -59]) {
      engine.correctDrift(error);
      const rate = context.sources.filter((s) => s.startedAt !== null)[0]?.playbackRate.value ?? 1;
      expect(Math.abs(rate - 1)).toBeLessThanOrEqual(0.001 + 1e-9);
    }
  });

  it('returns the rate to 1 once the correction window has passed', () => {
    // Left steering, the correction becomes drift in the other direction.
    engine.schedule(track, clock.serverNow(), 0);
    engine.correctDrift(20);
    const playing = context.sources.filter((s) => s.startedAt !== null)[0];
    expect(playing?.playbackRate.value).toBeLessThan(1);

    clock.advance(20_001);
    engine.settleRate();
    expect(playing?.playbackRate.value).toBe(1);
  });

  it('reports the last measured error as telemetry', () => {
    engine.schedule(track, clock.serverNow(), 0);
    engine.correctDrift(37.5);
    expect(engine.getMeasuredSkewMs()).toBe(37.5);
  });
});

describe('scheduleOverlapping', () => {
  it('ramps the outgoing track down and the incoming one up', () => {
    // Unused by v1's gapless cuts, but it is the same machinery a crossfade and
    // a channel switch need (D3, D6).
    engine.schedule(track, clock.serverNow(), 0);
    const outgoing = context.sources.filter((s) => s.startedAt !== null);

    const next: TrackRef = { ...track, trackId: 'aaa', gainDb: -6 };
    engine.scheduleOverlapping(next, clock.serverNow() + 1_000, 2_000);

    expect(outgoing.every((s) => s.stoppedAt !== null)).toBe(true);
    expect(context.sources.length).toBeGreaterThan(outgoing.length);
  });
});
