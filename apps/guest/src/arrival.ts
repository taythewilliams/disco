/**
 * The arrival flow (D4).
 *
 * The buffering window is not dead time — it *is* the onboarding. Calibration
 * takes 20–30 seconds anyway, so the two overlap and the guest is never in
 * silence: the loop is synthesised locally and starts the moment they arrive,
 * while segments download behind it.
 *
 *   0s   Scan QR → shell loads
 *   2s   Install prompt
 *   5s   Calibration begins, loop playing
 *        ↓ (segments downloading in the background)
 *  30s   Calibration done → join the live stream at the correct position
 *
 * Modelled as a pure function of observable facts rather than a machine with
 * transitions, because the interesting cases are all *combinations* — calibrated
 * but not buffered, buffered but the channel is idle, playing but the server
 * went away — and a transition table hides those.
 */

export type ArrivalPhase =
  | 'loading'
  | 'joining'
  | 'join-failed'
  | 'calibrating'
  | 'waiting-for-dj'
  | 'catching-up'
  | 'playing'
  | 'paused'
  | 'offline';

export interface ArrivalInputs {
  /** Session exchanged and socket live. */
  joined: boolean;
  /** The event code was refused. */
  joinFailed: boolean;
  /** The guest has finished (or skipped) the slider step. */
  calibrated: boolean;
  /** A `state` message has arrived. */
  haveState: boolean;
  /** The channel has a track and is not paused. */
  channelPlaying: boolean;
  /** The channel is paused by the DJ. */
  channelPaused: boolean;
  /** Enough audio is decoded to start at the room's playhead. */
  audioReady: boolean;
  /** The socket has dropped and is retrying. */
  connectionLost: boolean;
}

/**
 * What the guest should be looking at.
 *
 * Order matters. `connectionLost` is checked *after* playback state on purpose:
 * a client with buffered audio keeps playing through a server outage (D17), so
 * "playing" is the honest answer even while the socket is down — with a subtle
 * reconnecting indicator alongside, not instead.
 */
export function arrivalPhase(inputs: ArrivalInputs): ArrivalPhase {
  if (inputs.joinFailed) return 'join-failed';
  if (!inputs.joined && !inputs.haveState) {
    // Not yet connected and nothing cached: still opening the door.
    return inputs.connectionLost ? 'offline' : 'joining';
  }

  // Calibration comes before everything that follows, because joining the
  // stream uncalibrated is joining it at the wrong time (D1).
  if (!inputs.calibrated) return 'calibrating';

  if (!inputs.haveState) return inputs.connectionLost ? 'offline' : 'loading';
  if (inputs.channelPaused) return 'paused';
  if (!inputs.channelPlaying) return 'waiting-for-dj';

  // Playing wins over a dropped socket: the schedule is already known and the
  // audio is already buffered (D17).
  if (inputs.audioReady) return 'playing';
  if (inputs.connectionLost) return 'offline';

  // Mid-track join with segments still arriving. Never silence, never a silent
  // failure — a visible "catching up" (D5).
  return 'catching-up';
}

/** Whether to show the reconnecting indicator alongside whatever else is on screen. */
export function showsReconnecting(phase: ArrivalPhase, connectionLost: boolean): boolean {
  return connectionLost && phase !== 'joining' && phase !== 'join-failed';
}

// ─── Catch-up estimate ──────────────────────────────────────────────────────

/**
 * A rolling estimate of download throughput.
 *
 * Exponentially weighted so a single slow segment does not dominate, and so the
 * estimate tracks a room whose access point gets busier as it fills.
 */
export class DownloadRate {
  #bytesPerMs = 0;
  #samples = 0;

  constructor(private readonly alpha = 0.3) {}

  record(bytes: number, elapsedMs: number): void {
    if (elapsedMs <= 0 || bytes <= 0) return;
    const rate = bytes / elapsedMs;
    this.#bytesPerMs = this.#samples === 0 ? rate : this.#bytesPerMs + this.alpha * (rate - this.#bytesPerMs);
    this.#samples++;
  }

  get bytesPerMs(): number | null {
    return this.#samples === 0 ? null : this.#bytesPerMs;
  }

  get samples(): number {
    return this.#samples;
  }
}

/**
 * How long until the guest can join, in seconds.
 *
 * Returns null rather than a guess when there is no rate estimate yet — the UI
 * then says "catching up" without a number, which is honest. A confidently wrong
 * countdown is worse than no countdown, because a guest watches it.
 */
export function estimateCatchUpSec(bytesRemaining: number, rate: DownloadRate): number | null {
  const bytesPerMs = rate.bytesPerMs;
  if (bytesPerMs === null || bytesPerMs <= 0) return null;
  if (bytesRemaining <= 0) return 0;
  return Math.ceil(bytesRemaining / bytesPerMs / 1000);
}

/**
 * The copy for each phase.
 *
 * Server-driven strings win where the config defines one (D11). Wording is the
 * thing most likely to need changing mid-event — a guest reading the wrong
 * explanation for silence takes their headphones off — and a redeploy at 11pm
 * is not an option. Everything else falls back to the built-in copy so a
 * missing key never renders as blank.
 */
export function phaseHeadline(
  phase: ArrivalPhase,
  catchUpSec: number | null,
  strings: Record<string, string> = {},
): string {
  switch (phase) {
    case 'loading':
      return 'Getting ready…';
    case 'joining':
      return 'Joining…';
    case 'join-failed':
      return strings['joinFailed'] ?? 'That code didn’t work.';
    case 'calibrating':
      return 'Let’s tune your headphones';
    case 'waiting-for-dj':
      return 'Waiting for the DJ';
    case 'catching-up': {
      const base = strings['trackNotReady'] ?? 'Catching up';
      return catchUpSec === null ? `${base}…` : `${base} — ${catchUpSec}s`;
    }
    case 'playing':
      return 'Playing';
    case 'paused':
      return 'Paused';
    case 'offline':
      return strings['serverUnreachable'] ?? 'Reconnecting…';
  }
}
