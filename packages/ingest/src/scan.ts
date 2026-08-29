/** Recursive audio-file discovery. */

import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.wav',
  '.aif',
  '.aiff',
  '.ogg',
  '.oga',
  '.opus',
  '.wma',
  '.alac',
]);

/**
 * Walk `root` for audio files, sorted so a run is reproducible and a resumed
 * run visits files in the same order as the one it is resuming.
 */
export async function scanAudioFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip dotfiles: macOS `._` resource forks probe as unreadable audio and
      // would fill the failure log with noise on any USB-copied library.
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(path);
      }
    }
  }

  await walk(root);
  return found.sort();
}
