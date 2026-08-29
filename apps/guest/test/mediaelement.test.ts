import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaElementEngine, mediaElementSupported } from '../src/engine/mediaelement.js';
import type { EncodedSegmentSource } from '../src/engine/mediaelement.js';
import type { TrackRef } from '../src/engine/types.js';
import { FakeClock } from './fakes.js';

const SEGMENT_MS = 25_000;
const SEGMENTS = 8;

const track: TrackRef = {
  trackId: 'aaa',
  segmentDurationsMs: Array.from({ length: SEGMENTS }, () => SEGMENT_MS),
  gainDb: -6,
};

// ─── MSE fakes ──────────────────────────────────────────────────────────────

class FakeSourceBuffer {
  mode = '';
  updating = false;
  readonly appended: ArrayBuffer[] = [];
  #listeners = new Set<() => void>();
  throwOnAppend = false;

  addEventListener(_type: 'updateend', handler: () => void): void {
    this.#listeners.add(handler);
  }
  appendBuffer(bytes: ArrayBuffer): void {
    if (this.throwOnAppend) throw new Error('QuotaExceededError');
    this.appended.push(bytes);
    this.updating = true;
    // Settle asynchronously, like the real thing.
    queueMicrotask(() => {
      this.updating = false;
      for (const handler of this.#listeners) handler();
    });
  }
}

class FakeMediaSource {
  readyState = 'closed';
  readonly buffers: FakeSourceBuffer[] = [];
  #open: (() => void) | null = null;

  addEventListener(type: string, handler: () => void): void {
    if (type === 'sourceopen') {
      this.#open = handler;
      // The real one fires once the element attaches the object URL.
      queueMicrotask(() => {
        this.readyState = 'open';
        this.#open?.();
      });
    }
  }
  addSourceBuffer(): FakeSourceBuffer {
    const buffer = new FakeSourceBuffer();
    this.buffers.push(buffer);
    return buffer;
  }
  endOfStream(): void {
    this.readyState = 'ended';
  }
}

class FakeAudioElement {
  src = '';
  currentTime = 0;
  playbackRate = 1;
  volume = 1;
  readyState = 0;
  paused = true;
  readonly plays: number[] = [];

