/**
 * Cover art at two sizes (D10): one for the guest's now-playing view, one for
 * the projector.
 *
 * ffmpeg does the resizing rather than an image library — it is already a hard
 * dependency, and adding a second native module to the tree for two JPEGs a
 * track is not worth it.
 */

import { join } from 'node:path';
import { run } from './proc.js';

export const ART_SIZES = { small: 256, large: 1024 } as const;

export interface ArtworkResult {
  smallPath: string | null;
  largePath: string | null;
}

/**
 * Extract and resize embedded cover art. Missing art is normal, not an error —
 * the UI has a per-channel colour fallback — so this resolves with nulls rather
 * than failing the track.
 */
export async function extractArtwork(
  sourcePath: string,
  outDir: string,
  relativeDir: string,
): Promise<ArtworkResult> {
  const result: ArtworkResult = { smallPath: null, largePath: null };

  for (const [name, size] of Object.entries(ART_SIZES)) {
    const file = `art-${size}.jpg`;
    try {
      await run('ffmpeg', [
        '-nostdin',
        '-hide_banner',
        '-y',
        '-i',
        sourcePath,
        '-an',
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        // Fit inside the box without distorting, and never upscale a small
        // embedded thumbnail into a blurry large one.
        '-vf',
        `scale=w=${size}:h=${size}:force_original_aspect_ratio=decrease`,
        '-q:v',
        '3',
        join(outDir, file),
      ]);
      const relative = `${relativeDir}/${file}`;
      if (name === 'small') result.smallPath = relative;
      else result.largePath = relative;
    } catch {
      // No attached picture, or an image stream ffmpeg cannot read. Either way
      // the track is still perfectly playable.
      return result;
    }
  }

  return result;
}
