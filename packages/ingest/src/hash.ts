/**
 * Content hashing — the key the whole pipeline is idempotent on (Part E step 2).
 *
 * Hashing contents rather than path or mtime means a renamed file is recognised
 * as already done, a re-encoded file is recognised as new, and a re-run after a
 * crash resumes rather than restarting.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { SourceFile } from './types.js';

export async function hashFile(path: string): Promise<SourceFile> {
  const info = await stat(path);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return { path, contentHash: hash.digest('hex'), sizeBytes: info.size };
}

/**
 * Track IDs are the first 128 bits of the hash: short enough to read in a log,
 * long enough that a collision is not a thing that happens, and hex-only so it
 * satisfies `SafeId` and can never escape the media directory (D12).
 */
export function trackIdFromHash(contentHash: string): string {
  return contentHash.slice(0, 32);
}
