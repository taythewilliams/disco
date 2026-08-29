/**
 * `MediaElementEngine` — an `<audio>` element fed through Media Source
 * Extensions, steered by `currentTime` and `playbackRate` (D2).
 *
 * Coarser than Web Audio, around 30–50 ms, which is a real cost against a
 * 35–80 ms budget. What it buys is survival: it keeps playing with the screen
 * locked and gives real lock-screen controls through Media Session (D16).
 *
 * It consumes the same fMP4 fragments as the other engine. The init segment is
 * appended once, then fragments follow, and each fragment's own
 * `baseMediaDecodeTime` places it on the MSE timeline — so `element.currentTime`
 * *is* the track position, and a mid-track joiner can append segment three
 * alone and seek straight to it.
 *
 * Capability note: MSE on iPhone Safari arrived in iOS 17.1, as Managed Media
 * Source. `mediaElementSupported()` is what keeps an older device from
 * selecting an engine it cannot feed.
 */

import { DRIFT_CORRECTION_WINDOW_MS, driftCorrection, segmentIndexAt } from '@disco/shared';
import { gainFromDb, type EngineClock, type PlaybackEngine, type TrackRef } from './types.js';

/** Supplies encoded bytes. Returns null when a segment is not downloaded yet. */
export interface EncodedSegmentSource {
  /** The track's initialisation segment. Required before any fragment. */
  init(trackId: string): ArrayBuffer | null;
  fragment(trackId: string, index: number): ArrayBuffer | null;
}

const MIME = 'audio/mp4; codecs="mp4a.40.2"';

type MediaSourceCtor = {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
};

function mediaSourceCtor(scope: typeof globalThis = globalThis): MediaSourceCtor | null {
  const g = scope as unknown as {
    ManagedMediaSource?: MediaSourceCtor;
    MediaSource?: MediaSourceCtor;
  };
  // Managed Media Source first: on iOS it is the only one, and where both exist
  // it lets the platform manage buffering pressure itself.
  return g.ManagedMediaSource ?? g.MediaSource ?? null;
}

/** Whether this browser can be fed segments at all. */
export function mediaElementSupported(scope: typeof globalThis = globalThis): boolean {
  const Ctor = mediaSourceCtor(scope);
  try {
    return Ctor !== null && Ctor.isTypeSupported(MIME);
  } catch {
    return false;
  }
}

/** How far ahead of the playhead fragments are appended. */
const APPEND_AHEAD_MS = 90_000;

export class MediaElementEngine implements PlaybackEngine {
  readonly name = 'mediaelement' as const;
  /** Fed encoded bytes straight through MSE; decoded buffers would be waste. */
  readonly needsDecodedAudio = false;

  readonly #element: HTMLAudioElement;
  readonly #source: EncodedSegmentSource;
  readonly #clock: EngineClock;

  #mediaSource: MediaSource | null = null;
  #buffer: SourceBuffer | null = null;
  #track: TrackRef | null = null;
  /** Server time at which track position 0 occurs. The one anchor. */
  #anchorServerTime = 0;
  #appended = new Set<number>();
  #appendQueue: ArrayBuffer[] = [];
  #appending = false;
  #initAppended = false;
  #measuredSkewMs = 0;
  #rateResetAt: number | null = null;
  /**
   * Whether the one-off startup correction has been applied since the last
   * `schedule()`.
   *
   * Seeking and then starting playback is not instantaneous: the room moves on
   * while the element gets going, leaving a systematic offset — measured at
   * about −52 ms on a laptop. It is under the 60 ms coarse threshold, so the
   * fine correction owns it, and at 0.1 % that takes roughly three minutes to
   * bleed off. Tracks are shorter than that and every track boundary
   * re-creates it, so left alone it never converges at all. One corrective seek
   * as soon as the element is really playing removes it outright, and it is
   * inaudible there because the audio has only just begun.
   */
  #startupCorrected = false;
  #volume = 1;
  #gainDb = 0;
  /** How far ahead of the room to aim a seek, to land on it. Server-driven (D11). */
  #seekBiasMs = 0;

