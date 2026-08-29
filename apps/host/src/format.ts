/** Display formatting. Pure, so the awkward cases are pinned by tests. */

/** `m:ss`, or `h:mm:ss` past an hour. Negative clamps to zero. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Countdown to a track's end, for the transport view.
 *
 * Clamps at the end rather than going negative: an auto-advance is a tick away,
 * and a flash of "-0:01" reads as a bug.
 */
export function formatRemaining(positionMs: number, durationMs: number): string {
  return formatDuration(Math.max(0, durationMs - positionMs));
}

/** Signed milliseconds, for offsets and drift. The sign is the information. */
export function formatSigned(ms: number | undefined, digits = 0): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const rounded = ms.toFixed(digits);
  return Number(rounded) > 0 ? `+${rounded}` : rounded;
}

/**
 * Each client's clock offset relative to the median of the room.
 *
 * The absolute offset is a thirteen-digit number that means nothing on its own —
 * and per v4 Part 0, a delay every guest shares is inaudible anyway. What is
 * worth putting in front of the DJ is the *spread*: who is out of step with
 * everyone else. Median rather than mean, so one badly-synced phone does not
 * shift the baseline it is being compared against.
 */
export function offsetDeviations(offsets: ReadonlyArray<number | undefined>): Array<number | undefined> {
  const known = offsets.filter((o): o is number => o !== undefined && Number.isFinite(o));
  if (known.length === 0) return offsets.map(() => undefined);

  const sorted = [...known].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;

  return offsets.map((o) => (o === undefined || !Number.isFinite(o) ? undefined : o - median));
}

/** One readiness bar's caption: "28/30 ready", the widget that prevents most live failures (D5). */
export function readinessLabel(row: {
  ready: number;
  partial: number;
  listeners: number;
}): string {
  if (row.listeners === 0) return 'nobody listening yet';
  const partial = row.partial > 0 ? ` · ${row.partial} partial` : '';
  return `${row.ready}/${row.listeners} ready${partial}`;
}

/**
 * Bar widths as fractions of the room.
 *
 * Partial is drawn behind ready rather than added to it: a track that half the
 * room can *start* is not a track the room is ready for, and a single bar that
 * conflates the two would read as safer than it is.
 */
export function readinessWidths(row: {
  ready: number;
  partial: number;
  listeners: number;
}): { ready: number; partial: number } {
  if (row.listeners <= 0) return { ready: 0, partial: 0 };
  return {
    ready: Math.min(1, row.ready / row.listeners),
    partial: Math.min(1, (row.ready + row.partial) / row.listeners),
  };
}

/**
 * How much lead time a track still needs before it may start (D5).
 *
 * Returns null once it is playable, so a caller renders a badge only when there
 * is something to say.
 */
export function leadTimeRemainingMs(
  publishedAtServerTime: number | null,
  minLeadTimeMs: number,
  serverNow: number,
): number | null {
  if (publishedAtServerTime === null) return null;
  const remaining = publishedAtServerTime + minLeadTimeMs - serverNow;
  return remaining > 0 ? remaining : null;
}
