/**
 * One simulated guest.
 *
 * Real WebSocket, real clock sync, real HTTP segment fetches, real prefetch
 * planning — everything a phone does except turn bytes into sound. It runs the
 * *same* `Connection` and the same `planPrefetch` the guest PWA runs, which is
 * the only reason its numbers mean anything (Part E step 6).
 *
 * Build this in Phase 1, not when it is urgent: it is how you exercise
 * thirty-client behaviour, bandwidth shape and download prioritisation long
 * before thirty phones exist.
 */

import { WebSocket } from 'ws';
import {
  Connection,
  planPrefetch,
  readinessOf,
  segmentKey,
  type ServerMessage,
  type SocketLike,
  type StateMsg,
  type TrackMetaMsg,
  type TrackPlan,
} from '@disco/shared';

export interface VirtualClientOptions {
  baseUrl: string;
  /** `disco_session=…`, from a prior `/api/session` exchange. */
  cookie: string;
  channelId: string;
  label: string;
  /** Buffer target, matching the guest's. */
  bufferAheadMs?: number;
  onEvent?(event: ClientEvent): void;
}

export type ClientEvent =
  | { kind: 'ready'; label: string; atMs: number }
  | { kind: 'error'; label: string; code: string }
  | { kind: 'fetch-failed'; label: string; url: string };

export interface ClientStats {
  label: string;
  connected: boolean;
  clockLocked: boolean;
  offsetMs: number | null;
  rttMs: number;
  /** Wall-clock ms from start to holding the segment under the playhead. */
  timeToReadyMs: number | null;
  segmentsFetched: number;
  bytesFetched: number;
  requests: number;
  failedRequests: number;
  errors: string[];
  /** Highest number of segment requests this client had open at once. */
  peakConcurrentRequests: number;
}

/** Adapt a Node `ws` socket to the transport-agnostic interface `Connection` wants. */
function nodeSocket(url: string, cookie: string): SocketLike {
  const socket = new WebSocket(url, { headers: { cookie } });
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => socket.close(),
    onOpen: (h) => socket.on('open', h),
    onMessage: (h) => socket.on('message', (data: Buffer) => h(data.toString('utf8'))),
    onClose: (h) => socket.on('close', (code: number) => h(code)),
    onError: (h) => socket.on('error', () => h()),
  };
}

const DEFAULT_BUFFER_AHEAD_MS = 90_000;

export class VirtualClient {
  readonly connection: Connection;

  #state: StateMsg | null = null;
  readonly #meta = new Map<string, TrackMetaMsg>();
  readonly #have = new Set<string>();
  readonly #inflight = new Set<string>();
  readonly #initFetches = new Map<string, Promise<void>>();

  #startedAt = 0;
  /**
   * When this client first learned of a playable track.
   *
   * Time-to-ready is measured from here, not from `start()`. A client that
   * connects before the DJ queues anything would otherwise report the length of
   * its idle wait as though it were download latency — which is the number the
   * venue load test exists to measure.
   */
  #trackKnownAt: number | null = null;
  #readyAtMs: number | null = null;
  #bytes = 0;
  #requests = 0;
  #failed = 0;
  #peakConcurrent = 0;
  readonly #errors: string[] = [];
  #loop: NodeJS.Timeout | null = null;

  constructor(private readonly options: VirtualClientOptions) {
    const wsUrl = `${options.baseUrl.replace(/^http/, 'ws')}/ws`;
    this.connection = new Connection({
      connect: () => nodeSocket(wsUrl, options.cookie),
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      onMessage: (message) => this.#handle(message),
    });
  }

  start(): void {
    this.#startedAt = Date.now();
    this.connection.open(this.options.channelId);
    // The same cadence the guest runs its scheduling loop at. Prefetch is
    // driven from here rather than from message arrival so that a client keeps
    // buffering through a server outage (D17).
    this.#loop = setInterval(() => void this.#tick(), 250);
  }

