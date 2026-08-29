import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_CONFIG,
  segmentKey,
  type RuntimeConfig,
  type StateMsg,
  type TrackMetaMsg,
} from '@disco/shared';
import { SegmentCache } from '../src/cache.js';
import type { PlaybackEngine, TrackRef } from '../src/engine/types.js';
import { Scheduler, type DiagnosticEvent } from '../src/scheduler.js';
import { FakeAudioContext, FakeClock, fakeAudioBuffer } from './fakes.js';
import { WebAudioEngine } from '../src/engine/webaudio.js';

const SEGMENT_MS = 25_000;
const T0 = 1_000_000;

function meta(trackId: string, segments = 8): TrackMetaMsg {
  return {
    t: 'trackMeta',
    trackId,
    title: `Track ${trackId}`,
    artist: 'Disco Test',
    durationMs: segments * SEGMENT_MS,
    gainDb: -3,
    bpm: 128,
    beatGridOffsetMs: 1_880,
    initUrl: `/media/tracks/${trackId}/init.mp4`,
    segments: Array.from({ length: segments }, (_, index) => ({
      index,
      url: `/media/tracks/${trackId}/seg-${String(index).padStart(5, '0')}.m4s`,
      startMs: index * SEGMENT_MS,
      durationMs: SEGMENT_MS,
      bytes: 600_000,
    })),
    peaksUrl: null,
    beatsUrl: null,
    artUrl: null,
  };
}

const state = (over: Partial<StateMsg> = {}): StateMsg => ({
  t: 'state',
  channelId: 'main',
  trackId: 'aaa',
  startAtServerTime: T0,
  paused: false,
  pausedAtPosition: null,
  queue: ['bbb', 'ccc'],
  ...over,
});

/** Records what it was asked to do; `driftHandled` drives the reschedule path. */
class FakeEngine implements PlaybackEngine {
  readonly name = 'webaudio' as const;
  needsDecodedAudio = true;
  readonly scheduled: Array<{ trackId: string; atServerTime: number; fromPosition: number }> = [];
  stopped = 0;
  positionMs = 0;
  driftHandled = true;
  lastDrift = 0;
  ensured = 0;

  schedule(track: TrackRef, atServerTime: number, fromPosition: number): void {
    this.scheduled.push({ trackId: track.trackId, atServerTime, fromPosition });
    this.positionMs = fromPosition;
  }
  scheduleOverlapping(): void {}
  correctDrift(errorMs: number): boolean {
    this.lastDrift = errorMs;
    return this.driftHandled;
  }
  settleRate(): void {}
  ensureScheduled(): void {
    this.ensured++;
  }
  getCurrentPositionMs(): number {
    return this.positionMs;
  }
  expectedPositionMs(): number {
    return this.positionMs;
  }
  getMeasuredSkewMs(): number {
    return this.lastDrift;
  }
  setVolume(): void {}
  stop(): void {
    this.stopped++;
  }
  async dispose(): Promise<void> {}
}

let engine: FakeEngine;
let cache: SegmentCache;
let scheduler: Scheduler;
let serverTime: number;
let config: RuntimeConfig;
let diagnostics: DiagnosticEvent[];
let fetched: string[];

