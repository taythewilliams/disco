/**
 * Fleet control for the virtual clients.
 *
 * Two things it measures that matter more than the rest:
 *
 * - **Clock offset spread.** Per v4 Part 0, a uniform delay is invisible and
 *   only the spread between guests is audible. The spread of the clients'
 *   estimated server time is the sync error this architecture actually controls,
 *   and it is measurable here without a single phone.
 * - **Time to ready under a rush.** Thirty simultaneous arrivals is the
 *   bandwidth question (D4). The stagger models the door.
 */

import { VirtualClient, type ClientEvent, type ClientStats } from './client.js';

export interface HarnessOptions {
  baseUrl: string;
  eventCode: string;
  clients: number;
  channelId: string;
  /** Gap between arrivals. Zero models everyone scanning the QR at once. */
  arrivalStaggerMs: number;
  durationMs: number;
  onEvent?(event: ClientEvent): void;
}

export interface HarnessReport {
  clients: ClientStats[];
  locked: number;
  /** Spread of estimated server time across clients — the number that matters. */
  offsetSpreadMs: number | null;
  offsetStdDevMs: number | null;
  rtt: { min: number; median: number; p95: number; max: number } | null;
  timeToReady: { min: number; median: number; p95: number; max: number } | null;
  totalBytes: number;
  totalRequests: number;
  failedRequests: number;
  peakConcurrentRequests: number;
  /** Aggregate megabits per second across the run. */
  aggregateMbps: number;
  errorCounts: Record<string, number>;
}

async function openSession(baseUrl: string, code: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error(`session ${response.status}`);
  const setCookie = response.headers.getSetCookie()[0];
  if (!setCookie) throw new Error('no session cookie');
  return setCookie.split(';')[0] as string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runHarness(options: HarnessOptions): Promise<HarnessReport> {
  const clients: VirtualClient[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < options.clients; i++) {
    // One session each, exactly as thirty phones would: the server sees thirty
    // distinct client IDs and thirty rate-limit buckets, not one shared one.
    const cookie = await openSession(options.baseUrl, options.eventCode);
    const client = new VirtualClient({
      baseUrl: options.baseUrl,
      cookie,
      channelId: options.channelId,
      label: `client-${String(i).padStart(2, '0')}`,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
    clients.push(client);
    client.start();
    if (options.arrivalStaggerMs > 0) await sleep(options.arrivalStaggerMs);
  }

  await sleep(options.durationMs);

  const stats = clients.map((c) => c.stats());
  for (const client of clients) client.stop();

  return report(stats, Date.now() - startedAt);
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loV = sorted[lo] as number;
  return lo === hi ? loV : loV + ((sorted[hi] as number) - loV) * (pos - lo);
}

const summarise = (values: number[]) =>
  values.length === 0
    ? null
    : {
        min: Math.min(...values),
        median: quantile(values, 0.5),
        p95: quantile(values, 0.95),
        max: Math.max(...values),
      };

export function report(stats: ClientStats[], elapsedMs: number): HarnessReport {
  const offsets = stats.map((s) => s.offsetMs).filter((o): o is number => o !== null);
  const rtts = stats.filter((s) => s.clockLocked).map((s) => s.rttMs);
  const readies = stats.map((s) => s.timeToReadyMs).filter((t): t is number => t !== null);

  const mean = offsets.length > 0 ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
  const variance =
    offsets.length > 1
      ? offsets.reduce((acc, o) => acc + (o - mean) ** 2, 0) / (offsets.length - 1)
      : 0;

  const errorCounts: Record<string, number> = {};
  for (const s of stats) {
    for (const code of s.errors) errorCounts[code] = (errorCounts[code] ?? 0) + 1;
  }

  const totalBytes = stats.reduce((acc, s) => acc + s.bytesFetched, 0);

  return {
    clients: stats,
    locked: stats.filter((s) => s.clockLocked).length,
    // Spread, not mean: a uniform offset is inaudible, and only the difference
    // between guests is not (v4 Part 0).
    offsetSpreadMs: offsets.length > 1 ? Math.max(...offsets) - Math.min(...offsets) : null,
    offsetStdDevMs: offsets.length > 1 ? Math.sqrt(variance) : null,
    rtt: summarise(rtts),
    timeToReady: summarise(readies),
    totalBytes,
    totalRequests: stats.reduce((acc, s) => acc + s.requests, 0),
    failedRequests: stats.reduce((acc, s) => acc + s.failedRequests, 0),
    peakConcurrentRequests: stats.reduce((acc, s) => acc + s.peakConcurrentRequests, 0),
    aggregateMbps: elapsedMs > 0 ? (totalBytes * 8) / (elapsedMs / 1000) / 1e6 : 0,
    errorCounts,
  };
}

/** A human-readable summary, for the load-test write-up in `docs/`. */
export function formatReport(report: HarnessReport): string {
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)} ms`);
  const band = (b: { min: number; median: number; p95: number; max: number } | null) =>
    b === null ? '—' : `min ${b.min.toFixed(1)} · median ${b.median.toFixed(1)} · p95 ${b.p95.toFixed(1)} · max ${b.max.toFixed(1)}`;

  return [
    `clients             ${report.clients.length} (${report.locked} clock-locked)`,
    `offset spread       ${ms(report.offsetSpreadMs)}   <- the number that matters`,
    `offset std dev      ${ms(report.offsetStdDevMs)}`,
    `rtt (ms)            ${band(report.rtt)}`,
    `time to ready (ms)  ${band(report.timeToReady)}`,
    `downloaded          ${(report.totalBytes / 1e6).toFixed(1)} MB over ${report.totalRequests} requests`,
    `aggregate           ${report.aggregateMbps.toFixed(1)} Mbps`,
    `failed requests     ${report.failedRequests}`,
    `errors              ${Object.keys(report.errorCounts).length === 0 ? 'none' : JSON.stringify(report.errorCounts)}`,
  ].join('\n');
}
