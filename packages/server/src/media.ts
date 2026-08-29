/**
 * Media path resolution (D12, OWASP A01).
 *
 * Two gates, and both are needed. `SafeId` at the schema layer means an
 * identifier cannot contain a separator in the first place; `resolveMediaPath`
 * then resolves the result and confirms it is still inside the media root, so
 * a future caller that skips the schema still cannot escape.
 *
 * Client input is never concatenated into a path.
 */

import { resolve, sep } from 'node:path';
import { SafeId } from '@disco/shared';

export class MediaPathError extends Error {}

/** Files a track directory is allowed to contain, by exact name or safe pattern. */
const SEGMENT_PATTERN = /^seg-\d{5}\.m4s$/;
const ALLOWED_FILES = new Set(['init.mp4', 'peaks.json', 'beats.json', 'art-256.jpg', 'art-1024.jpg']);

export function isAllowedTrackFile(name: string): boolean {
  return ALLOWED_FILES.has(name) || SEGMENT_PATTERN.test(name);
}

/**
 * Absolute path for a file inside a track's directory.
 *
 * Throws rather than returning null: a caller that forgets to check a null is a
 * traversal, and a caller that forgets to catch is a 500.
 */
export function resolveTrackFile(mediaRoot: string, trackId: string, file: string): string {
  if (!SafeId.safeParse(trackId).success) {
    throw new MediaPathError('invalid track id');
  }
  // An allowlist rather than a denylist. Denylists lose to encodings; there are
  // exactly six kinds of file in a track directory and they are all known here.
  if (!isAllowedTrackFile(file)) {
    throw new MediaPathError('invalid media file');
  }

  const root = resolve(mediaRoot);
  const candidate = resolve(root, 'tracks', trackId, file);
  if (!isInside(root, candidate)) {
    // Unreachable given the checks above; kept because it is the check that
    // still holds if either of them is ever loosened.
    throw new MediaPathError('path escapes media root');
  }
  return candidate;
}

/** True when `candidate` is the root itself or sits beneath it. */
export function isInside(root: string, candidate: string): boolean {
  const normalisedRoot = resolve(root);
  const normalised = resolve(candidate);
  return normalised === normalisedRoot || normalised.startsWith(normalisedRoot + sep);
}

/**
 * Cache headers for a media file.
 *
 * Segment filenames are derived from the track's content hash, so a given URL's
 * bytes can never change — `immutable` is honest here, and it is what keeps a
 * reconnecting phone from re-fetching its whole buffer (D4).
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
