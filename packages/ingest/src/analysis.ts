/**
 * Beat grid and waveform peaks.
 *
 * Both read the same decoded mono WAV rather than the source, so a track is
 * decoded once for analysis instead of once per derived asset. 22.05 kHz mono
 * is ample for both: beat tracking works on an onset envelope, and the peaks
 * feed a scrubber a few thousand pixels wide.
 */

import { writeFile } from 'node:fs/promises';
import { run, runStreaming } from './proc.js';
import type { BeatResult } from './types.js';

/**
 * 44.1 kHz, and not lower.
 *
 * aubio's default hop and window sizes are counted in samples, not seconds, so
 * feeding it a half-rate file doubles the time each analysis frame covers and
 * halves the tempo resolution. Measured on a synthetic 128 BPM pattern:
 * 44.1 kHz reads 128.10 BPM, 22.05 kHz reads 63.38. Passing `-H 256` fixes it
 * too, but matching the tool's assumed rate is one less thing to get wrong.
 */
export const ANALYSIS_SAMPLE_RATE = 44_100;

/** One min/max pair per 20 ms — 50 pairs a second, 15 000 for a five-minute track. */
export const PEAKS_PER_SECOND = 50;

/** Decode to a mono WAV for the analysis tools to share. */
export async function decodeForAnalysis(sourcePath: string, wavPath: string): Promise<void> {
  await run('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-y',
    '-i',
    sourcePath,
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    String(ANALYSIS_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-threads',
    '1',
    wavPath,
  ]);
}

/**
 * Plausible tempo range. Deliberately wide: the common failure is an octave
 * error — half or double the real tempo — and a halved reading the DJ can see
 * and correct on the dashboard is more useful than a blank.
 */
const MIN_BPM = 50;
const MAX_BPM = 220;

/**
 * Beat times from aubio.
 *
 * The full grid is kept, not just a tempo: real recordings drift, and the
 * projector's visuals are driven off actual beat positions (D8). A single BPM
 * would be visibly wrong by the end of a five-minute track.
 */
export async function detectBeats(wavPath: string): Promise<BeatResult> {
  // Two aubio subcommands, and they are not interchangeable: `beat` prints one
  // timestamp per detected beat, `tempo` prints a single overall BPM. The grid
  // comes from the first; the second is a more robust tempo than the median of
  // the grid, because it does not care about individual missed beats.
  const [grid, tempo] = await Promise.all([
    run('aubio', ['beat', '-i', wavPath]),
    run('aubio', ['tempo', '-i', wavPath]).catch(() => null),
  ]);

  const beats: number[] = [];
  for (const line of grid.stdout.split('\n')) {
    const seconds = Number.parseFloat(line.trim());
    if (Number.isFinite(seconds) && seconds >= 0) beats.push(seconds * 1000);
  }

  if (beats.length < 4) {
    // Ambient, spoken word, or a detector failure. The projector falls back to
    // a time-based visual; nothing else in the system needs a tempo.
    return { bpm: null, beatGridOffsetMs: null, beats };
  }

  return {
    bpm: parseTempoBpm(tempo?.stdout) ?? bpmFromBeats(beats),
    beatGridOffsetMs: beats[0] as number,
    beats,
  };
}

/** `aubio tempo` prints a line like "124.31 bpm". Out-of-range answers are dropped. */
export function parseTempoBpm(stdout: string | undefined): number | null {
  if (!stdout) return null;
  const match = /(\d+(?:\.\d+)?)\s*bpm/i.exec(stdout);
  if (!match) return null;
  const bpm = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) return null;
  return Math.round(bpm * 10) / 10;
}

/**
 * Tempo as the median interval between beats.
 *
 * Median rather than mean because a missed beat doubles one interval, and one
 * doubled interval drags a mean far enough to report the wrong tempo.
 */
export function bpmFromBeats(beatsMs: readonly number[]): number | null {
  const intervals: number[] = [];
  for (let i = 1; i < beatsMs.length; i++) {
    intervals.push((beatsMs[i] as number) - (beatsMs[i - 1] as number));
  }
  const usable = intervals.filter((ms) => ms > 0 && 60_000 / ms >= MIN_BPM && 60_000 / ms <= MAX_BPM);
  if (usable.length < 3) return null;

  usable.sort((a, b) => a - b);
  const mid = Math.floor(usable.length / 2);
  const medianMs =
    usable.length % 2 === 1
      ? (usable[mid] as number)
      : ((usable[mid - 1] as number) + (usable[mid] as number)) / 2;

  return Math.round((60_000 / medianMs) * 10) / 10;
}

export interface Peaks {
  version: 1;
  /** Pairs per second, so a renderer can map a pixel to a time without guessing. */
  pairsPerSecond: number;
  bits: 8;
  length: number;
  /** Alternating min, max, each in −128…127. */
  data: number[];
}

/**
 * Waveform peaks for the DJ scrubber, reduced as the PCM streams past.
 *
 * A five-minute track is ~13 MB of mono PCM even at this rate, and there are
 * thousands of tracks — so the samples are folded into buckets on arrival and
 * never held whole.
 */
export async function computePeaks(wavPath: string): Promise<Peaks> {
  const samplesPerBucket = Math.round(ANALYSIS_SAMPLE_RATE / PEAKS_PER_SECOND);
  const data: number[] = [];

  let bucketMin = 0;
  let bucketMax = 0;
  let inBucket = 0;
  // A 16-bit sample can straddle a chunk boundary; hold the odd byte over.
  let carry: number | null = null;

  const pushSample = (sample: number) => {
    if (inBucket === 0) {
      bucketMin = sample;
      bucketMax = sample;
    } else {
      if (sample < bucketMin) bucketMin = sample;
      if (sample > bucketMax) bucketMax = sample;
    }
    if (++inBucket === samplesPerBucket) {
      data.push(toInt8(bucketMin), toInt8(bucketMax));
      inBucket = 0;
    }
  };

  await runStreaming(
    'ffmpeg',
    ['-nostdin', '-hide_banner', '-i', wavPath, '-f', 's16le', '-ac', '1', '-threads', '1', '-'],
    (chunk) => {
      let offset = 0;
      if (carry !== null && chunk.length > 0) {
        pushSample(signed16(carry, chunk.readUInt8(0)));
        carry = null;
        offset = 1;
      }
      for (; offset + 1 < chunk.length; offset += 2) {
        pushSample(chunk.readInt16LE(offset));
      }
      carry = offset < chunk.length ? chunk.readUInt8(offset) : null;
    },
  );

  if (inBucket > 0) data.push(toInt8(bucketMin), toInt8(bucketMax));

  return { version: 1, pairsPerSecond: PEAKS_PER_SECOND, bits: 8, length: data.length / 2, data };
}

/** Little-endian 16-bit signed from two bytes split across a chunk boundary. */
function signed16(low: number, high: number): number {
  const value = (high << 8) | low;
  return value >= 0x8000 ? value - 0x10000 : value;
}

/** 16-bit sample down to a signed byte; the scrubber has nothing like that resolution. */
function toInt8(sample: number): number {
  return Math.max(-128, Math.min(127, Math.round(sample / 256)));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), 'utf8');
}
