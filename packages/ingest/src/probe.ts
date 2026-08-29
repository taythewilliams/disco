/**
 * ffprobe wrappers: metadata for the source file, exact durations for segments.
 */

import { basename, extname } from 'node:path';
import { run } from './proc.js';
import type { ProbeResult } from './types.js';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  duration_ts?: number;
  time_base?: string;
  disposition?: Record<string, number>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; tags?: Record<string, string> };
}

async function ffprobeJson(path: string, extraArgs: readonly string[] = []): Promise<FfprobeOutput> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    ...extraArgs,
    path,
  ]);
  return JSON.parse(stdout) as FfprobeOutput;
}

/** Case-insensitive tag lookup; taggers disagree on capitalisation constantly. */
function tag(tags: Record<string, string> | undefined, ...names: string[]): string | undefined {
  if (!tags) return undefined;
  const lower = new Map(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export async function probeSource(path: string): Promise<ProbeResult> {
  const out = await ffprobeJson(path);
  const audio = out.streams?.find((s) => s.codec_type === 'audio');
  if (!audio) throw new Error('no audio stream');

  const durationSec = Number(audio.duration ?? out.format?.duration ?? NaN);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('unreadable duration');

  // Cover art arrives as a video stream carrying the `attached_pic` disposition.
  const hasCoverArt =
    out.streams?.some((s) => s.codec_type === 'video' && s.disposition?.['attached_pic'] === 1) ??
    false;

  const tags = out.format?.tags;
  return {
    durationMs: durationSec * 1000,
    sampleRate: Number(audio.sample_rate ?? 44_100),
    channels: audio.channels ?? 2,
    codec: audio.codec_name ?? 'unknown',
    // Falling back to the filename keeps an untagged track usable in the
    // dashboard rather than listing a wall of "Unknown".
    title: tag(tags, 'title') ?? basename(path, extname(path)),
    artist: tag(tags, 'artist', 'album_artist', 'performer') ?? 'Unknown artist',
    album: tag(tags, 'album') ?? null,
    hasCoverArt,
  };
}
