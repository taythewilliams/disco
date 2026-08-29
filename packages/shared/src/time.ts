/**
 * The single definition of "server time".
 *
 * `Date.now()` is read exactly once, at module load, to give the timeline a
 * human-readable origin for logs. Every reading after that advances on
 * `performance.now()`, which is monotonic. An NTP step or a DST change mid-set
 * therefore moves nothing: a wall-clock jump would otherwise reschedule every
 * track in the room at once (D9).
 */
const ORIGIN_MS = Date.now() - performance.now();

/** Server-side only. Milliseconds on the shared timeline. */
export const serverNow = (): number => ORIGIN_MS + performance.now();

/** Client-side monotonic reading. Not comparable across devices on its own. */
export const monotonicNow = (): number => performance.now();

/**
 * The timeline origin, for logging and for `hello`. Exposed so a client can
 * render server times as approximate wall-clock without ever computing on them.
 */
export const timelineOrigin = (): number => ORIGIN_MS;
