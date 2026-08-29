/**
 * Per-connection rate limiting (D12).
 *
 * Two things need it for different reasons. Clock-sync pings are the cheapest
 * message to flood, so their limit is server protection. Comment submissions
 * under open mode go straight to a projector in front of a room, so their limit
 * is a display-integrity control (D7).
 *
 * A token bucket rather than a fixed window: a guest who has been quiet for a
 * minute can still send a short burst, which is what real use looks like, while
 * the sustained rate stays capped.
 */

export class TokenBucket {
  #tokens: number;
  #lastRefillAt: number;

  constructor(
    readonly capacity: number,
    readonly refillPerMinute: number,
    now: number,
  ) {
    this.#tokens = capacity;
    this.#lastRefillAt = now;
  }

  /** Take a token if one is available. Returns false when the caller is over. */
  take(now: number, cost = 1): boolean {
    this.#refill(now);
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }

  get tokens(): number {
    return this.#tokens;
  }

  #refill(now: number): void {
    const elapsed = now - this.#lastRefillAt;
    if (elapsed <= 0) return;
    this.#lastRefillAt = now;
    this.#tokens = Math.min(this.capacity, this.#tokens + (elapsed / 60_000) * this.refillPerMinute);
  }
}

/**
 * The limits a single connection carries.
 *
 * Burst capacity differs from the sustained rate on purpose: a client opening a
 * connection fires sixteen pings back to back to lock its clock (D9), which is
 * normal and must not be throttled, while sixteen a second forever is not.
 */
export class ConnectionLimits {
  readonly ping: TokenBucket;
  readonly comment: TokenBucket;

  constructor(pingsPerMinute: number, commentsPerMinute: number, now: number) {
    this.ping = new TokenBucket(Math.max(20, pingsPerMinute), pingsPerMinute, now);
    this.comment = new TokenBucket(Math.max(1, commentsPerMinute), commentsPerMinute, now);
  }
}