  constructor(element: HTMLAudioElement, source: EncodedSegmentSource, clock: EngineClock) {
    this.#element = element;
    this.#source = source;
    this.#clock = clock;
  }

  /**
   * Set the seek bias.
   *
   * Kept as a setter rather than a constructor argument because it is remote
   * config: the DJ can correct it from the dashboard while the room is dancing.
   */
  setSeekBiasMs(ms: number): void {
    this.#seekBiasMs = ms;
  }

  /** Where to aim a seek so the element lands on the room rather than behind it. */
  #seekTargetSec(): number {
    return Math.max(0, this.expectedPositionMs() + this.#seekBiasMs) / 1000;
  }

  async schedule(track: TrackRef, atServerTime: number, fromPosition: number): Promise<void> {
    await this.#reset();
    this.#track = track;
    this.#anchorServerTime = atServerTime - fromPosition;
    this.#gainDb = track.gainDb;
    this.#startupCorrected = false;
    this.#applyVolume();

    await this.#openSource();
    this.ensureScheduled();

    // Seek before playing: the element must be positioned at the room's
    // playhead, not at zero, or a late joiner restarts the track (D5). Aimed
    // ahead by the seek bias, because the element lands late by its own resume
    // cost and seeking again cannot recover it.
    this.#element.currentTime = this.#seekTargetSec();
    await this.#element.play().catch(() => {
      // Autoplay refused until a gesture. The arrival flow spends one on the
      // join tap before this point; if it still fails the caller surfaces it.
    });
  }

  /**
   * A crossfade needs two elements, which this engine does not own. v1 does
   * gapless cuts, so the honest thing is a hard cut rather than pretending a
   * fade happened (D6).
   */
  scheduleOverlapping(track: TrackRef, atServerTime: number, _fadeMs: number): void {
    void this.schedule(track, atServerTime, 0);
  }

  /**
   * Append every downloaded fragment in the window, in order.
   *
   * Starts at the segment holding the playhead, not at zero. A guest joining
   * 95 s into a track never fetches segment zero, so starting there would find
   * a gap immediately and append nothing at all — the same mistake that stalled
   * mid-track joins in the scheduler (D5).
   */
  ensureScheduled(): void {
    const track = this.#track;
    if (!track || !this.#buffer) return;

    if (!this.#initAppended) {
      const init = this.#source.init(track.trackId);
      // A fragment without its init segment is not decodable at all — the same
      // constraint the Web Audio path works around by concatenation.
      if (!init) return;
      this.#initAppended = true;
      this.#enqueue(init);
    }

    const durations = track.segmentDurationsMs;
    const positionMs = Math.max(0, this.getCurrentPositionMs());
    const first = segmentIndexAt(durations, positionMs);

    let startMs = 0;
    for (let i = 0; i < first; i++) startMs += durations[i] as number;

    for (let index = first; index < durations.length; index++) {
      if (startMs > positionMs + APPEND_AHEAD_MS) break;
      if (!this.#appended.has(index)) {
        const bytes = this.#source.fragment(track.trackId, index);
        // Stop at the first gap: MSE fragments must be appended in order from
        // wherever the run starts, and skipping one leaves a hole the element
        // stalls in.
        if (!bytes) break;
        this.#appended.add(index);
        this.#enqueue(bytes);
      }
      startMs += durations[index] as number;
    }
  }

  correctDrift(errorMs: number): boolean {
    this.#measuredSkewMs = errorMs;
    const decision = driftCorrection(errorMs);

    // The startup offset, taken out once rather than steered at 0.1 % for
    // longer than the track lasts. Only after the element is genuinely playing,
    // so the measurement is against a real `currentTime` rather than a
    // placeholder.
    if (!this.#startupCorrected && this.#element.readyState > 0 && decision.action !== 'none') {
      this.#startupCorrected = true;
      this.#element.currentTime = this.#seekTargetSec();
      this.#element.playbackRate = 1;
      this.#rateResetAt = null;
      return true;
    }

    if (decision.action === 'reschedule') {
      // Seek to where the room is, not to where the element already is —
      // reading the current position here would make the correction a no-op.
      // Coarser than Web Audio's reschedule and audible, which is exactly why
      // the deadband and the fine correction exist above it (D9).
      this.#element.currentTime = this.#seekTargetSec();
      this.#element.playbackRate = 1;
      this.#rateResetAt = null;
      return true;
    }
    if (decision.action === 'none') {
      if (this.#element.playbackRate !== 1) this.#element.playbackRate = 1;
      return true;
    }

    this.#element.playbackRate = decision.playbackRate;
    this.#rateResetAt = this.#clock.now() + DRIFT_CORRECTION_WINDOW_MS;
    return true;
  }

  settleRate(): void {
    if (this.#rateResetAt !== null && this.#clock.now() >= this.#rateResetAt) {
      this.#element.playbackRate = 1;
      this.#rateResetAt = null;
    }
  }

  /**
   * Where the element actually is.
   *
   * This differs from the Web Audio engine on purpose. There, position is
   * derived from the clock because the graph plays exactly what it was
   * scheduled. Here the element is the authority, and the gap between it and
   * the clock *is* the drift the caller is measuring.
   */
  getCurrentPositionMs(): number {
    if (!this.#track) return 0;
    // Before metadata arrives, `currentTime` is 0 and would read as a huge
    // negative drift. Fall back to the schedule until the element is real.
    if (this.#element.readyState === 0) return this.expectedPositionMs();
    return this.#element.currentTime * 1000;
  }

  expectedPositionMs(): number {
    return this.#clock.serverNow() - this.#anchorServerTime;
  }

  getMeasuredSkewMs(): number {
    return this.#measuredSkewMs;
  }

  setVolume(volume: number): void {
    this.#volume = Math.max(0, Math.min(1, volume));
    this.#applyVolume();
  }

  stop(): void {
    this.#element.pause();
    this.#track = null;
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.#reset();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Loudness normalisation and user volume multiply into one element volume.
   *
   * An element has no gain stage, so unlike the Web Audio path these cannot be
   * separate nodes. Clamped at 1: an element cannot amplify, so a track wanting
   * positive gain is left where it is rather than distorted.
   */
  #applyVolume(): void {
    this.#element.volume = Math.max(0, Math.min(1, this.#volume * gainFromDb(this.#gainDb)));
  }

  async #openSource(): Promise<void> {
    const Ctor = mediaSourceCtor();
    if (!Ctor) throw new Error('MediaSource unavailable');

    const mediaSource = new Ctor();
    this.#mediaSource = mediaSource;
    this.#element.src = URL.createObjectURL(mediaSource);

    await new Promise<void>((resolve) => {
      mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
    });

    const buffer = mediaSource.addSourceBuffer(MIME);
    // `segments` mode: each fragment's own timestamps place it on the timeline,
    // which is what lets a mid-track joiner append segment three by itself.
    buffer.mode = 'segments';
    buffer.addEventListener('updateend', () => {
      this.#appending = false;
      this.#drain();
    });
    this.#buffer = buffer;
  }

  #enqueue(bytes: ArrayBuffer): void {
    this.#appendQueue.push(bytes);
    this.#drain();
  }

  /** One append at a time: `appendBuffer` throws while the buffer is updating. */
  #drain(): void {
    if (this.#appending || !this.#buffer || this.#buffer.updating) return;
    const next = this.#appendQueue.shift();
    if (!next) return;
    this.#appending = true;
    try {
      this.#buffer.appendBuffer(next);
    } catch {
      // Quota exceeded, or the source closed under us. The next pass retries;
      // a throw here would take the whole scheduling loop down.
      this.#appending = false;
    }
  }

  async #reset(): Promise<void> {
    this.#appendQueue = [];
    this.#appended.clear();
    this.#appending = false;
    this.#initAppended = false;
    this.#buffer = null;
    if (this.#mediaSource && this.#mediaSource.readyState === 'open') {
      try {
        this.#mediaSource.endOfStream();
      } catch {
        // Already ended.
      }
    }
    if (this.#element.src.startsWith('blob:')) URL.revokeObjectURL(this.#element.src);
    this.#mediaSource = null;
  }
}
