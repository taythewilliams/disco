/**
 * Tunables for the whole system.
 *
 * Two kinds live here. Protocol invariants (segment length, comment cap) are
 * fixed at build time — changing one is a protocol change. Runtime tunables are
 * gathered in `DEFAULT_RUNTIME_CONFIG` and can be overridden mid-event from the
 * dashboard (D11), which is why they are one object rather than loose consts.
 */

/**
 * Bumped whenever the message set changes shape. Sent in `hello`.
 *
 * 2 — Phase 3: telemetry carries readiness and a playing flag, and the DJ gains
 * `track.gain`, `crate.save` and `crate.delete`.
 */
export const PROTOCOL_VERSION = 2;

/** v1 ships a single channel; N>1 is modelled throughout and gated by config (D3). */
export const DEFAULT_CHANNEL_ID = 'main';

// ─── Clock sync (D9) ────────────────────────────────────────────────────────

/** Samples taken back-to-back when a connection first opens. */
export const CLOCK_SYNC_INITIAL_SAMPLES = 16;
/** Samples per periodic re-sync round. */
export const CLOCK_SYNC_RESAMPLE_SAMPLES = 8;
/**
 * Keep only samples at or below this RTT quantile before taking the median
 * offset. Low-RTT samples are the ones that spent least time queued, so they
 * carry the least asymmetric delay — the error term NTP-style estimation
 * cannot see.
 */
export const CLOCK_SYNC_RTT_QUANTILE = 0.25;
/** Never filter below this many survivors, however tight the RTT spread is. */
export const CLOCK_SYNC_MIN_SURVIVORS = 2;
/**
 * Weight applied to each new estimate once locked. Low on purpose: the running
 * estimate is smoothed, never step-corrected, so a single bad round cannot jerk
 * the whole schedule.
 */
export const CLOCK_SYNC_SMOOTHING_ALPHA = 0.15;

// ─── Drift correction (D9) ──────────────────────────────────────────────────

/** Below this, do nothing. Correcting noise costs more than the error. */
export const DRIFT_DEADBAND_MS = 5;
/** Above this, a rate nudge cannot catch up in time — hard reschedule instead. */
export const DRIFT_RESCHEDULE_THRESHOLD_MS = 60;
/** Window a fine correction is spread over. ~20 s keeps the pitch shift inaudible. */
export const DRIFT_CORRECTION_WINDOW_MS = 20_000;
/** ±0.1 % — about one cent of pitch shift, which nobody hears. */
export const DRIFT_MAX_RATE_ADJUSTMENT = 0.001;

// ─── Media (D10) ────────────────────────────────────────────────────────────

/** Nominal segment length. Exact durations come from the ingest manifest. */
export const SEGMENT_TARGET_MS = 25_000;
/** Target integrated loudness; per-track gain is computed against this. */
export const TARGET_LUFS = -14;
/**
 * Decoded audio is Float32 — a five-minute stereo track is ~105 MB — so the
 * client holds a sliding window of segments rather than a whole track (D2).
 */
export const RESIDENT_SEGMENTS = 3;

// ─── Comments (D7) ──────────────────────────────────────────────────────────

/** Enforced server-side as well as in the field. Fits the projector. */
export const COMMENT_MAX_LENGTH = 140;
/** Longest run of combining marks kept before the rest are dropped (anti-Zalgo). */
export const COMMENT_MAX_COMBINING_RUN = 2;

// ─── Runtime config (D11) ───────────────────────────────────────────────────

// `ModerationMode` and `EngineOverride` are declared in protocol.ts, where the
// Zod schema is the single definition. Only the defaults live here.

/**
 * Everything the dashboard may change without a redeploy. Sent whole in
 * `hello`, then as deltas in `config`. User-facing error strings live here too
 * so wording can be fixed mid-event.
 */
export const DEFAULT_RUNTIME_CONFIG = {
  /** Tracks published ahead of the playhead that clients may fetch (D5). */
  prefetchHorizonTracks: 5,
  /** A track cannot start until it has been published this long (D5). */
  minLeadTimeMs: 180_000,
  /** Concurrent segment downloads served; listeners outrank joiners (D4). */
  maxConcurrentSegmentDownloads: 12,
  clockResyncIntervalMs: 15_000,
  driftDeadbandMs: DRIFT_DEADBAND_MS,
  driftRescheduleThresholdMs: DRIFT_RESCHEDULE_THRESHOLD_MS,
  /** Layer 2 of calibration: keyed by output-device class, tuned from Phase 0 (D1). */
  devicePresetMs: {
    wired: 0,
    airpods: 160,
    bluetooth: 200,
    'bluetooth-lowlatency': 80,
    generic: 100,
  } as Record<string, number>,
  engineOverride: 'auto' as 'auto' | 'webaudio' | 'mediaelement',
  /**
   * How far ahead of the room `MediaElementEngine` aims a seek (D2, D11).
   *
   * A media element does not resume instantly: it lands late by its own seek
   * cost, so seeking to the room's position leaves the guest permanently
   * behind by that much, and seeking again cannot fix it — the offset *is* the
   * cost of the seek. Measured at 47–52 ms on a laptop; aiming that far ahead
   * makes the element land on the beat instead.
   *
   * It matters only in a mixed room. A delay every guest shares is inaudible
   * (v4 Part 0), so if the whole floor is on one engine this can be zero — but
   * a room split across both engines gets a ~50 ms bimodal spread, right at the
   * edge of what dancing shows up. Verify at the venue and correct it live.
   */
  mediaElementSeekBiasMs: 67,
  /** One number for the whole room, set once per venue (D8). */
  projectorOffsetMs: 0,
  /** Review is the safer default; chosen before doors, not mid-set (D7). */
  moderationMode: 'review' as 'review' | 'open',
  /** Pending comments expire quietly rather than becoming a backlog (D7). */
  commentPendingExpiryMs: 600_000,
  /** Hard limit; under open mode a flood goes straight to the projector (D7). */
  commentsPerMinute: 3,
  pingsPerMinute: 120,
  /** Panic control: hides the feed on the projector, leaving visuals intact (D7). */
  feedHidden: false,
  strings: {
    serverUnreachable: 'Lost the DJ. Music keeps playing — reconnecting…',
    // No trailing ellipsis or countdown: the client appends one or the other
    // depending on whether it has a download-rate estimate yet.
    trackNotReady: 'Catching up',
    joinFailed: 'That code didn’t work. Check the poster?',
    storageFull: 'Your phone is out of space. Free some up and reload.',
    commentRateLimited: 'One at a time — try again in a moment.',
    commentRejected: "That one didn't make it through.",
  } as Record<string, string>,
};

export type RuntimeConfig = typeof DEFAULT_RUNTIME_CONFIG;

/**
 * Apply a config patch, skipping keys that are present but undefined.
 *
 * Shared because both ends do it: the server merges `config.set` from the
 * dashboard, the client merges the `config` deltas it receives. A plain spread
 * would let `{ moderationMode: undefined }` blank a live setting — exactly the
 * shape a partially-filled form produces — so the merge is written once here
 * rather than twice, differently.
 */
export function mergeConfig(
  base: RuntimeConfig,
  // Explicitly `| undefined` per key rather than `Partial<…>`: under
  // `exactOptionalPropertyTypes` those are different types, and a Zod partial
  // produces the former.
  patch: { [K in keyof RuntimeConfig]?: RuntimeConfig[K] | undefined } | undefined,
): RuntimeConfig {
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as RuntimeConfig;
}
