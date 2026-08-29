/**
 * Bounded-concurrency task runner.
 *
 * Not `worker_threads`: every expensive step in ingest is an external process,
 * so the JS side is almost entirely idle and a thread per track would buy
 * nothing. What matters is capping how many ffmpeg processes exist at once.
 */

export interface PoolOptions {
  concurrency: number;
  /** Called as each task settles, for the progress line. */
  onSettled?: (index: number, error: unknown | null) => void;
}

/**
 * Run `worker` over every item, at most `concurrency` at a time, in order of
 * start. Results are returned in input order.
 *
 * A failing task never stops the run — thousands of tracks means one
 * unreadable file must not cost the other 1 999 (Part E step 2).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: PoolOptions,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(
    items.length,
  );
  const width = Math.max(1, Math.min(opts.concurrency, items.length));
  let next = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index] as T, index) };
        opts.onSettled?.(index, null);
      } catch (error) {
        results[index] = { ok: false, error };
        opts.onSettled?.(index, error);
      }
    }
  });

  await Promise.all(runners);
  return results;
}
