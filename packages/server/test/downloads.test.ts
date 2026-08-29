import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadGate, DownloadQueueFull } from '../src/downloads.js';

/** Resolve pending microtasks so an admitted waiter has actually run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let capacity = 2;
let gate: DownloadGate;

beforeEach(() => {
  capacity = 2;
  gate = new DownloadGate({ capacity: () => capacity, maxWaitMs: 10_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DownloadGate', () => {
  it('admits up to capacity without waiting', async () => {
    const a = await gate.acquire('joiner');
    const b = await gate.acquire('joiner');
    expect(gate.stats().inFlight).toBe(2);
    a();
    b();
    expect(gate.stats().inFlight).toBe(0);
  });

  it('queues past capacity and admits on release', async () => {
    const first = await gate.acquire('listener');
    await gate.acquire('listener');

    let admitted = false;
    void gate.acquire('joiner').then(() => {
      admitted = true;
    });
    await settle();
    expect(admitted).toBe(false);
    expect(gate.stats().queuedJoiners).toBe(1);

    first();
    await settle();
    expect(admitted).toBe(true);
  });

  it('puts every waiting listener ahead of every waiting joiner', async () => {
    // The whole point: a rush at the door must not starve the dance floor (D4).
    const held = await gate.acquire('listener');
    await gate.acquire('listener');

    const order: string[] = [];
    void gate.acquire('joiner').then(() => order.push('joiner-1'));
    void gate.acquire('joiner').then(() => order.push('joiner-2'));
    void gate.acquire('listener').then(() => order.push('listener'));
    await settle();

    held();
    await settle();
    expect(order).toEqual(['listener']);
  });

  it('reads capacity live so the dashboard can widen it mid-event', async () => {
    const a = await gate.acquire('joiner');
    const b = await gate.acquire('joiner');

    let admitted = 0;
    void gate.acquire('joiner').then(() => admitted++);
    void gate.acquire('joiner').then(() => admitted++);
    await settle();
    expect(admitted).toBe(0);

    // The DJ raises the cap from the config panel (D11); one release is then
    // enough to let both waiters through.
    capacity = 4;
    a();
    await settle();
    expect(admitted).toBe(2);
    b();
  });

  it('admits a waiter that has been queued too long rather than starving it', async () => {
    vi.useFakeTimers();
    const patient = new DownloadGate({ capacity: () => 1, maxWaitMs: 5_000 });
    await patient.acquire('listener');

    let admitted = false;
    void patient.acquire('joiner').then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(admitted).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(admitted).toBe(true);
    // Deliberately over the cap: a phone at the door that never finishes
    // buffering is a worse failure than one extra transfer in flight.
    expect(patient.stats().inFlight).toBe(2);
    expect(patient.stats().admittedOverCapacity).toBe(1);
  });

  it('ignores a repeated release so one request cannot free two slots', async () => {
    const release = await gate.acquire('listener');
    release();
    release();
    expect(gate.stats().inFlight).toBe(0);

    // And the freed slot is still exactly one slot.
    await gate.acquire('joiner');
    await gate.acquire('joiner');
    expect(gate.stats().inFlight).toBe(2);
  });

  it('counts how often the cap actually bound', async () => {
    // Zero here on loopback and non-zero at the venue is the whole point: it
    // says whether the cap is doing anything (D4).
    const a = await gate.acquire('joiner');
    await gate.acquire('joiner');
    expect(gate.stats().queuedTotal).toBe(0);
    void gate.acquire('listener');
    await settle();
    expect(gate.stats().queuedTotal).toBe(1);
    a();
  });

  it('reports the peak for the load-test write-up', async () => {
    const a = await gate.acquire('joiner');
    await gate.acquire('joiner');
    a();
    expect(gate.stats().peakInFlight).toBe(2);
    expect(gate.stats().inFlight).toBe(1);
  });

  it('refuses rather than queueing without bound', async () => {
    // Every waiter holds a live request and a timer. Without a bound, a client
    // opening ten thousand segment requests turns a bandwidth control into a
    // memory one.
    const small = new DownloadGate({ capacity: () => 1, maxWaitMs: 60_000, maxQueued: 2 });
    await small.acquire('listener');
    void small.acquire('joiner');
    void small.acquire('joiner');
    await settle();
    await expect(small.acquire('joiner')).rejects.toBeInstanceOf(DownloadQueueFull);
    expect(small.stats().refused).toBe(1);
  });

  it('never wedges on a capacity of zero', async () => {
    // A config value of zero would otherwise mean "serve nobody", which is a
    // silent, total outage from one mistyped number.
    const zero = new DownloadGate({ capacity: () => 0 });
    await expect(zero.acquire('joiner')).resolves.toBeTypeOf('function');
  });
});