  play(): Promise<void> {
    this.paused = false;
    this.plays.push(this.currentTime);
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

/** Holds whichever segments a test says are downloaded. */
class Downloaded implements EncodedSegmentSource {
  constructor(
    public segments = new Set<number>(Array.from({ length: SEGMENTS }, (_, i) => i)),
    public haveInit = true,
  ) {}
  init(): ArrayBuffer | null {
    return this.haveInit ? new ArrayBuffer(900) : null;
  }
  fragment(_trackId: string, index: number): ArrayBuffer | null {
    return this.segments.has(index) ? new ArrayBuffer(600_000) : null;
  }
}

let element: FakeAudioElement;
let source: Downloaded;
let clock: FakeClock;
let engine: MediaElementEngine;
let created: FakeMediaSource[];

beforeEach(() => {
  element = new FakeAudioElement();
  source = new Downloaded();
  // Client time 1 000, server time 501 000: a 500 s offset, so confusing the
  // two fails loudly rather than passing by coincidence.
  clock = new FakeClock(1_000, 500_000);
  created = [];

  const g = globalThis as unknown as Record<string, unknown>;
  g['MediaSource'] = class extends FakeMediaSource {
    static isTypeSupported = () => true;
    constructor() {
      super();
      created.push(this as unknown as FakeMediaSource);
    }
  };
  delete g['ManagedMediaSource'];
  g['URL'] = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };

  engine = new MediaElementEngine(
    element as unknown as HTMLAudioElement,
    source,
    clock,
  );
});

const buffer = () => created[0]?.buffers[0];
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('capability detection', () => {
  it('reports support when MediaSource can take the codec', () => {
    expect(mediaElementSupported()).toBe(true);
  });

  it('reports no support when MediaSource is absent', () => {
    // An iPhone before iOS 17.1. Selecting this engine there would produce an
    // app that loads and never plays (D2).
    const scope = {} as typeof globalThis;
    expect(mediaElementSupported(scope)).toBe(false);
  });

  it('survives an isTypeSupported that throws', () => {
    const scope = {
      MediaSource: class {
        static isTypeSupported() {
          throw new Error('nope');
        }
      },
    } as unknown as typeof globalThis;
    expect(mediaElementSupported(scope)).toBe(false);
  });
});

describe('scheduling', () => {
  it('appends the init segment before any fragment', async () => {
    await engine.schedule(track, clock.serverNow(), 0);
    await settle();
    // A fragment without its init segment is not decodable at all.
    expect(buffer()?.appended[0]?.byteLength).toBe(900);
    expect(buffer()?.appended[1]?.byteLength).toBe(600_000);
  });

  it('seeks to the room’s playhead before playing, not to zero', async () => {
    await engine.schedule(track, clock.serverNow(), 95_000);
    expect(element.currentTime).toBeCloseTo(95, 6);
    expect(element.plays[0]).toBeCloseTo(95, 6);
  });

  it('appends from the segment holding the playhead, not from zero', async () => {
    // The bug this guards: a guest joining 95 s in never fetches segment zero,
    // so starting the append run there finds a gap immediately and appends
    // nothing — the app loads and stays silent (D5).
    source.segments = new Set([3, 4, 5]);
    await engine.schedule(track, clock.serverNow(), 95_000);
    await settle();

    // init + segments 3, 4, 5.
    expect(buffer()?.appended).toHaveLength(4);
  });

  it('stops at a gap rather than leaving a hole the element stalls in', async () => {
    source.segments = new Set([0, 1, 3]);
    await engine.schedule(track, clock.serverNow(), 0);
    await settle();
    // init + 0 + 1, and then it stops: 3 cannot be appended across the gap.
    expect(buffer()?.appended).toHaveLength(3);
  });

  it('takes up a segment that arrives late', async () => {
    source.segments = new Set([0]);
    await engine.schedule(track, clock.serverNow(), 0);
    await settle();
    const before = buffer()?.appended.length ?? 0;

    source.segments.add(1);
    engine.ensureScheduled();
    await settle();
    expect(buffer()?.appended.length).toBe(before + 1);
  });

  it('does nothing until the init segment has downloaded', async () => {
    source.haveInit = false;
    await engine.schedule(track, clock.serverNow(), 0);
    await settle();
    expect(buffer()?.appended ?? []).toHaveLength(0);
  });

  it('survives an append that throws', async () => {
    await engine.schedule(track, clock.serverNow(), 0);
    const b = buffer();
    if (b) b.throwOnAppend = true;
    // Quota exceeded must not take the scheduling loop down with it.
    expect(() => engine.ensureScheduled()).not.toThrow();
  });
});

describe('position and drift', () => {
  it('falls back to the schedule before the element has metadata', async () => {
    // `currentTime` is 0 until then, which would read as a huge negative drift.
    await engine.schedule(track, clock.serverNow(), 40_000);
    expect(element.readyState).toBe(0);
    expect(engine.getCurrentPositionMs()).toBeCloseTo(40_000, 6);
  });

  it('trusts the element once it has metadata', async () => {
    await engine.schedule(track, clock.serverNow(), 40_000);
    element.readyState = 4;
    element.currentTime = 41.5;
    expect(engine.getCurrentPositionMs()).toBe(41_500);
    expect(engine.expectedPositionMs()).toBeCloseTo(40_000, 6);
  });

  it('steers with playbackRate under the threshold', async () => {
    await engine.schedule(track, clock.serverNow(), 0);
    expect(engine.correctDrift(20)).toBe(true);
    expect(element.playbackRate).toBeCloseTo(0.999, 9);
  });

  it('seeks to where the room is, not to where it already is', async () => {
    // The bug this guards: seeking to `getCurrentPositionMs()` is a no-op, so
    // a coarse correction would silently do nothing at all.
    await engine.schedule(track, clock.serverNow(), 40_000);
    element.readyState = 4;
    element.currentTime = 45; // 5 s ahead of the room
    expect(engine.correctDrift(5_000)).toBe(true);
    expect(element.currentTime).toBeCloseTo(40, 3);
  });

  it('handles a coarse correction itself rather than asking the caller', async () => {
    // Unlike Web Audio, an element can seek — so it returns true and the
    // scheduler does not reschedule on top of it (D9).
    await engine.schedule(track, clock.serverNow(), 0);
    expect(engine.correctDrift(5_000)).toBe(true);
  });

  it('returns the rate to 1 once the window has passed', async () => {
    await engine.schedule(track, clock.serverNow(), 0);
    engine.correctDrift(20);
    expect(element.playbackRate).toBeLessThan(1);
    clock.advance(20_001);
    engine.settleRate();
    expect(element.playbackRate).toBe(1);
  });

  it('does nothing inside the deadband', async () => {
    await engine.schedule(track, clock.serverNow(), 0);
    engine.correctDrift(3);
    expect(element.playbackRate).toBe(1);
  });
});

describe('volume', () => {
  it('folds loudness gain and user volume into one element volume', async () => {
    // An element has no gain stage, so unlike the Web Audio path these cannot
    // be separate nodes.
    await engine.schedule(track, clock.serverNow(), 0);
    // −6 dB is about 0.5.
    expect(element.volume).toBeCloseTo(0.501, 2);
    engine.setVolume(0.5);
    expect(element.volume).toBeCloseTo(0.251, 2);
  });

  it('clamps rather than distorting a track that wants positive gain', async () => {
    // An element cannot amplify; asking for more than 1 is not an option.
    await engine.schedule({ ...track, gainDb: +6 }, clock.serverNow(), 0);
    expect(element.volume).toBe(1);
  });
});

describe('lifecycle', () => {
  it('reports itself as not needing decoded audio', () => {
    expect(engine.needsDecodedAudio).toBe(false);
    expect(engine.name).toBe('mediaelement');
  });

  it('pauses on stop', async () => {
    await engine.schedule(track, clock.serverNow(), 0);
    expect(element.paused).toBe(false);
    engine.stop();
    expect(element.paused).toBe(true);
    expect(engine.getCurrentPositionMs()).toBe(0);
  });

  it('tears the media source down on dispose', async () => {
    await engine.schedule(track, clock.serverNow(), 0);
    const revoke = vi.fn();
    (globalThis as unknown as Record<string, unknown>)['URL'] = {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: revoke,
    };
    await engine.dispose();
    expect(created[0]?.readyState).toBe('ended');
    expect(revoke).toHaveBeenCalled();
  });
});

describe('startup offset', () => {
  /**
   * Seeking and then starting playback is not instantaneous, so the room moves
   * on while the element gets going. Measured live at about −52 ms, which sits
   * under the 60 ms coarse threshold — so the fine correction owns it, and at
   * 0.1 % that takes roughly three minutes. Tracks are shorter than that and
   * every boundary re-creates it, so left alone it never converges.
   */
  it('snaps the offset out once rather than steering at 0.1 %', async () => {
    await engine.schedule(track, clock.serverNow(), 40_000);
    element.readyState = 4;
    element.currentTime = 39.948; // 52 ms behind the room

    expect(engine.correctDrift(-52)).toBe(true);
    expect(element.currentTime).toBeCloseTo(40, 3);
    // A rate nudge would have been the wrong tool: it cannot finish in time.
    expect(element.playbackRate).toBe(1);
  });

  it('steers normally once the startup correction is done', async () => {
    await engine.schedule(track, clock.serverNow(), 40_000);
    element.readyState = 4;
    element.currentTime = 39.948;
    engine.correctDrift(-52);

    // Real drift after that point is ordinary drift, handled the ordinary way.
    engine.correctDrift(-20);
    expect(element.playbackRate).toBeCloseTo(1.001, 9);
  });

  it('waits for the element to be playing before measuring against it', async () => {
    // Before metadata, `currentTime` is a placeholder and correcting against it
    // would seek to a number that means nothing.
    await engine.schedule(track, clock.serverNow(), 40_000);
    expect(element.readyState).toBe(0);
    const before = element.currentTime;
    engine.correctDrift(-52);
    expect(element.currentTime).toBe(before);
  });

  it('does it again for the next track', async () => {
    // Every `schedule()` re-creates the offset, so the correction has to be
    // armed again — this is what stops it converging over a set.
    await engine.schedule(track, clock.serverNow(), 40_000);
    element.readyState = 4;
    element.currentTime = 39.948;
    engine.correctDrift(-52);

    await engine.schedule(track, clock.serverNow(), 0);
    element.readyState = 4;
    element.currentTime = 0.05;
    engine.correctDrift(-50);
    expect(element.currentTime).toBeCloseTo(0, 3);
  });

  it('is not triggered by a drift inside the deadband', async () => {
    await engine.schedule(track, clock.serverNow(), 40_000);
    element.readyState = 4;
    element.currentTime = 40.002;
    engine.correctDrift(2);
    expect(element.currentTime).toBeCloseTo(40.002, 6);
  });
});

describe('seek bias', () => {
  /**
   * A media element does not resume instantly: it lands late by its own seek
   * cost, so aiming at the room's position leaves the guest permanently behind
   * by that much — and seeking again cannot fix it, because the offset *is* the
   * cost of the seek. Measured live at 47–52 ms. Aiming that far ahead makes
   * the element land on the beat instead.
   */
  it('aims ahead of the room by the configured bias', async () => {
    engine.setSeekBiasMs(47);
    await engine.schedule(track, clock.serverNow(), 40_000);
    expect(element.currentTime).toBeCloseTo(40.047, 6);
  });

  it('aims ahead on the startup correction too', async () => {
    engine.setSeekBiasMs(47);
    await engine.schedule(track, clock.serverNow(), 40_000);
    element.readyState = 4;
    element.currentTime = 39.95;
    engine.correctDrift(-50);
    expect(element.currentTime).toBeCloseTo(40.047, 6);
  });

  it('aims ahead on a coarse correction too', async () => {
    engine.setSeekBiasMs(47);
    await engine.schedule(track, clock.serverNow(), 40_000);
    element.readyState = 4;
    engine.correctDrift(-50); // consumes the startup correction
    engine.correctDrift(-500); // now a genuine coarse correction
    expect(element.currentTime).toBeCloseTo(40.047, 6);
  });

  it('defaults to aiming exactly at the room', async () => {
    // Zero is right when the whole floor is on one engine: a delay everybody
    // shares is inaudible (v4 Part 0).
    await engine.schedule(track, clock.serverNow(), 40_000);
    expect(element.currentTime).toBeCloseTo(40, 6);
  });

  it('never seeks before the start of the track', async () => {
    engine.setSeekBiasMs(-500);
    await engine.schedule(track, clock.serverNow(), 0);
    expect(element.currentTime).toBe(0);
  });
});