  stop(): void {
    if (this.#loop) clearInterval(this.#loop);
    this.#loop = null;
    this.connection.close();
  }

  stats(): ClientStats {
    return {
      label: this.options.label,
      connected: this.connection.status === 'live',
      clockLocked: this.connection.clock.locked,
      offsetMs: this.connection.clock.locked ? this.connection.clock.offsetMs : null,
      rttMs: this.connection.clock.rttMs,
      timeToReadyMs: this.#readyAtMs,
      segmentsFetched: this.#have.size,
      bytesFetched: this.#bytes,
      requests: this.#requests,
      failedRequests: this.#failed,
      errors: [...this.#errors],
      peakConcurrentRequests: this.#peakConcurrent,
    };
  }

  #handle(message: ServerMessage): void {
    switch (message.t) {
      case 'state':
        this.#state = message;
        break;
      case 'trackMeta':
        this.#meta.set(message.trackId, message);
        break;
      case 'error':
        this.#errors.push(message.code);
        this.options.onEvent?.({ kind: 'error', label: this.options.label, code: message.code });
        break;
      default:
        break;
    }
  }

  async #tick(): Promise<void> {
    const state = this.#state;
    if (!state || !this.connection.clock.locked) return;

    // Telemetry, so a harness run populates the dashboard's client panel and
    // its readiness bars exactly as thirty phones would (D5, D11). Readiness is
    // also what the server's download admission control reads, so reporting it
    // honestly is what makes a load test measure the real ordering (D4).
    this.connection.send({
      t: 'telemetry',
      offsetMs: this.connection.clock.offsetMs,
      rttMs: this.connection.clock.rttMs,
      driftMs: 0,
      calibrationMs: 0,
      engine: 'webaudio',
      bufferSec: this.#bufferedSeconds(),
      playing: this.#readyAtMs !== null,
      // Only the horizon: a hundred-track queue is not a hundred readiness
      // reports four times a second, and the dashboard shows the horizon.
      ready: this.#plans()
        .slice(0, this.connection.config.prefetchHorizonTracks + 1)
        .map((plan) => ({ trackId: plan.trackId, state: readinessOf(plan, this.#have) })),
    });

    const plans = this.#plans();
    const currentIndex = state.trackId ? plans.findIndex((p) => p.trackId === state.trackId) : -1;
    const positionMs = state.trackId
      ? this.connection.serverNow() - state.startAtServerTime
      : 0;

    this.#noteReady(state, positionMs);

    const requests = planPrefetch({
      plans,
      currentIndex,
      positionMs,
      bufferAheadMs: this.options.bufferAheadMs ?? DEFAULT_BUFFER_AHEAD_MS,
      horizonTracks: this.connection.config.prefetchHorizonTracks,
      have: this.#have,
    });

    const batch = requests
      .filter((r) => !this.#inflight.has(segmentKey(r.trackId, r.segmentIndex)))
      .slice(0, this.connection.config.maxConcurrentSegmentDownloads);

    await Promise.all(batch.map((r) => this.#fetchSegment(r.trackId, r.segmentIndex)));
  }

  /** First moment this client holds the segment under the playhead. */
  #noteReady(state: StateMsg, positionMs: number): void {
    if (this.#readyAtMs !== null || !state.trackId) return;
    const meta = this.#meta.get(state.trackId);
    if (!meta) return;

    this.#trackKnownAt ??= Date.now();

    let elapsed = 0;
    let needed = 0;
    for (const segment of meta.segments) {
      elapsed += segment.durationMs;
      if (Math.max(0, positionMs) < elapsed) break;
      needed++;
    }
    if (this.#have.has(segmentKey(state.trackId, Math.min(needed, meta.segments.length - 1)))) {
      this.#readyAtMs = Date.now() - (this.#trackKnownAt ?? this.#startedAt);
      this.options.onEvent?.({
        kind: 'ready',
        label: this.options.label,
        atMs: this.#readyAtMs,
      });
    }
  }

  async #fetchSegment(trackId: string, index: number): Promise<void> {
    const meta = this.#meta.get(trackId);
    const segment = meta?.segments[index];
    if (!meta || !segment) return;

    const key = segmentKey(trackId, index);
    this.#inflight.add(key);
    this.#peakConcurrent = Math.max(this.#peakConcurrent, this.#inflight.size);

    try {
      // The init segment counts too: a fragment is not decodable without it, so
      // leaving it out of the bandwidth figure would understate the real load.
      // Deduped on a promise rather than on a flag — a batch of concurrent
      // segment fetches for one track would otherwise all race past a plain
      // `has` check and fetch the init nine times, inflating the very bandwidth
      // number this exists to measure.
      await this.#fetchInitOnce(trackId, meta.initUrl);
      await this.#get(`${this.options.baseUrl}${segment.url}`);
      this.#have.add(key);
    } catch {
      this.#failed++;
      this.options.onEvent?.({ kind: 'fetch-failed', label: this.options.label, url: segment.url });
    } finally {
      this.#inflight.delete(key);
    }
  }

  #fetchInitOnce(trackId: string, initUrl: string): Promise<void> {
    if (this.#have.has(`init:${trackId}`)) return Promise.resolve();
    const existing = this.#initFetches.get(trackId);
    if (existing) return existing;

    const promise = this.#get(`${this.options.baseUrl}${initUrl}`)
      .then(() => {
        this.#have.add(`init:${trackId}`);
      })
      .finally(() => this.#initFetches.delete(trackId));
    this.#initFetches.set(trackId, promise);
    return promise;
  }

  async #get(url: string): Promise<void> {
    this.#requests++;
    const response = await fetch(url, { headers: { cookie: this.options.cookie } });
    if (!response.ok) throw new Error(String(response.status));
    // Read the body rather than discarding it: an unread body is not a
    // transferred body, and the point of this is to move real bytes.
    this.#bytes += (await response.arrayBuffer()).byteLength;
  }

  #bufferedSeconds(): number {
    let ms = 0;
    for (const key of this.#have) {
      if (key.startsWith('init:')) continue;
      const [trackId, index] = key.split(':') as [string, string];
      ms += this.#meta.get(trackId)?.segments[Number(index)]?.durationMs ?? 0;
    }
    return ms / 1000;
  }

  #plans(): TrackPlan[] {
    const state = this.#state;
    if (!state) return [];
    const ids = state.trackId ? [state.trackId, ...state.queue] : [...state.queue];
    return ids
      .map((trackId) => this.#meta.get(trackId))
      .filter((m): m is TrackMetaMsg => m !== undefined)
      .map((m) => ({ trackId: m.trackId, segmentDurationsMs: m.segments.map((s) => s.durationMs) }));
  }
}
