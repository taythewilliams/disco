/**
 * The client's playback loop.
 *
 * Takes the one message that matters — `state` — and turns it into scheduled
 * audio. Late joins, reconnects, reloads, engine switches and channel switches
 * all arrive here as the same message and take the same path; there is no
 * special case, and that is the point (v4 Part 2).
 *
 * Drift monitoring lives here rather than in the engines because the decision
 * is shared: measure where the audio is, compare with where the room is, steer
 * with `playbackRate` under 60 ms, hard reschedule over (D9).
 */

import {
  RESIDENT_SEGMENTS,
  planPrefetch,
  residentWindow,
  segmentIndexAt,
  segmentKey,
  type RuntimeConfig,
  type StateMsg,
  type TrackMetaMsg,
  type TrackPlan,
} from '@disco/shared';
import type { SegmentCache, SegmentLocation } from './cache.js';
import type { PlaybackEngine, TrackRef } from './engine/types.js';

export interface SchedulerDeps {
  engine: PlaybackEngine;
  cache: SegmentCache;
  /** Estimated server time. The same identity the server publishes. */
  serverNow(): number;
  config(): RuntimeConfig;
  onDiagnostic?(event: DiagnosticEvent): void;
}

export type DiagnosticEvent =
  | { kind: 'reschedule'; reason: 'state' | 'drift'; trackId: string; positionMs: number }
  | { kind: 'drift'; errorMs: number; corrected: boolean }
  | { kind: 'stall'; trackId: string; positionMs: number }
  | { kind: 'evicted'; decoded: number; encoded: number };

/** How far ahead of the playhead to keep downloaded audio. */
const BUFFER_AHEAD_MS = 90_000;

