/**
 * Playback position math.
 *
 * The whole architecture rests on one identity: `position = serverNow -
 * startAtServerTime`. Late joins, reconnects, reloads, engine switches and
 * channel switches are all that same line, which is why there is no special
 * case anywhere else in the system (v4 Part 2).
 */

import {
  DRIFT_CORRECTION_WINDOW_MS,
  DRIFT_DEADBAND_MS,
  DRIFT_MAX_RATE_ADJUSTMENT,
  DRIFT_RESCHEDULE_THRESHOLD_MS,
} from './constants.js';

/** The subset of a `state` message the position math needs. */
export interface TimelineState {
  /** Server time at which track position 0 occurs. */
  startAtServerTime: number;
  paused: boolean;
  /** Position frozen at the moment of pausing. Null while playing. */
  pausedAtPosition: number | null;
}

/**
 * Position in the track at a given server time. Negative means the track has
 * not started yet — the caller wants that value, because a negative position is
 * exactly the lead time available to schedule against.
 */
export function positionAtServerTime(state: TimelineState, serverTimeMs: number): number {
  if (state.paused) return state.pausedAtPosition ?? 0;
  return serverTimeMs - state.startAtServerTime;
}

/**
 * The client monotonic time at which to *emit* position 0 so that it is *heard*
 * at `startAtServerTime`.
 *
 * `calibrationMs` is the guest's measured output latency: audio emitted at T
 * reaches the ear at T + calibrationMs, so emission moves that much earlier.
 * Per Part 0 only the spread between guests matters here — a bias shared by
 * everyone is inaudible.
 */
export function emitTimeForStart(
  startAtServerTime: number,
  clockOffsetMs: number,
  calibrationMs: number,
): number {
  return startAtServerTime - clockOffsetMs - calibrationMs;
}

/** Server time at which a given track position occurs. Inverse of the identity above. */
export function serverTimeForPosition(state: TimelineState, positionMs: number): number {
  return state.startAtServerTime + positionMs;
}

/**
 * Recompute `startAtServerTime` for a seek or an unpause, so that the timeline
 * keeps meaning "position 0 happened here" rather than growing a second origin.
 */
export function startTimeForSeek(positionMs: number, atServerTime: number): number {
  return atServerTime - positionMs;
}

export type DriftAction = 'none' | 'rate' | 'reschedule';

export interface DriftCorrection {
  action: DriftAction;
  /** Rate to apply for a fine correction; always 1 for the other actions. */
  playbackRate: number;
}

export interface DriftThresholds {
  deadbandMs?: number;
  rescheduleThresholdMs?: number;
  correctionWindowMs?: number;
  maxRateAdjustment?: number;
}

/**
 * Decide how to answer a measured drift.
 *
 * `errorMs` is `actualPosition - expectedPosition`: positive means playback has
 * run ahead of the schedule, so the rate goes below 1 to bleed it off.
 * Corrections spread over ~20 s at ≤0.1 %, which is roughly a cent of pitch
 * shift — inaudible. Anything a nudge cannot absorb in that window gets a hard
 * reschedule instead (D9).
 */
export function driftCorrection(errorMs: number, t: DriftThresholds = {}): DriftCorrection {
  const deadband = t.deadbandMs ?? DRIFT_DEADBAND_MS;
  const reschedule = t.rescheduleThresholdMs ?? DRIFT_RESCHEDULE_THRESHOLD_MS;
  const window = t.correctionWindowMs ?? DRIFT_CORRECTION_WINDOW_MS;
  const maxAdjust = t.maxRateAdjustment ?? DRIFT_MAX_RATE_ADJUSTMENT;

  const magnitude = Math.abs(errorMs);
  if (!Number.isFinite(errorMs) || magnitude < deadband) {
    return { action: 'none', playbackRate: 1 };
  }
  if (magnitude >= reschedule) {
    return { action: 'reschedule', playbackRate: 1 };
  }

  const raw = -errorMs / window;
  const clamped = Math.max(-maxAdjust, Math.min(maxAdjust, raw));
  return { action: 'rate', playbackRate: 1 + clamped };
}

/** Index of the segment containing `positionMs`, given each segment's exact duration. */
export function segmentIndexAt(segmentDurationsMs: readonly number[], positionMs: number): number {
  if (positionMs < 0) return 0;
  let elapsed = 0;
  for (let i = 0; i < segmentDurationsMs.length; i++) {
    elapsed += segmentDurationsMs[i] as number;
    if (positionMs < elapsed) return i;
  }
  return segmentDurationsMs.length - 1;
}

/** Start offset of a segment within the track. */
export function segmentStartMs(segmentDurationsMs: readonly number[], index: number): number {
  let start = 0;
  for (let i = 0; i < index && i < segmentDurationsMs.length; i++) {
    start += segmentDurationsMs[i] as number;
  }
  return start;
}
