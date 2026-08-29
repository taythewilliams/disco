/**
 * Clock-offset estimation, NTP-style, over the control WebSocket (D9).
 *
 * Pure functions plus one small stateful holder. No I/O, no timers, no
 * `performance.now()` calls inside the math — the caller supplies every
 * timestamp, which is what makes the whole thing testable.
 */

import {
  CLOCK_SYNC_MIN_SURVIVORS,
  CLOCK_SYNC_RTT_QUANTILE,
  CLOCK_SYNC_SMOOTHING_ALPHA,
} from './constants.js';

/**
 * One ping round trip.
 * - `t0` client monotonic time at send
 * - `t1` server time stamped on receipt
 * - `t2` client monotonic time on arrival of the pong
 */
export interface ClockSample {
  t0: number;
  t1: number;
  t2: number;
}

export interface ClockEstimate {
  /** Add to a client monotonic reading to get server time. */
  offsetMs: number;
  /** Median round-trip time of the samples that survived filtering. */
  rttMs: number;
  /** How many samples the estimate was computed from. */
  survivors: number;
}

export const rttOf = (s: ClockSample): number => s.t2 - s.t0;

/**
 * Assumes a symmetric path: the request and response each took half the RTT.
 * Asymmetry is the entire error term, which is why low-RTT samples are kept.
 */
export const offsetOf = (s: ClockSample): number => s.t1 - (s.t0 + s.t2) / 2;

/** Linear-interpolated quantile over a copy of `values`. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new RangeError('quantile of empty set');
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loV = sorted[lo] as number;
  if (lo === hi) return loV;
  return loV + ((sorted[hi] as number) - loV) * (pos - lo);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/**
 * Discard every sample whose RTT sits above the configured quantile, then take
 * the median offset of the survivors. Returns `null` for an empty input rather
 * than a fabricated zero — a missing estimate must stay visibly missing.
 */
export function estimateOffset(
  samples: readonly ClockSample[],
  quantileCut: number = CLOCK_SYNC_RTT_QUANTILE,
): ClockEstimate | null {
  if (samples.length === 0) return null;

  const rtts = samples.map(rttOf);
  const cut = quantile(rtts, quantileCut);

  let survivors = samples.filter((s) => rttOf(s) <= cut);
  // A tight RTT spread can leave too few to take a meaningful median, so fall
  // back to the N fastest rather than to a single sample.
  if (survivors.length < CLOCK_SYNC_MIN_SURVIVORS) {
    survivors = [...samples]
      .sort((a, b) => rttOf(a) - rttOf(b))
      .slice(0, Math.min(CLOCK_SYNC_MIN_SURVIVORS, samples.length));
  }

  return {
    offsetMs: median(survivors.map(offsetOf)),
    rttMs: median(survivors.map(rttOf)),
    survivors: survivors.length,
  };
}

/**
 * Holds the running offset. The first round locks directly; every round after
 * it is blended in, so the estimate is never step-corrected while audio is
 * scheduled against it (D9).
 */
export class ClockEstimator {
  #offsetMs: number | null = null;
  #rttMs = 0;
  readonly #alpha: number;

  constructor(alpha: number = CLOCK_SYNC_SMOOTHING_ALPHA) {
    this.#alpha = alpha;
  }

  get locked(): boolean {
    return this.#offsetMs !== null;
  }

  /** Throws until the first round has landed; check `locked` first. */
  get offsetMs(): number {
    if (this.#offsetMs === null) throw new Error('clock not yet synchronised');
    return this.#offsetMs;
  }

  get rttMs(): number {
    return this.#rttMs;
  }

  /**
   * Fold a round of samples in. Returns the resulting estimate, or `null` if the
   * round produced nothing usable and the previous estimate stands.
   */
  update(samples: readonly ClockSample[]): ClockEstimate | null {
    const next = estimateOffset(samples);
    if (next === null) return null;

    this.#offsetMs =
      this.#offsetMs === null
        ? next.offsetMs
        : this.#offsetMs + this.#alpha * (next.offsetMs - this.#offsetMs);
    this.#rttMs = this.#rttMs === 0 ? next.rttMs : this.#rttMs + this.#alpha * (next.rttMs - this.#rttMs);

    return { offsetMs: this.#offsetMs, rttMs: this.#rttMs, survivors: next.survivors };
  }

  /** Server time corresponding to a client monotonic reading. */
  toServerTime(clientMonotonicMs: number): number {
    return clientMonotonicMs + this.offsetMs;
  }

  /** Client monotonic time at which a given server time occurs. */
  toClientTime(serverTimeMs: number): number {
    return serverTimeMs - this.offsetMs;
  }
}
