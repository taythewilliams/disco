/**
 * The playback engine contract (D2).
 *
 * Two implementations behind one interface, chosen at runtime by capability
 * detection with a server-driven override. Both report `getMeasuredSkewMs()` as
 * telemetry, so the eventual decision to drop one is made on evidence from the
 * room rather than on an opinion.
 *
 * `scheduleOverlapping` is here from day one even though v1 does gapless cuts:
 * it is the same machinery as the future crossfade and as channel switching, so
 * building it now costs a method and building it later costs a rewrite (D5, D6).
 */

export interface TrackRef {
  trackId: string;
  /** Exact durations, in play order. The schedule sums these (D10). */
  segmentDurationsMs: readonly number[];
  /** Loudness-normalisation gain, applied on output (D10). */
  gainDb: number;
}

export interface PlaybackEngine {
  /** Play `track` so that position `fromPosition` lands at `atServerTime`. */
  schedule(track: TrackRef, atServerTime: number, fromPosition: number): void | Promise<void>;

  /** Start `track` while the current one fades out. Crossfade and channel switch. */
  scheduleOverlapping(track: TrackRef, atServerTime: number, fadeMs: number): void;

  /**
   * Answer a measured drift.
   *
   * Returns true when the engine dealt with it, false when the caller has to
   * reschedule instead. The two engines differ here honestly: Web Audio cannot
   * move a source that is already playing, so a coarse correction becomes the
   * caller's `schedule()`; a media element can seek itself.
   */
  correctDrift(errorMs: number): boolean;

  /** Return `playbackRate` to 1 once a fine correction has bled off. */
  settleRate(): void;

  /** Take up any newly available segments. Called on every scheduling pass. */
  ensureScheduled(): void;

  /** Where the room expects this client to be. The difference is the drift. */
  expectedPositionMs(): number;

  /**
   * Whether this engine consumes decoded `AudioBuffer`s or encoded bytes.
   *
   * Web Audio needs `decodeAudioData` output — Float32, ~35 MB a segment. A
   * media element is fed the encoded fragments directly through MSE and never
   * wants the decoded form, so decoding for it would burn both CPU and the
   * memory headroom the resident window exists to protect (D2).
   */
  readonly needsDecodedAudio: boolean;

  /** Position within the current track, in milliseconds. */
  getCurrentPositionMs(): number;

  /**
   * The engine's own estimate of how far its output is from where it was asked
   * to be. Telemetry, not control.
   */
  getMeasuredSkewMs(): number;

  /** Master volume, 0–1, applied after loudness normalisation. */
  setVolume(volume: number): void;

  stop(): void;
  dispose(): Promise<void>;

  readonly name: 'webaudio' | 'mediaelement';
}

/** Decoded audio for one segment, plus where it sits in the track. */
export interface DecodedSegment {
  trackId: string;
  index: number;
  startMs: number;
  durationMs: number;
  buffer: AudioBuffer;
}

/**
 * What an engine needs from the clock. Injected rather than reached for, so
 * tests drive time directly and neither engine owns a second definition of the
 * offset.
 */
export interface EngineClock {
  /** Current client monotonic time. */
  now(): number;
  /** Current estimated server time. */
  serverNow(): number;
  /** Client monotonic time at which a given server time occurs. */
  toClientTime(serverTimeMs: number): number;
}

/** dB → linear gain. −14 LUFS normalisation arrives as dB and is applied here. */
export function gainFromDb(db: number): number {
  return Math.pow(10, db / 20);
}
