/**
 * The beat grid, as the projector reads it (D8, D10).
 *
 * Ingest writes `beats.json` per track while it is already touching every file,
 * and this is where that decision pays off: the display has no audio and no
 * microphone, so every visual it draws is driven from these numbers and the
 * shared clock. Nothing here is analysis — it is lookup, at 60 frames a second.
 *
 * Pure functions over plain arrays, so the awkward cases (before the first beat,
 * past the last, no grid at all) are pinned by tests rather than discovered on a
 * projector in front of a room.
 */

import { z } from 'zod';

/** The file ingest writes. Parsed rather than trusted: it is still input. */
export const BeatGridFile = z.object({
  version: z.number().int(),
  bpm: z.number().positive().nullable(),
  offsetMs: z.number().nullable(),
  beatsMs: z.array(z.number().finite()),
});
export type BeatGridFile = z.infer<typeof BeatGridFile>;

export interface BeatGrid {
  bpm: number | null;
  /** Beat positions within the track, ascending. Empty when detection failed. */
  beatsMs: readonly number[];
}

export function parseBeatGrid(raw: unknown): BeatGrid | null {
  const parsed = BeatGridFile.safeParse(raw);
  if (!parsed.success) return null;
  // Sorted defensively. Everything below binary-searches this, and one
  // out-of-order entry from a future detector would turn into a visual
  // stutter that is very hard to trace back to its cause.
  const beatsMs = [...parsed.data.beatsMs].sort((a, b) => a - b);
  return { bpm: parsed.data.bpm, beatsMs };
}

export interface BeatPhase {
  /** Index of the most recent beat at or before the position. */
  index: number;
  /** Milliseconds since that beat. Never negative. */
  sinceMs: number;
  /** Gap to the next beat, or the previous interval past the end of the grid. */
  intervalMs: number;
}

/**
 * Where a position sits between beats.
 *
 * Returns null before the first beat and when there is no grid, which the
 * renderer treats as "no pulse" rather than guessing — a visual that pulses on
 * a beat that was never detected is worse than one that waits.
 */
export function beatPhaseAt(grid: BeatGrid, positionMs: number): BeatPhase | null {
  const beats = grid.beatsMs;
  if (beats.length === 0) return null;
  if (positionMs < (beats[0] as number)) return null;

  const index = lastAtOrBefore(beats, positionMs);
  const at = beats[index] as number;
  const next = beats[index + 1];
  const previous = beats[index - 1];

  // Past the last detected beat, keep the pulse going at the last known
  // interval. Detection often stops before a track's outro does, and a
  // visualiser that dies thirty seconds early reads as a crash.
  const intervalMs =
    next !== undefined
      ? next - at
      : previous !== undefined
        ? at - previous
        : grid.bpm
          ? 60_000 / grid.bpm
          : 500;

  return { index, sinceMs: positionMs - at, intervalMs: Math.max(1, intervalMs) };
}

/** Index of the last beat at or before `positionMs`. Assumes an ascending grid. */
function lastAtOrBefore(beats: readonly number[], positionMs: number): number {
  let low = 0;
  let high = beats.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((beats[mid] as number) <= positionMs) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Track position the projector should be *drawing*, in track milliseconds.
 *
 * `projectorOffsetMs` is how far ahead of the room's audio the visuals are
 * drawn. Raise it when the projector looks late: everything between the draw
 * call and the light hitting the wall — compositor, cable, the projector's own
 * input lag — is a constant, so one number set once per venue corrects it for
 * the whole room (D8, v4 Part 0).
 */
export function projectorPositionMs(
  serverNowMs: number,
  startAtServerTime: number,
  projectorOffsetMs: number,
): number {
  return serverNowMs - startAtServerTime + projectorOffsetMs;
}

/**
 * Pulse envelope for a beat: 1 on the beat, decaying to 0 by the next one.
 *
 * Shaped rather than linear so the flash reads as a hit and not as a sawtooth,
 * and clamped so a long gap between detected beats leaves the screen calm
 * instead of holding a half-lit frame.
 */
export function beatPulse(phase: BeatPhase | null, decayFraction = 0.55): number {
  if (!phase) return 0;
  const decayMs = Math.max(1, phase.intervalMs * decayFraction);
  const t = phase.sinceMs / decayMs;
  if (t >= 1) return 0;
  // Cubic ease-out: fast attack away from 1, long tail towards 0.
  return (1 - t) ** 3;
}
