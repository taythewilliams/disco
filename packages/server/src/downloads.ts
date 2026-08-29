/**
 * Segment download admission control (D4).
 *
 * The venue's constraint is airtime, not disk. Thirty phones arriving at once
 * ask for roughly 150 Mbps between them, which is the upper end of what a good
 * 5 GHz access point delivers in practice — so the server admits a bounded
 * number of segment transfers at a time and makes the rest wait.
 *
 * The ordering is the point. **A rush at the door must never starve the dance
 * floor**: a client that is already listening is one whose next segment is a
 * gap in the music, while a client still in the arrival flow is watching a
 * progress indicator that says it is buffering. Listeners go first, always.
 *
 * Two properties this is careful about:
 *
 * - **Nobody waits forever.** A joiner that has been queued past `maxWaitMs` is
 *   admitted over capacity rather than held behind an endless stream of
 *   listeners. Overshooting the cap briefly is a smaller failure than a guest
 *   at the door whose phone never finishes buffering.
 * - **Capacity is read live.** It comes from the runtime config, so the DJ can
 *   widen or narrow it mid-event from the dashboard (D11) without a restart.
 */

export type DownloadPriority = 'listener' | 'joiner';

interface Waiter {
  priority: DownloadPriority;
  admit: () => void;
  timer: NodeJS.Timeout | null;
}

export interface DownloadGateDeps {
  /** Read live, so a config change takes effect on the next release. */
  capacity: () => number;
  /** Longest a waiter is held before being admitted over capacity. */
  maxWaitMs?: number;
  /**
   * Most transfers that may be waiting at once, across both queues.
   *
   * A bound rather than an unbounded queue: every waiter holds a live request
   * and a timer, so a client that opens ten thousand segment requests would
   * otherwise turn a bandwidth control into a memory one. Past this the caller
   * is refused and can retry, which a client already does.
   */
  maxQueued?: number;
}

/** Thrown when the queue is full. The caller answers 503, not 500. */
export class DownloadQueueFull extends Error {
  constructor() {
    super('download queue full');
  }
}

export interface DownloadGateStats {
  inFlight: number;
  queuedListeners: number;
  queuedJoiners: number;
  /**
   * Transfers that had to wait for a slot, cumulative.
   *
   * The number that says whether the cap ever binds. On loopback it stays at
   * zero because a segment completes in about a millisecond; over the air at
   * the venue it is the first place pressure shows up (D4).
   */
  queuedTotal: number;
  /** Waiters admitted past the cap because they had waited too long. */
  admittedOverCapacity: number;
  /** Requests refused because the queue was full. */
  refused: number;
  /** Peak in-flight transfers seen, for the load-test write-up. */
  peakInFlight: number;
}

const DEFAULT_MAX_WAIT_MS = 15_000;
/** Generous next to thirty phones with a handful of transfers each. */
const DEFAULT_MAX_QUEUED = 256;

export class DownloadGate {
  #inFlight = 0;
  #peakInFlight = 0;
  #overCapacity = 0;
  #queuedTotal = 0;
  #refused = 0;
  readonly #listeners: Waiter[] = [];
  readonly #joiners: Waiter[] = [];

  constructor(private readonly deps: DownloadGateDeps) {}

  stats(): DownloadGateStats {
    return {
      inFlight: this.#inFlight,
      queuedListeners: this.#listeners.length,
      queuedJoiners: this.#joiners.length,
      queuedTotal: this.#queuedTotal,
      admittedOverCapacity: this.#overCapacity,
      refused: this.#refused,
      peakInFlight: this.#peakInFlight,
    };
  }

  /**
   * Wait for a slot. Resolves with the release function, which the caller must
   * call exactly once — repeated calls are ignored so a request that both
   * completes and errors cannot hand back two slots.
   */
  acquire(priority: DownloadPriority): Promise<() => void> {
    if (this.#inFlight < Math.max(1, this.deps.capacity())) {
      this.#enter();
      return Promise.resolve(this.#releaser());
    }

    if (this.#listeners.length + this.#joiners.length >= (this.deps.maxQueued ?? DEFAULT_MAX_QUEUED)) {
      this.#refused++;
      return Promise.reject(new DownloadQueueFull());
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        priority,
        admit: () => {
          this.#enter();
          resolve(this.#releaser());
        },
        timer: null,
      };

      // The starvation valve. Without it, a busy dance floor could hold a
      // joiner behind listeners for the length of a track.
      waiter.timer = setTimeout(() => {
        this.#remove(waiter);
        this.#overCapacity++;
        waiter.admit();
      }, this.deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
      waiter.timer.unref?.();

      this.#queuedTotal++;
      (priority === 'listener' ? this.#listeners : this.#joiners).push(waiter);
    });
  }

  #enter(): void {
    this.#inFlight++;
    if (this.#inFlight > this.#peakInFlight) this.#peakInFlight = this.#inFlight;
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight = Math.max(0, this.#inFlight - 1);
      this.#pump();
    };
  }

  /** Admit whoever is next: every waiting listener before any waiting joiner. */
  #pump(): void {
    while (this.#inFlight < Math.max(1, this.deps.capacity())) {
      const next = this.#listeners.shift() ?? this.#joiners.shift();
      if (!next) return;
      if (next.timer) clearTimeout(next.timer);
      next.admit();
    }
  }

  #remove(waiter: Waiter): void {
    for (const queue of [this.#listeners, this.#joiners]) {
      const index = queue.indexOf(waiter);
      if (index !== -1) {
        queue.splice(index, 1);
        return;
      }
    }
  }
}
