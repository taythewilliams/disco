/**
 * Client-side clock sync (D9).
 *
 * The estimation maths lives in `@disco/shared` and is shared with the tests
 * that prove it. This is the loop around it: send a round of pings, pair the
 * pongs, fold the round in, repeat.
 *
 * Every timestamp is `performance.now()` and never `Date.now()` — a wall-clock
 * jump mid-set would reschedule the entire room at once.
 */

import { CLOCK_SYNC_INITIAL_SAMPLES, CLOCK_SYNC_RESAMPLE_SAMPLES } from './constants.js';
import { ClockEstimator, type ClockEstimate, type ClockSample } from './clock.js';

export interface ClockSyncDeps {
  /** Send a ping carrying `t0`. */
  send(t0: number): void;
  /** Client monotonic time. */
  now(): number;
  onEstimate?(estimate: ClockEstimate): void;
}

/** Pongs are dropped after this long; the sample is simply lost. */
const SAMPLE_TIMEOUT_MS = 5_000;

export class ClockSync {
  readonly #estimator = new ClockEstimator();
  /** t0 → the round it belongs to. Pairs a pong with its ping. */
  readonly #inflight = new Map<number, { sentAt: number }>();
  #collected: ClockSample[] = [];
  #roundSize = CLOCK_SYNC_INITIAL_SAMPLES;

  constructor(private readonly deps: ClockSyncDeps) {}

  get locked(): boolean {
    return this.#estimator.locked;
  }

  get offsetMs(): number {
    return this.#estimator.offsetMs;
  }

  get rttMs(): number {
    return this.#estimator.rttMs;
  }

  /** Samples waiting on a pong. Exposed for the telemetry panel. */
  get inflightCount(): number {
    return this.#inflight.size;
  }

  /**
   * Send a round.
   *
   * Sixteen samples on connect, eight after that. The first round is the one
   * that has to be right — everything scheduled before it lands is scheduled
   * against nothing.
   */
  beginRound(size: number = this.locked ? CLOCK_SYNC_RESAMPLE_SAMPLES : CLOCK_SYNC_INITIAL_SAMPLES): void {
    this.#roundSize = size;
    this.#collected = [];
    this.#inflight.clear();
    for (let i = 0; i < size; i++) this.ping();
  }

  /** One ping. `t0` doubles as the correlation key, so it must be unique. */
  ping(): void {
    let t0 = this.deps.now();
    // `performance.now()` can return the same value twice in a tight loop, and
    // a duplicated key would pair the wrong pong with the wrong ping.
    while (this.#inflight.has(t0)) t0 += 1e-6;
    this.#inflight.set(t0, { sentAt: t0 });
    this.deps.send(t0);
  }

  /**
   * Pair a pong with its ping and stamp `t2` on arrival.
   *
   * Returns the folded estimate when the round completes, or null while it is
   * still filling.
   */
  handlePong(t0: number, t1: number): ClockEstimate | null {
    const pending = this.#inflight.get(t0);
    // An unrecognised t0 is either a stale pong from a previous round or a
    // fabricated one. Neither belongs in the estimate.
    if (!pending) return null;
    this.#inflight.delete(t0);

    this.#collected.push({ t0, t1, t2: this.deps.now() });
    if (this.#collected.length < this.#roundSize) return null;
    return this.#fold();
  }

  /**
   * Fold whatever has arrived, even if the round is short.
   *
   * Called on a timeout so that a few dropped pongs delay the lock rather than
   * preventing it — a client with no offset cannot play at all.
   */
  flush(): ClockEstimate | null {
    this.#expire();
    if (this.#collected.length === 0) return null;
    return this.#fold();
  }

  /** Server time corresponding to a client monotonic reading. */
  toServerTime(clientMonotonicMs: number): number {
    return this.#estimator.toServerTime(clientMonotonicMs);
  }

  /** Client monotonic time at which a given server time occurs. */
  toClientTime(serverTimeMs: number): number {
    return this.#estimator.toClientTime(serverTimeMs);
  }

  estimatedServerNow(): number {
    return this.#estimator.toServerTime(this.deps.now());
  }

  #fold(): ClockEstimate | null {
    const estimate = this.#estimator.update(this.#collected);
    this.#collected = [];
    this.#inflight.clear();
    if (estimate) this.deps.onEstimate?.(estimate);
    return estimate;
  }

  #expire(): void {
    const cutoff = this.deps.now() - SAMPLE_TIMEOUT_MS;
    for (const [t0, pending] of this.#inflight) {
      if (pending.sentAt < cutoff) this.#inflight.delete(t0);
    }
  }
}
