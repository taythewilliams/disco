import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/clocksync.js';

/**
 * A fake link with a known one-way delay and a known server offset, so a test
 * can assert the recovered offset against ground truth.
 */
function link(options: { trueOffset: number; upMs: number; downMs: number }) {
  let clock = 1_000;
  let trueOffset = options.trueOffset;
  const sent: number[] = [];
  const sync = new ClockSync({
    send: (t0) => sent.push(t0),
    now: () => clock,
  });

  return {
    sync,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Move the server's clock, to exercise how a later round is folded in. */
    setOffset: (offset: number) => {
      trueOffset = offset;
    },
    get clock() {
      return clock;
    },
    /** Deliver the pongs for the first `count` outstanding pings. */
    deliver(count = Number.POSITIVE_INFINITY) {
      const pending = sent.splice(0, Math.min(count, sent.length));
      for (const t0 of pending) {
        clock = t0 + options.upMs + options.downMs;
        sync.handlePong(t0, t0 + options.upMs + trueOffset);
      }
    },
    get pendingCount() {
      return sent.length;
    },
  };
}

describe('ClockSync', () => {
  it('is unlocked until the first round completes', () => {
    const { sync } = link({ trueOffset: 500_000, upMs: 5, downMs: 5 });
    expect(sync.locked).toBe(false);
    sync.beginRound(16);
    expect(sync.locked).toBe(false);
  });

  it('recovers the true offset on a symmetric link', () => {
    const l = link({ trueOffset: 500_000, upMs: 5, downMs: 5 });
    l.sync.beginRound(16);
    l.deliver();
    expect(l.sync.locked).toBe(true);
    expect(l.sync.offsetMs).toBe(500_000);
    expect(l.sync.rttMs).toBe(10);
  });

  it('sends exactly the round size', () => {
    const l = link({ trueOffset: 0, upMs: 5, downMs: 5 });
    l.sync.beginRound(16);
    expect(l.pendingCount).toBe(16);
  });

  it('converts both directions once locked', () => {
    const l = link({ trueOffset: 500_000, upMs: 5, downMs: 5 });
    l.sync.beginRound(16);
    l.deliver();
    const clientTime = l.clock;
    expect(l.sync.toServerTime(clientTime)).toBe(clientTime + 500_000);
    expect(l.sync.toClientTime(clientTime + 500_000)).toBeCloseTo(clientTime, 6);
    expect(l.sync.estimatedServerNow()).toBeCloseTo(clientTime + 500_000, 6);
  });

  it('ignores a pong for a ping it never sent', () => {
    // Either a stale sample from a previous round or a fabricated one. Neither
    // belongs in the estimate.
    const l = link({ trueOffset: 500_000, upMs: 5, downMs: 5 });
    l.sync.beginRound(4);
    expect(l.sync.handlePong(999_999, 12_345)).toBeNull();
    l.deliver();
    expect(l.sync.offsetMs).toBe(500_000);
  });

  it('never pairs two pings on the same key', () => {
    // `performance.now()` can return the same value twice in a tight loop, and
    // a duplicated key would pair the wrong pong with the wrong ping.
    let frozen = 1_000;
    const sent: number[] = [];
    const sync = new ClockSync({ send: (t0) => sent.push(t0), now: () => frozen });
    sync.beginRound(8);
    expect(new Set(sent).size).toBe(8);
    frozen += 1;
  });

  it('locks on a short round when some pongs are lost', () => {
    // A client with no offset cannot play at all, so a few drops must delay the
    // lock rather than prevent it.
    const l = link({ trueOffset: 500_000, upMs: 5, downMs: 5 });
    l.sync.beginRound(16);
    l.deliver(5);
    expect(l.sync.locked).toBe(false);

    const estimate = l.sync.flush();
    expect(estimate?.survivors).toBeGreaterThan(0);
    expect(l.sync.locked).toBe(true);
    expect(l.sync.offsetMs).toBe(500_000);
  });

  it('flushes nothing when no sample has arrived', () => {
    const l = link({ trueOffset: 0, upMs: 5, downMs: 5 });
    l.sync.beginRound(16);
    expect(l.sync.flush()).toBeNull();
    expect(l.sync.locked).toBe(false);
  });

  it('smooths a later round rather than stepping to it', () => {
    // A step would reschedule the whole room at once. The running estimate is
    // smoothed and never step-corrected (D9).
    const l = link({ trueOffset: 500_000, upMs: 5, downMs: 5 });
    l.sync.beginRound(16);
    l.deliver();
    expect(l.sync.offsetMs).toBe(500_000);

    l.setOffset(500_100);
    l.sync.beginRound(8);
    l.deliver();
    expect(l.sync.offsetMs).toBeGreaterThan(500_000);
    expect(l.sync.offsetMs).toBeLessThan(500_050);
  });

  it('converges on a sustained shift without ever jumping', () => {
    const l = link({ trueOffset: 500_000, upMs: 5, downMs: 5 });
    l.sync.beginRound(16);
    l.deliver();

    l.setOffset(500_100);
    let previous = l.sync.offsetMs;
    let biggestJump = 0;
    for (let i = 0; i < 60; i++) {
      l.sync.beginRound(8);
      l.deliver();
      biggestJump = Math.max(biggestJump, Math.abs(l.sync.offsetMs - previous));
      previous = l.sync.offsetMs;
    }
    expect(l.sync.offsetMs).toBeCloseTo(500_100, 1);
    expect(biggestJump).toBeLessThan(20);
  });

  it('reports how many samples are still outstanding', () => {
    const l = link({ trueOffset: 0, upMs: 5, downMs: 5 });
    l.sync.beginRound(4);
    expect(l.sync.inflightCount).toBe(4);
    l.deliver();
    expect(l.sync.inflightCount).toBe(0);
  });
});
