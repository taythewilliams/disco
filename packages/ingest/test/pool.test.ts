import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/pool.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('mapPool', () => {
  it('returns results in input order regardless of completion order', async () => {
    const results = await mapPool(
      [30, 10, 20, 0],
      async (delay, i) => {
        await tick(delay);
        return i;
      },
      { concurrency: 4 },
    );
    expect(results).toEqual([0, 1, 2, 3].map((value) => ({ ok: true, value })));
  });

  it('never exceeds the concurrency cap', async () => {
    // The cap is the whole point: it is what stops sixteen ffmpeg processes
    // from starting at once on an eight-core machine.
    let running = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 50 }, (_, i) => i),
      async () => {
        peak = Math.max(peak, ++running);
        await tick(1);
        running--;
      },
      { concurrency: 4 },
    );
    expect(peak).toBe(4);
  });

  it('keeps going after a failure', async () => {
    // One unreadable file out of two thousand must not cost the other 1 999.
    const results = await mapPool(
      [1, 2, 3, 4],
      async (n) => {
        if (n === 2) throw new Error('bad file');
        return n * 10;
      },
      { concurrency: 2 },
    );
    expect(results.map((r) => (r.ok ? r.value : 'failed'))).toEqual([10, 'failed', 30, 40]);
    const failure = results[1];
    expect(failure?.ok).toBe(false);
    if (failure && !failure.ok) expect((failure.error as Error).message).toBe('bad file');
  });

  it('reports every settlement exactly once, with its error', async () => {
    const seen: Array<[number, boolean]> = [];
    await mapPool(
      [1, 2, 3],
      async (n) => {
        if (n === 3) throw new Error('nope');
        return n;
      },
      { concurrency: 1, onSettled: (i, err) => seen.push([i, err !== null]) },
    );
    expect(seen).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);
  });

  it('handles an empty list without hanging', async () => {
    expect(await mapPool([], async () => 1, { concurrency: 8 })).toEqual([]);
  });

  it('does not spawn more runners than there are items', async () => {
    let peak = 0;
    let running = 0;
    await mapPool(
      [1, 2],
      async () => {
        peak = Math.max(peak, ++running);
        await tick(1);
        running--;
      },
      { concurrency: 32 },
    );
    expect(peak).toBe(2);
  });
});