beforeEach(() => {
  engine = new FakeEngine();
  fetched = [];
  cache = new SegmentCache({
    fetchBytes: async (url) => {
      fetched.push(url);
      return new ArrayBuffer(16);
    },
    decode: async () => fakeAudioBuffer(SEGMENT_MS),
  });
  serverTime = T0;
  config = { ...DEFAULT_RUNTIME_CONFIG };
  diagnostics = [];
  scheduler = new Scheduler({
    engine,
    cache,
    serverNow: () => serverTime,
    config: () => config,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  for (const id of ['aaa', 'bbb', 'ccc']) scheduler.learnTrack(meta(id));
});

const kinds = (kind: DiagnosticEvent['kind']) => diagnostics.filter((d) => d.kind === kind);

describe('applying state', () => {
  it('cannot start a track it has none of, and says so', () => {
    // This is the mid-track join before anything has downloaded — a visible
    // "catching up", never a silent failure (D5).
    scheduler.applyState(state());
    expect(engine.scheduled).toHaveLength(0);
    expect(kinds('stall')).toHaveLength(1);
  });

  it('starts once the first segment has arrived', async () => {
    scheduler.applyState(state());
    await scheduler.tick();
    expect(engine.scheduled).toEqual([{ trackId: 'aaa', atServerTime: T0, fromPosition: 0 }]);
  });

  it('joins at the room’s playhead, not at the top of the track', async () => {
    serverTime = T0 + 95_000;
    scheduler.applyState(state());
    await scheduler.tick();
    // Both halves matter, and the pair is the point: `schedule` means "play so
    // that `fromPosition` lands at `atServerTime`", so the time passed is now —
    // not the track's origin. Passing the origin alongside a non-zero position
    // subtracts the playhead twice and puts the joiner a full playhead behind.
    expect(engine.scheduled[0]).toEqual({
      trackId: 'aaa',
      atServerTime: T0 + 95_000,
      fromPosition: 95_000,
    });
  });

  it('does not reschedule when only the queue changed', async () => {
    // A `state` arrives on every queue edit. Restarting audio because the DJ
    // reordered track five would be audible for no reason.
    scheduler.applyState(state());
    await scheduler.tick();
    const before = engine.scheduled.length;

    scheduler.applyState(state({ queue: ['ccc', 'bbb'] }));
    expect(engine.scheduled).toHaveLength(before);
  });

  it('reschedules when the anchor moves', async () => {
    scheduler.applyState(state());
    await scheduler.tick();
    scheduler.applyState(state({ startAtServerTime: T0 + 60_000 }));
    expect(engine.scheduled).toHaveLength(2);
  });

  it('reschedules when the track changes', async () => {
    scheduler.applyState(state());
    await scheduler.tick();
    scheduler.applyState(state({ trackId: 'bbb', startAtServerTime: T0 + 200_000, queue: ['ccc'] }));
    // No segments for 'bbb' yet, so it stalls rather than starting silence.
    expect(kinds('stall').length).toBeGreaterThan(0);

    await scheduler.tick();
    expect(engine.scheduled.at(-1)).toMatchObject({ trackId: 'bbb' });
  });

  it('stops on pause and on an empty channel', () => {
    scheduler.applyState(state({ paused: true, pausedAtPosition: 30_000 }));
    expect(engine.stopped).toBe(1);
    scheduler.applyState(state({ trackId: null, queue: [] }));
    expect(engine.stopped).toBe(2);
  });
});

describe('drift', () => {
  beforeEach(async () => {
    scheduler.applyState(state());
    await scheduler.tick();
    engine.scheduled.length = 0;
  });

  it('measures ahead-of-the-room as a positive error', async () => {
    serverTime = T0 + 60_000;
    engine.positionMs = 60_040;
    await scheduler.tick();
    expect(scheduler.lastDriftMs).toBeCloseTo(40, 6);
  });

  it('measures behind-the-room as a negative error', async () => {
    serverTime = T0 + 60_000;
    engine.positionMs = 59_950;
    await scheduler.tick();
    expect(scheduler.lastDriftMs).toBeCloseTo(-50, 6);
  });

  it('leaves a handled correction to the engine', async () => {
    serverTime = T0 + 60_000;
    engine.positionMs = 60_030;
    await scheduler.tick();
    expect(engine.scheduled).toHaveLength(0);
  });

  it('reschedules when the engine says it cannot fix it', async () => {
    // Web Audio cannot move a playing source, so a coarse correction comes back
    // here as a reschedule at the room's current position (D9).
    engine.driftHandled = false;
    serverTime = T0 + 60_000;
    engine.positionMs = 60_400;
    await scheduler.tick();

    expect(engine.scheduled).toEqual([
      { trackId: 'aaa', atServerTime: T0 + 60_000, fromPosition: 60_000 },
    ]);
    expect(kinds('reschedule').some((d) => d.kind === 'reschedule' && d.reason === 'drift')).toBe(
      true,
    );
  });

  it('does not measure drift while paused', async () => {
    scheduler.applyState(state({ paused: true, pausedAtPosition: 1_000 }));
    diagnostics.length = 0;
    await scheduler.tick();
    expect(kinds('drift')).toHaveLength(0);
  });
});

describe('prefetch and memory', () => {
  it('fetches the init segment before any fragment', async () => {
    scheduler.applyState(state());
    await scheduler.tick();
    const firstInit = fetched.findIndex((u) => u.endsWith('init.mp4'));
    const firstFragment = fetched.findIndex((u) => u.endsWith('.m4s'));
    expect(firstInit).toBeGreaterThanOrEqual(0);
    expect(firstInit).toBeLessThan(firstFragment);
  });

  it('never exceeds the configured concurrent download cap', async () => {
    // A rush at the door must not starve the dance floor: the cap is what makes
    // the request stream bounded rather than a burst (D4).
    config = { ...config, maxConcurrentSegmentDownloads: 2 };
    scheduler.applyState(state());
    await scheduler.tick();
    expect(fetched.filter((u) => u.endsWith('.m4s'))).toHaveLength(2);
  });

  it('keeps only the resident window decoded', async () => {
    // Decoded audio is Float32 — ~35 MB a segment. Keeping a track's worth is
    // how a phone gets killed by the OS (D2).
    scheduler.applyState(state());
    for (let i = 0; i < 6; i++) await scheduler.tick();
    expect(cache.decodedCount).toBeLessThanOrEqual(3);

    serverTime = T0 + 150_000;
    await scheduler.tick();
    expect(cache.decodedCount).toBeLessThanOrEqual(3);
    expect(cache.get('aaa', 0)).toBeNull();
  });

  it('keeps encoded bytes for the whole horizon', async () => {
    // Cheap to hold (~600 kB a fragment) and expensive to re-fetch over a
    // contended access point.
    scheduler.applyState(state());
    await scheduler.tick();
    expect(cache.has('aaa', 0)).toBe(true);
    expect(cache.hasInit('aaa')).toBe(true);
  });

  it('drops a track that has left the horizon entirely', async () => {
    scheduler.applyState(state());
    await scheduler.tick();
    expect(cache.encodedKeys.has(segmentKey('aaa', 0))).toBe(true);

    scheduler.applyState(state({ trackId: 'ccc', startAtServerTime: T0, queue: [] }));
    await scheduler.tick();
    expect(cache.encodedKeys.has(segmentKey('aaa', 0))).toBe(false);
    expect(kinds('evicted').length).toBeGreaterThan(0);
  });

  it('survives a failing fetch and retries on the next pass', async () => {
    let failures = 2;
    const flaky = new SegmentCache({
      fetchBytes: async (url) => {
        if (failures-- > 0) throw new Error('network');
        fetched.push(url);
        return new ArrayBuffer(16);
      },
      decode: async () => fakeAudioBuffer(SEGMENT_MS),
    });
    const s = new Scheduler({
      engine,
      cache: flaky,
      serverNow: () => serverTime,
      config: () => config,
    });
    s.learnTrack(meta('aaa'));
    s.applyState(state({ queue: [] }));

    await s.tick();
    await s.tick();
    expect(flaky.hasInit('aaa')).toBe(true);
  });
});

describe('scheduler and engine agree on the anchor', () => {
  /**
   * The regression this exists for.
   *
   * Driving the real engine through the real scheduler is the only way to catch
   * a mismatch in what `schedule`'s arguments mean: with fakes on both sides,
   * two consistent misunderstandings look like a passing test. The live symptom
   * was a guest joining 57 s into a track reporting 57 s of drift.
   */
  const build = (joinAtMs: number) => {
    const context = new FakeAudioContext();
    // Client time 1 000, server time 501 000: a 500 s offset, so confusing the
    // two fails loudly rather than passing by coincidence.
    const clock = new FakeClock(1_000, 500_000);
    const trackMeta = meta('aaa');
    const durations = trackMeta.segments.map((s) => s.durationMs);

    const resident = {
      get(trackId: string, index: number) {
        return {
          trackId,
          index,
          startMs: durations.slice(0, index).reduce((a, b) => a + b, 0),
          durationMs: durations[index] as number,
          buffer: fakeAudioBuffer(durations[index] as number),
        };
      },
    };
    const realEngine = new WebAudioEngine(context as unknown as AudioContext, resident, clock);

    const anchor = clock.serverNow() - joinAtMs;
    const cache = { has: () => true } as unknown as SegmentCache;
    const s = new Scheduler({
      engine: realEngine,
      cache,
      serverNow: () => clock.serverNow(),
      config: () => config,
    });
    s.learnTrack(trackMeta);
    return { s, realEngine, clock, context, anchor };
  };

  it('puts a mid-track joiner exactly where the room is', () => {
    const { s, realEngine, anchor } = build(95_000);
    s.applyState(state({ startAtServerTime: anchor, queue: [] }));
    expect(realEngine.getCurrentPositionMs()).toBeCloseTo(95_000, 6);
    expect(realEngine.expectedPositionMs()).toBeCloseTo(95_000, 6);
  });

  it('reports no drift immediately after scheduling', () => {
    for (const joinAt of [0, 12_345, 95_000, 180_000]) {
      const { s, realEngine, anchor } = build(joinAt);
      s.applyState(state({ startAtServerTime: anchor, queue: [] }));
      const drift = realEngine.getCurrentPositionMs() - realEngine.expectedPositionMs();
      expect(Math.abs(drift), `joined at ${joinAt}`).toBeLessThan(1);
    }
  });

  it('stays aligned as both clocks advance together', () => {
    const { s, realEngine, clock, context, anchor } = build(30_000);
    s.applyState(state({ startAtServerTime: anchor, queue: [] }));

    clock.advance(10_000);
    context.advance(10);
    expect(realEngine.getCurrentPositionMs()).toBeCloseTo(40_000, 6);
    expect(realEngine.getCurrentPositionMs() - realEngine.expectedPositionMs()).toBeCloseTo(0, 6);
  });
});
