/**
 * The per-channel timeline (D3).
 *
 * One of these per channel, each holding its own queue, transport state and
 * `startAtServerTime`. Everything a client needs is derivable from the `state`
 * message this produces — position is `serverNow - startAtServerTime` and
 * nothing else, so late joins, reconnects and reloads are the same code path
 * (v4 Part 2).
 *
 * No I/O and no timers of its own: the caller supplies `now` and calls `tick`.
 * That is what makes a five-track set testable in a millisecond.
 */

import { positionAtServerTime, startTimeForSeek, type StateMsg } from '@disco/shared';

export interface ChannelDeps {
  /** Encoded length of a track, or undefined if it is not in the manifest. */
  durationOf(trackId: string): number | undefined;
}

export interface ChannelSnapshot {
  trackId: string | null;
  startAtServerTime: number;
  paused: boolean;
  pausedAtPosition: number | null;
  queue: string[];
}

export class Channel {
  #current: string | null = null;
  #queue: string[] = [];
  #startAtServerTime = 0;
  #paused = false;
  #pausedAtPosition: number | null = null;
  /** When each track was published, for the minimum lead time check (D5). */
  readonly #publishedAt = new Map<string, number>();

  constructor(
    readonly id: string,
    private readonly deps: ChannelDeps,
  ) {}

  snapshot(): ChannelSnapshot {
    return {
      trackId: this.#current,
      startAtServerTime: this.#startAtServerTime,
      paused: this.#paused,
      pausedAtPosition: this.#pausedAtPosition,
      queue: [...this.#queue],
    };
  }

  toStateMessage(): StateMsg {
    return { t: 'state', channelId: this.id, ...this.snapshot() };
  }

  get currentTrackId(): string | null {
    return this.#current;
  }

  /** Tracks a client should be prefetching: what is playing, then the horizon. */
  horizon(depth: number): string[] {
    const ahead = this.#queue.slice(0, Math.max(0, depth));
    return this.#current ? [this.#current, ...ahead] : ahead;
  }

  positionMs(now: number): number {
    return positionAtServerTime(
      {
        startAtServerTime: this.#startAtServerTime,
        paused: this.#paused,
        pausedAtPosition: this.#pausedAtPosition,
      },
      now,
    );
  }

  /** Earliest a track may start, so the room has had time to fetch it (D5). */
  readyAt(trackId: string, minLeadTimeMs: number): number {
    return (this.#publishedAt.get(trackId) ?? 0) + minLeadTimeMs;
  }

  /**
   * When a track was published to the room, or null if it never was.
   *
   * The dashboard shows the remaining lead time from this, so the DJ can see
   * that a track is two minutes from being startable rather than discovering it
   * by pressing play and being refused (D5).
   */
  publishedAt(trackId: string): number | null {
    return this.#publishedAt.get(trackId) ?? null;
  }

  /**
   * Replace the upcoming queue. The playing track is deliberately untouched —
   * re-ordering what comes next must never interrupt what is playing.
   */
  setQueue(trackIds: readonly string[], now: number): void {
    for (const id of trackIds) {
      // Publication time survives re-ordering: a track that has been visible to
      // the room for four minutes does not become unready by moving up.
      if (!this.#publishedAt.has(id)) this.#publishedAt.set(id, now);
    }
    this.#queue = [...trackIds];
  }

  /**
   * Start or resume.
   *
   * `trackId` jumps straight to a track, taking it out of the queue if it is
   * there. With no argument this resumes a pause, or starts the queue if
   * nothing is playing.
   */
  play(now: number, trackId?: string, fromPositionMs = 0, atServerTime?: number): boolean {
    const startAt = atServerTime ?? now;

    if (trackId) {
      this.#queue = this.#queue.filter((id) => id !== trackId);
      this.#current = trackId;
      if (!this.#publishedAt.has(trackId)) this.#publishedAt.set(trackId, now);
      this.#startAtServerTime = startTimeForSeek(fromPositionMs, startAt);
      this.#paused = false;
      this.#pausedAtPosition = null;
      return true;
    }

    if (this.#paused && this.#current) {
      this.#startAtServerTime = startTimeForSeek(this.#pausedAtPosition ?? 0, startAt);
      this.#paused = false;
      this.#pausedAtPosition = null;
      return true;
    }

    if (!this.#current) return this.#advance(startAt);
    return false;
  }

  pause(now: number): boolean {
    if (!this.#current || this.#paused) return false;
    // Freeze at the position reached, not at zero: an unpause has to resume
    // where the room was, or thirty people restart the track.
    this.#pausedAtPosition = Math.max(0, this.positionMs(now));
    this.#paused = true;
    return true;
  }

  skip(now: number): boolean {
    if (!this.#current && this.#queue.length === 0) return false;
    return this.#advance(now);
  }

  seek(positionMs: number, now: number): boolean {
    if (!this.#current) return false;
    if (this.#paused) {
      this.#pausedAtPosition = Math.max(0, positionMs);
    } else {
      this.#startAtServerTime = startTimeForSeek(Math.max(0, positionMs), now);
    }
    return true;
  }

  /**
   * Advance past any track that has finished.
   *
   * The next track starts at exactly the previous one's end, not at `now`: the
   * tick that notices is always a little late, and pinning the boundary to the
   * previous track's end keeps transitions gapless and the schedule identical
   * for every client (D6). A loop, because a tick delayed past a short track
   * has to catch up rather than fall a track behind.
   */
  tick(now: number): boolean {
    if (this.#paused || !this.#current) return false;

    let changed = false;
    for (let guard = 0; guard < 64; guard++) {
      const duration = this.deps.durationOf(this.#current);
      // An unknown duration means the manifest and the queue disagree. Holding
      // position is the safe response: the room keeps playing what it has.
      if (duration === undefined) break;

      const endsAt = this.#startAtServerTime + duration;
      if (now < endsAt) break;
      changed = this.#advance(endsAt) || changed;
      if (!this.#current) break;
    }
    return changed;
  }

  /** Move to the head of the queue, or stop if there is nothing left. */
  #advance(startAt: number): boolean {
    const next = this.#queue.shift() ?? null;
    this.#current = next;
    this.#startAtServerTime = next ? startAt : 0;
    this.#paused = false;
    this.#pausedAtPosition = null;
    return true;
  }
}
