/**
 * Segment residency and prefetch planning.
 *
 * Two separate questions that are easy to conflate:
 *
 * - **Residency** — which decoded segments to keep in memory. `decodeAudioData`
 *   returns Float32, so a five-minute stereo track is ~105 MB decoded. Holding
 *   two or three ~25 s segments instead is not an optimisation, it is the only
 *   way this runs on a phone (D2).
 * - **Prefetch** — which encoded segments to download. Bounded by the horizon,
 *   ordered so that the thing needed soonest arrives first (D5).
 *
 * Both are pure functions over plain data, which is what lets the whole
 * download-prioritisation story be tested without a network.
 */

import { RESIDENT_SEGMENTS } from './constants.js';
import { segmentIndexAt } from './position.js';
import type { ReadinessState } from './protocol.js';

export interface TrackPlan {
  trackId: string;
  /** Exact durations, in play order. */
  segmentDurationsMs: readonly number[];
}

/** Stable key for a segment, used for cache membership and dedupe. */
export const segmentKey = (trackId: string, index: number): string => `${trackId}:${index}`;

/**
 * Segment indices that should be decoded and resident for a given position.
 *
 * Always starts at the segment containing `positionMs` — never behind it. A
 * client that keeps the segment it just played is holding 35 MB it will not use
 * again.
 */
export function residentWindow(
  segmentDurationsMs: readonly number[],
  positionMs: number,
  count: number = RESIDENT_SEGMENTS,
): number[] {
  if (segmentDurationsMs.length === 0) return [];
  const first = segmentIndexAt(segmentDurationsMs, positionMs);
  const window: number[] = [];
  for (let i = first; i < segmentDurationsMs.length && window.length < count; i++) {
    window.push(i);
  }
  return window;
}

export interface PrefetchRequest {
  trackId: string;
  segmentIndex: number;
  /** Lower is more urgent. Ordering, not a queue depth. */
  priority: number;
}

export interface PrefetchOptions {
  /** The playing track, then the queue in order. */
  plans: readonly TrackPlan[];
  /** Which of `plans` is playing, or -1 when the channel is idle. */
  currentIndex: number;
  /** Position within the playing track. Negative before it starts. */
  positionMs: number;
  /** How far ahead of the playhead to buffer within the playing track. */
  bufferAheadMs: number;
  /** Tracks beyond the playing one that may be fetched at all (D5). */
  horizonTracks: number;
  /** Segment keys already held, so a plan is only ever the work remaining. */
  have: ReadonlySet<string>;
}

/**
 * What to download next, most urgent first.
 *
 * The ordering is the point. A guest arriving mid-set needs the *current*
 * track's next few segments before anything else; a queued track four ahead can
 * wait. With thirty phones sharing one access point, fetching in the wrong
 * order is indistinguishable from not having enough bandwidth (D4).
 */
export function planPrefetch(opts: PrefetchOptions): PrefetchRequest[] {
  const requests: PrefetchRequest[] = [];
  let priority = 0;

  const push = (trackId: string, segmentIndex: number) => {
    const key = segmentKey(trackId, segmentIndex);
    if (opts.have.has(key)) return;
    if (requests.some((r) => segmentKey(r.trackId, r.segmentIndex) === key)) return;
    requests.push({ trackId, segmentIndex, priority: priority++ });
  };

  // 1. The playing track, from the playhead forward, as far as the buffer
  //    target reaches. This is what silence sounds like if it is late.
  const current = opts.currentIndex >= 0 ? opts.plans[opts.currentIndex] : undefined;
  if (current) {
    const durations = current.segmentDurationsMs;
    const from = segmentIndexAt(durations, Math.max(0, opts.positionMs));
    // A negative position means the track has not started; the whole buffer
    // target still applies, measured from the top of the track.
    const target = Math.max(0, opts.positionMs) + opts.bufferAheadMs;
    let covered = 0;
    for (let i = 0; i < from; i++) covered += durations[i] as number;
    for (let i = from; i < durations.length; i++) {
      push(current.trackId, i);
      covered += durations[i] as number;
      if (covered >= target) break;
    }
  }

  // 2. Then the head of each queued track inside the horizon, breadth-first.
  //    One segment from each before a second from any: a track that is
  //    partially there can start on time and buffer the rest (D5, "Partial").
  const upcoming = opts.plans.slice(
    opts.currentIndex >= 0 ? opts.currentIndex + 1 : 0,
    (opts.currentIndex >= 0 ? opts.currentIndex + 1 : 0) + opts.horizonTracks,
  );
  const deepest = Math.max(0, ...upcoming.map((p) => p.segmentDurationsMs.length));
  for (let depth = 0; depth < deepest; depth++) {
    for (const plan of upcoming) {
      if (depth < plan.segmentDurationsMs.length) push(plan.trackId, depth);
    }
  }

  return requests;
}

/**
 * Readiness of a queued track, as the dashboard shows it (D5). Aliased to the
 * wire enum so the value a client computes and the value it reports are the
 * same type by construction.
 */
export type Readiness = ReadinessState;

/**
 * Ready means every segment is held; partial means enough to start and keep
 * buffering; not-ready means a mid-track join with a visible catch-up.
 */
export function readinessOf(plan: TrackPlan, have: ReadonlySet<string>): Readiness {
  const total = plan.segmentDurationsMs.length;
  if (total === 0) return 'not-ready';
  let held = 0;
  for (let i = 0; i < total; i++) {
    if (have.has(segmentKey(plan.trackId, i))) held++;
  }
  if (held === total) return 'ready';
  // The first segment is the one that decides whether playback can begin at
  // all; without it there is nothing to start.
  return held > 0 && have.has(segmentKey(plan.trackId, 0)) ? 'partial' : 'not-ready';
}
