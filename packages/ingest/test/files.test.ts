import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeId } from '@disco/shared';
import { hashFile, trackIdFromHash } from '../src/hash.js';
import { scanAudioFiles } from '../src/scan.js';
import { readPlaylistDurations } from '../src/transcode.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'disco-ingest-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('scanAudioFiles', () => {
  it('finds audio recursively and ignores everything else', async () => {
    await mkdir(join(dir, 'crate', 'nested'), { recursive: true });
    await writeFile(join(dir, 'a.mp3'), 'x');
    await writeFile(join(dir, 'crate', 'b.FLAC'), 'x');
    await writeFile(join(dir, 'crate', 'nested', 'c.m4a'), 'x');
    await writeFile(join(dir, 'cover.jpg'), 'x');
    await writeFile(join(dir, 'notes.txt'), 'x');

    const found = await scanAudioFiles(dir);
    expect(found.map((p) => p.slice(dir.length + 1))).toEqual([
      'a.mp3',
      'crate/b.FLAC',
      'crate/nested/c.m4a',
    ]);
  });

  it('skips dotfiles and dot-directories', async () => {
    // macOS `._` resource forks probe as unreadable audio, and a library copied
    // from a USB stick is full of them.
    await mkdir(join(dir, '.Trashes'), { recursive: true });
    await writeFile(join(dir, '.Trashes', 'old.mp3'), 'x');
    await writeFile(join(dir, '._track.mp3'), 'x');
    await writeFile(join(dir, 'track.mp3'), 'x');

    const found = await scanAudioFiles(dir);
    expect(found).toEqual([join(dir, 'track.mp3')]);
  });

  it('returns an empty list for a directory with nothing in it', async () => {
    expect(await scanAudioFiles(dir)).toEqual([]);
  });
});

describe('hashFile', () => {
  it('gives identical content the same hash under a different name', async () => {
    // This is what makes a renamed or re-organised library resume rather than
    // re-ingest.
    await writeFile(join(dir, 'one.mp3'), 'the same bytes');
    await writeFile(join(dir, 'two.mp3'), 'the same bytes');
    const a = await hashFile(join(dir, 'one.mp3'));
    const b = await hashFile(join(dir, 'two.mp3'));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.sizeBytes).toBe(14);
  });

  it('gives different content a different hash', async () => {
    await writeFile(join(dir, 'one.mp3'), 'a');
    await writeFile(join(dir, 'two.mp3'), 'b');
    const a = await hashFile(join(dir, 'one.mp3'));
    const b = await hashFile(join(dir, 'two.mp3'));
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('handles an empty file', async () => {
    await writeFile(join(dir, 'empty.mp3'), '');
    const s = await hashFile(join(dir, 'empty.mp3'));
    expect(s.sizeBytes).toBe(0);
    expect(s.contentHash).toHaveLength(64);
  });
});

describe('trackIdFromHash', () => {
  it('produces an ID the protocol will accept', async () => {
    // Track IDs reach the filesystem, so they have to satisfy `SafeId` — that
    // is what makes path traversal impossible before any handler runs (D12).
    await writeFile(join(dir, 'x.mp3'), 'content');
    const { contentHash } = await hashFile(join(dir, 'x.mp3'));
    const id = trackIdFromHash(contentHash);
    expect(id).toHaveLength(32);
    expect(SafeId.safeParse(id).success).toBe(true);
  });
});

describe('readPlaylistDurations', () => {
  it('reads EXTINF durations in playlist order', async () => {
    const playlist = join(dir, 'index.m3u8');
    await writeFile(
      playlist,
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:25',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:25.007891,',
        'seg-00000.m4s',
        '#EXTINF:25.007891,',
        'seg-00001.m4s',
        '#EXTINF:12.007438,',
        'seg-00002.m4s',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );

    const durations = await readPlaylistDurations(playlist);
    expect(durations).toEqual([25_007.891, 25_007.891, 12_007.438]);
    // The schedule adds these end to end, so the sum is what has to be right.
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(62_023.22, 2);
  });

  it('refuses a playlist with no segments rather than reporting a zero-length track', async () => {
    const playlist = join(dir, 'empty.m3u8');
    await writeFile(playlist, '#EXTM3U\n#EXT-X-ENDLIST\n');
    await expect(readPlaylistDurations(playlist)).rejects.toThrow(/no segments/);
  });
});