export class Scheduler {
  #state: StateMsg | null = null;
  readonly #meta = new Map<string, TrackMetaMsg>();
  /** The track the engine is currently playing, to detect a real change. */
  #scheduledTrackId: string | null = null;
  #scheduledStartAt = 0;
  #lastDriftMs = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  get lastDriftMs(): number {
    return this.#lastDriftMs;
  }

  get currentTrackId(): string | null {
    return this.#state?.trackId ?? null;
  }

  /** Server time of the current track's position zero, or null when idle. */
  get currentStartAtServerTime(): number | null {
    return this.#state?.trackId ? this.#state.startAtServerTime : null;
  }

  /**
   * The playing track then the queue, as far as the horizon reaches.
   *
   * Exposed so telemetry can report readiness over exactly the tracks this
   * client is prefetching — the same list, not a second reconstruction of it
   * from React state that could disagree (D5).
   */
  horizonPlans(depth: number): TrackPlan[] {
    return this.#plans().slice(0, Math.max(0, depth));
  }

  learnTrack(meta: TrackMetaMsg): void {
    this.#meta.set(meta.trackId, meta);
  }

  /**
   * Apply a `state` message.
   *
   * Reschedules only when the track or the anchor actually moved. A `state`
   * arrives on every queue edit, and re-scheduling audio because the DJ
   * reordered track five would be audible for no reason.
   */
  applyState(state: StateMsg): void {
    this.#state = state;

    if (state.paused || !state.trackId) {
      this.deps.engine.stop();
      this.#scheduledTrackId = null;
      return;
    }

    const anchorMoved = state.startAtServerTime !== this.#scheduledStartAt;
    const trackChanged = state.trackId !== this.#scheduledTrackId;
    if (!anchorMoved && !trackChanged) return;

    this.#scheduleCurrent('state');
  }

  /**
   * One pass of the loop: prefetch, decode, wire up, measure drift, evict.
   *
   * Called on a timer. Everything is idempotent, so a missed tick costs
   * latency and never correctness.
   */
  async tick(): Promise<void> {
    const state = this.#state;
    if (!state) return;

    await this.#prefetch();
    await this.#decodeWindow();
    this.deps.engine.ensureScheduled();
    this.deps.engine.settleRate();

    // A track the engine could not start for want of its first segment: try
    // again now that a download may have landed.
    if (!state.paused && state.trackId && this.#scheduledTrackId === null) {
      this.#scheduleCurrent('state');
    }

    this.#checkDrift();
    this.#evict();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #scheduleCurrent(reason: 'state' | 'drift'): void {
    const state = this.#state;
    if (!state?.trackId) return;

    const track = this.#trackRef(state.trackId);
    if (!track) return;

    // One reading of the clock for both values, so the position and the moment
    // it is claimed to hold at cannot disagree by the width of this function.
    const now = this.deps.serverNow();
    const positionMs = Math.max(0, now - state.startAtServerTime);

    // The segment holding the playhead, not segment zero. A guest joining 95 s
    // into a track needs segment three, and prefetch never fetches segment zero
    // for them — checking for it would stall a mid-track join forever (D5).
    const needed = segmentIndexAt(track.segmentDurationsMs, positionMs);
    if (!this.deps.cache.has(state.trackId, needed)) {
      // Leave `#scheduledTrackId` null so the next tick retries. This is the
      // visible "catching up" state, never a silent failure.
      this.deps.onDiagnostic?.({ kind: 'stall', trackId: state.trackId, positionMs });
      this.#scheduledTrackId = null;
      return;
    }

    // `schedule(track, atServerTime, fromPosition)` means "play so that
    // `fromPosition` lands at `atServerTime`" — so the time passed is *now*,
    // not the track's origin. Passing `startAtServerTime` alongside a non-zero
    // position subtracts the playhead twice, which puts a mid-set joiner a full
    // playhead behind the room: a guest joining 57 s in reported 57 s of drift.
    void this.deps.engine.schedule(track, now, positionMs);
    this.#scheduledTrackId = state.trackId;
    this.#scheduledStartAt = state.startAtServerTime;
    this.deps.onDiagnostic?.({ kind: 'reschedule', reason, trackId: state.trackId, positionMs });
  }

  #checkDrift(): void {
    const state = this.#state;
    if (!state?.trackId || state.paused || this.#scheduledTrackId !== state.trackId) return;

    const expected = this.deps.serverNow() - state.startAtServerTime;
    const actual = this.deps.engine.getCurrentPositionMs();
    // Positive means this client has run ahead of the room.
    const errorMs = actual - expected;
    this.#lastDriftMs = errorMs;

    const handled = this.deps.engine.correctDrift(errorMs);
    this.deps.onDiagnostic?.({ kind: 'drift', errorMs, corrected: handled });
    if (!handled) this.#scheduleCurrent('drift');
  }

  async #prefetch(): Promise<void> {
    const state = this.#state;
    if (!state) return;

    const plans = this.#plans();
    const currentIndex = state.trackId ? plans.findIndex((p) => p.trackId === state.trackId) : -1;
    const config = this.deps.config();

    const requests = planPrefetch({
      plans,
      currentIndex,
      positionMs: state.trackId ? this.deps.serverNow() - state.startAtServerTime : 0,
      bufferAheadMs: BUFFER_AHEAD_MS,
      horizonTracks: config.prefetchHorizonTracks,
      have: this.deps.cache.encodedKeys,
    });

    // Only the most urgent handful per pass. Firing the whole plan at once is
    // what saturates an access point when thirty phones arrive together (D4).
    const batch = requests.slice(0, config.maxConcurrentSegmentDownloads);
    await Promise.all(
      batch.map(async (request) => {
        const meta = this.#meta.get(request.trackId);
        if (!meta) return;
        const segment = meta.segments[request.segmentIndex];
        if (!segment) return;
        // The init segment first: a fragment without it decodes to nothing.
        await this.deps.cache.fetchInit(request.trackId, meta.initUrl).catch(() => {});
        await this.deps.cache
          .fetchSegment({
            trackId: request.trackId,
            index: request.segmentIndex,
            url: segment.url,
            startMs: segment.startMs,
            durationMs: segment.durationMs,
          })
          .catch(() => {
            // A failed segment is retried on the next pass; one lost fetch must
            // not stop the loop.
          });
      }),
    );
  }

  async #decodeWindow(): Promise<void> {
    // A media element is fed encoded fragments through MSE and never reads a
    // decoded buffer. Decoding for it would burn CPU and ~35 MB a segment of
    // the memory headroom the resident window exists to protect (D2).
    if (!this.deps.engine.needsDecodedAudio) return;
    const locations = this.#windowLocations();
    for (const location of locations) {
      await this.deps.cache.decodeSegment(location).catch(() => false);
    }
  }

  #evict(): void {
    const keepDecoded = this.deps.engine.needsDecodedAudio
      ? new Set(this.#windowLocations().map((l) => segmentKey(l.trackId, l.index)))
      : new Set<string>();
    const keepTracks = new Set(this.#plans().map((p) => p.trackId));
    const decoded = this.deps.cache.evictDecoded(keepDecoded);
    const encoded = this.deps.cache.evictEncoded(keepTracks);
    if (decoded > 0 || encoded > 0) {
      this.deps.onDiagnostic?.({ kind: 'evicted', decoded, encoded });
    }
  }

  /** Segments that should be decoded and resident right now. */
  #windowLocations(): SegmentLocation[] {
    const state = this.#state;
    if (!state?.trackId) return [];
    const meta = this.#meta.get(state.trackId);
    if (!meta) return [];

    const positionMs = Math.max(0, this.deps.serverNow() - state.startAtServerTime);
    const durations = meta.segments.map((s) => s.durationMs);

    return residentWindow(durations, positionMs, RESIDENT_SEGMENTS)
      .map((index) => meta.segments[index])
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => ({
        trackId: meta.trackId,
        index: s.index,
        url: s.url,
        startMs: s.startMs,
        durationMs: s.durationMs,
      }));
  }

  /** The playing track, then the queue, for every track whose metadata we hold. */
  #plans(): TrackPlan[] {
    const state = this.#state;
    if (!state) return [];
    const ids = state.trackId ? [state.trackId, ...state.queue] : [...state.queue];
    return ids
      .map((trackId) => this.#meta.get(trackId))
      .filter((m): m is TrackMetaMsg => m !== undefined)
      .map((m) => ({ trackId: m.trackId, segmentDurationsMs: m.segments.map((s) => s.durationMs) }));
  }

  #trackRef(trackId: string): TrackRef | null {
    const meta = this.#meta.get(trackId);
    if (!meta) return null;
    return {
      trackId,
      segmentDurationsMs: meta.segments.map((s) => s.durationMs),
      gainDb: meta.gainDb,
    };
  }
}
