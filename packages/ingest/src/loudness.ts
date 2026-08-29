/**
 * EBU R128 loudness analysis (D10).
 *
 * Without this, track-to-track volume jumps become the most-complained-about
 * thing in the room, and guests cannot fix it — Bluetooth volume steps are far
 * too coarse. The analysis happens once here; the client applies the resulting
 * gain at playback.
 */

import { TARGET_LUFS } from '@disco/shared';
import { run } from './proc.js';
import type { LoudnessResult } from './types.js';

/**
 * Ceiling for the normalised true peak. Leaving 1 dB of headroom below full
 * scale keeps the lossy decoder's inter-sample overshoot from clipping on
 * playback — the peaks a decoder reconstructs are not the peaks that were
 * encoded.
 */
const TRUE_PEAK_CEILING_DB = -1;

/** Nothing gets pushed up more than this, however quiet it was mastered. */
const MAX_GAIN_DB = 12;

export async function analyseLoudness(path: string): Promise<LoudnessResult> {
  // `loudnorm` in analysis mode: one pass, no output file, JSON summary on
  // stderr. The measurement is the same R128 integrated loudness `ebur128`
  // reports, but in a form that does not need log scraping.
  const { stderr } = await run('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-af',
    'loudnorm=print_format=json',
    '-f',
    'null',
    '-',
  ]);

  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('loudnorm produced no JSON summary');
  }
  const parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;

  const integratedLufs = Number(parsed['input_i']);
  const truePeakDb = Number(parsed['input_tp']);
  const loudnessRange = Number(parsed['input_lra']);
  if (!Number.isFinite(integratedLufs)) throw new Error('loudnorm reported no integrated loudness');

  return {
    integratedLufs,
    truePeakDb: Number.isFinite(truePeakDb) ? truePeakDb : 0,
    loudnessRange: Number.isFinite(loudnessRange) ? loudnessRange : 0,
  };
}

/**
 * Gain that brings a track to the target loudness, then backed off far enough
 * that its true peak still lands under the ceiling.
 *
 * The clip guard matters most on exactly the tracks normalisation helps most:
 * a quiet, dynamic master wants +9 dB, and +9 dB on a −2 dBTP peak clips.
 * Losing a little loudness on those is the right trade — a clipped track is
 * audibly broken, a slightly quiet one is not.
 */
export function gainForTarget(
  loudness: LoudnessResult,
  targetLufs: number = TARGET_LUFS,
  ceilingDb: number = TRUE_PEAK_CEILING_DB,
): number {
  const wanted = targetLufs - loudness.integratedLufs;
  const headroom = ceilingDb - loudness.truePeakDb;
  const limited = Math.min(wanted, headroom, MAX_GAIN_DB);
  // Round to a hundredth of a dB: far below audibility, and it keeps the
  // manifest readable.
  return Math.round(limited * 100) / 100;
}
