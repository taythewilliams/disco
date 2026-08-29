/**
 * `WebAudioEngine` — sample-accurate scheduling via `AudioBufferSourceNode`
 * (D2).
 *
 * Precision of roughly 5–10 ms, the smallest term in the error budget. Its
 * weakness is iOS suspending the context when the app is backgrounded, which is
 * what `MediaElementEngine` exists to cover.
 *
 * Scheduling is chunked over ~25 s segments with two or three resident, and
 * that is not an optimisation: `decodeAudioData` returns Float32, so a
 * five-minute stereo track is about 105 MB decoded.
 */

import {
  DRIFT_CORRECTION_WINDOW_MS,
  DRIFT_MAX_RATE_ADJUSTMENT,
  driftCorrection,
} from '@disco/shared';
import {
  gainFromDb,
  type DecodedSegment,
  type EngineClock,
  type PlaybackEngine,
  type TrackRef,
} from './types.js';

/** Supplies decoded audio. Returns null when a segment is not resident yet. */
export interface SegmentSource {
  get(trackId: string, index: number): DecodedSegment | null;
}

/** How far ahead of the playhead segments are wired into the graph. */
const LOOKAHEAD_MS = 60_000;

interface ScheduledSource {
  node: AudioBufferSourceNode;
  index: number;
  startMs: number;
  durationMs: number;
}

export class WebAudioEngine implements PlaybackEngine {
  readonly name = 'webaudio' as const;
  readonly needsDecodedAudio = true;

  readonly #context: AudioContext;
  readonly #master: GainNode;
  /** Loudness normalisation, separate from user volume so neither clobbers the other. */
  readonly #trackGain: GainNode;
  readonly #source: SegmentSource;
  readonly #clock: EngineClock;

  #track: TrackRef | null = null;
  /** Server time at which track position 0 occurs. The one anchor. */
  #anchorServerTime = 0;
  #scheduled: ScheduledSource[] = [];

  /**
   * Rate-aware position tracking.
   *
   * Position cannot be `(contextTime - start) × 1000`: while a fine correction
   * is steering at 0.999, the source emits 19.98 s of track audio per 20 s of
   * context time, and the naive formula would over-report by exactly the 20 ms
   * being corrected — masking the very error it is measuring. So position is
   * integrated across rate changes instead.
   */
  #positionAtMark = 0;
  #contextTimeAtMark = 0;
  #playbackRate = 1;
  #rateResetAt: number | null = null;

  #measuredSkewMs = 0;
  #volume = 1;

  constructor(context: AudioContext, source: SegmentSource, clock: EngineClock) {
    this.#context = context;
    this.#source = source;
    this.#clock = clock;

    this.#trackGain = context.createGain();
    this.#master = context.createGain();
    this.#trackGain.connect(this.#master);
    this.#master.connect(context.destination);
  }

  schedule(track: TrackRef, atServerTime: number, fromPosition: number): void {
    this.#stopSources();
    this.#track = track;
    // Everything downstream derives from this: the server time of position
    // zero. A seek moves it; nothing else does.
    this.#anchorServerTime = atServerTime - fromPosition;
    this.#trackGain.gain.value = gainFromDb(track.gainDb);

    this.#playbackRate = 1;
    this.#rateResetAt = null;
    this.#positionAtMark = fromPosition;
    this.#contextTimeAtMark = this.#contextTimeFor(fromPosition);

    this.ensureScheduled();
  }

