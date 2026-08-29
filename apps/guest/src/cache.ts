/**
 * Segment download and decode cache.
 *
 * The one thing to understand here: **a fragment is not independently
 * decodable.** `init.mp4` carries the moov box; a `.m4s` carries only moof and
 * mdat. Decoding one means concatenating the init segment in front of it — a
 * fact verified against ffmpeg during ingest, where the fragment alone fails
 * with "no tfhd was found" and init+fragment yields exactly 25.008 s of audio.
 *
 * Encoded bytes are cheap to keep (a 25 s AAC fragment is ~600 kB) and are held
 * for the whole horizon. Decoded buffers are not — Float32, ~35 MB per
 * segment — so only the resident window survives (D2).
 */

import { segmentKey } from '@disco/shared';
import type { DecodedSegment } from './engine/types.js';

export interface CacheDeps {
  /** Injected so tests need no network and the harness can count requests. */
  fetchBytes(url: string): Promise<ArrayBuffer>;
  /** Injected so tests need no AudioContext. */
  decode(bytes: ArrayBuffer): Promise<AudioBuffer>;
  /**
   * Raised when the device runs out of room for audio.
   *
   * Swallowed, this presents as a phone that stalls for no visible reason. The
   * guest cannot fix a bug but can absolutely delete some photos, so it is
   * worth telling them (Part F, failure UX).
   */
  onStorageFull?(): void;
}

export interface SegmentLocation {
  trackId: string;
  index: number;
  url: string;
  startMs: number;
  durationMs: number;
}

export class SegmentCache {
  /** Encoded fragments, keyed `trackId:index`. */
  readonly #encoded = new Map<string, ArrayBuffer>();
  /** Init segments, keyed by track. One per track, kept while the track is in the horizon. */
  readonly #init = new Map<string, ArrayBuffer>();
  /** Decoded audio, bounded by the resident window. */
  readonly #decoded = new Map<string, DecodedSegment>();
  /** In-flight downloads, so a re-plan does not fetch the same bytes twice. */
  readonly #inflight = new Map<string, Promise<void>>();

  constructor(private readonly deps: CacheDeps) {}

  get encodedKeys(): ReadonlySet<string> {
    return new Set(this.#encoded.keys());
  }

  get decodedCount(): number {
    return this.#decoded.size;
  }

  has(trackId: string, index: number): boolean {
    return this.#encoded.has(segmentKey(trackId, index));
  }

  hasInit(trackId: string): boolean {
    return this.#init.has(trackId);
  }

  /** For `MediaElementEngine`, which appends encoded bytes directly. */
  init(trackId: string): ArrayBuffer | null {
    return this.#init.get(trackId) ?? null;
  }

  fragment(trackId: string, index: number): ArrayBuffer | null {
    return this.#encoded.get(segmentKey(trackId, index)) ?? null;
  }

  /** For `WebAudioEngine`, which needs decoded buffers. */
  get(trackId: string, index: number): DecodedSegment | null {
    return this.#decoded.get(segmentKey(trackId, index)) ?? null;
  }

  async fetchInit(trackId: string, url: string): Promise<void> {
    if (this.#init.has(trackId)) return;
    const key = `init:${trackId}`;
    await this.#once(key, async () => {
      this.#init.set(trackId, await this.deps.fetchBytes(url));
    });
  }

  async fetchSegment(location: SegmentLocation): Promise<void> {
    const key = segmentKey(location.trackId, location.index);
    if (this.#encoded.has(key)) return;
    await this.#once(key, async () => {
      this.#encoded.set(key, await this.deps.fetchBytes(location.url));
    });
  }

  /**
   * Decode a downloaded fragment into the resident set.
   *
   * Returns false rather than throwing when the bytes are not there yet: a
   * decode racing a download is normal, not exceptional.
   */
  async decodeSegment(location: SegmentLocation): Promise<boolean> {
    const key = segmentKey(location.trackId, location.index);
    if (this.#decoded.has(key)) return true;

    const init = this.#init.get(location.trackId);
    const fragment = this.#encoded.get(key);
    if (!init || !fragment) return false;

    const joined = new Uint8Array(init.byteLength + fragment.byteLength);
    joined.set(new Uint8Array(init), 0);
    joined.set(new Uint8Array(fragment), init.byteLength);

    const buffer = await this.deps.decode(joined.buffer);
    this.#decoded.set(key, {
      trackId: location.trackId,
      index: location.index,
      startMs: location.startMs,
      durationMs: location.durationMs,
      buffer,
    });
    return true;
  }

  /**
   * Drop every decoded buffer outside the window.
   *
   * Called on every scheduling pass. Skipping it for a few tracks is enough to
   * be killed by the OS on a phone.
   */
  evictDecoded(keep: ReadonlySet<string>): number {
    let dropped = 0;
    for (const key of [...this.#decoded.keys()]) {
      if (!keep.has(key)) {
        this.#decoded.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  /** Drop encoded bytes for tracks that have left the horizon entirely. */
  evictEncoded(keepTracks: ReadonlySet<string>): number {
    let dropped = 0;
    for (const key of [...this.#encoded.keys()]) {
      const trackId = key.slice(0, key.lastIndexOf(':'));
      if (!keepTracks.has(trackId)) {
        this.#encoded.delete(key);
        dropped++;
      }
    }
    for (const trackId of [...this.#init.keys()]) {
      if (!keepTracks.has(trackId)) this.#init.delete(trackId);
    }
    return dropped;
  }

  /** Collapse duplicate work onto one promise per key. */
  async #once(key: string, work: () => Promise<void>): Promise<void> {
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const promise = work()
      .catch((error: unknown) => {
        if (isQuotaError(error)) this.deps.onStorageFull?.();
        throw error;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }
}

/** Browsers disagree on the name but agree on the code. */
function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    (error as { code?: number }).code === 22
  );
}
