/**
 * Transcode to fragmented MP4 segments (D10).
 *
 * AAC-LC because `decodeAudioData` supports it everywhere including Safari,
 * with hardware decode. Fragmented MP4 rather than a run of standalone files
 * because each standalone encode would carry its own encoder priming and leave
 * an audible gap at every boundary — the shared init segment plus fragments is
 * what makes ~25 s chunking gapless (D2, D6).
 *
 * The client fetches `init.mp4` once per track and prepends it to each
 * fragment before decoding.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SEGMENT_TARGET_MS } from '@disco/shared';
import { run } from './proc.js';
import type { SegmentRecord } from './types.js';

export const INIT_SEGMENT_NAME = 'init.mp4';
const PLAYLIST_NAME = 'index.m3u8';

export interface TranscodeOptions {
  bitrate: string;
  sampleRate: number;
  channels: number;
  /**
   * `aac` is ffmpeg's built-in encoder and works everywhere. On macOS
   * `aac_at` (AudioToolbox) is noticeably better at 192 kbps; it is opt-in
   * because it does not exist on other platforms.
   */
  encoder: string;
  segmentTargetMs: number;
}

export const DEFAULT_TRANSCODE: TranscodeOptions = {
  bitrate: '192k',
  sampleRate: 44_100,
  channels: 2,
  encoder: 'aac',
  segmentTargetMs: SEGMENT_TARGET_MS,
};

export interface TranscodeResult {
  segments: SegmentRecord[];
  /** Sum of the segment durations — the authoritative length of the encode. */
  totalDurationMs: number;
}

/**
 * Encode `sourcePath` into `outDir`, which must already exist and be empty of
 * previous output. Returns one record per fragment, in play order.
 */
export async function transcodeToSegments(
  sourcePath: string,
  outDir: string,
  relativeDir: string,
  opts: TranscodeOptions = DEFAULT_TRANSCODE,
): Promise<TranscodeResult> {
  const segmentSeconds = (opts.segmentTargetMs / 1000).toString();

  await run('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-y',
    '-i',
    sourcePath,
    // Drop cover art and any other non-audio stream; artwork is extracted
    // separately at the sizes we actually serve.
    '-vn',
    '-map',
    '0:a:0',
    '-c:a',
    opts.encoder,
    '-b:a',
    opts.bitrate,
    '-ar',
    String(opts.sampleRate),
    '-ac',
    String(opts.channels),
    // One thread per ffmpeg, many ffmpegs. Encoding a single track across all
    // cores scales far worse than encoding one track per core.
    '-threads',
    '1',
    '-f',
    'hls',
    '-hls_time',
    segmentSeconds,
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_list_size',
    '0',
    '-hls_fmp4_init_filename',
    INIT_SEGMENT_NAME,
    '-hls_segment_filename',
    join(outDir, 'seg-%05d.m4s'),
    join(outDir, PLAYLIST_NAME),
  ]);

  const durations = await readPlaylistDurations(join(outDir, PLAYLIST_NAME));
  const files = (await readdir(outDir)).filter((f) => f.endsWith('.m4s')).sort();

  if (files.length !== durations.length) {
    throw new Error(
      `segment count mismatch: ${files.length} files, ${durations.length} playlist entries`,
    );
  }

  const segments: SegmentRecord[] = [];
  let startMs = 0;
  for (let i = 0; i < files.length; i++) {
    const name = files[i] as string;
    const durationMs = durations[i] as number;
    const info = await stat(join(outDir, name));
    segments.push({
      index: i,
      path: `${relativeDir}/${name}`,
      startMs,
      durationMs,
      bytes: info.size,
    });
    startMs += durationMs;
  }

  return { segments, totalDurationMs: startMs };
}

/**
 * Segment durations from the playlist's EXTINF tags.
 *
 * These come from the muxer's own packet timing — microsecond precision, and
 * exact in the sense that matters: they sum to the encode's true length. The
 * schedule adds them end to end, so anything less precise would accumulate.
 */
export async function readPlaylistDurations(playlistPath: string): Promise<number[]> {
  const text = await readFile(playlistPath, 'utf8');
  const durations: number[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('#EXTINF:')) continue;
    const seconds = Number.parseFloat(line.slice('#EXTINF:'.length));
    if (!Number.isFinite(seconds)) throw new Error(`unreadable EXTINF: ${line}`);
    durations.push(seconds * 1000);
  }
  if (durations.length === 0) throw new Error('playlist contained no segments');
  return durations;
}
