import { describe, expect, it } from 'vitest';
import {
  planPrefetch,
  readinessOf,
  residentWindow,
  segmentKey,
  type TrackPlan,
} from '../src/segments.js';

/** A five-minute track: twelve 25 s segments. */
const durations = (count: number, ms = 25_000) => Array.from({ length: count }, () => ms);

const plan = (trackId: string, segments = 12): TrackPlan => ({
  trackId,
  segmentDurationsMs: durations(segments),
});

describe('residentWindow', () => {
  it('starts at the segment holding the playhead', () => {
    expect(residentWindow(durations(12), 0, 3)).toEqual([0, 1, 2]);
    expect(residentWindow(durations(12), 60_000, 3)).toEqual([2, 3, 4]);
  });

  it('never keeps a segment already played', () => {
    // Holding what has gone past is ~35 MB of Float32 that will never be read
    // again, on a device with no room for it (D2).
    expect(residentWindow(durations(12), 200_000, 3)).not.toContain(7);
    expect(residentWindow(durations(12), 200_000, 3)[0]).toBe(8);
  });

  it('shrinks at the end of a track rather than running past it', () => {
    expect(residentWindow(durations(12), 285_000, 3)).toEqual([11]);
  });

  it('handles a position before the track starts', () => {
    expect(residentWindow(durations(12), -8_000, 3)).toEqual([0, 1, 2]);
  });

  it('returns nothing for a track with no segments', () => {
    expect(residentWindow([], 0, 3)).toEqual([]);
  });
});

describe('planPrefetch', () => {
  const base = {
    positionMs: 0,
    bufferAheadMs: 90_000,
    horizonTracks: 5,
    have: new Set<string>(),
  };

  it('fetches the playing track before anything queued', () => {
    // A guest joining mid-set needs the current track's next segments before a
    // track four ahead. With thirty phones on one access point, fetching in the
    // wrong order is indistinguishable from not having the bandwidth (D4).
    const requests = planPrefetch({
      ...base,
      plans: [plan('current'), plan('next'), plan('later')],
      currentIndex: 0,
    });
    const firstQueued = requests.findIndex((r) => r.trackId !== 'current');
    expect(requests.slice(0, firstQueued).every((r) => r.trackId === 'current')).toBe(true);
    expect(firstQueued).toBeGreaterThan(0);
  });

  it('starts at the playhead, not at the top of the track', () => {
    const requests = planPrefetch({
      ...base,
      plans: [plan('current')],
      currentIndex: 0,
      positionMs: 130_000,
    });
    expect(requests[0]).toMatchObject({ trackId: 'current', segmentIndex: 5 });
    expect(requests.some((r) => r.segmentIndex < 5)).toBe(false);
  });

  it('stops once the buffer target is covered', () => {
    const requests = planPrefetch({
      ...base,
      plans: [plan('current')],
      currentIndex: 0,
      bufferAheadMs: 60_000,
    });
    // 60 s of target needs three 25 s segments to cover it.
    expect(requests.filter((r) => r.trackId === 'current')).toHaveLength(3);
  });

  it('goes breadth-first across queued tracks', () => {
    // One segment from each before a second from any: a partially-fetched track
    // can start on time and buffer the rest, which is the "Partial" tier (D5).
    const requests = planPrefetch({
      ...base,
      plans: [plan('current'), plan('a'), plan('b'), plan('c')],
      currentIndex: 0,
      bufferAheadMs: 0,
    });
    const queued = requests.filter((r) => r.trackId !== 'current');
    expect(queued.slice(0, 3).map((r) => r.trackId)).toEqual(['a', 'b', 'c']);
    expect(queued.slice(0, 3).every((r) => r.segmentIndex === 0)).toBe(true);
    expect(queued[3]).toMatchObject({ trackId: 'a', segmentIndex: 1 });
  });

  it('never reaches past the horizon', () => {
    // The horizon is what keeps a phone holding ~30 MB regardless of whether
    // the library has fifty tracks or five thousand (D5, D10).
    const plans = [plan('current'), ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => plan(id))];
    const requests = planPrefetch({ ...base, plans, currentIndex: 0, horizonTracks: 2 });
    const tracks = new Set(requests.map((r) => r.trackId));
    expect([...tracks].sort()).toEqual(['a', 'b', 'current']);
  });

  it('asks for nothing it already holds', () => {
    const have = new Set([segmentKey('current', 0), segmentKey('current', 1)]);
    const requests = planPrefetch({
      ...base,
      plans: [plan('current')],
      currentIndex: 0,
      bufferAheadMs: 60_000,
      have,
    });
    expect(requests.map((r) => r.segmentIndex)).toEqual([2]);
  });

  it('assigns strictly increasing priority in fetch order', () => {
    const requests = planPrefetch({
      ...base,
      plans: [plan('current'), plan('next')],
      currentIndex: 0,
    });
    expect(requests.map((r) => r.priority)).toEqual(requests.map((_, i) => i));
  });

  it('fetches the head of the queue when nothing is playing yet', () => {
    // The arrival case: the channel is idle, and the first track still has to
    // be there before the DJ hits play.
    const requests = planPrefetch({
      ...base,
      plans: [plan('first'), plan('second')],
      currentIndex: -1,
      bufferAheadMs: 0,
    });
    expect(requests[0]).toMatchObject({ trackId: 'first', segmentIndex: 0 });
  });

  it('plans nothing when everything is held', () => {
    const p = plan('current', 2);
    const have = new Set([segmentKey('current', 0), segmentKey('current', 1)]);
    expect(planPrefetch({ ...base, plans: [p], currentIndex: 0, have })).toEqual([]);
  });
});

describe('readinessOf', () => {
  const p = plan('t', 4);
  const key = (i: number) => segmentKey('t', i);

  it('reports ready only when every segment is held', () => {
    expect(readinessOf(p, new Set([0, 1, 2, 3].map(key)))).toBe('ready');
    expect(readinessOf(p, new Set([0, 1, 2].map(key)))).toBe('partial');
  });

  it('reports not-ready without the first segment, however much else is held', () => {
    // Without segment zero there is nothing to start from — a mid-track join
    // with a visible catch-up, not a track that can begin on cue (D5).
    expect(readinessOf(p, new Set([1, 2, 3].map(key)))).toBe('not-ready');
  });

  it('reports not-ready for an empty cache and an empty track', () => {
    expect(readinessOf(p, new Set())).toBe('not-ready');
    expect(readinessOf({ trackId: 't', segmentDurationsMs: [] }, new Set())).toBe('not-ready');
  });
});
