import { describe, expect, it } from 'vitest';
import { ConnectionLimits, TokenBucket } from '../src/ratelimit.js';

const T0 = 1_000_000;

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const bucket = new TokenBucket(5, 60, T0);
    for (let i = 0; i < 5; i++) expect(bucket.take(T0)).toBe(true);
    expect(bucket.take(T0)).toBe(false);
  });

  it('refills over time at the configured rate', () => {
    const bucket = new TokenBucket(5, 60, T0);
    for (let i = 0; i < 5; i++) bucket.take(T0);
    // 60 a minute is one a second.
    expect(bucket.take(T0 + 999)).toBe(false);
    expect(bucket.take(T0 + 1_000)).toBe(true);
  });

  it('never refills past capacity', () => {
    // An hour of silence must not buy an hour's worth of burst.
    const bucket = new TokenBucket(5, 60, T0);
    bucket.take(T0 + 3_600_000);
    expect(bucket.tokens).toBeCloseTo(4, 6);
  });

  it('ignores time going backwards', () => {
    const bucket = new TokenBucket(5, 60, T0);
    bucket.take(T0);
    expect(bucket.take(T0 - 100_000)).toBe(true);
    expect(bucket.tokens).toBeCloseTo(3, 6);
  });

  it('supports a cost greater than one', () => {
    const bucket = new TokenBucket(5, 60, T0);
    expect(bucket.take(T0, 5)).toBe(true);
    expect(bucket.take(T0, 1)).toBe(false);
  });
});

describe('ConnectionLimits', () => {
  it('gives pings enough burst for the initial lock-on round', () => {
    // Sixteen samples back to back on connect is normal traffic, not a flood
    // (D9). A limit that throttled it would delay every arrival.
    const limits = new ConnectionLimits(120, 3, T0);
    for (let i = 0; i < 16; i++) expect(limits.ping.take(T0)).toBe(true);
  });

  it('keeps comment burst tight', () => {
    // Under open mode a burst goes straight to the projector, so this limit is
    // a display-integrity control, not just server protection (D7).
    const limits = new ConnectionLimits(120, 3, T0);
    expect(limits.comment.take(T0)).toBe(true);
    expect(limits.comment.take(T0)).toBe(true);
    expect(limits.comment.take(T0)).toBe(true);
    expect(limits.comment.take(T0)).toBe(false);
  });

  it('still allows one comment when the configured rate is zero', () => {
    // A misconfigured zero should not make the field silently dead.
    const limits = new ConnectionLimits(120, 0, T0);
    expect(limits.comment.take(T0)).toBe(true);
    expect(limits.comment.take(T0 + 60_000)).toBe(false);
  });
});