  /**
   * Start a second track over the first, fading between them.
   *
   * v1 does gapless cuts, so this is unused at the transport level — but it is
   * the same machinery a crossfade and a channel switch need, and having it now
   * means neither is an engine rewrite (D3, D6).
   */
  scheduleOverlapping(track: TrackRef, atServerTime: number, fadeMs: number): void {
    const fadeStart = Math.max(this.#context.currentTime, this.#contextTimeFor(this.getCurrentPositionMs()));
    const fadeEnd = fadeStart + fadeMs / 1000;

    // Ramp the outgoing track down rather than cutting it: a hard stop under a
    // fade-in is audible as a click.
    this.#trackGain.gain.setValueAtTime(this.#trackGain.gain.value, fadeStart);
    this.#trackGain.gain.linearRampToValueAtTime(0.0001, fadeEnd);
    for (const s of this.#scheduled) {
      try {
        s.node.stop(fadeEnd);
      } catch {
        // Already stopped.
      }
    }
    this.#scheduled = [];

    this.#track = track;
    this.#anchorServerTime = atServerTime;
    this.#playbackRate = 1;
    this.#rateResetAt = null;
    this.#positionAtMark = 0;
    this.#contextTimeAtMark = this.#contextTimeFor(0);

    this.#trackGain.gain.setValueAtTime(0.0001, fadeStart);
    this.#trackGain.gain.exponentialRampToValueAtTime(gainFromDb(track.gainDb), fadeEnd);
    this.ensureScheduled();
  }

  /**
   * Wire any resident segment inside the window into the graph.
   *
   * Called whenever a segment finishes decoding, so a segment that arrives late
   * joins the timeline at its correct position rather than forcing a reschedule
   * of the whole track — which is what a mid-track join looks like from here
   * (D5).
   */
  ensureScheduled(): void {
    const track = this.#track;
    if (!track) return;

    const positionMs = this.getCurrentPositionMs();
    const durations = track.segmentDurationsMs;

    let startMs = 0;
    for (let index = 0; index < durations.length; index++) {
      const durationMs = durations[index] as number;
      const endMs = startMs + durationMs;

      if (endMs <= positionMs || this.#scheduled.some((s) => s.index === index)) {
        startMs = endMs;
        continue;
      }
      if (startMs > positionMs + LOOKAHEAD_MS) break;

      const segment = this.#source.get(track.trackId, index);
      if (segment) this.#wire(segment, index, startMs, durationMs, positionMs);
      startMs = endMs;
    }

    this.#prune(positionMs);
  }

  correctDrift(errorMs: number): boolean {
    this.#measuredSkewMs = errorMs;
    const decision = driftCorrection(errorMs);

    // Web Audio cannot move a source that is already playing, so a coarse
    // correction is the caller's job: it calls `schedule()` again.
    if (decision.action === 'reschedule') return false;

    if (decision.action === 'none') {
      if (this.#playbackRate !== 1) this.#setRate(1);
      return true;
    }

    this.#setRate(decision.playbackRate);
    // Sized to bleed the error off over the window, so the rate has to come
    // back to 1 when it has. Left steering, it becomes drift the other way.
    this.#rateResetAt = this.#clock.now() + DRIFT_CORRECTION_WINDOW_MS;
    return true;
  }

  settleRate(): void {
    if (this.#rateResetAt !== null && this.#clock.now() >= this.#rateResetAt) {
      this.#setRate(1);
      this.#rateResetAt = null;
    }
  }

  /** Where the audio graph actually is, integrated across rate changes. */
  getCurrentPositionMs(): number {
    if (!this.#track) return 0;
    const elapsed = (this.#context.currentTime - this.#contextTimeAtMark) * 1000;
    return this.#positionAtMark + elapsed * this.#playbackRate;
  }

  /** Where the room expects this client to be. The difference is the drift. */
  expectedPositionMs(): number {
    return this.#clock.serverNow() - this.#anchorServerTime;
  }

  getMeasuredSkewMs(): number {
    return this.#measuredSkewMs;
  }

  setVolume(volume: number): void {
    this.#volume = Math.max(0, Math.min(1, volume));
    this.#master.gain.value = this.#volume;
  }

  stop(): void {
    this.#stopSources();
    this.#track = null;
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.#context.close();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #wire(
    segment: DecodedSegment,
    index: number,
    startMs: number,
    durationMs: number,
    positionMs: number,
  ): void {
    const node = this.#context.createBufferSource();
    node.buffer = segment.buffer;
    node.playbackRate.value = this.#playbackRate;
    node.connect(this.#trackGain);

    // Where within this segment to begin. Non-zero only for the segment holding
    // the playhead — the mid-track join.
    const offsetMs = Math.max(0, positionMs - startMs);
    const when = Math.max(this.#context.currentTime, this.#contextTimeFor(startMs + offsetMs));

    node.start(when, offsetMs / 1000);
    this.#scheduled.push({ node, index, startMs, durationMs });
  }

  /** Audio-context time at which a given track position occurs. */
  #contextTimeFor(positionMs: number): number {
    const clientTime = this.#clock.toClientTime(this.#anchorServerTime + positionMs);
    return this.#context.currentTime + (clientTime - this.#clock.now()) / 1000;
  }

  #setRate(rate: number): void {
    const clamped = Math.max(
      1 - DRIFT_MAX_RATE_ADJUSTMENT,
      Math.min(1 + DRIFT_MAX_RATE_ADJUSTMENT, rate),
    );
    if (clamped === this.#playbackRate) return;

    // Snapshot before changing: everything after this point advances at the new
    // rate, and the position integrated so far must not be recomputed with it.
    this.#positionAtMark = this.getCurrentPositionMs();
    this.#contextTimeAtMark = this.#context.currentTime;
    this.#playbackRate = clamped;
    for (const s of this.#scheduled) s.node.playbackRate.value = clamped;
  }

  #prune(positionMs: number): void {
    this.#scheduled = this.#scheduled.filter((s) => {
      if (s.startMs + s.durationMs > positionMs) return true;
      try {
        s.node.stop();
      } catch {
        // Already ended.
      }
      s.node.disconnect();
      return false;
    });
  }

  #stopSources(): void {
    for (const s of this.#scheduled) {
      try {
        s.node.stop();
      } catch {
        // Already ended.
      }
      s.node.disconnect();
    }
    this.#scheduled = [];
  }
}
